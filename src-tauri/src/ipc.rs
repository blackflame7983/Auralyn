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
    SetInputChannels {
        left: usize,
        right: usize,
    },
    SetChannelScan {
        active: bool,
    },
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
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", content = "data")]
pub enum OutputMessage {
    Response(Response),
    Event(EngineEvent),
}
