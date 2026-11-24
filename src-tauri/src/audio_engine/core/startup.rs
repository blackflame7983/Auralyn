//! 起動時の非RT準備とストリーム構築。資源の回収・再試行は lifecycle に従う。
use super::input::{InputCallback, InputStream};
use super::output::{OutputCallback, OutputCallbackContext};
use super::*;
#[path = "startup_callbacks.rs"]
mod callbacks;
pub(in crate::audio_engine::core) use callbacks::PluginBlock;
use callbacks::*;
pub(super) use callbacks::{
    apply_commands, flush_pending_retire, measure_output_loudness, route_and_meter_input,
    write_device_silence, CommandContext, PluginControls,
};

struct ResolvedDevices {
    input: Option<cpal::Device>,
    output: cpal::Device,
    is_asio: bool,
}

struct StartAttemptLog {
    started: Instant,
    host: Option<String>,
    input: Option<String>,
    output: Option<String>,
    requested_rate: Option<u32>,
    requested_buffer: Option<u32>,
    attempted_input: Option<cpal::StreamConfig>,
    attempted_output: Option<cpal::StreamConfig>,
    retry_reason: Option<String>,
}

impl StartAttemptLog {
    fn new(request: &AudioStartRequest) -> Self {
        Self {
            started: Instant::now(),
            host: request.host_name.clone(),
            input: request.input_name.clone(),
            output: request.output_name.clone(),
            requested_rate: request.sample_rate,
            requested_buffer: request.buffer_size,
            attempted_input: None,
            attempted_output: None,
            retry_reason: None,
        }
    }

    fn record_configs(&mut self, input: &cpal::StreamConfig, output: &cpal::StreamConfig) {
        self.attempted_input = Some(input.clone());
        self.attempted_output = Some(output.clone());
    }

    fn validate_configs(
        &self,
        input: &cpal::StreamConfig,
        output: &cpal::StreamConfig,
    ) -> Result<()> {
        capabilities::validate_stream_config(self.output.as_deref().unwrap_or("出力機器"), output)?;
        capabilities::validate_stream_config(self.input.as_deref().unwrap_or("アプリ入力"), input)
    }

    fn warn(&self, reason: &str) {
        log::warn!(
            "[StartupFailure] host={:?} input={:?} output={:?} requested_rate={:?} requested_buffer={:?} attempted_input={:?} attempted_output={:?} reason={} elapsed_ms={}",
            self.host, self.input, self.output, self.requested_rate, self.requested_buffer,
            self.attempted_input, self.attempted_output, reason, self.started.elapsed().as_millis()
        );
    }
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
        let mut controls = PluginControls::new(sample_rate, health_shared);
        controls.bypassed = rt_bypassed;
        controls.muted = rt_muted;
        controls.gains = rt_gains;
        controls.order = rt_order;
        controls.order_len = rt_order_len;
        controls.health_tokens = health_tokens;
        for slot in 0..MAX_PLUGINS {
            controls.transitions[slot] = super::slot_transition::SlotTransition::at_rest(
                sample_rate,
                self.plugin_manager.latency_samples_at(slot as u8),
                controls.bypassed[slot],
                controls.muted[slot],
            );
        }
        controls
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
        attempt: &mut StartAttemptLog,
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
        // locked補正や同率入力の採用後も、固定容量の確保より先に検査する。
        attempt.record_configs(in_stream_config, out_stream_config);
        attempt.validate_configs(in_stream_config, out_stream_config)?;
        // 起動試行の選択結果だけを非RTで記録する。実機の同率受理はbuild/play成功と照合する。
        log::debug!(
            "[Config] Selected rates: input={} output={} input_channels={} preferred_input={}",
            in_stream_config.sample_rate,
            out_stream_config.sample_rate,
            in_stream_config.channels,
            used_preferred_input
        );

