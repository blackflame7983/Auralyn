use serde::{Deserialize, Serialize};

/// 入力と物理出力の対応。旧データでは従来の条件付き insert を維持する。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum OutputRouting {
    #[default]
    Legacy,
    Independent {
        channels: [usize; 2],
    },
    Insert,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRouting {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_channels: Option<[usize; 2]>,
    #[serde(default)]
    pub output_routing: OutputRouting,
}

impl ChannelRouting {
    /// 実際のストリーム構成確定後、callback の生成前に解決する。
    pub fn resolve(
        mut self,
        asio: bool,
        inputs: usize,
        outputs: usize,
    ) -> Result<(Self, [usize; 2]), String> {
        if inputs == 0 || outputs == 0 {
            return Err("入出力チャンネルがありません".into());
        }
        let first_input = [0, usize::from(inputs > 1)];
        let input = match self.input_channels {
            None => first_input,
            Some([0, 1]) if !asio && inputs == 1 => [0, 0],
            Some(pair)
                if pair.iter().all(|&channel| channel < inputs)
                    && (asio || pair.iter().all(|&channel| channel < 2)) =>
            {
                pair
            }
            Some(_) => return Err("入力チャンネルが範囲外です".into()),
        };
        let first_output = [0, usize::from(outputs > 1)];
        // 未取得の能力を持つ機器の既定ステレオ指定だけは mono に畳む。
        if asio
            && outputs == 1
            && self.output_routing == (OutputRouting::Independent { channels: [0, 1] })
        {
            self.output_routing = OutputRouting::Independent { channels: [0, 0] };
        }
        if !asio && matches!(self.output_routing, OutputRouting::Independent { .. }) {
            self.output_routing = OutputRouting::Independent {
                channels: first_output,
            };
        }
        let output = match self.output_routing {
            OutputRouting::Legacy if asio && input.iter().all(|&channel| channel < outputs) => {
                input
            }
            OutputRouting::Legacy => first_output,
            OutputRouting::Independent { channels } if asio => {
                if !channels.iter().all(|&channel| channel < outputs) {
                    return Err("出力チャンネルが範囲外です".into());
                }
                channels
            }
            OutputRouting::Independent { .. } => first_output,
            OutputRouting::Insert if asio && input.iter().all(|&channel| channel < outputs) => {
                input
            }
            OutputRouting::Insert => {
                return Err("insert に対応する出力チャンネルがありません".into())
            }
        };
        Ok((
            Self {
                input_channels: Some(input),
                ..self
            },
            output,
        ))
    }
}

#[cfg(test)]
mod channel_routing_tests {
    use super::{ChannelRouting, OutputRouting};

    #[test]
    fn old_data_defaults_to_legacy_and_resolves_first_pair() {
        let routing: ChannelRouting = serde_json::from_str("{}").unwrap();
        assert_eq!(routing.output_routing, OutputRouting::Legacy);
        assert_eq!(
            routing.resolve(true, 4, 4).unwrap().0.input_channels,
            Some([0, 1])
        );
    }

    #[test]
    fn independent_insert_and_legacy_choose_distinct_outputs() {
        let routing = ChannelRouting {
            input_channels: Some([2, 3]),
            output_routing: OutputRouting::Independent { channels: [0, 1] },
        };
        assert_eq!(routing.resolve(true, 4, 4).unwrap().1, [0, 1]);
        assert_eq!(
            ChannelRouting {
                output_routing: OutputRouting::Insert,
                ..routing
            }
            .resolve(true, 4, 4)
            .unwrap()
            .1,
            [2, 3]
        );
        assert_eq!(
            ChannelRouting {
                output_routing: OutputRouting::Legacy,
                ..routing
            }
            .resolve(true, 4, 2)
            .unwrap()
            .1,
            [0, 1]
        );
    }

