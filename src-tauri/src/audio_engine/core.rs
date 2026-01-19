use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::HeapRb;
use serde_json;
use std::io::{self, BufRead, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
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
use super::plugins::PluginManager;
use super::plugins::MAX_PLUGINS;

pub enum AudioThreadMessage {
    AddProcessor {
        index: u8,
        processor: VstProcessor,
        initial_gain: f32,
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
    SetInputGain(f32),
    SetInputChannels(usize, usize), // (Left, Right)
    SetChannelScan(bool),           // Enable/Disable background scanning
    Stop,
}

pub struct RetiredProcessor {
    pub index: u8,
    pub processor: VstProcessor,
}

// Custom Event for Winit Loop
#[derive(Debug)]
pub enum UserEvent {
    Command(Command),
    Timer,
}

type CmdProducer = <HeapRb<AudioThreadMessage> as Split>::Prod;
type LevelConsumer = <HeapRb<MeterLevels> as Split>::Cons;
type ChannelConsumer = <HeapRb<[f32; 32]> as Split>::Cons;
type RetireConsumer = <HeapRb<RetiredProcessor> as Split>::Cons;

// Smoother Implementation
struct Smoother {
    current: f32,
    target: f32,
    coeff: f32,
}

impl Smoother {
    fn new(initial_value: f32) -> Self {
        Self {
            current: initial_value,
            target: initial_value,
            coeff: 0.005,
        }
    }

    fn new_ramp(start: f32, end: f32) -> Self {
        Self {
            current: start,
            target: end,
            coeff: 0.005,
        }
    }

    fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    fn next(&mut self) -> f32 {
        if (self.current - self.target).abs() < 0.0001 {
            self.current = self.target;
        } else {
            self.current += (self.target - self.current) * self.coeff;
        }
        self.current
    }
}

pub struct Engine {
    input_stream: Option<cpal::Stream>,
    output_stream: Option<cpal::Stream>,

    // Sub-Modules
    pub device_manager: DeviceManager,
    pub editor_manager: EditorManager,
    pub plugin_manager: PluginManager,

    command_tx: Option<CmdProducer>,
    level_rx: Option<LevelConsumer>,
    channel_rx: Option<ChannelConsumer>,
    retire_rx: Option<RetireConsumer>,
    pending_audio_msgs: Vec<AudioThreadMessage>,
    frames_processed: Arc<AtomicU64>, // Diagnostic

    // Active Audio Config
    current_sample_rate: f64,
    current_block_size: usize,
    current_channels: usize,

    // Channel Mapping (Runtime)
    input_channel_l: usize,
    input_channel_r: usize,
    scan_enabled: bool,

    // Diagnostics
    stats_max_jitter: Arc<AtomicU64>,
    stats_glitches: Arc<AtomicU64>,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            input_stream: None,
            output_stream: None,
            device_manager: DeviceManager::new(),
            editor_manager: EditorManager::new(),
            plugin_manager: PluginManager::new(),
            command_tx: None,
            level_rx: None,
            channel_rx: None,
            retire_rx: None,
            pending_audio_msgs: Vec::new(),
            frames_processed: Arc::new(AtomicU64::new(0)),
            current_sample_rate: 0.0,
            current_block_size: 0,
            current_channels: 2,
            input_channel_l: 0,
            input_channel_r: 1,
            scan_enabled: true, // Auto-enable scan for smart selector
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
                                if let Err(_) = proxy.send_event(UserEvent::Command(cmd)) {
                                    break; // Loop closed
                                }
                            }
                            Err(e) => eprintln!("JSON Parse Error: {}", e),
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Log startup
        self.send_event(EngineEvent::Log("Audio Engine Started".to_string()));

        let mut last_meter_time = Instant::now();
        let meter_interval = Duration::from_millis(16); // ~60 FPS

        let mut current_in_l = 0.0f32;
        let mut current_in_r = 0.0f32;
        let mut current_out_l = 0.0f32;
        let mut current_out_r = 0.0f32;

        let mut updates_received = 0;
        let mut last_data_time = Instant::now();
        let mut last_heartbeat = Instant::now();

        // Run Event Loop
        let _ = event_loop.run(move |event, target| {
            // Use WaitUntil to prevent CPU spinning
            target.set_control_flow(ControlFlow::WaitUntil(
                Instant::now() + Duration::from_millis(8),
            ));

            match event {
                Event::UserEvent(UserEvent::Command(cmd)) => {
                    self.handle_command(cmd, target);
                }
                Event::UserEvent(UserEvent::Timer) => {}
                Event::AboutToWait => {
                    self.flush_pending_audio_msgs();

                    // Retire processors off the audio callback thread (safe place to drop VST objects)
                    if let Some(retire_cons) = &mut self.retire_rx {
                        while let Some(retired) = retire_cons.try_pop() {
                            drop(retired.processor);
                            self.plugin_manager.on_processor_retired(retired.index);
                        }
                    }

                    // --- Deferred Initialization ---
                    if !self.plugin_manager.pending_init.is_empty() {
                        let pending_ids = std::mem::take(&mut self.plugin_manager.pending_init);
                        for id in pending_ids {
                            let index = self.plugin_manager.rt_index_of(&id);
                            let initial_gain = *self.plugin_manager.gains.get(&id).unwrap_or(&1.0);
                            let is_bypassed = self.plugin_manager.bypassed.contains(&id);
                            let is_muted = self.plugin_manager.muted.contains(&id);

                            let mut created_processor: Option<VstProcessor> = None;

                            let finalize_ok = {
                                let Some(instance) = self.plugin_manager.get_mut(&id) else {
                                    continue;
                                };
                                eprintln!(
                                    "Executing Deferred Init (Activate -> Connect) for {}",
                                    instance.name
                                );

                                if self.output_stream.is_some() {
                                    let sr = self.current_sample_rate;
                                    let bs = self.current_block_size as i32;
                                    let ch = self.current_channels as i32;

                                    if let Err(e) = instance.prepare_processing(sr, bs, ch) {
                                        eprintln!("Deferred Activation Failed: {}", e);
                                    }
                                    created_processor = instance.create_processor();
                                }

                                instance.finalize_connection().is_ok()
                            };

                            if finalize_ok {
                                eprintln!("Deferred connection finalized for {}", id);
                            } else {
                                eprintln!("Error finalizing deferred connection for {}", id);
                            }

                            if self.output_stream.is_some() {
                                if let (Some(index), Some(proc)) = (index, created_processor) {
                                    self.queue_audio_msg(AudioThreadMessage::AddProcessor {
                                        index,
                                        processor: proc,
                                        initial_gain,
                                    });
                                    if is_bypassed {
                                        self.queue_audio_msg(AudioThreadMessage::SetBypass {
                                            index,
                                            active: true,
                                        });
                                    }
                                    if is_muted {
                                        self.queue_audio_msg(AudioThreadMessage::SetMute {
                                            index,
                                            active: true,
                                        });
                                    }
                                    self.queue_audio_msg(self.make_reorder_message());
                                }
                            }
                        }
                    }
                    // -------------------------------------------

                    // Heartbeat (1s) & Diagnostics
                    if last_heartbeat.elapsed() >= Duration::from_secs(1) {
                        let _max_jitter = self.stats_max_jitter.swap(0, Ordering::Relaxed);
                        let _glitches = self.stats_glitches.swap(0, Ordering::Relaxed);
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

                                meter_event_to_send = Some(EngineEvent::LevelMeter(MeterLevels {
                                    input: [safe_in_l, safe_in_r],
                                    output: [safe_out_l, safe_out_r],
                                }));

                                current_in_l = 0.0;
                                current_in_r = 0.0;
                                current_out_l = 0.0;
                                current_out_r = 0.0;
                                updates_received = 0;
                                last_meter_time = Instant::now();
                            } else if time_since_data > Duration::from_millis(75) {
                                meter_event_to_send = Some(EngineEvent::LevelMeter(MeterLevels {
                                    input: [0.0, 0.0],
                                    output: [0.0, 0.0],
                                }));
                                last_meter_time = Instant::now();
                            }
                        }
                    }
                    if let Some(evt) = meter_event_to_send {
                        self.send_event(evt);
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
                        self.send_event(EngineEvent::ChannelLevels(scan_data));
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
                                eprintln!("Error resizing plugin {}: {}", pid, e);
                            }
                        }
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    window_id,
                } => {
                    // Refactored Close Handling
                    if let Some(plugin_id) = self.editor_manager.handle_close_requested(window_id) {
                        if let Some(instance) = self.plugin_manager.get_mut(&plugin_id) {
                            instance.close_editor();
                        }
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
            Err(e) => eprintln!("JSON Serialize Error (Response): {}", e),
        }
    }

    fn send_event(&self, evt: EngineEvent) {
        let msg = OutputMessage::Event(evt);
        match serde_json::to_string(&msg) {
            Ok(json) => {
                println!("IPC:{}", json);
                let _ = io::stdout().flush();
            }
            Err(e) => eprintln!("JSON Serialize Error (Event): {}", e),
        }
    }

    fn send_error(&self, msg: String) {
        self.send_response(Response::Error(msg));
    }

    fn handle_command<T>(
        &mut self,
        cmd: Command,
        target: &winit::event_loop::EventLoopWindowTarget<T>,
    ) {
        match cmd {
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
                buffer_size,
                sample_rate,
            } => match self.start_audio(Some(host), input, output, sample_rate, buffer_size) {
                Ok(_) => self.send_response(Response::Success),
                Err(e) => self.send_error(e.to_string()),
            },
            Command::Stop => {
                self.stop_audio();
                self.send_response(Response::Success);
            }
            Command::LoadPlugin { path } => {
                // Delegated to PluginManager
                match self.plugin_manager.load_plugin(
                    &path,
                    self.current_sample_rate,
                    self.current_block_size,
                    self.current_channels,
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
            Command::UnloadPlugin { id } => {
                // Always close editor if open
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
            Command::ReorderPlugins { order } => {
                self.plugin_manager.order = order.clone();
                self.queue_audio_msg(self.make_reorder_message());
                self.send_response(Response::Success);
            }
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
                if active {
                    self.plugin_manager.bypassed.insert(id.clone());
                } else {
                    self.plugin_manager.bypassed.remove(&id);
                }
                if let Some(index) = self.plugin_manager.rt_index_of(&id) {
                    self.queue_audio_msg(AudioThreadMessage::SetBypass { index, active });
                }
                self.send_response(Response::Success);
            }
            Command::SetMute { id, active } => {
                if active {
                    self.plugin_manager.muted.insert(id.clone());
                } else {
                    self.plugin_manager.muted.remove(&id);
                }
                if let Some(index) = self.plugin_manager.rt_index_of(&id) {
                    self.queue_audio_msg(AudioThreadMessage::SetMute { index, active });
                }
                self.send_response(Response::Success);
            }
            Command::SetGain { id, value } => {
                self.plugin_manager.gains.insert(id.clone(), value);
                if let Some(index) = self.plugin_manager.rt_index_of(&id) {
                    self.queue_audio_msg(AudioThreadMessage::SetGain { index, value });
                }
                self.send_response(Response::Success);
            }
            Command::SetGlobalMute { active } => {
                self.queue_audio_msg(AudioThreadMessage::SetGlobalMute(active));
                self.send_response(Response::Success);
            }
            Command::SetInputGain { value } => {
                self.queue_audio_msg(AudioThreadMessage::SetInputGain(value));
                self.send_response(Response::Success);
            }
            Command::SetInputChannels { left, right } => {
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
            Command::GetPluginState { id } => match self.plugin_manager.get(&id) {
                Some(instance) => match instance.get_state() {
                    Ok(state) => self.send_response(Response::PluginState { id, state }),
                    Err(e) => self.send_error(format!("Failed to get state: {}", e)),
                },
                None => self.send_error("Plugin not found".to_string()),
            },
            Command::SetPluginState { id, state } => match self.plugin_manager.get(&id) {
                Some(instance) => match instance.set_state(&state) {
                    Ok(_) => self.send_response(Response::Success),
                    Err(e) => self.send_error(format!("Failed to set state: {}", e)),
                },
                None => self.send_error("Plugin not found".to_string()),
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
        self.start_audio_impl(
            host_name,
            input_device,
            output_device,
            sample_rate,
            buffer_size,
            true,
        )
    }

    #[allow(deprecated)]
    fn start_audio_impl(
        &mut self,
        host_name: Option<String>,
        input_name: Option<String>,
        output_name: Option<String>,
        sample_rate: Option<u32>,
        buffer_size: Option<u32>,
        allow_fallback: bool,
    ) -> Result<()> {
        if self.output_stream.is_some() {
            self.stop_audio();
        }

        self.send_event(EngineEvent::Log(format!(
            "Start Audio Request: Host={:?}, Input={:?}, Output={:?}, SR={:?}, Buf={:?}",
            host_name, input_name, output_name, sample_rate, buffer_size
        )));

        let host_name_str = host_name
            .as_deref()
            .ok_or_else(|| anyhow!("Host name not specified"))?;
        let host_id_str = match host_name_str {
            "ASIO" => cpal::HostId::Asio,
            "Wasapi" => cpal::HostId::Wasapi,
            _ => return Err(anyhow!("Unsupported host: {}", host_name_str)),
        };
        let host =
            cpal::host_from_id(host_id_str).map_err(|e| anyhow!("Failed to init host: {}", e))?;

        // 1. Resolve Devices (Delegated to DeviceManager)
        let in_dev = if let Some(name) = &input_name {
            DeviceManager::resolve_input_device(&host, name)
                .ok_or_else(|| anyhow!("Input device not found: {}", name))?
        } else {
            host.default_input_device()
                .ok_or_else(|| anyhow!("No default input device"))?
        };

        let out_dev = if let Some(name) = &output_name {
            DeviceManager::resolve_output_device(&host, name)
                .ok_or_else(|| anyhow!("Output device not found: {}", name))?
        } else {
            host.default_output_device()
                .ok_or_else(|| anyhow!("No default output device"))?
        };

        // 2. Resolve Config (Same logic as before, just cleaner in main flow)
        let mut out_stream_config: cpal::StreamConfig = out_dev.default_output_config()?.config();

        if let Some(rate) = sample_rate {
            if let Ok(configs) = out_dev.supported_output_configs() {
                if let Some(_) = configs
                    .into_iter()
                    .find(|c| c.min_sample_rate() <= rate && c.max_sample_rate() >= rate)
                {
                    out_stream_config.sample_rate = rate;
                }
            }
        }
        if let Some(size) = buffer_size {
            out_stream_config.buffer_size = cpal::BufferSize::Fixed(size);
        }

        let mut in_stream_config: cpal::StreamConfig = in_dev.default_input_config()?.config();
        in_stream_config.sample_rate = out_stream_config.sample_rate;
        if let Some(size) = buffer_size {
            in_stream_config.buffer_size = cpal::BufferSize::Fixed(size);
        }

        let safe_max_block_size = 4096usize.max(self.current_block_size);
        self.current_sample_rate = out_stream_config.sample_rate as f64;
        self.current_block_size = match out_stream_config.buffer_size {
            cpal::BufferSize::Fixed(s) => s as usize,
            _ => 512,
        };
        self.current_channels = out_stream_config.channels as usize;

        // Force detection of Locked Buffer Size (ASIO)
        if let Ok(def) = out_dev.default_output_config() {
            if let cpal::SupportedBufferSize::Range { min, max } = def.buffer_size() {
                eprintln!("[Config] Device Buffer Range: min={}, max={}", min, max);
                if *min == *max && *min as usize != self.current_block_size {
                    eprintln!(
                        "[Config] Detected Locked Buffer Size override: {} -> {}",
                        self.current_block_size, *min
                    );
                    self.current_block_size = *min as usize;
                }
            }
        }

        // Register active devices with DeviceManager for OOP scan merge
        // This ensures the currently used device appears in device list even when OOP scanner can't see it
        {
            use crate::ipc::DeviceInfo;

            // Get max channels for input device
            let in_channels: u16 = in_dev
                .supported_input_configs()
                .ok()
                .map(|iter| iter.map(|c| c.channels()).max().unwrap_or(2))
                .unwrap_or(2);

            // Get max channels for output device
            let out_channels: u16 = out_dev
                .supported_output_configs()
                .ok()
                .map(|iter| iter.map(|c| c.channels()).max().unwrap_or(2))
                .unwrap_or(2);

            // Get buffer range for input device
            let in_buf_range: Option<(u32, u32)> = {
                let mut min_buf = u32::MAX;
                let mut max_buf = 0u32;
                let mut found = false;
                if let Ok(iter) = in_dev.supported_input_configs() {
                    for c in iter {
                        if let cpal::SupportedBufferSize::Range { min, max } = c.buffer_size() {
                            if *min < min_buf {
                                min_buf = *min;
                            }
                            if *max > max_buf {
                                max_buf = *max;
                            }
                            found = true;
                        }
                    }
                }
                if found && min_buf <= max_buf {
                    Some((min_buf, max_buf))
                } else {
                    None
                }
            };

            // Get buffer range for output device
            let out_buf_range: Option<(u32, u32)> = {
                let mut min_buf = u32::MAX;
                let mut max_buf = 0u32;
                let mut found = false;
                if let Ok(iter) = out_dev.supported_output_configs() {
                    for c in iter {
                        if let cpal::SupportedBufferSize::Range { min, max } = c.buffer_size() {
                            if *min < min_buf {
                                min_buf = *min;
                            }
                            if *max > max_buf {
                                max_buf = *max;
                            }
                            found = true;
                        }
                    }
                }
                if found && min_buf <= max_buf {
                    Some((min_buf, max_buf))
                } else {
                    None
                }
            };

            let in_name = input_name
                .clone()
                .unwrap_or_else(|| in_dev.name().unwrap_or_default());
            let out_name = output_name
                .clone()
                .unwrap_or_else(|| out_dev.name().unwrap_or_default());

            self.device_manager.set_active_input(DeviceInfo {
                name: in_name,
                host: host_name_str.to_string(),
                is_input: true,
                buffer_size_range: in_buf_range,
                channels: in_channels,
            });

            self.device_manager.set_active_output(DeviceInfo {
                name: out_name,
                host: host_name_str.to_string(),
                is_input: false,
                buffer_size_range: out_buf_range,
                channels: out_channels,
            });
        }

        // Error Handler
        let err_fn_ipc = |err: cpal::StreamError| {
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

        let retire_rb = HeapRb::<RetiredProcessor>::new(32);
        let (mut retire_prod, retire_cons) = retire_rb.split();
        self.retire_rx = Some(retire_cons);

        let level_rb = HeapRb::<MeterLevels>::new(4096);
        let (mut level_prod, level_cons) = level_rb.split();
        self.level_rx = Some(level_cons);

        let channel_rb = HeapRb::<[f32; 32]>::new(16); // Small buffer for low-rate scan data
        let (mut channel_prod, channel_cons) = channel_rb.split();
        self.channel_rx = Some(channel_cons);

        let audio_rb_size = (self.current_sample_rate as usize / 2) * 2;
        let audio_rb = HeapRb::<f32>::new(audio_rb_size.max(8192));
        let (mut audio_prod, mut audio_cons) = audio_rb.split();

        // 3. Prepare Processors (Delegated to PluginManager)
        let mut processors_vec = self.plugin_manager.prepare_for_audio_start(
            self.current_sample_rate,
            self.current_channels,
            safe_max_block_size,
        );

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

        // RT State Setup (all fixed-capacity / no resize in callback)
        let max_len = safe_max_block_size
            .saturating_mul(self.current_channels)
            .max(16384);
        // let mut scratch_buf = vec![0.0; max_len]; // Deprecated
        let mut input_buf = vec![0.0; max_len];

        // Planar Buffers (Vector of Vectors)
        // Pre-allocate for max expected channels (e.g., 8).
        // Each inner vector is pre-allocated to max block size.
        let max_ch = 32; // Generous limit
        let mut planar_buf_a: Vec<Vec<f32>> = (0..max_ch)
            .map(|_| vec![0.0; 4096.max(safe_max_block_size)])
            .collect();
        let mut planar_buf_b: Vec<Vec<f32>> = (0..max_ch)
            .map(|_| vec![0.0; 4096.max(safe_max_block_size)])
            .collect();

        let mut rt_processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        let mut rt_active_count: usize = 0;
        while let Some((idx, proc)) = processors_vec.pop() {
            let slot = idx as usize;
            if slot < MAX_PLUGINS {
                if rt_processors[slot].is_none() {
                    rt_processors[slot] = Some(proc);
                    rt_active_count += 1;
                }
            }
        }

        let mut rt_global_mute = false;
        let mut rt_input_gain = 1.0f32;
        let mut rt_input_l = self.input_channel_l;
        let mut rt_input_r = self.input_channel_r;
        let mut rt_scan_enabled = self.scan_enabled;

        let frames_counter = self.frames_processed.clone();
        let channels_len = out_stream_config.channels as usize;

        let stats_max_jitter = Arc::new(AtomicU64::new(0));
        let stats_glitches = Arc::new(AtomicU64::new(0));
        self.stats_max_jitter = stats_max_jitter.clone();
        self.stats_glitches = stats_glitches.clone();

        let mut last_callback_inst = Instant::now();
        let expected_period_micros =
            (self.current_block_size as u64 * 1000000) / self.current_sample_rate as u64;

        let mmcss_set_out = Arc::new(AtomicBool::new(false));
        let mut pending_retire: [Option<RetiredProcessor>; MAX_PLUGINS] =
            std::array::from_fn(|_| None);

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

        let output_stream = match out_dev.build_output_stream(
            &out_stream_config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                // Flush any pending retire messages first (never drop VST objects in RT thread)
                for slot in 0..MAX_PLUGINS {
                    if let Some(retired) = pending_retire[slot].take() {
                        match retire_prod.try_push(retired) {
                            Ok(()) => {}
                            Err(retired) => {
                                pending_retire[slot] = Some(retired);
                                break;
                            }
                        }
                    }
                }

                let now = Instant::now();
                let delta = now.duration_since(last_callback_inst).as_micros() as u64;
                last_callback_inst = now;

                // Jitter Calc
                if delta > 0 && expected_period_micros > 0 {
                    let jitter = if delta > expected_period_micros {
                        delta - expected_period_micros
                    } else {
                        0
                    };
                    let current_max = stats_max_jitter.load(Ordering::Relaxed);
                    if jitter > current_max {
                        stats_max_jitter.store(jitter, Ordering::Relaxed);
                    }
                    if jitter > (expected_period_micros / 2) {
                        stats_glitches.fetch_add(1, Ordering::Relaxed);
                    }
                }

                if !mmcss_set_out.load(Ordering::Relaxed) {
                    unsafe {
                        use windows::Win32::System::Threading::{
                            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
                        };
                        let _ =
                            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
                    }
                    mmcss_set_out.store(true, Ordering::Relaxed);
                }

                if channels_len > 0 {
                    let _ = frames_counter
                        .fetch_add((data.len() / channels_len) as u64, Ordering::Relaxed);
                }

                // Process Commands
                while let Some(msg) = consumer.try_pop() {
                    match msg {
                        AudioThreadMessage::AddProcessor {
                            index,
                            processor,
                            initial_gain,
                        } => {
                            let slot = index as usize;
                            if slot < MAX_PLUGINS {
                                if rt_processors[slot].is_none() {
                                    rt_processors[slot] = Some(processor);
                                    rt_active_count += 1;
                                    rt_gains[slot] = Smoother::new_ramp(0.0, initial_gain);
                                }
                            }
                        }
                        AudioThreadMessage::RemoveProcessor { index } => {
                            let slot = index as usize;
                            if slot < MAX_PLUGINS {
                                if pending_retire[slot].is_none() {
                                    if let Some(proc) = rt_processors[slot].take() {
                                        let retired = RetiredProcessor {
                                            index,
                                            processor: proc,
                                        };
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
                        AudioThreadMessage::SetGlobalMute(active) => {
                            rt_global_mute = active;
                        }
                        AudioThreadMessage::SetInputGain(val) => {
                            rt_input_gain = val;
                        }
                        AudioThreadMessage::SetInputChannels(l, r) => {
                            rt_input_l = l;
                            rt_input_r = r;
                        }
                        AudioThreadMessage::SetChannelScan(enable) => {
                            rt_scan_enabled = enable;
                        }
                        AudioThreadMessage::Stop => {}
                    }
                }

                if channels_len == 0 {
                    return;
                }
                let channels = channels_len;
                let frames = data.len() / channels;

                // --- 1. Efficient Input Data Fetch & De-interleaving ---
                if planar_buf_a.len() != channels {
                    planar_buf_a.resize(channels, vec![0.0; max_len]);
                    planar_buf_b.resize(channels, vec![0.0; max_len]);
                }

                let available = audio_cons.occupied_len();
                let to_read = frames * channels;

                if input_buf.len() < to_read {
                    // Safety: Resize input buffer if callback delivers more frames than negotiated.
                    // This allocation in RT thread is not ideal, but better than a panic/crash.
                    input_buf.resize(to_read, 0.0);
                }

                let read_count = if available >= to_read {
                    audio_cons.pop_slice(&mut input_buf[..to_read])
                } else {
                    audio_cons.pop_slice(&mut input_buf[..to_read.min(available)])
                };

                if read_count < to_read {
                    input_buf[read_count..to_read].fill(0.0);
                }

                // De-interleave & Metering
                let mut in_max_l = 0.0;
                let mut in_max_r = 0.0;

                // Channel Scanning (For UI Smart Selector)
                let mut channel_peaks = [0.0f32; 32]; // Max 32 channels scan
                let scan_limit = channels.min(32);

                for ch in 0..channels {
                    if planar_buf_a[ch].len() < frames {
                        planar_buf_a[ch].resize(frames, 0.0);
                    }
                    // Planar buffers for plugins logic...
                    // No need to resize B here if we don't assume plugins increase channel count dynamically in this scope
                    if planar_buf_b[ch].len() < frames {
                        planar_buf_b[ch].resize(frames, 0.0);
                    }
                }

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

                if rt_active_count > 0 && rt_order_len > 0 {
                    for i_order in 0..rt_order_len {
                        let idx = rt_order[i_order] as usize;
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
                                if ch < in_bufs.len() && ch < out_bufs.len() {
                                    if in_bufs[ch].len() >= frames && out_bufs[ch].len() >= frames {
                                        out_bufs[ch][..frames]
                                            .copy_from_slice(&in_bufs[ch][..frames]);
                                    }
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
                                for ch in 0..channels {
                                    planar_buf_a[ch][..frames].fill(0.0);
                                }
                            } else {
                                for ch in 0..channels {
                                    planar_buf_b[ch][..frames].fill(0.0);
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
                            if (smoother.current - 1.0).abs() > 0.0001
                                || (smoother.target - 1.0).abs() > 0.0001
                            {
                                let target_buf = if current_source_is_a {
                                    &mut planar_buf_a
                                } else {
                                    &mut planar_buf_b
                                };

                                let mut frame_idx = 0;
                                while frame_idx < frames {
                                    let gain = smoother.next();
                                    for ch in 0..channels {
                                        target_buf[ch][frame_idx] *= gain;
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

                if rt_global_mute {
                    data.fill(0.0);
                    // Zero metering too implies output is silence
                    let _ = level_prod.try_push(MeterLevels {
                        input: [in_max_l, in_max_r],
                        output: [0.0, 0.0],
                    });
                } else {
                    // Initialize output with silence
                    data.fill(0.0);

                    // Map processed "Main" (0/1) back to the selected physical device channels
                    // (Symmetric Routing / Insert Logic)
                    let target_l = rt_input_l;
                    let target_r = rt_input_r;

                    for i in 0..frames {
                        // Left
                        if target_l < channels {
                            let out_idx = i * channels + target_l;
                            if out_idx < data.len() {
                                data[out_idx] = final_buf[0][i];
                            }
                        }
                        // Right
                        if target_r < channels {
                            let out_idx = i * channels + target_r;
                            if out_idx < data.len() {
                                data[out_idx] = final_buf[1][i];
                            }
                        }
                    }

                    // Metering: Scan final_buf directly (Pre-Routing / "Main Output" level)
                    let out_max_l = final_buf[0][..frames]
                        .iter()
                        .fold(0.0f32, |m, &x| m.max(x.abs()));
                    let out_max_r = final_buf[1][..frames]
                        .iter()
                        .fold(0.0f32, |m, &x| m.max(x.abs()));

                    let _ = level_prod.try_push(MeterLevels {
                        input: [in_max_l, in_max_r],
                        output: [out_max_l, out_max_r],
                    });
                }
            },
            err_fn_ipc,
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                let error_jp = match &e {
                    cpal::BuildStreamError::DeviceNotAvailable => "デバイスが見つかりません。切断されたか、他アプリが排他制御している可能性があります。",
                    cpal::BuildStreamError::StreamConfigNotSupported => "指定された設定（サンプルレート/バッファ）はこのデバイスでサポートされていません。",
                    cpal::BuildStreamError::InvalidArgument => "無効なパラメータが指定されました。",
                    cpal::BuildStreamError::StreamIdOverflow => "ストリームIDオーバーフロー",
                    cpal::BuildStreamError::BackendSpecific { .. } => "バックエンドエラー",
                };
                let detailed_msg = format!("{} (Original: {})", error_jp, e);
                eprintln!("Failed to build output stream: {}", detailed_msg);

                if allow_fallback {
                    if let Ok(def) = out_dev.default_output_config() {
                        eprintln!(
                            "[Config] Fallback! Retrying with Default: {} Hz",
                            def.sample_rate()
                        );
                        return self.start_audio_impl(
                            retry_host_out,
                            retry_input_out,
                            retry_output_out,
                            Some(def.sample_rate()),
                            None,
                            false,
                        );
                    }
                }
                return Err(anyhow!(
                    "Stream Build Failed (Fallback exhausted): {}",
                    detailed_msg
                ));
            }
        };

        // --- Input Stream Setup (MOVED HERE) ---
        let retry_host_in = host_name.clone();
        let retry_input_in = input_name.clone();
        let retry_output_in = output_name.clone();

        let mmcss_set_in = Arc::new(AtomicBool::new(false));

        let input_stream = match in_dev.build_input_stream(
            &in_stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !mmcss_set_in.load(Ordering::Relaxed) {
                    unsafe {
                        use windows::Win32::System::Threading::{
                            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
                        };
                        let _ =
                            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
                    }
                    mmcss_set_in.store(true, Ordering::Relaxed);
                }
                for &sample in data {
                    let _ = audio_prod.try_push(sample);
                }
            },
            move |err| {
                let msg = OutputMessage::Event(EngineEvent::Error(format!(
                    "Input Stream Error: {}",
                    err
                )));
                if let Ok(json) = serde_json::to_string(&msg) {
                    println!("IPC:{}", json);
                }
            },
            None,
        ) {
            Ok(s) => s,
            Err(e) => {
                let error_jp = match &e {
                    cpal::BuildStreamError::DeviceNotAvailable => "デバイスが見つかりません。切断されたか、他アプリが排他制御している可能性があります。",
                    cpal::BuildStreamError::StreamConfigNotSupported => "指定された設定（サンプルレート/バッファ）はこのデバイスでサポートされていません。",
                    cpal::BuildStreamError::InvalidArgument => "無効なパラメータが指定されました。",
                    cpal::BuildStreamError::StreamIdOverflow => "ストリームIDオーバーフロー",
                    cpal::BuildStreamError::BackendSpecific { .. } => "バックエンドエラー",
                };
                let detailed_msg = format!("{} (Original: {})", error_jp, e);
                eprintln!("[Engine] Failed to build input stream: {}", detailed_msg);

                // Note: Fallback logic here is tricky because Output is already built.
                // Ideally we drop output and recurse, but for this specific experiment we just error or try simple fallback.
                // We reuse the retry variables captured at top of function (but we need to clone them again if we use them)
                // actually we defined retry_host_in above.
                if allow_fallback {
                    eprintln!("[Config] Fallback (INPUT post-output)! (Simplified retry strategy)");
                    // Simply fail complex retry for now to keep experiment clean, or reuse same recurrence
                    if let Ok(def) = out_dev.default_output_config() {
                        return self.start_audio_impl(
                            retry_host_in,
                            retry_input_in,
                            retry_output_in,
                            Some(def.sample_rate()),
                            None,
                            false, // stop recursion
                        );
                    }
                }
                return Err(anyhow!(
                    "Input Stream Build Failed (Post-Output): {}",
                    detailed_msg
                ));
            }
        };
        self.input_stream = Some(input_stream);

        self.send_event(EngineEvent::Log(
            "Attempting to start Output Stream...".to_string(),
        ));
        if let Err(e) = output_stream.play() {
            let err_msg = format!("Output Stream play() failed: {}", e);
            self.send_event(EngineEvent::Error(err_msg.clone()));
            return Err(anyhow!(err_msg));
        }
        self.send_event(EngineEvent::Log(
            "Output Stream started successfully.".to_string(),
        ));
        self.output_stream = Some(output_stream);

        // Start Input stream now (Deferred for ASIO compatibility)
        if let Some(in_stream) = &self.input_stream {
            self.send_event(EngineEvent::Log(
                "Attempting to start Input Stream...".to_string(),
            ));
            if let Err(e) = in_stream.play() {
                let err_msg = format!("Input Stream play() failed: {}", e);
                self.send_event(EngineEvent::Error(err_msg.clone()));
                return Err(anyhow!(err_msg));
            }
            self.send_event(EngineEvent::Log(
                "Input Stream started successfully.".to_string(),
            ));
        }

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

    fn stop_audio(&mut self) {
        if let Some(tx) = &mut self.command_tx {
            let _ = tx.try_push(AudioThreadMessage::Stop);
        }
        self.input_stream = None;
        self.output_stream = None;
        self.command_tx = None;
        self.level_rx = None;
        self.retire_rx = None;
        self.pending_audio_msgs.clear();
    }
}
