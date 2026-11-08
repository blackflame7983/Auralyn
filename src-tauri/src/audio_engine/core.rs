#[path = "core/noise_comparison.rs"]
mod noise_comparison;
#[cfg(test)]
#[path = "core/noise_evaluation.rs"]
mod noise_evaluation;
#[path = "core/noise_learning.rs"]
pub mod noise_learning;
use noise_learning::{NoiseLearningShared, RtNoiseLearning};
#[path = "core/dsp.rs"]
pub(crate) mod dsp;
#[path = "core/slot_transition.rs"]
mod slot_transition;
#[cfg(any(test, feature = "dsp-verification"))]
use dsp::RtNoiseReducer;
use dsp::{
    normalize_built_in_effects_preset, normalize_noise_control_mode, Smoother,
    NOISE_REDUCTION_MODE_HIGH, NOISE_REDUCTION_MODE_LOW, NOISE_REDUCTION_MODE_SMART,
    NOISE_REDUCTION_MODE_VENUE,
};
#[path = "core/noise_control.rs"]
pub(crate) mod noise_control;
use noise_control::{Analysis as NoiseAnalysis, RtNoiseControl, Settings as NoiseSettings};
#[path = "core/auto_gain_commands.rs"]
mod auto_gain_commands;
#[path = "core/bundle_capture.rs"]
mod bundle_capture;
#[path = "core/capabilities.rs"]
mod capabilities;
#[path = "core/commands.rs"]
mod commands;
#[path = "core/input.rs"]
mod input;
#[path = "core/lifecycle.rs"]
pub(super) mod lifecycle;
#[path = "core/mixing.rs"]
mod mixing_state;
#[path = "core/native_stream.rs"]
mod native_stream;
#[path = "core/post_mix.rs"]
mod post_mix;
#[path = "core/session_rack.rs"]
mod session_rack;
#[path = "core/startup.rs"]
mod startup;
use super::auto_gain::{self, Session as GainSession};
use super::auto_gain_preview;
use super::callback_diagnostics::{
    normalized_channels, requested_channels, CallbackDiagnostics, OutputCadence,
};
use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use lifecycle::{callback_owner, ControlOwner, StreamPair};
use log;
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::HeapRb;
use serde_json;
use std::io::{self, BufRead, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant};

use winit::event::{Event, WindowEvent};
use winit::event_loop::{ControlFlow, EventLoopBuilder};

use crate::ipc::{Command, EngineEvent, MeterLevels, OutputMessage, Response};
use crate::vst_host::instance::VstProcessor;

// New Managers
use super::devices::DeviceManager;
use super::editors::EditorManager;
use super::loopback_probe::{analyze_loopback, capture_input_mono};
use super::loudness::{LoudnessMeter, LoudnessReading};
use super::plugins::PluginManager;
use super::plugins::MAX_PLUGINS;
use super::queue_diagnostics::{self, QueueDiagnostics, QueueSnapshot, QueueState};
#[cfg(test)]
mod latency_tests;
#[cfg(test)]
#[path = "core/user_event_tests.rs"]
mod user_event_tests;
use super::test_tone::RtTestTone;
use super::voice_check::preview as voice_preview;
use super::voice_check::{
    allocate_voice_check_buffers, compute_peak_envelope, export_voice_check_wav,
    parse_voice_check_source, RtVoiceCheck, VoiceCheckBuffers, VoiceCheckShared, VC_STATE_IDLE,
    VC_STATE_RECORDING, VOICE_CHECK_ENVELOPE_BUCKETS,
};

#[cfg(any(test, feature = "dsp-verification"))]
#[path = "core/dsp_rt_tests.rs"]
mod dsp_rt_tests;

// 通常の配布には含めない、検証用exampleの入口。
#[cfg(feature = "dsp-verification")]
#[doc(hidden)]
pub fn run_dsp_abort_verification() {
    if cfg!(debug_assertions) || !cfg!(panic = "abort") {
        panic!("release・panic=abort構成で実行してください");
    }
    dsp_rt_tests::run_all();
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseControlMode {
    Low,
    High,
    Smart,
    Venue,
}

impl NoiseControlMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Low => NOISE_REDUCTION_MODE_LOW,
            Self::High => NOISE_REDUCTION_MODE_HIGH,
            Self::Smart => NOISE_REDUCTION_MODE_SMART,
            Self::Venue => NOISE_REDUCTION_MODE_VENUE,
        }
    }
}

pub use super::builtin::Preset as BuiltInEffectsPreset;

pub enum AudioThreadMessage {
    CohortWindow {
        revision: u64,
    },
    AddProcessor {
        index: u8,
        processor: VstProcessor,
        initial_gain: f32,
        initial_bypassed: bool,
        initial_muted: bool,
        health_token: u64,
        /// 申告遅延。不明は `u32::MAX` とし、遷移はディップを選ぶ。
        latency: u32,
    },
    RemoveProcessor {
        index: u8,
    },
    ReorderProcessors {
        order: [u8; MAX_PLUGINS],
        len: u8,
    },
    SetBypass {
        index: u8,
        active: bool,
        /// その時点の申告遅延。不明は `u32::MAX`。
        latency: u32,
    },
    SetMute {
        index: u8,
        active: bool,
    },
    SetGain {
        index: u8,
        value: f32,
    },
    /// 停止した slot の判定だけを戻す。VST の内部状態はリセットしない。
    ResumePlugin {
        index: u8,
    },
    SetGlobalMute(bool),
    LiveMode {
        voice: super::live_modes::Voice,
        revision: u64,
        builtin_revision: u64,
        reverb: super::reverb::Coefficients,
        talk: bool,
        frames: u32,
    },
    SetGlobalBypass(bool),
    SetInputGain(f32),
    StartNoiseLearning {
        generation: u64,
        window_frames: usize,
        duration_frames: u64,
    },
    CancelNoiseLearning,
    SetNoiseControl {
        revision: u64,
        active: bool,
        mode: NoiseControlMode,
        strength: f32,
        voice_guard: bool,
    },
    SetBuiltInEffects {
        active: bool,
        preset: BuiltInEffectsPreset,
        amount: f32,
        singing: super::singing::Coefficients,
        reverb: super::reverb::Coefficients,
        revision: u64,
    },
    SetLoudnessMeasurement(Option<u64>),
    MeasurementReservation(u64),
    SetOutputGain {
        value: f32,
        revision: u64,
    },
    StartAutoGainCapture(u64),
    SetInputChannels(usize, usize), // (Left, Right)
    StartVoiceCheckRecording {
        buffers: Arc<VoiceCheckBuffers>,
        max_frames: u64,
    },
    StopVoiceCheckRecording,
    PlayVoiceCheck {
        source: u32,
        loop_playback: bool,
    },
    StopVoiceCheckPlayback,
    VoiceCheckTransportAck(u64),
    PlayTestTone {
        freq_hz: f32,
        duration_ms: u32,
        level_db: f32,
    },
    StopTestTone,
    Stop,
}

impl AudioThreadMessage {
    fn changes_cohort(&self) -> bool {
        matches!(
            self,
            Self::AddProcessor { .. }
                | Self::RemoveProcessor { .. }
                | Self::ReorderProcessors { .. }
                | Self::SetBypass { .. }
                | Self::SetMute { .. }
                | Self::SetGain { .. }
                | Self::ResumePlugin { .. }
                | Self::LiveMode { .. }
                | Self::SetGlobalBypass(_)
                | Self::SetInputGain(_)
                | Self::SetInputChannels(..)
                | Self::StartNoiseLearning { .. }
                | Self::CancelNoiseLearning
                | Self::SetNoiseControl { .. }
                | Self::SetBuiltInEffects { .. }
                | Self::SetOutputGain { .. }
        )
    }
}

pub struct RetiredProcessor {
    pub index: u8,
    pub processor: VstProcessor,
}

enum DisposedProcessor {
    Retired(RetiredProcessor),
    // 現役slotのアンロード完了として通知してはいけない。
    Rejected(VstProcessor),
}

// callback終了後もprocessorを制御側で解放するため、一括して所有する。
struct CallbackProcessors {
    reverb: super::reverb::Reverb,
    processors: [Option<VstProcessor>; MAX_PLUGINS],
    pending_retire: [Option<DisposedProcessor>; MAX_PLUGINS],
    pending_rejected: super::deferred_drop::DeferredDrop<DisposedProcessor>,
}

struct LoopbackProbeOutcome {
    detected: bool,
    level_db: f32,
    unavailable: Option<String>,
}

// Custom Event for Winit Loop
#[derive(Debug)]
#[allow(clippy::large_enum_variant)] // Box候補の追加確保と配送時間を比較し、現行を維持する。user_event_tests参照。
pub enum UserEvent {
    Command(Command),
    Shutdown,
    Timer,
}

type CmdProducer = <HeapRb<AudioThreadMessage> as Split>::Prod;
type LoudnessConsumer = <HeapRb<LoudnessReading> as Split>::Cons;
type LevelConsumer = <HeapRb<MeterLevels> as Split>::Cons;
type ChannelConsumer = <HeapRb<super::channel_scan::Snapshot> as Split>::Cons;
type RetireConsumer = <HeapRb<DisposedProcessor> as Split>::Cons;

fn time_critical_audio_threads_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        let Some(v) = std::env::var_os("AURALYN_TIME_CRITICAL_AUDIO_THREADS") else {
            return false;
        };
        let v = v.to_string_lossy().to_ascii_lowercase();
        v == "1" || v == "true" || v == "yes" || v == "on"
    })
}

struct AudioStartRequest {
    input_source: Option<crate::input_source::Start>,
    host_name: Option<String>,
    input_name: Option<String>,
    output_name: Option<String>,
    sample_rate: Option<u32>,
    buffer_size: Option<u32>,
    device_ids: (Option<String>, Option<String>),
}

pub struct Engine {
    builtin: super::builtin::Controller,
    live_modes: super::live_modes::Controller,
    pending_restore: Option<super::restoration::StagedRestore>,
    gain_shared: Arc<auto_gain::Shared>,
    gain_capture_rx: Option<auto_gain::CaptureConsumer>,
    gain_revision: u64,
    peak_config: super::peak_protection::Config,
    peak_shared: Arc<super::peak_protection::Shared>,
    output_gain: f32,
    output_gain_revision: u64,
    output_gain_initialized: bool,
    gain_session: Option<GainSession>,
    gain_history: Option<auto_gain::History>,
    gain_history_reason: super::history::Reason,
    gain_preview: Option<auto_gain_preview::Preview>,
    gain_main_device: Option<String>,
    stream_failed: Arc<AtomicBool>,
    live_output: Option<super::live_output::Sink>,
    live_output_config: super::live_output::Config,
    live_output_error: Option<String>,
    monitor_levels: Arc<AtomicU64>,
    split_monitor: Option<super::split_monitor::Controller>,
    restored_monitor: Option<super::split_monitor::State>,
    split_worker: Option<super::split_monitor::Worker>,
    mode_silence: super::mode_silence::Controller,
    input_stream: Option<input::InputStream>,
    input_source: Option<crate::input_source::Start>,
    process_shared: Option<Arc<super::process_capture::Shared>>,
    mixing_start: Option<super::mixing::Start>,
    mixing_revision: u64,
    mixing_shared: Option<Arc<super::mixing::controls::Shared>>,
    mixing_source: Option<super::mixing::input::Controller>,
    mixing_input_shared: Option<Arc<super::process_capture::Shared>>,
    mixing_worker_owner: Option<ControlOwner<super::mixing::runtime::Broadcast>>,
    mixing_source_failure_reported: bool,
    mixing_output_failure_reported: bool,
    process_renderer_owner: Option<ControlOwner<super::process_capture::clock::Renderer>>,
    output_stream: Option<cpal::Stream>,
    post_role: bool,
    processing_restart_revision: u64,
    last_processing_preparation: &'static str,
    post_worker: Option<post_mix::Worker>,
    post_mapping: Option<super::post_mix::Mapping>,
    post_renderer_owner: Option<ControlOwner<super::post_mix::ClientRenderer>>,

