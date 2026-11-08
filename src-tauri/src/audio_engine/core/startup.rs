//! 起動時の非RT準備とストリーム構築。資源の回収・再試行は lifecycle に従う。
use super::input::{InputCallback, InputStream};
use super::*;
#[path = "startup_callbacks.rs"]
mod callbacks;
pub(super) use callbacks::PluginControls;
use callbacks::*;

struct ResolvedDevices {
    input: Option<cpal::Device>,
    output: cpal::Device,
    is_asio: bool,
}

fn resolve_source_devices(
    host_name_str: &str,
    input_name: Option<&str>,
    output_name: Option<&str>,
    device_ids: &(Option<String>, Option<String>),
    process_input: bool,
) -> Result<ResolvedDevices> {
    let host_id_str = resolve_host_id(host_name_str)?;
    let host =
        cpal::host_from_id(host_id_str).map_err(|e| anyhow!("Failed to init host: {}", e))?;

    // 1. Resolve Devices (Delegated to DeviceManager)
    validate_device_ids(device_ids)?;
    let in_dev = if process_input {
        None
    } else {
        Some(if let Some(id) = &device_ids.0 {
            DeviceManager::resolve_input_device_by_id(&host, id)
                .ok_or_else(|| anyhow!("入力機器のIDを確認できません。機器を選び直してください"))?
        } else if let Some(name) = input_name {
            DeviceManager::resolve_input_device(&host, name)
                .ok_or_else(|| anyhow!("Input device not found: {}", name))?
        } else {
            host.default_input_device()
                .ok_or_else(|| anyhow!("No default input device"))?
        })
    };

    let out_dev = if let Some(id) = &device_ids.1 {
        DeviceManager::resolve_output_device_by_id(&host, id)
            .ok_or_else(|| anyhow!("出力機器のIDを確認できません。機器を選び直してください"))?
    } else if let Some(name) = output_name {
        DeviceManager::resolve_output_device(&host, name)
            .ok_or_else(|| anyhow!("Output device not found: {}", name))?
    } else {
        host.default_output_device()
            .ok_or_else(|| anyhow!("No default output device"))?
    };
    let is_asio = host_id_str == cpal::HostId::Asio;
    let (in_dev, out_dev) = if let Some(input) = in_dev {
        let (input, output) =
            DeviceManager::coordinated_pair(input, out_dev, is_asio, |device: &cpal::Device| {
                device.id().map_err(Into::into)
            })?;
        (Some(input), output)
    } else {
        (None, out_dev)
    };
    DeviceManager::verify_selected_ids(
        device_ids,
        in_dev
            .as_ref()
            .and_then(|d| d.id().ok())
            .map(|id| id.to_string()),
        out_dev.id().ok().map(|id| id.to_string()),
    )?;
    Ok(ResolvedDevices {
        input: in_dev,
        output: out_dev,
        is_asio,
    })
}

fn resolve_host_id(host_name: &str) -> Result<cpal::HostId> {
    match host_name {
        "ASIO" => Ok(cpal::HostId::Asio),
        "Wasapi" | "WASAPI" => Ok(cpal::HostId::Wasapi),
        _ => Err(anyhow!("Unsupported host: {}", host_name)),
    }
}

fn validate_device_ids(device_ids: &(Option<String>, Option<String>)) -> Result<()> {
    for id in [&device_ids.0, &device_ids.1].into_iter().flatten() {
        if id.is_empty() || id.len() > 4096 || id.chars().any(char::is_control) {
            return Err(anyhow!("機器の識別情報が不正です"));
        }
    }
    Ok(())
}

impl Engine {
    // 非RTで機器一覧へ今回の選択結果を登録する。
    #[allow(clippy::too_many_arguments, deprecated)]
    fn register_start_devices(
        &mut self,
        host_name_str: &str,
        input_name: &Option<String>,
        output_name: &Option<String>,
        in_dev: &Option<cpal::Device>,
        out_dev: &cpal::Device,
        in_capabilities: &capabilities::CapabilitySnapshot,
        out_capabilities: &capabilities::CapabilitySnapshot,
        in_stream_config: &cpal::StreamConfig,
        out_stream_config: &cpal::StreamConfig,
    ) {
        use crate::ipc::DeviceInfo;

        let in_buf_range = in_capabilities.buffer_range();
        let out_buf_range = out_capabilities.buffer_range();
        let in_name = input_name.clone().unwrap_or_else(|| {
            in_dev
                .as_ref()
                .and_then(|d| d.name().ok())
                .unwrap_or_else(|| "アプリ入力".into())
        });
        let out_name = output_name
            .clone()
            .unwrap_or_else(|| out_dev.name().unwrap_or_default());

        self.device_manager.set_active_input(DeviceInfo {
            name: in_name,
            host: host_name_str.to_string(),
            id: in_dev
                .as_ref()
                .and_then(|d| d.id().ok())
                .map(|id| id.to_string()),
            is_input: true,
            buffer_size_range: in_buf_range,
            channels: in_stream_config.channels,
            sample_rate_ranges: if self.current_host_is_asio {
                in_capabilities.native_rate_ranges()
            } else {
                in_capabilities.f32_rate_ranges()
            },
            is_default: false,
        });

        self.device_manager.set_active_output(DeviceInfo {
            name: out_name,
            host: host_name_str.to_string(),
            id: out_dev.id().ok().map(|id| id.to_string()),
            is_input: false,
            buffer_size_range: out_buf_range,
            channels: out_stream_config.channels,
            sample_rate_ranges: if self.current_host_is_asio {
                out_capabilities.native_rate_ranges()
            } else {
                out_capabilities.f32_rate_ranges()
            },
            is_default: false,
        });
    }

