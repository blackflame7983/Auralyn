//! 未公開のVSTを制御STA上で復元する。期限超過・失敗では所有値を公開しない。
use crate::{
    ipc::RestorePluginRequest,
    vst_host::instance::{VstInstance, VstProcessor},
};
use anyhow::{anyhow, ensure, Context, Result};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) struct StagedRestore {
    pub expected_ids: Option<Vec<String>>,
    pub expected_rack_revision: Option<u64>,
    pub operation_id: u64,
    pub request: RestorePluginRequest,
    pub instance: VstInstance,
    deadline: Instant,
    staged: Instant,
}

impl StagedRestore {
    #[cfg(test)]
    pub(crate) fn expire(&mut self) {
        self.deadline = Instant::now();
    }
    pub(crate) fn load(
        request: RestorePluginRequest,
        operation_id: u64,
        expires_at_ms: u64,
    ) -> Result<Self> {
        Self::load_with(request, operation_id, expires_at_ms, VstInstance::load)
    }

    pub(crate) fn load_with(
        request: RestorePluginRequest,
        operation_id: u64,
        expires_at_ms: u64,
        load: impl FnOnce(&str) -> Result<VstInstance>,
    ) -> Result<Self> {
        request.validate().map_err(|error| anyhow!(error))?;
        let budget = expires_at_ms
            .checked_sub(unix_ms())
            .filter(|ms| *ms > 0 && *ms <= 10_000)
            .ok_or_else(|| anyhow!("VST復元要求の期限が切れました"))?;
        let deadline = Instant::now() + Duration::from_millis(budget);
        let phase = Instant::now();
        let instance = load(&request.path).context("VSTのロードに失敗しました")?;
        log::debug!("VST restore phase=load us={}", phase.elapsed().as_micros());
        let result = Self {
            expected_ids: None,
            expected_rack_revision: None,
            operation_id,
            request,
            instance,
            deadline,
            staged: Instant::now(),
        };
        result.check_deadline()?;
        let phase = Instant::now();
        if let Some(state) = &result.request.state {
            result
                .instance
                .set_state(state)
                .context("VSTの保存状態を復元できません")?;
        }
        log::debug!("VST restore phase=state us={}", phase.elapsed().as_micros());
        result.check_deadline()?;
        Ok(result)
    }

    pub(crate) fn check_deadline(&self) -> Result<()> {
        ensure!(
            Instant::now() < self.deadline,
            "VST復元要求の期限が切れました。公開せず破棄しました"
        );
        Ok(())
    }

    pub(crate) fn finish(
        &mut self,
        setup: Option<(f64, usize, usize)>,
    ) -> Result<Option<VstProcessor>> {
        self.check_deadline()?;
        log::debug!(
            "VST restore phase=deferred_wait us={}",
            self.staged.elapsed().as_micros()
        );
        let phase = Instant::now();
        if let Some((rate, capacity, channels)) = setup {
            self.instance
                .prepare_processing(rate, capacity as i32, channels as i32)
                .context("VSTの音声処理を準備できません")?;
        }
        log::debug!(
            "VST restore phase=prepare us={}",
            phase.elapsed().as_micros()
        );
        self.check_deadline()?;
        if self.instance.needs_deferred_connection() {
            self.instance
                .finalize_connection()
                .context("VSTの遅延接続に失敗しました")?;
        }
        self.check_deadline()?;
        if setup.is_some() {
            Ok(Some(
                self.instance
                    .create_processor()
                    .ok_or_else(|| anyhow!("VST processorを作成できません"))?,
            ))
        } else {
            Ok(None)
        }
    }
}
