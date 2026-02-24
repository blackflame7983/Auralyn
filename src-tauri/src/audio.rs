use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// Returns the path for the persistent "last audio config" file.
/// On Windows: %APPDATA%/com.kuro7983.auralynhost/last_audio_config.json
/// Fallback: next to the executable.
fn last_config_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let dir = PathBuf::from(appdata).join("com.kuro7983.auralynhost");
            let _ = std::fs::create_dir_all(&dir);
            return dir.join("last_audio_config.json");
        }
    }
    // Fallback
    let mut p = std::env::current_exe().unwrap_or_default();
    p.set_file_name("last_audio_config.json");
    p
}

#[cfg(windows)]
mod win_job {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // HANDLE is just an OS handle; it is safe to move/share as an opaque value as long as
    // we don't use it concurrently in a data-race way (we only close on Drop).
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new_kill_on_drop() -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(None, None).ok()?;

                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .ok()?;

                Some(Self(job))
            }
        }

        pub fn assign(&self, process: HANDLE) -> bool {
            unsafe { AssignProcessToJobObject(self.0, process).is_ok() }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

// Use shared IPC types
use crate::ipc::{Command as IpcCommand, EngineEvent, OutputMessage, Response as IpcResponse};

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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EngineTuningConfig {
    pub enable_affinity_pinning: bool,
    pub affinity_mask: Option<String>,
    pub enable_realtime_priority: bool,
    pub enable_time_critical_audio_threads: bool,
}

impl Default for EngineTuningConfig {
    fn default() -> Self {
        Self {
            enable_affinity_pinning: false,
            affinity_mask: None,
            enable_realtime_priority: false,
            enable_time_critical_audio_threads: false,
        }
    }
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct EngineRuntimeStats {
    pub active_plugin_count: u32,
    pub enabled_plugin_count: u32,
    pub pending_unload_count: u32,
    pub burned_library_count: u32,
    pub global_bypass: bool,
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
}

pub struct AudioHost {
    child: Option<Child>,
    stdin: Option<BufWriter<ChildStdin>>,
    // We store a sender to satisfy a waiting command.
    // Since we assume sequential commands from the UI (mutex locked AudioState),
    // we only have one pending request at a time.
    pending_reply_tx: Arc<Mutex<Option<mpsc::Sender<IpcResponse>>>>,
    emitter: Arc<Mutex<Option<AppHandle>>>,
    cached_devices: Option<AudioDeviceList>,
    active_config: Option<ActiveAudioConfig>,
    is_global_muted: bool,
    engine_tuning: EngineTuningConfig,
    #[cfg(windows)]
    engine_job: Option<win_job::Job>,
}

impl AudioHost {
    pub fn new() -> Self {
        Self {
            child: None,
            stdin: None,
            pending_reply_tx: Arc::new(Mutex::new(None)),
            emitter: Arc::new(Mutex::new(None)),
            cached_devices: None,
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
        // ... (check child logic same as before) ...
        if self.child.is_some() {
            // Check if still alive
            if let Some(c) = self.child.as_mut() {
                match c.try_wait() {
                    Ok(Some(status)) => {
                        log::error!(
                            "Audio Engine exited unexpectedly! Status: {}",
                            status
                        );
                        log::warn!("Forcing restart with empty state");
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
        let mut candidates: Vec<PathBuf> = Vec::new();

        // Preferred: Tauri bundle layout candidates
        candidates.push(exe_dir.join("audio_engine.exe"));
        candidates.push(exe_dir.join("ns-audio-engine.exe"));

        // Common "bin/" locations for externalBin
        candidates.push(exe_dir.join("bin").join("audio_engine.exe"));
        candidates.push(exe_dir.join("bin").join("ns-audio-engine.exe"));

        // Dev build outputs
        candidates.push(PathBuf::from("target/debug/audio_engine.exe"));
        candidates.push(PathBuf::from("src-tauri/target/debug/audio_engine.exe"));
        candidates.push(cwd.join("target/debug/audio_engine.exe"));
        candidates.push(cwd.join("src-tauri/target/debug/audio_engine.exe"));

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

        // Spawn Output Reader Thread
        let pending_tx_clone = self.pending_reply_tx.clone();
        let emitter_clone = self.emitter.clone();

        thread::spawn(move || {
            for line in stdout.lines() {
                if let Ok(l) = line {
                    if l.trim().is_empty() {
                        continue;
                    }

                    if l.starts_with("IPC:") {
                        let json_str = &l[4..]; // Strip "IPC:"
                        match serde_json::from_str::<OutputMessage>(json_str) {
                            Ok(msg) => match msg {
                                OutputMessage::Response(resp) => {
                                    let mut lock = pending_tx_clone.lock().unwrap();
                                    if let Some(tx) = lock.take() {
                                        let _ = tx.send(resp);
                                    } else {
                                        log::warn!(
                                            "Received Response but no one waiting: {:?}",
                                            resp
                                        );
                                    }
                                }
                                OutputMessage::Event(evt) => match evt {
                                    EngineEvent::Log(s) => log::info!("[Engine] {}", s),
                                    EngineEvent::Error(s) => {
                                        log::error!("[Engine] {}", s);
                                        if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
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
                                        if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
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
            }

            log::warn!("Engine stdout closed.");
            // Notify Frontend of crash/exit
            if let Some(h) = emitter_clone.lock().unwrap().as_ref() {
                let _ = h.emit("audio-error", "Audio Engine Process Exited (Crash?)");
            }

            // UX FIX: Abort any pending command to prevent 10s timeout
            {
                let mut lock = pending_tx_clone.lock().unwrap();
                if let Some(tx) = lock.take() {
                    log::warn!("Aborting pending command due to engine exit.");
                    let _ = tx.send(IpcResponse::Error("Engine Crashed/Exited".to_string()));
                }
            }
        });

        Ok(())
    }

    fn execute_command(&mut self, cmd: IpcCommand) -> Result<IpcResponse> {
        self.ensure_engine_running()?;

        let json = serde_json::to_string(&cmd)?;

        // Create Channel
        let (tx, rx) = mpsc::channel();
        {
            let mut lock = self.pending_reply_tx.lock().unwrap();
            *lock = Some(tx);
        }

        // Send
        if let Some(stdin) = &mut self.stdin {
            writeln!(stdin, "{}", json)?;
            stdin.flush()?;
        } else {
            return Err(anyhow!("Stdin not available"));
        }

        // Wait
        // Timeout? 5 seconds?
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(resp) => Ok(resp),
            Err(_) => {
                // Clear pending
                let mut lock = self.pending_reply_tx.lock().unwrap();
                *lock = None;
                Err(anyhow!("Timeout waiting for engine response"))
            }
        }
    }

    pub fn enumerate_devices(&mut self, force_refresh: bool) -> Result<AudioDeviceList> {
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

    pub fn start(
        &mut self,
        host_name: Option<String>,
        input_name: Option<String>,
        output_name: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
    ) -> Result<AudioConfig> {
        let cmd = IpcCommand::Start {
            host: host_name.clone().unwrap_or("ASIO".to_string()),
            input: input_name.clone(),
            output: output_name.clone(),
            buffer_size,
            sample_rate,
        };

        log::info!("Sending Start Command: {:?}", cmd);

        match self.execute_command(cmd)? {
            IpcResponse::Started {
                sample_rate,
                buffer_size,
            } => {
                // Restore global mute state if active (because engine process is fresh)
                if self.is_global_muted {
                    log::info!("Restoring Global Mute State...");
                    if let Err(e) = self.execute_command(IpcCommand::SetGlobalMute { active: true })
                    {
                        log::warn!("Failed to restore global mute: {}", e);
                    }
                }

                // Update active config
                let config = ActiveAudioConfig {
                    host: host_name.clone().unwrap_or("ASIO".to_string()),
                    input: input_name,
                    output: output_name,
                    buffer_size: Some(buffer_size),
                    sample_rate: Some(sample_rate),
                };

                // Persist for fast auto-start on next launch
                if let Ok(json) = serde_json::to_string_pretty(&config) {
                    let path = last_config_path();
                    if let Err(e) = std::fs::write(&path, json) {
                        log::warn!("Failed to save last audio config: {}", e);
                    } else {
                        log::debug!("Saved last audio config to {:?}", path);
                    }
                }

                self.active_config = Some(config);

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

    pub fn stop(&mut self) {
        let _ = self.execute_command(IpcCommand::Stop);
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

    pub fn remove_plugin(&mut self, id: &str) -> Result<()> {
        match self.execute_command(IpcCommand::UnloadPlugin { id: id.to_string() })? {
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
        self.is_global_muted = active;
        match self.execute_command(IpcCommand::SetGlobalMute { active })? {
            IpcResponse::Success => {
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

    pub fn set_output_gain(&mut self, value: f32) -> Result<()> {
        match self.execute_command(IpcCommand::SetOutputGain { value })? {
            IpcResponse::Success => Ok(()),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn set_global_bypass(&mut self, active: bool) -> Result<()> {
        match self.execute_command(IpcCommand::SetGlobalBypass { active })? {
            IpcResponse::Success => Ok(()),
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

    pub fn set_channel_scan(&mut self, active: bool) -> Result<()> {
        match self.execute_command(IpcCommand::SetChannelScan { active })? {
            IpcResponse::Success => Ok(()),
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
        if self.child.is_none() {
            return Ok(EngineRuntimeStats::default());
        }

        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => {
                    self.stdin = None;
                    self.child = None;
                    #[cfg(windows)]
                    {
                        self.engine_job = None;
                    }
                    return Ok(EngineRuntimeStats::default());
                }
                Ok(None) => {}
            }
        }

        match self.execute_command(IpcCommand::GetRuntimeStats)? {
            IpcResponse::RuntimeStats {
                active_plugin_count,
                enabled_plugin_count,
                pending_unload_count,
                burned_library_count,
                global_bypass,
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
            } => Ok(EngineRuntimeStats {
                active_plugin_count,
                enabled_plugin_count,
                pending_unload_count,
                burned_library_count,
                global_bypass,
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
            }),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("Unexpected response type")),
        }
    }

    pub fn kill_engine(&mut self) {
        if let Some(mut child) = self.child.take() {
            log::warn!("Force Killing Audio Engine...");
            let _ = child.kill();
            let _ = child.wait();
        }
        self.stdin = None;
        self.child = None;
        #[cfg(windows)]
        {
            self.engine_job = None;
        }
    }

    pub fn warmup(&mut self) -> Result<()> {
        self.ensure_engine_running()?;

        // Fast auto-start: read last successful config and start immediately
        // This avoids waiting for the frontend to load and send the Start command.
        let path = last_config_path();
        match std::fs::read_to_string(&path) {
            Ok(json) => match serde_json::from_str::<ActiveAudioConfig>(&json) {
                Ok(config) if !config.host.is_empty() => {
                    log::info!("Auto-starting audio with last config: {:?}", config);
                    match self.start(
                        Some(config.host),
                        config.input,
                        config.output,
                        config.buffer_size,
                        config.sample_rate,
                    ) {
                        Ok(res) => {
                            log::info!(
                                "Auto-start successful (SR={}, Buf={})",
                                res.sample_rate,
                                res.buffer_size
                            );
                        }
                        Err(e) => {
                            log::warn!("Auto-start failed (user can start manually): {}", e);
                        }
                    }
                }
                Ok(_) => log::debug!("Last config has empty host, skipping auto-start"),
                Err(e) => log::debug!("Failed to parse last config: {}", e),
            },
            Err(_) => log::debug!("No last audio config found, skipping auto-start"),
        }

        Ok(())
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
        return format!(
            "オーディオデバイスが見つかりません。\n\n\
             → デバイスが接続されているか確認してください。\n\
             → 接続し直した後、「更新」ボタンを押してください。"
        );
    }
    if lower.contains("access is denied") {
        return "オーディオデバイスへのアクセスが拒否されました。\n\n\
                → Windows設定 > プライバシー > マイクで、アプリのアクセスを許可してください。\n\
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
