//! 初回画面とwarmupだけが共有する、Host寿命内で一度の自動開始権限。
use super::*;

#[derive(Default)]
pub(super) struct Startup {
    pub(super) frontend_seen: bool,
    pub(super) canceled: bool,
    pub(super) warmup_seen: bool,
    pub(super) automatic_attempted: bool,
    pub(super) warmup_succeeded: bool,
    pub(super) input_gain: Option<f32>,
    pub(super) output_gain: Option<f32>,
    pub(super) session_claimed: bool,
    pub(super) warmup_error: Option<String>,
    pub(super) deferred_config: Option<ActiveAudioConfig>,
}
impl Startup {
    pub(super) fn cancel(&mut self) {
        self.canceled = true;
        self.warmup_error = None;
    }
}
impl AudioHost {
    pub(super) fn prepare_warmup(
        &mut self,
        ensure: impl FnOnce(&mut Self) -> Result<()>,
    ) -> Result<bool> {
        if self.frontend_bootstrap.canceled || self.frontend_bootstrap.warmup_seen {
            return Ok(false);
        }
        self.frontend_bootstrap.warmup_seen = true;
        let open = !self.connection_lost();
        if let Some(child) = &mut self.child {
            let connected = open && matches!(child.try_wait(), Ok(None));
            let state = if connected {
                self.auto_gain(crate::audio_engine::auto_gain::Request::Status)
                    .ok()
            } else {
                None
            };
            if state.as_ref().is_none_or(|state| state.stream_failed) {
                self.frontend_bootstrap.cancel();
                self.frontend_bootstrap.warmup_error =
                    Some("音声接続を確認できません。設定から明示的に再開してください。".into());
                return Err(anyhow!("既存接続は自動再生成しません"));
            }
            if state.is_some_and(|state| state.running) {
                self.frontend_bootstrap.automatic_attempted = true;
                return Ok(false);
            }
        }
        if let Err(error) = ensure(self) {
            self.frontend_bootstrap.cancel();
            self.frontend_bootstrap.warmup_error =
                Some("音声エンジンの準備に失敗しました。設定から明示的に再開してください。".into());
            return Err(error);
        }
        Ok(true)
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn frontend_bootstrap_stop_claims_auto_session_but_explicit_restore_can_begin_on_same_existing_engine(
    ) {
        use super::super::session_rack::tests::with_host;
        use crate::ipc::{SessionRackReply as RackReply, SessionRackRequest as RackRequest};
        with_host(
            |command| match command {
                IpcCommand::GetPluginRack => IpcResponse::PluginRack {
                    plugins: vec![],
                    restore_eligible: true,
                    revision: 0,
                    running: false,
                },
                _ => IpcResponse::Success,
            },
            |host, _| {
                host.stop().unwrap();
                assert!(matches!(
                    host.session_rack(RackRequest::Snapshot).unwrap(),
                    RackReply::Snapshot {
                        restore_eligible: false,
                        ..
                    }
                ));
                let begin = |explicit| RackRequest::Begin {
                    generation: "0".into(),
                    revision: "0".into(),
                    ids: vec![],
                    input_gain: 0.3,
                    output_gain: 0.2,
                    explicit,
                };
                assert!(matches!(
                    host.session_rack(begin(false)).unwrap(),
                    RackReply::Conflict
                ));
                assert!(matches!(
                    host.session_rack(begin(true)).unwrap(),
                    RackReply::Ready { .. }
                ));
            },
        );
    }
}
