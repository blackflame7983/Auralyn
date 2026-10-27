pub(crate) mod conditions;
pub(crate) mod frontend_bootstrap;
mod live_modes;
mod replies;
mod session_rack;
use anyhow::{anyhow, Result};
use replies::ReplySlot;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::{AppHandle, Emitter};

fn persist_audio_config(path: &std::path::Path, config: &ActiveAudioConfig) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("設定保存先がありません"))?;
    std::fs::create_dir_all(dir)?;
    std::fs::write(path, serde_json::to_string_pretty(config)?)?;
    Ok(())
}

#[cfg(windows)]
use crate::process_job as win_job;

// Use shared IPC types
use crate::ipc::DeviceScanStatus;
use crate::ipc::{Command as IpcCommand, EngineEvent, OutputMessage, Response as IpcResponse};

#[derive(Clone, Debug)]
pub(crate) struct DeviceScanTicket {
    generation: u64,
    token: u64,
    started: std::time::Instant,
    terminal: Arc<OnceLock<std::result::Result<AudioDeviceList, String>>>,
}

pub(crate) enum DeviceScanStart {
    Cached(AudioDeviceList),
    Pending(DeviceScanTicket),
}

// Re-export for frontend
#[derive(Debug, Serialize, Clone)]
pub struct AudioDevice {
    pub name: String,
    pub host: String,
    pub is_input: bool,
    pub channels: u16,
    pub index: usize,
    pub is_default: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioDeviceList {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub channels: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ActiveAudioConfig {
    pub host: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub buffer_size: Option<u32>,
    pub sample_rate: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioStateInfo {
    pub is_running: bool,
    pub config: Option<ActiveAudioConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineTuningConfig {
    pub enable_affinity_pinning: bool,
    pub affinity_mask: Option<String>,
    pub enable_realtime_priority: bool,
    pub enable_time_critical_audio_threads: bool,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineRuntimeStats {
    pub preparation: Option<Box<crate::ipc::PreparationSnapshot>>,
    pub active_plugin_count: u32,
    pub enabled_plugin_count: u32,
    pub pending_unload_count: u32,
    pub burned_library_count: u32,
    pub global_bypass: bool,
    pub callback_diagnostics: crate::audio_engine::callback_diagnostics::CallbackSnapshot,
    pub queue_diagnostics: Option<Box<crate::audio_engine::queue_diagnostics::QueueSnapshot>>,
    pub latency_metadata: Option<Box<crate::ipc::LatencyMetadata>>,
    pub frame_timing: Option<Box<crate::audio_engine::frame_timing::Snapshot>>,
    #[serde(default)]
    pub resampler_batch_timing: Option<Box<crate::audio_engine::frame_timing::BatchSnapshot>>,
    #[serde(default)]
    pub resampler_cohort_timing: Option<Box<crate::audio_engine::frame_timing::cohort::Snapshot>>,
    pub max_jitter_us: u64,
    pub glitch_count: u64,
    pub total_plugin_latency_samples: u32,
    pub total_plugin_latency_ms: f64,
    pub noise_reduction_latency_samples: u32,
    pub noise_reduction_latency_ms: f64,
    pub total_chain_latency_samples: u32,
    pub total_chain_latency_ms: f64,
    pub noise_reduction_enabled: bool,
    pub noise_reduction_active: bool,
    pub noise_reduction_mode: String,
    pub noise_learning_state: String,
    pub noise_learning_progress: f32,
    pub noise_profile_available: bool,
    pub noise_profile_rms: f32,
    pub recommended_noise_mix: f32,
    pub speech_detected: bool,
    pub noise_voice_guard: bool,
    pub noise_control_strength: f32,
    pub built_in_effects_enabled: bool,
    pub built_in_effects_preset: String,
    pub built_in_effects_amount: f32,
    pub built_in_singing: Option<crate::audio_engine::singing::SingingParams>,
    pub built_in_reverb: Option<crate::audio_engine::reverb::ReverbParams>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackProbeResult {
    pub detected: bool,
    pub level_db: f32,
    pub unavailable: Option<String>,
}

pub struct AudioHost {
    conditions: Arc<conditions::Conditions>,
    last_config_path: PathBuf,
    maintenance: bool,
    live_modes: live_modes::HostModes,
    voice_activity: Arc<AtomicBool>,
    reader_active: Arc<AtomicBool>,
    child: Option<Child>,
    stdin: Option<BufWriter<ChildStdin>>,
    // We store a sender to satisfy a waiting command.
    // Since we assume sequential commands from the UI (mutex locked AudioState),
    // we only have one pending request at a time.
    pending_reply_tx: Arc<ReplySlot>,
    emitter: Arc<Mutex<Option<AppHandle>>>,
    cached_devices: Option<AudioDeviceList>,
    engine_generation: u64,
    bundle_change_generation: Option<u64>,
    next_restore_operation: u64,
    session_restore: Option<session_rack::Lease>,
    session_restore_generation: Option<u64>,
    peak_intent: Option<crate::audio_engine::peak_protection::Config>,
    frontend_bootstrap: frontend_bootstrap::Startup,
    device_scan: Option<DeviceScanTicket>,
    active_config: Option<ActiveAudioConfig>,
    is_global_muted: bool,
    engine_tuning: EngineTuningConfig,
    #[cfg(windows)]
    engine_job: Option<win_job::Job>,
}

impl AudioHost {
    pub(crate) fn checked_snapshot_supported(&mut self) -> Result<()> {
        self.preflight_live_changes()?;
        anyhow::ensure!(self.live_modes.target.is_none() && self.live_output(None)?.config == Default::default(), "確認済み保存・復帰は単一出力・カスタム音作りが対象です。モニター分離や歌/雑談は各設定で管理してください");
        Ok(())
    }
    pub fn peak_protection(
        &mut self,
        config: Option<crate::audio_engine::peak_protection::Config>,
    ) -> Result<crate::audio_engine::peak_protection::Snapshot> {
        match self.execute_running_command(IpcCommand::PeakProtection { config })? {
            IpcResponse::PeakProtection(snapshot) => {
                if config.is_some() {
                    self.peak_intent = Some(snapshot.config);
                }
                Ok(snapshot)
            }
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("ピーク保護の状態を読み戻せません")),
        }
    }
    pub fn live_output(
        &mut self,
        config: Option<crate::audio_engine::live_output::Config>,
    ) -> Result<crate::audio_engine::live_output::Status> {
        if let Some(value) = &config {
            value.validate()?;
            self.preflight_proposal_apply()?;
        }
        let path = self.last_config_path.with_file_name("live_output.json");
        if config.is_none() && (self.child.is_none() || !self.reader_active.load(Ordering::Acquire))
        {
            let stored = if path.exists() {
                serde_json::from_slice(&std::fs::read(&path)?)?
            } else {
                crate::audio_engine::live_output::Config::default()
            };
            stored.validate()?;
            return Ok(crate::audio_engine::live_output::Status {
                config: stored,
                sink: None,
                error: None,
                broadcast_epoch: None,
                monitor: None,
            });
        }
        let saved = config.clone();
        let previous = if saved.is_some() {
            match self.execute_command(IpcCommand::LiveOutput { config: None })? {
                IpcResponse::LiveOutput(s) => Some(s.config),
                _ => return Err(anyhow!("変更前の出力構成を確認できません")),
            }
        } else {
            None
        };
        if let (Some(next), Some(previous)) = (&saved, &previous) {
            if !next.same_route(previous) {
                self.preflight_live_changes()?;
            }
        }
        let response = if saved.is_none() {
            self.execute_running_command(IpcCommand::LiveOutput { config })?
        } else {
            self.execute_command(IpcCommand::LiveOutput { config })?
        };
        match response {
            IpcResponse::LiveOutput(status) => {
                let mut status = *status;
                if let Some(config) = saved {
                    let pending = path.with_file_name("live_output.pending.json");
                    let persist = serde_json::to_vec(&config)
                        .map_err(anyhow::Error::from)
                        .and_then(|bytes| {
                            std::fs::write(&pending, bytes)?;
                            std::fs::rename(&pending, &path)?;
                            Ok(())
                        });
                    if persist.is_err() {
                        let restored = self
                            .execute_running_command(IpcCommand::LiveOutput { config: previous });
                        return Err(anyhow!(
                            if matches!(restored, Ok(IpcResponse::LiveOutput(_))) {
                                "保存に失敗し、実行中の出力構成を元へ戻しました"
                            } else {
                                "保存と出力構成の復元に失敗しました。音声を停止して構成を確認してください"
                            }
                        ));
                    }
                } else if path.exists() {
                    let stored: crate::audio_engine::live_output::Config =
                        serde_json::from_slice(&std::fs::read(&path)?)?;
                    stored.validate()?;
                    status.config = stored;
                }
                Ok(status)
            }
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("二系統出力の応答を確認できません")),
        }
    }
    pub fn new(config_dir: PathBuf) -> Self {
        Self {
            conditions: Arc::new(conditions::Conditions::default()),
            last_config_path: config_dir.join("last_audio_config.json"),
            maintenance: false,
            live_modes: live_modes::HostModes::new(&config_dir),
            voice_activity: Arc::new(AtomicBool::new(false)),
            reader_active: Arc::new(AtomicBool::new(false)),
            child: None,
            stdin: None,
            pending_reply_tx: Arc::new(ReplySlot::default()),
            emitter: Arc::new(Mutex::new(None)),
            cached_devices: None,
            engine_generation: 0,
            bundle_change_generation: None,
            next_restore_operation: 0,
            session_restore: None,
            session_restore_generation: None,
            peak_intent: None,
            frontend_bootstrap: frontend_bootstrap::Startup::default(),
            device_scan: None,
            active_config: None,
            is_global_muted: false,
            engine_tuning: EngineTuningConfig::default(),
            #[cfg(windows)]
            engine_job: None,
        }
    }

    pub fn set_event_emitter(&mut self, handle: AppHandle) {
        *self.emitter.lock().unwrap() = Some(handle);
    }

    pub(crate) fn conditions(&self) -> Arc<conditions::Conditions> {
        self.conditions.clone()
    }

    fn notify_conditions_changed(&self) {
        if let Some(handle) = self.emitter.lock().unwrap().as_ref() {
            let _ = handle.emit("audio-conditions-changed", ());
        }
    }

    fn apply_engine_tuning_env(&self, command: &mut Command) {
        command.env(
            "AURALYN_ENABLE_AFFINITY_PINNING",
            if self.engine_tuning.enable_affinity_pinning {
                "1"
            } else {
                "0"
            },
        );
        command.env(
            "AURALYN_ENABLE_REALTIME_PRIORITY",
            if self.engine_tuning.enable_realtime_priority {
                "1"
            } else {
                "0"
            },
        );
        command.env(
            "AURALYN_TIME_CRITICAL_AUDIO_THREADS",
            if self.engine_tuning.enable_time_critical_audio_threads {
                "1"
            } else {
                "0"
            },
        );

        match self
            .engine_tuning
            .affinity_mask
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            Some(mask) => {
                command.env("AURALYN_AFFINITY_MASK", mask);
            }
            None => {
                command.env("AURALYN_AFFINITY_MASK", "0");
            }
        }
    }

    fn ensure_engine_running(&mut self) -> Result<()> {
        if self.maintenance {
            return Err(anyhow!("更新を適用中のため音声操作はできません。"));
        }
        // ... (check child logic same as before) ...
        if self.child.is_some() {
            // Check if still alive
            if let Some(c) = self.child.as_mut() {
                match c.try_wait() {
                    Ok(Some(status)) => {
                        log::error!("Audio Engine exited unexpectedly! Status: {}", status);
                        log::warn!("Forcing restart with empty state");
                        self.reader_active.store(false, Ordering::Release);
                        self.child = None;
                        self.stdin = None;
                        #[cfg(windows)]
                        {
                            self.engine_job = None;
                        }
                    }
                    Ok(None) => return Ok(()), // Running
                    Err(e) => {
                        log::error!("Error waiting on audio engine child process: {}", e);
                        self.reader_active.store(false, Ordering::Release);
                        self.child = None;
                        self.stdin = None;
                        #[cfg(windows)]
                        {
                            self.engine_job = None;
                        }
                    }
                }
            }
        }

        log::info!("Spawning Audio Engine Sidecar...");
        let condition_epoch = self.conditions.new_engine();
        self.notify_conditions_changed();
        let cwd = std::env::current_dir()?;
        log::debug!("  CWD: {:?}", cwd);

        let exe = std::env::current_exe()?;
        log::debug!("  Exe Path: {:?}", exe);

        fn find_sidecar_exe(dir: &std::path::Path, base: &str) -> Option<PathBuf> {
            let exact = dir.join(format!("{}.exe", base));
            if exact.exists() {
                return Some(exact);
            }

            // Tauri externalBin naming often looks like: audio_engine-<target-triple>.exe
            let mut best: Option<PathBuf> = None;
            let mut best_is_windows: bool = false;

            let entries = std::fs::read_dir(dir).ok()?;
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
                    continue;
                };

                let lower = file_name.to_ascii_lowercase();
                if !lower.ends_with(".exe") {
                    continue;
                }
                if !lower.starts_with(&format!("{}-", base)) {
                    continue;
                }

                let is_windows = lower.contains("windows");
                if best.is_none() || (!best_is_windows && is_windows) {
                    best = Some(path);
                    best_is_windows = is_windows;
                }
            }

            best
        }

        let exe_dir = exe.parent().unwrap_or_else(|| std::path::Path::new("."));
        let mut candidates: Vec<PathBuf> = vec![
            // Preferred: Tauri bundle layout candidates
            exe_dir.join("audio_engine.exe"),
            exe_dir.join("ns-audio-engine.exe"),
            // Common "bin/" locations for externalBin
            exe_dir.join("bin").join("audio_engine.exe"),
            exe_dir.join("bin").join("ns-audio-engine.exe"),
        ];

        #[cfg(debug_assertions)]
        {
            // Development fallbacks should not be probed in release builds.
            candidates.push(PathBuf::from("target/debug/audio_engine.exe"));
            candidates.push(PathBuf::from("src-tauri/target/debug/audio_engine.exe"));
            candidates.push(cwd.join("target/debug/audio_engine.exe"));
            candidates.push(cwd.join("src-tauri/target/debug/audio_engine.exe"));
        }

        // Tauri externalBin triple-suffixed fallback (search)
        if let Some(p) = find_sidecar_exe(exe_dir, "audio_engine") {
            candidates.push(p);
        }
        if let Some(p) = find_sidecar_exe(&exe_dir.join("bin"), "audio_engine") {
            candidates.push(p);
        }

        let binary_path = candidates
            .iter()
            .find(|p| {
                let exists = p.exists();
                log::debug!("  Checking: {:?} -> {}", p, exists);
                exists
            })
            .cloned()
            .ok_or_else(|| anyhow!("Audio Engine binary not found"))?;

        log::info!("Found engine at: {:?}", binary_path);

        #[cfg(windows)]
        let mut child = {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let mut command = Command::new(binary_path);
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .creation_flags(CREATE_NO_WINDOW);
            self.apply_engine_tuning_env(&mut command);
            command.spawn()?
        };

        #[cfg(not(windows))]
        let mut child = {
            let mut command = Command::new(binary_path);
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());
            self.apply_engine_tuning_env(&mut command);
            command.spawn()?
        };

        // Best-effort: kill process tree (child + grandchildren) on host drop/restart (Windows)
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;

            let job = win_job::Job::new_kill_on_drop();
            if let Some(ref job) = job {
                let _ = job.assign(HANDLE(child.as_raw_handle()));
            }
            self.engine_job = job;
        }

