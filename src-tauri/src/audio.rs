pub(crate) mod conditions;
pub(crate) mod frontend_bootstrap;
mod live_bundle;
mod live_modes;
pub(crate) mod mixing;
mod mode_vst;
mod output_bundle;
mod process_bundle;
pub(crate) mod process_inputs;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate_ranges: Option<Vec<(u32, u32)>>,
    pub name: String,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub is_input: bool,
    pub channels: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer_size_range: Option<(u32, u32)>,
    pub index: usize,
    pub is_default: bool,
}
impl AudioDevice {
    fn from_info(index: usize, device: crate::ipc::DeviceInfo) -> Self {
        Self {
            sample_rate_ranges: device.sample_rate_ranges,
            name: device.name,
            host: device.host,
            id: device.id,
            is_input: device.is_input,
            channels: device.channels,
            buffer_size_range: device.buffer_size_range,
            index,
            is_default: device.is_default,
        }
    }
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
    pub routing: Option<crate::ipc::ChannelRouting>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct ActiveAudioConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_source: Option<crate::input_source::Config>,
    pub host: String,
    pub input: Option<String>,
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_id: Option<String>,
    pub buffer_size: Option<u32>,
    pub sample_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<crate::ipc::ChannelRouting>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioStateInfo {
    pub is_running: bool,
    pub config: Option<ActiveAudioConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_witness: Option<AudioConditionWitness>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct AudioConditionWitness {
    pub revision: String,
    pub epoch: String,
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
    pub process_input: Option<Box<crate::audio_engine::process_capture::Snapshot>>,
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
    mode_vst: mode_vst::State,
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
    process_inputs: process_inputs::Inputs,
    mixing: mixing::State,
    is_global_muted: bool,
    engine_tuning: EngineTuningConfig,
    bundle_output_override: Option<crate::audio_engine::live_output::Config>,
    bundle_monitor_override: Option<Option<crate::audio_engine::split_monitor::State>>,
    bundle_interrupt: Option<u64>,
    output_gain_initialized: bool,
    #[cfg(windows)]
    engine_job: Option<win_job::Job>,
}

impl AudioHost {
    pub(crate) fn global_mute_intent(&self) -> bool {
        self.is_global_muted
    }
    pub(crate) fn checked_snapshot_supported(&mut self) -> Result<()> {
        self.output_snapshot_supported()?;
        anyhow::ensure!(
            self.live_output(None)?.config == Default::default(),
            "確認済み保存・復帰で分離出力を含める場合は、出力構成も保存してください"
        );
        Ok(())
    }
    pub(crate) fn output_snapshot_supported(&mut self) -> Result<()> {
        self.full_snapshot_supported()?;
        anyhow::ensure!(
            self.live_modes.target.is_none(),
            "歌／雑談モードも保存することを選んでください"
        );
        let config = self.live_output(None)?.config;
        if config.split_processing {
            match self.execute_running_command(IpcCommand::ModeMonitor {
                request: crate::audio_engine::split_monitor::Request::Snapshot,
            })? {
                IpcResponse::ModeMonitor(snapshot) => {
                    crate::bundle::output_configuration::validate_custom_monitor(&config, &snapshot)
                        .map_err(anyhow::Error::msg)?
                }
                _ => return Err(anyhow!("現在の自分用処理を確認できません")),
            }
        }
        Ok(())
    }
    pub(crate) fn full_snapshot_supported(&mut self) -> Result<()> {
        self.preflight_live_changes()?;
        anyhow::ensure!(
            self.active_config
                .as_ref()
                .and_then(|c| c.input_source.as_ref())
                .is_none_or(|s| *s == crate::input_source::Config::default()),
            "この入力は確認済み保存・復帰に未対応です。VST単体の設定を保存してください"
        );
        Ok(())
    }
    pub(crate) fn preflight_runtime_checkpoint(&mut self) -> Result<()> {
        self.check_can_interrupt()?;
        anyhow::ensure!(
            self.session_restore.is_none(),
            "VSTの復元を完了してから退避してください"
        );
        if self.capture_bundle_process()?.is_some() {
            self.process_snapshot_supported()?;
        } else {
            self.full_snapshot_supported()?;
        }
        let stats = self.get_engine_runtime_stats()?;
        anyhow::ensure!(
            stats.noise_learning_state != "capturing",
            "周囲の音の測定を終了してから退避してください"
        );
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
        let mode_vst = mode_vst::State::new(&config_dir);
        let recovery_muted = mode_vst.blocked();
        Self {
            conditions: Arc::new(conditions::Conditions::default()),
            last_config_path: config_dir.join("last_audio_config.json"),
            maintenance: false,
            live_modes: live_modes::HostModes::new(&config_dir),
            mode_vst,
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
            process_inputs: Default::default(),
            mixing: mixing::State::new(&config_dir),
            is_global_muted: recovery_muted,
            engine_tuning: EngineTuningConfig::default(),
            bundle_output_override: None,
            bundle_monitor_override: None,
            bundle_interrupt: None,
            output_gain_initialized: false,
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
        self.guard_mode_vst()?;
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
        self.output_gain_initialized = false;
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
                                EngineEvent::MixingSourceFailed
                                | EngineEvent::MixingOutputFailed => {
                                    if !conditions.engine_changed(condition_epoch) {
                                        continue;
                                    }
                                    if let Some(handle) = emitter_clone.lock().unwrap().as_ref() {
                                        let _ = handle.emit("audio-conditions-changed", ());
                                        let _ = handle.emit(
                                            if matches!(evt, EngineEvent::MixingSourceFailed) {
                                                "mixing-source-failed"
                                            } else {
                                                "mixing-output-failed"
                                            },
                                            (),
                                        );
                                    }
                                }
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
        self.guard_mode_vst()?;
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
                        | crate::audio_engine::builtin::Request::Redo { .. }
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
        self.guard_mode_vst()?;
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
                    let ad = AudioDevice::from_info(i, d);
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
            let device = AudioDevice::from_info(index, device);
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

    /// ID指定時は名前へ代替せず、その実機だけを開始する。
    #[allow(clippy::too_many_arguments)]
    pub fn start_with_device_ids(
        &mut self,
        host_name: Option<String>,
        input_name: Option<String>,
        output_name: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
        input_id: Option<String>,
        output_id: Option<String>,
        channel_routing: Option<crate::ipc::ChannelRouting>,
    ) -> Result<AudioConfig> {
        self.frontend_bootstrap.cancel();
        self.start_internal_guarded_with_ids(
            host_name,
            input_name,
            output_name,
            buffer_size,
            sample_rate,
            None,
            None,
            input_id,
            output_id,
            channel_routing,
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
        self.start_internal_guarded_with_ids(
            host_name,
            input_name,
            output_name,
            buffer_size,
            sample_rate,
            initial_controls,
            expected_generation,
            None,
            None,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn start_internal_guarded_with_ids(
        &mut self,
        host_name: Option<String>,
        input_name: Option<String>,
        output_name: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
        initial_controls: Option<crate::ipc::StartControls>,
        expected_generation: Option<u64>,
        input_id: Option<String>,
        output_id: Option<String>,
        channel_routing: Option<crate::ipc::ChannelRouting>,
    ) -> Result<AudioConfig> {
        let source = self.resolve_input_source(None)?;
        self.start_internal_with_source(
            host_name,
            input_name,
            output_name,
            buffer_size,
            sample_rate,
            initial_controls,
            expected_generation,
            input_id,
            output_id,
            channel_routing,
            source,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn start_internal_with_source(
        &mut self,
        host_name: Option<String>,
        input_name: Option<String>,
        output_name: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
        initial_controls: Option<crate::ipc::StartControls>,
        expected_generation: Option<u64>,
        input_id: Option<String>,
        output_id: Option<String>,
        channel_routing: Option<crate::ipc::ChannelRouting>,
        input_source: Option<crate::input_source::Start>,
    ) -> Result<AudioConfig> {
        self.guard_mode_vst()?;
        self.validate_mixing_selection(input_source.as_ref())?;
        if let Some(controls) = initial_controls {
            controls.validate().map_err(|e| anyhow!(e))?;
        }
        let channel_routing =
            channel_routing.or_else(|| initial_controls.map(|controls| controls.routing()));
        let process = input_source
            .as_ref()
            .is_some_and(|s| matches!(s.source, crate::input_source::Config::ProcessLoopback(_)));
        if !process {
            crate::desktop_integration::check_microphone_access(host_name.as_deref())
                .map_err(anyhow::Error::msg)?;
        }
        if let Some(source) = &input_source {
            source.validate().map_err(anyhow::Error::msg)?;
        }
        let cmd = IpcCommand::Start {
            input_source: input_source.clone(),
            host: host_name.clone().unwrap_or("ASIO".to_string()),
            input: input_name.clone(),
            output: output_name.clone(),
            input_id: input_id.clone(),
            output_id: output_id.clone(),
            buffer_size,
            sample_rate,
            initial_controls,
            channel_routing,
        };

        if input_source
            .as_ref()
            .is_some_and(|s| s.source != crate::input_source::Config::default())
        {
            let path = self.last_config_path.with_file_name("live_output.json");
            if path.exists() {
                let config: crate::audio_engine::live_output::Config =
                    serde_json::from_slice(&std::fs::read(path)?)?;
                anyhow::ensure!(
                    !config.split_processing,
                    "この入力は処理分離に未対応です。音声設定で通常の処理経路を選んでください"
                );
            }
        }
        if (input_source
            .as_ref()
            .is_some_and(|s| s.source != crate::input_source::Config::default())
            || self
                .active_config
                .as_ref()
                .and_then(|c| c.input_source.as_ref())
                .is_some_and(|s| *s != crate::input_source::Config::default()))
            && self.reader_active.load(Ordering::Acquire)
        {
            let status = self.auto_gain(crate::audio_engine::auto_gain::Request::Status)?;
            anyhow::ensure!(
                !status.running,
                "音声を停止してから入力元・用途を変更してください"
            );
        }
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
        if input_source.is_some() {
            crate::input_source::require_capability(|probe| self.execute_running_command(probe))?;
        }
        require_identity_capability(&cmd, |probe| self.execute_running_command(probe))?;
        let live_path = self.last_config_path.with_file_name("live_output.json");
        let live_config = if let Some(config) = &self.bundle_output_override {
            Some(config.clone())
        } else if live_path.exists() {
            Some(serde_json::from_slice::<
                crate::audio_engine::live_output::Config,
            >(&std::fs::read(live_path)?)?)
        } else {
            None
        };
        if let Some(config) = live_config {
            config.validate()?;
            match self.execute_running_command(IpcCommand::LiveOutput {
                config: Some(config),
            })? {
                IpcResponse::LiveOutput(_) => {}
                IpcResponse::Error(error) => return Err(anyhow!(error)),
                _ => return Err(anyhow!("二系統出力の保存構成を反映できません")),
            }
        }
        if let Some(state) = self.bundle_monitor_override.clone() {
            match self.execute_running_command(IpcCommand::ModeMonitor {
                request: crate::audio_engine::split_monitor::Request::Restore { state },
            })? {
                IpcResponse::ModeMonitor(snapshot) if !snapshot.failed && !snapshot.pending => {}
                IpcResponse::Error(error) => return Err(anyhow!(error)),
                _ => return Err(anyhow!("開始前に自分用処理を復帰できません")),
            }
        }
        let muted = self.is_global_muted;
        self.prepare_mixing_start()?;
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
                routing,
                input_id: actual_input_id,
                output_id: actual_output_id,
            } => {
                if channel_routing.is_some() && routing.is_none() {
                    let _ = self.execute_running_command(IpcCommand::Stop);
                    return Err(anyhow!("音声エンジンが接続設定の確認に対応していません"));
                }
                if process && actual_input_id.is_some() {
                    let _ = self.execute_running_command(IpcCommand::Stop);
                    return Err(anyhow!(
                        "アプリ入力で開始したことを確認できません。音声エンジンを更新してください"
                    ));
                }
                if input_id
                    .as_ref()
                    .is_some_and(|id| Some(id) != actual_input_id.as_ref())
                    || output_id
                        .as_ref()
                        .is_some_and(|id| Some(id) != actual_output_id.as_ref())
                {
                    // 旧Engine等がID照合を行わない場合は即時停止し、成功としない。
                    let _ = self.execute_running_command(IpcCommand::Stop);
                    return Err(anyhow!(
                        "開始した機器のIDを確認できません。機器を選び直してください"
                    ));
                }
                // Update active config
                let config = ActiveAudioConfig {
                    input_source: input_source.as_ref().map(|s| s.source.clone()),
                    host: host_name.clone().unwrap_or("ASIO".to_string()),
                    input: input_name,
                    output: output_name,
                    input_id: actual_input_id,
                    output_id: actual_output_id,
                    buffer_size: Some(buffer_size),
                    sample_rate: Some(sample_rate),
                    routing,
                };

                // Persist for fast auto-start on next launch
                if let Err(e) = persist_audio_config(&self.last_config_path, &config) {
                    log::warn!("Failed to save last audio config: {}", e);
                }

                self.active_config = Some(config);
                self.remember_input_source(input_source);
                if let Some(controls) = initial_controls {
                    self.is_global_muted = controls.muted;
                    self.output_gain_initialized = true;
                }

                Ok(AudioConfig {
                    sample_rate,
                    buffer_size,
                    routing,
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
        if self.mode_vst.blocked() {
            self.cancel_mode_vst("利用者が音声を停止しました");
            self.kill_engine();
            return Ok(());
        }
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
        if self.mode_vst.blocked() {
            anyhow::ensure!(active, "切替・復旧の完了後にミュートを解除してください");
            self.is_global_muted = true;
            self.cancel_mode_vst("緊急ミュートで切替を中止しました");
            self.kill_engine();
            if let Ok(emitter) = self.emitter.lock() {
                if let Some(handle) = emitter.as_ref() {
                    let _ = handle.emit("global-mute-changed", true);
                }
            }
            return Ok(());
        }
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
        let response = if matches!(&request, crate::audio_engine::builtin::Request::Snapshot) {
            self.execute_running_command(IpcCommand::BuiltinEffects { request })?
        } else if matches!(
            &request,
            crate::audio_engine::builtin::Request::ApplyProposal { .. }
                | crate::audio_engine::builtin::Request::Undo { .. }
                | crate::audio_engine::builtin::Request::Redo { .. }
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
                self.output_gain_initialized = true;
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
        let explicit_gain_update = matches!(
            &request,
            crate::audio_engine::auto_gain::Request::Apply { .. }
                | crate::audio_engine::auto_gain::Request::Restore { .. }
                | crate::audio_engine::auto_gain::Request::UndoHistory { .. }
                | crate::audio_engine::auto_gain::Request::RedoHistory { .. }
        );
        // Engine側も明示設定後のInitializeを無視する。Hostでも読取にし、
        // 再起動通知に伴う遅い初期化で復帰・Undoのwitnessを自己失効させない。
        let request = if initializing && self.output_gain_initialized {
            crate::audio_engine::auto_gain::Request::Status
        } else {
            request
        };
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
                history_id: None,
                history_epoch: None,
                history_reason: Some(crate::audio_engine::history::Reason::NotCreated),
                undo_available: false,
                redo_available: false,
            });
        }
        let existing_only = matches!(
            request,
            crate::audio_engine::auto_gain::Request::Status
                | crate::audio_engine::auto_gain::Request::UndoHistory { .. }
                | crate::audio_engine::auto_gain::Request::RedoHistory { .. }
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
                if explicit_gain_update {
                    self.output_gain_initialized = true;
                }
                if initializing && !state.stream_failed {
                    self.frontend_bootstrap.output_gain = Some(state.gain);
                    if state.running {
                        self.output_gain_initialized = true;
                    }
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
        self.start_bundle_with_device_ids(host, input, output, buffer, rate, intent, None, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_bundle_with_device_ids(
        &mut self,
        host: Option<String>,
        input: Option<String>,
        output: Option<String>,
        buffer: Option<u32>,
        rate: Option<u32>,
        intent: crate::profile::StartIntent,
        input_id: Option<String>,
        output_id: Option<String>,
    ) -> Result<AudioConfig> {
        intent.validate().map_err(|e| anyhow!(e))?;
        self.validate_bundle_connection()?;
        self.preflight_live_changes()?;
        self.preserve_live_changes_for_restart();
        self.kill_engine();
        self.start_internal_guarded_with_ids(
            host,
            input,
            output,
            buffer,
            rate,
            Some(intent),
            None,
            input_id,
            output_id,
            None,
        )
    }

    fn validate_bundle_connection(&self) -> Result<()> {
        if let Some(expected) = self.bundle_change_generation {
            anyhow::ensure!(
                self.bundle_interrupt == Some(self.conditions.restore_interrupt()),
                "停止・ミュート操作が優先されたため、配信状態の復帰を中断しました"
            );
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
        self.bundle_interrupt = Some(self.conditions.restore_interrupt());
        let result = self
            .validate_bundle_connection()
            .map_err(|e| e.to_string())
            .and_then(|()| operation(self));
        let intact = self.validate_bundle_connection().map_err(|e| e.to_string());
        self.bundle_change_generation = None;
        self.bundle_interrupt = None;
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
            crate::audio_engine::voice_check::preview::Action::HistoryStatus
        ) {
            self.execute_running_command(IpcCommand::VoiceCheckPreview { request })?
        } else if matches!(
            &request.action,
            crate::audio_engine::voice_check::preview::Action::PrepareProposal { .. }
                | crate::audio_engine::voice_check::preview::Action::PrepareNoise { .. }
                | crate::audio_engine::voice_check::preview::Action::ApplyNoise { .. }
                | crate::audio_engine::voice_check::preview::Action::UndoNoise { .. }
                | crate::audio_engine::voice_check::preview::Action::RedoNoise { .. }
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
                process_input,
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
                process_input,
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
        self.mixing.selected = None;
        self.output_gain_initialized = false;
        if self.mode_vst.busy() {
            self.cancel_mode_vst("音声エンジンが終了したため手動復旧が必要です");
        }
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
        if self.mode_vst.blocked() {
            self.require_explicit_start();
            return Ok(());
        }
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
                    Ok(config)
                        if config
                            .input_source
                            .as_ref()
                            .is_some_and(|s| *s != crate::input_source::Config::default()) =>
                    {
                        self.frontend_bootstrap.automatic_attempted = true;
                        self.frontend_bootstrap.warmup_error = Some(
                            "保存した入力は自動開始しません。音声設定で入力を確認してください。"
                                .into(),
                        );
                    }
                    Ok(config)
                        if !config.host.is_empty()
                            && config
                                .routing
                                .is_none_or(|routing| routing.input_channels.is_none()) =>
                    {
                        // 旧形式には入力ペアがない。frontendから保存済みの選択が届くまで開始しない。
                        log::debug!("入力ペアを受け取るまで旧設定の自動開始を待機します");
                        self.frontend_bootstrap.deferred_config = Some(config);
                    }
                    Ok(config) if !config.host.is_empty() => {
                        self.frontend_bootstrap.automatic_attempted = true;
                        log::info!("Auto-starting audio with last config: {:?}", config);
                        let generation = self.engine_generation;
                        match self.start_internal_guarded_with_ids(
                            Some(config.host),
                            config.input,
                            config.output,
                            config.buffer_size,
                            config.sample_rate,
                            None,
                            Some(generation),
                            config.input_id,
                            config.output_id,
                            config.routing,
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
            condition_witness: self
                .conditions
                .snapshot()
                .ok()
                .map(|w| AudioConditionWitness {
                    revision: w.revision().to_string(),
                    epoch: w.engine_epoch().to_string(),
                }),
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

fn require_identity_capability(
    start: &IpcCommand,
    mut send: impl FnMut(IpcCommand) -> Result<IpcResponse>,
) -> Result<()> {
    let needs_routing = matches!(
        start,
        IpcCommand::Start {
            channel_routing: Some(_),
            ..
        }
    );
    if !needs_routing
        && !matches!(
            start,
            IpcCommand::Start {
                input_id: Some(_),
                ..
            } | IpcCommand::Start {
                output_id: Some(_),
                ..
            }
        )
    {
        return Ok(());
    }
    match send(IpcCommand::StartIdentityCapability) {
        Ok(IpcResponse::StartIdentityCapability { version })
            if version >= if needs_routing { 2 } else { 1 } =>
        {
            Ok(())
        }
        _ => Err(anyhow!(
            "音声エンジンが機器IDの照合に対応していません。再起動して設定を確認してください"
        )),
    }
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
#[path = "audio/tests/permission_error_tests.rs"]
mod permission_error_tests;

#[cfg(test)]
#[path = "audio/tests/config_storage_tests.rs"]
mod config_storage_tests;

#[cfg(test)]
#[path = "audio/tests/device_scan_tests.rs"]
mod device_scan_tests;
