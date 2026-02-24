use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum Command {
    GetDevices,
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
        mode: Option<String>, // "low" | "high"
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
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum Response {
    Devices(Vec<DeviceInfo>),
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
    },
    // ... existing code ...
    PluginState {
        id: String,
        state: String,
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
    // Channel Activity Scan (Up to 32 chans)
    ChannelLevels(Vec<f32>),
    Started { sample_rate: u32, buffer_size: u32 },
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

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", content = "data")]
pub enum OutputMessage {
    Response(Response),
    Event(EngineEvent),
}
