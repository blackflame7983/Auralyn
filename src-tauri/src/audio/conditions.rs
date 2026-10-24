//! OBSの手動測定に結び付けるHost固有の条件。音声データ・設定値を保持しない。
use crate::ipc::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};

#[derive(Default, Debug)]
pub(crate) struct Conditions {
    revision: AtomicU64,
    pending: AtomicU64,
    running: AtomicBool,
    engine_epoch: AtomicU64,
}

#[derive(Clone)]
pub(crate) struct ConditionState(pub Arc<Conditions>);

#[derive(Clone, Debug)]
pub(crate) struct Witness {
    conditions: Arc<Conditions>,
    revision: u64,
    epoch: u64,
}

/// 停止中の保持意図も対象。送出中であることや信号到達を意味しない。
#[derive(Clone)]
pub(crate) struct ControlWitness {
    conditions: Arc<Conditions>,
    revision: u64,
    epoch: u64,
}
impl ControlWitness {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.conditions.pending.load(Ordering::SeqCst) != 0
            || self.conditions.revision.load(Ordering::SeqCst) != self.revision
            || self.conditions.engine_epoch.load(Ordering::SeqCst) != self.epoch
        {
            return Err("Auralynの構成・音声世代が変わりました。再確認してください".into());
        }
        Ok(())
    }
}

