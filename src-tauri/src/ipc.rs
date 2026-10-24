use serde::{Deserialize, Serialize};

/// Startの同じ要求で初回callbackへ渡す制御意図。旧Startでは省略する。
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartControls {
    pub input_gain: f32,
    pub output_gain: f32,
    pub input_channels: [usize; 2],
    pub muted: bool,
    pub bypassed: bool,
}
impl StartControls {
    pub fn validate(&self) -> Result<(), String> {
        if [self.input_gain, self.output_gain]
            .iter()
            .all(|v| v.is_finite() && (0.0..=2.0).contains(v))
        {
            Ok(())
        } else {
            Err("初期音量が範囲外です".into())
        }
    }
}

/// 計算・申告値の根拠だけを伝える。信号の通過時間は測定していない。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyMetadata {
    pub schema_version: u8,
    pub stream_running: bool,
    pub nominal_sample_rate_hz: Option<u32>,
    pub fixed_buffer_request_frames: Option<u32>,
    pub nr_configured_enabled: bool,
    pub nr_processing_rate_hz: Option<u32>,
    pub nr_processing_frame_samples: Option<u32>,
    pub vst_reported_latency_samples: u32,
    pub signal_correspondence: SignalCorrespondence,
    #[serde(default)]
    pub stage_breakdown: Option<LatencyStages>,
}