    // callbackへ移すプラグインの固定長状態は起動スレッド上で作る。
    pub(super) fn prepare_plugin_controls(&mut self) -> PluginControls {
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

        // 再起動では PluginControls を作り直す。token も振り直して、停止前の異常を採用しない。
        let health_tokens = self.plugin_manager.assign_processing_tokens();
        let health_shared = self.plugin_manager.health_shared();
        for (slot, token) in health_tokens.iter().copied().enumerate() {
            if token != 0 {
                health_shared.publish(slot, false, 0, token);
            }
        }
        let sample_rate = if self.current_sample_rate.is_finite() && self.current_sample_rate >= 1.0
        {
            self.current_sample_rate.round().min(u32::MAX as f64) as u32
        } else {
            // プラグインのない起動前の構築だけがレート未確定。実行中は確定済みレートで作る。
            48_000
        };
        PluginControls {
            bypassed: rt_bypassed,
            muted: rt_muted,
            gains: rt_gains,
            order: rt_order,
            order_len: rt_order_len,
            health: [crate::audio_engine::plugin_health::SlotHealth::default(); MAX_PLUGINS],
            health_tokens,
            limits: crate::audio_engine::plugin_health::HealthLimits::new(sample_rate),
            health_shared,
        }
    }

    // 機器の選択後、処理に使う構成と固定容量を確定する。
    #[allow(clippy::too_many_arguments)]
    fn prepare_stream_geometry(
        &mut self,
        in_stream_config: &mut cpal::StreamConfig,
        out_stream_config: &mut cpal::StreamConfig,
        out_capabilities: &capabilities::CapabilitySnapshot,
        in_capabilities: &capabilities::CapabilitySnapshot,
        is_asio: bool,
        policy: lifecycle::StartupPolicy,
        music_input: bool,
    ) -> Result<(bool, Option<u32>)> {
        dsp::NoiseGeometry::guard(
            out_stream_config.sample_rate,
            self.noise_reduction_enabled && !music_input,
        )
        .map_err(|e| anyhow!(e))?;
        self.current_sample_rate = out_stream_config.sample_rate as f64;
        self.current_block_size = match out_stream_config.buffer_size {
            cpal::BufferSize::Fixed(s) => s as usize,
            _ => 512,
        };
        self.current_channels = out_stream_config.channels as usize;
        self.current_host_is_asio = is_asio;

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
                in_capabilities.same_rate_input(in_stream_config, out_stream_config.sample_rate)
            })
            .flatten();
        let used_preferred_input = preferred_input.is_some();
        if let Some(config) = preferred_input {
            *in_stream_config = config;
        }
        // 起動試行の選択結果だけを非RTで記録する。実機の同率受理はbuild/play成功と照合する。
        log::debug!(
            "[Config] Selected rates: input={} output={} input_channels={} preferred_input={}",
            in_stream_config.sample_rate,
            out_stream_config.sample_rate,
            in_stream_config.channels,
            used_preferred_input
        );

        self.current_input_channels = in_stream_config.channels as usize;
        self.resolve_start_channels()?;

        // 今回の要求・固定サイズ検出後に全処理段の上限を揃える。
        let effective_fixed_block = match out_stream_config.buffer_size {
            cpal::BufferSize::Fixed(frames) => Some(frames),
            cpal::BufferSize::Default => None,
        };
        self.fixed_buffer_request_frames = effective_fixed_block;
        self.configure_processing_capacity(effective_fixed_block, default_max_block)?;

        Ok((used_preferred_input, effective_fixed_block))
    }

    pub(super) fn start_audio_attempt(
        &mut self,
        mut request: AudioStartRequest,
        mut policy: lifecycle::StartupPolicy,
    ) -> Result<()> {
        // callback準備を含む大きなフレームを再帰で重ねない。
        // 再試行は一度戻ってローカル所有値を回収してから、既存policyの上限内で行う。
        while let Some((next_request, next_policy)) = self.try_start_audio(request, policy)? {
            request = next_request;
            policy = next_policy;
        }
        Ok(())
    }

    #[allow(deprecated)]
    #[inline(never)]
    fn try_start_audio(
        &mut self,
        request: AudioStartRequest,
        policy: lifecycle::StartupPolicy,
    ) -> Result<Option<(AudioStartRequest, lifecycle::StartupPolicy)>> {
        let AudioStartRequest {
            input_source,
            host_name,
            input_name,
            output_name,
            sample_rate,
            buffer_size,
            device_ids,
        } = request;
        self.last_processing_preparation = "start_audio";
        self.builtin
            .invalidate_history_with_reason(crate::audio_engine::history::Reason::StreamChanged);
        if self.output_stream.is_some() || self.input_stream.is_some() {
            // 同じStart内の再設定は、利用者のStop通知と区別する。
            // 成功時はStartedだけを通知し、失敗時はstart_audio_implがStoppedを送る。
            self.clear_audio_resources();
        }

        self.send_event(EngineEvent::Log(format!(
            "Start Audio Request: Host={:?}, Input={:?}, Output={:?}, SR={:?}, Buf={:?}",
            host_name, input_name, output_name, sample_rate, buffer_size
        )));

        self.input_source = input_source.clone();
        let process_spec = input_source.as_ref().and_then(|s| match &s.source {
            crate::input_source::Config::ProcessLoopback(config) => s
                .target
                .as_ref()
                .map(|target| (config.clone(), target.clone())),
            _ => None,
        });
        let is_process = process_spec.is_some();
        let music_input = input_source
            .as_ref()
            .is_some_and(|s| s.source.purpose() == crate::input_source::Purpose::Music);
        let host_name_str = host_name
            .as_deref()
            .ok_or_else(|| anyhow!("Host name not specified"))?;
        let resolving_started = Instant::now();
        let ResolvedDevices {
            input: in_dev,
            output: out_dev,
            is_asio,
        } = resolve_source_devices(
            host_name_str,
            input_name.as_deref(),
            output_name.as_deref(),
            &device_ids,
            is_process,
        )?;
        let noise_identity = if let Some((config, _)) = &process_spec {
            anyhow::ensure!(
                out_dev.id()?.1 != config.raw_endpoint_id,
                "原音用と本人用の出力先を分けてください"
            );
            Some(format!("process:{}", config.app_key))
        } else {
            in_dev
                .as_ref()
                .and_then(|d| d.id().ok())
                .map(|id| id.to_string())
        };
        if let Some(mixing) = &self.mixing_start {
            let input_id = in_dev
                .as_ref()
                .map(|input| input.id().map(|id| id.to_string()))
                .transpose()?;
            mixing
                .config
                .source
                .validate_primary(input_id.as_deref(), &out_dev.id()?.1)
                .map_err(anyhow::Error::msg)?;
        }
        // 同じASIO deviceを共有すると確認できた組だけ、従来の共通時計を使う。
        let common_clock = is_asio
            && in_dev.as_ref().is_some_and(|input| {
                input
                    .id()
                    .ok()
                    .zip(out_dev.id().ok())
                    .is_some_and(|(input, output)| input == output)
            });
        let adaptive_primary = self.mixing_start.is_some() && !common_clock;

        self.bind_noise_input(noise_identity);
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
        let in_capabilities = if let Some(in_dev) = &in_dev {
            capabilities::timed("capability_input", || {
                capabilities::CapabilitySnapshot::capture(
                    || in_dev.default_input_config().map_err(Into::into),
                    || in_dev.supported_input_configs().map_err(Into::into),
                )
            })?
        } else {
            // プロセス取得は明示した48kHz stereo f32。通常入力機器の能力照会はしない。
            capabilities::CapabilitySnapshot::capture(
                || {
                    Ok(cpal::SupportedStreamConfig::new(
                        2,
                        48000,
                        cpal::SupportedBufferSize::Unknown,
                        cpal::SampleFormat::F32,
                    ))
                },
                || Ok(Vec::<cpal::SupportedStreamConfigRange>::new().into_iter()),
            )?
        };
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
                    if let Some((next_policy, fallback_rate)) = policy
                        .retry_default_output()
                        .zip(out_capabilities.default_retry_rate())
                    {
                        lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                            self.clear_audio_resources()
                        });
                        return Ok(Some((
                            AudioStartRequest {
                                input_source: input_source.clone(),
                                host_name,
                                input_name,
                                output_name,
                                sample_rate: Some(fallback_rate),
                                buffer_size: None,
                                device_ids: device_ids.clone(),
                            },
                            next_policy,
                        )));
                    }
                    return Err(error);
                }
            }
        }

        if is_process {
            anyhow::ensure!(
                !is_asio && out_stream_config.channels == 2,
                "アプリ入力の出力はWASAPI stereoを選んでください"
            );
        }
        let input_format = if is_asio {
            in_capabilities.native_format()
        } else {
            cpal::SampleFormat::F32
        };
        let output_format = if is_asio {
            out_capabilities.native_format()
        } else {
            cpal::SampleFormat::F32
        };

        let (used_preferred_input, effective_fixed_block) = self.prepare_stream_geometry(
            &mut in_stream_config,
            &mut out_stream_config,
            &out_capabilities,
            &in_capabilities,
            is_asio,
            policy,
            music_input,
        )?;

        self.register_start_devices(
            host_name_str,
            &input_name,
            &output_name,
            &in_dev,
            &out_dev,
            &in_capabilities,
            &out_capabilities,
            &in_stream_config,
            &out_stream_config,
        );

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
        let mut loudness_start = crate::audio_engine::queue_recovery::MeasurementGate::default();

        let rt_channel_scan = self.prepare_channel_scan(in_stream_config.sample_rate);
        let scan_control = self.scan_control.clone();
        let channel_rb = HeapRb::<crate::audio_engine::channel_scan::Snapshot>::new(16); // Small buffer for low-rate scan data
        let (channel_prod, channel_cons) = channel_rb.split();
        self.channel_rx = Some(channel_cons);

        let audio_rb_frames = if is_process || adaptive_primary {
            crate::audio_engine::process_capture::clock::queue_capacity(
                if is_process {
                    crate::audio_engine::process_capture::RATE
                } else {
                    in_stream_config.sample_rate
                },
                out_stream_config.sample_rate,
                self.processing_block_capacity,
            )?
        } else {
            (self.current_sample_rate as usize / 2).max(4096)
        };
        let audio_rb = Arc::new(HeapRb::<f32>::new(
            audio_rb_frames * self.current_input_channels,
        ));
        self.queue_attempt = self
            .queue_attempt
            .checked_add(1)
            .ok_or_else(|| anyhow!("queue観測世代の上限です"))?;
        let queue_diagnostics = QueueDiagnostics::new_input_queue(
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
        );
        let queue_diagnostics = Arc::new(if adaptive_primary {
            queue_diagnostics.with_raw_input_clock()
        } else {
            queue_diagnostics
        });
        self.queue_diagnostics = Some(queue_diagnostics.clone());
        self.queue_observer = Some(audio_rb.clone());
        self.queue_state = QueueState::Preparing;
        self.queue_slots_at_stop = None;
        // 同率の原点・recorder構築位置は従来どおり。異率は変換準備後に別modeで構築する。
        let (mut input_timing, mut output_timing) = if !is_process
            && !adaptive_primary
            && in_stream_config.sample_rate == out_stream_config.sample_rate
        {
            let (timing, input, output) = crate::audio_engine::frame_timing::Observer::new(
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
        let mut queue_recovery = crate::audio_engine::queue_recovery::Recovery::new(
            audio_rb.capacity().get() / in_stream_config.channels as usize,
            out_stream_config.sample_rate as usize,
            1,
            3,
        );
        let (audio_prod, mut audio_cons) = audio_rb.split();

        // 3. Prepare Processors (Delegated to PluginManager)
        let (sample_rate, capacity, channels) = self.processor_setup();
        let processors_vec = capabilities::timed("processor_prepare", || {
            self.plugin_manager
                .prepare_for_audio_start(sample_rate, channels, capacity)
        });
        let mut processors_vec = processors_vec?;

        let mut plugin_controls = self.prepare_plugin_controls();

        let channels_len = out_stream_config.channels as usize;
        let max_frames_per_callback = self.processing_block_capacity;
        // 固定容量をコールバックの構築前に確保する。
        let CallbackBuffers {
            input: mut input_buf,
            planar_a: mut planar_buf_a,
            planar_b: mut planar_buf_b,
        } = CallbackBuffers::new(
            self.current_input_channels,
            channels_len,
            max_frames_per_callback,
        );

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
        let mut rt_peak = crate::audio_engine::peak_protection::Rt::new(
            self.peak_config,
            self.current_sample_rate as u32,
        );
        let (mut rt_global_mute, mut rt_input_gain, mut rt_output_gain) =
            self.initial_callback_levels();
        let mut rt_comparison = crate::audio_engine::comparison::Transition::new(
            self.global_bypass,
            self.current_sample_rate as u32,
        );
        self.stream_failed.store(false, Ordering::Release);
        self.processing_restart_revision = crate::vst_host::instance::processing_restart_revision();
        self.gain_main_device = out_dev.id().ok().map(|id| id.to_string());
        let (capture_tx, capture_rx) = auto_gain::capture_queue();
        self.gain_capture_rx = Some(capture_rx);
        let mut rt_capture = auto_gain::RtCapture::new(
            self.gain_shared.clone(),
            capture_tx,
            self.current_sample_rate as u32,
        );
        let mut rt_input_l = self.input_channel_l;
        let mut rt_physical_input = [self.input_channel_l, self.input_channel_r];
        let rt_output_routing = self.output_routing;
        let mut rt_input_r = self.input_channel_r;
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
        let mut rt_voice = crate::audio_engine::live_modes::RtVoice::new(
            crate::audio_engine::live_modes::Voice::prepare(
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

        let callback_rate = self.current_sample_rate as u32;
        let callback_diagnostics = Arc::new(CallbackDiagnostics::default());
        self.callback_diagnostics = callback_diagnostics.clone();

        let mmcss_set_out = Arc::new(AtomicBool::new(false));
        let (mut callback_processors, returned_processors) = callback_owner(CallbackProcessors {
            reverb: crate::audio_engine::reverb::Reverb::new(
                initial_builtin.reverb.unwrap_or_default(),
                callback_rate,
            )
            .map_err(|error| anyhow!(error))?,
            processors: rt_processors,
            pending_retire: std::array::from_fn(|_| None),
            pending_rejected: crate::audio_engine::deferred_drop::DeferredDrop::new(),
        });
        self.processor_return = Some(returned_processors);
        self.resampling_failed.store(false, Ordering::Release);
        self.block_capacity_failed.store(false, Ordering::Release);
        self.nr_failed.store(false, Ordering::Release);
        let output_nr_failed = self.nr_failed.clone();
        let output_resampling_failed = self.resampling_failed.clone();
        let output_capacity_failed = self.block_capacity_failed.clone();
        let output_stream_failed = self.stream_failed.clone();

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
        let queue_input_channels = if self.live_output_config.split_processing {
            2
        } else {
            channels
        };

        let resampler = if is_process || adaptive_primary {
            None
        } else {
            crate::audio_engine::resampling::prepare(in_rate, out_rate, channels)?
        };
        let batch_timing = resampler.is_some();
        if let Some(resampler) = &resampler {
            let (timing, input, output) = crate::audio_engine::frame_timing::Observer::new_batch(
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
                match crate::audio_engine::live_output::Sink::start(
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
        let mut broadcast_frames: Option<crate::audio_engine::split_monitor::BroadcastRx> = None;
        let mut broadcast_mixer = None;
        let mut broadcast_block = if self.live_output_config.split_processing {
            vec![
                crate::audio_engine::split_monitor::BroadcastFrame::default();
                max_frames_per_callback
            ]
        } else {
            Vec::new()
        };
        let mut upstream_recovery = vec![1.0f32; max_frames_per_callback];
        if separated {
            anyhow::ensure!(channels_len == 2, "処理分離の出力構成を開始できません");
            let queue = Arc::new(
                HeapRb::<crate::audio_engine::split_monitor::BroadcastFrame>::new(
                    (self.current_sample_rate as usize / 5).max(2),
                ),
            );
            let (tx, rx) = queue.clone().split();
            let unused = Arc::new(HeapRb::<f32>::new(2));
            let original_consumer = std::mem::replace(&mut audio_cons, unused.split().1);
            let mode = self
                .live_modes
                .snapshot(self.builtin.snapshot(false).epoch, false)
                .target;
            let (controller, mut renderer) =
                crate::audio_engine::split_monitor::Controller::prepare_with_input_channels(
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
                    self.restored_monitor.as_ref(),
                    channels,
                )?;
            if let Some(start) = self.mixing_start.clone() {
                self.mixing_shared = Some(Arc::new(
                    crate::audio_engine::mixing::controls::Shared::new_at(
                        &start.config.levels,
                        self.mixing_revision,
                    ),
                ));
                self.sync_mixing_latency()?;
                let shared = self
                    .mixing_shared
                    .as_ref()
                    .ok_or_else(|| anyhow!("ミックスの設定を取得できません"))?
                    .clone();
                shared
                    .primary_input_rate
                    .store(in_stream_config.sample_rate, Ordering::Relaxed);
                shared
                    .primary_output_rate
                    .store(out_stream_config.sample_rate, Ordering::Relaxed);
                shared
                    .primary_adaptive
                    .store(adaptive_primary, Ordering::Relaxed);
                let (source, source_render) =
                    crate::audio_engine::mixing::input::Controller::prepare(
                        &start,
                        out_stream_config.sample_rate,
                        self.mode_silence.shared.clone(),
                        max_frames_per_callback,
                    )?;
                let source_shared = source_render.shared.clone();
                let monitor = crate::audio_engine::mixing::runtime::Monitor::new(
                    source_render,
                    shared.clone(),
                    out_stream_config.sample_rate,
                )?;
                let clock = adaptive_primary
                    .then(|| {
                        crate::audio_engine::process_capture::clock::Renderer::with_rates_and_capacity(
                            in_stream_config.sample_rate,
                            out_stream_config.sample_rate,
                            audio_rb_frames,
                        )
                    })
                    .transpose()?;
                renderer
                    .get_mut()
                    .configure_mixing(monitor, clock, shared.clone());
                let (mixer, owner) =
                    callback_owner(crate::audio_engine::mixing::runtime::Broadcast::new(
                        out_stream_config.sample_rate,
                        shared,
                        source_shared.clone(),
                    )?);
                self.mixing_worker_owner = Some(owner);
                self.mixing_source = Some(source);
                self.mixing_input_shared = Some(source_shared);
                broadcast_mixer = Some(mixer);
            }
            if self.live_output.is_none() {
                controller.shared.failed.store(true, Ordering::Release);
            }
            worker_controls = Some(controller.shared.clone());
            broadcast_frames = Some(rx);
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
        let process_shared = is_process.then(|| {
            Arc::new(crate::audio_engine::process_capture::Shared::new(
                self.stream_failed.clone(),
            ))
        });
        self.process_shared = process_shared.clone();
        let mut process_renderer = if is_process {
            let (callback, owner) = callback_owner(
                crate::audio_engine::process_capture::clock::Renderer::with_rates_and_capacity(
                    crate::audio_engine::process_capture::RATE,
                    out_stream_config.sample_rate,
                    audio_rb_frames,
                )?,
            );
            self.process_renderer_owner = Some(owner);
            Some(callback)
        } else {
            None
        };
        let process_output_shared = process_shared.clone();
        let mut process_starved_at = None;
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
        let mut post_epoch = 0u64;
        let mut post_previous = None;
        let post_mix_controls = self.mixing_shared.clone();
        let mut post_renderer = if let Some(mapping) = &mut self.post_mapping {
            anyhow::ensure!(
                separated && self.mixing_start.is_some() && mapping.ready() && !mapping.failed(),
                "ミックス後VSTの準備が整っていません"
            );
            anyhow::ensure!(
                mapping.descriptor().sample_rate == out_stream_config.sample_rate,
                "ミックス後VSTと本人用出力のrateが変わりました。停止して設定し直してください"
            );
            let (callback, owner) = callback_owner(
                crate::audio_engine::post_mix::ClientRenderer::new(mapping.client()?),
            );
            self.post_renderer_owner = Some(owner);
            Some(callback)
        } else {
            None
        };
        let build_output = || {
            let output_build_started = Instant::now();
            let mut output_cadence = OutputCadence::new(callback_rate);
            let mut process_output =
                move |data: &mut [f32], info: Option<&cpal::OutputCallbackInfo>| {
                    if dsp_silence.drain_worker() {
                        if let Some(mixer) = &mut broadcast_mixer {
                            mixer.get_mut().reset();
                        }
                        if let Some(queue) = &mut broadcast_frames {
                            queue.skip(queue.occupied_len());
                        } else {
                            audio_cons.skip(
                                audio_cons.occupied_len() / queue_input_channels
                                    * queue_input_channels,
                            );
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
                            if let Some(mixer) = &mut broadcast_mixer {
                                mixer.get_mut().reset();
                            }
                            let skipped = broadcast_frames.as_mut().map_or_else(
                                || audio_cons.skip(audio_cons.occupied_len() / 2 * 2) / 2,
                                |queue| queue.skip(queue.occupied_len()),
                            );
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
                    if let Some(queue) = &mut broadcast_frames {
                        for (index, frame) in
                            broadcast_block[..actual_frames].iter_mut().enumerate()
                        {
                            let Some(value) = queue.try_pop() else {
                                output_stream_failed.store(true, Ordering::Release);
                                data.fill(0.0);
                                return;
                            };
                            *frame = value;
                            upstream_recovery[index] = value.recovery_gain;
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
                    flush_pending_retire(pending_retire, &mut retire_prod);

                    let now = Instant::now();
                    if !mmcss_set_out.load(Ordering::Relaxed) {
                        // SAFETY: 現在のコールバックスレッドの疑似ハンドルと定義済み優先度を渡す。
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

                    if !apply_commands(CommandContext {
                        consumer: &mut consumer,
                        retire_prod: &mut retire_prod,
                        pending_rejected,
                        pending_retire,
                        rt_processors,
                        rt_active_count: &mut rt_active_count,
                        rt_gains: &mut plugin_controls.gains,
                        rt_bypassed: &mut plugin_controls.bypassed,
                        rt_muted: &mut plugin_controls.muted,
                        rt_order: &mut plugin_controls.order,
                        rt_order_len: &mut plugin_controls.order_len,
                        rt_health: &mut plugin_controls.health,
                        rt_health_tokens: &mut plugin_controls.health_tokens,
                        health_shared: &plugin_controls.health_shared,
                        rt_cohort_change_applied: &mut rt_cohort_change_applied,
                        output_timing: &mut output_timing,
                        worker_generation_controls: worker_generation_controls.as_deref(),
                        measurement_ready,
                        upstream_first_frame,
                        rt_voice: &mut rt_voice,
                        rt_reverb,
                        live_shared: &live_shared,
                        rt_global_mute: &mut rt_global_mute,
                        rt_comparison: &mut rt_comparison,
                        rt_input_gain: &mut rt_input_gain,
                        rt_input_l: &mut rt_input_l,
                        rt_input_r: &mut rt_input_r,
                        rt_physical_input: &mut rt_physical_input,
                        separated,
                        rt_noise_control: &mut rt_noise_control,
                        rt_noise_learning: &mut rt_noise_learning,
                        output_nr_failed: &output_nr_failed,
                        noise_applied_revision: &noise_applied_revision,
                        builtin_applied: &builtin_applied,
                        rt_loudness: &mut rt_loudness,
                        loudness_start: &mut loudness_start,
                        queue_recovery: &queue_recovery,
                        measurement_processed: &mut measurement_processed,
                        rt_output_gain: &mut rt_output_gain,
                        rt_capture: &mut rt_capture,
                        rt_voice_check: &mut rt_voice_check,
                        rt_test_tone: &mut rt_test_tone,
                    }) {
                        data.fill(0.0);
                        return;
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
                        audio_cons.occupied_len() / queue_input_channels,
                        frames,
                        output_queue_diagnostics.max_burst(),
                        recovery_blocked || separated || is_process,
                    );
                    if skip_frames > 0 {
                        if let Some(timing) = &output_timing {
                            timing.invalidate_recovery();
                        }
                        // f32のskipはindex更新。完全frameだけをconsumerが回収する。
                        let skipped = audio_cons.skip(skip_frames * queue_input_channels)
                            / queue_input_channels;
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
                    let to_read = frames * queue_input_channels;
                    let (consumed_frames, timing_read) = if broadcast_frames.is_some() {
                        for (output, frame) in input_buf[..to_read]
                            .as_chunks_mut::<2>()
                            .0
                            .iter_mut()
                            .zip(&broadcast_block[..frames])
                        {
                            *output = frame.voice;
                        }
                        (frames, 0)
                    } else if let Some(renderer) = &mut process_renderer {
                        use crate::audio_engine::process_capture::clock::Interleaved;
                        let renderer = renderer.get_mut();
                        let before = renderer.rendered;
                        renderer
                            .render(&mut input_buf[..to_read], &mut Interleaved(&mut audio_cons));
                        if renderer.failed {
                            let shared = process_output_shared
                                .as_ref()
                                .expect("プロセス取得の共有状態");
                            if !renderer.failed_underrun {
                                shared.failed.store(true, Ordering::Release);
                            } else {
                                let began = process_starved_at.get_or_insert(shared.elapsed_ms());
                                if shared.packet_age_ms() >= 30 {
                                    let discarded = audio_cons.occupied_len() / 2;
                                    audio_cons.skip(discarded * 2);
                                    shared.paused(discarded);
                                    renderer.wait_for_audio();
                                    process_starved_at = None;
                                } else if shared.elapsed_ms().saturating_sub(*began) >= 100 {
                                    shared.failed.store(true, Ordering::Release);
                                }
                            }
                        }
                        if let Some(shared) = &process_output_shared {
                            shared.rendered(renderer, audio_cons.occupied_len() / 2);
                        }
                        (renderer.rendered.saturating_sub(before) as usize, 0)
                    } else if let Some(timing) = &output_timing {
                        queue_diagnostics::read_complete_frames_observed(
                            &mut audio_cons,
                            &mut input_buf[..to_read],
                            queue_input_channels,
                            || timing.now_ns(),
                        )
                    } else {
                        (
                            queue_diagnostics::read_complete_frames(
                                &mut audio_cons,
                                &mut input_buf[..to_read],
                                queue_input_channels,
                            ),
                            0,
                        )
                    };
                    // 分離時の主入力キューは本人用callbackだけが読む。
                    // 配信workerまで加えると読出しと不足を二重計上してしまう。
                    if !separated {
                        output_queue_diagnostics.record_output(frames, consumed_frames);
                    }

                    let ([in_max_l, in_max_r], record_block_start) = route_and_meter_input(
                        frames,
                        queue_input_channels,
                        &input_buf,
                        rt_input_l,
                        rt_input_r,
                        rt_input_gain,
                        &mut planar_buf_a,
                        channels,
                        &mut rt_voice_check,
                    );

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

                    if !music_input {
                        if channels >= 2 {
                            rt_noise_learning.analyze_block(
                                &planar_buf_a[0][..frames],
                                Some(&planar_buf_a[1][..frames]),
                                frames,
                            );
                        } else if channels == 1 {
                            rt_noise_learning.analyze_block(
                                &planar_buf_a[0][..frames],
                                None,
                                frames,
                            );
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
                                        .load(Ordering::Relaxed)
                                        as f32
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
                    }

                    rt_comparison
                        .begin_block(frames, rt_active_count > 0 && plugin_controls.order_len > 0);
                    let comparison_settled = rt_comparison.settled();
                    let current_source_is_a = plugin_controls.process(PluginBlock {
                        processors: rt_processors,
                        planar_buf_a: &mut planar_buf_a,
                        planar_buf_b: &mut planar_buf_b,
                        channels,
                        frames,
                        active_count: rt_active_count,
                        global_bypass: rt_comparison.bypassed(),
                    });

                    // --- 3. Result Interleaving & Output Metering ---
                    let final_buf = if current_source_is_a {
                        &mut planar_buf_a
                    } else {
                        &mut planar_buf_b
                    };
                    rt_comparison.apply(final_buf, channels, frames);

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
                    if let Some(mixer) = &mut broadcast_mixer {
                        mixer
                            .get_mut()
                            .process(final_buf, &broadcast_block[..frames]);
                    }
                    if let Some(renderer) = &mut post_renderer {
                        let music_generation = post_mix_controls
                            .as_ref()
                            .and_then(|shared| shared.read())
                            .map_or(0, |settings| settings.mute_generation);
                        let current = (dsp_silence.ticket(), worker_generation, music_generation);
                        if post_previous != Some(current) {
                            post_epoch = post_epoch.wrapping_add(1);
                            post_previous = Some(current);
                        }
                        let generation = post_epoch;
                        if !renderer.get_mut().process(
                            final_buf,
                            frames,
                            rt_global_mute,
                            generation,
                            rt_comparison.bypassed(),
                        ) {
                            output_stream_failed.store(true, Ordering::Release);
                            data.fill(0.0);
                            return;
                        }
                    }

                    let cohort_normal_mic = comparison_settled
                        && !rt_global_mute
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
                        let output_pair = if separated {
                            [0, 1]
                        } else {
                            super::super::queue_diagnostics::routed_output_pair(
                                rt_output_routing,
                                is_asio,
                                rt_physical_input,
                                channels,
                            )
                        };
                        let mut out_max_l = 0.0f32;
                        let mut out_max_r = 0.0f32;

                        for i in 0..frames {
                            let gain = rt_output_gain.next();
                            let (tone_l, tone_r) = rt_test_tone.sample();
                            let main_l = tone_l * gain;
                            let main_r = tone_r * gain;
                            let [main_l, main_r] = rt_peak.process([main_l, main_r]);

                            let sent = super::super::queue_diagnostics::write_output_frame(
                                &mut data[i * channels..(i + 1) * channels],
                                output_pair,
                                [main_l, main_r],
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
                        let output_pair = if separated {
                            [0, 1]
                        } else {
                            super::super::queue_diagnostics::routed_output_pair(
                                rt_output_routing,
                                is_asio,
                                rt_physical_input,
                                channels,
                            )
                        };
                        let mut out_max_l = 0.0f32;
                        let mut out_max_r = 0.0f32;

                        for i in 0..frames {
                            let gain = rt_output_gain.next();
                            let (main_l, main_r) = rt_voice_check.read_playback_sample();
                            let main_l = main_l * gain;
                            let main_r = main_r * gain;
                            let [main_l, main_r] = rt_peak.process([main_l, main_r]);

                            let sent = super::super::queue_diagnostics::write_output_frame(
                                &mut data[i * channels..(i + 1) * channels],
                                output_pair,
                                [main_l, main_r],
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

                        // 入力選択とは独立した、実際に存在する出力ペアへ送る。
                        let output_pair = if separated {
                            [0, 1]
                        } else {
                            super::super::queue_diagnostics::routed_output_pair(
                                rt_output_routing,
                                is_asio,
                                rt_physical_input,
                                channels,
                            )
                        };

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
                            let sent = super::super::queue_diagnostics::write_output_frame(
                                &mut data[i * channels..(i + 1) * channels],
                                output_pair,
                                [main_l, main_r],
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
                    measure_output_loudness(
                        data,
                        channels,
                        if separated {
                            [0, 1]
                        } else {
                            super::super::queue_diagnostics::routed_output_pair(
                                rt_output_routing,
                                is_asio,
                                rt_physical_input,
                                channels,
                            )
                        },
                        &mut rt_loudness,
                        &mut loudness_prod,
                    );
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
                let monitor_controls = controls.clone();
                match crate::audio_engine::split_monitor::Worker::start_gated(
                    move |data| {
                        let ticket = output_silence.ticket();
                        process_output(data, None);
                        output_silence.finish(
                            crate::audio_engine::mode_silence::MAIN,
                            ticket,
                            data,
                        );
                    },
                    queue,
                    controls,
                    self.stream_failed.clone(),
                    self.current_block_size.min(max_frames_per_callback).max(1),
                    self.mode_silence.shared.clone(),
                ) {
                    Ok(worker) => {
                        self.split_worker = Some(worker);
                        native_stream::build_output(
                            &out_dev,
                            &out_stream_config,
                            output_format,
                            max_frames_per_callback,
                            self.stream_failed.clone(),
                            move |data: &mut [f32], info| {
                                output_cadence.record(
                                    data.len() / channels_len,
                                    &stats_max_jitter,
                                    &stats_glitches,
                                );
                                monitor
                                    .get_mut()
                                    .render_gated(data, Some(info), &monitor_silence);
                                let pair = super::super::queue_diagnostics::routed_output_pair(
                                    rt_output_routing,
                                    is_asio,
                                    monitor_controls.input_pair(),
                                    2,
                                );
                                super::super::queue_diagnostics::route_stereo_monitor(data, pair);
                            },
                            err_fn_ipc,
                        )
                    }
                    Err(_) => Err(cpal::BuildStreamError::DeviceNotAvailable),
                }
            } else {
                native_stream::build_output(
                    &out_dev,
                    &out_stream_config,
                    output_format,
                    max_frames_per_callback,
                    self.stream_failed.clone(),
                    move |data: &mut [f32], info| {
                        output_cadence.record(
                            data.len() / channels_len,
                            &stats_max_jitter,
                            &stats_glitches,
                        );
                        let ticket = output_silence.ticket();
                        process_output(data, Some(info));
                        output_silence.finish(
                            crate::audio_engine::mode_silence::MAIN,
                            ticket,
                            data,
                        );
                    },
                    err_fn_ipc,
                )
            };
            capabilities::report_phase("output_build", output_build_started);
            output_result
        };

        let mut input_callback = InputCallback {
            scan_control,
            rt_channel_scan,
            channel_prod,
            channels,
            input_silence,
            input_silence_reset: 0,
            resampler,
            input_timing,
            input_process_failed,
            input_resampling_failed,
            input_queue_diagnostics,
            mmcss_set_in,
            audio_prod,
            batch_timing,
        };
        let build_input = || {
            let input_build_started = Instant::now();
            if let Some((config, target)) = process_spec {
                let InputCallback { audio_prod, .. } = input_callback;
                return crate::audio_engine::process_capture::Controller::prepare(
                    config,
                    target,
                    audio_prod,
                    process_shared.expect("プロセス取得の共有状態"),
                )
                .map(InputStream::Process)
                .map_err(|e| cpal::BuildStreamError::BackendSpecific {
                    err: cpal::BackendSpecificError {
                        description: e.to_string(),
                    },
                });
            }
            let input_result = native_stream::build_input(
                in_dev.as_ref().expect("機器入力の選択済みdevice"),
                &in_stream_config,
                input_format,
                max_frames_per_callback,
                self.stream_failed.clone(),
                move |data: &[f32], info: &cpal::InputCallbackInfo| {
                    input_callback.process(data, info);
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
            );
            capabilities::report_phase("input_build", input_build_started);
            input_result.map(InputStream::Device)
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

                if let Some((next_policy, fallback_rate)) = policy
                    .retry_default_output()
                    .zip(out_capabilities.default_retry_rate())
                {
                    log::warn!(
                        "[Config] Fallback! Retrying with Default: {} Hz",
                        out_capabilities.default_rate()
                    );
                    lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                        self.clear_audio_resources()
                    });
                    return Ok(Some((
                        AudioStartRequest {
                            input_source: input_source.clone(),
                            host_name: retry_host_out,
                            input_name: retry_input_out,
                            output_name: retry_output_out,
                            sample_rate: Some(fallback_rate),
                            buffer_size: None,
                            device_ids: device_ids.clone(),
                        },
                        next_policy,
                    )));
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
                    return Ok(Some((
                        AudioStartRequest {
                            input_source: input_source.clone(),
                            host_name: retry_host_in,
                            input_name: retry_input_in,
                            output_name: retry_output_in,
                            sample_rate: Some(out_stream_config.sample_rate),
                            buffer_size: effective_fixed_block,
                            device_ids: device_ids.clone(),
                        },
                        next_policy,
                    )));
                }
                // 既定入力も拒否された場合は、従来どおり出力の既定設定へ一度だけ戻す。
                if let Some((next_policy, fallback_rate)) = policy
                    .retry_default_output()
                    .zip(out_capabilities.default_retry_rate())
                {
                    log::warn!("[Config] Input fallback: retrying after output cleanup");
                    // 再試行より前にローカル出力とcallback所有値を回収する。
                    lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                        self.clear_audio_resources()
                    });
                    return Ok(Some((
                        AudioStartRequest {
                            input_source: input_source.clone(),
                            host_name: retry_host_in,
                            input_name: retry_input_in,
                            output_name: retry_output_in,
                            sample_rate: Some(fallback_rate),
                            buffer_size: None,
                            device_ids: device_ids.clone(),
                        },
                        next_policy,
                    )));
                }
                return Err(anyhow!("Input Stream Build Failed: {}", detailed_msg));
            }
        };
        // オケを準備し、ASIO共有driverは出力→入力、WASAPIは入力到着→出力の順を保つ。
        if let Some(source) = &self.mixing_source {
            source.play()?;
        }
        let streams = capabilities::timed("stream_play", || {
            let play_output = |stream: &cpal::Stream| {
                stream
                    .play()
                    .map_err(|e| anyhow!("Output Stream play() failed: {}", e))
            };
            let play_input = |stream: &InputStream| {
                stream
                    .play()
                    .map_err(|e| anyhow!("Input Stream play() failed: {}", e))
            };
            if is_asio {
                StreamPair::start_with(output_stream, input_stream, play_output, play_input)
            } else {
                let queue = self
                    .queue_observer
                    .as_ref()
                    .ok_or_else(|| anyhow!("入力キューがありません"))?;
                let channels = self.current_input_channels;
                let target = self
                    .current_block_size
                    .saturating_mul(2)
                    .min(queue.capacity().get() / channels);
                StreamPair::start_input_first_with(
                    output_stream,
                    input_stream,
                    play_output,
                    play_input,
                    || {
                        let frames = lifecycle::wait_for_input(
                            target,
                            in_stream_config.sample_rate,
                            || queue.occupied_len() / channels,
                            || self.stream_failed.load(Ordering::Acquire),
                        )?;
                        log::debug!("[StartupInput] ready_frames={frames} target_frames={target}");
                        Ok(())
                    },
                )
            }
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

        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_resolution_rejects_invalid_host_and_ids_without_opening_devices() {
        assert_eq!(resolve_host_id("ASIO").unwrap(), cpal::HostId::Asio);
        assert_eq!(resolve_host_id("Wasapi").unwrap(), cpal::HostId::Wasapi);
        assert_eq!(resolve_host_id("WASAPI").unwrap(), cpal::HostId::Wasapi);
        assert!(resolve_host_id("unknown").is_err());
        assert!(validate_device_ids(&(None, Some("device-id".into()))).is_ok());
        assert!(validate_device_ids(&(Some(String::new()), None)).is_err());
        assert!(validate_device_ids(&(None, Some("device\nid".into()))).is_err());
        assert!(validate_device_ids(&(Some("x".repeat(4097)), None)).is_err());
        assert!(validate_device_ids(&(Some("x".repeat(4096)), None)).is_ok());
    }

    #[test]
    fn callback_buffers_match_input_queue_and_output_processor_geometry() {
        for (input, output, frames) in [(8, 2, 512), (2, 8, 1024), (1, 1, 64), (3, 2, 256)] {
            let buffers = CallbackBuffers::new(input, output, frames);
            assert_eq!(buffers.input.len(), frames * input.max(2));
            for planar in [&buffers.planar_a, &buffers.planar_b] {
                assert_eq!(planar.len(), output.max(2));
                assert!(planar
                    .iter()
                    .all(|channel| channel.len() == frames && channel.iter().all(|v| *v == 0.0)));
            }
        }
    }

    #[test]
    fn preparing_controls_again_drops_the_previous_isolation() {
        use crate::audio_engine::restoration::{unix_ms, StagedRestore};
        use crate::ipc::RestorePluginRequest;
        use crate::vst_host::instance::with_mock_vst;
        with_mock_vst(false, |instance| {
            let mut engine = Engine::new();
            engine.current_sample_rate = 48_000.0;
            let staged = StagedRestore::load_with(
                RestorePluginRequest {
                    path: "mock.vst3".into(),
                    state: Some(String::new()),
                    bypassed: false,
                    muted: false,
                    gain: 1.0,
                },
                1,
                unix_ms() + 8_000,
                |_| Ok(instance),
            )
            .unwrap();
            let index = engine
                .plugin_manager
                .reserve_restored_index(&staged)
                .unwrap();
            engine.plugin_manager.commit_restored(staged, index);
            let old = engine.plugin_manager.mint_health_token(index);
            engine
                .plugin_manager
                .health_shared()
                .publish(index as usize, true, 4, old);
            assert_eq!(
                engine.plugin_manager.plugin_health_entries(),
                vec![crate::ipc::PluginHealthEntry {
                    id: engine.plugin_manager.order[0].clone(),
                    state: "isolated".into(),
                    invalid_blocks: 4,
                }]
            );
            let controls = engine.prepare_plugin_controls();
            assert!(engine.plugin_manager.plugin_health_entries().is_empty());
            assert!(!controls.health[index as usize].isolated);
            assert_ne!(controls.health_tokens[index as usize], 0);
            assert_ne!(controls.health_tokens[index as usize], old);
            assert_eq!(
                engine
                    .plugin_manager
                    .health_shared()
                    .isolated_blocks(index as usize, old),
                None
            );
        });
    }
}
