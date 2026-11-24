//! 子の stdout を読み、応答の待ち手と通知へつなぐ（接続ごとに1本のスレッド）。
//!
//! ホストのロックは持たない・取らない。状態の変更は epoch で古い接続を弾き、
//! 通知は `emit_order` を取った後に接続を確かめてから、列の全体を出す。
use super::*;
use crate::audio::emit::Notifier;
use std::process::ChildStdout;

pub(super) struct Reader {
    pub(super) link: Arc<LinkCell>,
    pub(super) voice_activity: Arc<AtomicBool>,
    pub(super) notifier: Arc<Notifier>,
    pub(super) conditions: Arc<conditions::Conditions>,
    pub(super) epoch: u64,
    pub(super) engine_generation: u64,
    #[cfg(test)]
    pub(super) pause: Option<Pause>,
}

impl Reader {
    pub(super) fn spawn(self, stdout: BufReader<ChildStdout>) {
        thread::spawn(move || self.run(stdout));
    }

    /// 通知の列を出す。列の直前（`emit_order` を取った後）に、自分の接続がまだ開いているかを確かめる。
    fn emit_chain(&self, chain: impl FnOnce(&emit::Chain<'_>)) {
        self.notifier.chain_if(|| self.link.is_open(), chain);
    }

    fn run(self, stdout: BufReader<ChildStdout>) {
        for line in stdout.lines() {
            if !self.link.is_open() {
                break;
            }
            let received_at = Instant::now();
            let Ok(l) = line else {
                continue;
            };
            if l.trim().is_empty() {
                continue;
            }
            if let Some(json_str) = l.strip_prefix("IPC:") {
                match serde_json::from_str::<OutputMessage>(json_str) {
                    Ok(OutputMessage::Response(resp)) => {
                        if !self.link.deliver_at(resp, received_at) {
                            log::warn!("Received Response but no one is waiting");
                        }
                    }
                    Ok(OutputMessage::Event(event)) => self.handle_event(event),
                    Err(e) => {
                        log::error!("Engine IPC parse error: {} (Line: {})", e, l);
                    }
                }
            } else {
                // Non-IPC line (External Log from VST or simple print)
                log::trace!("[Engine Raw] {}", l);
            }
        }
        self.finish();
    }

    pub(super) fn handle_event(&self, event: EngineEvent) {
        let (conditions, epoch) = (&self.conditions, self.epoch);
        match event {
            EngineEvent::ControlStall {
                command,
                plugin_id,
                module,
                elapsed_ms,
            } => {
                log::error!(
                    "[Engine] Control stall: command={command} plugin_id={plugin_id:?} module={module:?} elapsed_ms={elapsed_ms}"
                );
                self.emit_chain(|c| {
                    let _ = c.emit(
                        "audio-control-stall",
                        serde_json::json!({
                            "command": command,
                            "pluginId": plugin_id,
                            "module": module,
                            "elapsedMs": elapsed_ms,
                        }),
                    );
                });
            }
            EngineEvent::MixingSourceFailed | EngineEvent::MixingOutputFailed => {
                if !conditions.engine_changed(epoch) {
                    return;
                }
                let name = if matches!(event, EngineEvent::MixingSourceFailed) {
                    "mixing-source-failed"
                } else {
                    "mixing-output-failed"
                };
                self.emit_chain(|c| {
                    let _ = c.emit("audio-conditions-changed", ());
                    let _ = c.emit(name, ());
                });
            }
            EngineEvent::Log(s) => log::info!("[Engine] {}", s),
            EngineEvent::Error(s) => {
                if !conditions.engine_event(epoch, false) {
                    return;
                }
                log::error!("[Engine] {}", s);
                self.emit_chain(|c| {
                    let _ = c.emit("audio-conditions-changed", ());
                    let _ = c.emit("audio-stream-error", &s);
                });
            }
            EngineEvent::LevelMeter {
                levels,
                stream_generation,
            } => {
                self.emit_chain(|c| {
                    if let Err(e) = c.emit(
                        "audio-level",
                        LevelPayload {
                            levels,
                            stream_generation: stream_generation_label(
                                self.engine_generation,
                                stream_generation,
                            ),
                        },
                    ) {
                        log::warn!("Failed to emit audio-level: {}", e);
                    }
                });
            }
            EngineEvent::Stopped {
                stream_generation,
                ended_stream_generation,
            } => {
                if !conditions.engine_event(epoch, false) {
                    return;
                }
                self.emit_chain(|c| {
                    let _ = c.emit("audio-conditions-changed", ());
                    let _ = c.emit(
                        "audio-stopped",
                        StoppedPayload {
                            stream_generation: stream_generation_label(
                                self.engine_generation,
                                stream_generation,
                            ),
                            ended_stream_generation: stream_generation_label(
                                self.engine_generation,
                                ended_stream_generation,
                            ),
                        },
                    );
                });
            }
            EngineEvent::Loudness(reading) => {
                self.emit_chain(|c| {
                    let _ = c.emit("audio-loudness", reading);
                });
            }
            EngineEvent::ChannelLevels(levels) => {
                self.emit_chain(|c| {
                    if let Err(e) = c.emit("audio-channel-scan", levels) {
                        log::warn!("Failed to emit audio-channel-scan: {}", e);
                    }
                });
            }
            EngineEvent::Started {
                sample_rate,
                buffer_size,
                stream_generation,
            } => {
                if !conditions.engine_event(epoch, true) {
                    return;
                }
                self.emit_chain(|c| {
                    let _ = c.emit("audio-conditions-changed", ());
                    let _ = c.emit(
                        "audio-started",
                        StartedPayload {
                            sample_rate,
                            buffer_size,
                            stream_generation: stream_generation_label(
                                self.engine_generation,
                                stream_generation,
                            ),
                        },
                    );
                });
            }
            EngineEvent::VoiceCheckState {
                state,
                position_ms,
                duration_ms,
            } => {
                let active = matches!(state.as_str(), "recording" | "playing");
                self.voice_activity.store(active, Ordering::Release);
                #[derive(serde::Serialize, Clone)]
                struct VoiceCheckStatePayload {
                    state: String,
                    position_ms: u32,
                    duration_ms: u32,
                }
                self.emit_chain(|c| {
                    let _ = c.emit(
                        "voice-check-state",
                        VoiceCheckStatePayload {
                            state,
                            position_ms,
                            duration_ms,
                        },
                    );
                });
            }
            EngineEvent::EditorOpened { id } => {
                self.emit_chain(|c| {
                    let _ = c.emit("plugin-editor-opened", serde_json::json!({ "id": id }));
                });
            }
            EngineEvent::EditorClosed { id } => {
                self.emit_chain(|c| {
                    let _ = c.emit("plugin-editor-closed", serde_json::json!({ "id": id }));
                });
            }
            EngineEvent::ProcessingHealth {
                state,
                kind,
                recent_late,
                recent_underflow,
                window_secs,
            } => {
                #[derive(serde::Serialize, Clone)]
                #[serde(rename_all = "camelCase")]
                struct ProcessingHealthPayload {
                    state: crate::audio_engine::processing_watch::HealthState,
                    stall_kind: Option<crate::audio_engine::processing_watch::StallKind>,
                    recent_late: u64,
                    recent_underflow: u64,
                    window_secs: u32,
                }
                self.emit_chain(|c| {
                    let _ = c.emit(
                        "audio-processing-health",
                        ProcessingHealthPayload {
                            state,
                            stall_kind: kind,
                            recent_late,
                            recent_underflow,
                            window_secs,
                        },
                    );
                });
            }
            EngineEvent::VoiceCheckEnvelope {
                raw_peaks,
                processed_peaks,
            } => {
                #[derive(serde::Serialize, Clone)]
                struct VoiceCheckEnvelopePayload {
                    raw_peaks: Vec<f32>,
                    processed_peaks: Vec<f32>,
                }
                self.emit_chain(|c| {
                    let _ = c.emit(
                        "voice-check-envelope",
                        VoiceCheckEnvelopePayload {
                            raw_peaks,
                            processed_peaks,
                        },
                    );
                });
            }
        }
    }

    /// stdout の終端（2.4）。先に接続を EOF で閉じる競りを行う。「閉じた」は `LinkCell` だけで決まる。
    /// 勝った側だけが、通知を出し、待ち手へ `Eof` を送る。
    pub(super) fn finish(&self) {
        log::warn!("Engine stdout closed.");
        // 意図した停止、または Host の切り離しが先なら、通知は出さず、待ち手は切断で解放されている。
        let Some(link::EofWin { waiter, exit }) = self.link.close_eof() else {
            return;
        };
        #[cfg(test)]
        if let Some(pause) = &self.pause {
            pause.wait_open();
        }
        log::error!("Audio engine exited: {exit:?}");
        self.conditions.engine_event(self.epoch, false);
        self.notifier.chain(|c| {
            let _ = c.emit("audio-conditions-changed", ());
            let _ = c.emit("audio-engine-exited", exit);
            let _ = c.emit("audio-error", "Audio Engine Process Exited (Crash?)");
        });
        // 通知を出し終えてから、待っている呼び出しを切断で解放する。
        self.link.mark_notified();
        drop(waiter);
    }
}

/// 試験の継ぎ目：`LinkCell` を閉じた直後で、reader を止める。
#[cfg(test)]
#[derive(Clone)]
pub(super) struct Pause(Arc<(Mutex<bool>, std::sync::Condvar)>);

#[cfg(test)]
impl Pause {
    pub(super) fn closed() -> Self {
        Self(Arc::new((Mutex::new(false), std::sync::Condvar::new())))
    }

    pub(super) fn release(&self) {
        *self.0 .0.lock().unwrap() = true;
        self.0 .1.notify_all();
    }

    fn wait_open(&self) {
        let mut open = self.0 .0.lock().unwrap();
        while !*open {
            open = self.0 .1.wait(open).unwrap();
        }
    }
}