    // Sub-Modules
    pub device_manager: DeviceManager,
    // フィールドの破棄順序: プラグインのエディタ切断を HWND の破棄より先に行う。
    pub plugin_manager: PluginManager,
    pub editor_manager: EditorManager,

    command_tx: Option<CmdProducer>,
    level_rx: Option<LevelConsumer>,
    loudness_rx: Option<LoudnessConsumer>,
    channel_rx: Option<ChannelConsumer>,
    retire_rx: Option<RetireConsumer>,
    processor_return: Option<ControlOwner<CallbackProcessors>>,
    resampling_failed: Arc<AtomicBool>,
    nr_failed: Arc<AtomicBool>,
    block_capacity_failed: Arc<AtomicBool>,
    pending_audio_msgs: Vec<AudioThreadMessage>,
    frames_processed: Arc<AtomicU64>, // Diagnostic

    // Active Audio Config
    current_sample_rate: f64,
    current_block_size: usize,
    fixed_buffer_request_frames: Option<u32>,
    // bundle保存用の最後に成功した要求。None=未取得、Some(None)=Default。
    bundle_last_fixed_buffer_request: Option<Option<u32>>,
    session_rack_revision: u64,
    // デバイスの設定値とは別に、全VSTとcallbackで共有する確保済み処理容量。
    processing_block_capacity: usize,
    current_channels: usize,
    current_input_channels: usize,
    current_host_is_asio: bool,
    callback_diagnostics: Arc<CallbackDiagnostics>,
    queue_diagnostics: Option<Arc<QueueDiagnostics>>,
    queue_observer: Option<Arc<HeapRb<f32>>>,
    queue_state: QueueState,
    queue_slots_at_stop: Option<usize>,
    queue_attempt: u64,
    frame_timing: Option<super::frame_timing::Observer>,

    // Channel Mapping (Runtime)
    input_channel_l: usize,
    input_channel_r: usize,
    output_routing: crate::ipc::OutputRouting,
    start_routing: Option<crate::ipc::ChannelRouting>,
    scan_enabled: bool,
    scan_generation: u64,
    scan_control: Arc<super::channel_scan::Control>,
    global_bypass: bool,
    global_mute: bool,
    noise_reduction_enabled: bool,
    noise_control_mode: NoiseControlMode,
    noise_control_strength: f32,
    noise_voice_guard: bool,
    noise_learning: Arc<NoiseLearningShared>,
    input_learning: std::collections::BTreeMap<String, Arc<NoiseLearningShared>>,
    noise_measurement: noise_learning::Controller,
    noise_undo: Option<noise_comparison::Undo>,
    noise_history_reason: super::history::Reason,
    noise_command_revision: u64,
    noise_applied_revision: Arc<AtomicU64>,
    noise_input_identity: Option<String>,
    noise_input_revision: u64,
    built_in_effects_enabled: bool,
    built_in_effects_preset: BuiltInEffectsPreset,
    built_in_effects_amount: f32,

    voice_check: Arc<VoiceCheckShared>,
    voice_check_buffers: super::voice_check::VoiceCheckBufferStore,
    voice_preview: voice_preview::Controller,
    voice_metadata: Option<voice_preview::Metadata>,
    voice_recording_id: u64,
    voice_revision: u64,
    comparison_revision: u64,
    preparation_routing_revision: u64,
    voice_input_gain: f32,

    // Diagnostics
    stats_max_jitter: Arc<AtomicU64>,
    stats_glitches: Arc<AtomicU64>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        Self {
            builtin: super::builtin::Controller::new(),
            live_modes: super::live_modes::Controller::new(),
            pending_restore: None,
            live_output: None,
            live_output_config: super::live_output::Config::default(),
            live_output_error: None,
            monitor_levels: Arc::new(AtomicU64::new(1.0f32.to_bits() as u64)),
            split_monitor: None,
            restored_monitor: None,
            split_worker: None,
            mode_silence: Default::default(),
            input_stream: None,
            input_source: None,
            process_shared: None,
            mixing_start: None,
            mixing_revision: 0,
            mixing_shared: None,
            mixing_source: None,
            mixing_input_shared: None,
            mixing_worker_owner: None,
            mixing_source_failure_reported: false,
            mixing_output_failure_reported: false,
            process_renderer_owner: None,
            gain_shared: Arc::new(auto_gain::Shared::default()),
            gain_capture_rx: None,
            gain_revision: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            peak_config: Default::default(),
            peak_shared: Default::default(),
            output_gain: 1.0,
            output_gain_revision: 0,
            output_gain_initialized: false,
            gain_session: None,
            gain_history: None,
            gain_history_reason: Default::default(),
            gain_preview: None,
            gain_main_device: None,
            stream_failed: Arc::new(AtomicBool::new(false)),
            output_stream: None,
            post_role: false,
            processing_restart_revision: crate::vst_host::instance::processing_restart_revision(),
            last_processing_preparation: "none",
            post_worker: None,
            post_mapping: None,
            post_renderer_owner: None,
            device_manager: DeviceManager::new(),
            editor_manager: EditorManager::new(),
            plugin_manager: PluginManager::new(),
            command_tx: None,
            level_rx: None,
            loudness_rx: None,
            channel_rx: None,
            retire_rx: None,
            processor_return: None,
            resampling_failed: Arc::new(AtomicBool::new(false)),
            nr_failed: Arc::new(AtomicBool::new(false)),
            block_capacity_failed: Arc::new(AtomicBool::new(false)),
            pending_audio_msgs: Vec::new(),
            frames_processed: Arc::new(AtomicU64::new(0)),
            current_sample_rate: 0.0,
            current_block_size: 0,
            fixed_buffer_request_frames: None,
            bundle_last_fixed_buffer_request: None,
            session_rack_revision: 0,
            processing_block_capacity: 0,
            current_channels: 2,
            current_input_channels: 2,
            current_host_is_asio: false,
            callback_diagnostics: Arc::new(CallbackDiagnostics::default()),
            queue_diagnostics: None,
            queue_observer: None,
            queue_state: QueueState::Preparing,
            queue_slots_at_stop: None,
            queue_attempt: 0,
            frame_timing: None,
            input_channel_l: 0,
            input_channel_r: 1,
            output_routing: crate::ipc::OutputRouting::Legacy,
            start_routing: None,
            scan_enabled: false,
            scan_generation: 0,
            scan_control: Arc::new(super::channel_scan::Control::new(false, 0, 1.0)),
            global_bypass: false,
            global_mute: false,
            noise_reduction_enabled: false,
            noise_control_mode: NoiseControlMode::Low,
            noise_control_strength: 1.0,
            noise_voice_guard: true,
            noise_learning: Arc::new(NoiseLearningShared::new()),
            input_learning: Default::default(),
            noise_measurement: noise_learning::Controller::default(),
            noise_undo: None,
            noise_history_reason: Default::default(),
            noise_command_revision: 0,
            noise_applied_revision: Arc::new(AtomicU64::new(0)),
            noise_input_identity: None,
            noise_input_revision: 0,
            built_in_effects_enabled: false,
            built_in_effects_preset: BuiltInEffectsPreset::Broadcast,
            built_in_effects_amount: 0.7,
            voice_check: Arc::new(VoiceCheckShared::new()),
            voice_check_buffers: super::voice_check::VoiceCheckBufferStore::default(),
            voice_preview: voice_preview::Controller::new(),
            voice_metadata: None,
            voice_recording_id: 0,
            voice_revision: 0,
            comparison_revision: 0,
            preparation_routing_revision: 0,
            voice_input_gain: 1.0,
            stats_max_jitter: Arc::new(AtomicU64::new(0)),
            stats_glitches: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn run_loop(mut self) {
        // Create Event Loop
        let event_loop = EventLoopBuilder::<UserEvent>::with_user_event()
            .build()
            .unwrap();
        let proxy = event_loop.create_proxy();

        // Spawn stdin reader thread
        thread::spawn(move || {
            let stdin = io::stdin();
            let mut handle = stdin.lock();
            let mut line = String::new();

            loop {
                line.clear();
                match handle.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let trim = line.trim();
                        if trim.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Command>(trim) {
                            Ok(cmd) => {
                                if proxy.send_event(UserEvent::Command(cmd)).is_err() {
                                    break; // Loop closed
                                }
                            }
                            Err(e) => log::error!("JSON Parse Error: {}", e),
                        }
                    }
                    Err(_) => break,
                }
            }
            // Hostがpipeを閉じた後も常駐しない。音声・GUIの破棄は制御スレッドで行う。
            let _ = proxy.send_event(UserEvent::Shutdown);
        });

        // Log startup
        self.send_event(EngineEvent::Log("Audio Engine Started".to_string()));

        let mut last_meter_time = Instant::now();
        let meter_interval = Duration::from_millis(16); // ~60 FPS
        let mut last_voice_check_time = Instant::now();
        let voice_check_interval = Duration::from_millis(100);
        let mut last_voice_check_state = VC_STATE_IDLE;

        let mut current_in_l = 0.0f32;
        let mut current_in_r = 0.0f32;
        let mut current_out_l = 0.0f32;
        let mut current_out_r = 0.0f32;

        let mut updates_received = 0;
        let mut last_data_time = Instant::now();
        let mut last_heartbeat = Instant::now();
        let mut last_meter_was_zero = false;
        let mut last_channel_scan_was_zero = false;
        let mut last_channel_scan_generation = self.scan_generation;

