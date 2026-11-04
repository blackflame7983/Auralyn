//! 本人用の音声を開始する前に、配信専用ラックと音声転送の準備を完了する。
use super::*;
impl AudioHost {
    pub(super) fn cancel_prepared_post_start(&mut self) {
        if !self.post_attached {
            return;
        }
        if self.reader_active.load(Ordering::Acquire) {
            let _ = self.execute_running_command(IpcCommand::Stop);
        }
        if self.post_mix.stop().is_err() {
            self.post_mix.kill();
        }
        if self.reader_active.load(Ordering::Acquire) {
            let _ = self.execute_running_command(IpcCommand::PostMixClear);
        }
        self.post_attached = false;
    }
    pub(super) fn prepare_post_mix_start(&mut self, rate: Option<u32>) -> Result<()> {
        self.post_mix.validate_start()?;
        if !self.post_mix.enabled() {
            if self.post_attached {
                anyhow::ensure!(
                    matches!(
                        self.execute_running_command(IpcCommand::PostMixClear)?,
                        IpcResponse::Success
                    ),
                    "ミックス後VSTを解除できません"
                );
                self.post_attached = false;
            }
            return Ok(());
        }
        anyhow::ensure!(
            self.post_mix.ready(),
            "ミックス後VSTを明示的に復元してから開始してください"
        );
        let rate =
            rate.ok_or_else(|| anyhow!("ミックス後VSTを使う場合は処理rateを明示選択してください"))?;
        let descriptor =
            match self.execute_running_command(IpcCommand::PostMixPrepare { sample_rate: rate })? {
                IpcResponse::PostMixDescriptor(value) => value,
                IpcResponse::Error(error) => anyhow::bail!(error),
                _ => anyhow::bail!("ミックス後VSTの転送を準備できません"),
            };
        self.post_attached = true;
        if let Err(error) = self.post_mix.start(rate, descriptor) {
            let _ = self.execute_running_command(IpcCommand::PostMixClear);
            self.post_attached = false;
            return Err(error);
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            match self.execute_running_command(IpcCommand::PostMixStatus)? {
                IpcResponse::PostMixStatus {
                    ready: true,
                    failed: false,
                    ..
                } => return Ok(()),
                IpcResponse::PostMixStatus { failed: false, .. } => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                _ => break,
            }
        }
        let _ = self.post_mix.stop();
        let _ = self.execute_running_command(IpcCommand::PostMixClear);
        self.post_attached = false;
        anyhow::bail!("ミックス後VSTの準備が完了しませんでした。音声は開始していません")
    }
}