/// 申告・計算・unknownを並列に記録する。実測合計ではない。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyStages {
    pub schema_version: u8,
    pub query_basis: String,
    pub current: bool,
    pub stream_epoch: Option<String>,
    pub global_bypass: bool,
    pub vst: Vec<VstLatencyStage>,
    pub vst_known_subtotal_samples: Option<u32>,
    pub vst_subtotal_overflow: bool,
    pub nr: NrLatencyStage,
    pub builtin_voice_enabled: bool,
    pub builtin_reverb_enabled: bool,
    pub builtin_signal_delay: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VstLatencyStage {
    pub id: String,
    pub name: String,
    pub state: String,
    pub bypassed: bool,
    pub muted: bool,
    pub declared_samples: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NrLatencyStage {
    pub enabled: bool,
    pub configured_rate_hz: Option<u32>,
    pub frame_samples: Option<u32>,
    pub frame_period_ms: Option<f64>,
    pub model_rate_hz: u32,
    pub model_frame_samples: u32,
    pub signal_delay: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignalCorrespondence {
    Unmeasured,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestorePluginRequest {
    pub path: String,
    pub state: Option<String>,
    pub bypassed: bool,
    pub muted: bool,
    pub gain: f32,
}

impl RestorePluginRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.path.is_empty()
            || self.path.len() > 32_768
            || self.path.contains('\0')
            || !self.gain.is_finite()
            || self.gain < 0.0
            || self
                .state
                .as_ref()
                .is_some_and(|state| state.len() > 64 * 1024 * 1024)
        {
            return Err("VST復元のパス・状態・ゲインが不正です".into());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RestoredPlugin {
    pub id: String,
    pub name: String,
    /// falseは停止中のstate復元成功。音声開始時のprepare成功を保証しない。
    pub prepared: bool,
}

/// 保存stateやview生成を含まない、稼働中ラックへの再接続用情報。
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RackPlugin {
    pub id: String,
    pub path: String,
    pub name: String,
    pub enabled: bool,
    pub muted: bool,
    pub gain: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum SessionRackRequest {
    Snapshot,
    Retain {
        generation: String,
        revision: String,
        ids: Vec<String>,
        #[serde(rename = "inputGain")]
        input_gain: Option<f32>,
    },
    Begin {
        #[serde(default)]
        explicit: bool,
        generation: String,
        revision: String,
        ids: Vec<String>,
        #[serde(rename = "inputGain")]
        input_gain: f32,
        #[serde(rename = "outputGain")]
        output_gain: f32,
    },
    Add {
        token: String,
        request: RestorePluginRequest,
    },
    Finish {
        token: String,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SessionRackReply {
    Snapshot {
        generation: String,
        revision: String,
        present: bool,
        running: bool,
        #[serde(rename = "restoreEligible")]
        restore_eligible: bool,
        plugins: Vec<RackPlugin>,
    },
    Ready {
        token: String,
        generation: String,
    },
    Restored {
        plugin: RestoredPlugin,
    },
    Finished,
    Conflict,
    Busy,
    Failed {
        message: String,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum Command {
    GetPluginRack,
    RestoreSessionPlugin {
        expected_ids: Vec<String>,
        expected_revision: u64,
        request: RestorePluginRequest,
        operation_id: u64,
        expires_at_ms: u64,
    },
    GetDevices,
    LiveMode {
        request: crate::audio_engine::live_modes::Request,
    },
    ConfigureLiveModes {
        definitions: crate::audio_engine::live_modes::Definitions,
        armed: bool,
    },
    BeginDeviceScan,
    PollDeviceScan {
        token: u64,
    },
    CancelDeviceScan {
        token: u64,
    },
    AutoGain {
        request: crate::audio_engine::auto_gain::Request,
    },
    Start {
        host: String,
        input: Option<String>,
        output: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_controls: Option<StartControls>,
    },
    Stop,
    LoadPlugin {
        path: String,
    },
    RestorePlugin {
        request: RestorePluginRequest,
        operation_id: u64,
        expires_at_ms: u64,
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
        #[serde(default)]
        singing: Option<crate::audio_engine::singing::SingingParams>,
        #[serde(default)]
        reverb: Option<crate::audio_engine::reverb::ReverbParams>,
    },
    BuiltinEffects {
        request: crate::audio_engine::builtin::Request,
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
    GetFrameTimingTrace {
        #[serde(rename = "expectedEpoch")]
        expected_epoch: String,
    },
    // Parameter Automation
    GetPluginState {
        id: String,
    },
    CaptureBundleState,
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
    VoiceCheckPreview {
        request: crate::audio_engine::voice_check::preview::Request,
    },
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
    PluginRack {
        plugins: Vec<RackPlugin>,
        restore_eligible: bool,
        revision: u64,
        running: bool,
    },
    RackBusy,
    RackConflict,
    BundleState(Box<crate::bundle::EngineCapture>),
    BuiltinEffects(crate::audio_engine::builtin::Snapshot),
    LiveModes(Box<crate::audio_engine::live_modes::Snapshot>),
    PluginRestored {
        operation_id: u64,
        plugin: RestoredPlugin,
    },
    Devices(Vec<DeviceInfo>),
    DeviceScanStarted {
        token: u64,
    },
    DeviceScanStatus {
        token: u64,
        status: DeviceScanStatus,
    },
    AutoGain(crate::audio_engine::auto_gain::Snapshot),
    VoiceCheckPreview(Box<crate::audio_engine::voice_check::preview::Snapshot>),
    FrameTimingTrace(Box<crate::audio_engine::frame_timing::Trace>),
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
        callback_diagnostics: Box<crate::audio_engine::callback_diagnostics::CallbackSnapshot>,
        #[serde(default)]
        queue_diagnostics: Option<Box<crate::audio_engine::queue_diagnostics::QueueSnapshot>>,
        #[serde(default)]
        latency_metadata: Option<Box<LatencyMetadata>>,
        #[serde(default)]
        frame_timing: Option<Box<crate::audio_engine::frame_timing::Snapshot>>,
        #[serde(default)]
        resampler_batch_timing: Option<Box<crate::audio_engine::frame_timing::BatchSnapshot>>,
        #[serde(default)]
        resampler_cohort_timing: Option<Box<crate::audio_engine::frame_timing::cohort::Snapshot>>,
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
        built_in_singing: Option<crate::audio_engine::singing::SingingParams>,
        built_in_reverb: Option<crate::audio_engine::reverb::ReverbParams>,
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

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "status", content = "data")]
pub enum DeviceScanStatus {
    Pending,
    Completed(Vec<DeviceInfo>),
    Failed(String),
    Cancelled,
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
    Started {
        sample_rate: u32,
        buffer_size: u32,
    },
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

#[cfg(test)]
mod device_scan_protocol_tests {
    use super::*;
    #[test]
    fn scan_requests_and_terminal_responses_keep_the_tagged_protocol() {
        for command in [
            Command::GetDevices,
            Command::BeginDeviceScan,
            Command::PollDeviceScan { token: 7 },
            Command::CancelDeviceScan { token: 7 },
        ] {
            let json = serde_json::to_string(&command).unwrap();
            let decoded: Command = serde_json::from_str(&json).unwrap();
            assert_eq!(
                serde_json::to_value(command).unwrap(),
                serde_json::to_value(decoded).unwrap()
            );
        }
        for status in [
            DeviceScanStatus::Pending,
            DeviceScanStatus::Completed(Vec::new()),
            DeviceScanStatus::Failed("timeout".into()),
            DeviceScanStatus::Cancelled,
        ] {
            let response = Response::DeviceScanStatus { token: 7, status };
            let json = serde_json::to_string(&response).unwrap();
            let decoded: Response = serde_json::from_str(&json).unwrap();
            assert_eq!(
                serde_json::to_value(response).unwrap(),
                serde_json::to_value(decoded).unwrap()
            );
        }
    }
}

#[cfg(test)]
mod cohort_compatibility_tests {
    #[test]
    fn old_runtime_stats_missing_or_null_cohort_remain_unknown() {
        let mut data = serde_json::json!({
            "active_plugin_count":0,"enabled_plugin_count":0,"pending_unload_count":0,"burned_library_count":0,"global_bypass":false,
            "callback_diagnostics":{"count":0,"minFrames":0,"maxFrames":0,"totalProcessingUs":0,"maxProcessingUs":0},
            "max_jitter_us":0,"glitch_count":0,"total_plugin_latency_samples":0,"total_plugin_latency_ms":0.0,"noise_reduction_latency_samples":0,"noise_reduction_latency_ms":0.0,"total_chain_latency_samples":0,"total_chain_latency_ms":0.0,
            "noise_reduction_enabled":false,"noise_reduction_active":false,"noise_reduction_mode":"low","noise_learning_state":"idle","noise_learning_progress":0.0,"noise_profile_available":false,"noise_profile_rms":0.0,"recommended_noise_mix":0.0,"speech_detected":false,"noise_voice_guard":false,"noise_control_strength":1.0,"built_in_effects_enabled":false,"built_in_effects_preset":"broadcast","built_in_effects_amount":0.7
        });
        for explicit_null in [false, true] {
            if explicit_null {
                data["resampler_cohort_timing"] = serde_json::Value::Null;
            }
            let response: super::Response = serde_json::from_value(
                serde_json::json!({"type":"RuntimeStats","payload":data.clone()}),
            )
            .unwrap();
            let super::Response::RuntimeStats {
                resampler_cohort_timing,
                ..
            } = response
            else {
                panic!()
            };
            assert!(resampler_cohort_timing.is_none());
        }
    }
}
