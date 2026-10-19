use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum Command {
    GetDevices,
    AutoGain {
        request: crate::audio_engine::auto_gain::Request,
    },
    Start {
        host: String,
        input: Option<String>,
        output: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
    },
    Stop,
    LoadPlugin {
        path: String,
    },
    UnloadPlugin {
        id: String,
    },
    ReorderPlugins {
        order: Vec<String>,
    },
    OpenEditor {
        id: String,
    },
    SetBypass {
        id: String,
        active: bool,
    },
    SetMute {
        id: String,
        active: bool,
    },
    SetGain {
        id: String,
        value: f32, // Linear gain (0.0 to >1.0)
    },
    SetGlobalMute {
        active: bool,
    },
    SetInputGain {
        value: f32, // Linear gain for pre-FX input (0.0 to >1.0)
    },
    SetNoiseReduction {
        active: bool,
        mode: Option<String>, // "low" | "high" | "smart" | "venue"
    },
    StartNoiseLearning {
        duration_ms: u32,
    },
    CancelNoiseLearning,
    SetNoiseControlConfig {
        active: bool,
        mode: String,
        strength: f32,
        voice_guard: bool,
    },
    SetBuiltInEffects {
        active: bool,
        preset: Option<String>,
        amount: f32,
    },
    SetLoudnessMeasurement {
        id: Option<u64>,
    },
    SetOutputGain {
        value: f32, // Linear gain for master output (0.0 to >1.0)
    },
    SetGlobalBypass {
        active: bool, // Bypass all plugins (A/B comparison: hear dry input)
    },
    SetInputChannels {
        left: usize,
        right: usize,
    },
    SetChannelScan {
        active: bool,
    },
    GetRuntimeStats,
    // Parameter Automation
    GetPluginState {
        id: String,
    },
    SetPluginState {
        id: String,
        state: String, // Base64 chunk
    },
    StartVoiceCheckRecording {
        max_ms: u32,
    },
    StopVoiceCheckRecording,
    PlayVoiceCheck {
        source: String,
        loop_playback: bool,
    },
    StopVoiceCheckPlayback,
    ExportVoiceCheck {
        path: String,
        source: String,
    },
    PlayTestTone {
        freq_hz: f32,
        duration_ms: u32,
        level_db: f32,
    },
    StopTestTone,
    ProbeLoopback {
        input_device: String,
        duration_ms: u32,
        freq_hz: f32,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum Response {
    Devices(Vec<DeviceInfo>),
    AutoGain(crate::audio_engine::auto_gain::Snapshot),
    Success,
    Started {
        sample_rate: u32,
        buffer_size: u32,
    },
    Error(String),
    PluginLoaded {
        id: String,
        name: String,
        vendor: String,
    },
    RuntimeStats {
        active_plugin_count: u32,
        enabled_plugin_count: u32,
        pending_unload_count: u32,
        burned_library_count: u32,
        global_bypass: bool,
        #[serde(default)]
        callback_diagnostics: crate::audio_engine::callback_diagnostics::CallbackSnapshot,
        max_jitter_us: u64,
        glitch_count: u64,
        total_plugin_latency_samples: u32,
        total_plugin_latency_ms: f64,
        noise_reduction_latency_samples: u32,
        noise_reduction_latency_ms: f64,
        total_chain_latency_samples: u32,
        total_chain_latency_ms: f64,
        noise_reduction_enabled: bool,
        noise_reduction_active: bool,
        noise_reduction_mode: String,
        noise_learning_state: String,
        noise_learning_progress: f32,
        noise_profile_available: bool,
        noise_profile_rms: f32,
        recommended_noise_mix: f32,
        speech_detected: bool,
        noise_voice_guard: bool,
        noise_control_strength: f32,
        built_in_effects_enabled: bool,
        built_in_effects_preset: String,
        built_in_effects_amount: f32,
    },
    // ... existing code ...
    PluginState {
        id: String,
        state: String,
    },
    LoopbackProbe {
        detected: bool,
        level_db: f32,
        unavailable: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MeterLevels {
    pub input: [f32; 2],
    pub output: [f32; 2],
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum EngineEvent {
    Log(String),
    Error(String),
    // Peak Meters (Input L/R, Output L/R)
    LevelMeter(MeterLevels),
    Loudness(crate::audio_engine::loudness::LoudnessReading),
    Stopped,
    // Channel Activity Scan (Up to 32 chans)
    ChannelLevels(Vec<f32>),
    Started { sample_rate: u32, buffer_size: u32 },
    VoiceCheckState {
        state: String,
        position_ms: u32,
        duration_ms: u32,
    },
    VoiceCheckEnvelope {
        raw_peaks: Vec<f32>,
        processed_peaks: Vec<f32>,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DeviceInfo {
    pub name: String,
    pub host: String,
    pub is_input: bool,
    pub buffer_size_range: Option<(u32, u32)>,
    pub channels: u16,
    pub is_default: bool,
}

#[cfg(test)]
mod tests {
    use super::Command;

    #[test]
    fn voice_check_commands_roundtrip() {
        let cmds = [
            Command::StartVoiceCheckRecording { max_ms: 5000 },
            Command::StopVoiceCheckRecording,
            Command::PlayVoiceCheck {
                source: "raw".to_string(),
                loop_playback: true,
            },
            Command::StopVoiceCheckPlayback,
            Command::ExportVoiceCheck {
                path: "C:\\temp\\test.wav".to_string(),
                source: "processed".to_string(),
            },
        ];
        for cmd in cmds {
            let json = serde_json::to_string(&cmd).expect("serialize");
            let _: Command = serde_json::from_str(&json).expect("deserialize");
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", content = "data")]
pub enum OutputMessage {
    Response(Response),
    Event(EngineEvent),
}