        // Run Event Loop
        let _ = event_loop.run(move |event, target| {
            self.poll_live_modes();
            // Use WaitUntil to prevent CPU spinning
            target.set_control_flow(ControlFlow::WaitUntil(
                Instant::now() + Duration::from_millis(8),
            ));

            match event {
                Event::UserEvent(UserEvent::Command(cmd)) => {
                    self.handle_command(cmd, target);
                }
                Event::UserEvent(UserEvent::Shutdown) => {
                    self.stop_audio();
                    target.exit();
                }
                Event::UserEvent(UserEvent::Timer) => {}
                Event::AboutToWait => {
                    if let Some(timing) = &mut self.frame_timing { timing.drain(); }
                    self.voice_preview.poll(self.processing_running() && !self.stream_failed.load(Ordering::Acquire));
                    if self.processing_running() && !self.stream_failed.load(Ordering::Acquire) {
                        if !self.mixing_source_failure_reported && self.mixing_input_shared.as_ref().is_some_and(|source| source.failed.load(Ordering::Acquire)) {
                            self.mixing_source_failure_reported = true;
                            self.builtin.invalidate_history();
                            self.preparation_routing_revision = self.preparation_routing_revision.saturating_add(1);
                            self.send_event(EngineEvent::MixingSourceFailed);
                        }
                        if self.mixing_start.is_some() && !self.mixing_output_failure_reported
                            && (self.mixing_shared.as_ref().is_some_and(|shared| shared.failed.load(Ordering::Acquire))
                                || self.split_monitor.as_ref().is_some_and(|monitor| monitor.shared.failed.load(Ordering::Acquire))
                                || self.live_output.as_ref().is_some_and(|sink| sink.snapshot().failed)) {
                            self.mixing_output_failure_reported = true;
                            if let Some(sink) = &self.live_output { sink.deactivate(); }
                            self.builtin.invalidate_history();
                            self.preparation_routing_revision = self.preparation_routing_revision.saturating_add(1);
                            self.send_event(EngineEvent::MixingOutputFailed);
                        }
                    }
                    // RT側は固定サイズの通知だけを行い、停止と文言生成は制御側で行う。
                    let resampling_failed = self.resampling_failed.swap(false, Ordering::AcqRel);
                    let block_capacity_failed = self.block_capacity_failed.swap(false, Ordering::AcqRel);
                    let nr_failed = self.nr_failed.swap(false, Ordering::AcqRel);
                    if let Some(message) = self.input_stream.as_ref().and_then(input::InputStream::failure_message) {
                        self.stop_audio();
                        self.send_event(EngineEvent::Error(message.into()));
                    }
                    if resampling_failed || block_capacity_failed || nr_failed {
                        self.stop_audio();
                        let reason = match (resampling_failed, block_capacity_failed) {
                            (true, true) => "レート変換に失敗し、デバイスから受け取った音声ブロックも処理容量を超えたため音声を停止しました。",
                            (_, true) => "デバイスから受け取った音声ブロックが処理容量を超えたため音声を停止しました。バッファサイズを指定して再開してください。",
                            _ => "レート変換に失敗したため音声を停止しました。設定を確認して再開してください。",
                        };
                        let reason = if nr_failed { "ノイズ低減のレート準備と適用が一致しないため音声を停止しました。" } else { reason };
                        self.send_event(EngineEvent::Error(format!("Stream Error: {}", reason)));
                    }
                    self.voice_check_buffers.collect();
                    self.flush_pending_audio_msgs();
                    self.poll_auto_gain();
                    self.poll_noise_measurement();
                    self.poll_processing_restart();

                    // Retire processors off the audio callback thread (safe place to drop VST objects)
                    if let Some(retire_cons) = &mut self.retire_rx {
                        while let Some(disposed) = retire_cons.try_pop() {
                            match disposed {
                                DisposedProcessor::Retired(retired) => {
                                    drop(retired.processor);
                                    self.plugin_manager.on_processor_retired(retired.index);
                                }
                                DisposedProcessor::Rejected(processor) => drop(processor),
                            }
                        }
                    }

                    if let Some(staged) = self.pending_restore.take() {
                        self.finish_plugin_restore(staged);
                    }
                    // 旧LoadPluginも同じSTAの次turnで接続するが、失敗したprocessorは公開しない。
                    let pending_ids = std::mem::take(&mut self.plugin_manager.pending_init);
                    for id in pending_ids {
                        let (sr, bs, ch) = self.processor_setup();
                        let running = self.processing_running();
                        let result = (|| -> Result<Option<VstProcessor>> {
                            let instance = self.plugin_manager.get_mut(&id).ok_or_else(|| anyhow!("VSTが見つかりません"))?;
                            if running { instance.prepare_processing(sr, bs as i32, ch as i32)?; }
                            instance.finalize_connection()?;
                            if running { Ok(Some(instance.create_processor().ok_or_else(|| anyhow!("VST processorを作成できません"))?)) } else { Ok(None) }
                        })();
                        match result {
                            Ok(Some(processor)) => {
                                if let Some(index) = self.plugin_manager.rt_index_of(&id) {
                                    self.queue_add_processor(
                                        index,
                                        processor,
                                        *self.plugin_manager.gains.get(&id).unwrap_or(&1.0),
                                        self.plugin_manager.bypassed.contains(&id),
                                        self.plugin_manager.muted.contains(&id),
                                    );
                                    self.queue_audio_msg(self.make_reorder_message());
                                }
                                self.acknowledge_processing_preparation();
                            }
                            Ok(None) => { self.acknowledge_processing_preparation(); },
                            Err(error) => {
                                self.stop_audio();
                                self.send_event(EngineEvent::Error(format!("VST {id} の遅延初期化に失敗したため音声を停止しました: {error}")));
                            }
                        }
                    }
                    // -------------------------------------------

                    // Heartbeat (1s) & Diagnostics
                    if last_heartbeat.elapsed() >= Duration::from_secs(1) {
                        let _max_jitter = self.stats_max_jitter.load(Ordering::Relaxed);
                        let _glitches = self.stats_glitches.load(Ordering::Relaxed);
                        let _frames = self.frames_processed.load(Ordering::Relaxed);

                        // Check Priority Class
                        // SAFETY: 現プロセスの疑似ハンドルを取得し、優先度の読み取りにだけ使う。
                        unsafe {
                            use windows::Win32::System::Threading::{
                                GetCurrentProcess, GetPriorityClass,
                            };
                            let _prio_class = GetPriorityClass(GetCurrentProcess());
                        }
                        last_heartbeat = Instant::now();
                    }

                    // Meter Processing
                    let mut meter_event_to_send = None;
                    if let Some(consumer) = &mut self.level_rx {
                        while let Some(levels) = consumer.try_pop() {
                            updates_received += 1;
                            last_data_time = Instant::now();
                            if levels.input[0] > current_in_l {
                                current_in_l = levels.input[0];
                            }
                            if levels.input[1] > current_in_r {
                                current_in_r = levels.input[1];
                            }
                            if levels.output[0] > current_out_l {
                                current_out_l = levels.output[0];
                            }
                            if levels.output[1] > current_out_r {
                                current_out_r = levels.output[1];
                            }
                        }

                        if last_meter_time.elapsed() >= meter_interval {
                            let time_since_data = last_data_time.elapsed();

                            if updates_received > 0 {
                                let safe_in_l = current_in_l.clamp(0.0, 10.0);
                                let safe_in_r = current_in_r.clamp(0.0, 10.0);
                                let safe_out_l = current_out_l.clamp(0.0, 10.0);
                                let safe_out_r = current_out_r.clamp(0.0, 10.0);

                                let is_zero = safe_in_l == 0.0
                                    && safe_in_r == 0.0
                                    && safe_out_l == 0.0
                                    && safe_out_r == 0.0;
                                if !is_zero || !last_meter_was_zero {
                                    meter_event_to_send =
                                        Some(EngineEvent::LevelMeter(MeterLevels {
                                            input: [safe_in_l, safe_in_r],
                                            output: [safe_out_l, safe_out_r],
                                        }));
                                }

                                current_in_l = 0.0;
                                current_in_r = 0.0;
                                current_out_l = 0.0;
                                current_out_r = 0.0;
                                updates_received = 0;
                                last_meter_time = Instant::now();
                                last_meter_was_zero = is_zero;
                            } else if time_since_data > Duration::from_millis(75) {
                                if !last_meter_was_zero {
                                    meter_event_to_send =
                                        Some(EngineEvent::LevelMeter(MeterLevels {
                                            input: [0.0, 0.0],
                                            output: [0.0, 0.0],
                                        }));
                                    last_meter_was_zero = true;
                                }
                                last_meter_time = Instant::now();
                            }
                        }
                    }
                    if let Some(evt) = meter_event_to_send {
                        self.send_event(evt);
                    }

                    let mut loudness = None;
                    if let Some(rx) = &mut self.loudness_rx {
                        while let Some(reading) = rx.try_pop() {
                            loudness = Some(reading);
                        }
                    }
                    if let Some(reading) = loudness {
                        self.send_event(EngineEvent::Loudness(reading));
                    }

                    // 排出したスナップショットの最大値を統合し、IPC 用に一度だけ変換する。
                    let mut channel_scan_to_send = None;
                    if let Some(chan_cons) = &mut self.channel_rx {
                        while let Some(snapshot) = chan_cons.try_pop() {
                            super::channel_scan::merge(
                                &mut channel_scan_to_send, snapshot, self.scan_generation, self.scan_enabled,
                            );
                        }
                    }
                    if let Some(scan_data) = channel_scan_to_send {
                        if last_channel_scan_generation != self.scan_generation {
                            last_channel_scan_generation = self.scan_generation;
                            last_channel_scan_was_zero = false;
                        }
                        let is_zero = scan_data.iter().all(|v| *v == 0.0);
                        if !is_zero || !last_channel_scan_was_zero {
                            self.send_event(EngineEvent::ChannelLevels(scan_data.to_vec()));
                        }
                        last_channel_scan_was_zero = is_zero;
                    }

                    // Voice Check 状態イベント
                    // recording/playing 中は定期送信、それ以外は状態遷移時に 1 回だけ送る
                    let vc_state = self.voice_check.state.load(Ordering::Relaxed);
                    let vc_active = vc_state == VC_STATE_RECORDING
                        || vc_state == super::voice_check::VC_STATE_PLAYING;
                    let vc_transitioned = vc_state != last_voice_check_state;
                    if (vc_active && last_voice_check_time.elapsed() >= voice_check_interval)
                        || vc_transitioned
                    {
                        self.send_event(EngineEvent::VoiceCheckState {
                            state: self.voice_check.state_label().to_string(),
                            position_ms: self.voice_check.position_ms(),
                            duration_ms: self.voice_check.duration_ms(),
                        });
                        last_voice_check_time = Instant::now();
                        last_voice_check_state = vc_state;
                    }

                    // バッファ自体の封印を確認してから読む。共有の表示状態を読取権限に使わない。
                    if self
                        .voice_check
                        .envelope_dirty
                        .swap(false, Ordering::Relaxed)
                    {
                        if let Some(recording) = self
                            .voice_check_buffers
                            .current()
                            .and_then(|b| b.recording())
                        {
                            if recording.frames > 0 {
                                let raw_peaks = compute_peak_envelope(
                                    recording.raw,
                                    recording.frames,
                                    VOICE_CHECK_ENVELOPE_BUCKETS,
                                );
                                let processed_peaks = compute_peak_envelope(
                                    recording.processed,
                                    recording.frames,
                                    VOICE_CHECK_ENVELOPE_BUCKETS,
                                );
                                self.send_event(EngineEvent::VoiceCheckEnvelope {
                                    raw_peaks,
                                    processed_peaks,
                                });
                            }
                        }
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::Resized(size),
                    window_id,
                } => {
                    // Identify plugin first
                    let plugin_id_opt = self.editor_manager.get_plugin_id(window_id);

                    // Resize container window
                    self.editor_manager.handle_resized(window_id, size);

                    // If it is a plugin window, notify the plugin instance
                    if let Some(pid) = plugin_id_opt {
                        if let Some(instance) = self.plugin_manager.get_mut(&pid) {
                            if let Err(e) = instance.on_window_resized(size.width, size.height) {
                                log::error!("Error resizing plugin {}: {}", pid, e);
                            }
                        }
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    window_id,
                } => {
                    // 親 HWND が有効な間に IPlugView::removed を呼ぶ。
                    if let Some(plugin_id) = self.editor_manager.get_plugin_id(window_id) {
                        if let Some(instance) = self.plugin_manager.get_mut(&plugin_id) {
                            instance.close_editor();
                        }
                        self.editor_manager.handle_close_requested(window_id);
                    }
                }
                _ => {}
            }
        });
    }

    fn send_response(&self, resp: Response) {
        let msg = OutputMessage::Response(resp);
        match serde_json::to_string(&msg) {
            Ok(json) => {
                println!("IPC:{}", json);
                let _ = io::stdout().flush();
            }
            Err(e) => log::error!("JSON Serialize Error (Response): {}", e),
        }
    }

    fn send_event(&self, evt: EngineEvent) {
        let msg = OutputMessage::Event(evt);
        match serde_json::to_string(&msg) {
            Ok(json) => {
                println!("IPC:{}", json);
                let _ = io::stdout().flush();
            }
            Err(e) => log::error!("JSON Serialize Error (Event): {}", e),
        }
    }

    fn send_error(&self, msg: String) {
        self.send_response(Response::Error(msg));
    }

    fn voice_preview_context(&self) -> voice_preview::Context {
        let auto_gain_active = self.gain_preview.is_some()
            || self.gain_shared.active.load(Ordering::Acquire) != 0
            || self.gain_shared.requested.load(Ordering::Acquire) != 0;
        let builtin = self.builtin.snapshot(self.processing_running());
        let noise = self.noise_candidate_settings();
        let noise_basis = self.noise_candidate_basis(&noise);
        voice_preview::Context {
            noise,
            noise_basis,
            noise_undo_token: self.noise_undo_token(),
            noise_redo_token: self.noise_redo_token(),
            noise_history_reason: self.noise_history_reason(),
            noise_pending: self.noise_applied_revision.load(Ordering::Acquire)
                != self.noise_command_revision
                || !self.pending_audio_msgs.is_empty()
                || self.command_tx.as_ref().is_some_and(|q| !q.is_empty()),
            builtin_revision: builtin.revision,
            builtin_epoch: builtin.epoch,
            builtin_config: builtin.config,
            builtin_pending: builtin.pending,
            buffers: self.voice_check_buffers.current().cloned(),
            metadata: self.voice_metadata.clone(),
            main_device: self.gain_main_device.clone(),
            main_running: self.processing_running() && !self.stream_failed.load(Ordering::Acquire),
            busy: auto_gain_active || self.voice_check.transport_busy(),
            auto_gain_active,
            current_revision: self.voice_revision,
        }
    }

    fn builtin_command(
        &mut self,
        request: super::builtin::Request,
    ) -> Result<super::builtin::Snapshot, String> {
        use super::builtin::Request;
        let failed = self.processing_running() && self.stream_failed.load(Ordering::Acquire);
        if failed {
            self.builtin
                .invalidate_history_with_reason(super::history::Reason::StreamFailed);
            if !matches!(request, Request::Snapshot) {
                return Err("音声処理が停止したため設定を確認してください".into());
            }
        }
        let request = match request {
            Request::ApplyProposal {
                epoch,
                expected_revision,
                proposal_id,
                recording_id,
            } => {
                if epoch.is_empty()
                    || epoch.len() > 128
                    || expected_revision.is_empty()
                    || expected_revision.len() > 32
                    || !expected_revision.bytes().all(|v| v.is_ascii_digit())
                    || !(1..=9_007_199_254_740_991).contains(&recording_id)
                {
                    return Err("提案の識別情報が不正です".into());
                }
                let context = self.voice_preview_context();
                // この照合からCASまでは同じ制御dispatch。await/別commandの割込みはない。
                let config = self
                    .voice_preview
                    .proposal_config(
                        &proposal_id,
                        recording_id,
                        &epoch,
                        &expected_revision,
                        &context,
                    )
                    .map_err(|e| e.to_string())?;
                Request::Apply {
                    epoch,
                    expected_revision,
                    config,
                }
            }
            other => other,
        };
        if self.builtin.request(request, self.processing_running())? {
            self.live_modes.custom();
            self.voice_revision = self.voice_revision.saturating_add(1);
            self.publish_builtin();
        }
        let mut snapshot = self.builtin.snapshot(self.processing_running());
        if failed {
            snapshot.error = Some("音声処理が停止しました".into());
        }
        Ok(snapshot)
    }

    fn preparation_snapshot(&self) -> crate::ipc::PreparationSnapshot {
        crate::ipc::PreparationSnapshot {
            engine_epoch: self.builtin.snapshot(false).epoch,
            processing_revision: self.voice_revision.to_string(),
            routing_revision: self.preparation_routing_revision.to_string(),
            input_gain: self.voice_input_gain,
            input_channels: [self.input_channel_l, self.input_channel_r],
            output_routing: self.output_routing,
            output_gain: self.output_gain,
            output_revision: self.output_gain_revision.to_string(),
            muted: self.global_mute,
            controls_pending: !self.pending_audio_msgs.is_empty()
                || self.command_tx.as_ref().is_some_and(|q| !q.is_empty())
                || !self.gain_shared.settled.load(Ordering::Acquire)
                || (self.processing_running()
                    && self.peak_shared.pending(
                        self.live_output_config.split_processing,
                        self.live_output.is_some(),
                    )),
            nr_backend: "nnnoiseless-0.5.2".into(),
            nr_model: "bundled-e6de5fbfadf7ec91".into(),
        }
    }

    fn probe_loopback(
        &mut self,
        input_device: &str,
        duration_ms: u32,
        freq_hz: f32,
    ) -> LoopbackProbeOutcome {
        if !self.processing_running() {
            return LoopbackProbeOutcome {
                detected: false,
                level_db: -120.0,
                unavailable: Some("オーディオエンジンが起動していません".to_string()),
            };
        }

        let host_name = self
            .device_manager
            .active_output
            .as_ref()
            .map(|d| d.host.as_str())
            .unwrap_or("");
        if host_name.eq_ignore_ascii_case("asio") {
            return LoopbackProbeOutcome {
                detected: false,
                level_db: -120.0,
                unavailable: Some(
                    "ASIO 排他モードではループバックプローブを実行できません。手動で CABLE Output を確認してください"
                        .to_string(),
                ),
            };
        }

        let tone_ms = duration_ms.saturating_add(200).min(5000);
        self.queue_audio_msg(AudioThreadMessage::StopVoiceCheckPlayback);
        self.queue_audio_msg(AudioThreadMessage::PlayTestTone {
            freq_hz,
            duration_ms: tone_ms,
            level_db: super::test_tone::TEST_TONE_DEFAULT_DBFS,
        });
        self.flush_pending_audio_msgs();
        std::thread::sleep(Duration::from_millis(80));

        let capture_result = capture_input_mono(input_device, duration_ms);
        self.queue_audio_msg(AudioThreadMessage::StopTestTone);
        self.flush_pending_audio_msgs();

        match capture_result {
            Ok((samples, sample_rate)) => {
                let (detected, level_db) = analyze_loopback(&samples, sample_rate, freq_hz);
                LoopbackProbeOutcome {
                    detected,
                    level_db,
                    unavailable: None,
                }
            }
            Err(e) => LoopbackProbeOutcome {
                detected: false,
                level_db: -120.0,
                unavailable: Some(format!(
                    "{}。手動で CABLE Output にテスト音が届いているか確認してください",
                    e
                )),
            },
        }
    }

    fn make_reorder_message(&self) -> AudioThreadMessage {
        let mut order: [u8; MAX_PLUGINS] = [u8::MAX; MAX_PLUGINS];
        let mut len: u8 = 0;

        for id in &self.plugin_manager.order {
            if (len as usize) >= MAX_PLUGINS {
                break;
            }
            if let Some(idx) = self.plugin_manager.rt_index_of(id) {
                order[len as usize] = idx;
                len += 1;
            }
        }

        AudioThreadMessage::ReorderProcessors { order, len }
    }

    fn queue_add_processor(
        &mut self,
        index: u8,
        processor: VstProcessor,
        initial_gain: f32,
        initial_bypassed: bool,
        initial_muted: bool,
    ) {
        let health_token = self.plugin_manager.mint_health_token(index);
        let latency = self.plugin_manager.latency_samples_at(index);
        self.queue_audio_msg(AudioThreadMessage::AddProcessor {
            index,
            processor,
            initial_gain,
            initial_bypassed,
            initial_muted,
            health_token,
            latency,
        });
    }

    fn set_channel_scan(&mut self, active: bool) {
        self.scan_enabled = active;
        self.scan_generation = self.scan_generation.wrapping_add(1) & (u64::MAX >> 1);
        self.scan_control.set_enabled(active, self.scan_generation);
    }

    fn prepare_channel_scan(&mut self, input_rate: u32) -> super::channel_scan::ChannelScan {
        self.scan_generation = self.scan_generation.wrapping_add(1) & (u64::MAX >> 1);
        self.scan_control
            .set_enabled(self.scan_enabled, self.scan_generation);
        self.scan_control.set_gain(self.voice_input_gain);
        super::channel_scan::ChannelScan::new(input_rate, self.scan_enabled, self.scan_generation)
    }

    fn queue_audio_msg(&mut self, msg: AudioThreadMessage) {
        self.comparison_revision = self.comparison_revision.saturating_add(1);
        let measurement = if let Some(monitor) = &mut self.split_monitor {
            monitor.message(&msg);
            matches!(
                &msg,
                AudioThreadMessage::StartVoiceCheckRecording { .. }
                    | AudioThreadMessage::StartAutoGainCapture(_)
                    | AudioThreadMessage::SetLoudnessMeasurement(Some(_))
            )
            .then(|| monitor.shared.measurement_ticket())
        } else {
            None
        };
        // 要求だけでは新CDFへ移らない。実mutation直後のmarkerを同じFIFOへ置く。
        let cohort_revision = msg
            .changes_cohort()
            .then(|| {
                self.frame_timing
                    .as_ref()
                    .and_then(|t| t.request_cohort_window())
            })
            .flatten();
        let revision = matches!(
            &msg,
            AudioThreadMessage::StartVoiceCheckRecording { .. }
                | AudioThreadMessage::StopVoiceCheckRecording
                | AudioThreadMessage::PlayVoiceCheck { .. }
                | AudioThreadMessage::StopVoiceCheckPlayback
        )
        .then(|| self.voice_check.reserve_transport());
        self.push_audio_msg(msg);
        if let Some(ticket) = measurement {
            self.push_audio_msg(AudioThreadMessage::MeasurementReservation(ticket));
        }
        if let Some(revision) = cohort_revision {
            self.push_audio_msg(AudioThreadMessage::CohortWindow { revision });
        }
        if let Some(revision) = revision {
            self.push_audio_msg(AudioThreadMessage::VoiceCheckTransportAck(revision));
        }
    }

    fn push_audio_msg(&mut self, msg: AudioThreadMessage) {
        if let AudioThreadMessage::CohortWindow { revision } = &msg {
            if let Some(monitor) = &mut self.split_monitor {
                monitor.window(*revision);
            }
        }
        if !self.pending_audio_msgs.is_empty() {
            self.pending_audio_msgs.push(msg);
            return;
        }
        if let Some(tx) = &mut self.command_tx {
            match tx.try_push(msg) {
                Ok(()) => return,
                Err(msg) => {
                    self.pending_audio_msgs.push(msg);
                    return;
                }
            }
        }
        self.pending_audio_msgs.push(msg);
    }

    fn flush_pending_audio_msgs(&mut self) {
        if self.pending_audio_msgs.is_empty() {
            return;
        }
        let Some(tx) = &mut self.command_tx else {
            return;
        };

        let pending = std::mem::take(&mut self.pending_audio_msgs);
        let mut iter = pending.into_iter();
        while let Some(msg) = iter.next() {
            match tx.try_push(msg) {
                Ok(()) => {}
                Err(msg) => {
                    self.pending_audio_msgs.push(msg);
                    self.pending_audio_msgs.extend(iter);
                    break;
                }
            }
        }
    }

    #[allow(deprecated)]
    pub fn start_audio(
        &mut self,
        host_name: Option<String>,
        input_device: Option<String>,
        output_device: Option<String>,
        sample_rate: Option<u32>,
        buffer_size: Option<u32>,
    ) -> Result<()> {
        self.start_audio_with_ids(
            host_name,
            input_device,
            output_device,
            sample_rate,
            buffer_size,
            (None, None),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn start_audio_with_ids(
        &mut self,
        host_name: Option<String>,
        input_device: Option<String>,
        output_device: Option<String>,
        sample_rate: Option<u32>,
        buffer_size: Option<u32>,
        device_ids: (Option<String>, Option<String>),
    ) -> Result<()> {
        self.start_audio_impl(
            AudioStartRequest {
                input_source: None,
                host_name,
                input_name: input_device,
                output_name: output_device,
                sample_rate,
                buffer_size,
                device_ids,
            },
            lifecycle::StartupPolicy::default(),
        )
    }

    #[allow(deprecated)]
    fn start_audio_impl(
        &mut self,
        request: AudioStartRequest,
        policy: lifecycle::StartupPolicy,
    ) -> Result<()> {
        let result = self.start_audio_attempt(request, policy);
        // ローカルstreamとcallbackが破棄されてから、共有キューと所有値を回収する。
        if result.is_err() {
            self.clear_audio_resources();
            self.send_event(EngineEvent::Stopped);
        }
        result
    }

    fn configure_processing_capacity(
        &mut self,
        fixed: Option<u32>,
        default_max: Option<u32>,
    ) -> Result<()> {
        self.processing_block_capacity = lifecycle::block_capacity(fixed, default_max)?;
        Ok(())
    }

    // 起動時・稼働中の追加・遅延初期化で同じ容量を渡す。
    fn processor_setup(&self) -> (f64, usize, usize) {
        (
            self.current_sample_rate,
            self.processing_block_capacity,
            self.current_channels,
        )
    }

    fn stop_audio(&mut self) {
        self.clear_audio_resources();
        self.send_event(EngineEvent::Stopped);
    }

    fn set_global_mute_intent(&mut self, active: bool) {
        self.global_mute = active;
        if let Some(sink) = &self.live_output {
            sink.mute(active);
        }
        if self.processing_running() {
            self.queue_audio_msg(AudioThreadMessage::SetGlobalMute(active));
        }
    }

    fn queue_snapshot(&self) -> Option<QueueSnapshot> {
        if self.process_shared.is_some() {
            return None;
        }
        self.queue_diagnostics.as_ref().map(|diagnostics| {
            diagnostics.snapshot(
                self.queue_state,
                self.queue_observer
                    .as_ref()
                    .map(|queue| queue.occupied_len()),
                self.queue_slots_at_stop,
            )
        })
    }

    // 実稼働rateは呼出側のstream境界から渡す。停止中は意図だけ保持し、旧queueを再生しない。
    fn apply_noise_intent(
        &mut self,
        active: bool,
        mode: NoiseControlMode,
        strength: f32,
        voice_guard: bool,
        running_rate: Option<u32>,
    ) -> Result<(), &'static str> {
        if !strength.is_finite() {
            return Err("ノイズ低減の抑制強度が不正です");
        }
        if let Some(rate) = running_rate {
            dsp::NoiseGeometry::guard(rate, active)?;
        }
        self.noise_control_mode = mode;
        self.noise_control_strength = strength.clamp(0.25, 1.25);
        self.noise_voice_guard = voice_guard;
        self.noise_reduction_enabled = active;
        if running_rate.is_some() {
            self.noise_command_revision = self.noise_command_revision.saturating_add(1);
            self.queue_audio_msg(AudioThreadMessage::SetNoiseControl {
                revision: self.noise_command_revision,
                active,
                mode,
                strength: self.noise_control_strength,
                voice_guard,
            });
        }
        Ok(())
    }

    fn latency_metadata(
        &self,
        report: (u32, Option<u32>, bool, Vec<crate::ipc::VstLatencyStage>),
    ) -> crate::ipc::LatencyMetadata {
        let nr_enabled = self.noise_reduction_enabled
            && self
                .input_source
                .as_ref()
                .is_none_or(|s| s.source.purpose() != crate::input_source::Purpose::Music);
        let nominal = (self.current_sample_rate.is_finite() && self.current_sample_rate > 0.0)
            .then(|| self.current_sample_rate.round() as u32);
        // NR生成時と同じ設定rate。1フレームの長さであり、各sampleの待ち時間ではない。
        let geometry = nominal.and_then(dsp::NoiseGeometry::checked);
        let nr_rate = geometry.map(|g| g.rate);
        let current = self.processing_running()
            && !self.stream_failed.load(Ordering::Acquire)
            && !self.nr_failed.load(Ordering::Acquire)
            && !self.resampling_failed.load(Ordering::Acquire)
            && !self.block_capacity_failed.load(Ordering::Acquire)
            && !self
                .split_monitor
                .as_ref()
                .is_some_and(|s| s.shared.failed.load(Ordering::Acquire));
        let (vst_reported_latency_samples, known_subtotal, overflow, mut vst) = report;
        if !current {
            for stage in &mut vst {
                stage.state = "unavailable".into();
                stage.declared_samples = None;
            }
        }
        let stages = crate::ipc::LatencyStages {
            schema_version: 1,
            query_basis: "queriedAtRuntimeStats".into(),
            current,
            stream_epoch: if self.live_output_config.split_processing {
                Some(format!(
                    "{}:queue:{}",
                    self.builtin.snapshot(false).epoch,
                    self.queue_attempt
                ))
            } else {
                self.queue_snapshot().map(|q| q.epoch)
            },
            global_bypass: self.global_bypass,
            vst,
            vst_known_subtotal_samples: current.then_some(known_subtotal).flatten(),
            vst_subtotal_overflow: current && overflow,
            nr: crate::ipc::NrLatencyStage {
                enabled: nr_enabled,
                configured_rate_hz: current.then_some(nr_rate).flatten(),
                frame_samples: current.then(|| geometry.map(|g| g.frames as u32)).flatten(),
                frame_period_ms: if current {
                    geometry.map(|g| g.frames as f64 * 1000.0 / f64::from(g.rate))
                } else {
                    None
                },
                model_rate_hz: 48_000,
                model_frame_samples: 480,
                signal_delay: "unknown".into(),
            },
            builtin_voice_enabled: self.builtin.config.active,
            builtin_reverb_enabled: self.builtin.config.reverb.unwrap_or_default().enabled,
            builtin_signal_delay: "unknown".into(),
        };
        crate::ipc::LatencyMetadata {
            broadcast_state: self.live_output_config.device_id.as_ref().map(|_| {
                if !self.processing_running() || self.stream_failed.load(Ordering::Acquire) {
                    "stopped"
                } else if self.live_output.as_ref().is_none_or(|s| {
                    let status = s.snapshot();
                    status.failed || !status.active
                }) || self
                    .split_monitor
                    .as_ref()
                    .is_some_and(|m| m.shared.failed.load(Ordering::Acquire))
                {
                    "failed"
                } else {
                    "running"
                }
                .into()
            }),
            processing_context: Some(
                if self.live_output_config.split_processing {
                    "broadcastWorker"
                } else {
                    "singleOutput"
                }
                .into(),
            ),
            comparison_revision: Some(format!(
                "{}:{}",
                self.voice_revision, self.comparison_revision
            )),
            stream_epoch: stages.stream_epoch.clone(),
            schema_version: 1,
            stream_running: current,
            nominal_sample_rate_hz: nominal,
            fixed_buffer_request_frames: self.fixed_buffer_request_frames,
            nr_configured_enabled: nr_enabled,
            nr_processing_rate_hz: nr_rate,
            nr_processing_frame_samples: geometry.map(|g| g.frames as u32),
            vst_reported_latency_samples,
            signal_correspondence: crate::ipc::SignalCorrespondence::Unmeasured,
            stage_breakdown: Some(stages),
        }
    }

    fn frame_timing_trace(
        &self,
        expected_epoch: &str,
    ) -> Result<super::frame_timing::Trace, String> {
        self.frame_timing
            .as_ref()
            .ok_or_else(|| "音声試行が未開始のためtraceを取得できません".to_string())?
            .trace(expected_epoch)
            .map_err(str::to_string)
    }

    fn set_live_output_config(&mut self, config: super::live_output::Config) {
        if !config.same_route(&self.live_output_config) {
            self.restored_monitor = None;
        }
        self.live_output_config = config;
    }

    fn mode_monitor_command(
        &mut self,
        request: super::split_monitor::Request,
    ) -> std::result::Result<super::split_monitor::StateSnapshot, String> {
        use super::split_monitor::{Request, State, StateSnapshot};
        let running = self.processing_running();
        if let Request::Restore { state } = request {
            if running && !self.mode_silence.shared.active() {
                return Err("自分用設定の復元には切替用の無音確認が必要です".into());
            }
            if state.is_some() != self.live_output_config.split_processing {
                return Err("復旧原本と自分用出力の構成が一致しません".into());
            }
            if let Some(state) = &state {
                state.validate().map_err(|e| e.to_string())?;
            }
            // 配信側は個別設定のまま保持し、自分用だけに新しい完了世代を作る。
            self.live_modes.custom();
            let revision = self
                .live_mode_snapshot()
                .revision
                .parse::<u64>()
                .map_err(|_| "自分用設定の世代が不正です")?;
            if let Some(state) = &state {
                if running {
                    self.split_monitor
                        .as_mut()
                        .ok_or("自分用の音声処理がありません")?
                        .restore(state.clone(), revision)
                        .map_err(|e| e.to_string())?;
                }
            }
            // 停止中の手動復旧では、次の開始の初期DSPにも同じ設定を使う。
            self.restored_monitor = state;
        }
        let epoch = self.builtin.snapshot(false).epoch;
        if let Some(monitor) = &self.split_monitor {
            return Ok(monitor.state_snapshot(epoch));
        }
        let state = self.restored_monitor.clone().or_else(|| {
            if self.live_output_config.split_processing {
                let mode = self
                    .live_mode_snapshot()
                    .target
                    .unwrap_or(super::live_modes::Mode::Singing);
                let config = if mode == super::live_modes::Mode::Talk {
                    self.live_output_config.monitor_talk.clone()
                } else {
                    self.live_output_config.monitor_singing.clone()
                }?;
                Some(State { mode, config })
            } else {
                None
            }
        });
        let revision = self.live_mode_snapshot().revision;
        Ok(StateSnapshot {
            epoch,
            state,
            revision: revision.clone(),
            completed_revision: revision,
            pending: false,
            failed: running && self.live_output_config.split_processing,
        })
    }

    fn live_mode_snapshot(&self) -> super::live_modes::Snapshot {
        let mut snapshot = self.live_modes.snapshot(
            self.builtin.snapshot(false).epoch,
            self.processing_running(),
        );
        if let Some(monitor) = &self.split_monitor {
            snapshot.include_monitor_progress(
                monitor.shared.accepted.load(Ordering::Acquire),
                monitor.shared.completed.load(Ordering::Acquire),
                monitor.shared.failed.load(Ordering::Acquire),
            );
        }
        snapshot
    }
    fn select_live_mode(
        &mut self,
        mode: super::live_modes::Mode,
    ) -> std::result::Result<(), String> {
        if let Some(config) = self.live_modes.select(mode)? {
            self.restored_monitor = None;
            self.invalidate_auto_gain();
            self.builtin.legacy(config)?;
            self.built_in_effects_enabled = self.builtin.config.active;
            self.built_in_effects_preset = self.builtin.config.preset;
            self.built_in_effects_amount = self.builtin.config.amount;
            self.voice_revision = self.voice_revision.saturating_add(1);
            self.voice_preview.invalidate_candidate();
            self.poll_live_modes();
        }
        Ok(())
    }
    fn poll_live_modes(&mut self) {
        let sink_failed = self
            .live_output
            .as_ref()
            .is_some_and(|s| s.snapshot().failed);
        if sink_failed {
            if let Some(monitor) = &self.split_monitor {
                monitor.shared.failed.store(true, Ordering::Release);
            }
        }
        if let Some(monitor) = &mut self.split_monitor {
            monitor.flush();
            if monitor.shared.failed.load(Ordering::Acquire) {
                if let Some(sink) = &self.live_output {
                    sink.deactivate();
                }
                self.live_output_error =
                    Some("配信枝が停止しました。自分用は継続しています".into());
            }
        }
        if let Some(job) = self.live_modes.next(self.processing_running()) {
            let rate = self.current_sample_rate.round().clamp(8_000.0, 384_000.0) as u32;
            if let Some(monitor) = &mut self.split_monitor {
                if let Err(error) = monitor.mode(job.mode, job.revision) {
                    self.live_output_error = Some(error.to_string());
                }
            }
            self.queue_audio_msg(AudioThreadMessage::LiveMode {
                voice: super::live_modes::Voice::prepare(&job.config, rate)
                    .expect("検証済み本番内蔵設定"),
                revision: job.revision,
                builtin_revision: self.builtin.revision,
                reverb: super::live_modes::reverb_coefficients(&job.config, rate)
                    .expect("検証済み本番残響"),
                talk: job.mode == super::live_modes::Mode::Talk,
                frames: (rate / 50).max(1),
            });
        }
    }

    fn legacy_builtin(
        &mut self,
        active: bool,
        preset: BuiltInEffectsPreset,
        amount: f32,
        singing: Option<super::singing::SingingParams>,
        reverb: Option<super::reverb::ReverbParams>,
    ) -> std::result::Result<(), String> {
        self.builtin.legacy(super::builtin::Config {
            active,
            preset,
            amount: amount.clamp(0.0, 1.0),
            singing,
            reverb: reverb.or(self.builtin.config.reverb),
        })
    }

    fn builtin_coefficients(&self) -> Result<super::singing::Coefficients> {
        super::singing::Coefficients::prepare(
            self.builtin.config.singing.unwrap_or_default(),
            self.current_sample_rate.round().clamp(8_000.0, 384_000.0) as u32,
        )
        .map_err(|error| anyhow!(error))
    }

    fn initial_builtin(&self) -> Result<(super::builtin::Config, super::singing::Coefficients)> {
        let coefficients = self.builtin_coefficients()?;
        self.builtin
            .applied
            .store(self.builtin.revision, Ordering::Release);
        Ok((self.builtin.config.clone(), coefficients))
    }

    fn publish_builtin(&mut self) {
        self.voice_preview.invalidate_candidate();
        let config = &self.builtin.config;
        self.built_in_effects_enabled = config.active;
        self.built_in_effects_preset = config.preset;
        self.built_in_effects_amount = config.amount;
        if self.processing_running() {
            let singing = self
                .builtin_coefficients()
                .expect("検証済み内蔵処理とレート");
            self.queue_audio_msg(AudioThreadMessage::SetBuiltInEffects {
                active: config.active,
                preset: config.preset,
                amount: config.amount,
                singing,
                reverb: super::reverb::Coefficients::prepare(
                    config.reverb.unwrap_or_default(),
                    self.current_sample_rate.round().clamp(8_000.0, 384_000.0) as u32,
                )
                .expect("検証済み残響とレート"),
                revision: self.builtin.revision,
            });
        }
    }

    fn finish_plugin_restore(&mut self, mut staged: super::restoration::StagedRestore) {
        self.last_processing_preparation = "restore_plugin";
        if staged.expected_ids.as_ref().is_some_and(|ids| {
            !self.session_rack_matches(ids, staged.expected_rack_revision.unwrap_or(u64::MAX))
        }) {
            self.send_response(Response::RackConflict);
            return;
        }
        let setup = self.processing_running().then(|| self.processor_setup());
        let processor = match staged.finish(setup) {
            Ok(processor) => processor,
            Err(error) => {
                self.send_error(error.to_string());
                return;
            }
        };
        let index = match self.plugin_manager.reserve_restored_index(&staged) {
            Ok(index) => index,
            Err(error) => {
                drop(processor);
                self.send_error(error.to_string());
                return;
            }
        };
        let operation_id = staged.operation_id;
        let gain = staged.request.gain;
        let bypassed = staged.request.bypassed;
        let muted = staged.request.muted;
        let phase = Instant::now();
        let (id, name, index) = self.plugin_manager.commit_restored(staged, index);
        let opened = self.plugin_manager.plugins.get(&id);
        let class_id = opened.map(|instance| instance.class_id.clone());
        let legacy_class_ambiguous = opened.is_some_and(|instance| instance.legacy_class_ambiguous);
        let prepared = processor.is_some();
        if let Some(processor) = processor {
            self.queue_add_processor(index, processor, gain, bypassed, muted);
            self.queue_audio_msg(self.make_reorder_message());
        }
        log::debug!(
            "VST restore phase=commit us={}",
            phase.elapsed().as_micros()
        );
        self.acknowledge_processing_preparation();
        self.send_response(Response::PluginRestored {
            operation_id,
            plugin: crate::ipc::RestoredPlugin {
                id,
                name,
                prepared,
                class_id,
                legacy_class_ambiguous,
            },
        });
    }

    // streamを構築する前に保持値を反映し、最初のcallbackから同じ意図で処理する。
    fn initial_callback_levels(&mut self) -> (bool, f32, Smoother) {
        self.output_gain_revision = self.gain_revision;
        self.gain_shared
            .applied_revision
            .store(self.output_gain_revision, Ordering::Release);
        self.gain_shared
            .confirmed_gain
            .store(self.output_gain.to_bits(), Ordering::Release);
        self.gain_shared.settled.store(true, Ordering::Release);
        (
            self.global_mute,
            self.voice_input_gain,
            Smoother::new(self.output_gain),
        )
    }

    // 開始失敗・通常停止・終了で同じ回収順を使う。stream終了後にVSTを解放する。
    fn clear_audio_resources(&mut self) {
        self.mode_silence.invalidate();
        let reason = if self.stream_failed.load(Ordering::Acquire) {
            super::history::Reason::StreamFailed
        } else {
            super::history::Reason::StreamChanged
        };
        self.invalidate_noise_history(reason);
        self.builtin.invalidate_history_with_reason(reason);
        self.live_modes.stop();
        if self.pending_restore.take().is_some() {
            self.send_error("音声条件が変わったためVST復元を中断しました".into());
        }
        self.voice_preview.interrupt(true);
        self.invalidate_auto_gain_with_reason(reason);
        if let Some(sink) = &self.live_output {
            sink.deactivate();
        }
        self.input_stream = None;
        self.mixing_source = None;
        self.output_stream = None;
        self.post_worker = None;
        if let Some(mut owner) = self.process_renderer_owner.take() {
            drop(owner.take());
        }
        self.process_shared = None;
        self.mixing_input_shared = None;
        self.mixing_source_failure_reported = false;
        self.mixing_output_failure_reported = false;
        self.split_worker = None;
        if let Some(mut owner) = self.post_renderer_owner.take() {
            drop(owner.take());
        }
        if let Some(mut owner) = self.mixing_worker_owner.take() {
            drop(owner.take());
        }
        self.split_monitor = None;
        self.live_output = None;
        if let Some(timing) = &mut self.frame_timing {
            timing.seal();
        }
        // 両callback終了後に残量を封印し、音声slotの最後のArcも制御側で解放する。
        if let Some(observer) = self.queue_observer.take() {
            self.queue_slots_at_stop = Some(observer.occupied_len());
            self.queue_state = if self.queue_state == QueueState::Preparing
                || self.stream_failed.load(Ordering::Acquire)
            {
                QueueState::Failed
            } else {
                QueueState::Stopped
            };
        }
        self.processing_block_capacity = 0;
        self.fixed_buffer_request_frames = None;
        // callbackを保持するworkerが終了してから、返却されたprocessorを解放する。
        if let Some(mut returned) = self.processor_return.take() {
            drop(returned.take());
        }
        if let Some(retired) = &mut self.retire_rx {
            while let Some(processor) = retired.try_pop() {
                drop(processor);
            }
        }
        self.retire_rx = None;
        self.command_tx = None;
        self.pending_audio_msgs.clear();
        self.plugin_manager.stop_processing();
        self.voice_check.reset_transport_after_stream_drop();
        // 返却キュー・callback・未処理コマンドの全参照を解放した後だけVSTを閉じる。
        let pending: Vec<_> = self
            .plugin_manager
            .pending_drop_by_index
            .keys()
            .copied()
            .collect();
        for index in pending {
            self.plugin_manager.on_processor_retired(index);
        }
        self.channel_rx = None;
        self.gain_capture_rx = None;
        self.gain_main_device = None;
        self.gain_shared.settled.store(false, Ordering::Release);
        self.device_manager.clear_active_devices();
        // 学習値の所有元は停止中も残す。次の入力へのbindで退避・復帰するため、
        // 識別だけ消すと通常停止や開始失敗の後に既存の学習値を見失う。
        self.noise_learning.cancel_capture();
        let recorded_frames = self
            .voice_check_buffers
            .current()
            .and_then(|buffer| buffer.recording())
            .map_or(0, |recording| recording.frames as u64);
        self.voice_check
            .duration_frames
            .store(recorded_frames, Ordering::Relaxed);
        self.voice_check.state.store(
            if recorded_frames > 0 {
                super::voice_check::VC_STATE_READY
            } else {
                VC_STATE_IDLE
            },
            Ordering::Relaxed,
        );
        self.voice_check
            .envelope_dirty
            .store(recorded_frames > 0, Ordering::Relaxed);
        self.voice_check_buffers.collect();
        self.level_rx = None;
        self.loudness_rx = None;
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // フィールドの自動Dropより先に、VSTインスタンスとprocessorの寿命を揃える。
        self.clear_audio_resources();
    }
}

#[cfg(test)]
mod singing_startup_tests {
    #[test]
    fn stopped_recovery_keeps_captured_monitor_without_changing_broadcast_builtin() {
        use super::super::split_monitor::{Request, State};
        use super::*;
        let mut engine = Engine::new();
        let broadcast = engine.builtin.config.clone();
        let route = super::super::live_output::Config {
            split_processing: true,
            device_id: Some("fixture".into()),
            monitor_singing: Some(Default::default()),
            monitor_talk: Some(Default::default()),
            ..Default::default()
        };
        engine.set_live_output_config(route.clone());
        let source = State {
            mode: super::super::live_modes::Mode::Talk,
            config: super::super::builtin::Config {
                amount: 0.31,
                ..Default::default()
            },
        };
        let snapshot = engine
            .mode_monitor_command(Request::Restore {
                state: Some(source.clone()),
            })
            .unwrap();
        assert_eq!(snapshot.state, Some(source.clone()));
        assert!(!snapshot.pending && !snapshot.failed);
        assert_eq!(engine.restored_monitor, Some(source.clone()));
        assert_eq!(engine.builtin.config, broadcast);
        assert!(engine.output_stream.is_none());
        let snapshot = engine.mode_monitor_command(Request::Snapshot).unwrap();
        assert_eq!(snapshot.state, Some(source.clone()));
        assert!(engine.live_mode_snapshot().target.is_none());
        // 初回Startによる同じ保存構成の再送は元処理を維持する。
        engine.set_live_output_config(route.clone());
        assert_eq!(engine.restored_monitor, Some(source));
        // 復旧後の明示編集は古い復旧overrideより優先する。
        let mut edited = route;
        edited.monitor_singing = Some(super::super::builtin::Config {
            active: true,
            preset: BuiltInEffectsPreset::Warm,
            amount: 0.8,
            ..Default::default()
        });
        engine.set_live_output_config(edited.clone());
        assert!(engine.restored_monitor.is_none());
        assert_eq!(
            engine
                .mode_monitor_command(Request::Snapshot)
                .unwrap()
                .state
                .unwrap()
                .config,
            edited.monitor_singing.unwrap()
        );
    }

    #[test]
    fn stopped_channel_scan_changes_are_not_replayed_with_stale_generation() {
        use super::*;
        for enabled in [false, true] {
            let mut engine = Engine::new();
            engine.current_sample_rate = 100.0;
            engine.set_channel_scan(!enabled);
            engine.set_channel_scan(enabled);
            assert!(engine.pending_audio_msgs.is_empty());
            // 停止中の設定後、cleanupを経ずにコマンドキューとRT状態を作る。
            let (tx, mut rx) = HeapRb::new(8).split();
            engine.command_tx = Some(tx);
            let mut scan = engine.prepare_channel_scan(100);
            engine.flush_pending_audio_msgs();
            assert!(rx.try_pop().is_none());
            let (mut snapshots, mut received) = HeapRb::new(2).split();
            scan.observe(0, 0.7);
            scan.finish_block(10, &mut snapshots);
            if enabled {
                let snapshot = received.try_pop().expect("enabled scan must publish");
                let mut merged = None;
                super::super::channel_scan::merge(
                    &mut merged,
                    snapshot,
                    engine.scan_generation,
                    true,
                );
                assert_eq!(merged.unwrap()[0], 0.7);
            } else {
                assert!(received.try_pop().is_none());
            }
            // 稼働中の設定変更は最新世代を入力callbackへ直接渡す。
            engine.set_channel_scan(true);
            assert!(rx.try_pop().is_none());
            engine.scan_control.sync(&mut scan);
            scan.observe(0, 0.4);
            scan.finish_block(10, &mut snapshots);
            let mut merged = None;
            super::super::channel_scan::merge(
                &mut merged,
                received.try_pop().unwrap(),
                engine.scan_generation,
                true,
            );
            assert_eq!(merged.unwrap()[0], 0.4);
        }
    }

    #[test]
    fn cohort_marker_backpressure_waits_for_rt_completion_without_restarting_stream() {
        use super::*;
        let mut engine = Engine::new();
        let (observer, input, output) =
            super::super::frame_timing::Observer::new("window-epoch".into(), 1, true);
        engine.frame_timing = Some(observer);
        let (mut input, mut output) = (input.unwrap(), output.unwrap());
        let (tx, mut rx) = HeapRb::new(1).split();
        engine.command_tx = Some(tx);
        engine.queue_audio_msg(AudioThreadMessage::SetInputGain(0.5));
        assert!(matches!(
            rx.try_pop(),
            Some(AudioThreadMessage::SetInputGain(0.5))
        ));
        assert_eq!(engine.pending_audio_msgs.len(), 1);
        let now = input.now_ns();
        input.record_span(4, now);
        input.record_direct_emission(4, 4);
        input.record(4, 4, now, None);
        output.record_context(4, 4, now, now, None, true);
        engine.frame_timing.as_mut().unwrap().drain();
        assert_eq!(
            engine
                .frame_timing
                .as_ref()
                .unwrap()
                .cohort_snapshot()
                .unwrap()
                .status,
            "pending"
        );
        engine.flush_pending_audio_msgs();
        let Some(AudioThreadMessage::CohortWindow { revision }) = rx.try_pop() else {
            panic!()
        };
        assert!(output.complete_cohort_window(revision, true));
        let now = input.now_ns();
        input.record_span(4, now);
        input.record_direct_emission(4, 4);
        input.record(4, 4, now, None);
        output.record_context(4, 4, now, now, None, true);
        let observer = engine.frame_timing.as_mut().unwrap();
        observer.drain();
        let s = observer.cohort_snapshot().unwrap();
        assert_eq!(
            (
                s.applied_revision.as_str(),
                s.consumed_frames,
                s.stream_consumed_frames
            ),
            ("1", 4, 8)
        );
        assert!(!observer.snapshot().counter_invalid);
        observer.seal();
        let before = serde_json::to_value(observer.cohort_snapshot()).unwrap();
        assert!(observer.request_cohort_window().is_none());
        assert_eq!(
            serde_json::to_value(observer.cohort_snapshot()).unwrap(),
            before
        );
    }

    #[test]
    fn live_modes_stopped_selection_does_not_queue_old_values_or_change_rack_gain_nr_or_mute() {
        use super::*;
        use crate::audio_engine::live_modes::{Definitions, Mode};
        use ringbuf::HeapRb;
        let mut engine = Engine::new();
        engine.global_mute = true;
        engine.output_gain = 0.37;
        engine.voice_input_gain = 1.42;
        engine.noise_reduction_enabled = true;
        engine.plugin_manager.order = vec!["existing-vst-a".into(), "existing-vst-b".into()];
        engine
            .live_modes
            .configure(
                Definitions {
                    singing: Some(super::super::builtin::Config {
                        active: true,
                        preset: BuiltInEffectsPreset::Singing,
                        ..Default::default()
                    }),
                    talk: Some(Default::default()),
                    ..Default::default()
                },
                false,
            )
            .unwrap();
        let (producer, mut consumer) = HeapRb::new(4).split();
        engine.command_tx = Some(producer);
        let before = (
            engine.global_mute,
            engine.output_gain,
            engine.voice_input_gain,
            engine.noise_reduction_enabled,
            engine.plugin_manager.order.clone(),
        );
        engine.select_live_mode(Mode::Singing).unwrap();
        engine.select_live_mode(Mode::Talk).unwrap();
        let revision = engine.builtin.revision;
        engine.gain_shared.active.store(19, Ordering::Release);
        engine.select_live_mode(Mode::Talk).unwrap();
        engine.live_mode_snapshot();
        assert_eq!(engine.gain_shared.active.load(Ordering::Acquire), 19);
        assert_eq!(engine.builtin.revision, revision);
        assert!(engine.pending_audio_msgs.is_empty());
        assert!(consumer.try_pop().is_none());
        assert_eq!(
            before,
            (
                engine.global_mute,
                engine.output_gain,
                engine.voice_input_gain,
                engine.noise_reduction_enabled,
                engine.plugin_manager.order.clone()
            )
        );
        let (initial, _) = engine.initial_builtin().unwrap();
        assert!(!initial.active);
        engine.clear_audio_resources();
        assert_eq!(engine.live_mode_snapshot().target, Some(Mode::Talk));
    }

    #[test]
    fn legacy_voice_changes_keep_independent_reverb_and_profile_missing_value_disables_it() {
        use super::*;
        let mut engine = Engine::new();
        let params = super::super::reverb::ReverbParams {
            enabled: true,
            ..Default::default()
        };
        engine.builtin.config.reverb = Some(params);
        engine
            .legacy_builtin(false, BuiltInEffectsPreset::Broadcast, 0.7, None, None)
            .unwrap();
        assert!(!engine.builtin.config.active);
        assert_eq!(engine.builtin.config.reverb, Some(params));
        assert!(engine.pending_audio_msgs.is_empty());
        let old_profile: crate::vst_host::presets::ProfileBuiltinFx =
            serde_json::from_str(r#"{"enabled":false,"preset":"broadcast","amount":0.7}"#).unwrap();
        engine
            .legacy_builtin(
                old_profile.enabled,
                BuiltInEffectsPreset::Broadcast,
                old_profile.amount,
                old_profile.singing,
                Some(old_profile.reverb.unwrap_or_default()),
            )
            .unwrap();
        assert!(!engine.builtin.config.reverb.unwrap().enabled);
    }

    #[test]
    fn startup_and_live_coefficients_use_actual_384khz_and_match_response() {
        use super::*;
        use crate::audio_engine::singing::{Coefficients, SingingChain};
        let mut engine = Engine::new();
        engine.current_sample_rate = 384_000.0;
        engine.builtin.config.active = true;
        engine.builtin.config.preset = BuiltInEffectsPreset::Singing;
        let (_, initial) = engine.initial_builtin().unwrap();
        let live = engine.builtin_coefficients().unwrap();
        let expected =
            Coefficients::prepare(engine.builtin.config.singing.unwrap_or_default(), 384_000)
                .unwrap();
        let mut started = SingingChain::new(initial, true);
        let mut updated = SingingChain::new(live, true);
        let mut reference = SingingChain::new(expected, true);
        for frame in 0..16_384 {
            if frame == 100 {
                started.update(live, true);
            }
            let sample = if frame == 0 { 0.25 } else { 0.0 };
            let input = [sample, -sample];
            let wanted = reference.process(input, input);
            assert_eq!(started.process(input, input), wanted);
            assert_eq!(updated.process(input, input), wanted);
        }
    }
}

#[cfg(test)]
mod singing_proposal_dispatch_tests {
    use super::*;
    use crate::audio_engine::builtin::Request;
    fn fixture() -> Engine {
        let mut engine = Engine::new();
        let context = voice_preview::tests::proposal_context();
        engine.voice_check_buffers.replace(context.buffers.unwrap());
        engine.voice_metadata = context.metadata;
        engine.voice_revision = context.current_revision;
        engine.global_mute = true;
        engine.voice_input_gain = 1.4;
        engine.output_gain = 0.37;
        engine.noise_reduction_enabled = true;
        engine.plugin_manager.order = vec!["rack-a".into(), "rack-b".into()];
        engine
    }
    fn prepare(engine: &mut Engine) -> (String, String) {
        use voice_preview::{Action, Request as PreviewRequest};
        let context = engine.voice_preview_context();
        let request = |operation_id, epoch, action| PreviewRequest {
            client_id: "proposal-test".into(),
            session_id: 1,
            operation_id,
            epoch,
            action,
        };
        let opened = engine
            .voice_preview
            .command(request(1, None, Action::Open), context.clone())
            .unwrap();
        engine
            .voice_preview
            .command(
                request(
                    2,
                    Some(opened.epoch.clone()),
                    Action::PrepareProposal {
                        rule_version: None,
                        preferences: None,
                        preferences_revision: None,
                        recording_id: 1,
                        builtin_epoch: context.builtin_epoch,
                        expected_revision: context.builtin_revision,
                    },
                ),
                engine.voice_preview_context(),
            )
            .unwrap();
        for _ in 0..1000 {
            let snapshot = engine
                .voice_preview
                .command(
                    request(2, Some(opened.epoch.clone()), Action::Status),
                    engine.voice_preview_context(),
                )
                .unwrap();
            if let Some(candidate) = snapshot.candidate {
                if candidate.state == "ready" {
                    return (candidate.id, opened.epoch);
                }
                assert_eq!(candidate.state, "preparing");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        panic!("提案の完了待機が期限切れ");
    }
    fn apply(engine: &mut Engine, id: &str) -> Result<super::super::builtin::Snapshot, String> {
        let snapshot = engine.builtin.snapshot(false);
        engine.builtin_command(Request::ApplyProposal {
            epoch: snapshot.epoch,
            expected_revision: snapshot.revision,
            proposal_id: id.into(),
            recording_id: 1,
        })
    }
    #[test]
    fn proposal_same_dispatch_apply_ack_survives_invalidation_close_then_undo_cas() {
        let mut engine = fixture();
        let before = engine.builtin.config.clone();
        let (id, preview_epoch) = prepare(&mut engine);
        let accepted = apply(&mut engine, &id).unwrap();
        assert!(accepted.config.active);
        assert_eq!(accepted.config.preset, BuiltInEffectsPreset::Singing);
        assert!(accepted.undo_token.is_some());
        assert!(!accepted.pending);
        assert_eq!(
            (
                engine.global_mute,
                engine.voice_input_gain,
                engine.output_gain,
                engine.noise_reduction_enabled
            ),
            (true, 1.4, 0.37, true)
        );
        assert_eq!(engine.plugin_manager.order, vec!["rack-a", "rack-b"]);
        assert!(engine.pending_audio_msgs.is_empty());
        engine
            .voice_preview
            .command(
                voice_preview::Request {
                    client_id: "proposal-test".into(),
                    session_id: 1,
                    operation_id: 3,
                    epoch: Some(preview_epoch),
                    action: voice_preview::Action::Close,
                },
                engine.voice_preview_context(),
            )
            .unwrap();
        assert_eq!(engine.builtin.revision.to_string(), accepted.revision);
        assert!(apply(&mut engine, &id).is_err()); // 提案自体の失効を適用ACKの失敗へ戻さない。
        let restored = engine
            .builtin_command(Request::Undo {
                epoch: accepted.epoch,
                expected_revision: accepted.revision,
                undo_token: accepted.undo_token.unwrap(),
            })
            .unwrap();
        assert_eq!(restored.config, before);
        assert!(restored.undo_token.is_none());
    }
    #[test]
    fn proposal_dispatch_rejects_recording_only_epoch_or_condition_change_without_cas() {
        for kind in 0..4 {
            let mut engine = fixture();
            let (id, _) = prepare(&mut engine);
            let before = engine.builtin.config.clone();
            let revision = engine.builtin.revision;
            match kind {
                0 => engine.voice_metadata.as_mut().unwrap().recording_id += 1,
                1 => {
                    engine
                        .voice_metadata
                        .as_mut()
                        .unwrap()
                        .changed_during_recording = true
                }
                2 => engine.voice_revision += 1,
                _ => engine
                    .voice_check_buffers
                    .replace(voice_preview::tests::proposal_context().buffers.unwrap()),
            }
            assert!(apply(&mut engine, &id).is_err());
            assert_eq!(engine.builtin.revision, revision);
            assert_eq!(engine.builtin.config, before);
        }
        let mut engine = fixture();
        let (id, _) = prepare(&mut engine);
        let before = engine.builtin.revision;
        assert!(engine
            .builtin_command(Request::ApplyProposal {
                epoch: "old-engine".into(),
                expected_revision: before.to_string(),
                proposal_id: id,
                recording_id: 1
            })
            .is_err());
        assert_eq!(engine.builtin.revision, before);
    }
}

#[cfg(test)]
mod latency_stage_runtime_tests {
    use super::*;
    #[test]
    fn noise_intent_refusal_preserves_both_setter_inputs_and_stopped_latest_has_no_queue() {
        let mut e = Engine::new();
        for mode in [NoiseControlMode::High, NoiseControlMode::Venue] {
            let before = (
                e.noise_reduction_enabled,
                e.noise_control_mode,
                e.noise_control_strength,
                e.noise_voice_guard,
                e.pending_audio_msgs.len(),
            );
            assert!(e
                .apply_noise_intent(true, mode, 0.8, false, Some(768_000))
                .is_err());
            assert_eq!(
                before,
                (
                    e.noise_reduction_enabled,
                    e.noise_control_mode,
                    e.noise_control_strength,
                    e.noise_voice_guard,
                    e.pending_audio_msgs.len()
                )
            );
        }
        e.apply_noise_intent(false, NoiseControlMode::High, 0.8, false, Some(768_000))
            .unwrap();
        e.pending_audio_msgs.clear();
        for rate in [44_100, 48_000, 96_000, 192_000, 384_000, 768_000] {
            e.current_sample_rate = rate as f64;
            e.apply_noise_intent(true, NoiseControlMode::Low, 1.0, true, None)
                .unwrap();
            assert!(e.pending_audio_msgs.is_empty());
            assert_eq!(
                dsp::NoiseGeometry::guard(rate, e.noise_reduction_enabled).is_ok(),
                rate <= 384_000
            );
            let m = e.latency_metadata((0, Some(0), false, vec![]));
            assert_eq!(m.nr_processing_rate_hz, (rate <= 384_000).then_some(rate));
            let stage = m.stage_breakdown.unwrap();
            assert!(!stage.current);
            assert!(stage.nr.frame_period_ms.is_none());
        }
        e.clear_audio_resources();
        assert!(e.noise_reduction_enabled);
    }
}

#[cfg(test)]
mod preparation_status_tests {
    use super::*;

    #[test]
    fn status_reads_do_not_change_revisions_or_audio_and_roundtrip_without_integer_loss() {
        let mut engine = Engine::new();
        engine.voice_revision = (1_u64 << 54) + 1;
        engine.preparation_routing_revision = 8;
        engine.output_gain_revision = 9;
        engine.voice_input_gain = 1.3;
        engine.global_mute = true;
        let first = engine.preparation_snapshot();
        assert_eq!(first, engine.preparation_snapshot());
        assert_eq!(first.processing_revision, "18014398509481985");
        assert_eq!(first.routing_revision, "8");
        assert_eq!(first.output_revision, "9");
        assert_eq!(first.input_gain, 1.3);
        assert!(first.muted);
        assert!(engine.pending_audio_msgs.is_empty());
        let value = serde_json::to_value(&first).unwrap();
        assert_eq!(value["processingRevision"], "18014398509481985");
        assert_eq!(
            serde_json::from_value::<crate::ipc::PreparationSnapshot>(value).unwrap(),
            first
        );
    }

    #[test]
    fn status_reports_unconsumed_audio_commands_as_pending_without_draining_them() {
        let mut engine = Engine::new();
        let (tx, mut rx) = HeapRb::new(2).split();
        engine.command_tx = Some(tx);
        engine.queue_audio_msg(AudioThreadMessage::SetInputGain(0.5));
        assert!(engine.preparation_snapshot().controls_pending);
        assert!(matches!(
            rx.try_pop(),
            Some(AudioThreadMessage::SetInputGain(0.5))
        ));
        engine.pending_audio_msgs.clear();
        engine.command_tx = None;
        let before = engine.preparation_snapshot();
        engine.preparation_routing_revision += 1;
        let after = engine.preparation_snapshot();
        assert_eq!(before.processing_revision, after.processing_revision);
        assert_ne!(before.routing_revision, after.routing_revision);
    }
}

#[cfg(test)]
#[path = "core/history_tests.rs"]
mod history_tests;