        let stdin = BufWriter::new(child.stdin.take().unwrap());
        let stdout = BufReader::new(child.stdout.take().unwrap());

        self.stdin = Some(stdin);
        self.child = Some(child);
        self.engine_generation = self.engine_generation.wrapping_add(1);
        self.device_scan = None;

        // Spawn Output Reader Thread
        // 終了した旧プロセスの応答・終了通知を、新プロセスの待機やUIへ渡さない。
        self.pending_reply_tx = Arc::new(ReplySlot::default());
        self.reader_active = Arc::new(AtomicBool::new(true));
        let reader_active = self.reader_active.clone();
        let pending_tx_clone = self.pending_reply_tx.clone();
        let emitter_clone = self.emitter.clone();
        self.voice_activity = Arc::new(AtomicBool::new(false));
        let voice_activity = self.voice_activity.clone();
        let conditions = self.conditions.clone();

        thread::spawn(move || {
            for line in stdout.lines() {
                if !reader_active.load(Ordering::Acquire) {
                    break;
                }
                let Ok(l) = line else {
                    continue;
                };
                if l.trim().is_empty() {
                    continue;
                }

                if let Some(json_str) = l.strip_prefix("IPC:") {
                    match serde_json::from_str::<OutputMessage>(json_str) {
                        Ok(msg) => match msg {
                            OutputMessage::Response(resp) => {
                                if !pending_tx_clone.deliver(resp) {
                                    log::warn!("Received Response but no one is waiting");
                                }
                            }
                            OutputMessage::Event(evt) => match evt {
                                EngineEvent::Log(s) => log::info!("[Engine] {}", s),
                                EngineEvent::Error(s) => {
                                    if !conditions.engine_event(condition_epoch, false) {
                                        continue;
                                    }
                                    log::error!("[Engine] {}", s);
                                    if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                                        let _ = h.emit("audio-conditions-changed", ());
                                        let _ = h.emit("audio-stream-error", &s);
                                    }
                                }
                                EngineEvent::LevelMeter(levels) => {
                                    if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                                        if let Err(e) = h.emit("audio-level", levels) {
                                            log::warn!("Failed to emit audio-level: {}", e);
                                        }
                                    }
                                }
                                EngineEvent::Stopped => {
                                    if !conditions.engine_event(condition_epoch, false) {
                                        continue;
                                    }
                                    if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                                        let _ = h.emit("audio-conditions-changed", ());
                                        let _ = h.emit("audio-stopped", ());
                                    }
                                }
                                EngineEvent::Loudness(reading) => {
                                    if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                                        let _ = h.emit("audio-loudness", reading);
                                    }
                                }
                                EngineEvent::ChannelLevels(levels) => {
                                    if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                                        if let Err(e) = h.emit("audio-channel-scan", levels) {
                                            log::warn!("Failed to emit audio-channel-scan: {}", e);
                                        }
                                    }
                                }
                                EngineEvent::Started {
                                    sample_rate,
                                    buffer_size,
                                } => {
                                    if !conditions.engine_event(condition_epoch, true) {
                                        continue;
                                    }
                                    if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                                        let _ = h.emit("audio-conditions-changed", ());
                                        #[derive(serde::Serialize, Clone)]
                                        struct StartedPayload {
                                            sample_rate: u32,
                                            buffer_size: u32,
                                        }
                                        let _ = h.emit(
                                            "audio-started",
                                            StartedPayload {
                                                sample_rate,
                                                buffer_size,
                                            },
                                        );
                                    }
                                }
                                EngineEvent::VoiceCheckState {
                                    state,
                                    position_ms,
                                    duration_ms,
                                } => {
                                    voice_activity.store(
                                        matches!(state.as_str(), "recording" | "playing"),
                                        Ordering::Release,
                                    );
                                    if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                                        #[derive(serde::Serialize, Clone)]
                                        struct VoiceCheckStatePayload {
                                            state: String,
                                            position_ms: u32,
                                            duration_ms: u32,
                                        }
                                        let _ = h.emit(
                                            "voice-check-state",
                                            VoiceCheckStatePayload {
                                                state,
                                                position_ms,
                                                duration_ms,
                                            },
                                        );
                                    }
                                }
                                EngineEvent::VoiceCheckEnvelope {
                                    raw_peaks,
                                    processed_peaks,
                                } => {
                                    if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                                        #[derive(serde::Serialize, Clone)]
                                        struct VoiceCheckEnvelopePayload {
                                            raw_peaks: Vec<f32>,
                                            processed_peaks: Vec<f32>,
                                        }
                                        let _ = h.emit(
                                            "voice-check-envelope",
                                            VoiceCheckEnvelopePayload {
                                                raw_peaks,
                                                processed_peaks,
                                            },
                                        );
                                    }
                                }
                            },
                        },
                        Err(e) => {
                            log::error!("Engine IPC parse error: {} (Line: {})", e, l);
                        }
                    }
                } else {
                    // Non-IPC line (External Log from VST or simple print)
                    log::trace!("[Engine Raw] {}", l);
                }
            }

            log::warn!("Engine stdout closed.");
            if !reader_active.swap(false, Ordering::AcqRel) {
                return;
            }
            // Notify Frontend of crash/exit
            conditions.engine_event(condition_epoch, false);
            if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                let _ = h.emit("audio-conditions-changed", ());
                let _ = h.emit("audio-error", "Audio Engine Process Exited (Crash?)");
            }

            // 終了時は待機中の呼出しを直ちに解放する。
            pending_tx_clone.deliver(IpcResponse::Error("Engine Crashed/Exited".to_string()));
        });

        if let Some(config) = self.peak_intent {
            let result = self.execute_running_command(IpcCommand::PeakProtection {
                config: Some(config),
            });
            if !matches!(&result, Ok(IpcResponse::PeakProtection(snapshot)) if snapshot.config == config)
            {
                self.kill_engine();
                return Err(anyhow!(
                    "ピーク保護を新しいEngineへ引き継げません。音声を開始していません"
                ));
            }
        }
        Ok(())
    }

    fn execute_command(&mut self, cmd: IpcCommand) -> Result<IpcResponse> {
        if conditions::command_changes(&cmd) {
            self.frontend_bootstrap.cancel();
            match &cmd {
                IpcCommand::SetInputGain { value } => {
                    self.frontend_bootstrap.input_gain = Some(*value)
                }
                IpcCommand::SetOutputGain { value } => {
                    self.frontend_bootstrap.output_gain = Some(*value)
                }
                _ => {}
            }
        }
        // 診断の明示読出しでengineを起動・本番設定を同期しない。
        if matches!(&cmd, IpcCommand::GetFrameTimingTrace { .. }) {
            return self.execute_running_command_inner(cmd);
        }
        if self.bundle_change_generation.is_some() {
            self.validate_bundle_connection()?;
        } else {
            self.ensure_engine_running()?;
        }
        self.sync_live_modes()?;
        self.guard_live_command(&cmd)?;
        let custom = matches!(
            &cmd,
            IpcCommand::SetBuiltInEffects { .. }
                | IpcCommand::BuiltinEffects {
                    request: crate::audio_engine::builtin::Request::Apply { .. }
                        | crate::audio_engine::builtin::Request::Undo { .. }
                        | crate::audio_engine::builtin::Request::ApplyProposal { .. }
                }
        );
        let response = self.execute_running_command(cmd)?;
        if custom && !matches!(response, IpcResponse::Error(_)) {
            self.live_modes.target = None;
        }
        Ok(response)
    }

    // 一連の開始準備中に別engineを起動し、適用済みの設定を失わない。
    fn execute_running_command(&mut self, cmd: IpcCommand) -> Result<IpcResponse> {
        let conditions = self.conditions.clone();
        let emitter = self.emitter.clone();
        conditions.dispatch(
            conditions::command_changes(&cmd),
            || self.execute_running_command_inner(cmd),
            || {
                if let Some(handle) = emitter.lock().unwrap().as_ref() {
                    let _ = handle.emit("audio-conditions-changed", ());
                }
            },
        )
    }

    fn execute_running_command_inner(&mut self, cmd: IpcCommand) -> Result<IpcResponse> {
        anyhow::ensure!(
            self.reader_active.load(Ordering::Acquire),
            "音声エンジンとの通信が終了しました"
        );
        let json = serde_json::to_string(&cmd)?;

        // IDのない直列プロトコルなので、タイムアウトした応答を受け取るまで
        // 次の要求を送らない。古い応答を新しい操作の成功と取り違えないため。
        let rx = self.pending_reply_tx.begin()?;
        let sent = match &mut self.stdin {
            Some(stdin) => writeln!(stdin, "{}", json).and_then(|()| stdin.flush()),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "Stdin not available",
            )),
        };
        if let Err(error) = sent {
            self.pending_reply_tx.cancel();
            // 書きかけのJSONや遅い応答が残る接続を再利用しない。
            self.kill_engine();
            if let Ok(emitter) = self.emitter.lock() {
                if let Some(handle) = emitter.as_ref() {
                    let _ = handle.emit("audio-error", "音声エンジンとの通信が切れました");
                }
            }
            return Err(error.into());
        }

        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| anyhow!("Timeout or disconnect waiting for engine response: {e}"))
    }

    // 同期呼出元（プロファイル適用）は取得済み一覧だけを読む。
    // 明示再検出はcommands::get_audio_devicesのBegin/Poll経路を使う。
    pub fn enumerate_devices(&mut self, force_refresh: bool) -> Result<AudioDeviceList> {
        anyhow::ensure!(
            !force_refresh,
            "再検出には非同期のデバイス取得を使用してください"
        );
        if !force_refresh {
            if let Some(cache) = &self.cached_devices {
                log::debug!("Returning cached device list");
                return Ok(cache.clone());
            }
        }

        match self.execute_command(IpcCommand::GetDevices)? {
            IpcResponse::Devices(dl) => {
                let mut inputs = Vec::new();
                let mut outputs = Vec::new();
                for (i, d) in dl.into_iter().enumerate() {
                    let ad = AudioDevice {
                        name: d.name,
                        host: d.host,
                        is_input: d.is_input,
                        channels: d.channels,
                        index: i,
                        is_default: d.is_default,
                    };
                    if ad.is_input {
                        inputs.push(ad);
                    } else {
                        outputs.push(ad);
                    }
                }
                let list = AudioDeviceList { inputs, outputs };
                self.cached_devices = Some(list.clone());
                Ok(list)
            }
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub(crate) fn begin_device_scan(&mut self, force_refresh: bool) -> Result<DeviceScanStart> {
        if !force_refresh {
            if let Some(cache) = &self.cached_devices {
                return Ok(DeviceScanStart::Cached(cache.clone()));
            }
        }
        if let Some(ticket) = self.device_scan.clone() {
            if ticket.started.elapsed() < std::time::Duration::from_secs(35) {
                return Ok(DeviceScanStart::Pending(ticket));
            }
            // 呼出futureが破棄されても、期限切れtokenを次回へ持ち越さない。
            let _ = self.cancel_device_scan(&ticket);
        }
        match self.execute_command(IpcCommand::BeginDeviceScan)? {
            IpcResponse::DeviceScanStarted { token } => {
                let ticket = DeviceScanTicket {
                    generation: self.engine_generation,
                    token,
                    started: std::time::Instant::now(),
                    terminal: Arc::new(OnceLock::new()),
                };
                self.device_scan = Some(ticket.clone());
                Ok(DeviceScanStart::Pending(ticket))
            }
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("Unexpected device scan response")),
        }
    }

    fn scan_is_current(&self, ticket: &DeviceScanTicket) -> bool {
        self.engine_generation == ticket.generation
            && self.device_scan.as_ref().is_some_and(|current| {
                current.generation == ticket.generation && current.token == ticket.token
            })
    }

    pub(crate) fn poll_device_scan(
        &mut self,
        ticket: &DeviceScanTicket,
    ) -> Result<Option<AudioDeviceList>> {
        // 完了済みでも旧engineの結果は返さない。caller共有のterminalは新Beginで消さない。
        anyhow::ensure!(
            ticket.generation == self.engine_generation,
            "音声エンジンの再起動でデバイス検出要求が失効しました"
        );
        if let Some(result) = ticket.terminal.get() {
            return result.clone().map(Some).map_err(anyhow::Error::msg);
        }
        anyhow::ensure!(
            self.scan_is_current(ticket),
            "デバイス検出要求は失効しています"
        );
        anyhow::ensure!(
            self.reader_active.load(Ordering::Acquire),
            "検出中に音声エンジンとの通信が終了しました"
        );
        let response = self.execute_command(IpcCommand::PollDeviceScan {
            token: ticket.token,
        });
        anyhow::ensure!(
            self.scan_is_current(ticket),
            "音声エンジンの再起動でデバイス検出要求が失効しました"
        );
        match response {
            Ok(IpcResponse::DeviceScanStatus { token, status }) if token == ticket.token => {
                match status {
                    DeviceScanStatus::Pending => Ok(None),
                    DeviceScanStatus::Completed(devices) => {
                        self.finish_device_scan(ticket, devices).map(Some)
                    }
                    DeviceScanStatus::Failed(error) => self.fail_device_scan(ticket, error),
                    DeviceScanStatus::Cancelled => {
                        self.fail_device_scan(ticket, "デバイス検出を取り消しました".into())
                    }
                }
            }
            Ok(IpcResponse::Error(error)) => self.fail_device_scan(ticket, error),
            Ok(_) => self.fail_device_scan(ticket, "Unexpected device scan response".into()),
            Err(error) => self.fail_device_scan(ticket, error.to_string()),
        }
    }

    fn fail_device_scan(
        &mut self,
        ticket: &DeviceScanTicket,
        error: String,
    ) -> Result<Option<AudioDeviceList>> {
        let _ = ticket.terminal.set(Err(error.clone()));
        if self.scan_is_current(ticket) {
            self.device_scan = None;
        }
        Err(anyhow!(error))
    }

    fn finish_device_scan(
        &mut self,
        ticket: &DeviceScanTicket,
        devices: Vec<crate::ipc::DeviceInfo>,
    ) -> Result<AudioDeviceList> {
        anyhow::ensure!(
            self.scan_is_current(ticket),
            "デバイス検出要求は失効しています"
        );
        self.device_scan = None;
        let mut list = AudioDeviceList {
            inputs: Vec::new(),
            outputs: Vec::new(),
        };
        for (index, device) in devices.into_iter().enumerate() {
            let device = AudioDevice {
                name: device.name,
                host: device.host,
                is_input: device.is_input,
                channels: device.channels,
                index,
                is_default: device.is_default,
            };
            if device.is_input {
                list.inputs.push(device);
            } else {
                list.outputs.push(device);
            }
        }
        self.cached_devices = Some(list.clone());
        let _ = ticket.terminal.set(Ok(list.clone()));
        Ok(list)
    }

    pub(crate) fn cancel_device_scan(&mut self, ticket: &DeviceScanTicket) -> Result<()> {
        if !self.scan_is_current(ticket) {
            return Ok(());
        }
        self.device_scan = None;
        let _ = ticket
            .terminal
            .set(Err("デバイス検出を取り消しました".into()));
        if !self.reader_active.load(Ordering::Acquire) {
            return Ok(());
        }
        match self.execute_command(IpcCommand::CancelDeviceScan {
            token: ticket.token,
        })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("Unexpected device scan cancellation response")),
        }
    }

    pub fn start(
        &mut self,
        host_name: Option<String>,
        input_name: Option<String>,
        output_name: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
    ) -> Result<AudioConfig> {
        self.frontend_bootstrap.cancel();
        self.start_internal(
            host_name,
            input_name,
            output_name,
            buffer_size,
            sample_rate,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn start_internal(
        &mut self,
        host_name: Option<String>,
        input_name: Option<String>,
        output_name: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
        initial_controls: Option<crate::ipc::StartControls>,
    ) -> Result<AudioConfig> {
        self.start_internal_guarded(
            host_name,
            input_name,
            output_name,
            buffer_size,
            sample_rate,
            initial_controls,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn start_internal_guarded(
        &mut self,
        host_name: Option<String>,
        input_name: Option<String>,
        output_name: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
        initial_controls: Option<crate::ipc::StartControls>,
        expected_generation: Option<u64>,
    ) -> Result<AudioConfig> {
        if let Some(controls) = initial_controls {
            controls.validate().map_err(|e| anyhow!(e))?;
        }
        crate::desktop_integration::check_microphone_access(host_name.as_deref())
            .map_err(|error| anyhow!(error))?;
        let cmd = IpcCommand::Start {
            host: host_name.clone().unwrap_or("ASIO".to_string()),
            input: input_name.clone(),
            output: output_name.clone(),
            buffer_size,
            sample_rate,
            initial_controls,
        };

        log::info!("Sending Start Command: {:?}", cmd);

        if let Some(expected) = expected_generation {
            validate_start_generation(expected, self.engine_generation)?;
            anyhow::ensure!(
                self.child.is_some() && self.reader_active.load(Ordering::Acquire),
                "初期化中に音声接続が終了しました"
            );
        } else if self.bundle_change_generation.is_some() && initial_controls.is_none() {
            self.validate_bundle_connection()?;
        } else {
            self.ensure_engine_running()?;
            if self.bundle_change_generation.is_some() {
                // 明示bundle再起動だけが、操作中の世代更新を引き受ける。
                self.bundle_change_generation = Some(self.engine_generation);
            }
        }
        let generation = self.engine_generation;
        self.sync_live_modes()?;
        self.guard_live_command(&cmd)?;
        let live_path = self.last_config_path.with_file_name("live_output.json");
        if live_path.exists() {
            let config: crate::audio_engine::live_output::Config =
                serde_json::from_slice(&std::fs::read(live_path)?)?;
            config.validate()?;
            match self.execute_running_command(IpcCommand::LiveOutput {
                config: Some(config),
            })? {
                IpcResponse::LiveOutput(_) => {}
                IpcResponse::Error(error) => return Err(anyhow!(error)),
                _ => return Err(anyhow!("二系統出力の保存構成を反映できません")),
            }
        }
        let muted = self.is_global_muted;
        validate_start_generation(generation, self.engine_generation)?;
        let response = if initial_controls.is_some() {
            self.start_on_existing_generation(generation, cmd)?
        } else {
            start_with_mute(muted, cmd, |command| self.execute_running_command(command))?
        };
        validate_start_generation(generation, self.engine_generation)?;
        match response {
            IpcResponse::Started {
                sample_rate,
                buffer_size,
            } => {
                // Update active config
                let config = ActiveAudioConfig {
                    host: host_name.clone().unwrap_or("ASIO".to_string()),
                    input: input_name,
                    output: output_name,
                    buffer_size: Some(buffer_size),
                    sample_rate: Some(sample_rate),
                };

                // Persist for fast auto-start on next launch
                if let Err(e) = persist_audio_config(&self.last_config_path, &config) {
                    log::warn!("Failed to save last audio config: {}", e);
                }

                self.active_config = Some(config);
                if let Some(controls) = initial_controls {
                    self.is_global_muted = controls.muted;
                }

                Ok(AudioConfig {
                    sample_rate,
                    buffer_size,
                    channels: 2, // Hardcoded for now, or fetch?
                })
            }
            IpcResponse::Success => {
                // For backward compatibility or if engine doesn't return Started (it should now)
                // Or maybe restart_audio_engine calls start which calls this...
                // If we updated core.rs, it should only return Started for Start command.
                // But let's handle Success gracefully just in case?
                // No, core.rs change is definitive.
                Err(anyhow!("Unexpected Success response, expected Started"))
            }
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    // 停止・画面の後始末で共有する。生存中の通信断を停止済みと推測しない。
    fn reap_confirmed_stopped_connection(&mut self) -> Result<bool> {
        if self.reader_active.load(Ordering::Acquire) {
            return Ok(false);
        }
        if let Some(child) = &mut self.child {
            if child.try_wait()?.is_none() {
                return Ok(false);
            }
        }
        // 通常StopのIPCがなくてもwitness・本番保護・声の活動状態を失効させる。
        self.kill_engine();
        Ok(true)
    }

    pub fn stop(&mut self) -> Result<()> {
        self.frontend_bootstrap.cancel();
        self.frontend_bootstrap.session_claimed = true;
        if self.reap_confirmed_stopped_connection()? {
            return Ok(());
        }
        // 停止は新しいchildを起動せず、確認後に終了した旧接続も再生成しない。
        match self.execute_running_command(IpcCommand::Stop)? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn load_plugin(&mut self, path: &str) -> Result<String> {
        match self.execute_command(IpcCommand::LoadPlugin {
            path: path.to_string(),
        })? {
            IpcResponse::PluginLoaded {
                id,
                name: _,
                vendor: _,
            } => Ok(id),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn restore_plugin(
        &mut self,
        request: crate::ipc::RestorePluginRequest,
    ) -> Result<crate::ipc::RestoredPlugin> {
        request.validate().map_err(|error| anyhow!(error))?;
        if self.bundle_change_generation.is_some() {
            self.validate_bundle_connection()?;
        } else {
            self.ensure_engine_running()?;
        }
        let generation = self.engine_generation;
        self.next_restore_operation = self
            .next_restore_operation
            .checked_add(1)
            .ok_or_else(|| anyhow!("VST復元操作IDの上限です"))?;
        let operation_id = self.next_restore_operation;
        let response = self.execute_running_command(IpcCommand::RestorePlugin {
            request,
            operation_id,
            expires_at_ms: crate::audio_engine::restoration::unix_ms().saturating_add(8_000),
        })?;
        validate_restore_response(generation, self.engine_generation, operation_id, response)
    }

    pub fn remove_plugin(&mut self, id: &str) -> Result<()> {
        // 削除・取消後の回収のために新しいengineを起こさない。
        // 生存接続では従来の本番保護と条件変更通知を維持する。
        self.sync_live_modes()?;
        let command = IpcCommand::UnloadPlugin { id: id.to_string() };
        self.guard_live_command(&command)?;
        match self.execute_running_command(command)? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn reorder_plugins(&mut self, order: Vec<String>) -> Result<()> {
        match self.execute_command(IpcCommand::ReorderPlugins { order })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_bypass(&mut self, id: &str, active: bool) -> Result<()> {
        match self.execute_command(IpcCommand::SetBypass {
            id: id.to_string(),
            active,
        })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_mute(&mut self, id: &str, active: bool) -> Result<()> {
        match self.execute_command(IpcCommand::SetMute {
            id: id.to_string(),
            active,
        })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_gain(&mut self, id: &str, value: f32) -> Result<()> {
        match self.execute_command(IpcCommand::SetGain {
            id: id.to_string(),
            value,
        })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn open_editor(&mut self, id: &str) -> Result<()> {
        match self.execute_command(IpcCommand::OpenEditor { id: id.to_string() })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_global_mute(&mut self, active: bool) -> Result<()> {
        match self.execute_command(IpcCommand::SetGlobalMute { active })? {
            IpcResponse::Success => {
                self.is_global_muted = active;
                // Emit event for UI update
                if let Some(h) = self.emitter.lock().unwrap().as_ref() {
                    let _ = h.emit("global-mute-changed", active);
                }
                Ok(())
            }
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn toggle_global_mute(&mut self) -> Result<()> {
        let new_state = !self.is_global_muted;
        self.set_global_mute(new_state)
    }

    pub fn set_input_gain(&mut self, value: f32) -> Result<()> {
        match self.execute_command(IpcCommand::SetInputGain { value })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_noise_reduction(&mut self, active: bool, mode: Option<String>) -> Result<()> {
        match self.execute_command(IpcCommand::SetNoiseReduction { active, mode })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn noise_measurement(
        &mut self,
        request: crate::audio_engine::core::noise_learning::Request,
    ) -> Result<crate::audio_engine::core::noise_learning::Snapshot> {
        match self.execute_running_command(IpcCommand::NoiseMeasurement { request })? {
            IpcResponse::NoiseMeasurement(snapshot) => Ok(*snapshot),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("測定状態を確認できません")),
        }
    }

    pub fn start_noise_learning(&mut self, duration_ms: u32) -> Result<()> {
        match self.execute_command(IpcCommand::StartNoiseLearning { duration_ms })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn cancel_noise_learning(&mut self) -> Result<()> {
        match self.execute_command(IpcCommand::CancelNoiseLearning)? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_noise_control_config(
        &mut self,
        active: bool,
        mode: String,
        strength: f32,
        voice_guard: bool,
    ) -> Result<()> {
        if !strength.is_finite() {
            return Err(anyhow!("ノイズ低減の抑制強度が不正です"));
        }
        match self.execute_command(IpcCommand::SetNoiseControlConfig {
            active,
            mode,
            strength,
            voice_guard,
        })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_built_in_effects(
        &mut self,
        active: bool,
        preset: Option<String>,
        amount: f32,
    ) -> Result<()> {
        self.set_built_in_effects_full(active, preset, amount, None)
    }

    pub fn set_built_in_effects_full(
        &mut self,
        active: bool,
        preset: Option<String>,
        amount: f32,
        singing: Option<crate::audio_engine::singing::SingingParams>,
    ) -> Result<()> {
        self.set_built_in_effects_with_reverb(active, preset, amount, singing, None)
    }

    pub fn set_built_in_effects_with_reverb(
        &mut self,
        active: bool,
        preset: Option<String>,
        amount: f32,
        singing: Option<crate::audio_engine::singing::SingingParams>,
        reverb: Option<crate::audio_engine::reverb::ReverbParams>,
    ) -> Result<()> {
        match self.execute_command(IpcCommand::SetBuiltInEffects {
            active,
            preset,
            amount,
            singing,
            reverb,
        })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn builtin_effects(
        &mut self,
        request: crate::audio_engine::builtin::Request,
    ) -> Result<crate::audio_engine::builtin::Snapshot> {
        let response = if matches!(
            &request,
            crate::audio_engine::builtin::Request::ApplyProposal { .. }
        ) {
            self.preflight_proposal_apply()?;
            anyhow::ensure!(
                !self.reap_confirmed_stopped_connection()?,
                "音声エンジンが終了したため提案の期限が切れました"
            );
            self.sync_live_modes()?;
            let command = IpcCommand::BuiltinEffects { request };
            self.guard_live_command(&command)?;
            let response = self.execute_running_command(command)?;
            if !matches!(&response, IpcResponse::Error(_)) {
                self.live_modes.target = None;
            }
            response
        } else {
            self.execute_command(IpcCommand::BuiltinEffects { request })?
        };
        match response {
            IpcResponse::BuiltinEffects(snapshot) => Ok(snapshot),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("Unexpected builtin response")),
        }
    }

    pub fn set_loudness_measurement(&mut self, id: Option<u64>) -> Result<()> {
        let response = if id.is_none() {
            if self.reap_confirmed_stopped_connection()? {
                return Ok(());
            }
            self.execute_running_command(IpcCommand::SetLoudnessMeasurement { id })?
        } else {
            self.execute_command(IpcCommand::SetLoudnessMeasurement { id })?
        };
        match response {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_output_gain(&mut self, value: f32) -> Result<()> {
        match self.execute_command(IpcCommand::SetOutputGain { value })? {
            IpcResponse::Success => {
                // プリセットからの変更も、RT反映前に成功として保存させない。
                for _ in 0..100 {
                    let state = self.auto_gain(crate::audio_engine::auto_gain::Request::Status)?;
                    if state.stream_failed {
                        return Err(anyhow!("音声ストリームが停止しています。音声を再起動して現在の音量を確認してください"));
                    }
                    if state.gain != value {
                        return Err(anyhow!("出力音量が変更されました"));
                    }
                    if state.settled || !state.running {
                        return Ok(());
                    }
                    thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(anyhow!(
                    "出力音量の反映を確認できません。現在の状態を確認してください"
                ))
            }
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn auto_gain(
        &mut self,
        request: crate::audio_engine::auto_gain::Request,
    ) -> Result<crate::audio_engine::auto_gain::Snapshot> {
        let initializing = matches!(
            &request,
            crate::audio_engine::auto_gain::Request::Initialize { .. }
        );
        if matches!(request, crate::audio_engine::auto_gain::Request::Cancel)
            && self.reap_confirmed_stopped_connection()?
        {
            // cancelの成功は録音・試聴が存在しないことだけ。gainは未確認で保存対象にしない。
            return Ok(crate::audio_engine::auto_gain::Snapshot {
                revision: 0,
                gain: 1.0,
                confirmed_gain: 1.0,
                settled: false,
                running: false,
                stream_failed: false,
                id: 0,
                phase: "idle".into(),
                progress: 0.0,
                proposal: None,
                playing: false,
                error: None,
                devices: Vec::new(),
            });
        }
        let existing_only = matches!(
            request,
            crate::audio_engine::auto_gain::Request::Status
                | crate::audio_engine::auto_gain::Request::Initialize { .. }
                | crate::audio_engine::auto_gain::Request::Cancel
        );
        let command = IpcCommand::AutoGain { request };
        let response = if existing_only {
            // 常時status監視と保存gainの再試行は、停止後のchildを起動しない。
            self.guard_live_command(&command)?;
            self.execute_running_command(command)?
        } else {
            self.execute_command(command)?
        };
        match response {
            IpcResponse::AutoGain(state) => {
                if initializing && !state.stream_failed {
                    self.frontend_bootstrap.output_gain = Some(state.gain);
                }
                Ok(state)
            }
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("音量調整の状態を取得できません")),
        }
    }

    pub fn set_global_bypass(&mut self, active: bool) -> Result<()> {
        match self.execute_command(IpcCommand::SetGlobalBypass { active })? {
            IpcResponse::Success => {
                if let Ok(emitter) = self.emitter.lock() {
                    if let Some(handle) = emitter.as_ref() {
                        let _ = handle.emit("global-bypass-changed", active);
                    }
                }
                Ok(())
            }
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_input_channels(&mut self, left: usize, right: usize) -> Result<()> {
        match self.execute_command(IpcCommand::SetInputChannels { left, right })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub(crate) fn capture_bundle_state(&mut self) -> Result<crate::bundle::EngineCapture> {
        let generation = self.engine_generation;
        let result = self.execute_running_command(IpcCommand::CaptureBundleState)?;
        anyhow::ensure!(
            generation == self.engine_generation,
            "取得中に音声世代が変わりました"
        );
        match result {
            IpcResponse::BundleState(snapshot) => Ok(*snapshot),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("配信状態の応答を確認できません")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_bundle(
        &mut self,
        host: Option<String>,
        input: Option<String>,
        output: Option<String>,
        buffer: Option<u32>,
        rate: Option<u32>,
        intent: crate::profile::StartIntent,
    ) -> Result<AudioConfig> {
        intent.validate().map_err(|e| anyhow!(e))?;
        self.validate_bundle_connection()?;
        self.preflight_live_changes()?;
        self.preserve_live_changes_for_restart();
        self.kill_engine();
        self.start_internal(host, input, output, buffer, rate, Some(intent))
    }

    fn validate_bundle_connection(&self) -> Result<()> {
        if let Some(expected) = self.bundle_change_generation {
            validate_start_generation(expected, self.engine_generation)?;
            anyhow::ensure!(
                self.reader_active.load(Ordering::Acquire),
                "配信状態の変更中に音声エンジンが終了しました"
            );
        }
        Ok(())
    }

    pub(crate) fn bundle_change_scope<T>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> std::result::Result<T, String>,
    ) -> std::result::Result<T, String> {
        if self.bundle_change_generation.is_some() {
            return Err("配信状態の変更が重複しています".into());
        }
        self.bundle_change_generation = Some(self.engine_generation);
        let result = self
            .validate_bundle_connection()
            .map_err(|e| e.to_string())
            .and_then(|()| operation(self));
        let intact = self.validate_bundle_connection().map_err(|e| e.to_string());
        self.bundle_change_generation = None;
        let value = result?;
        intact?;
        Ok(value)
    }

    fn start_on_existing_generation(
        &mut self,
        generation: u64,
        command: IpcCommand,
    ) -> Result<IpcResponse> {
        validate_start_generation(generation, self.engine_generation)?;
        let response = self.execute_running_command(command)?;
        validate_start_generation(generation, self.engine_generation)?;
        Ok(response)
    }

    pub fn get_plugin_state(&mut self, id: &str) -> Result<String> {
        // 保存開始後に旧engineが終了しても、読み取りで新engineを起こさない。
        match self.execute_running_command(IpcCommand::GetPluginState { id: id.to_string() })? {
            IpcResponse::PluginState { state, .. } => Ok(state),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_plugin_state(&mut self, id: &str, state: &str) -> Result<()> {
        match self.execute_command(IpcCommand::SetPluginState {
            id: id.to_string(),
            state: state.to_string(),
        })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn unload_all_plugins(&mut self, ids: &[String]) -> Result<()> {
        for id in ids {
            self.remove_plugin(id)?;
        }
        Ok(())
    }

    pub fn set_channel_scan(&mut self, active: bool) -> Result<()> {
        match self.execute_command(IpcCommand::SetChannelScan { active })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn start_voice_check(&mut self, max_ms: u32) -> Result<()> {
        match self.execute_command(IpcCommand::StartVoiceCheckRecording { max_ms })? {
            IpcResponse::Success => {
                self.voice_activity.store(true, Ordering::Release);
                Ok(())
            }
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn voice_check_preview(
        &mut self,
        request: crate::audio_engine::voice_check::preview::Request,
    ) -> Result<crate::audio_engine::voice_check::preview::Snapshot> {
        // 閉じた画面の古いpoll/停止で、終了済みのengineを起動し直さない。
        if !matches!(
            request.action,
            crate::audio_engine::voice_check::preview::Action::Open
        ) && !self.reader_active.load(Ordering::Acquire)
        {
            return Err(anyhow!(
                "音声エンジンとの通信が終了しました。試聴画面を開き直してください"
            ));
        }
        let response = if matches!(
            &request.action,
            crate::audio_engine::voice_check::preview::Action::PrepareProposal { .. }
                | crate::audio_engine::voice_check::preview::Action::PrepareNoise { .. }
                | crate::audio_engine::voice_check::preview::Action::ApplyNoise { .. }
                | crate::audio_engine::voice_check::preview::Action::UndoNoise { .. }
        ) {
            let generation = self.engine_generation;
            self.require_proposal_connection(generation)?;
            self.prepare_proposal_on_existing_generation(generation, request)?
        } else {
            self.execute_command(IpcCommand::VoiceCheckPreview { request })?
        };
        match response {
            IpcResponse::VoiceCheckPreview(snapshot) => Ok(*snapshot),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("Unexpected voice preview response")),
        }
    }

    fn require_proposal_connection(&mut self, generation: u64) -> Result<()> {
        validate_start_generation(generation, self.engine_generation)?;
        anyhow::ensure!(
            self.reader_active.load(Ordering::Acquire),
            "音声エンジンとの通信が終了しました"
        );
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| anyhow!("既存の音声エンジンがありません。提案を作成し直してください"))?;
        anyhow::ensure!(
            child.try_wait()?.is_none(),
            "音声エンジンが終了しました。提案を作成し直してください"
        );
        Ok(())
    }

    fn prepare_proposal_on_existing_generation(
        &mut self,
        generation: u64,
        request: crate::audio_engine::voice_check::preview::Request,
    ) -> Result<IpcResponse> {
        // reader通知前のchild終了と、直前の検査後の終了を再起動で補わない。
        self.require_proposal_connection(generation)?;
        let response = self.execute_running_command(IpcCommand::VoiceCheckPreview { request })?;
        self.require_proposal_connection(generation)?;
        Ok(response)
    }

    pub fn stop_voice_check(&mut self) -> Result<()> {
        match self.execute_command(IpcCommand::StopVoiceCheckRecording)? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn play_voice_check(&mut self, source: String, loop_playback: bool) -> Result<()> {
        match self.execute_command(IpcCommand::PlayVoiceCheck {
            source,
            loop_playback,
        })? {
            IpcResponse::Success => {
                self.voice_activity.store(true, Ordering::Release);
                Ok(())
            }
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn stop_voice_check_playback(&mut self) -> Result<()> {
        match self.execute_command(IpcCommand::StopVoiceCheckPlayback)? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn export_voice_check(&mut self, path: String, source: String) -> Result<()> {
        match self.execute_command(IpcCommand::ExportVoiceCheck { path, source })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn play_test_tone(&mut self, freq_hz: f32, duration_ms: u32, level_db: f32) -> Result<()> {
        match self.execute_command(IpcCommand::PlayTestTone {
            freq_hz,
            duration_ms,
            level_db,
        })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    // 到達確認は既存streamだけを使う。別操作が入った後の古い後始末から
    // 新しいtoneや利用者の停止を変更しないよう、開始ACK後の条件を所有する。
    pub(crate) fn begin_obs_reach_tone(&mut self, duration_ms: u32) -> Result<conditions::Witness> {
        self.conditions.snapshot().map_err(anyhow::Error::msg)?;
        let command = IpcCommand::PlayTestTone {
            freq_hz: 1000.0,
            duration_ms,
            level_db: -20.0,
        };
        self.guard_live_command(&command)?;
        match self.execute_running_command(command)? {
            IpcResponse::Success => self.conditions.snapshot().map_err(anyhow::Error::msg),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub(crate) fn finish_obs_reach_tone(
        &mut self,
        witness: &conditions::Witness,
    ) -> Result<conditions::Witness> {
        witness.validate().map_err(anyhow::Error::msg)?;
        match self.execute_running_command(IpcCommand::StopTestTone)? {
            IpcResponse::Success => self.conditions.snapshot().map_err(anyhow::Error::msg),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn stop_test_tone(&mut self) -> Result<()> {
        match self.execute_command(IpcCommand::StopTestTone)? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn probe_loopback(
        &mut self,
        input_device: String,
        duration_ms: u32,
        freq_hz: f32,
    ) -> Result<LoopbackProbeResult> {
        match self.execute_command(IpcCommand::ProbeLoopback {
            input_device,
            duration_ms,
            freq_hz,
        })? {
            IpcResponse::LoopbackProbe {
                detected,
                level_db,
                unavailable,
            } => Ok(LoopbackProbeResult {
                detected,
                level_db,
                unavailable,
            }),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_engine_tuning_config(&mut self, mut config: EngineTuningConfig) {
        config.affinity_mask = config
            .affinity_mask
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        self.engine_tuning = config;
    }

    pub fn get_engine_tuning_config(&self) -> EngineTuningConfig {
        self.engine_tuning.clone()
    }

    pub fn get_engine_runtime_stats(&mut self) -> Result<EngineRuntimeStats> {
        if self.bundle_change_generation.is_some() {
            self.validate_bundle_connection()?;
            anyhow::ensure!(
                self.child.is_some(),
                "配信状態の変更中に音声エンジンが終了しました"
            );
        }
        if self.child.is_none() {
            return Ok(EngineRuntimeStats::default());
        }

        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.kill_engine();
                    self.validate_bundle_connection()?;
                    return Ok(EngineRuntimeStats::default());
                }
                Err(error) => return Err(error.into()),
                Ok(None) => {}
            }
        }

        match self.execute_running_command(IpcCommand::GetRuntimeStats)? {
            IpcResponse::RuntimeStats {
                preparation,
                active_plugin_count,
                enabled_plugin_count,
                pending_unload_count,
                burned_library_count,
                global_bypass,
                callback_diagnostics,
                queue_diagnostics,
                latency_metadata,
                frame_timing,
                resampler_batch_timing,
                resampler_cohort_timing,
                max_jitter_us,
                glitch_count,
                total_plugin_latency_samples,
                total_plugin_latency_ms,
                noise_reduction_latency_samples,
                noise_reduction_latency_ms,
                total_chain_latency_samples,
                total_chain_latency_ms,
                noise_reduction_enabled,
                noise_reduction_active,
                noise_reduction_mode,
                noise_learning_state,
                noise_learning_progress,
                noise_profile_available,
                noise_profile_rms,
                recommended_noise_mix,
                speech_detected,
                noise_voice_guard,
                noise_control_strength,
                built_in_effects_enabled,
                built_in_effects_preset,
                built_in_effects_amount,
                built_in_singing,
                built_in_reverb,
            } => Ok(EngineRuntimeStats {
                preparation,
                active_plugin_count,
                enabled_plugin_count,
                pending_unload_count,
                burned_library_count,
                global_bypass,
                callback_diagnostics: *callback_diagnostics,
                queue_diagnostics,
                latency_metadata,
                frame_timing,
                resampler_batch_timing,
                resampler_cohort_timing,
                max_jitter_us,
                glitch_count,
                total_plugin_latency_samples,
                total_plugin_latency_ms,
                noise_reduction_latency_samples,
                noise_reduction_latency_ms,
                total_chain_latency_samples,
                total_chain_latency_ms,
                noise_reduction_enabled,
                noise_reduction_active,
                noise_reduction_mode,
                noise_learning_state,
                noise_learning_progress,
                noise_profile_available,
                noise_profile_rms,
                recommended_noise_mix,
                speech_detected,
                noise_voice_guard,
                noise_control_strength,
                built_in_effects_enabled,
                built_in_effects_preset,
                built_in_effects_amount,
                built_in_singing,
                built_in_reverb,
            }),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn check_can_interrupt(&mut self) -> Result<()> {
        if self.maintenance {
            return Err(anyhow!(
                "変更を反映済みです。再起動してから操作してください。"
            ));
        }
        if self.voice_activity.load(Ordering::Acquire) {
            return Err(anyhow!(
                "ボイスチェックの録音・試聴を終了してから更新してください。"
            ));
        }
        if self.child.is_some() {
            let gain = self.auto_gain(crate::audio_engine::auto_gain::Request::Status)?;
            if gain.phase == "recording" || gain.playing {
                return Err(anyhow!(
                    "音量調整の録音・試聴を終了してから更新してください。"
                ));
            }
        }
        Ok(())
    }

    pub fn prepare_update(&mut self) -> Result<()> {
        self.check_can_interrupt()?;
        if self.child.is_some() {
            self.stop()?;
        }
        self.maintenance = true;
        self.kill_engine();
        Ok(())
    }

    pub fn finish_update_attempt(&mut self) {
        self.maintenance = false;
    }

    pub fn kill_engine(&mut self) {
        if self.child.is_some() {
            self.frontend_bootstrap.cancel();
            self.frontend_bootstrap.session_claimed = true;
        }
        self.invalidate_live_protection();
        self.live_modes.needs_sync = true;
        self.conditions.retire_engine();
        self.notify_conditions_changed();
        self.engine_generation = self.engine_generation.wrapping_add(1);
        self.device_scan = None;
        // 先に旧readerを無効にし、意図した停止をクラッシュとして通知しない。
        self.reader_active.store(false, Ordering::Release);
        if let Some(mut child) = self.child.take() {
            log::warn!("Force Killing Audio Engine...");
            let _ = child.kill();
            let _ = child.wait();
        }
        self.stdin = None;
        self.child = None;
        self.voice_activity.store(false, Ordering::Release);
        #[cfg(windows)]
        {
            self.engine_job = None;
        }
    }

    pub fn warmup(&mut self) -> Result<()> {
        if self.frontend_bootstrap.frontend_seen {
            return Ok(());
        }
        self.warmup_once()
    }

    fn warmup_once(&mut self) -> Result<()> {
        if !self.prepare_warmup(Self::ensure_engine_running)? {
            return Ok(());
        }
        if self
            .last_config_path
            .parent()
            .is_some_and(crate::migration::review_required)
        {
            log::info!("移行後の設定確認が済むまで音声を自動開始しません");
            return Ok(());
        }

        // Fast auto-start: read last successful config and start immediately
        // This avoids waiting for the frontend to load and send the Start command.
        let path = &self.last_config_path;
        match std::fs::read_to_string(path) {
            Ok(json) => {
                match serde_json::from_str::<ActiveAudioConfig>(&json) {
                    Ok(config) if !config.host.is_empty() => {
                        self.frontend_bootstrap.automatic_attempted = true;
                        log::info!("Auto-starting audio with last config: {:?}", config);
                        let generation = self.engine_generation;
                        match self.start_internal_guarded(
                            Some(config.host),
                            config.input,
                            config.output,
                            config.buffer_size,
                            config.sample_rate,
                            None,
                            Some(generation),
                        ) {
                            Ok(res) => {
                                self.frontend_bootstrap.warmup_succeeded = true;
                                log::info!(
                                    "Auto-start successful (SR={}, Buf={})",
                                    res.sample_rate,
                                    res.buffer_size
                                );
                            }
                            Err(e) => {
                                self.frontend_bootstrap.cancel();
                                self.frontend_bootstrap.warmup_error = Some("自動開始が完了していません。設定から明示的に再開してください。".into());
                                log::warn!("Auto-start failed (user can start manually): {}", e);
                            }
                        }
                    }
                    Ok(_) => log::debug!("Last config has empty host, skipping auto-start"),
                    Err(e) => log::debug!("Failed to parse last config: {}", e),
                }
            }
            Err(_) => log::debug!("No last audio config found, skipping auto-start"),
        }

        Ok(())
    }

    pub(crate) fn require_explicit_start(&mut self) {
        self.frontend_bootstrap.cancel();
        self.frontend_bootstrap.session_claimed = true;
    }

    pub fn get_state(&self) -> AudioStateInfo {
        AudioStateInfo {
            is_running: self.child.is_some(),
            config: self.active_config.clone(),
        }
    }
}

impl Drop for AudioHost {
    fn drop(&mut self) {
        self.conditions.retire_engine();
        if let Some(mut child) = self.child.take() {
            log::info!("Killing Audio Engine Sidecar (Drop)...");
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        {
            self.engine_job = None;
        }
    }
}

// ミュート確認を受けた同じ接続だけでStartする。拒否・通信失敗ではStartしない。
fn validate_restore_response(
    expected_generation: u64,
    generation: u64,
    operation_id: u64,
    response: IpcResponse,
) -> Result<crate::ipc::RestoredPlugin> {
    anyhow::ensure!(
        generation == expected_generation,
        "VST復元中に音声エンジンが変わりました"
    );
    match response {
        IpcResponse::PluginRestored {
            operation_id: received,
            plugin,
        } if received == operation_id => Ok(plugin),
        IpcResponse::Error(error) => Err(anyhow!(error)),
        _ => Err(anyhow!("VST復元の応答が操作と一致しません")),
    }
}

fn validate_start_generation(expected: u64, actual: u64) -> Result<()> {
    anyhow::ensure!(
        expected == actual,
        "開始準備中に音声エンジンが変わりました。開始していません"
    );
    Ok(())
}

fn start_with_mute(
    active: bool,
    start: IpcCommand,
    mut execute: impl FnMut(IpcCommand) -> Result<IpcResponse>,
) -> Result<IpcResponse> {
    match execute(IpcCommand::SetGlobalMute { active })? {
        IpcResponse::Success => execute(start),
        IpcResponse::Error(error) => Err(anyhow!(error)),
        _ => Err(anyhow!("Unexpected global mute response before Start")),
    }
}

// Global state container
pub struct AudioState(pub Arc<Mutex<AudioHost>>);

/// Translate common audio engine errors into user-friendly Japanese messages.
pub fn localize_audio_error(e: String) -> String {
    let lower = e.to_lowercase();

    if lower.contains("sample clock or rate cannot be determined") {
        return "オーディオデバイスのサンプルレートを取得できません。\n\n\
                他のアプリ（Discord・ブラウザなど）がデバイスを使用中の可能性があります。\n\
                → 他のアプリを閉じてから、もう一度お試しください。\n\
                → 解決しない場合は「サウンド設定」でサンプルレートを確認してください。"
            .to_string();
    }
    if lower.contains("device not found") {
        return "オーディオデバイスが見つかりません。\n\n\
             → デバイスが接続されているか確認してください。\n\
             → 接続し直した後、「更新」ボタンを押してください。"
            .to_string();
    }
    if lower.contains("access is denied")
        || lower.contains("access denied")
        || lower.contains("0x80070005")
        || e.contains("アクセスが拒否")
    {
        return "オーディオデバイスへのアクセスが拒否されました。\n\n\
                → Windows設定 > プライバシーとセキュリティ > マイクを確認してください。\n\
                → Store・MSIX版はアプリ一覧のAuralyn、通常配布版はデスクトップアプリの許可も確認してください。\n\
                → 排他モードを使用中の場合は、他のアプリを閉じてください。"
            .to_string();
    }
    if lower.contains("stream configuration is not supported") {
        return "選択した設定はこのデバイスに対応していません。\n\n\
                → バッファサイズを大きくしてみてください（例: 512 → 1024）。\n\
                → それでも解決しない場合は「かんたん設定」をお試しください。"
            .to_string();
    }
    // Default fallback
    format!("オーディオエラーが発生しました。\n\n詳細: {}", e)
}

#[cfg(test)]
mod permission_error_tests {
    use super::localize_audio_error;

    #[test]
    fn access_denied_in_both_languages_and_hresult_has_permission_guidance() {
        for error in [
            "Input Stream Build Failed: Access is denied.",
            "アクセスが拒否されました。(0x80070005)",
            "Input Stream Build Failed: HRESULT 0x80070005",
        ] {
            let message = localize_audio_error(error.to_owned());
            assert!(message.contains("Store・MSIX版"));
            assert!(message.contains("デスクトップアプリの許可"));
            assert!(message.contains("他のアプリを閉じて"));
        }
    }

    #[test]
    fn unrelated_audio_errors_do_not_claim_a_permission_denial() {
        let message = localize_audio_error("buffer allocation failed".to_owned());
        assert!(!message.contains("アクセスが拒否"));
        assert!(message.contains("buffer allocation failed"));
    }
}

#[cfg(test)]
mod config_storage_tests {
    use super::*;
    #[test]
    fn live_output_read_and_invalid_configuration_never_spawn_or_invalidate_conditions() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-readonly-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut host = AudioHost::new(root);
        let witness = host.conditions.control_snapshot().unwrap();
        let snapshot = host.live_output(None).unwrap();
        assert!(snapshot.config.device_id.is_none());
        assert!(snapshot.sink.is_none());
        assert!(snapshot.monitor.is_none());
        assert!(host.child.is_none());
        assert!(witness.validate().is_ok());
        assert!(host
            .live_output(Some(crate::audio_engine::live_output::Config {
                monitor_trim: f32::NAN,
                ..Default::default()
            }))
            .is_err());
        assert!(host.child.is_none());
        assert!(witness.validate().is_ok());
    }

    #[test]
    fn obs_reach_never_spawns_for_stopped_or_missing_stream() {
        let mut host = AudioHost::new(std::env::temp_dir());
        assert!(host.begin_obs_reach_tone(100).is_err());
        assert!(host.child.is_none());
        host.conditions.lifecycle(true);
        assert!(host.begin_obs_reach_tone(100).is_err());
        assert!(host.child.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn obs_reach_ack_captures_own_stop_but_old_cleanup_never_stops_new_tone_or_user_stop() {
        use std::os::windows::process::CommandExt;
        let mut host = AudioHost::new(std::env::temp_dir());
        // 音声engineではない有限の所有fixture。実音声・OBSへ接続しない。
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "while($null -ne ($line=[Console]::In.ReadLine())){[Console]::Out.WriteLine($line)}"])
            .creation_flags(0x0800_0000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
        let stdout = child.stdout.take().unwrap();
        host.child = Some(child);
        host.reader_active.store(true, Ordering::Release);
        let slot = host.pending_reply_tx.clone();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let recorded = commands.clone();
        let fail_start = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let failure = fail_start.clone();
        let conditions = host.conditions.clone();
        let worker = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                recorded
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str::<IpcCommand>(&line).unwrap());
                let response = match failure.swap(0, Ordering::SeqCst) {
                    1 => IpcResponse::Error("開始拒否".into()),
                    2 => {
                        conditions.lifecycle(false);
                        IpcResponse::Success
                    }
                    _ => IpcResponse::Success,
                };
                slot.deliver(response);
            }
        });
        host.conditions.lifecycle(true);
        let result = (|| -> Result<()> {
            let first = host.begin_obs_reach_tone(100)?;
            let finished = host.finish_obs_reach_tone(&first)?;
            assert!(finished.validate().is_ok());
            assert!(finished.revision() > first.revision());
            let old = host.begin_obs_reach_tone(100)?;
            host.execute_running_command(IpcCommand::SetInputGain { value: 0.5 })?;
            let count = commands.lock().unwrap().len();
            assert!(host.finish_obs_reach_tone(&old).is_err());
            assert_eq!(commands.lock().unwrap().len(), count);
            let new = host.begin_obs_reach_tone(100)?;
            assert!(host.finish_obs_reach_tone(&old).is_err());
            host.finish_obs_reach_tone(&new)?;
            let last = host.begin_obs_reach_tone(100)?;
            host.execute_running_command(IpcCommand::Stop)?;
            let count = commands.lock().unwrap().len();
            assert!(host.finish_obs_reach_tone(&last).is_err());
            assert_eq!(commands.lock().unwrap().len(), count);
            // 開始拒否／開始ACK後のstream異常では所有権を発行せず、
            // 未所有のStopを送らない。IPCのduration自体に有限期限がある。
            for failure in [1, 2] {
                host.conditions.lifecycle(true);
                fail_start.store(failure, Ordering::SeqCst);
                let count = commands.lock().unwrap().len();
                assert!(host.begin_obs_reach_tone(100).is_err());
                let sent = commands.lock().unwrap();
                assert_eq!(sent.len(), count + 1);
                assert!(matches!(
                    sent.last(),
                    Some(IpcCommand::PlayTestTone {
                        duration_ms: 100,
                        ..
                    })
                ));
            }
            Ok(())
        })();
        host.kill_engine();
        worker.join().unwrap();
        result.unwrap();
    }

    #[test]
    fn frame_timing_trace_read_does_not_spawn_or_invalidate_audio_conditions() {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.conditions.lifecycle(true);
        let witness = host.conditions.snapshot().unwrap();
        assert!(host
            .execute_command(IpcCommand::GetFrameTimingTrace {
                expected_epoch: "old".into()
            })
            .is_err());
        assert!(host.child.is_none());
        assert!(!host.reader_active.load(Ordering::Acquire));
        assert!(witness.validate().is_ok());
    }

    #[test]
    fn restore_requires_matching_operation_and_engine_generation_and_valid_input() {
        let response = || IpcResponse::PluginRestored {
            operation_id: 7,
            plugin: crate::ipc::RestoredPlugin {
                id: "id".into(),
                name: "Mock".into(),
                prepared: false,
            },
        };
        assert!(validate_restore_response(1, 1, 7, response()).is_ok());
        assert!(validate_restore_response(1, 2, 7, response()).is_err());
        assert!(validate_restore_response(1, 1, 8, response()).is_err());
        let mut host = AudioHost::new(std::env::temp_dir());
        assert!(host
            .restore_plugin(crate::ipc::RestorePluginRequest {
                path: "mock.vst3".into(),
                state: None,
                bypassed: false,
                muted: false,
                gain: f32::NAN
            })
            .is_err());
        assert!(host.child.is_none());
        let request = crate::ipc::RestorePluginRequest {
            path: "mock.vst3".into(),
            state: Some(String::new()),
            bypassed: true,
            muted: true,
            gain: 0.0,
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["state"], "");
        assert_eq!(json["bypassed"], true);
        assert_eq!(
            serde_json::from_value::<crate::ipc::RestorePluginRequest>(json)
                .unwrap()
                .state
                .as_deref(),
            Some("")
        );
    }

    fn start_command() -> IpcCommand {
        IpcCommand::Start {
            host: "ASIO".into(),
            input: None,
            output: None,
            buffer_size: None,
            sample_rate: None,
            initial_controls: None,
        }
    }

    #[test]
    fn start_sends_retained_mute_before_start_in_both_states() {
        for active in [false, true] {
            let mut sent = Vec::new();
            let response = start_with_mute(active, start_command(), |command| {
                let response = if matches!(command, IpcCommand::Start { .. }) {
                    IpcResponse::Started {
                        sample_rate: 48000,
                        buffer_size: 512,
                    }
                } else {
                    IpcResponse::Success
                };
                sent.push(command);
                Ok(response)
            })
            .unwrap();
            assert!(
                matches!(sent.as_slice(), [IpcCommand::SetGlobalMute { active: value }, IpcCommand::Start { .. }] if *value == active)
            );
            assert!(matches!(response, IpcResponse::Started { .. }));
        }
    }

    #[test]
    fn bundle_start_keeps_initial_controls_in_one_request_and_rejects_retired_generation() {
        let mut command = start_command();
        if let IpcCommand::Start {
            initial_controls, ..
        } = &mut command
        {
            *initial_controls = Some(crate::ipc::StartControls {
                input_gain: 0.,
                output_gain: 0.,
                input_channels: [4, 5],
                muted: true,
                bypassed: true,
            });
        }
        let json = serde_json::to_value(&command).unwrap();
        let parsed: IpcCommand = serde_json::from_value(json).unwrap();
        assert!(matches!(
            parsed,
            IpcCommand::Start {
                initial_controls: Some(crate::ipc::StartControls {
                    output_gain: 0.,
                    input_channels: [4, 5],
                    ..
                }),
                ..
            }
        ));
        assert!(validate_start_generation(7, 7).is_ok());
        assert!(validate_start_generation(7, 8).is_err());
        let mut host = AudioHost::new(std::env::temp_dir());
        host.engine_generation = 7;
        assert!(host
            .start_on_existing_generation(6, start_command())
            .is_err());
        assert!(host.child.is_none());
        // 同じ世代でもStart直前のreader終了を新engine起動で補わない。
        assert!(host
            .start_on_existing_generation(7, start_command())
            .is_err());
        assert!(host.child.is_none());
        assert!(!host.reader_active.load(Ordering::Acquire));
        let mut legacy = serde_json::to_value(start_command()).unwrap();
        legacy.as_object_mut().unwrap().remove("initial_controls");
        assert!(serde_json::from_value::<IpcCommand>(legacy).is_ok());
    }

    #[test]
    fn start_is_not_sent_after_mute_rejection_or_connection_loss() {
        for failure in 0..3 {
            let mut sent = Vec::new();
            assert!(start_with_mute(true, start_command(), |command| {
                sent.push(command);
                match failure {
                    0 => Err(anyhow!("connection lost")),
                    1 => Ok(IpcResponse::Error("rejected".into())),
                    _ => Ok(IpcResponse::Started {
                        sample_rate: 48000,
                        buffer_size: 512,
                    }),
                }
            })
            .is_err());
            assert!(matches!(
                sent.as_slice(),
                [IpcCommand::SetGlobalMute { active: true }]
            ));
        }
        let mut sent = Vec::new();
        assert!(start_with_mute(true, start_command(), |command| {
            sent.push(command);
            if sent.len() == 1 {
                Ok(IpcResponse::Success)
            } else {
                Err(anyhow!("engine exited after mute"))
            }
        })
        .is_err());
        assert_eq!(sent.len(), 2); // 再接続や設定なしの再Startは行わない。
    }

    #[test]
    fn invalid_noise_strength_is_rejected_before_starting_or_sending_to_engine() {
        let mut host = AudioHost::new(std::env::temp_dir());
        for strength in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(host
                .set_noise_control_config(true, "smart".into(), strength, true)
                .is_err());
            assert!(host.child.is_none());
        }
    }

    #[test]
    fn stopped_without_child_is_idempotent_but_rejected_mutations_keep_mute_intent() {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.maintenance = true;
        host.is_global_muted = true;
        assert!(host.stop().is_ok());
        assert!(host.unload_all_plugins(&["plugin".into()]).is_err());
        assert!(host.set_global_mute(false).is_err());
        assert!(host.is_global_muted);
    }

    #[test]
    fn stop_without_engine_never_spawns_or_changes_retained_intent() {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.is_global_muted = true;
        host.conditions.lifecycle(true);
        let old_conditions = host.conditions.snapshot().unwrap();
        host.voice_activity.store(true, Ordering::Release);
        assert!(host.stop().is_ok());
        assert!(host.child.is_none());
        assert!(host.stdin.is_none());
        assert!(!host.reader_active.load(Ordering::Acquire));
        assert!(old_conditions.validate().is_err());
        assert!(!host.voice_activity.load(Ordering::Acquire));
        assert!(host.is_global_muted);
    }

    #[test]
    fn stop_after_reader_exit_or_broken_pipe_does_not_restart_engine() {
        let mut host = AudioHost::new(std::env::temp_dir());
        // UIが稼働状態を読んだ後、readerが終了した場合。
        host.reader_active.store(true, Ordering::Release);
        host.reader_active.store(false, Ordering::Release);
        assert!(host.stop().is_ok());
        assert!(host.child.is_none());
        // reader終了通知より先にstdinが失われた場合も、失敗接続を回収するだけ。
        host.reader_active.store(true, Ordering::Release);
        assert!(host.stop().is_err());
        assert!(host.child.is_none());
        assert!(host.stdin.is_none());
        assert!(!host.reader_active.load(Ordering::Acquire));
    }

    #[test]
    fn cancelled_restore_cleanup_never_spawns_for_old_plugin_id() {
        let mut host = AudioHost::new(std::env::temp_dir());
        assert!(host.remove_plugin("late-old-id").is_err());
        assert!(host.child.is_none());
        assert_eq!(host.engine_generation, 0);
        // 一度同期済みのreader終了・壊れたpipeも、新しいengineでは回収しない。
        host.live_modes.needs_sync = false;
        assert!(host.remove_plugin("late-old-id").is_err());
        assert!(host.child.is_none());
        host.reader_active.store(true, Ordering::Release);
        assert!(host.remove_plugin("late-old-id").is_err());
        assert!(host.child.is_none());
        assert!(!host.reader_active.load(Ordering::Acquire));
    }

    fn background_observation(host: &mut AudioHost, kind: usize) -> Result<()> {
        use crate::audio_engine::auto_gain::Request;
        match kind {
            0 => host.auto_gain(Request::Status).map(|_| ()),
            1 => host
                .auto_gain(Request::Initialize { value: 0.5 })
                .map(|_| ()),
            2 => host.get_plugin_state("old-id").map(|_| ()),
            _ => host.get_engine_runtime_stats().map(|_| ()),
        }
    }

    #[test]
    fn bundle_restore_fatal_stops_later_chain_requests_before_send_or_spawn() {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.engine_generation = 7;
        host.reader_active.store(true, Ordering::Release);
        // ensure経路に退行しても、fixtureが実sidecarを起動しないよう防ぐ。
        host.maintenance = true;
        let request = || crate::ipc::RestorePluginRequest {
            path: "fixture-vst".into(),
            state: Some(String::new()),
            bypassed: false,
            muted: false,
            gain: 1.,
        };
        let result = host.bundle_change_scope(|host| {
            // 最初の要求は既存接続へ送信を試み、閉じたstdinによりfatalになる。
            assert!(host.restore_plugin(request()).is_err());
            assert_eq!(host.next_restore_operation, 1);
            assert!(!host.reader_active.load(Ordering::Acquire));
            assert!(host.child.is_none());
            let retired_generation = host.engine_generation;
            // チェーンがmissing扱いでcontinueしても、後続はID発行/送信前に拒否。
            assert!(host.restore_plugin(request()).is_err());
            assert_eq!(host.next_restore_operation, 1);
            assert_eq!(host.engine_generation, retired_generation);
            assert!(host.child.is_none());
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(host.engine_generation, 8); // fatalによる旧世代退役だけ。新engineは生成しない。
        assert!(host.child.is_none());
        assert!(host.bundle_change_generation.is_none());
    }

    #[test]
    fn bundle_state_capture_never_spawns_absent_or_closed_reader_engine() {
        let mut host = AudioHost::new(std::env::temp_dir());
        assert!(host.capture_bundle_state().is_err());
        assert!(host.child.is_none());
        assert_eq!(host.engine_generation, 0);
        host.live_modes.needs_sync = false;
        host.reader_active.store(true, Ordering::Release);
        assert!(host.capture_bundle_state().is_err());
        assert!(host.child.is_none());
    }
    #[test]
    fn bundle_change_scope_rejects_dead_stats_and_setters_without_spawning_or_adopting_generation()
    {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.engine_generation = 5;
        host.reader_active.store(true, Ordering::Release);
        let result = host.bundle_change_scope(|host| {
            // capture後の終了。通常pollのdefault statsを成功した実状態に昇格しない。
            host.reader_active.store(false, Ordering::Release);
            assert!(host.get_engine_runtime_stats().is_err());
            assert!(host
                .set_noise_control_config(true, "smart".into(), 0.5, true)
                .is_err());
            assert!(host.set_built_in_effects(false, None, 0.5).is_err());
            assert!(host.child.is_none());
            Ok(()) // 旧callerがエラーを無視しても、scope終端で成功にしない。
        });
        assert!(result.is_err());
        assert!(host.child.is_none());
        assert_eq!(host.engine_generation, 5);
        assert!(host.bundle_change_generation.is_none());
        host.reader_active.store(true, Ordering::Release);
        let result = host.bundle_change_scope(|host| {
            host.engine_generation += 1;
            Ok(())
        });
        assert!(result.is_err());
        assert!(host.child.is_none());
    }

    fn cleanup_observation(host: &mut AudioHost, cancel: bool) -> Result<()> {
        if cancel {
            let snapshot = host.auto_gain(crate::audio_engine::auto_gain::Request::Cancel)?;
            assert_eq!(snapshot.phase, "idle");
            assert!(!snapshot.playing);
            assert!(!snapshot.running);
            assert!(!snapshot.settled, "取消ACKを音量の確認済み値にしない");
            assert!(snapshot.proposal.is_none());
            Ok(())
        } else {
            host.set_loudness_measurement(None)
        }
    }

    #[test]
    fn absent_engine_cleanup_acknowledges_stop_without_spawning_or_changing_mute() {
        for cancel in [false, true] {
            let mut host = AudioHost::new(std::env::temp_dir());
            host.is_global_muted = true;
            host.conditions.lifecycle(true);
            let witness = host.conditions.snapshot().unwrap();
            host.voice_activity.store(true, Ordering::Release);
            assert!(cleanup_observation(&mut host, cancel).is_ok());
            assert!(host.child.is_none());
            assert!(host.stdin.is_none());
            assert!(!host.reader_active.load(Ordering::Acquire));
            assert!(host.is_global_muted);
            assert!(!host.voice_activity.load(Ordering::Acquire));
            assert!(witness.validate().is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_reaps_only_confirmed_exit_and_never_replaces_disconnected_child() {
        use std::os::windows::process::CommandExt;
        // 0=確実終了、1=生存reader断、2=生存pipe断。音声engineは起動しない。
        for state in 0..3 {
            for cancel in [false, true] {
                let mut host = AudioHost::new(std::env::temp_dir());
                let mut command = if state == 0 {
                    let mut command = Command::new("cmd.exe");
                    command.args(["/D", "/C", "exit 0"]);
                    command
                } else {
                    let mut command = Command::new("powershell.exe");
                    command.args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "Start-Sleep -Seconds 30",
                    ]);
                    command
                };
                host.child = Some(
                    command
                        .creation_flags(0x0800_0000)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .unwrap(),
                );
                let pid = host.child.as_ref().unwrap().id();
                if state == 0 {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                    while host.child.as_mut().unwrap().try_wait().unwrap().is_none() {
                        if std::time::Instant::now() >= deadline {
                            host.kill_engine();
                            panic!("fixture終了期限超過");
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                }
                host.reader_active.store(state == 2, Ordering::Release);
                host.conditions.lifecycle(true);
                let witness = host.conditions.snapshot().unwrap();
                let result = cleanup_observation(&mut host, cancel);
                let same_or_absent = host.child.as_ref().is_none_or(|child| child.id() == pid);
                let alive_disconnected_retained = state != 1 || host.child.is_some();
                host.kill_engine();
                assert_eq!(result.is_ok(), state == 0);
                assert!(same_or_absent);
                assert!(alive_disconnected_retained);
                assert!(witness.validate().is_err());
                assert!(host.child.is_none());
            }
        }
    }

    #[test]
    fn background_observations_do_not_spawn_cold_or_closed_reader_engine() {
        for kind in 0..4 {
            let mut host = AudioHost::new(std::env::temp_dir());
            host.is_global_muted = true;
            let result = background_observation(&mut host, kind);
            assert_eq!(result.is_ok(), kind == 3); // 旧runtime statsの不在default契約だけ保持。
            assert!(host.child.is_none());
            assert!(host.stdin.is_none());
            assert_eq!(host.engine_generation, 0);
            assert!(host.is_global_muted);
            host.live_modes.needs_sync = false;
            host.reader_active.store(false, Ordering::Release);
            assert_eq!(background_observation(&mut host, kind).is_ok(), kind == 3);
            assert!(host.child.is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn background_observations_do_not_replace_exited_child_or_broken_pipe() {
        use std::os::windows::process::CommandExt;
        for exited in [true, false] {
            for kind in 0..4 {
                let mut host = AudioHost::new(std::env::temp_dir());
                let mut command = if exited {
                    let mut command = Command::new("cmd.exe");
                    command.args(["/D", "/C", "exit 0"]);
                    command
                } else {
                    let mut command = Command::new("powershell.exe");
                    command.args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "Start-Sleep -Seconds 30",
                    ]);
                    command
                };
                host.child = Some(
                    command
                        .creation_flags(0x0800_0000)
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .spawn()
                        .unwrap(),
                );
                let pid = host.child.as_ref().unwrap().id();
                if exited {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                    while host.child.as_mut().unwrap().try_wait().unwrap().is_none() {
                        if std::time::Instant::now() >= deadline {
                            host.kill_engine();
                            panic!("fixture終了期限超過");
                        }
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                }
                host.reader_active.store(!exited, Ordering::Release);
                host.conditions.lifecycle(true);
                let witness = host.conditions.snapshot().unwrap();
                let result = background_observation(&mut host, kind);
                let same_or_absent = host.child.as_ref().is_none_or(|child| child.id() == pid);
                host.kill_engine();
                assert_eq!(result.is_ok(), exited && kind == 3);
                assert!(same_or_absent, "読取のために新childを作らない");
                assert!(witness.validate().is_err());
                assert!(host.child.is_none());
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn existing_background_reads_keep_values_and_only_gain_initialize_invalidates_witness() {
        use crate::audio_engine::auto_gain::{Request, Snapshot};
        use std::os::windows::process::CommandExt;
        let mut host = AudioHost::new(std::env::temp_dir());
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "for($i=0;$i -lt 6;$i++){ $line=[Console]::In.ReadLine(); [Console]::Out.WriteLine($line) }; Start-Sleep -Seconds 30"])
            .creation_flags(0x0800_0000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let pid = child.id();
        host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
        let stdout = child.stdout.take().unwrap();
        host.child = Some(child);
        host.reader_active.store(true, Ordering::Release);
        host.live_modes.needs_sync = false;
        let slot = host.pending_reply_tx.clone();
        let worker = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            for _ in 0..6 {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let response = match serde_json::from_str::<IpcCommand>(&line).unwrap() {
                    IpcCommand::AutoGain { .. } => IpcResponse::AutoGain(Snapshot {
                        revision: 4,
                        gain: 0.5,
                        confirmed_gain: 0.5,
                        settled: true,
                        running: false,
                        stream_failed: false,
                        id: 0,
                        phase: "idle".into(),
                        progress: 0.,
                        proposal: None,
                        playing: false,
                        error: None,
                        devices: Vec::new(),
                    }),
                    IpcCommand::GetPluginState { id } => IpcResponse::PluginState {
                        id,
                        state: "saved-state".into(),
                    },
                    IpcCommand::GetRuntimeStats => {
                        let value = serde_json::to_value(EngineRuntimeStats::default()).unwrap();
                        let fields: serde_json::Map<String, serde_json::Value> = value
                            .as_object()
                            .unwrap()
                            .iter()
                            .map(|(key, value)| {
                                let snake = key
                                    .chars()
                                    .flat_map(|c| {
                                        if c.is_ascii_uppercase() {
                                            vec!['_', c.to_ascii_lowercase()]
                                        } else {
                                            vec![c]
                                        }
                                    })
                                    .collect::<String>();
                                (snake, value.clone())
                            })
                            .collect();
                        serde_json::from_value(
                            serde_json::json!({ "type": "RuntimeStats", "payload": fields }),
                        )
                        .unwrap()
                    }
                    IpcCommand::SetLoudnessMeasurement { id: None } => IpcResponse::Success,
                    _ => panic!("状態取得以外のIPCを送りました"),
                };
                assert!(slot.deliver(response));
            }
        });
        host.conditions.lifecycle(true);
        let witness = host.conditions.snapshot().unwrap();
        let result = (|| -> Result<()> {
            assert_eq!(host.auto_gain(Request::Status)?.gain, 0.5);
            assert!(witness.validate().is_ok());
            assert_eq!(
                host.auto_gain(Request::Initialize { value: 0.5 })?.gain,
                0.5
            );
            assert!(witness.validate().is_err());
            let after_gain = host.conditions.snapshot().unwrap();
            assert_eq!(host.get_plugin_state("old-id")?, "saved-state");
            assert_eq!(host.get_engine_runtime_stats()?.active_plugin_count, 0);
            assert!(after_gain.validate().is_ok());
            host.set_loudness_measurement(None)?;
            let cancelled = host.auto_gain(Request::Cancel)?;
            assert_eq!(cancelled.gain, 0.5);
            assert!(cancelled.settled); // 生存engineの実応答は保持する。
            Ok(())
        })();
        let same_child = host.child.as_ref().is_some_and(|child| child.id() == pid);
        host.kill_engine();
        worker.join().unwrap();
        assert!(result.is_ok());
        assert!(same_child);
        assert!(host.child.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn remove_plugin_on_live_child_with_stopped_audio_sends_unload_and_invalidates_witness() {
        use std::os::windows::process::CommandExt;
        let mut host = AudioHost::new(std::env::temp_dir());
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$line=[Console]::In.ReadLine(); [Console]::Out.WriteLine($line); Start-Sleep -Seconds 30"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().unwrap();
        let pid = child.id();
        host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
        let stdout = child.stdout.take().unwrap();
        host.child = Some(child);
        host.reader_active.store(true, Ordering::Release);
        host.live_modes.needs_sync = false;
        // 音声streamが停止中でも、常駐child上のVSTは削除できる。
        host.voice_activity.store(false, Ordering::Release);
        host.conditions.lifecycle(true);
        let witness = host.conditions.snapshot().unwrap();
        let reply = host.pending_reply_tx.clone();
        let worker = std::thread::spawn(move || {
            let mut line = String::new();
            BufReader::new(stdout).read_line(&mut line).unwrap();
            assert!(
                matches!(serde_json::from_str::<IpcCommand>(&line).unwrap(), IpcCommand::UnloadPlugin { id } if id == "stopped-id")
            );
            assert!(reply.deliver(IpcResponse::Success));
        });
        let result = host.remove_plugin("stopped-id");
        let same_child = host.child.as_ref().is_some_and(|child| child.id() == pid);
        // 成否にかかわらず、所有fixtureだけを先に回収してからassertする。
        host.kill_engine();
        worker.join().unwrap();
        assert!(result.is_ok());
        assert!(same_child);
        assert!(witness.validate().is_err());
        assert!(host.child.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn stop_reaps_exited_child_but_refuses_live_child_with_closed_reader() {
        use std::os::windows::process::CommandExt;
        // 音声engineではなく、所有する短命fixtureだけを起動する。consoleは表示しない。
        let mut host = AudioHost::new(std::env::temp_dir());
        host.child = Some(
            Command::new("cmd.exe")
                .args(["/D", "/C", "exit 0"])
                .creation_flags(0x0800_0000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while host.child.as_mut().unwrap().try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline {
                host.kill_engine();
                panic!("fixture終了期限を超過しました");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        // 実クラッシュと同じくchildはSome、readerはfalseのまま。
        assert!(host.get_state().is_running);
        host.is_global_muted = true;
        host.conditions.lifecycle(true);
        let witness = host.conditions.snapshot().unwrap();
        assert!(host.stop().is_ok());
        assert!(!host.get_state().is_running);
        assert!(host.child.is_none());
        assert!(witness.validate().is_err());
        assert!(host.is_global_muted);

        host.child = Some(
            Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ])
                .creation_flags(0x0800_0000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let generation = host.engine_generation;
        assert!(host.stop().is_err());
        assert!(host.child.is_some());
        assert_eq!(host.engine_generation, generation);
        // 自分のfixtureだけを確実にkill/waitする。assert失敗時もAudioHost::dropが回収する。
        host.kill_engine();
        assert!(host.child.is_none());
    }

    #[test]
    fn saving_packaged_audio_config_does_not_read_or_overwrite_standalone() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-audio-storage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let standalone = root.join("legacy/last_audio_config.json");
        let packaged = root.join("package/LocalState/Auralyn/last_audio_config.json");
        let legacy = ActiveAudioConfig {
            host: "ASIO".into(),
            input: Some("Legacy Input".into()),
            output: None,
            sample_rate: Some(96000),
            buffer_size: Some(512),
        };
        persist_audio_config(&standalone, &legacy).unwrap();
        let before = std::fs::read(&standalone).unwrap();
        assert!(!packaged.exists(), "既存版から暗黙にコピーしない");
        let current = ActiveAudioConfig {
            host: "Wasapi".into(),
            ..legacy
        };
        persist_audio_config(&packaged, &current).unwrap();
        assert_eq!(std::fs::read(&standalone).unwrap(), before);
        let loaded: ActiveAudioConfig =
            serde_json::from_slice(&std::fs::read(&packaged).unwrap()).unwrap();
        assert_eq!(loaded.host, "Wasapi");
        // 削除対象はこのテストが作成した絶対パスの専用ディレクトリだけ。
        assert!(root.is_absolute() && root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod device_scan_tests {
    use super::*;
    fn ticket(generation: u64, token: u64) -> DeviceScanTicket {
        DeviceScanTicket {
            generation,
            token,
            started: std::time::Instant::now(),
            terminal: Arc::new(OnceLock::new()),
        }
    }
    #[test]
    fn old_scan_ticket_cannot_poll_or_cancel_another_generation() {
        let mut host = AudioHost::new(std::env::temp_dir());
        let old = ticket(3, 1);
        let current = ticket(4, 1);
        host.engine_generation = 4;
        host.device_scan = Some(current.clone());
        assert!(host.poll_device_scan(&old).is_err());
        host.cancel_device_scan(&old).unwrap();
        assert!(host.scan_is_current(&current));
        assert!(host.child.is_none());
    }
    #[test]
    fn cache_hit_and_coalesced_request_do_not_start_an_engine_or_destroy_cache() {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.cached_devices = Some(AudioDeviceList {
            inputs: Vec::new(),
            outputs: Vec::new(),
        });
        assert!(matches!(
            host.begin_device_scan(false).unwrap(),
            DeviceScanStart::Cached(_)
        ));
        host.device_scan = Some(ticket(0, 1));
        assert!(matches!(
            host.begin_device_scan(true).unwrap(),
            DeviceScanStart::Pending(_)
        ));
        assert!(host.cached_devices.is_some());
        assert!(host.child.is_none());
    }
    #[test]
    fn parallel_callers_keep_completion_after_next_scan_and_reject_previous_engine() {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.engine_generation = 2;
        host.device_scan = Some(ticket(2, 8));
        let DeviceScanStart::Pending(first) = host.begin_device_scan(true).unwrap() else {
            panic!("not pending")
        };
        let DeviceScanStart::Pending(second) = host.begin_device_scan(false).unwrap() else {
            panic!("not pending")
        };
        assert!(Arc::ptr_eq(&first.terminal, &second.terminal));
        let device = crate::ipc::DeviceInfo {
            name: "Current Mic".into(),
            host: "Wasapi".into(),
            is_input: true,
            channels: 2,
            buffer_size_range: None,
            is_default: true,
        };
        host.finish_device_scan(&first, vec![device]).unwrap();
        // CのBeginが成功した直後と同じ状態。Bのterminalはhostの新ticketと独立する。
        let next = ticket(2, 9);
        host.device_scan = Some(next.clone());
        let DeviceScanStart::Pending(third) = host.begin_device_scan(true).unwrap() else {
            panic!("not pending")
        };
        assert_eq!(third.token, 9);
        assert_eq!(
            host.poll_device_scan(&second).unwrap().unwrap().inputs[0].name,
            "Current Mic"
        );
        assert!(host.scan_is_current(&next));
        host.engine_generation += 1;
        assert!(host.poll_device_scan(&second).is_err());
        assert!(host.finish_device_scan(&first, Vec::new()).is_err());
        assert_eq!(
            host.cached_devices.as_ref().unwrap().inputs[0].name,
            "Current Mic"
        );
        assert!(host.child.is_none());
    }
    #[test]
    fn failed_terminal_is_shared_without_destroying_cache_or_cancelling_new_request() {
        let mut host = AudioHost::new(std::env::temp_dir());
        let first = ticket(0, 1);
        let second = first.clone();
        host.device_scan = Some(first.clone());
        host.cached_devices = Some(AudioDeviceList {
            inputs: Vec::new(),
            outputs: Vec::new(),
        });
        assert!(host
            .fail_device_scan(&first, "scanner timeout".into())
            .is_err());
        let next = ticket(0, 2);
        host.device_scan = Some(next.clone());
        assert_eq!(
            host.poll_device_scan(&second).unwrap_err().to_string(),
            "scanner timeout"
        );
        host.cancel_device_scan(&second).unwrap();
        assert!(host.scan_is_current(&next));
        assert!(host.cached_devices.is_some());
    }
    fn proposal_prepare_request() -> crate::audio_engine::voice_check::preview::Request {
        use crate::audio_engine::voice_check::preview::{Action, Request};
        Request {
            client_id: "proposal-host".into(),
            session_id: 1,
            operation_id: 2,
            epoch: Some("old-preview".into()),
            action: Action::PrepareProposal {
                rule_version: None,
                preferences: None,
                preferences_revision: None,
                recording_id: 1,
                builtin_epoch: "old-builtin".into(),
                expected_revision: "1".into(),
            },
        }
    }
    #[cfg(windows)]
    #[test]
    fn proposal_prepare_exited_child_with_late_reader_notification_never_ensures_or_spawns() {
        use std::os::windows::process::CommandExt;
        let mut host = AudioHost::new(std::env::temp_dir());
        // 音声sidecarではない所有fixture。ensureへ退行しても実engineは起動させない。
        host.maintenance = true;
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/C", "exit 0"])
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child.wait().unwrap();
        let pid = child.id();
        host.child = Some(child);
        host.engine_generation = 7;
        host.reader_active.store(true, Ordering::Release);
        let error = host
            .voice_check_preview(proposal_prepare_request())
            .unwrap_err()
            .to_string();
        let unchanged =
            host.engine_generation == 7 && host.child.as_ref().is_some_and(|c| c.id() == pid);
        host.kill_engine();
        assert!(unchanged);
        assert!(error.contains("音声エンジンが終了しました"));
    }
    #[cfg(windows)]
    #[test]
    fn proposal_prepare_exit_after_connection_check_rejects_same_generation_without_spawn() {
        use std::os::windows::process::CommandExt;
        let mut host = AudioHost::new(std::env::temp_dir());
        host.maintenance = true;
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$null=[Console]::In.ReadLine()",
            ])
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
        let pid = child.id();
        host.child = Some(child);
        host.engine_generation = 7;
        host.reader_active.store(true, Ordering::Release);
        assert!(host.require_proposal_connection(6).is_err());
        host.require_proposal_connection(7).unwrap();
        // 公開入口の接続確認と実際の送信の間でchildだけが終了。reader通知はまだtrue。
        host.stdin = None;
        host.child.as_mut().unwrap().wait().unwrap();
        assert!(host.reader_active.load(Ordering::Acquire));
        let error = host
            .prepare_proposal_on_existing_generation(7, proposal_prepare_request())
            .unwrap_err()
            .to_string();
        let unchanged =
            host.engine_generation == 7 && host.child.as_ref().is_some_and(|c| c.id() == pid);
        host.kill_engine();
        assert!(unchanged);
        assert!(error.contains("音声エンジンが終了しました"));
    }
}