pub(super) struct Pending(Arc<Conditions>);
impl Drop for Pending {
    fn drop(&mut self) {
        self.0.revision.fetch_add(1, Ordering::SeqCst);
        self.0.pending.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Conditions {
    pub(crate) fn control_snapshot(self: &Arc<Self>) -> Result<ControlWitness, String> {
        let witness = ControlWitness {
            conditions: self.clone(),
            revision: self.revision.load(Ordering::SeqCst),
            epoch: self.engine_epoch.load(Ordering::SeqCst),
        };
        witness.validate()?;
        Ok(witness)
    }
    pub(super) fn dispatch<T, E>(
        self: &Arc<Self>,
        changes: bool,
        execute: impl FnOnce() -> Result<T, E>,
        notify: impl Fn(),
    ) -> Result<T, E> {
        let pending = changes.then(|| self.begin());
        if changes {
            notify();
        }
        let result = execute();
        if result.is_err() {
            self.lifecycle(false);
        }
        drop(pending);
        if changes || result.is_err() {
            notify();
        }
        result
    }
    pub(super) fn new_engine(&self) -> u64 {
        let epoch = self.engine_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        self.lifecycle(false);
        epoch
    }

    pub(super) fn retire_engine(&self) {
        self.engine_epoch.fetch_add(1, Ordering::SeqCst);
        self.lifecycle(false);
    }

    pub(super) fn engine_event(&self, epoch: u64, running: bool) -> bool {
        if self.engine_epoch.load(Ordering::SeqCst) != epoch {
            return false;
        }
        self.pending.fetch_add(1, Ordering::SeqCst);
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.running.store(running, Ordering::SeqCst);
        let current = self.engine_epoch.load(Ordering::SeqCst) == epoch;
        if !current {
            self.running.store(false, Ordering::SeqCst);
        }
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.pending.fetch_sub(1, Ordering::SeqCst);
        current
    }
    pub(super) fn begin(self: &Arc<Self>) -> Pending {
        self.pending.fetch_add(1, Ordering::SeqCst);
        self.revision.fetch_add(1, Ordering::SeqCst);
        Pending(self.clone())
    }

    pub(crate) fn lifecycle(&self, running: bool) {
        self.pending.fetch_add(1, Ordering::SeqCst);
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.running.store(running, Ordering::SeqCst);
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.pending.fetch_sub(1, Ordering::SeqCst);
    }

    pub(crate) fn snapshot(self: &Arc<Self>) -> Result<Witness, String> {
        let revision = self.revision.load(Ordering::SeqCst);
        if self.pending.load(Ordering::SeqCst) != 0
            || !self.running.load(Ordering::SeqCst)
            || self.revision.load(Ordering::SeqCst) != revision
            || self.pending.load(Ordering::SeqCst) != 0
        {
            return Err(
                "音声条件が未確定です。音声を開始し、変更の完了後に測定し直してください".into(),
            );
        }
        Ok(Witness {
            conditions: self.clone(),
            revision,
            epoch: self.engine_epoch.load(Ordering::SeqCst),
        })
    }
}

impl Witness {
    pub(crate) fn revision(&self) -> u64 {
        self.revision
    }

    pub(crate) fn engine_epoch(&self) -> u64 {
        self.epoch
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        let current = self.conditions.snapshot()?;
        if current.revision != self.revision || current.epoch != self.epoch {
            return Err("Auralynの音声条件が変わりました。同期の測定からやり直してください".into());
        }
        Ok(())
    }
}

pub(super) fn command_changes(command: &Command) -> bool {
    use crate::audio_engine::auto_gain::Request;
    match command {
        Command::ConfigureLiveModes { .. } | Command::LiveMode { request: crate::audio_engine::live_modes::Request::Snapshot | crate::audio_engine::live_modes::Request::Arm { .. } | crate::audio_engine::live_modes::Request::Disarm { .. } | crate::audio_engine::live_modes::Request::Save { .. } } => false,
        Command::BuiltinEffects {
            request: crate::audio_engine::builtin::Request::Snapshot,
        } => false,
        Command::GetDevices
        | Command::BeginDeviceScan
        | Command::PollDeviceScan { .. }
        | Command::CancelDeviceScan { .. }
        | Command::GetRuntimeStats
        | Command::GetFrameTimingTrace { .. }
        | Command::GetPluginState { .. }
        | Command::CaptureBundleState
        | Command::GetPluginRack
        | Command::SetLoudnessMeasurement { .. }
        | Command::SetChannelScan { .. }
        | Command::VoiceCheckPreview { .. }
        // 録音tapの停止は通常送出の処理・経路を変えない。画面の後始末で
        // 同期witnessや新しい独立試聴を自己失効させない。
        | Command::StopVoiceCheckRecording
        | Command::ExportVoiceCheck { .. } => false,
        Command::AutoGain { request } => matches!(
            request,
            Request::Initialize { .. } | Request::Apply { .. } | Request::Restore { .. }
        ),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundle_read_does_not_invalidate_stopped_control_witness_but_mutation_and_epoch_do() {
        let conditions = Arc::new(Conditions::default());
        let witness = conditions.control_snapshot().unwrap();
        assert!(!command_changes(&Command::CaptureBundleState));
        assert!(witness.validate().is_ok());
        conditions.lifecycle(false);
        assert!(witness.validate().is_err());
        let next = conditions.control_snapshot().unwrap();
        conditions.new_engine();
        assert!(next.validate().is_err());
    }
    #[test]
    fn live_modes_reads_settings_and_protection_preserve_audio_witness_but_mode_intent_changes_it()
    {
        use crate::audio_engine::live_modes::{Definitions, Intent, Request as LiveRequest};
        for command in [
            Command::ConfigureLiveModes {
                definitions: Definitions::default(),
                armed: false,
            },
            Command::LiveMode {
                request: LiveRequest::Snapshot,
            },
            Command::LiveMode {
                request: LiveRequest::Arm {
                    intent: Intent {
                        client_id: "ui".into(),
                        sequence: 1,
                        expected_epoch: "epoch".into(),
                    },
                },
            },
            Command::LiveMode {
                request: LiveRequest::Disarm {
                    intent: Intent {
                        client_id: "ui".into(),
                        sequence: 2,
                        expected_epoch: "epoch".into(),
                    },
                },
            },
            Command::LiveMode {
                request: LiveRequest::Save {
                    expected_version: "1".into(),
                    singing: None,
                    talk: None,
                },
            },
        ] {
            assert!(!command_changes(&command));
        }
        assert!(command_changes(&Command::LiveMode {
            request: LiveRequest::TalkOn {
                intent: Intent {
                    client_id: "ui".into(),
                    sequence: 1,
                    expected_epoch: "epoch".into()
                }
            }
        }));
    }

    #[test]
    fn pending_rejection_timeout_restart_and_hosts_never_revalidate_old_witness() {
        let conditions = Arc::new(Conditions::default());
        assert!(conditions.snapshot().is_err());
        conditions.lifecycle(true);
        let old = conditions.snapshot().unwrap();
        let pending = conditions.begin();
        assert!(conditions.snapshot().is_err());
        assert!(old.validate().is_err());
        drop(pending); // 失敗・拒否でも以前の測定は失効。
        assert!(old.validate().is_err());
        let before_exit = conditions.snapshot().unwrap();
        conditions.lifecycle(false); // timeout/停止/異常
        assert!(conditions.snapshot().is_err());
        conditions.lifecycle(true); // 同じ設定の別engineでも旧条件とは別。
        assert!(before_exit.validate().is_err());
        let other = Arc::new(Conditions::default());
        other.lifecycle(true);
        let other_witness = other.snapshot().unwrap();
        conditions.lifecycle(false);
        assert!(other_witness.validate().is_ok());
    }

    #[test]
    fn only_audio_mutations_notify_and_read_commands_preserve_witness() {
        for command in [
            Command::GetRuntimeStats,
            Command::GetFrameTimingTrace {
                expected_epoch: "epoch".into(),
            },
            Command::GetDevices,
            Command::GetPluginState { id: "vst".into() },
            Command::StopVoiceCheckRecording,
            Command::AutoGain {
                request: crate::audio_engine::auto_gain::Request::Status,
            },
        ] {
            assert!(!command_changes(&command));
        }
        for command in [
            Command::Stop,
            // 開始は旧通常再生を終了し、マイク送出へ切り替えることがある。
            Command::StartVoiceCheckRecording { max_ms: 1_000 },
            Command::SetInputGain { value: 1.0 },
            Command::SetGlobalMute { active: true },
            Command::Start {
                host: "ASIO".into(),
                input: None,
                output: None,
                sample_rate: Some(96000),
                buffer_size: Some(512),
                initial_controls: None,
            },
            Command::LoadPlugin { path: "vst".into() },
            Command::PlayVoiceCheck {
                source: "raw".into(),
                loop_playback: false,
            },
            Command::StopVoiceCheckPlayback,
            Command::StopTestTone,
        ] {
            assert!(command_changes(&command));
        }
    }

    #[test]
    fn dispatch_notifies_around_changes_but_successful_reads_do_not_invalidate() {
        let conditions = Arc::new(Conditions::default());
        conditions.lifecycle(true);
        let old = conditions.snapshot().unwrap();
        let notifications = std::cell::Cell::new(0);
        conditions
            .dispatch(
                false,
                || Ok::<_, ()>(()),
                || notifications.set(notifications.get() + 1),
            )
            .unwrap();
        assert!(old.validate().is_ok());
        assert_eq!(notifications.get(), 0);
        conditions
            .dispatch(
                true,
                || {
                    assert!(conditions.snapshot().is_err());
                    Ok::<_, ()>(()) // backend拒否の応答もtransport上はOkで扱う。
                },
                || notifications.set(notifications.get() + 1),
            )
            .unwrap();
        assert!(old.validate().is_err());
        assert_eq!(notifications.get(), 2);
        let current = conditions.snapshot().unwrap();
        assert!(conditions
            .dispatch(
                true,
                || Err::<(), _>("timeout"),
                || notifications.set(notifications.get() + 1)
            )
            .is_err());
        assert!(conditions.snapshot().is_err());
        assert!(current.validate().is_err());
        assert_eq!(notifications.get(), 4);
    }

    #[test]
    fn old_engine_events_cannot_make_a_new_engine_ready() {
        let conditions = Arc::new(Conditions::default());
        let old = conditions.new_engine();
        conditions.engine_event(old, true);
        let witness = conditions.snapshot().unwrap();
        conditions.retire_engine();
        let current = conditions.new_engine();
        assert!(!conditions.engine_event(old, true));
        assert!(conditions.snapshot().is_err());
        assert!(witness.validate().is_err());
        assert!(conditions.engine_event(current, true));
        assert!(conditions.snapshot().is_ok());
    }
    #[test]
    fn proposal_preparation_is_read_only_but_apply_invalidates_audio_witness() {
        use crate::audio_engine::{builtin, voice_check::preview};
        assert!(!command_changes(&Command::VoiceCheckPreview {
            request: preview::Request {
                client_id: "test".into(),
                session_id: 1,
                operation_id: 1,
                epoch: Some("preview".into()),
                action: preview::Action::PrepareProposal {
                    rule_version: None,
                    preferences: None,
                    preferences_revision: None,
                    recording_id: 1,
                    builtin_epoch: "builtin".into(),
                    expected_revision: "1".into()
                }
            }
        }));
        assert!(command_changes(&Command::BuiltinEffects {
            request: builtin::Request::ApplyProposal {
                epoch: "builtin".into(),
                expected_revision: "1".into(),
                proposal_id: "p1".into(),
                recording_id: 1
            }
        }));
    }
}