        self.current_input_channels = in_stream_config.channels as usize;
        self.current_input_rate = in_stream_config.sample_rate;
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
        let mut attempt = StartAttemptLog::new(&request);
        let result = self.try_start_audio_inner(request, policy, &mut attempt);
        // 早期失敗と再試行の理由も、この非RT境界で一度だけ記録する。
        match &result {
            Err(error) => attempt.warn(&error.to_string()),
            Ok(Some(_)) => {
                if let Some(reason) = &attempt.retry_reason {
                    attempt.warn(reason);
                }
            }
            Ok(None) => {}
        }
        result
    }

    #[allow(deprecated)]
    #[inline(never)]
    fn try_start_audio_inner(
        &mut self,
        request: AudioStartRequest,
        policy: lifecycle::StartupPolicy,
        attempt: &mut StartAttemptLog,
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
        self.begin_stream_generation();
        self.last_processing_preparation = "start_audio";
        self.builtin
            .invalidate_history_with_reason(crate::audio_engine::history::Reason::StreamChanged);
        if self.output_stream.is_some() || self.input_stream.is_some() {
            // 同じStart内の再設定は、利用者のStop通知と区別する。
            // 成功時はStartedだけを通知し、失敗時はstart_audio_implがStoppedを送る。
            self.fade_before_stop();
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
        attempt.started = resolving_started;
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
        attempt.input = in_dev.as_ref().map(|device| {
            device
                .name()
                .unwrap_or_else(|_| input_name.clone().unwrap_or_default())
        });
        attempt.output = Some(
            out_dev
                .name()
                .unwrap_or_else(|_| output_name.clone().unwrap_or_default()),
        );
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
        attempt.record_configs(&in_stream_config, &out_stream_config);
        // ASIOの能力照合でも0 Hzを拒否するため、その前に具体的な理由を確保する。
        if let Err(error) = capabilities::validate_stream_config(
            attempt.output.as_deref().unwrap_or("出力機器"),
            &out_stream_config,
        ) {
            lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                self.clear_audio_resources()
            });
            return Err(error);
        }
        if is_asio {
            match in_capabilities.asio_input_config(
                &out_capabilities,
                &in_stream_config,
                &out_stream_config,
            ) {
                Ok(config) => in_stream_config = config,
                Err(error) => {
                    attempt.validate_configs(&in_stream_config, &out_stream_config)?;
                    if let Some((next_policy, fallback_rate)) = policy
                        .retry_default_output()
                        .zip(out_capabilities.default_retry_rate())
                        .filter(|_| lifecycle::allows_start_retry(attempt.started.elapsed()))
                    {
                        attempt.retry_reason = Some(error.to_string());
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
        attempt.record_configs(&in_stream_config, &out_stream_config);
        if let Err(error) = attempt.validate_configs(&in_stream_config, &out_stream_config) {
            lifecycle::release_devices_before_retry((in_dev, out_dev), || {
                self.clear_audio_resources()
            });
            return Err(error);
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
            attempt,
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
        let (producer, consumer) = ring.split();
        self.command_tx = Some(producer);

        let retire_rb = HeapRb::<DisposedProcessor>::new(32);
        let (retire_prod, retire_cons) = retire_rb.split();
        self.retire_rx = Some(retire_cons);

        let level_prod = self.prepare_meter_channel();
        let loudness_rb = HeapRb::<LoudnessReading>::new(64);
        let (loudness_prod, loudness_cons) = loudness_rb.split();
        self.loudness_rx = Some(loudness_cons);
        let rt_loudness = LoudnessMeter::new(self.current_sample_rate as u32);
        let loudness_start = crate::audio_engine::queue_recovery::MeasurementGate::default();

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
        let queue_recovery = crate::audio_engine::queue_recovery::Recovery::new(
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

        let plugin_controls = self.prepare_plugin_controls();

        let channels_len = out_stream_config.channels as usize;
        let max_frames_per_callback = self.processing_block_capacity;
        // 固定容量をコールバックの構築前に確保する。
        let CallbackBuffers {
            input: input_buf,
            planar_a: planar_buf_a,
            planar_b: planar_buf_b,
            planar_dry: planar_buf_dry,
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
        self.true_peak_shared.publish(
            self.true_peak_config
                .prepare(self.current_sample_rate as u32),
        );
        let peak_shared = self.peak_shared.clone();
        let rt_peak = crate::audio_engine::peak_protection::Rt::new(
            self.peak_config,
            self.current_sample_rate as u32,
        );
        let (rt_global_mute, mut rt_input_gain, rt_output_gain) = self.initial_callback_levels();
        let rt_comparison = crate::audio_engine::comparison::Transition::new(
            self.global_bypass,
            self.current_sample_rate as u32,
        );
        self.stream_failed.store(false, Ordering::Release);
        self.processing_restart_revision = crate::vst_host::instance::processing_restart_revision();
        self.gain_main_device = out_dev.id().ok().map(|id| id.to_string());
        let (capture_tx, capture_rx) = auto_gain::capture_queue();
        self.gain_capture_rx = Some(capture_rx);
        let rt_capture = auto_gain::RtCapture::new(
            self.gain_shared.clone(),
            capture_tx,
            self.current_sample_rate as u32,
        );
        let mut rt_input_l = self.input_channel_l;
        let rt_physical_input = [self.input_channel_l, self.input_channel_r];
        let rt_output_routing = self.output_routing;
        let mut rt_input_r = self.input_channel_r;
        let rt_sample_rate_hz = self.current_sample_rate.round().clamp(8_000.0, 192_000.0) as u32;
        let rt_noise_control = RtNoiseControl::prepare(
            self.current_sample_rate as u32,
            NoiseSettings {
                enabled: self.noise_reduction_enabled,
                mode: self.noise_control_mode,
                strength: self.noise_control_strength,
                voice_guard: self.noise_voice_guard,
            },
        );
        let rt_noise_learning = RtNoiseLearning::new(self.noise_learning.clone());
        let (initial_builtin, _) = self.initial_builtin()?;
        let rt_voice = crate::audio_engine::live_modes::RtVoice::new(
            crate::audio_engine::live_modes::Voice::prepare(
                &initial_builtin,
                self.current_sample_rate.round().clamp(8_000.0, 384_000.0) as u32,
            )
            .map_err(|error| anyhow!(error))?,
        );
        let initial_live_revision = self.live_modes.start();
        let initial_live_ack = false;
        let rt_cohort_change_applied = false;
        let live_shared = self.live_modes.shared.clone();
        let builtin_applied = self.builtin.applied.clone();
        let noise_applied_revision = self.noise_applied_revision.clone();
        noise_applied_revision.store(self.noise_command_revision, Ordering::Release);
        let voice_check_shared = self.voice_check.clone();
        let mut rt_voice_check = RtVoiceCheck::new(voice_check_shared, rt_sample_rate_hz);
        if let Some(buffers) = self.voice_check_buffers.current().cloned() {
            rt_voice_check.attach_buffers(buffers);
        }
        let rt_test_tone = RtTestTone::new(rt_sample_rate_hz);

        let frames_counter = self.frames_processed.clone();

        let stats_max_jitter = Arc::new(AtomicU64::new(0));
        let stats_glitches = Arc::new(AtomicU64::new(0));
        self.stats_max_jitter = stats_max_jitter.clone();
        self.stats_glitches = stats_glitches.clone();

        let callback_rate = self.current_sample_rate as u32;
        let callback_diagnostics = Arc::new(CallbackDiagnostics::default());
        self.callback_diagnostics = callback_diagnostics.clone();
        let output_callbacks = Arc::new(AtomicU64::new(0));
        let input_callbacks = Arc::new(AtomicU64::new(0));
        self.output_callbacks = output_callbacks.clone();
        self.input_callbacks = input_callbacks.clone();

        let mmcss_set_out = Arc::new(AtomicBool::new(false));
        let (callback_processors, returned_processors) = callback_owner(CallbackProcessors {
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
                    crate::audio_engine::live_output::SinkProtection {
                        stop_fade: self.stop_fade.clone(),
                        peak: (self.peak_config, self.peak_shared.clone()),
                        true_peak: (self.true_peak_config, self.true_peak_shared.clone()),
                    },
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
        let broadcast_block = if self.live_output_config.split_processing {
            vec![
                crate::audio_engine::split_monitor::BroadcastFrame::default();
                max_frames_per_callback
            ]
        } else {
            Vec::new()
        };
        let upstream_recovery = vec![1.0f32; max_frames_per_callback];
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
            renderer.get_mut().set_stop_fade(self.stop_fade.clone());
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
        let process_renderer = if is_process {
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
        let process_starved_at = None;
        let input_failed = self.stream_failed.clone();
        let input_process_failed = input_failed.clone();
        let input_resampling_failed = self.resampling_failed.clone();
        let worker_generation = 0;
        let upstream_consumed = 0u64;
        let measurement_processed = 0;
        let worker_generation_controls = worker_controls.clone();
        let dsp_silence = self.mode_silence.shared.clone();
        let output_silence = self.mode_silence.shared.clone();
        let monitor_silence = self.mode_silence.shared.clone();
        let input_silence = self.mode_silence.shared.clone();
        let post_epoch = 0u64;
        let post_previous = None;
        let post_mix_controls = self.mixing_shared.clone();
        let post_renderer = if let Some(mapping) = &mut self.post_mapping {
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
        let measure_output = self.round_trip.bridge();
        let measure_input = self.round_trip.bridge();
        let build_output = || {
            let output_build_started = Instant::now();
            let mut output_cadence = OutputCadence::new(callback_rate);
            let levels = monitor_levels.load(Ordering::Relaxed);
            let initial_monitor_gain = if separated {
                1.0
            } else if levels >> 32 != 0 {
                0.0
            } else {
                f32::from_bits(levels as u32)
            };
            let monitor_trim =
                super::super::gain_ramp::GainRamp::new(initial_monitor_gain, callback_rate);
            // スイープ用の領域はストリーム構築時に確保し、コールバックでは再利用する。
            let measure_bridge = measure_output;
            let measure_dry = vec![0.0f32; max_frames_per_callback.max(1)];
            let mut main_stop_fade = super::super::stop_fade::StopFadeRt::new(
                self.stop_fade.clone(),
                super::super::stop_fade::MAIN,
                callback_rate,
            );
            let mut output_callback = Box::new(OutputCallback {
                dsp_silence,
                measure_bridge,
                broadcast_mixer,
                broadcast_frames,
                audio_cons,
                queue_input_channels,
                rt_peak,
                peak_shared,
                live_sender,
                worker_generation_controls,
                worker_generation,
                upstream_consumed,
                output_timing,
                callback_processors,
                output_nr_failed,
                output_resampling_failed,
                output_stream_failed,
                output_capacity_failed,
                channels_len,
                max_frames_per_callback,
                broadcast_block,
                upstream_recovery,
                initial_live_ack,
                live_shared,
                initial_live_revision,
                retire_prod,
                mmcss_set_out,
                frames_counter,
                consumer,
                rt_active_count,
                plugin_controls,
                rt_cohort_change_applied,
                rt_voice,
                rt_global_mute,
                rt_comparison,
                rt_input_gain,
                rt_input_l,
                rt_input_r,
                rt_physical_input,
                separated,
                rt_noise_control,
                rt_noise_learning,
                noise_applied_revision,
                builtin_applied,
                rt_loudness,
                loudness_start,
                queue_recovery,
                measurement_processed,
                rt_output_gain,
                rt_capture,
                rt_voice_check,
                rt_test_tone,
                measure_dry,
                output_queue_diagnostics,
                is_process,
                process_renderer,
                process_output_shared,
                process_starved_at,
                input_buf,
                planar_buf_a,
                planar_buf_b,
                planar_buf_dry,
                music_input,
                post_mix_controls,
                post_renderer,
                post_epoch,
                post_previous,
                level_prod,
                rt_output_routing,
                is_asio,
                monitor_trim,
                monitor_levels,
                loudness_prod,
                callback_diagnostics,
            });
            let output_result = if let (Some(mut monitor), Some(queue), Some(controls)) =
                (monitor_renderer, broadcast_queue, worker_controls)
            {
                let monitor_controls = controls.clone();
                match crate::audio_engine::split_monitor::Worker::start_gated(
                    move |data| {
                        let ticket = output_silence.ticket();
                        output_callback.process(
                            data,
                            OutputCallbackContext {
                                info: None,
                                stop_fade: None,
                            },
                        );
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
                        let output_callbacks = output_callbacks.clone();
                        native_stream::build_output(
                            &out_dev,
                            &out_stream_config,
                            output_format,
                            max_frames_per_callback,
                            self.stream_failed.clone(),
                            move |data: &mut [f32], info| {
                                crate::audio_engine::processing_watch::note_callback(
                                    &output_callbacks,
                                );
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
                let output_callbacks = output_callbacks.clone();
                native_stream::build_output(
                    &out_dev,
                    &out_stream_config,
                    output_format,
                    max_frames_per_callback,
                    self.stream_failed.clone(),
                    move |data: &mut [f32], info| {
                        crate::audio_engine::processing_watch::note_callback(&output_callbacks);
                        output_cadence.record(
                            data.len() / channels_len,
                            &stats_max_jitter,
                            &stats_glitches,
                        );
                        let ticket = output_silence.ticket();
                        main_stop_fade.begin_block();
                        output_callback.process(
                            data,
                            OutputCallbackContext {
                                info: Some(info),
                                stop_fade: Some(&mut main_stop_fade),
                            },
                        );
                        output_silence.finish(
                            crate::audio_engine::mode_silence::MAIN,
                            ticket,
                            data,
                        );
                        main_stop_fade.end_block(data.len() / channels_len);
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
            input_callbacks,
            measure: measure_input,
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

                if let Some((next_policy, fallback_rate)) = policy
                    .retry_default_output()
                    .zip(out_capabilities.default_retry_rate())
                    .filter(|_| lifecycle::allows_start_retry(attempt.started.elapsed()))
                {
                    attempt.retry_reason = Some(detailed_msg);
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

                // 優先入力だけの拒否では、出力rateと有効bufferを変えず既定入力へ戻す。
                // build_pairがローカルstreamと未実行closureを回収した後だけ再準備する。
                if let Some(next_policy) = policy
                    .retry_default_input(used_preferred_input)
                    .filter(|_| lifecycle::allows_start_retry(attempt.started.elapsed()))
                {
                    attempt.retry_reason = Some(detailed_msg);
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
                    .filter(|_| lifecycle::allows_start_retry(attempt.started.elapsed()))
                {
                    attempt.retry_reason = Some(detailed_msg);
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

        let stream_generation = self.streams.started();
        self.send_event(EngineEvent::Started {
            sample_rate: self.current_sample_rate as u32,
            buffer_size: self.current_block_size as u32,
            stream_generation,
        });

        Ok(None)
    }
}

// 全出力枝でtrim・保護の後に同じ停止倍率を掛け、物理出力へ書く。
pub(super) fn write_faded_output_frame(
    output: &mut [f32],
    pair: [usize; 2],
    samples: [f32; 2],
    fade: Option<&mut super::super::stop_fade::StopFadeRt>,
) -> [f32; 2] {
    super::super::queue_diagnostics::write_output_frame(
        output,
        pair,
        fade.map_or(samples, |fade| fade.apply(samples)),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn fade481_main_sine_after_trim_routes_and_converges_without_allocations() {
        use crate::audio_engine::stop_fade::{SignalCheck, StopFade, StopFadeRt, MAIN};
        use std::sync::Arc;
        for pair in [[0, 1], [1, 0], [0, 0], [2, 3]] {
            let shared = Arc::new(StopFade::default());
            let mut rt = StopFadeRt::new(shared.clone(), MAIN, 48_000);
            let mut trim = crate::audio_engine::gain_ramp::GainRamp::new(0.7, 48_000);
            let mut check = SignalCheck::default();
            let mut generation = 0;
            let mut index = 0;
            let mut faded = 0u32;
            for block in 0..16 {
                if block == 3 {
                    generation = shared.request();
                }
                let frames = [31, 64, 127][block % 3];
                assert_eq!(
                    crate::dsp_verification_allocator::allocation_counts(|| {
                        rt.begin_block();
                        for _ in 0..frames {
                            let sample = 0.5
                                * (std::f32::consts::TAU * 1000.0 * index as f32 / 48000.0
                                    + std::f32::consts::FRAC_PI_3)
                                    .sin()
                                * trim.next();
                            index += 1;
                            let mut output = [0.0; 4];
                            super::write_faded_output_frame(
                                &mut output,
                                pair,
                                [sample, -sample],
                                Some(&mut rt),
                            );
                            if generation != 0 {
                                faded += 1;
                            }
                            let gain = if generation == 0 {
                                1.0
                            } else {
                                480u32.saturating_sub(faded) as f32 / 480.0
                            };
                            let right = if pair[0] == pair[1] {
                                output[pair[0]]
                            } else {
                                -output[pair[1]]
                            };
                            check.frame([output[pair[0]], right], [sample; 2], gain, 480);
                            for (ch, value) in output.iter().enumerate() {
                                if !pair.contains(&ch) {
                                    assert_eq!(*value, 0.0);
                                }
                            }
                        }
                        rt.end_block(frames);
                    }),
                    (0, 0)
                );
                if generation != 0 {
                    assert_eq!(shared.acknowledged(1 << MAIN, generation), faded >= 480);
                }
            }
            assert!(faded > 480);
            eprintln!(
                "fade481 main {pair:?}: max_step={:.9}, max_excess={:.9}",
                check.max_step, check.max_excess
            );
        }
    }

    use super::*;

    fn attempt_log() -> StartAttemptLog {
        StartAttemptLog::new(&AudioStartRequest {
            input_source: None,
            host_name: Some("ASIO".into()),
            input_name: Some("Input ASIO".into()),
            output_name: Some("Output ASIO".into()),
            sample_rate: Some(48_000),
            buffer_size: Some(512),
            device_ids: (None, None),
        })
    }

    #[test]
    fn invalid_input_config_keeps_device_and_bad_value_in_the_error() {
        let valid = cpal::StreamConfig {
            channels: 2,
            sample_rate: 48_000,
            buffer_size: cpal::BufferSize::Fixed(512),
        };
        let mut invalid = valid.clone();
        invalid.sample_rate = 0;
        let error = attempt_log()
            .validate_configs(&invalid, &valid)
            .unwrap_err()
            .to_string();
        assert!(error.contains("Input ASIO"));
        assert!(error.contains("0 Hz"));
    }

    #[test]
    fn locked_buffer_is_validated_before_processing_capacity_or_streams() {
        for locked in [0, 16_385] {
            let snapshot = capabilities::CapabilitySnapshot::capture(
                || {
                    Ok(cpal::SupportedStreamConfig::new(
                        2,
                        48_000,
                        cpal::SupportedBufferSize::Range {
                            min: locked,
                            max: locked,
                        },
                        cpal::SampleFormat::F32,
                    ))
                },
                || Ok(Vec::<cpal::SupportedStreamConfigRange>::new().into_iter()),
            )
            .unwrap();
            let mut output = snapshot.output_config(Some(48_000), Some(512));
            let mut input = snapshot.input_config(Some(512));
            let mut engine = Engine::new();
            let capacity_before = engine.processing_block_capacity;
            let mut attempt = attempt_log();
            let error = engine
                .prepare_stream_geometry(
                    &mut input,
                    &mut output,
                    &snapshot,
                    &snapshot,
                    true,
                    lifecycle::StartupPolicy::default(),
                    true,
                    &mut attempt,
                )
                .unwrap_err()
                .to_string();
            assert!(error.contains("Output ASIO"));
            assert!(error.contains(&format!("{locked} サンプル")));
            assert_eq!(engine.processing_block_capacity, capacity_before);
            assert!(engine.input_stream.is_none() && engine.output_stream.is_none());
            assert_eq!(
                attempt.attempted_output.unwrap().buffer_size,
                cpal::BufferSize::Fixed(locked)
            );
        }
    }

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
            for planar in [&buffers.planar_a, &buffers.planar_b, &buffers.planar_dry] {
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
                    class_id: None,
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
                    isolation_seq: 1,
                    token: old,
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