    #[test]
    fn rejects_missing_physical_channels_and_collapses_mono() {
        let input = ChannelRouting {
            input_channels: Some([2, 3]),
            output_routing: OutputRouting::Insert,
        };
        assert!(input.resolve(true, 2, 4).is_err());
        assert!(input.resolve(true, 4, 2).is_err());
        let output = ChannelRouting {
            input_channels: Some([0, 1]),
            output_routing: OutputRouting::Independent { channels: [2, 3] },
        };
        assert!(output.resolve(true, 4, 2).is_err());
        let (resolved, pair) = output.resolve(false, 1, 1).unwrap();
        assert_eq!(resolved.input_channels, Some([0, 0]));
        assert_eq!(pair, [0, 0]);
        assert!(input.resolve(false, 4, 4).is_err());
        let default_output = ChannelRouting {
            input_channels: None,
            output_routing: OutputRouting::Independent { channels: [0, 1] },
        };
        let (resolved, pair) = default_output.resolve(true, 1, 1).unwrap();
        assert_eq!(pair, [0, 0]);
        assert_eq!(
            resolved.output_routing,
            OutputRouting::Independent { channels: [0, 0] }
        );
        assert!(ChannelRouting {
            output_routing: OutputRouting::Independent { channels: [0, 2] },
            ..default_output
        }
        .resolve(true, 1, 1)
        .is_err());
    }

    #[test]
    fn routing_json_round_trips() {
        let routing = ChannelRouting {
            input_channels: Some([2, 3]),
            output_routing: OutputRouting::Independent { channels: [0, 1] },
        };
        let value = serde_json::to_value(routing).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"inputChannels": [2, 3], "outputRouting": {"mode": "independent", "channels": [0, 1]}})
        );
        assert_eq!(
            serde_json::from_value::<ChannelRouting>(value).unwrap(),
            routing
        );
    }
}

/// 準備画面の確認を結び付ける制御側の状態。音声の到達や聴感を保証しない。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreparationSnapshot {
    pub engine_epoch: String,
    pub processing_revision: String,
    pub routing_revision: String,
    pub input_gain: f32,
    pub input_channels: [usize; 2],
    #[serde(default)]
    pub output_routing: OutputRouting,
    pub output_gain: f32,
    pub output_revision: String,
    pub muted: bool,
    pub controls_pending: bool,
    pub nr_backend: String,
    pub nr_model: String,
}

