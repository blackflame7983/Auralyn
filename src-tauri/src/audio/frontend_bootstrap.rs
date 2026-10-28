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
}
impl Startup {
    pub(super) fn cancel(&mut self) {
        self.canceled = true;
        self.warmup_error = None;
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GainObservation {
    pub generation: String,
    pub state: crate::audio_engine::auto_gain::Snapshot,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GainIntent {
    pub generation: String,
    pub revision: u64,
    pub gain: f32,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    pub host: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub buffer_size: Option<u32>,
    pub sample_rate: Option<u32>,
    pub input_channels: Option<[usize; 2]>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub config: Option<Config>,
    pub input_gain: f32,
    pub output_gain: f32,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Outcome {
    Started,
    Attached,
    Inactive,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reply {
    pub outcome: Outcome,
    pub initial_page: bool,
    pub error: Option<String>,
}
impl AudioHost {
    pub(crate) fn output_gain_observation(&mut self) -> Result<GainObservation> {
        let generation = self.engine_generation;
        let state = self.auto_gain(crate::audio_engine::auto_gain::Request::Status)?;
        validate_start_generation(generation, self.engine_generation)?;
        Ok(GainObservation {
            generation: generation.to_string(),
            state,
        })
    }
    pub(crate) fn shortcut_gain_intent(&mut self, gain: f32) -> Result<GainIntent> {
        let observed = self.output_gain_observation()?;
        anyhow::ensure!(
            !observed.state.stream_failed && (observed.state.gain - gain).abs() < 0.000001,
            "音量の要求が変更されました"
        );
        Ok(GainIntent {
            generation: observed.generation,
            revision: observed.state.revision,
            gain,
        })
    }
    pub(super) fn prepare_warmup(
        &mut self,
        ensure: impl FnOnce(&mut Self) -> Result<()>,
    ) -> Result<bool> {
        if self.frontend_bootstrap.canceled || self.frontend_bootstrap.warmup_seen {
            return Ok(false);
        }
        self.frontend_bootstrap.warmup_seen = true;
        if let Some(child) = &mut self.child {
            let connected =
                self.reader_active.load(Ordering::Acquire) && matches!(child.try_wait(), Ok(None));
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
    pub(crate) fn frontend_bootstrap(&mut self, request: Request) -> Result<Reply> {
        // reload、停止、明示操作後は状態の取得さえこの要求に付随させない。
        if self.frontend_bootstrap.frontend_seen {
            return Ok(Reply {
                outcome: if self.frontend_bootstrap.warmup_error.is_some() {
                    Outcome::Inactive
                } else {
                    Outcome::Attached
                },
                initial_page: false,
                error: self.frontend_bootstrap.warmup_error.clone(),
            });
        }
        if self.frontend_bootstrap.canceled {
            return Ok(Reply {
                outcome: if self.frontend_bootstrap.warmup_error.is_some() {
                    Outcome::Inactive
                } else {
                    Outcome::Attached
                },
                initial_page: false,
                error: self.frontend_bootstrap.warmup_error.clone(),
            });
        }
        self.frontend_bootstrap.frontend_seen = true;
        anyhow::ensure!(
            [request.input_gain, request.output_gain]
                .iter()
                .all(|gain| gain.is_finite() && (0.0..=2.0).contains(gain)),
            "保存音量が不正です"
        );
        if self
            .last_config_path
            .parent()
            .is_some_and(crate::migration::review_required)
        {
            return Ok(Reply {
                outcome: Outcome::Inactive,
                initial_page: true,
                error: None,
            });
        }
        // 遅いbackground warmupも同じフラグを先に消費し、二度目のStartを送らない。
        if let Err(error) = self.warmup_once() {
            return Ok(Reply {
                outcome: Outcome::Inactive,
                initial_page: true,
                error: self
                    .frontend_bootstrap
                    .warmup_error
                    .clone()
                    .or_else(|| Some(error.to_string())),
            });
        }
        let running = if self.child.is_some() {
            match self.auto_gain(crate::audio_engine::auto_gain::Request::Status) {
                Ok(state) if !state.stream_failed => state.running,
                Ok(_) => {
                    return Ok(Reply {
                        outcome: Outcome::Inactive,
                        initial_page: true,
                        error: Some(
                            "音声状態を確認できません。設定から明示的に再開してください。".into(),
                        ),
                    })
                }
                Err(error) => {
                    return Ok(Reply {
                        outcome: Outcome::Inactive,
                        initial_page: true,
                        error: Some(error.to_string()),
                    })
                }
            }
        } else {
            false
        };
        if self.frontend_bootstrap.canceled {
            return Ok(Reply {
                outcome: if self.frontend_bootstrap.warmup_error.is_some() {
                    Outcome::Inactive
                } else {
                    Outcome::Attached
                },
                initial_page: true,
                error: self.frontend_bootstrap.warmup_error.clone(),
            });
        }
        if self.frontend_bootstrap.automatic_attempted && !running {
            return Ok(Reply {
                outcome: Outcome::Inactive,
                initial_page: true,
                error: Some(
                    "自動開始が完了していません。設定から明示的に再開してください。".into(),
                ),
            });
        }
        if running {
            // warmup自身の開始だけが初回pair/gain適用を許可する。既存の任意稼働には触れない。
            if self.frontend_bootstrap.warmup_succeeded {
                let generation = self.engine_generation;
                let mut commands = Vec::new();
                if self.frontend_bootstrap.input_gain.is_none() {
                    commands.push(IpcCommand::SetInputGain {
                        value: request.input_gain,
                    });
                }
                if self.frontend_bootstrap.output_gain.is_none() {
                    commands.push(IpcCommand::SetOutputGain {
                        value: request.output_gain,
                    });
                }
                if let Some(channels) = request
                    .config
                    .as_ref()
                    .and_then(|config| config.input_channels)
                {
                    commands.push(IpcCommand::SetInputChannels {
                        left: channels[0],
                        right: channels[1],
                    });
                }
                for command in commands {
                    validate_start_generation(generation, self.engine_generation)?;
                    self.guard_live_command(&command)?;
                    let input = if let IpcCommand::SetInputGain { value } = &command {
                        Some(*value)
                    } else {
                        None
                    };
                    let output = if let IpcCommand::SetOutputGain { value } = &command {
                        Some(*value)
                    } else {
                        None
                    };
                    match self.execute_running_command(command)? {
                        IpcResponse::Success => {}
                        IpcResponse::Error(error) => return Err(anyhow!(error)),
                        _ => return Err(anyhow!("初回設定の応答が不正です")),
                    }
                    if let Some(value) = input {
                        self.frontend_bootstrap.input_gain = Some(value);
                    }
                    if let Some(value) = output {
                        self.frontend_bootstrap.output_gain = Some(value);
                    }
                }
            }
            return Ok(Reply {
                outcome: Outcome::Attached,
                initial_page: true,
                error: None,
            });
        }
        let Some(config) = request.config.filter(|config| !config.host.is_empty()) else {
            return Ok(Reply {
                outcome: Outcome::Inactive,
                initial_page: true,
                error: None,
            });
        };
        self.frontend_bootstrap.automatic_attempted = true;
        // warmupがconfig無しでchildだけを準備した場合の、一度だけのfallback。
        if self.child.is_none() {
            self.ensure_engine_running()?;
        }
        let generation = self.engine_generation;
        let input_gain = self
            .frontend_bootstrap
            .input_gain
            .unwrap_or(request.input_gain);
        let output_gain = self
            .frontend_bootstrap
            .output_gain
            .unwrap_or(request.output_gain);
        self.start_internal_guarded(
            Some(config.host),
            config.input,
            config.output,
            config.buffer_size,
            config.sample_rate,
            Some(crate::ipc::StartControls {
                input_gain,
                output_gain,
                input_channels: config.input_channels.unwrap_or([0, 1]),
                muted: self.is_global_muted,
                bypassed: false,
            }),
            Some(generation),
        )?;
        self.frontend_bootstrap.input_gain = Some(input_gain);
        self.frontend_bootstrap.output_gain = Some(output_gain);
        Ok(Reply {
            outcome: Outcome::Started,
            initial_page: true,
            error: None,
        })
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub(super) fn request() -> Request {
        Request {
            config: Some(Config {
                host: "ASIO".into(),
                input: None,
                output: None,
                sample_rate: Some(96000),
                buffer_size: Some(512),
                input_channels: Some([6, 7]),
            }),
            input_gain: 0.3,
            output_gain: 0.2,
        }
    }
    #[cfg(windows)]
    pub(super) fn status(running: bool, failed: bool, gain: f32) -> IpcResponse {
        IpcResponse::AutoGain(crate::audio_engine::auto_gain::Snapshot {
            revision: 3,
            gain,
            confirmed_gain: gain,
            settled: true,
            running,
            stream_failed: failed,
            id: 0,
            phase: "idle".into(),
            progress: 0.,
            proposal: None,
            playing: false,
            error: None,
            devices: Vec::new(),
            history_id: None,
            history_epoch: None,
            undo_available: false,
            redo_available: false,
        })
    }
    #[test]
    fn frontend_bootstrap_stop_without_child_and_warmup_prepare_failure_never_retry_spawn() {
        let mut stopped = AudioHost::new(std::env::temp_dir());
        stopped.stop().unwrap();
        let response = stopped.frontend_bootstrap(request()).unwrap();
        assert!(!response.initial_page);
        stopped.warmup().unwrap();
        assert!(stopped.child.is_none());
        let mut failed = AudioHost::new(std::env::temp_dir());
        let mut attempts = 0;
        assert!(failed
            .prepare_warmup(|_| {
                attempts += 1;
                Err(anyhow!("fixture spawn/job/pipe failure"))
            })
            .is_err());
        assert!(failed.frontend_bootstrap.canceled);
        let response = failed.frontend_bootstrap(request()).unwrap();
        assert_eq!(response.outcome, Outcome::Inactive);
        assert!(response.error.is_some());
        failed.warmup().unwrap();
        assert!(failed.child.is_none());
        assert_eq!(attempts, 1);
    }
    #[cfg(windows)]
    #[test]
    fn frontend_bootstrap_cold_fallback_once_carries_saved_pair_and_prior_session_gains_then_late_warmup_is_noop(
    ) {
        use super::super::session_rack::tests::with_host;
        with_host(
            |command| match command {
                IpcCommand::AutoGain { .. } => status(false, false, 0.4),
                IpcCommand::Start {
                    initial_controls: Some(controls),
                    ..
                } => {
                    assert_eq!(controls.input_channels, [6, 7]);
                    assert_eq!(controls.input_gain, 0.6);
                    assert_eq!(controls.output_gain, 0.4);
                    IpcResponse::Started {
                        sample_rate: 96000,
                        buffer_size: 512,
                        input_id: None,
                        output_id: None,
                    }
                }
                _ => panic!("unexpected IPC"),
            },
            |host, calls| {
                host.frontend_bootstrap.warmup_seen = true; // native config無しでchildだけ準備済み。
                host.frontend_bootstrap.input_gain = Some(0.6);
                host.frontend_bootstrap.output_gain = Some(0.4);
                host.last_config_path = std::env::temp_dir().join(format!(
                    "bootstrap-{}-{}.json",
                    std::process::id(),
                    crate::audio_engine::restoration::unix_ms()
                ));
                let response = host.frontend_bootstrap(request()).unwrap();
                assert_eq!(response.outcome, Outcome::Started);
                assert!(response.initial_page);
                let count = calls.lock().unwrap().len();
                assert!(!host.frontend_bootstrap(request()).unwrap().initial_page);
                host.warmup().unwrap();
                assert_eq!(calls.lock().unwrap().len(), count);
                assert_eq!(
                    calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|c| matches!(c, IpcCommand::Start { .. }))
                        .count(),
                    1
                );
                let _ = std::fs::remove_file(&host.last_config_path);
            },
        );
    }
    #[cfg(windows)]
    #[test]
    fn frontend_bootstrap_warmup_running_pair_survives_initialize_ack_and_never_reapplies_prior_gains(
    ) {
        use super::super::session_rack::tests::with_host;
        with_host(
            |command| match command {
                IpcCommand::AutoGain { .. } => status(true, false, 0.4),
                IpcCommand::SetInputChannels { left, right } => {
                    assert_eq!([left, right], [6, 7]);
                    IpcResponse::Success
                }
                _ => panic!("gain再適用・Startは禁止"),
            },
            |host, calls| {
                host.frontend_bootstrap.warmup_seen = true;
                host.frontend_bootstrap.warmup_succeeded = true;
                host.frontend_bootstrap.automatic_attempted = true;
                host.frontend_bootstrap.input_gain = Some(0.6); // session Begin ACK先行。
                host.auto_gain(crate::audio_engine::auto_gain::Request::Initialize { value: 0.4 })
                    .unwrap();
                assert!(!host.frontend_bootstrap.canceled);
                assert_eq!(
                    host.frontend_bootstrap(request()).unwrap().outcome,
                    Outcome::Attached
                );
                assert_eq!(
                    calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|c| matches!(c, IpcCommand::SetInputChannels { .. }))
                        .count(),
                    1
                );
            },
        );
    }
    #[cfg(windows)]
    #[test]
    fn frontend_bootstrap_explicit_controls_or_stop_win_before_queued_initialization() {
        use super::super::session_rack::tests::with_host;
        for action in ["stop", "input", "output", "pair", "profile"] {
            with_host(
                |command| {
                    if matches!(command, IpcCommand::AutoGain { .. }) {
                        status(false, false, 0.8)
                    } else {
                        IpcResponse::Success
                    }
                },
                |host, calls| {
                    host.frontend_bootstrap.warmup_seen = true;
                    match action {
                        "stop" => host.stop().unwrap(),
                        "input" => host.set_input_gain(0.7).unwrap(),
                        "output" => host.set_output_gain(0.8).unwrap(),
                        "pair" => {
                            host.execute_command(IpcCommand::SetInputChannels {
                                left: 4,
                                right: 5,
                            })
                            .unwrap();
                        }
                        _ => {
                            host.begin_live_changes().unwrap();
                        }
                    }
                    let count = calls.lock().unwrap().len();
                    let response = host.frontend_bootstrap(request()).unwrap();
                    assert!(!response.initial_page);
                    assert_eq!(calls.lock().unwrap().len(), count);
                    host.warmup().unwrap();
                    assert_eq!(calls.lock().unwrap().len(), count);
                },
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn frontend_bootstrap_running_stopped_failed_and_absent_reloads_are_attach_only_and_failed_warmup_is_not_retried(
    ) {
        use super::super::session_rack::tests::with_host;
        for (running, failed) in [(true, false), (false, false), (false, true)] {
            with_host(
                move |_| status(running, failed, 0.2),
                |host, calls| {
                    host.frontend_bootstrap.frontend_seen = true;
                    assert!(!host.frontend_bootstrap(request()).unwrap().initial_page);
                    assert!(calls.lock().unwrap().is_empty());
                },
            );
        }
        let mut absent = AudioHost::new(std::env::temp_dir());
        absent.frontend_bootstrap.frontend_seen = true;
        assert!(!absent.frontend_bootstrap(request()).unwrap().initial_page);
        assert!(absent.child.is_none());
        with_host(
            |_| status(false, false, 1.),
            |host, calls| {
                host.frontend_bootstrap.warmup_seen = true;
                host.frontend_bootstrap.automatic_attempted = true;
                assert_eq!(
                    host.frontend_bootstrap(request()).unwrap().outcome,
                    Outcome::Inactive
                );
                assert!(calls
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|c| matches!(c, IpcCommand::AutoGain { .. })));
            },
        );
    }
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

#[cfg(all(test, windows))]
mod warmup_failure_tests {
    use super::super::session_rack::tests::with_host;
    use super::tests::{request, status};
    use super::*;
    #[test]
    fn frontend_bootstrap_actual_warmup_start_failure_returns_manual_error_and_never_falls_back() {
        with_host(
            |command| match command {
                IpcCommand::Start { .. } => IpcResponse::Error("fixture start failure".into()),
                IpcCommand::SetGlobalMute { .. } => IpcResponse::Success,
                IpcCommand::AutoGain { .. } => status(false, false, 1.),
                _ => panic!("unexpected IPC"),
            },
            |host, calls| {
                host.last_config_path = std::env::temp_dir().join(format!(
                    "warmup-failure-{}-{}.json",
                    std::process::id(),
                    crate::audio_engine::restoration::unix_ms()
                ));
                std::fs::write(&host.last_config_path, r#"{"host":"ASIO","input":null,"output":null,"buffer_size":512,"sample_rate":96000}"#).unwrap();
                let reply = host.frontend_bootstrap(request()).unwrap();
                assert_eq!(reply.outcome, Outcome::Inactive);
                assert!(reply.error.is_some());
                assert_eq!(
                    host.frontend_bootstrap(request()).unwrap().outcome,
                    Outcome::Inactive
                );
                host.warmup().unwrap();
                assert_eq!(
                    calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|command| matches!(command, IpcCommand::Start { .. }))
                        .count(),
                    1
                );
                let _ = std::fs::remove_file(&host.last_config_path);
            },
        );
    }
}

#[cfg(all(test, windows))]
mod connection_tests {
    use super::super::session_rack::tests::with_host;
    use super::tests::{request, status};
    use super::*;
    #[test]
    fn frontend_bootstrap_existing_failed_or_closed_connection_does_not_reenter_ensure() {
        for closed in [false, true] {
            with_host(
                |_| status(false, true, 1.),
                |host, _| {
                    if closed {
                        host.reader_active.store(false, Ordering::Release);
                    }
                    let mut attempts = 0;
                    assert!(host
                        .prepare_warmup(|_| {
                            attempts += 1;
                            Ok(())
                        })
                        .is_err());
                    assert_eq!(attempts, 0);
                    assert_eq!(
                        host.frontend_bootstrap(request()).unwrap().outcome,
                        Outcome::Inactive
                    );
                    assert!(host.child.is_some());
                },
            );
        }
    }
    #[test]
    fn frontend_bootstrap_gain_observation_is_existing_only_and_carries_current_generation_and_ack_revision(
    ) {
        let mut cold = AudioHost::new(std::env::temp_dir());
        assert!(cold.output_gain_observation().is_err());
        assert!(cold.child.is_none());
        with_host(
            |_| status(true, false, 0.6),
            |host, calls| {
                host.conditions.lifecycle(true);
                let witness = host.conditions.snapshot().unwrap();
                let intent = host.shortcut_gain_intent(0.6).unwrap();
                assert_eq!(intent.generation, "0");
                assert_eq!(intent.revision, 3);
                let observed = host.output_gain_observation().unwrap();
                assert_eq!(observed.generation, intent.generation);
                assert_eq!(observed.state.revision, intent.revision);
                assert!(witness.validate().is_ok());
                assert!(calls.lock().unwrap().iter().all(|command| matches!(
                    command,
                    IpcCommand::AutoGain {
                        request: crate::audio_engine::auto_gain::Request::Status
                    }
                )));
            },
        );
    }
}
