#[path = "core/noise_comparison.rs"]
mod noise_comparison;
#[path = "core/noise_learning.rs"]
pub mod noise_learning;
use noise_learning::{NoiseLearningShared, RtNoiseLearning};
#[path = "core/dsp.rs"]
pub(crate) mod dsp;
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
#[path = "core/lifecycle.rs"]
pub(super) mod lifecycle;
#[path = "core/session_rack.rs"]
mod session_rack;
use super::auto_gain::{self, Session as GainSession};
use super::auto_gain_preview;
use super::callback_diagnostics::{callback_lateness, normalized_channels, CallbackDiagnostics};
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
    },
    SetMute {
        index: u8,
        active: bool,
    },
    SetGain {
        index: u8,
        value: f32,
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
    SetChannelScan(bool),           // Enable/Disable background scanning
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
pub enum UserEvent {
    Command(Command),
    Shutdown,
    Timer,
}

type CmdProducer = <HeapRb<AudioThreadMessage> as Split>::Prod;
type LoudnessConsumer = <HeapRb<LoudnessReading> as Split>::Cons;
type LevelConsumer = <HeapRb<MeterLevels> as Split>::Cons;
type ChannelConsumer = <HeapRb<[f32; 32]> as Split>::Cons;
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
    split_worker: Option<super::split_monitor::Worker>,
    mode_silence: super::mode_silence::Controller,
    input_stream: Option<cpal::Stream>,
    output_stream: Option<cpal::Stream>,

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
    scan_enabled: bool,
    global_bypass: bool,
    global_mute: bool,
    noise_reduction_enabled: bool,
    noise_control_mode: NoiseControlMode,
    noise_control_strength: f32,
    noise_voice_guard: bool,
    noise_learning: Arc<NoiseLearningShared>,
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
            split_worker: None,
            mode_silence: Default::default(),
            input_stream: None,
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
            scan_enabled: true, // Auto-enable scan for smart selector
            global_bypass: false,
            global_mute: false,
            noise_reduction_enabled: false,
            noise_control_mode: NoiseControlMode::Low,
            noise_control_strength: 1.0,
            noise_voice_guard: true,
            noise_learning: Arc::new(NoiseLearningShared::new()),
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
                    self.voice_preview.poll(self.output_stream.is_some() && !self.stream_failed.load(Ordering::Acquire));
                    // RT側は固定サイズの通知だけを行い、停止と文言生成は制御側で行う。
                    let resampling_failed = self.resampling_failed.swap(false, Ordering::AcqRel);
                    let block_capacity_failed = self.block_capacity_failed.swap(false, Ordering::AcqRel);
                    let nr_failed = self.nr_failed.swap(false, Ordering::AcqRel);
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
                        let running = self.output_stream.is_some();
                        let result = (|| -> Result<Option<VstProcessor>> {
                            let instance = self.plugin_manager.get_mut(&id).ok_or_else(|| anyhow!("VSTが見つかりません"))?;
                            if running { instance.prepare_processing(sr, bs as i32, ch as i32)?; }
                            instance.finalize_connection()?;
                            if running { Ok(Some(instance.create_processor().ok_or_else(|| anyhow!("VST processorを作成できません"))?)) } else { Ok(None) }
                        })();
                        match result {
                            Ok(Some(processor)) => {
                                if let Some(index) = self.plugin_manager.rt_index_of(&id) {
                                    self.queue_audio_msg(AudioThreadMessage::AddProcessor {
                                        index, processor,
                                        initial_gain: *self.plugin_manager.gains.get(&id).unwrap_or(&1.0),
                                        initial_bypassed: self.plugin_manager.bypassed.contains(&id),
                                        initial_muted: self.plugin_manager.muted.contains(&id),
                                    });
                                    self.queue_audio_msg(self.make_reorder_message());
                                }
                            }
                            Ok(None) => {},
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

                    // Channel Scan Processing (32ch)
                    let mut channel_scan_to_send: Option<Vec<f32>> = None;
                    if let Some(chan_cons) = &mut self.channel_rx {
                        // We only care about the latest scan? Or accumulate max?
                        // For visualization, latest snapshot is usually fine if rate is controlled by audio thread.
                        // Audio thread sends at ~10-20Hz.
                        while let Some(peaks) = chan_cons.try_pop() {
                            // peaks is [f32; 32]
                            // Convert to Vec for IPC
                            // Optimization: Only send if we really have new data.
                            // But we just popped it, so we have new data.
                            channel_scan_to_send = Some(peaks.to_vec());
                        }
                    }
                    if let Some(scan_data) = channel_scan_to_send {
                        let is_zero = scan_data.iter().all(|v| *v == 0.0);
                        if !is_zero || !last_channel_scan_was_zero {
                            self.send_event(EngineEvent::ChannelLevels(scan_data));
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
        let builtin = self.builtin.snapshot(self.output_stream.is_some());
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
            main_running: self.output_stream.is_some()
                && !self.stream_failed.load(Ordering::Acquire),
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
        let failed = self.output_stream.is_some() && self.stream_failed.load(Ordering::Acquire);
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
        if self
            .builtin
            .request(request, self.output_stream.is_some())?
        {
            self.live_modes.custom();
            self.voice_revision = self.voice_revision.saturating_add(1);
            self.publish_builtin();
        }
        let mut snapshot = self.builtin.snapshot(self.output_stream.is_some());
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
            output_gain: self.output_gain,
            output_revision: self.output_gain_revision.to_string(),
            muted: self.global_mute,
            controls_pending: !self.pending_audio_msgs.is_empty()
                || self.command_tx.as_ref().is_some_and(|q| !q.is_empty())
                || !self.gain_shared.settled.load(Ordering::Acquire)
                || (self.output_stream.is_some()
                    && self.peak_shared.pending(
                        self.live_output_config.split_processing,
                        self.live_output.is_some(),
                    )),
            nr_backend: "nnnoiseless-0.5.2".into(),
            nr_model: "bundled-e6de5fbfadf7ec91".into(),
        }
    }

    fn handle_command<T>(
        &mut self,
        cmd: Command,
        target: &winit::event_loop::EventLoopWindowTarget<T>,
    ) {
        // 拒否時に保存intent/条件revision/pending queueを部分更新しない。
        let nr_enable = match &cmd {
            Command::SetNoiseReduction { active, .. }
            | Command::SetNoiseControlConfig { active, .. } => Some(*active),
            _ => None,
        };
        if let Some(active) = nr_enable {
            if self.output_stream.is_some() {
                if let Err(error) =
                    dsp::NoiseGeometry::guard(self.current_sample_rate as u32, active)
                {
                    self.send_error(error.into());
                    return;
                }
            }
        }
        // 保存セッションだけは、追加のentryと遅延STA完了の両方で同じ順序を要求する。
        let (cmd, session_expected_ids) = match cmd {
            Command::RestoreSessionPlugin {
                expected_ids,
                expected_revision,
                request,
                operation_id,
                expires_at_ms,
            } => {
                if !self.session_rack_matches(&expected_ids, expected_revision) {
                    self.send_response(Response::RackConflict);
                    return;
                }
                (
                    Command::RestorePlugin {
                        request,
                        operation_id,
                        expires_at_ms,
                    },
                    Some(expected_ids),
                )
            }
            other => (other, None),
        };
        if self.live_output_config.split_processing
            && matches!(
                &cmd,
                Command::PlayVoiceCheck { .. } | Command::PlayTestTone { .. }
            )
        {
            self.send_error("処理分離中は通常出力への録音再生・テスト音に対応していません。録音の別試聴または単一出力を使ってください".into());
            return;
        }
        if matches!(
            &cmd,
            Command::LoadPlugin { .. }
                | Command::RestorePlugin { .. }
                | Command::UnloadPlugin { .. }
                | Command::ReorderPlugins { .. }
        ) {
            let Some(revision) = self.session_rack_revision.checked_add(1) else {
                self.send_response(Response::RackConflict);
                return;
            };
            self.session_rack_revision = revision;
        }
        if let Err(error) =
            super::live_modes::guard(self.live_modes.armed, self.live_modes.bound.as_ref(), &cmd)
        {
            self.send_error(error);
            return;
        }
        if matches!(
            &cmd,
            Command::BuiltinEffects {
                request: super::builtin::Request::ApplyProposal { .. }
            }
        ) && (self.gain_preview.is_some()
            || self.gain_shared.active.load(Ordering::Acquire) != 0
            || self.gain_shared.requested.load(Ordering::Acquire) != 0)
        {
            self.send_error("音量調整を停止してから提案を適用してください".into());
            return;
        }
        if matches!(
            &cmd,
            Command::Start { .. }
                | Command::Stop
                | Command::SetInputGain { .. }
                | Command::SetInputChannels { .. }
        ) {
            self.invalidate_noise_history(
                if matches!(&cmd, Command::Start { .. } | Command::Stop) {
                    super::history::Reason::StreamChanged
                } else {
                    super::history::Reason::InputChanged
                },
            );
            self.noise_input_revision = self.noise_input_revision.saturating_add(1);
            self.invalidate_noise_measurement("inputChanged");
        }
        // 新しい別出力試聴は、通常再生stateも自動ゲイン提案も変更しない。
        if matches!(
            &cmd,
            Command::LiveOutput { config: Some(_) } | Command::SetGlobalMute { .. }
        ) {
            self.preparation_routing_revision = self.preparation_routing_revision.saturating_add(1);
        }
        if matches!(
            &cmd,
            Command::StartVoiceCheckRecording { .. } | Command::PlayVoiceCheck { .. }
        ) && (self.gain_preview.is_some()
            || self.gain_shared.active.load(Ordering::Acquire) != 0
            || self.gain_shared.requested.load(Ordering::Acquire) != 0)
        {
            self.send_error("音量調整の録音・聞き比べを停止してから操作してください".into());
            return;
        }
        if matches!(&cmd, Command::PlayVoiceCheck { .. }) && self.voice_preview.active() {
            self.send_error("別出力の試聴を停止してから通常出力で再生してください".into());
            return;
        }
        if matches!(
            &cmd,
            Command::Start { .. }
                | Command::Stop
                | Command::LoadPlugin { .. }
                | Command::RestorePlugin { .. }
                | Command::UnloadPlugin { .. }
                | Command::ReorderPlugins { .. }
                | Command::SetBypass { .. }
                | Command::SetMute { .. }
                | Command::SetGain { .. }
                | Command::SetPluginState { .. }
                | Command::SetGlobalBypass { .. }
                | Command::SetInputGain { .. }
                | Command::SetInputChannels { .. }
                | Command::SetNoiseReduction { .. }
                | Command::SetNoiseControlConfig { .. }
                | Command::StartNoiseLearning { .. }
                | Command::CancelNoiseLearning
                | Command::SetBuiltInEffects { .. }
        ) {
            self.voice_revision = self.voice_revision.saturating_add(1);
            self.voice_preview.invalidate_candidate();
            if self.voice_check.state.load(Ordering::Acquire) == VC_STATE_RECORDING {
                if let Some(metadata) = &mut self.voice_metadata {
                    metadata.changed_during_recording = true;
                }
            }
        }
        if !matches!(
            &cmd,
            Command::PeakProtection { config: None }
                | Command::LiveOutput { config: None }
                | Command::LiveMode { .. }
                | Command::ModeSilence { .. }
                | Command::ConfigureLiveModes { .. }
                | Command::GetDevices
                | Command::StartIdentityCapability
                | Command::BeginDeviceScan
                | Command::PollDeviceScan { .. }
                | Command::CancelDeviceScan { .. }
                | Command::GetRuntimeStats
                | Command::NoiseMeasurement {
                    request: noise_learning::Request::Snapshot
                }
                | Command::GetFrameTimingTrace { .. }
                | Command::GetPluginState { .. }
                | Command::CaptureBundleState
                | Command::GetPluginRack
                | Command::AutoGain { .. }
                | Command::SetOutputGain { .. }
                | Command::SetLoudnessMeasurement { .. }
                | Command::SetChannelScan { .. }
                | Command::StopVoiceCheckPlayback
                | Command::StopVoiceCheckRecording
                | Command::VoiceCheckPreview { .. }
                | Command::BuiltinEffects {
                    request: super::builtin::Request::Snapshot
                }
        ) {
            self.invalidate_auto_gain_with_reason(match &cmd {
                Command::Start { .. } | Command::Stop => super::history::Reason::StreamChanged,
                Command::SetInputGain { .. } | Command::SetInputChannels { .. } => {
                    super::history::Reason::InputChanged
                }
                _ => super::history::Reason::ConditionsChanged,
            });
        }
        if self.peak_config.enabled
            && matches!(
                &cmd,
                Command::AutoGain {
                    request: auto_gain::Request::Begin { .. }
                }
            )
        {
            self.send_error("固定ゲイン提案はピーク保護をOFFにして測定してください。最終送出は保護をONにして再確認できます".into());
            return;
        }
        match cmd {
            Command::ModeSilence { request } => {
                let failed = self.stream_failed.load(Ordering::Acquire)
                    || self.nr_failed.load(Ordering::Acquire)
                    || self.resampling_failed.load(Ordering::Acquire)
                    || self.block_capacity_failed.load(Ordering::Acquire)
                    || self
                        .live_output
                        .as_ref()
                        .is_some_and(|sink| sink.snapshot().failed)
                    || self
                        .split_monitor
                        .as_ref()
                        .is_some_and(|m| m.shared.failed.load(Ordering::Acquire));
                match self.mode_silence.request(
                    request,
                    self.queue_attempt,
                    self.output_stream.is_some(),
                    self.live_output_config.split_processing,
                    self.live_output.is_some(),
                    failed,
                ) {
                    Ok(value) => self.send_response(Response::ModeSilence(value)),
                    Err(error) => self.send_error(error),
                }
            }
            Command::StartIdentityCapability => {
                self.send_response(Response::StartIdentityCapability { version: 1 });
            }
            Command::PeakProtection { config } => {
                if let Some(config) = config {
                    if self.live_modes.armed {
                        self.send_error(
                            "本番保護を解除してからピーク保護を変更してください".into(),
                        );
                        return;
                    }
                    match config.validate() {
                        Ok(config) => {
                            self.peak_config = config;
                            self.peak_shared
                                .publish(config.prepare(self.current_sample_rate as u32));
                            self.preparation_routing_revision =
                                self.preparation_routing_revision.saturating_add(1);
                        }
                        Err(error) => {
                            self.send_error(error);
                            return;
                        }
                    }
                }
                let mut status = self.peak_shared.status(
                    self.peak_config,
                    self.output_stream.is_some(),
                    self.live_output_config.split_processing,
                );
                status.pending |=
                    status.running && self.live_output.is_some() && self.peak_shared.sink_pending();
                self.send_response(Response::PeakProtection(status));
            }
            Command::LiveOutput { config } => {
                if let Some(config) = config {
                    if let Err(error) = config.validate() {
                        self.send_error(error.to_string());
                        return;
                    }
                    if self.live_modes.armed && !config.same_route(&self.live_output_config) {
                        self.send_error("本番保護中は出力構成を変更できません".into());
                        return;
                    }
                    if self.output_stream.is_some() && !config.same_route(&self.live_output_config)
                    {
                        self.send_error("音声を停止してから出力構成を変更してください".into());
                        return;
                    }
                    if let Some(sink) = &self.live_output {
                        sink.update(&config);
                    }
                    self.monitor_levels.store(
                        u64::from(config.monitor_trim.to_bits())
                            | (u64::from(config.monitor_muted) << 32),
                        Ordering::Release,
                    );
                    self.builtin.invalidate_history();
                    self.live_output_config = config;
                    if self.output_stream.is_some() {
                        if let Some(revision) = self
                            .frame_timing
                            .as_ref()
                            .and_then(|t| t.request_cohort_window())
                        {
                            self.push_audio_msg(AudioThreadMessage::CohortWindow { revision });
                        }
                    }
                }
                self.send_response(Response::LiveOutput(Box::new(super::live_output::Status {
                    config: self.live_output_config.clone(),
                    sink: self.live_output.as_ref().map(|s| s.snapshot()),
                    error: self.live_output_error.clone(),
                    broadcast_epoch: self.live_output.as_ref().map(|_| {
                        format!(
                            "{}:broadcast:{}",
                            self.builtin.snapshot(false).epoch,
                            self.queue_attempt
                        )
                    }),
                    monitor: self.split_monitor.as_ref().map(|m| {
                        m.snapshot(format!(
                            "{}:monitor:{}",
                            self.builtin.snapshot(false).epoch,
                            self.queue_attempt
                        ))
                    }),
                })));
            }
            Command::GetFrameTimingTrace { expected_epoch } => {
                match self.frame_timing_trace(&expected_epoch) {
                    Ok(trace) => self.send_response(Response::FrameTimingTrace(Box::new(trace))),
                    Err(error) => self.send_error(error),
                }
            }
            Command::VoiceCheckPreview { request } => {
                match self.noise_voice_preview_command(request) {
                    Ok(snapshot) => {
                        self.send_response(Response::VoiceCheckPreview(Box::new(snapshot)))
                    }
                    Err(error) => self.send_error(error.to_string()),
                }
            }
            Command::AutoGain { request } => match self.auto_gain_command(request) {
                Ok(state) => self.send_response(Response::AutoGain(state)),
                Err(e) => self.send_error(e.to_string()),
            },
            Command::BeginDeviceScan => match self.device_manager.begin_scan() {
                Ok(token) => self.send_response(Response::DeviceScanStarted { token }),
                Err(error) => self.send_error(error.to_string()),
            },
            Command::PollDeviceScan { token } => match self.device_manager.poll_scan(token) {
                Ok(status) => self.send_response(Response::DeviceScanStatus { token, status }),
                Err(error) => self.send_error(error.to_string()),
            },
            Command::CancelDeviceScan { token } => match self.device_manager.cancel_scan(token) {
                Ok(()) => self.send_response(Response::Success),
                Err(error) => self.send_error(error.to_string()),
            },
            Command::LiveMode { request } => {
                if matches!(
                    request,
                    super::live_modes::Request::BindProfile { .. }
                        | super::live_modes::Request::Recover { .. }
                ) {
                    self.send_error("VST構成の登録と復旧はHostから操作してください".into());
                    return;
                }
                if let Err(error) = self
                    .live_modes
                    .accept_request(&request, &self.builtin.snapshot(false).epoch)
                {
                    self.send_error(error);
                    return;
                }
                self.poll_live_modes();
                let result = match request {
                    super::live_modes::Request::Snapshot => Ok(()),
                    super::live_modes::Request::Arm { .. } => {
                        if self
                            .live_modes
                            .bound
                            .as_ref()
                            .is_some_and(|bound| bound.concrete())
                        {
                            self.live_modes.armed = true;
                            Ok(())
                        } else {
                            Err("入出力・レート・バッファを明示選択してから本番保護を有効にしてください".into())
                        }
                    }
                    super::live_modes::Request::Disarm { .. } => {
                        self.live_modes.armed = false;
                        Ok(())
                    }
                    super::live_modes::Request::SingingOn { .. } => {
                        self.select_live_mode(super::live_modes::Mode::Singing)
                    }
                    super::live_modes::Request::TalkOn { .. } => {
                        self.select_live_mode(super::live_modes::Mode::Talk)
                    }
                    super::live_modes::Request::Save { .. }
                    | super::live_modes::Request::BindProfile { .. }
                    | super::live_modes::Request::Recover { .. } => {
                        Err("保存はHostの本番モードAPIを使用してください".into())
                    }
                };
                match result {
                    Ok(()) => {
                        self.send_response(Response::LiveModes(Box::new(self.live_mode_snapshot())))
                    }
                    Err(error) => self.send_error(error),
                }
            }
            Command::ConfigureLiveModes { definitions, armed } => {
                match self.live_modes.configure(definitions, armed) {
                    Ok(()) => {
                        self.send_response(Response::LiveModes(Box::new(self.live_mode_snapshot())))
                    }
                    Err(error) => self.send_error(error),
                }
            }
            Command::GetDevices => {
                // Delegated to DeviceManager
                match self.device_manager.enumerate() {
                    Ok(devs) => self.send_response(Response::Devices(devs)),
                    Err(e) => self.send_error(e.to_string()),
                }
            }
            Command::Start {
                host,
                input,
                output,
                input_id,
                output_id,
                buffer_size,
                sample_rate,
                initial_controls,
            } => {
                if let Some(controls) = initial_controls {
                    if let Err(error) = self.prepare_initial_controls(controls) {
                        self.send_error(error.to_string());
                        return;
                    }
                }
                let mut bound = super::live_modes::StartSpec {
                    host: host.clone(),
                    input: input.clone(),
                    output: output.clone(),
                    input_id: input_id.clone(),
                    output_id: output_id.clone(),
                    rate: sample_rate,
                    buffer: buffer_size,
                };
                match self.start_audio_with_ids(
                    Some(host),
                    input,
                    output,
                    sample_rate,
                    buffer_size,
                    (input_id, output_id),
                ) {
                    Ok(_) => {
                        bound.rate = Some(self.current_sample_rate as u32);
                        bound.buffer = Some(self.current_block_size as u32);
                        bound.input_id = self
                            .device_manager
                            .active_input
                            .as_ref()
                            .and_then(|d| d.id.clone());
                        bound.output_id = self
                            .device_manager
                            .active_output
                            .as_ref()
                            .and_then(|d| d.id.clone());
                        self.live_modes.bound = Some(bound);
                        self.send_response(Response::Started {
                            sample_rate: self.current_sample_rate as u32,
                            buffer_size: self.current_block_size as u32,
                            input_id: self
                                .device_manager
                                .active_input
                                .as_ref()
                                .and_then(|d| d.id.clone()),
                            output_id: self
                                .device_manager
                                .active_output
                                .as_ref()
                                .and_then(|d| d.id.clone()),
                        });
                    }
                    Err(error) => self.send_error(error.to_string()),
                }
            }
            Command::Stop => {
                self.stop_audio();
                self.send_response(Response::Success);
            }
            Command::LoadPlugin { path } => {
                // Delegated to PluginManager
                let (sample_rate, capacity, channels) = self.processor_setup();
                match self.plugin_manager.load_plugin(
                    &path,
                    sample_rate,
                    capacity,
                    channels,
                    self.output_stream.is_some(),
                ) {
                    Ok((id, name, index, processor_opt)) => {
                        // If Audio Thread is active and manager returned a processor, push it
                        if let Some(proc) = processor_opt {
                            let initial_gain = *self.plugin_manager.gains.get(&id).unwrap_or(&1.0);
                            self.queue_audio_msg(AudioThreadMessage::AddProcessor {
                                index,
                                processor: proc,
                                initial_gain,
                                initial_bypassed: self.plugin_manager.bypassed.contains(&id),
                                initial_muted: self.plugin_manager.muted.contains(&id),
                            });

                            if self.plugin_manager.bypassed.contains(&id) {
                                self.queue_audio_msg(AudioThreadMessage::SetBypass {
                                    index,
                                    active: true,
                                });
                            }
                            if self.plugin_manager.muted.contains(&id) {
                                self.queue_audio_msg(AudioThreadMessage::SetMute {
                                    index,
                                    active: true,
                                });
                            }

                            self.queue_audio_msg(self.make_reorder_message());
                        }
                        self.send_response(Response::PluginLoaded {
                            id,
                            name,
                            vendor: "".to_string(),
                        });
                    }
                    Err(e) => self.send_error(e.to_string()),
                }
            }
            Command::RestorePlugin {
                request,
                operation_id,
                expires_at_ms,
            } => {
                match super::restoration::StagedRestore::load(request, operation_id, expires_at_ms)
                    .map(|mut staged| {
                        staged.expected_rack_revision = session_expected_ids
                            .as_ref()
                            .map(|_| self.session_rack_revision);
                        staged.expected_ids = session_expected_ids;
                        staged
                    }) {
                    Ok(staged) if staged.instance.needs_deferred_connection() => {
                        self.pending_restore = Some(staged);
                    }
                    Ok(staged) => self.finish_plugin_restore(staged),
                    Err(error) => self.send_error(error.to_string()),
                }
            }
            Command::UnloadPlugin { id } => {
                // 遅延アンロード時も、親 HWND の破棄前にエディタを切断する。
                if let Some(instance) = self.plugin_manager.get_mut(&id) {
                    instance.close_editor();
                }
                self.editor_manager.close_editor(&id);

                if self.output_stream.is_some() {
                    match self.plugin_manager.begin_unload(&id) {
                        Ok(index) => {
                            self.queue_audio_msg(AudioThreadMessage::RemoveProcessor { index });
                            self.queue_audio_msg(self.make_reorder_message());
                            self.send_response(Response::Success);
                        }
                        Err(e) => self.send_error(e.to_string()),
                    }
                } else {
                    match self.plugin_manager.remove_plugin(&id) {
                        Ok(_) => self.send_response(Response::Success),
                        Err(e) => self.send_error(e.to_string()),
                    }
                }
            }
            Command::ReorderPlugins { order } => match self.plugin_manager.reorder_plugins(order) {
                Ok(()) => {
                    self.queue_audio_msg(self.make_reorder_message());
                    self.send_response(Response::Success);
                }
                Err(error) => self.send_error(error.to_string()),
            },
            Command::OpenEditor { id } => {
                // Delegated to EditorManager, but needs Instance from PluginManager
                match self.plugin_manager.get_mut(&id) {
                    Some(instance) => match self.editor_manager.open_editor(instance, target) {
                        Ok(_) => self.send_response(Response::Success),
                        Err(e) => self.send_error(format!("Failed to open editor: {}", e)),
                    },
                    None => self.send_error("Plugin not found".to_string()),
                }
            }
            Command::SetBypass { id, active } => {
                let Some(index) = self.plugin_manager.rt_index_of(&id) else {
                    self.send_error("Plugin not found".into());
                    return;
                };
                if active {
                    self.plugin_manager.bypassed.insert(id.clone());
                } else {
                    self.plugin_manager.bypassed.remove(&id);
                }
                self.queue_audio_msg(AudioThreadMessage::SetBypass { index, active });
                self.send_response(Response::Success);
            }
            Command::SetMute { id, active } => {
                let Some(index) = self.plugin_manager.rt_index_of(&id) else {
                    self.send_error("Plugin not found".into());
                    return;
                };
                if active {
                    self.plugin_manager.muted.insert(id.clone());
                } else {
                    self.plugin_manager.muted.remove(&id);
                }
                self.queue_audio_msg(AudioThreadMessage::SetMute { index, active });
                self.send_response(Response::Success);
            }
            Command::SetGain { id, value } => {
                let Some(index) = self.plugin_manager.rt_index_of(&id) else {
                    self.send_error("Plugin not found".into());
                    return;
                };
                self.plugin_manager.gains.insert(id.clone(), value);
                self.queue_audio_msg(AudioThreadMessage::SetGain { index, value });
                self.send_response(Response::Success);
            }
            Command::SetGlobalMute { active } => {
                self.set_global_mute_intent(active);
                self.send_response(Response::Success);
            }
            Command::SetGlobalBypass { active } => {
                self.global_bypass = active;
                self.queue_audio_msg(AudioThreadMessage::SetGlobalBypass(active));
                self.send_response(Response::Success);
            }
            Command::SetInputGain { value } => {
                self.builtin
                    .invalidate_history_with_reason(super::history::Reason::InputChanged);
                self.voice_input_gain = value;
                self.queue_audio_msg(AudioThreadMessage::SetInputGain(value));
                self.send_response(Response::Success);
            }
            Command::SetNoiseReduction { active, mode } => {
                let normalized_mode = normalize_noise_control_mode(mode.as_deref());
                let rate = self
                    .output_stream
                    .as_ref()
                    .map(|_| self.current_sample_rate as u32);
                match self.apply_noise_intent(
                    active,
                    normalized_mode,
                    self.noise_control_strength,
                    self.noise_voice_guard,
                    rate,
                ) {
                    Ok(()) => {
                        self.invalidate_noise_history(super::history::Reason::SettingsChanged);
                        self.send_response(Response::Success);
                    }
                    Err(error) => self.send_error(error.into()),
                }
            }
            Command::StartNoiseLearning { duration_ms } => {
                match self.begin_noise_learning(duration_ms) {
                    Ok(()) => self.send_response(Response::Success),
                    Err(error) => self.send_error(error.to_string()),
                }
            }
            Command::NoiseMeasurement { request } => {
                match self.noise_measurement_request(request) {
                    Ok(snapshot) => {
                        self.send_response(Response::NoiseMeasurement(Box::new(snapshot)))
                    }
                    Err(error) => self.send_error(error),
                }
            }
            Command::CancelNoiseLearning => {
                self.invalidate_noise_measurement("cancelled");
                if self.output_stream.is_some() {
                    self.queue_audio_msg(AudioThreadMessage::CancelNoiseLearning);
                } else {
                    self.noise_learning.cancel_capture();
                }
                self.send_response(Response::Success);
            }
            Command::SetNoiseControlConfig {
                active,
                mode,
                strength,
                voice_guard,
            } => {
                if !strength.is_finite() {
                    self.send_error("ノイズ低減の抑制強度が不正です".into());
                    return;
                }
                let normalized_mode = normalize_noise_control_mode(Some(mode.as_str()));
                let rate = self
                    .output_stream
                    .as_ref()
                    .map(|_| self.current_sample_rate as u32);
                match self.apply_noise_intent(active, normalized_mode, strength, voice_guard, rate)
                {
                    Ok(()) => {
                        self.invalidate_noise_history(super::history::Reason::SettingsChanged);
                        self.send_response(Response::Success);
                    }
                    Err(error) => self.send_error(error.into()),
                }
            }
            Command::SetBuiltInEffects {
                active,
                preset,
                amount,
                singing,
                reverb,
            } => {
                let normalized_preset = normalize_built_in_effects_preset(preset.as_deref());
                match self.legacy_builtin(active, normalized_preset, amount, singing, reverb) {
                    Ok(()) => {
                        self.live_modes.custom();
                        self.publish_builtin();
                        self.send_response(Response::Success);
                    }
                    Err(error) => self.send_error(error),
                }
            }
            Command::BuiltinEffects { request } => match self.builtin_command(request) {
                Ok(snapshot) => self.send_response(Response::BuiltinEffects(snapshot)),
                Err(error) => self.send_error(error),
            },
            Command::SetLoudnessMeasurement { id } => {
                if self.output_stream.is_none() {
                    self.send_response(Response::Error(
                        "音声を開始してから測定してください".into(),
                    ));
                } else {
                    self.queue_audio_msg(AudioThreadMessage::SetLoudnessMeasurement(id));
                    self.send_response(Response::Success);
                }
            }
            Command::SetOutputGain { value } => match self.request_output_gain(value) {
                Ok(()) => self.send_response(Response::Success),
                Err(e) => self.send_error(e.to_string()),
            },
            Command::SetInputChannels { left, right } => {
                let [left, right] = normalized_channels(
                    self.current_host_is_asio,
                    [left, right],
                    self.current_channels,
                );
                self.builtin
                    .invalidate_history_with_reason(super::history::Reason::InputChanged);
                self.input_channel_l = left;
                self.input_channel_r = right;
                self.queue_audio_msg(AudioThreadMessage::SetInputChannels(left, right));
                self.send_response(Response::Success);
            }
            Command::SetChannelScan { active } => {
                self.scan_enabled = active;
                self.queue_audio_msg(AudioThreadMessage::SetChannelScan(active));
                self.send_response(Response::Success);
            }
            Command::StartVoiceCheckRecording { max_ms } => {
                if self.output_stream.is_none() || self.stream_failed.load(Ordering::Acquire) {
                    self.send_response(Response::Error(
                        "音声エンジンが起動していません".to_string(),
                    ));
                    return;
                }
                if !(8_000.0..=192_000.0).contains(&self.current_sample_rate) {
                    self.send_error(
                        "このサンプルレートではボイスチェックを録音できません（8〜192 kHz対応）"
                            .into(),
                    );
                    return;
                }
                self.voice_preview.interrupt(false);
                let Some(recording_id) = self.voice_recording_id.checked_add(1) else {
                    self.send_error("録音IDが上限です。音声エンジンを開き直してください".into());
                    return;
                };
                self.invalidate_noise_history(super::history::Reason::NewMeasurement);
                self.voice_recording_id = recording_id;
                self.voice_metadata = Some(voice_preview::Metadata {
                    recording_id,
                    revision: self.voice_revision,
                    sample_rate: self.current_sample_rate as u32,
                    buffer_size: self.current_block_size as u32,
                    host: if self.current_host_is_asio {
                        "ASIO"
                    } else {
                        "WASAPI"
                    }
                    .into(),
                    input_channels: [self.input_channel_l, self.input_channel_r],
                    input_gain: self.voice_input_gain,
                    noise_enabled: self.noise_reduction_enabled,
                    noise_mode: self.noise_control_mode.as_str().into(),
                    noise_strength: self.noise_control_strength,
                    voice_guard: self.noise_voice_guard,
                    built_in_enabled: self.built_in_effects_enabled,
                    built_in_preset: self.built_in_effects_preset.as_str().into(),
                    built_in_amount: self.built_in_effects_amount,
                    singing: self.builtin.config.singing,
                    reverb: self.builtin.config.reverb,
                    global_bypass: self.global_bypass,
                    plugins: self
                        .plugin_manager
                        .order
                        .iter()
                        .filter_map(|id| {
                            self.plugin_manager.get(id).map(|plugin| {
                                voice_preview::PluginCondition {
                                    id: id.clone(),
                                    name: plugin.name.clone(),
                                    enabled: !self.plugin_manager.bypassed.contains(id),
                                    muted: self.plugin_manager.muted.contains(id),
                                    gain: *self.plugin_manager.gains.get(id).unwrap_or(&1.0),
                                }
                            })
                        })
                        .collect(),
                    changed_during_recording: false,
                    raw_tap: "post_input_gain_and_channel_selection_pre_fx".into(),
                    processed_tap: if self.live_output_config.split_processing {
                        "broadcast_post_fx_pre_common_output_gain_and_global_mute"
                    } else {
                        "post_fx_pre_output_gain_and_global_mute"
                    }
                    .into(),
                    vst_parameters_verified: false,
                });
                let max_ms = max_ms.clamp(500, super::voice_check::VOICE_CHECK_MAX_MS);
                let sample_rate_hz =
                    self.current_sample_rate.round().clamp(8_000.0, 192_000.0) as u32;
                let max_frames = ((max_ms as f64 * sample_rate_hz as f64) / 1000.0).round() as u64;
                let buffers = Arc::new(allocate_voice_check_buffers(max_ms, sample_rate_hz));
                self.voice_check_buffers.replace(buffers.clone());
                self.voice_check
                    .sample_rate_hz
                    .store(sample_rate_hz, Ordering::Relaxed);
                self.voice_check
                    .max_frames
                    .store(max_frames, Ordering::Relaxed);
                self.voice_check.duration_frames.store(0, Ordering::Relaxed);
                self.voice_check.playback_frame.store(0, Ordering::Relaxed);
                self.voice_check
                    .envelope_dirty
                    .store(false, Ordering::Relaxed);
                self.voice_check
                    .state
                    .store(VC_STATE_RECORDING, Ordering::Relaxed);
                self.queue_audio_msg(AudioThreadMessage::StartVoiceCheckRecording {
                    buffers,
                    max_frames,
                });
                self.send_response(Response::Success);
            }
            Command::StopVoiceCheckRecording => {
                if self.output_stream.is_some() {
                    self.queue_audio_msg(AudioThreadMessage::StopVoiceCheckRecording);
                }
                self.send_response(Response::Success);
            }
            Command::PlayVoiceCheck {
                source,
                loop_playback,
            } => {
                if self.output_stream.is_none() || self.stream_failed.load(Ordering::Acquire) {
                    self.send_error("音声エンジンを開始してから再生してください".into());
                    return;
                }
                let parsed = parse_voice_check_source(&source);
                self.voice_check
                    .loop_playback
                    .store(loop_playback, Ordering::Relaxed);
                self.queue_audio_msg(AudioThreadMessage::PlayVoiceCheck {
                    source: parsed,
                    loop_playback,
                });
                self.send_response(Response::Success);
            }
            Command::StopVoiceCheckPlayback => {
                if self.output_stream.is_some() {
                    self.queue_audio_msg(AudioThreadMessage::StopVoiceCheckPlayback);
                }
                self.send_response(Response::Success);
            }
            Command::ExportVoiceCheck { path, source } => {
                match self.voice_check_buffers.current() {
                    Some(buffers) => {
                        match export_voice_check_wav(std::path::Path::new(&path), buffers, &source)
                        {
                            Ok(()) => self.send_response(Response::Success),
                            Err(e) => self.send_response(Response::Error(e.to_string())),
                        }
                    }
                    None => self.send_response(Response::Error(
                        "録音バッファが初期化されていません".to_string(),
                    )),
                }
            }
            Command::GetRuntimeStats => {
                let (active_plugin_count, pending_unload_count, burned_library_count) =
                    self.plugin_manager.runtime_stats();
                let enabled_plugin_count =
                    self.plugin_manager.enabled_plugin_count(self.global_bypass);
                let latency_report = self.plugin_manager.latency_report(self.global_bypass);
                let total_plugin_latency_samples = latency_report.0;
                let noise_reduction_latency_samples = if self.noise_reduction_enabled {
                    ((self.current_sample_rate / 100.0).round() as u32).max(1)
                } else {
                    0
                };
                let total_chain_latency_samples =
                    total_plugin_latency_samples.saturating_add(noise_reduction_latency_samples);
                let total_plugin_latency_ms = if self.current_sample_rate > 0.0 {
                    (total_plugin_latency_samples as f64 * 1000.0) / self.current_sample_rate
                } else {
                    0.0
                };
                let noise_reduction_latency_ms = if self.current_sample_rate > 0.0 {
                    (noise_reduction_latency_samples as f64 * 1000.0) / self.current_sample_rate
                } else {
                    0.0
                };
                let total_chain_latency_ms = if self.current_sample_rate > 0.0 {
                    (total_chain_latency_samples as f64 * 1000.0) / self.current_sample_rate
                } else {
                    0.0
                };
                self.send_response(Response::RuntimeStats {
                    preparation: Some(Box::new(self.preparation_snapshot())),
                    active_plugin_count,
                    enabled_plugin_count,
                    pending_unload_count,
                    burned_library_count,
                    global_bypass: self.global_bypass,
                    callback_diagnostics: Box::new(self.callback_diagnostics.snapshot()),
                    queue_diagnostics: self.queue_snapshot().map(Box::new),
                    latency_metadata: Some(Box::new(self.latency_metadata(latency_report))),
                    frame_timing: self
                        .frame_timing
                        .as_ref()
                        .and_then(|timing| timing.raw_snapshot().map(Box::new)),
                    resampler_batch_timing: self
                        .frame_timing
                        .as_ref()
                        .and_then(|timing| timing.batch_snapshot().map(Box::new)),
                    resampler_cohort_timing: self
                        .frame_timing
                        .as_ref()
                        .and_then(|t| t.cohort_snapshot().map(Box::new)),
                    max_jitter_us: self.stats_max_jitter.load(Ordering::Relaxed),
                    glitch_count: self.stats_glitches.load(Ordering::Relaxed),
                    total_plugin_latency_samples,
                    total_plugin_latency_ms,
                    noise_reduction_latency_samples,
                    noise_reduction_latency_ms,
                    total_chain_latency_samples,
                    total_chain_latency_ms,
                    noise_reduction_enabled: self.noise_reduction_enabled,
                    noise_reduction_active: self.noise_reduction_enabled,
                    noise_reduction_mode: self.noise_control_mode.as_str().to_string(),
                    noise_learning_state: self.noise_learning.state_label().to_string(),
                    noise_learning_progress: self.noise_learning.progress(),
                    noise_profile_available: self
                        .noise_learning
                        .profile_valid
                        .load(Ordering::Acquire),
                    noise_profile_rms: self.noise_learning.profile_rms(),
                    recommended_noise_mix: self.noise_learning.recommended_mix(),
                    speech_detected: self.noise_learning.speech_detected.load(Ordering::Relaxed),
                    noise_voice_guard: self.noise_voice_guard,
                    noise_control_strength: self.noise_control_strength,
                    built_in_effects_enabled: self.built_in_effects_enabled,
                    built_in_effects_preset: self.built_in_effects_preset.as_str().to_string(),
                    built_in_effects_amount: self.built_in_effects_amount,
                    built_in_singing: self.builtin.config.singing,
                    built_in_reverb: self.builtin.config.reverb,
                });
            }
            Command::CaptureBundleState => match self.capture_bundle_state() {
                Ok(snapshot) => self.send_response(Response::BundleState(Box::new(snapshot))),
                Err(error) => self.send_error(error.to_string()),
            },
            Command::GetPluginRack => self.send_response(self.session_rack_snapshot()),
            Command::RestoreSessionPlugin { .. } => unreachable!("entryで既存復元へ変換済み"),
            Command::GetPluginState { id } => match self.plugin_manager.get(&id) {
                Some(instance) => match instance.get_state() {
                    Ok(state) => self.send_response(Response::PluginState { id, state }),
                    Err(e) => self.send_error(format!("Failed to get state: {}", e)),
                },
                None => self.send_error("Plugin not found".to_string()),
            },
            Command::SetPluginState { id, state } => {
                if self.output_stream.is_some() {
                    self.send_error("音声を停止してからVST状態を適用してください".into());
                } else {
                    match self.plugin_manager.get(&id) {
                        Some(instance) => match instance.set_state(&state) {
                            Ok(_) => self.send_response(Response::Success),
                            Err(e) => self.send_error(format!("Failed to set state: {}", e)),
                        },
                        None => self.send_error("Plugin not found".to_string()),
                    }
                }
            }
            Command::PlayTestTone {
                freq_hz,
                duration_ms,
                level_db,
            } => {
                if self.output_stream.is_none() {
                    self.send_error("オーディオエンジンが起動していません".to_string());
                    return;
                }
                self.queue_audio_msg(AudioThreadMessage::StopVoiceCheckPlayback);
                self.queue_audio_msg(AudioThreadMessage::PlayTestTone {
                    freq_hz,
                    duration_ms,
                    level_db,
                });
                self.send_response(Response::Success);
            }
            Command::StopTestTone => {
                self.queue_audio_msg(AudioThreadMessage::StopTestTone);
                self.send_response(Response::Success);
            }
            Command::ProbeLoopback {
                input_device,
                duration_ms,
                freq_hz,
            } => {
                let result = self.probe_loopback(&input_device, duration_ms, freq_hz);
                self.send_response(Response::LoopbackProbe {
                    detected: result.detected,
                    level_db: result.level_db,
                    unavailable: result.unavailable,
                });
            }
        }
    }

    fn probe_loopback(
        &mut self,
        input_device: &str,
        duration_ms: u32,
        freq_hz: f32,
    ) -> LoopbackProbeOutcome {
        if self.output_stream.is_none() {
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

    #[allow(deprecated)]
    fn start_audio_attempt(
        &mut self,
        request: AudioStartRequest,
        policy: lifecycle::StartupPolicy,
    ) -> Result<()> {
        let AudioStartRequest {
            host_name,
            input_name,
            output_name,
            sample_rate,
            buffer_size,
            device_ids,
        } = request;
        self.builtin
            .invalidate_history_with_reason(super::history::Reason::StreamChanged);
        if self.output_stream.is_some() || self.input_stream.is_some() {
            self.stop_audio();
        }

        self.send_event(EngineEvent::Log(format!(
            "Start Audio Request: Host={:?}, Input={:?}, Output={:?}, SR={:?}, Buf={:?}",
            host_name, input_name, output_name, sample_rate, buffer_size
        )));

        let host_name_str = host_name
            .as_deref()
            .ok_or_else(|| anyhow!("Host name not specified"))?;
        let resolving_started = Instant::now();
        let host_id_str = match host_name_str {
            "ASIO" => cpal::HostId::Asio,
            "Wasapi" | "WASAPI" => cpal::HostId::Wasapi,
            _ => return Err(anyhow!("Unsupported host: {}", host_name_str)),
        };
        let host =
            cpal::host_from_id(host_id_str).map_err(|e| anyhow!("Failed to init host: {}", e))?;

        // 1. Resolve Devices (Delegated to DeviceManager)
        for id in [&device_ids.0, &device_ids.1].into_iter().flatten() {
            if id.is_empty() || id.len() > 4096 || id.chars().any(char::is_control) {
                return Err(anyhow!("機器の識別情報が不正です"));
            }
        }
        let in_dev = if let Some(id) = &device_ids.0 {
            DeviceManager::resolve_input_device_by_id(&host, id)
                .ok_or_else(|| anyhow!("入力機器のIDを確認できません。機器を選び直してください"))?
        } else if let Some(name) = &input_name {
            DeviceManager::resolve_input_device(&host, name)
                .ok_or_else(|| anyhow!("Input device not found: {}", name))?
        } else {
            host.default_input_device()
                .ok_or_else(|| anyhow!("No default input device"))?
        };

        let out_dev = if let Some(id) = &device_ids.1 {
            DeviceManager::resolve_output_device_by_id(&host, id)
                .ok_or_else(|| anyhow!("出力機器のIDを確認できません。機器を選び直してください"))?
        } else if let Some(name) = &output_name {
            DeviceManager::resolve_output_device(&host, name)
                .ok_or_else(|| anyhow!("Output device not found: {}", name))?
        } else {
            host.default_output_device()
                .ok_or_else(|| anyhow!("No default output device"))?
        };
        let is_asio = host_id_str == cpal::HostId::Asio;
        let (in_dev, out_dev) =
            DeviceManager::coordinated_pair(in_dev, out_dev, is_asio, |device: &cpal::Device| {
                device.id().map_err(Into::into)
            })?;
        DeviceManager::verify_selected_ids(
            &device_ids,
            in_dev.id().ok().map(|id| id.to_string()),
            out_dev.id().ok().map(|id| id.to_string()),
        )?;
        self.noise_input_identity = in_dev.id().ok().map(|id| id.to_string());

        log::debug!(
            "[StartupPhase] phase=device_resolve us={}",
            resolving_started.elapsed().as_micros()
        );
        let out_capabilities = capabilities::timed("capability_output", || {
            capabilities::CapabilitySnapshot::capture(
                || out_dev.default_output_config().map_err(Into::into),
                || out_dev.supported_output_configs().map_err(Into::into),
            )
        })?;
        let in_capabilities = capabilities::timed("capability_input", || {
            capabilities::CapabilitySnapshot::capture(
                || in_dev.default_input_config().map_err(Into::into),
                || in_dev.supported_input_configs().map_err(Into::into),
            )
        })?;
        let mut out_stream_config = out_capabilities.output_config(sample_rate, buffer_size);
        // まず既定入力を保持し、実際の出力rateとbufferが決まってから同率を検討する。
        let mut in_stream_config = in_capabilities.input_config(buffer_size);
        if is_asio {
            match in_capabilities.asio_input_config(
                &out_capabilities,
                &in_stream_config,
                &out_stream_config,
            ) {
                Ok(config) => in_stream_config = config,
                Err(error) => {
                    if let Some(next_policy) = policy.retry_default_output() {
                        let fallback_rate = out_capabilities.default_rate();
                        lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                            self.clear_audio_resources()
                        });
                        return self.start_audio_attempt(
                            AudioStartRequest {
                                host_name,
                                input_name,
                                output_name,
                                sample_rate: Some(fallback_rate),
                                buffer_size: None,
                                device_ids: device_ids.clone(),
                            },
                            next_policy,
                        );
                    }
                    return Err(error);
                }
            }
        }

        dsp::NoiseGeometry::guard(out_stream_config.sample_rate, self.noise_reduction_enabled)
            .map_err(|e| anyhow!(e))?;
        self.current_sample_rate = out_stream_config.sample_rate as f64;
        self.current_block_size = match out_stream_config.buffer_size {
            cpal::BufferSize::Fixed(s) => s as usize,
            _ => 512,
        };
        self.current_channels = out_stream_config.channels as usize;
        self.current_host_is_asio = is_asio;
        self.normalize_start_channels();

        // Force detection of Locked Buffer Size (ASIO)
        let default_max_block = out_capabilities.default_buffer_range().map(|(_, max)| max);
        if let Some((min, max)) = out_capabilities.default_buffer_range() {
            log::debug!("[Config] Device Buffer Range: min={}, max={}", min, max);
            if let Some(locked) = out_capabilities.locked_buffer_override(self.current_block_size) {
                log::info!(
                    "[Config] Detected Locked Buffer Size override: {} -> {}",
                    self.current_block_size,
                    locked
                );
                self.current_block_size = locked as usize;
                out_stream_config.buffer_size = cpal::BufferSize::Fixed(locked);
                in_stream_config.buffer_size = cpal::BufferSize::Fixed(locked);
            }
        }

        // ASIOの最後のprepareで別bufferを再適用しない。locked補正後の出力を正本にする。
        if is_asio {
            in_stream_config.buffer_size = out_stream_config.buffer_size;
        }
        let preferred_input = policy
            .prefer_same_rate_input(self.current_host_is_asio)
            .then(|| {
                in_capabilities.same_rate_input(&in_stream_config, out_stream_config.sample_rate)
            })
            .flatten();
        let used_preferred_input = preferred_input.is_some();
        if let Some(config) = preferred_input {
            in_stream_config = config;
        }
        // 起動試行の選択結果だけを非RTで記録する。実機の同率受理はbuild/play成功と照合する。
        log::debug!(
            "[Config] Selected rates: input={} output={} input_channels={} preferred_input={}",
            in_stream_config.sample_rate,
            out_stream_config.sample_rate,
            in_stream_config.channels,
            used_preferred_input
        );

        // 今回の要求・固定サイズ検出後に全処理段の上限を揃える。
        let effective_fixed_block = match out_stream_config.buffer_size {
            cpal::BufferSize::Fixed(frames) => Some(frames),
            cpal::BufferSize::Default => None,
        };
        self.fixed_buffer_request_frames = effective_fixed_block;
        self.configure_processing_capacity(effective_fixed_block, default_max_block)?;

        // Register active devices with DeviceManager for OOP scan merge
        // This ensures the currently used device appears in device list even when OOP scanner can't see it
        {
            use crate::ipc::DeviceInfo;

            let in_channels = in_capabilities.max_channels();
            let out_channels = out_capabilities.max_channels();
            let in_buf_range = in_capabilities.buffer_range();
            let out_buf_range = out_capabilities.buffer_range();
            let in_name = input_name
                .clone()
                .unwrap_or_else(|| in_dev.name().unwrap_or_default());
            let out_name = output_name
                .clone()
                .unwrap_or_else(|| out_dev.name().unwrap_or_default());

            self.device_manager.set_active_input(DeviceInfo {
                name: in_name,
                host: host_name_str.to_string(),
                id: in_dev.id().ok().map(|id| id.to_string()),
                is_input: true,
                buffer_size_range: in_buf_range,
                channels: in_channels,
                is_default: false,
            });

            self.device_manager.set_active_output(DeviceInfo {
                name: out_name,
                host: host_name_str.to_string(),
                id: out_dev.id().ok().map(|id| id.to_string()),
                is_input: false,
                buffer_size_range: out_buf_range,
                channels: out_channels,
                is_default: false,
            });
        }

        // Error Handler
        let output_failed = self.stream_failed.clone();
        let err_fn_ipc = move |err: cpal::StreamError| {
            output_failed.store(true, Ordering::Release);
            let msg = OutputMessage::Event(EngineEvent::Error(format!("Stream Error: {}", err)));
            if let Ok(json) = serde_json::to_string(&msg) {
                println!("IPC:{}", json);
                let _ = io::stdout().flush();
            }
        };

        // Init Ring Buffers
        let ring = HeapRb::<AudioThreadMessage>::new(32);
        let (producer, mut consumer) = ring.split();
        self.command_tx = Some(producer);

        let retire_rb = HeapRb::<DisposedProcessor>::new(32);
        let (mut retire_prod, retire_cons) = retire_rb.split();
        self.retire_rx = Some(retire_cons);

        let level_rb = HeapRb::<MeterLevels>::new(4096);
        let (mut level_prod, level_cons) = level_rb.split();
        self.level_rx = Some(level_cons);
        let loudness_rb = HeapRb::<LoudnessReading>::new(64);
        let (mut loudness_prod, loudness_cons) = loudness_rb.split();
        self.loudness_rx = Some(loudness_cons);
        let mut rt_loudness = LoudnessMeter::new(self.current_sample_rate as u32);
        let mut loudness_start = super::queue_recovery::MeasurementGate::default();

        let channel_rb = HeapRb::<[f32; 32]>::new(16); // Small buffer for low-rate scan data
        let (mut channel_prod, channel_cons) = channel_rb.split();
        self.channel_rx = Some(channel_cons);

        let audio_rb_size = (self.current_sample_rate as usize / 2) * 2;
        let audio_rb = Arc::new(HeapRb::<f32>::new(audio_rb_size.max(8192)));
        self.queue_attempt = self
            .queue_attempt
            .checked_add(1)
            .ok_or_else(|| anyhow!("queue観測世代の上限です"))?;
        let queue_diagnostics = Arc::new(QueueDiagnostics::new(
            format!(
                "{}:queue:{}",
                self.builtin.snapshot(false).epoch,
                self.queue_attempt
            ),
            in_stream_config.sample_rate,
            out_stream_config.sample_rate,
            in_stream_config.channels,
            out_stream_config.channels,
            audio_rb.capacity().get(),
        ));
        self.queue_diagnostics = Some(queue_diagnostics.clone());
        self.queue_observer = Some(audio_rb.clone());
        self.queue_state = QueueState::Preparing;
        self.queue_slots_at_stop = None;
        // 同率の原点・recorder構築位置は従来どおり。異率は変換準備後に別modeで構築する。
        let (mut input_timing, mut output_timing) =
            if in_stream_config.sample_rate == out_stream_config.sample_rate {
                let (timing, input, output) = super::frame_timing::Observer::new(
                    format!(
                        "{}:queue:{}",
                        self.builtin.snapshot(false).epoch,
                        self.queue_attempt
                    ),
                    self.queue_attempt,
                    true,
                );
                self.frame_timing = Some(timing);
                (input, output)
            } else {
                self.frame_timing = None;
                (None, None)
            };
        let output_queue_diagnostics = queue_diagnostics.clone();
        let input_queue_diagnostics = queue_diagnostics;
        let mut queue_recovery = super::queue_recovery::Recovery::new(
            audio_rb.capacity().get() / out_stream_config.channels as usize,
            out_stream_config.sample_rate as usize,
            1,
            3,
        );
        let (mut audio_prod, mut audio_cons) = audio_rb.split();

        // 3. Prepare Processors (Delegated to PluginManager)
        let (sample_rate, capacity, channels) = self.processor_setup();
        let processors_vec = capabilities::timed("processor_prepare", || {
            self.plugin_manager
                .prepare_for_audio_start(sample_rate, channels, capacity)
        });
        let mut processors_vec = processors_vec?;

        // Pre-compute RT state (no heap in callback)
        let mut rt_bypassed: [bool; MAX_PLUGINS] = [false; MAX_PLUGINS];
        for id in &self.plugin_manager.bypassed {
            if let Some(idx) = self.plugin_manager.rt_index_of(id) {
                rt_bypassed[idx as usize] = true;
            }
        }

        let mut rt_muted: [bool; MAX_PLUGINS] = [false; MAX_PLUGINS];
        for id in &self.plugin_manager.muted {
            if let Some(idx) = self.plugin_manager.rt_index_of(id) {
                rt_muted[idx as usize] = true;
            }
        }

        let mut rt_gains: [Smoother; MAX_PLUGINS] = std::array::from_fn(|_| Smoother::new(1.0));
        for (id, val) in &self.plugin_manager.gains {
            if let Some(idx) = self.plugin_manager.rt_index_of(id) {
                rt_gains[idx as usize] = Smoother::new(*val);
            }
        }

        let mut rt_order: [u8; MAX_PLUGINS] = [u8::MAX; MAX_PLUGINS];
        let mut rt_order_len: usize = 0;
        for id in &self.plugin_manager.order {
            if rt_order_len >= MAX_PLUGINS {
                break;
            }
            if let Some(idx) = self.plugin_manager.rt_index_of(id) {
                rt_order[rt_order_len] = idx;
                rt_order_len += 1;
            }
        }

        let channels_len = out_stream_config.channels as usize;
        let max_ch = channels_len.max(2);
        let max_frames_per_callback = self.processing_block_capacity;

        // RT State Setup (fixed-capacity / no resize in callback)
        let max_len = max_frames_per_callback.saturating_mul(channels_len.max(1));
        let mut input_buf = vec![0.0; max_len];

        // Planar Buffers (fixed-capacity for callback upper bound)
        let mut planar_buf_a: Vec<Vec<f32>> = (0..max_ch)
            .map(|_| vec![0.0; max_frames_per_callback])
            .collect();
        let mut planar_buf_b: Vec<Vec<f32>> = (0..max_ch)
            .map(|_| vec![0.0; max_frames_per_callback])
            .collect();

        let mut rt_processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        let mut rt_active_count: usize = 0;
        while let Some((idx, proc)) = processors_vec.pop() {
            let slot = idx as usize;
            if slot < MAX_PLUGINS && rt_processors[slot].is_none() {
                rt_processors[slot] = Some(proc);
                rt_active_count += 1;
            }
        }

        self.peak_shared
            .publish(self.peak_config.prepare(self.current_sample_rate as u32));
        let peak_shared = self.peak_shared.clone();
        let mut rt_peak =
            super::peak_protection::Rt::new(self.peak_config, self.current_sample_rate as u32);
        let (mut rt_global_mute, mut rt_input_gain, mut rt_output_gain) =
            self.initial_callback_levels();
        let mut rt_global_bypass = self.global_bypass;
        self.stream_failed.store(false, Ordering::Release);
        self.gain_main_device = out_dev.id().ok().map(|id| id.to_string());
        let (capture_tx, capture_rx) = auto_gain::capture_queue();
        self.gain_capture_rx = Some(capture_rx);
        let mut rt_capture = auto_gain::RtCapture::new(
            self.gain_shared.clone(),
            capture_tx,
            self.current_sample_rate as u32,
        );
        let mut rt_input_l = self.input_channel_l;
        let mut rt_input_r = self.input_channel_r;
        let mut rt_scan_enabled = self.scan_enabled;
        let rt_sample_rate_hz = self.current_sample_rate.round().clamp(8_000.0, 192_000.0) as u32;
        let mut rt_noise_control = RtNoiseControl::prepare(
            self.current_sample_rate as u32,
            NoiseSettings {
                enabled: self.noise_reduction_enabled,
                mode: self.noise_control_mode,
                strength: self.noise_control_strength,
                voice_guard: self.noise_voice_guard,
            },
        );
        let mut rt_noise_learning = RtNoiseLearning::new(self.noise_learning.clone());
        let (initial_builtin, _) = self.initial_builtin()?;
        let mut rt_voice = super::live_modes::RtVoice::new(
            super::live_modes::Voice::prepare(
                &initial_builtin,
                self.current_sample_rate.round().clamp(8_000.0, 384_000.0) as u32,
            )
            .map_err(|error| anyhow!(error))?,
        );
        let initial_live_revision = self.live_modes.start();
        let mut initial_live_ack = false;
        let mut rt_cohort_change_applied = false;
        let live_shared = self.live_modes.shared.clone();
        let builtin_applied = self.builtin.applied.clone();
        let noise_applied_revision = self.noise_applied_revision.clone();
        noise_applied_revision.store(self.noise_command_revision, Ordering::Release);
        let voice_check_shared = self.voice_check.clone();
        let mut rt_voice_check = RtVoiceCheck::new(voice_check_shared, rt_sample_rate_hz);
        if let Some(buffers) = self.voice_check_buffers.current().cloned() {
            rt_voice_check.attach_buffers(buffers);
        }
        let mut rt_test_tone = RtTestTone::new(rt_sample_rate_hz);

        let frames_counter = self.frames_processed.clone();

        let stats_max_jitter = Arc::new(AtomicU64::new(0));
        let stats_glitches = Arc::new(AtomicU64::new(0));
        self.stats_max_jitter = stats_max_jitter.clone();
        self.stats_glitches = stats_glitches.clone();

        let mut last_callback: Option<(Instant, usize)> = None;
        let callback_rate = self.current_sample_rate as u32;
        let callback_diagnostics = Arc::new(CallbackDiagnostics::default());
        self.callback_diagnostics = callback_diagnostics.clone();

        let mmcss_set_out = Arc::new(AtomicBool::new(false));
        let (mut callback_processors, returned_processors) = callback_owner(CallbackProcessors {
            reverb: super::reverb::Reverb::new(
                initial_builtin.reverb.unwrap_or_default(),
                callback_rate,
            )
            .map_err(|error| anyhow!(error))?,
            processors: rt_processors,
            pending_retire: std::array::from_fn(|_| None),
            pending_rejected: super::deferred_drop::DeferredDrop::new(),
        });
        self.processor_return = Some(returned_processors);
        self.resampling_failed.store(false, Ordering::Release);
        self.block_capacity_failed.store(false, Ordering::Release);
        self.nr_failed.store(false, Ordering::Release);
        let output_nr_failed = self.nr_failed.clone();
        let output_resampling_failed = self.resampling_failed.clone();
        let output_capacity_failed = self.block_capacity_failed.clone();
        let output_stream_failed = self.stream_failed.clone();

        fn remove_from_order(order: &mut [u8; MAX_PLUGINS], len: &mut usize, idx: u8) {
            let mut write = 0usize;
            for read in 0..*len {
                let v = order[read];
                if v != idx {
                    order[write] = v;
                    write += 1;
                }
            }
            *len = write;
        }

        // Output Stream Setup
        let retry_host_out = host_name.clone();
        let retry_input_out = input_name.clone();
        let retry_output_out = output_name.clone();

        // 入力の準備は両build前に完了させ、ASIOだけ入力を先に登録する。
        let retry_host_in = host_name.clone();
        let retry_input_in = input_name.clone();
        let retry_output_in = output_name.clone();

        let mmcss_set_in = Arc::new(AtomicBool::new(false));

        // レートが異なる場合は変換の準備成功を開始条件にする。
        let in_rate = in_stream_config.sample_rate as usize;
        let out_rate = out_stream_config.sample_rate as usize;
        let channels = in_stream_config.channels as usize;
        let out_channels_target = out_stream_config.channels as usize;

        let mut resampler = crate::audio_engine::resampling::prepare(in_rate, out_rate, channels)?;
        let batch_timing = resampler.is_some();
        if let Some(resampler) = &resampler {
            let (timing, input, output) = super::frame_timing::Observer::new_batch(
                format!(
                    "{}:queue:{}",
                    self.builtin.snapshot(false).epoch,
                    self.queue_attempt
                ),
                self.queue_attempt,
                resampler.timing_descriptor(),
            );
            self.frame_timing = Some(timing);
            input_timing = input;
            output_timing = output;
        }

        let monitor_levels = self.monitor_levels.clone();
        let mut live_sender = None;
        self.live_output_error = None;
        if let Some(device) = self.live_output_config.device_id.as_deref() {
            if channels_len != 2 {
                self.live_output_error = Some("二系統出力はstereo構成だけに対応しています".into());
            } else {
                match super::live_output::Sink::start(
                    device,
                    self.current_sample_rate as u32,
                    self.gain_main_device.as_deref(),
                    &self.live_output_config,
                    self.stream_failed.clone(),
                    (self.peak_config, self.peak_shared.clone()),
                    self.mode_silence.shared.clone(),
                ) {
                    Ok((sink, sender)) => {
                        sink.mute(self.global_mute);
                        self.live_output = Some(sink);
                        live_sender = Some(sender);
                    }
                    Err(error) => {
                        self.live_output_error = Some(error.to_string());
                    }
                }
            }
        }
        let separated = self.live_output_config.split_processing;
        let mut monitor_renderer = None;
        let mut broadcast_queue = None;
        let mut worker_controls = None;
        let mut broadcast_recovery_gains = None;
        let mut upstream_recovery = vec![1.0f32; max_frames_per_callback];
        if separated {
            anyhow::ensure!(channels_len == 2, "処理分離の出力構成を開始できません");
            let queue = Arc::new(HeapRb::<f32>::new(
                (self.current_sample_rate as usize / 5).max(2) * 2,
            ));
            let (tx, rx) = queue.clone().split();
            let original_consumer = std::mem::replace(&mut audio_cons, rx);
            let mode = self
                .live_modes
                .snapshot(self.builtin.snapshot(false).epoch, false)
                .target;
            let (controller, renderer, gains) = super::split_monitor::Controller::prepare(
                original_consumer,
                tx,
                output_timing.take(),
                output_queue_diagnostics.clone(),
                max_frames_per_callback,
                &self.live_output_config,
                self.current_sample_rate as u32,
                self.voice_input_gain,
                self.output_gain,
                [self.input_channel_l, self.input_channel_r],
                self.global_mute,
                self.global_bypass,
                self.monitor_levels.clone(),
                self.stream_failed.clone(),
                mode,
                initial_live_revision,
                (self.peak_config, self.peak_shared.clone()),
            )?;
            if self.live_output.is_none() {
                controller.shared.failed.store(true, Ordering::Release);
            }
            worker_controls = Some(controller.shared.clone());
            broadcast_recovery_gains = Some(gains);
            self.split_monitor = Some(controller);
            monitor_renderer = Some(renderer);
            broadcast_queue = Some(queue);
            rt_input_gain = 1.0;
            rt_input_l = 0;
            rt_input_r = 1;
            // 入力→monitorの観測を維持し、配信workerとは別に集計する。
            output_timing = None;
        }
        let output_queue_diagnostics = if separated {
            Arc::new(QueueDiagnostics::new(
                format!("broadcast:{}", self.queue_attempt),
                self.current_sample_rate as u32,
                self.current_sample_rate as u32,
                2,
                2,
                (self.current_sample_rate as usize / 5).max(2) * 2,
            ))
        } else {
            output_queue_diagnostics
        };
        let output_nr_failed = worker_controls
            .as_ref()
            .map_or(output_nr_failed, |s| s.failed.clone());
        let output_capacity_failed = worker_controls
            .as_ref()
            .map_or(output_capacity_failed, |s| s.failed.clone());
        let output_stream_failed = worker_controls
            .as_ref()
            .map_or(output_stream_failed, |s| s.failed.clone());
        let input_failed = self.stream_failed.clone();
        let input_process_failed = input_failed.clone();
        let input_resampling_failed = self.resampling_failed.clone();
        let mut worker_generation = 0;
        let mut upstream_consumed = 0u64;
        let mut measurement_processed = 0;
        let worker_generation_controls = worker_controls.clone();
        let dsp_silence = self.mode_silence.shared.clone();
        let output_silence = self.mode_silence.shared.clone();
        let monitor_silence = self.mode_silence.shared.clone();
        let input_silence = self.mode_silence.shared.clone();
        let build_output = || {
            let output_build_started = Instant::now();
            let mut process_output =
                move |data: &mut [f32], info: Option<&cpal::OutputCallbackInfo>| {
                    if dsp_silence.drain_worker() {
                        audio_cons.skip(audio_cons.occupied_len());
                        if let Some(gains) = &mut broadcast_recovery_gains {
                            gains.skip(gains.occupied_len());
                        }
                        dsp_silence.worker_drained();
                        data.fill(0.0);
                        return;
                    }
                    rt_peak.sync(&peak_shared);
                    if let Some(sender) = &mut live_sender {
                        sender.get_mut().begin_block();
                    }
                    if let Some(controls) = &worker_generation_controls {
                        let generation = controls.generation.load(Ordering::Acquire);
                        if generation != worker_generation {
                            let skipped = audio_cons.skip(audio_cons.occupied_len() / 2 * 2) / 2;
                            if let Some(gains) = &mut broadcast_recovery_gains {
                                gains.skip(skipped);
                            }
                            upstream_consumed = upstream_consumed.saturating_add(skipped as u64);
                            worker_generation = generation;
                            data.fill(0.0);
                            return;
                        }
                    }
                    let timing_begin = output_timing.as_ref().map_or(0, |timing| timing.now_ns());
                    let CallbackProcessors {
                        processors: rt_processors,
                        reverb: rt_reverb,
                        pending_retire,
                        pending_rejected,
                    } = callback_processors.get_mut();
                    if output_nr_failed.load(Ordering::Acquire)
                        || output_resampling_failed.load(Ordering::Acquire)
                        || output_stream_failed.load(Ordering::Acquire)
                    {
                        data.fill(0.0);
                        return;
                    }
                    let Some(actual_frames) = lifecycle::output_block_frames(
                        data,
                        channels_len,
                        max_frames_per_callback,
                        &output_stream_failed,
                        &output_capacity_failed,
                    ) else {
                        return;
                    };
                    let measurement_ticket = worker_generation_controls
                        .as_ref()
                        .map(|c| c.measurement_ticket());
                    let upstream_first_frame = upstream_consumed;
                    if let Some(gains) = &mut broadcast_recovery_gains {
                        for gain in &mut upstream_recovery[..actual_frames] {
                            let Some(value) = gains.try_pop() else {
                                output_stream_failed.store(true, Ordering::Release);
                                data.fill(0.0);
                                return;
                            };
                            *gain = value;
                        }
                        upstream_consumed = upstream_consumed.saturating_add(actual_frames as u64);
                    }
                    // Monitorのunity ACKと、このblock自体の回復係数が揃うまで開始要求をFIFOに残す。
                    // 既に転送済みのfade blockを録音・測定の先頭として扱わない。
                    let measurement_ready = worker_generation_controls
                        .as_ref()
                        .zip(measurement_ticket)
                        .is_none_or(|(c, ticket)| {
                            c.measurement_ready_at(ticket, upstream_first_frame)
                                && upstream_recovery[..actual_frames]
                                    .iter()
                                    .all(|gain| *gain == 1.0)
                        });
                    if !initial_live_ack {
                        live_shared
                            .accepted
                            .fetch_max(initial_live_revision, Ordering::Release);
                        live_shared
                            .completed
                            .fetch_max(initial_live_revision, Ordering::Release);
                        initial_live_ack = true;
                    }
                    // Flush any pending retire messages first (never drop VST objects in RT thread)
                    for slot in pending_retire.iter_mut() {
                        if let Some(retired) = slot.take() {
                            match retire_prod.try_push(retired) {
                                Ok(()) => {}
                                Err(retired) => {
                                    *slot = Some(retired);
                                    break;
                                }
                            }
                        }
                    }

                    let now = Instant::now();
                    if let Some((previous, previous_frames)) = last_callback {
                        let (late, missed) = callback_lateness(
                            now.duration_since(previous),
                            previous_frames,
                            callback_rate,
                        );
                        stats_max_jitter.fetch_max(late, Ordering::Relaxed);
                        if missed {
                            stats_glitches.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    last_callback = Some((now, actual_frames));

                    if !mmcss_set_out.load(Ordering::Relaxed) {
                        unsafe {
                            use windows::Win32::System::Threading::{
                                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST,
                                THREAD_PRIORITY_TIME_CRITICAL,
                            };
                            let priority = if time_critical_audio_threads_enabled() {
                                THREAD_PRIORITY_TIME_CRITICAL
                            } else {
                                THREAD_PRIORITY_HIGHEST
                            };
                            let _ = SetThreadPriority(GetCurrentThread(), priority);
                        }
                        mmcss_set_out.store(true, Ordering::Relaxed);
                    }

                    if let Some(frames) = data.len().checked_div(channels_len) {
                        let _ = frames_counter.fetch_add(frames as u64, Ordering::Relaxed);
                    }

                    // Process Commands
                    // 返却待ちの拒否値がある間は次の所有値を受け取らない。
                    // キュー満杯でも保持数を固定し、RT側でprocessorをDropしない。
                    while measurement_ready && pending_rejected.flush_to(&mut retire_prod) {
                        if consumer.try_peek().is_some_and(|msg| {
                            matches!(
                                msg,
                                AudioThreadMessage::StartVoiceCheckRecording { .. }
                                    | AudioThreadMessage::StartAutoGainCapture(_)
                                    | AudioThreadMessage::SetLoudnessMeasurement(Some(_))
                            )
                        }) && worker_generation_controls.as_ref().is_some_and(|c| {
                            !c.measurement_ready_at(c.measurement_ticket(), upstream_first_frame)
                        }) {
                            break;
                        }
                        let Some(msg) = consumer.try_pop() else {
                            break;
                        };
                        if msg.changes_cohort() {
                            rt_cohort_change_applied = match &msg {
                                AudioThreadMessage::AddProcessor { index, .. } => {
                                    let slot = *index as usize;
                                    slot < MAX_PLUGINS && rt_processors[slot].is_none()
                                }
                                AudioThreadMessage::RemoveProcessor { index } => {
                                    let slot = *index as usize;
                                    slot < MAX_PLUGINS
                                }
                                AudioThreadMessage::SetBypass { index, .. }
                                | AudioThreadMessage::SetMute { index, .. }
                                | AudioThreadMessage::SetGain { index, .. } => {
                                    (*index as usize) < MAX_PLUGINS
                                }
                                _ => true,
                            };
                        }
                        match msg {
                            AudioThreadMessage::CohortWindow { revision } => {
                                if let Some(timing) = &mut output_timing {
                                    timing
                                        .complete_cohort_window(revision, rt_cohort_change_applied);
                                }
                            }
                            AudioThreadMessage::AddProcessor {
                                index,
                                processor,
                                initial_gain,
                                initial_bypassed,
                                initial_muted,
                            } => {
                                let slot = index as usize;
                                if slot < MAX_PLUGINS && rt_processors[slot].is_none() {
                                    rt_processors[slot] = Some(processor);
                                    rt_active_count += 1;
                                    rt_gains[slot] = Smoother::new_ramp(0.0, initial_gain);
                                    rt_bypassed[slot] = initial_bypassed;
                                    rt_muted[slot] = initial_muted;
                                } else {
                                    pending_rejected.defer(
                                        DisposedProcessor::Rejected(processor),
                                        &mut retire_prod,
                                    );
                                }
                            }
                            AudioThreadMessage::RemoveProcessor { index } => {
                                let slot = index as usize;
                                if slot < MAX_PLUGINS {
                                    if pending_retire[slot].is_none() {
                                        if let Some(proc) = rt_processors[slot].take() {
                                            let retired =
                                                DisposedProcessor::Retired(RetiredProcessor {
                                                    index,
                                                    processor: proc,
                                                });
                                            if let Err(retired) = retire_prod.try_push(retired) {
                                                pending_retire[slot] = Some(retired);
                                            };
                                            rt_active_count = rt_active_count.saturating_sub(1);
                                        }
                                    }
                                    rt_muted[slot] = false;
                                    rt_bypassed[slot] = false;
                                    rt_gains[slot] = Smoother::new(1.0);
                                    remove_from_order(&mut rt_order, &mut rt_order_len, index);
                                }
                            }
                            AudioThreadMessage::ReorderProcessors { order, len } => {
                                rt_order = order;
                                rt_order_len = (len as usize).min(MAX_PLUGINS);
                            }
                            AudioThreadMessage::SetBypass { index, active } => {
                                let slot = index as usize;
                                if slot < MAX_PLUGINS {
                                    rt_bypassed[slot] = active;
                                }
                            }
                            AudioThreadMessage::SetMute { index, active } => {
                                let slot = index as usize;
                                if slot < MAX_PLUGINS {
                                    rt_muted[slot] = active;
                                }
                            }
                            AudioThreadMessage::SetGain { index, value } => {
                                let slot = index as usize;
                                if slot < MAX_PLUGINS {
                                    rt_gains[slot].set_target(value);
                                }
                            }
                            AudioThreadMessage::LiveMode {
                                voice,
                                revision,
                                builtin_revision,
                                reverb,
                                talk,
                                frames,
                            } => {
                                rt_voice.start(voice, revision, builtin_revision, frames);
                                if talk {
                                    rt_reverb.set_transport(0.0, 1.0);
                                } else {
                                    rt_reverb.update(reverb);
                                }
                                live_shared.accepted.fetch_max(revision, Ordering::Release);
                            }
                            AudioThreadMessage::SetGlobalMute(active) => {
                                if rt_global_mute != active {
                                    if let Some(control) = &mut rt_noise_control {
                                        control.reset_state();
                                    }
                                }
                                rt_global_mute = active;
                                if active {
                                    rt_reverb.reset();
                                }
                            }
                            AudioThreadMessage::SetGlobalBypass(active) => {
                                rt_global_bypass = active;
                            }
                            AudioThreadMessage::SetInputGain(val) => {
                                if !separated {
                                    rt_input_gain = val;
                                }
                            }
                            AudioThreadMessage::StartNoiseLearning {
                                duration_frames,
                                generation,
                                window_frames,
                            } => {
                                rt_noise_learning.start_with_generation(
                                    duration_frames,
                                    generation,
                                    window_frames,
                                );
                            }
                            AudioThreadMessage::CancelNoiseLearning => {
                                rt_noise_learning.cancel();
                            }
                            AudioThreadMessage::SetNoiseControl {
                                revision,
                                active,
                                mode,
                                strength,
                                voice_guard,
                            } => {
                                if active && rt_noise_control.is_none() {
                                    output_nr_failed.store(true, Ordering::Release);
                                    data.fill(0.0);
                                    return;
                                }
                                if let Some(control) = &mut rt_noise_control {
                                    control.configure(NoiseSettings {
                                        enabled: active,
                                        mode,
                                        strength: strength.clamp(0.25, 1.25),
                                        voice_guard,
                                    });
                                }
                                noise_applied_revision.store(revision, Ordering::Release);
                            }
                            AudioThreadMessage::SetBuiltInEffects {
                                active,
                                preset,
                                amount,
                                singing,
                                reverb,
                                revision,
                            } => {
                                rt_voice.update_normal(
                                    active,
                                    preset,
                                    amount.clamp(0.0, 1.0),
                                    singing,
                                );
                                rt_reverb.update(reverb);
                                builtin_applied.store(revision, Ordering::Release);
                            }
                            AudioThreadMessage::SetLoudnessMeasurement(id) => {
                                rt_loudness.reset(loudness_start.request(id, &queue_recovery));
                            }
                            AudioThreadMessage::MeasurementReservation(ticket) => {
                                measurement_processed = ticket;
                            }
                            AudioThreadMessage::SetOutputGain { value, revision } => {
                                rt_output_gain.set_target(value);
                                rt_capture
                                    .shared
                                    .applied_revision
                                    .store(revision, Ordering::Release);
                            }
                            AudioThreadMessage::StartAutoGainCapture(id) => rt_capture.start(id),
                            AudioThreadMessage::SetInputChannels(l, r) => {
                                if !separated {
                                    rt_input_l = l;
                                    rt_input_r = r;
                                }
                            }
                            AudioThreadMessage::SetChannelScan(enable) => {
                                rt_scan_enabled = enable;
                            }
                            AudioThreadMessage::StartVoiceCheckRecording {
                                buffers,
                                max_frames,
                            } => {
                                rt_voice_check.start_recording(buffers, max_frames);
                            }
                            AudioThreadMessage::StopVoiceCheckRecording => {
                                rt_voice_check.stop_recording();
                            }
                            AudioThreadMessage::PlayVoiceCheck {
                                source,
                                loop_playback,
                            } => {
                                if rt_voice_check.is_playback_active() {
                                    rt_voice_check.set_playback_source(source);
                                    rt_voice_check.set_loop_playback(loop_playback);
                                } else {
                                    rt_voice_check.start_playback(source, loop_playback);
                                }
                            }
                            AudioThreadMessage::StopVoiceCheckPlayback => {
                                rt_voice_check.stop_playback();
                            }
                            AudioThreadMessage::VoiceCheckTransportAck(revision) => {
                                rt_voice_check.acknowledge_transport(revision);
                            }
                            AudioThreadMessage::PlayTestTone {
                                freq_hz,
                                duration_ms,
                                level_db,
                            } => {
                                rt_voice_check.stop_playback();
                                rt_test_tone.start(freq_hz, duration_ms, level_db);
                            }
                            AudioThreadMessage::StopTestTone => {
                                rt_test_tone.stop();
                            }
                            AudioThreadMessage::Stop => {}
                        }
                    }

                    let channels = channels_len;
                    let frames = actual_frames;

                    // --- 1. Efficient Input Data Fetch & De-interleaving ---
                    // 測定・別再生中は通常マイクの回復を開始しない。
                    if let Some(id) = loudness_start.take_ready(&queue_recovery) {
                        rt_loudness.reset(Some(id));
                    }
                    let recovery_blocked = rt_global_mute
                        || rt_test_tone.is_active()
                        || rt_voice_check.is_playback_active()
                        || rt_voice_check.is_recording_active()
                        || rt_capture.is_active()
                        || rt_loudness.id.is_some()
                        || loudness_start.blocks_recovery();
                    let skip_frames = queue_recovery.begin_block(
                        audio_cons.occupied_len() / channels,
                        frames,
                        output_queue_diagnostics.max_burst(),
                        recovery_blocked || separated,
                    );
                    if skip_frames > 0 {
                        if let Some(timing) = &output_timing {
                            timing.invalidate_recovery();
                        }
                        // f32のskipはindex更新。完全frameだけをconsumerが回収する。
                        let skipped = audio_cons.skip(skip_frames * channels) / channels;
                        output_queue_diagnostics.record_recovery(
                            skipped,
                            queue_recovery.status(),
                            queue_recovery.target(),
                            queue_recovery.high(),
                        );
                    } else {
                        output_queue_diagnostics.record_recovery(
                            0,
                            queue_recovery.status(),
                            queue_recovery.target(),
                            queue_recovery.high(),
                        );
                    }
                    let to_read = frames * channels;
                    let (consumed_frames, timing_read) = if let Some(timing) = &output_timing {
                        queue_diagnostics::read_complete_frames_observed(
                            &mut audio_cons,
                            &mut input_buf[..to_read],
                            channels,
                            || timing.now_ns(),
                        )
                    } else {
                        (
                            queue_diagnostics::read_complete_frames(
                                &mut audio_cons,
                                &mut input_buf[..to_read],
                                channels,
                            ),
                            0,
                        )
                    };
                    output_queue_diagnostics.record_output(frames, consumed_frames);

                    // De-interleave & Metering
                    let mut in_max_l = 0.0;
                    let mut in_max_r = 0.0;

                    // Channel Scanning (For UI Smart Selector)
                    let mut channel_peaks = [0.0f32; 32]; // Max 32 channels scan
                    let scan_limit = channels.min(32);
                    let record_block_start = rt_voice_check.block_record_start();

                    for i in 0..frames {
                        // Manual de-interleaving and Mapping to Stereo Bus (0/1)
                        // The internal processing is Stereo (2ch).
                        // We map the selected Input Channels to Planar 0 and 1.

                        // First de-interleave everything to planar? Or just what we need?
                        // To support "Active Channel Scan", we should de-interleave or peek all.
                        // For performance, let's just peek for scan and de-interleave selected for processing.

                        // OPTIMIZATION: Just de-interleave ALL for now, or just the selected?
                        // Let's stick to full de-interleave to plan_buf_a to support multi-channel plugins later if needed.
                        for ch in 0..channels {
                            let sample = input_buf[i * channels + ch] * rt_input_gain;
                            planar_buf_a[ch][i] = sample;

                            // Scanner Logic (only if enabled)
                            if rt_scan_enabled && ch < scan_limit {
                                let abs = sample.abs();
                                if abs > channel_peaks[ch] {
                                    channel_peaks[ch] = abs;
                                }
                            }
                        }

                        // Input Routing & Metering:
                        // We WANT the selected input channels (rt_input_l, rt_input_r) to appear as indices 0 and 1
                        // for the subsequent plugin chain if the chain expects stereo.
                        // HOWEVER, `planar_buf_a` currently holds the physical mapping (Index N = Channel N).
                        // If we want plugins to receive "Main Input" on 0/1, we must SWAP or COPY.

                        // Simple approach: Copy active inputs to a temporary "Stereo Processing Buffer"
                        // OR just use the selected indices for Metering and passing to first plugin.
                        // BUT: Current ping-pong logic iterates 0..channels.
                        // If plugins process "Stereo" they usually take buf[0] and buf[1].

                        // SOLUTION: The host should likely copy Selected Ch -> Ch 0, Selected Ch -> Ch 1
                        // BEFORE processing starts.
                        // Note: This destructively overwrites physical Ch 0/1 data in the buffer.
                        // But that's fine, we are "Routing" inputs.

                        let sample_l = if rt_input_l < channels {
                            planar_buf_a[rt_input_l][i]
                        } else {
                            0.0
                        };
                        let sample_r = if rt_input_r < channels {
                            planar_buf_a[rt_input_r][i]
                        } else {
                            0.0
                        };

                        // Overwrite 0/1 for the processing chain
                        if channels >= 2 {
                            planar_buf_a[0][i] = sample_l;
                            planar_buf_a[1][i] = sample_r;
                        }

                        // Main Metering (Post-Routing)
                        let abs_l = sample_l.abs();
                        if abs_l > in_max_l {
                            in_max_l = abs_l;
                        }

                        let abs_r = sample_r.abs();
                        if abs_r > in_max_r {
                            in_max_r = abs_r;
                        }

                        if rt_voice_check.is_recording_active() {
                            rt_voice_check.record_raw_at(
                                record_block_start + i as u64,
                                sample_l,
                                sample_r,
                            );
                        }
                    }

                    if rt_voice_check.is_playback_active() {
                        // 再生中はマイク入力をミュート（処理チェーンは無音で継続）
                        for channel in &mut planar_buf_a[..channels.min(2)] {
                            channel[..frames].fill(0.0);
                        }
                    }

                    if rt_test_tone.is_active() {
                        // テストトーン中はマイク入力をミュート
                        for channel in &mut planar_buf_a[..channels.min(2)] {
                            channel[..frames].fill(0.0);
                        }
                    }

                    if channels >= 2 {
                        rt_noise_learning.analyze_block(
                            &planar_buf_a[0][..frames],
                            Some(&planar_buf_a[1][..frames]),
                            frames,
                        );
                    } else if channels == 1 {
                        rt_noise_learning.analyze_block(&planar_buf_a[0][..frames], None, frames);
                    }

                    if let Some(control) = &mut rt_noise_control {
                        let profile_available = rt_noise_learning
                            .shared
                            .profile_valid
                            .load(Ordering::Acquire);
                        control.begin_block(NoiseAnalysis {
                            speech: rt_noise_learning
                                .shared
                                .speech_detected
                                .load(Ordering::Relaxed),
                            profile_rms: profile_available.then(|| {
                                rt_noise_learning
                                    .shared
                                    .accepted_rms_ppm
                                    .load(Ordering::Relaxed) as f32
                                    / 1_000_000.0
                            }),
                            learned_mix: rt_noise_learning.shared.applied_mix(),
                            has_learned_mix: rt_noise_learning
                                .shared
                                .has_applied_mix
                                .load(Ordering::Acquire),
                        });
                        if channels >= 2 {
                            let (left, right) = planar_buf_a.split_at_mut(1);
                            for (left, right) in
                                left[0][..frames].iter_mut().zip(&mut right[0][..frames])
                            {
                                let output = control.process_sample(*left, *right);
                                *left = output[0];
                                *right = output[1];
                            }
                        } else if channels == 1 {
                            for sample in &mut planar_buf_a[0][..frames] {
                                *sample = control.process_sample(*sample, *sample)[0];
                            }
                        }
                    }

                    if channels >= 2 {
                        let (left, right) = planar_buf_a.split_at_mut(1);
                        for (left, right) in
                            left[0].iter_mut().zip(right[0].iter_mut()).take(frames)
                        {
                            let output = rt_voice.process([*left, *right]);
                            *left = output[0];
                            *right = output[1];
                        }
                    } else {
                        for sample in planar_buf_a[0].iter_mut().take(frames) {
                            *sample = rt_voice.process([*sample; 2])[0];
                        }
                    }
                    if let Some((revision, builtin_revision)) = rt_voice.take_completed() {
                        live_shared.completed.fetch_max(revision, Ordering::Release);
                        builtin_applied.fetch_max(builtin_revision, Ordering::Release);
                    }

                    // 独立残響: voiceのactiveに依存させず、VSTへ渡す前に加算する。
                    if rt_global_mute {
                        rt_reverb.reset();
                    } else if channels > 1 {
                        let (left, remaining) = planar_buf_a.split_at_mut(1);
                        for (left, right) in
                            left[0].iter_mut().zip(remaining[0].iter_mut()).take(frames)
                        {
                            let result = rt_reverb.process([*left, *right], false);
                            *left = result[0];
                            *right = result[1];
                        }
                    } else {
                        for sample in planar_buf_a[0].iter_mut().take(frames) {
                            *sample = rt_reverb.process([*sample; 2], false)[0];
                        }
                    }

                    // Send Channel Scan Data (throttled)
                    if rt_scan_enabled {
                        // Simple throttling using frames_processed
                        let current_frames = frames_counter.load(Ordering::Relaxed);
                        // 48000Hz / 4800 = 10Hz approx.
                        // This logic "current_frames % 4800 < frames" ensures we trigger once per ~4800-frame window.

                        if current_frames % 4800 < frames as u64 {
                            let mut peaks = [0.0f32; 32];
                            for i in 0..scan_limit {
                                peaks[i] = channel_peaks[i];
                                channel_peaks[i] = 0.0; // Reset peak
                            }
                            // Use channel_prod captured by move closure
                            let _ = channel_prod.try_push(peaks);
                        }
                    }

                    // --- 2. Ping-Pong Processing Loop ---
                    // We toggle between using `planar_buf_a` and `planar_buf_b` as input/output
                    // Current Data is always in `current_buffer_index` (0 -> A, 1 -> B)

                    let mut current_source_is_a = true; // True usually implies result is in A

                    // Global Bypass: Skip all plugin processing (A/B comparison mode)
                    // Input remains in planar_buf_a, so current_source_is_a stays true.
                    if !rt_global_bypass && rt_active_count > 0 && rt_order_len > 0 {
                        for &index in &rt_order[..rt_order_len] {
                            let idx = index as usize;
                            if idx >= MAX_PLUGINS {
                                continue;
                            }

                            // Bypass Check
                            if rt_bypassed[idx] {
                                // Soft Bypass: Explicitly copy input buffer to output buffer
                                // This ensures the processing chain continuity ("Ping-Pong" flow)
                                // and guarantees valid data in the target buffer, resolving "Silence" issues.
                                let (in_bufs, out_bufs) = if current_source_is_a {
                                    (&planar_buf_a, &mut planar_buf_b)
                                } else {
                                    (&planar_buf_b, &mut planar_buf_a)
                                };

                                for ch in 0..channels {
                                    // Safety bounds check
                                    if ch < in_bufs.len()
                                        && ch < out_bufs.len()
                                        && in_bufs[ch].len() >= frames
                                        && out_bufs[ch].len() >= frames
                                    {
                                        out_bufs[ch][..frames]
                                            .copy_from_slice(&in_bufs[ch][..frames]);
                                    }
                                }

                                // Toggle source to maintain chain state (A -> B or B -> A)
                                current_source_is_a = !current_source_is_a;
                                continue;
                            }

                            // Mute Check
                            if rt_muted[idx] {
                                // If muted, we need to zero out the current buffer
                                if current_source_is_a {
                                    for channel in &mut planar_buf_a[..channels] {
                                        channel[..frames].fill(0.0);
                                    }
                                } else {
                                    for channel in &mut planar_buf_b[..channels] {
                                        channel[..frames].fill(0.0);
                                    }
                                }
                                continue;
                            }

                            // Process
                            if let Some(proc) = rt_processors[idx].as_mut() {
                                let (in_bufs, out_bufs) = if current_source_is_a {
                                    (&planar_buf_a, &mut planar_buf_b)
                                } else {
                                    (&planar_buf_b, &mut planar_buf_a)
                                };

                                // Call new process_planar
                                proc.process_planar(in_bufs, out_bufs, frames);

                                // Toggle
                                current_source_is_a = !current_source_is_a;

                                // Apply Gain (Smoother)
                                let smoother = &mut rt_gains[idx];
                                // Optimization: Check if gain is effectively 1.0 (no change needed)
                                if (smoother.current() - 1.0).abs() > 0.0001
                                    || (smoother.target() - 1.0).abs() > 0.0001
                                {
                                    let target_buf = if current_source_is_a {
                                        &mut planar_buf_a
                                    } else {
                                        &mut planar_buf_b
                                    };

                                    let mut frame_idx = 0;
                                    while frame_idx < frames {
                                        let gain = smoother.next();
                                        for channel in &mut target_buf[..channels] {
                                            channel[frame_idx] *= gain;
                                        }
                                        frame_idx += 1;
                                    }
                                }
                            }
                        }
                    }

                    // --- 3. Result Interleaving & Output Metering ---
                    let final_buf = if current_source_is_a {
                        &planar_buf_a
                    } else {
                        &planar_buf_b
                    };

                    if rt_capture.is_active() {
                        let invalid = rt_global_mute
                            || rt_test_tone.is_active()
                            || rt_voice_check.is_playback_active()
                            || in_max_l >= 0.999
                            || in_max_r >= 0.999;
                        for i in 0..frames {
                            let l = final_buf
                                .first()
                                .and_then(|b| b.get(i))
                                .copied()
                                .unwrap_or(0.0);
                            let r = final_buf
                                .get(1)
                                .and_then(|b| b.get(i))
                                .copied()
                                .unwrap_or(l);
                            rt_capture.sample(
                                auto_gain::capture_channels(l, r, rt_input_l == rt_input_r),
                                invalid,
                            );
                        }
                    }
                    if rt_voice_check.is_recording_active() {
                        for i in 0..frames {
                            let proc_l = final_buf
                                .first()
                                .and_then(|buf| buf.get(i))
                                .copied()
                                .unwrap_or(0.0);
                            let proc_r = final_buf
                                .get(1)
                                .and_then(|buf| buf.get(i))
                                .copied()
                                .unwrap_or(proc_l);
                            rt_voice_check.record_processed_at(
                                record_block_start + i as u64,
                                proc_l,
                                proc_r,
                            );
                        }
                        // 加工前後の最終ブロックが揃ってから公開・完了通知する。
                        rt_voice_check.advance_recording(frames);
                    }

                    let cohort_normal_mic = !rt_global_mute
                        && !rt_test_tone.is_active()
                        && !rt_voice_check.is_playback_active();
                    if let Some(sender) = &mut live_sender {
                        sender.get_mut().normal(cohort_normal_mic);
                    }
                    if rt_global_mute
                        || rt_test_tone.is_active()
                        || rt_voice_check.is_playback_active()
                    {
                        for _ in 0..frames {
                            queue_recovery.next_gain();
                        }
                    }
                    if rt_global_mute {
                        // ミュート中もゲインの反映を完了させる。出力は無音のまま。
                        for _ in 0..frames {
                            rt_output_gain.next();
                            rt_peak.process([0.0; 2]);
                        }
                        data.fill(0.0);
                        // Zero metering too implies output is silence
                        let _ = level_prod.try_push(MeterLevels {
                            input: [in_max_l, in_max_r],
                            output: [0.0, 0.0],
                        });
                    } else if rt_test_tone.is_active() {
                        data.fill(0.0);
                        let target_l = rt_input_l;
                        let target_r = rt_input_r;
                        let mut out_max_l = 0.0f32;
                        let mut out_max_r = 0.0f32;

                        for i in 0..frames {
                            let gain = rt_output_gain.next();
                            let (tone_l, tone_r) = rt_test_tone.sample();
                            let main_l = tone_l * gain;
                            let main_r = tone_r * gain;
                            let [main_l, main_r] = rt_peak.process([main_l, main_r]);

                            if target_l < channels {
                                let out_idx = i * channels + target_l;
                                if out_idx < data.len() {
                                    data[out_idx] = main_l;
                                }
                            }
                            if target_r < channels {
                                let out_idx = i * channels + target_r;
                                if out_idx < data.len() {
                                    data[out_idx] = main_r;
                                }
                            }

                            let sent = dsp::sent_sample_levels(
                                &data[i * channels..(i + 1) * channels],
                                [target_l, target_r],
                            );
                            out_max_l = out_max_l.max(sent[0]);
                            out_max_r = out_max_r.max(sent[1]);
                        }

                        let _ = level_prod.try_push(MeterLevels {
                            input: [0.0, 0.0],
                            output: [out_max_l, out_max_r],
                        });
                    } else if rt_voice_check.is_playback_active() {
                        data.fill(0.0);
                        let target_l = rt_input_l;
                        let target_r = rt_input_r;
                        let mut out_max_l = 0.0f32;
                        let mut out_max_r = 0.0f32;

                        for i in 0..frames {
                            let gain = rt_output_gain.next();
                            let (main_l, main_r) = rt_voice_check.read_playback_sample();
                            let main_l = main_l * gain;
                            let main_r = main_r * gain;
                            let [main_l, main_r] = rt_peak.process([main_l, main_r]);

                            if target_l < channels {
                                let out_idx = i * channels + target_l;
                                if out_idx < data.len() {
                                    data[out_idx] = main_l;
                                }
                            }
                            if target_r < channels {
                                let out_idx = i * channels + target_r;
                                if out_idx < data.len() {
                                    data[out_idx] = main_r;
                                }
                            }

                            let sent = dsp::sent_sample_levels(
                                &data[i * channels..(i + 1) * channels],
                                [target_l, target_r],
                            );
                            out_max_l = out_max_l.max(sent[0]);
                            out_max_r = out_max_r.max(sent[1]);
                        }

                        let _ = level_prod.try_push(MeterLevels {
                            input: [0.0, 0.0],
                            output: [out_max_l, out_max_r],
                        });
                    } else {
                        // Initialize output with silence
                        data.fill(0.0);

                        // Map processed "Main" (0/1) back to the selected physical device channels
                        // (Symmetric Routing / Insert Logic)
                        let target_l = rt_input_l;
                        let target_r = rt_input_r;

                        let mut out_max_l = 0.0f32;
                        let mut out_max_r = 0.0f32;
                        for i in 0..frames {
                            let gain = rt_output_gain.next();
                            let main_l = final_buf
                                .first()
                                .and_then(|buf| buf.get(i))
                                .copied()
                                .unwrap_or(0.0)
                                * gain;
                            let main_r = final_buf
                                .get(1)
                                .and_then(|buf| buf.get(i))
                                .copied()
                                .unwrap_or(main_l)
                                * gain;

                            // 既存gain/routingの後で、左右へ同一の回復fadeを1回だけ適用。
                            let recovery_gain = queue_recovery.next_gain() * upstream_recovery[i];
                            let main_l = main_l * recovery_gain;
                            let main_r = main_r * recovery_gain;
                            let [main_l, main_r] = rt_peak.process([main_l, main_r]);

                            if let Some(sender) = &mut live_sender {
                                sender.get_mut().send([main_l, main_r]);
                            }
                            let levels = monitor_levels.load(Ordering::Relaxed);
                            let monitor_gain = if separated {
                                1.0
                            } else if levels >> 32 != 0 {
                                0.0
                            } else {
                                f32::from_bits(levels as u32)
                            };
                            let main_l = main_l * monitor_gain;
                            let main_r = main_r * monitor_gain;
                            // Left
                            if target_l < channels {
                                let out_idx = i * channels + target_l;
                                if out_idx < data.len() {
                                    data[out_idx] = main_l;
                                }
                            }
                            // Right
                            if target_r < channels {
                                let out_idx = i * channels + target_r;
                                if out_idx < data.len() {
                                    data[out_idx] = main_r;
                                }
                            }
                            let sent = dsp::sent_sample_levels(
                                &data[i * channels..(i + 1) * channels],
                                [target_l, target_r],
                            );
                            out_max_l = out_max_l.max(sent[0]);
                            out_max_r = out_max_r.max(sent[1]);
                        }

                        let _ = level_prod.try_push(MeterLevels {
                            input: [in_max_l, in_max_r],
                            output: [out_max_l, out_max_r],
                        });
                    }
                    rt_peak.report(&peak_shared, 0);
                    // 最終ゲイン・ミュート・試聴を含め、デバイスへ実際に渡す値で測る。
                    // 測定していない間はフィルター・補間・走査を実行しない。
                    if rt_loudness.id.is_some() {
                        for frame in data.chunks_exact(channels) {
                            let l = frame.get(rt_input_l).copied().unwrap_or(0.0);
                            // 同じ物理チャンネルをL/Rへ選んだ場合は二重に加算しない。
                            let r = if rt_input_r == rt_input_l {
                                0.0
                            } else {
                                frame.get(rt_input_r).copied().unwrap_or(0.0)
                            };
                            if let Some(reading) = rt_loudness.sample([l, r]) {
                                let _ = loudness_prod.try_push(reading);
                            }
                        }
                    }
                    rt_capture
                        .shared
                        .confirmed_gain
                        .store(rt_output_gain.current().to_bits(), Ordering::Release);
                    rt_capture.shared.settled.store(
                        rt_output_gain.current() == rt_output_gain.target(),
                        Ordering::Release,
                    );
                    if measurement_ready
                        && measurement_ticket
                            .is_some_and(|ticket| ticket & !3 == measurement_processed & !3)
                    {
                        if let Some((controls, ticket)) =
                            worker_generation_controls.as_ref().zip(measurement_ticket)
                        {
                            controls.finish_measurement_block(
                                ticket,
                                rt_voice_check.is_recording_active()
                                    || rt_capture.is_active()
                                    || rt_loudness.id.is_some()
                                    || loudness_start.blocks_recovery(),
                            );
                        }
                    }
                    callback_diagnostics.record(actual_frames, now.elapsed().as_micros() as u64);
                    if let Some(timing) = &mut output_timing {
                        timing.record_context(
                            consumed_frames,
                            frames,
                            timing_begin,
                            timing_read,
                            info.map(|info| info.timestamp().callback),
                            cohort_normal_mic
                                && (separated || monitor_levels.load(Ordering::Acquire) >> 32 == 0),
                        );
                    }
                };
            let output_result = if let (Some(mut monitor), Some(queue), Some(controls)) =
                (monitor_renderer, broadcast_queue, worker_controls)
            {
                match super::split_monitor::Worker::start_gated(
                    move |data| {
                        let ticket = output_silence.ticket();
                        process_output(data, None);
                        output_silence.finish(super::mode_silence::MAIN, ticket, data);
                    },
                    queue,
                    controls,
                    self.stream_failed.clone(),
                    self.current_block_size.min(max_frames_per_callback).max(1),
                    self.mode_silence.shared.clone(),
                ) {
                    Ok(worker) => {
                        self.split_worker = Some(worker);
                        out_dev.build_output_stream(
                            &out_stream_config,
                            move |data: &mut [f32], info| {
                                monitor
                                    .get_mut()
                                    .render_gated(data, Some(info), &monitor_silence)
                            },
                            err_fn_ipc,
                            None,
                        )
                    }
                    Err(_) => Err(cpal::BuildStreamError::DeviceNotAvailable),
                }
            } else {
                out_dev.build_output_stream(
                    &out_stream_config,
                    move |data: &mut [f32], info| {
                        let ticket = output_silence.ticket();
                        process_output(data, Some(info));
                        output_silence.finish(super::mode_silence::MAIN, ticket, data);
                    },
                    err_fn_ipc,
                    None,
                )
            };
            capabilities::report_phase("output_build", output_build_started);
            output_result
        };

        let mut input_silence_reset = 0;
        let build_input = || {
            let input_build_started = Instant::now();
            let input_result = in_dev.build_input_stream(
                &in_stream_config,
                move |data: &[f32], info: &cpal::InputCallbackInfo| {
                    if input_silence.pause_input(|| {
                        if input_silence_reset != input_silence.ticket() {
                            if let Some(resampler) = &mut resampler {
                                resampler.discard_history();
                            }
                            if let Some(timing) = &mut input_timing {
                                timing.invalidate();
                            }
                            input_silence_reset = input_silence.ticket();
                        }
                    }) {
                        return;
                    }
                    let timing_arrival = input_timing.as_ref().map_or(0, |timing| timing.now_ns());
                    let received_frames = data.len() / channels;
                    if let Some(timing) = &mut input_timing {
                        timing.record_span(received_frames, timing_arrival);
                    }
                    if input_process_failed.load(Ordering::Acquire) {
                        input_queue_diagnostics.record_input(received_frames, 0, 0, 0, 0);
                        return;
                    }
                    if !mmcss_set_in.load(Ordering::Relaxed) {
                        unsafe {
                            use windows::Win32::System::Threading::{
                                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST,
                                THREAD_PRIORITY_TIME_CRITICAL,
                            };
                            let priority = if time_critical_audio_threads_enabled() {
                                THREAD_PRIORITY_TIME_CRITICAL
                            } else {
                                THREAD_PRIORITY_HIGHEST
                            };
                            let _ = SetThreadPriority(GetCurrentThread(), priority);
                        }
                        mmcss_set_in.store(true, Ordering::Relaxed);
                    }

                    // Push interleaved samples as full frames to preserve channel alignment.
                    // Mapping policy:
                    // - 1ch input -> duplicate to all output channels
                    // - Nch input, Mch output -> copy min(N, M), duplicate last input channel for extras
                    // 分割された出力でも、このコールバックの転送上限は1回だけ決める。
                    let mut remaining_frames = None;
                    let mut accepted_prefix = super::frame_timing::AcceptedPrefix::default();
                    let mut generated_frames = 0;
                    let mut offered_frames = 0;
                    let mut accepted_frames = 0;
                    let mut max_observed_slots = 0;
                    let mut push_frames = |samples: &[f32],
                                               in_channels: usize,
                                               cohort: Option<
                            super::resampling::CohortEmission,
                        >| {
                            let pushed = queue_diagnostics::push_mapped_frames(
                                &mut audio_prod,
                                samples,
                                in_channels,
                                out_channels_target,
                                &mut remaining_frames,
                            );
                            if let Some(timing) = &mut input_timing {
                                if batch_timing {
                                    timing.record_emission(cohort, pushed.accepted);
                                } else {
                                    timing.record_direct_emission(pushed.offered, pushed.accepted);
                                }
                            }
                            accepted_prefix.record(pushed.offered, pushed.accepted);
                            generated_frames += pushed.offered;
                            offered_frames += pushed.offered;
                            accepted_frames += pushed.accepted;
                            max_observed_slots = max_observed_slots.max(pushed.observed_slots);
                        };

                    // If resampler is active, process
                    if let Some(res) = &mut resampler {
                        // We assume input data matches configured channels
                        // エラーは固定サイズのenum。RT側で文字列化・ログ出力しない。
                        res.process_realtime_observed(
                            data,
                            |output, cohort| push_frames(output, channels, cohort),
                            &input_process_failed,
                            &input_resampling_failed,
                        );
                    } else {
                        // Passthrough
                        push_frames(data, channels, None);
                    }
                    input_queue_diagnostics.record_input(
                        received_frames,
                        generated_frames,
                        offered_frames,
                        accepted_frames,
                        max_observed_slots,
                    );
                    if let Some(timing) = &mut input_timing {
                        if batch_timing
                            && (!accepted_prefix.valid()
                                || input_process_failed.load(Ordering::Acquire))
                        {
                            // 音声は既存経路のまま。生成prefixを保証できない観測だけを失効する。
                            timing.invalidate();
                        }
                        timing.record(
                            if batch_timing {
                                generated_frames
                            } else {
                                received_frames
                            },
                            accepted_frames,
                            timing_arrival,
                            Some(info.timestamp().callback),
                        );
                    }
                },
                move |err| {
                    input_failed.store(true, Ordering::Release);
                    let msg = OutputMessage::Event(EngineEvent::Error(format!(
                        "Input Stream Error: {}",
                        err
                    )));
                    if let Ok(json) = serde_json::to_string(&msg) {
                        println!("IPC:{}", json);
                    }
                },
                None,
            );
            capabilities::report_phase("input_build", input_build_started);
            input_result
        };

        let order = lifecycle::BuildOrder::for_host(is_asio);
        let (output_stream, input_stream) = match lifecycle::build_pair(
            order,
            build_output,
            build_input,
        ) {
            Ok(s) => s,
            Err(lifecycle::BuildPairError::Output(e)) => {
                let error_jp = match &e {
                    cpal::BuildStreamError::DeviceNotAvailable => "デバイスが見つかりません。切断されたか、他アプリが排他制御している可能性があります。",
                    cpal::BuildStreamError::StreamConfigNotSupported => "指定された設定（サンプルレート/バッファ）はこのデバイスでサポートされていません。",
                    cpal::BuildStreamError::InvalidArgument => "無効なパラメータが指定されました。",
                    cpal::BuildStreamError::StreamIdOverflow => "ストリームIDオーバーフロー",
                    cpal::BuildStreamError::BackendSpecific { .. } => "バックエンドエラー",
                };
                let detailed_msg = format!("{} (Original: {})", error_jp, e);
                log::error!("Failed to build output stream: {}", detailed_msg);

                if let Some(next_policy) = policy.retry_default_output() {
                    log::warn!(
                        "[Config] Fallback! Retrying with Default: {} Hz",
                        out_capabilities.default_rate()
                    );
                    lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                        self.clear_audio_resources()
                    });
                    return self.start_audio_attempt(
                        AudioStartRequest {
                            host_name: retry_host_out,
                            input_name: retry_input_out,
                            output_name: retry_output_out,
                            sample_rate: Some(out_capabilities.default_rate()),
                            buffer_size: None,
                            device_ids: device_ids.clone(),
                        },
                        next_policy,
                    );
                }
                return Err(anyhow!(
                    "Stream Build Failed (Fallback exhausted): {}",
                    detailed_msg
                ));
            }
            Err(lifecycle::BuildPairError::Input(e)) => {
                let error_jp = match &e {
                    cpal::BuildStreamError::DeviceNotAvailable => "デバイスが見つかりません。切断されたか、他アプリが排他制御している可能性があります。",
                    cpal::BuildStreamError::StreamConfigNotSupported => "指定された設定（サンプルレート/バッファ）はこのデバイスでサポートされていません。",
                    cpal::BuildStreamError::InvalidArgument => "無効なパラメータが指定されました。",
                    cpal::BuildStreamError::StreamIdOverflow => "ストリームIDオーバーフロー",
                    cpal::BuildStreamError::BackendSpecific { .. } => "バックエンドエラー",
                };
                let detailed_msg = format!("{} (Original: {})", error_jp, e);
                log::error!("[Engine] Failed to build input stream: {}", detailed_msg);

                // 優先入力だけの拒否では、出力rateと有効bufferを変えず既定入力へ戻す。
                // build_pairがローカルstreamと未実行closureを回収した後だけ再準備する。
                if let Some(next_policy) = policy.retry_default_input(used_preferred_input) {
                    log::warn!("[Config] Input rate fallback: retaining output rate and buffer");
                    lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                        self.clear_audio_resources()
                    });
                    return self.start_audio_attempt(
                        AudioStartRequest {
                            host_name: retry_host_in,
                            input_name: retry_input_in,
                            output_name: retry_output_in,
                            sample_rate: Some(out_stream_config.sample_rate),
                            buffer_size: effective_fixed_block,
                            device_ids: device_ids.clone(),
                        },
                        next_policy,
                    );
                }
                // 既定入力も拒否された場合は、従来どおり出力の既定設定へ一度だけ戻す。
                if let Some(next_policy) = policy.retry_default_output() {
                    log::warn!("[Config] Input fallback: retrying after output cleanup");
                    // 再試行より前にローカル出力とcallback所有値を回収する。
                    lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                        self.clear_audio_resources()
                    });
                    return self.start_audio_attempt(
                        AudioStartRequest {
                            host_name: retry_host_in,
                            input_name: retry_input_in,
                            output_name: retry_output_in,
                            sample_rate: Some(out_capabilities.default_rate()),
                            buffer_size: None,
                            device_ids: device_ids.clone(),
                        },
                        next_policy,
                    );
                }
                return Err(anyhow!("Input Stream Build Failed: {}", detailed_msg));
            }
        };
        // ASIO互換の出力→入力play順を維持し、両方成功した場合だけ公開する。
        let mut starting_output = true;
        let streams = capabilities::timed("stream_play", || {
            StreamPair::start(output_stream, input_stream, |stream: &cpal::Stream| {
                let direction = if starting_output { "Output" } else { "Input" };
                starting_output = false;
                stream
                    .play()
                    .map_err(|error| anyhow!("{} Stream play() failed: {}", direction, error))
            })
        })?;
        let (input_stream, output_stream) = streams.commit();
        self.input_stream = Some(input_stream);
        self.output_stream = Some(output_stream);
        self.queue_state = QueueState::Running;
        self.bundle_last_fixed_buffer_request = Some(effective_fixed_block);

        self.send_event(EngineEvent::Log(format!(
            "Audio Engine Started: Sample Rate={}, Buffer Size={}, Channels={}",
            self.current_sample_rate, self.current_block_size, self.current_channels
        )));

        self.send_event(EngineEvent::Started {
            sample_rate: self.current_sample_rate as u32,
            buffer_size: self.current_block_size as u32,
        });

        Ok(())
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
        if self.output_stream.is_some() {
            self.queue_audio_msg(AudioThreadMessage::SetGlobalMute(active));
        }
    }

    fn queue_snapshot(&self) -> Option<QueueSnapshot> {
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
        let nominal = (self.current_sample_rate.is_finite() && self.current_sample_rate > 0.0)
            .then(|| self.current_sample_rate.round() as u32);
        // NR生成時と同じ設定rate。1フレームの長さであり、各sampleの待ち時間ではない。
        let geometry = nominal.and_then(dsp::NoiseGeometry::checked);
        let nr_rate = geometry.map(|g| g.rate);
        let current = self.output_stream.is_some()
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
                enabled: self.noise_reduction_enabled,
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
                if self.output_stream.is_none() || self.stream_failed.load(Ordering::Acquire) {
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
            nr_configured_enabled: self.noise_reduction_enabled,
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

    fn live_mode_snapshot(&self) -> super::live_modes::Snapshot {
        let mut snapshot = self.live_modes.snapshot(
            self.builtin.snapshot(false).epoch,
            self.output_stream.is_some(),
        );
        if let Some(monitor) = &self.split_monitor {
            snapshot.accepted_revision = snapshot
                .accepted_revision
                .parse::<u64>()
                .unwrap_or(0)
                .min(monitor.shared.accepted.load(Ordering::Acquire))
                .to_string();
            snapshot.completed_revision = snapshot
                .completed_revision
                .parse::<u64>()
                .unwrap_or(0)
                .min(monitor.shared.completed.load(Ordering::Acquire))
                .to_string();
            if monitor.shared.failed.load(Ordering::Acquire) {
                snapshot.phase = "partial".into();
                snapshot.applied = None;
                return snapshot;
            }
            if snapshot.completed_revision != snapshot.revision {
                snapshot.applied = None;
                if snapshot.running {
                    snapshot.phase = "transitioning".into();
                }
            }
        }
        snapshot
    }
    fn select_live_mode(
        &mut self,
        mode: super::live_modes::Mode,
    ) -> std::result::Result<(), String> {
        if let Some(config) = self.live_modes.select(mode)? {
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
        if let Some(job) = self.live_modes.next(self.output_stream.is_some()) {
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
        if self.output_stream.is_some() {
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
        if staged.expected_ids.as_ref().is_some_and(|ids| {
            !self.session_rack_matches(ids, staged.expected_rack_revision.unwrap_or(u64::MAX))
        }) {
            self.send_response(Response::RackConflict);
            return;
        }
        let setup = self.output_stream.is_some().then(|| self.processor_setup());
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
        let prepared = processor.is_some();
        if let Some(processor) = processor {
            self.queue_audio_msg(AudioThreadMessage::AddProcessor {
                index,
                processor,
                initial_gain: gain,
                initial_bypassed: bypassed,
                initial_muted: muted,
            });
            self.queue_audio_msg(self.make_reorder_message());
        }
        log::debug!(
            "VST restore phase=commit us={}",
            phase.elapsed().as_micros()
        );
        self.send_response(Response::PluginRestored {
            operation_id,
            plugin: crate::ipc::RestoredPlugin { id, name, prepared },
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
        self.output_stream = None;
        self.split_worker = None;
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
        self.noise_input_identity = None;
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