/// Startの同じ要求で初回callbackへ渡す制御意図。旧Startでは省略する。
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartControls {
    pub input_gain: f32,
    pub output_gain: f32,
    pub input_channels: [usize; 2],
    #[serde(default)]
    pub output_routing: OutputRouting,
    pub muted: bool,
    pub bypassed: bool,
}
impl StartControls {
    pub fn routing(&self) -> ChannelRouting {
        ChannelRouting {
            input_channels: Some(self.input_channels),
            output_routing: self.output_routing,
        }
    }
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
    #[serde(default)]
    pub processing_context: Option<String>,
    #[serde(default)]
    pub broadcast_state: Option<String>,
    #[serde(default)]
    pub comparison_revision: Option<String>,
    #[serde(default)]
    pub stream_epoch: Option<String>,
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
    /// 無い旧データはパスだけを使い、最初に生成できたクラスを開く。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_id: Option<String>,
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
            || self.class_id.as_ref().is_some_and(|class_id| {
                crate::vst_host::class_listing::normalize_class_id(class_id).is_none()
            })
        {
            return Err("VST復元のパス・状態・ゲイン・クラスIDが不正です".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPlugin {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub legacy_class_ambiguous: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RestoredPlugin {
    pub id: String,
    pub name: String,
    /// falseは停止中のstate復元成功。音声開始時のprepare成功を保証しない。
    pub prepared: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_id: Option<String>,
    /// クラス未指定で、エフェクト候補が2つ以上あった。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub legacy_class_ambiguous: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_id: Option<String>,
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
    ProcessingState,
    CaptureMixingBundleState,
    PostMixPrepare {
        sample_rate: u32,
    },
    PostMixClear,
    PostMixStatus,
    PostMixStart {
        descriptor: crate::audio_engine::post_mix::Descriptor,
    },
    Mixing {
        request: crate::audio_engine::mixing::Request,
    },
    ModeMonitor {
        request: crate::audio_engine::split_monitor::Request,
    },
    ModeSilence {
        request: crate::audio_engine::mode_silence::Request,
    },
    LiveOutput {
        config: Option<crate::audio_engine::live_output::Config>,
    },
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
    /// このEngineがStart時の実デバイスID照合に対応することを確認する。
    StartIdentityCapability,
    ProcessInputCapability,
    AutoGain {
        request: crate::audio_engine::auto_gain::Request,
    },
    Start {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_source: Option<crate::input_source::Start>,
        host: String,
        input: Option<String>,
        output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_id: Option<String>,
        buffer_size: Option<u32>,
        sample_rate: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_controls: Option<StartControls>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_routing: Option<ChannelRouting>,
    },
    Stop,
    LoadPlugin {
        path: String,
        #[serde(default, rename = "classId", skip_serializing_if = "Option::is_none")]
        class_id: Option<String>,
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
    /// 異常出力で止めた VST の処理を、明示操作でのみ再開する。
    ResumePlugin {
        id: String,
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
    PeakProtection {
        config: Option<crate::audio_engine::peak_protection::Config>,
    },
    NoiseMeasurement {
        request: crate::audio_engine::core::noise_learning::Request,
    },
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

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginHealthEntry {
    pub id: String,
    /// 現在は停止中だけを載せる。
    pub state: String,
    pub invalid_blocks: u32,
    /// この token で停止へ遷移した回数。古い統計には無いので 0。
    #[serde(default)]
    pub isolation_seq: u64,
    /// 起動ごとに振り直す世代。古い統計には無いので 0。
    #[serde(default)]
    pub token: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum Response {
    ProcessingState {
        present: bool,
        failed: bool,
    },
    PostMixDescriptor(crate::audio_engine::post_mix::Descriptor),
    PostMixStatus {
        attached: bool,
        ready: bool,
        failed: bool,
        sample_rate: Option<u32>,
        transport_latency_frames: u32,
        declared_plugin_latency_frames: Option<u32>,
        #[serde(default)]
        processed_packets: Option<u64>,
    },
    Mixing(Box<crate::audio_engine::mixing::Snapshot>),
    ModeMonitor(Box<crate::audio_engine::split_monitor::StateSnapshot>),
    ModeSilence(crate::audio_engine::mode_silence::Snapshot),
    PeakProtection(crate::audio_engine::peak_protection::Snapshot),
    NoiseMeasurement(Box<crate::audio_engine::core::noise_learning::Snapshot>),
    LiveOutput(Box<crate::audio_engine::live_output::Status>),
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
    StartIdentityCapability {
        version: u32,
    },
    ProcessInputCapability {
        version: u32,
    },
    Started {
        sample_rate: u32,
        buffer_size: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        routing: Option<ChannelRouting>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_id: Option<String>,
    },
    Error(String),
    PluginLoaded {
        id: String,
        name: String,
        vendor: String,
        #[serde(default, rename = "classId", skip_serializing_if = "Option::is_none")]
        class_id: Option<String>,
        #[serde(
            default,
            rename = "legacyClassAmbiguous",
            skip_serializing_if = "std::ops::Not::not"
        )]
        legacy_class_ambiguous: bool,
    },
    RuntimeStats {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        process_input: Option<Box<crate::audio_engine::process_capture::Snapshot>>,
        #[serde(default)]
        preparation: Option<Box<PreparationSnapshot>>,
        active_plugin_count: u32,
        enabled_plugin_count: u32,
        pending_unload_count: u32,
        burned_library_count: u32,
        global_bypass: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        plugin_health: Vec<PluginHealthEntry>,
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
    MixingSourceFailed,
    MixingOutputFailed,
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
    /// 選択中の既定ch・F32の対応範囲。Noneは取得していないことを表す。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate_ranges: Option<Vec<(u32, u32)>>,
    pub name: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
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
// 制御スレッドの直列IPC。頻出するメーターイベントごとのBox確保は追加しない。
#[allow(clippy::large_enum_variant)]
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
                preparation,
                ..
            } = response
            else {
                panic!()
            };
            assert!(resampler_cohort_timing.is_none());
            assert!(preparation.is_none());
        }
    }

    #[test]
    fn plugin_health_uses_camel_case_and_empty_lists_stay_absent() {
        let entry = super::PluginHealthEntry {
            id: "plugin".into(),
            state: "isolated".into(),
            invalid_blocks: 4,
            isolation_seq: 2,
            token: 9,
        };
        let value = serde_json::to_value(&entry).unwrap();
        assert_eq!(value["invalidBlocks"], 4);
        assert_eq!(value["isolationSeq"], 2);
        assert_eq!(value["token"], 9);
        assert!(value.get("invalid_blocks").is_none());
        assert!(value.get("isolation_seq").is_none());
        assert_eq!(value["state"], "isolated");
        let old: super::PluginHealthEntry = serde_json::from_value(serde_json::json!({
            "id": "plugin",
            "state": "isolated",
            "invalidBlocks": 4
        }))
        .unwrap();
        assert_eq!(old.isolation_seq, 0);
        assert_eq!(old.token, 0);
    }
}
