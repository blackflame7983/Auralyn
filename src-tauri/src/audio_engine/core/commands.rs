//! コマンド受付と機能別処理への振り分け。
use super::*;

impl Engine {
    pub(super) fn handle_command<T>(
        &mut self,
        cmd: Command,
        target: &winit::event_loop::EventLoopWindowTarget<T>,
    ) {
        if !self.post_command_allowed(&cmd) {
            self.send_error(
                "ミックス後VSTのこの操作は、専用Engineを停止してから行ってください".into(),
            );
            return;
        }
        let latency_may_change = matches!(
            &cmd,
            Command::LoadPlugin { .. }
                | Command::RestorePlugin { .. }
                | Command::RestoreSessionPlugin { .. }
                | Command::UnloadPlugin { .. }
                | Command::ReorderPlugins { .. }
                | Command::SetBypass { .. }
                | Command::SetGlobalBypass { .. }
                | Command::SetNoiseReduction { .. }
                | Command::SetNoiseControlConfig { .. }
        );
        if let Err(error) = self.validate_input_start(&cmd) {
            self.send_error(error.to_string());
            return;
        }
        if let Err(error) = self.validate_mixing_start(&cmd) {
            self.send_error(error.to_string());
            return;
        }
        let music = self
            .input_source
            .as_ref()
            .is_some_and(|s| s.source.purpose() == crate::input_source::Purpose::Music);
        if music
            && matches!(
                &cmd,
                Command::StartNoiseLearning { .. }
                    | Command::StartVoiceCheckRecording { .. }
                    | Command::PlayVoiceCheck { .. }
                    | Command::NoiseMeasurement {
                        request: noise_learning::Request::Start { .. }
                    }
                    | Command::AutoGain {
                        request: auto_gain::Request::Begin { .. }
                    }
                    | Command::AutoGain {
                        request: auto_gain::Request::Apply { .. }
                    }
                    | Command::SetChannelScan { active: true }
            )
        {
            self.send_error(
                "音楽の入力では声向けの測定を使用できません。入力の用途を確認してください".into(),
            );
            return;
        }
        if self
            .input_source
            .as_ref()
            .is_some_and(|s| s.source != crate::input_source::Config::default())
            && (matches!(&cmd, Command::ConfigureLiveModes { armed: true, .. })
                || (matches!(&cmd, Command::CaptureBundleState)
                    && self
                        .input_source
                        .as_ref()
                        .is_some_and(|s| !s.source.supports_bundle_capture()))
                || matches!(&cmd, Command::LiveMode { request } if !matches!(request,
                    crate::audio_engine::live_modes::Request::Snapshot | crate::audio_engine::live_modes::Request::Disarm { .. })))
        {
            self.send_error("この入力は歌・雑談モードや配信状態の保存に未対応です。音声設定で入力を確認してください".into());
            return;
        }
        if self
            .input_source
            .as_ref()
            .is_some_and(|s| s.source != crate::input_source::Config::default())
            && matches!(&cmd, Command::LiveOutput { config: Some(c) } if c.split_processing)
        {
            self.send_error(
                "この入力は処理分離に未対応です。単一の処理経路を使ってください".into(),
            );
            return;
        }
        // 拒否時に保存intent/条件revision/pending queueを部分更新しない。
        let nr_enable = match &cmd {
            Command::SetNoiseReduction { active, .. }
            | Command::SetNoiseControlConfig { active, .. } => Some(*active),
            _ => None,
        };
        if let Some(active) = nr_enable {
            if self.processing_running() && !music {
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
        if let Err(error) = crate::audio_engine::live_modes::guard(
            self.live_modes.armed,
            self.live_modes.bound.as_ref(),
            &cmd,
        ) {
            self.send_error(error);
            return;
        }
        if matches!(
            &cmd,
            Command::BuiltinEffects {
                request: crate::audio_engine::builtin::Request::ApplyProposal { .. }
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
                    crate::audio_engine::history::Reason::StreamChanged
                } else {
                    crate::audio_engine::history::Reason::InputChanged
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
                | Command::ResumePlugin { .. }
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
        self.invalidate_auto_gain_for_command(&cmd);
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
            Command::PostMixStatus => {
                let mapping = self.post_mapping.as_ref();
                self.send_response(Response::PostMixStatus {
                    attached: mapping.is_some(),
                    ready: mapping.is_some_and(|m| m.ready()),
                    failed: mapping.is_some_and(|m| m.failed()),
                    sample_rate: mapping.map(|m| m.descriptor().sample_rate),
                    transport_latency_frames:
                        crate::audio_engine::post_mix::TRANSPORT_LATENCY_FRAMES,
                    declared_plugin_latency_frames: mapping.and_then(|m| m.plugin_latency_frames()),
                    processed_packets: mapping.map(|m| m.processed_packets()),
                });
            }
            Command::ProcessingState => self.send_response(Response::ProcessingState {
                present: self.processing_running(),
                failed: self.stream_failed.load(Ordering::Acquire),
            }),
            Command::PostMixPrepare { sample_rate } => match self.prepare_post_mix(sample_rate) {
                Ok(descriptor) => self.send_response(Response::PostMixDescriptor(descriptor)),
                Err(error) => self.send_error(error.to_string()),
            },
            Command::PostMixClear => {
                if self.processing_running() {
                    self.send_error("停止してからミックス後VSTを解除してください".into());
                } else {
                    self.post_mapping = None;
                    self.send_response(Response::Success);
                }
            }
            Command::PostMixStart { descriptor } => match self.start_post_mix(descriptor) {
                Ok(()) => self.send_response(Response::Success),
                Err(error) => self.send_error(error.to_string()),
            },
            Command::Mixing { request } => match self.mixing_command(request) {
                Ok(snapshot) => self.send_response(Response::Mixing(Box::new(snapshot))),
                Err(error) => self.send_error(error),
            },
            Command::ModeMonitor { request } => match self.mode_monitor_command(request) {
                Ok(snapshot) => self.send_response(Response::ModeMonitor(Box::new(snapshot))),
                Err(error) => self.send_error(error),
            },
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
                    self.processing_running(),
                    self.live_output_config.split_processing,
                    self.live_output.is_some(),
                    failed,
                ) {
                    Ok(value) => self.send_response(Response::ModeSilence(value)),
                    Err(error) => self.send_error(error),
                }
            }
            Command::StartIdentityCapability => {
                self.send_response(Response::StartIdentityCapability { version: 2 });
            }
            Command::ProcessInputCapability => {
                self.send_response(Response::ProcessInputCapability { version: 1 });
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
                    self.processing_running(),
                    self.live_output_config.split_processing,
                );
                status.pending |=
                    status.running && self.live_output.is_some() && self.peak_shared.sink_pending();
                self.send_response(Response::PeakProtection(status));
            }
            Command::BroadcastTruePeak { config } => {
                if let Some(config) = config {
                    if self.live_modes.armed {
                        self.send_error(
                            "本番保護を解除してから配信用 true-peak 制限を変更してください".into(),
                        );
                        return;
                    }
                    match config.validate() {
                        Ok(config) => {
                            self.true_peak_config = config;
                            self.true_peak_shared
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
                let status = self.true_peak_shared.status(
                    self.true_peak_config,
                    self.processing_running(),
                    self.true_peak_route(),
                    self.current_sample_rate.round().clamp(1.0, 384_000.0) as u32,
                );
                self.send_response(Response::BroadcastTruePeak(status));
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
                    if self.processing_running() && !config.same_route(&self.live_output_config) {
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
                    self.set_live_output_config(config);
                    if self.processing_running() {
                        if let Some(revision) = self
                            .frame_timing
                            .as_ref()
                            .and_then(|t| t.request_cohort_window())
                        {
                            self.push_audio_msg(AudioThreadMessage::CohortWindow { revision });
                        }
                    }
                }
                self.send_response(Response::LiveOutput(Box::new(
                    crate::audio_engine::live_output::Status {
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
                    },
                )));
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
                    crate::audio_engine::live_modes::Request::BindProfile { .. }
                        | crate::audio_engine::live_modes::Request::Recover { .. }
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
                    crate::audio_engine::live_modes::Request::Snapshot => Ok(()),
                    crate::audio_engine::live_modes::Request::Arm { .. } => {
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
                    crate::audio_engine::live_modes::Request::Disarm { .. } => {
                        self.live_modes.armed = false;
                        Ok(())
                    }
                    crate::audio_engine::live_modes::Request::SingingOn { .. } => {
                        self.select_live_mode(crate::audio_engine::live_modes::Mode::Singing)
                    }
                    crate::audio_engine::live_modes::Request::TalkOn { .. } => {
                        self.select_live_mode(crate::audio_engine::live_modes::Mode::Talk)
                    }
                    crate::audio_engine::live_modes::Request::Save { .. }
                    | crate::audio_engine::live_modes::Request::BindProfile { .. }
                    | crate::audio_engine::live_modes::Request::Recover { .. } => {
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
                input_source,
                host,
                input,
                output,
                input_id,
                output_id,
                buffer_size,
                sample_rate,
                initial_controls,
                channel_routing,
            } => {
                if let Some(controls) = initial_controls {
                    if let Err(error) = self.prepare_initial_controls(controls) {
                        self.send_error(error.to_string());
                        return;
                    }
                }
                let channel_routing =
                    channel_routing.or_else(|| initial_controls.map(|controls| controls.routing()));
                self.prepare_start_routing(channel_routing);
                let mut bound = crate::audio_engine::live_modes::StartSpec {
                    host: host.clone(),
                    input: input.clone(),
                    output: output.clone(),
                    input_id: input_id.clone(),
                    output_id: output_id.clone(),
                    rate: sample_rate,
                    buffer: buffer_size,
                };
                match self.start_audio_impl(
                    AudioStartRequest {
                        host_name: Some(host),
                        input_name: input,
                        output_name: output,
                        sample_rate,
                        buffer_size,
                        device_ids: (input_id, output_id),
                        input_source,
                    },
                    lifecycle::StartupPolicy::default(),
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
                            routing: Some(crate::ipc::ChannelRouting {
                                input_channels: Some([self.input_channel_l, self.input_channel_r]),
                                output_routing: self.output_routing,
                            }),
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
            Command::LoadPlugin { path, class_id } => {
                self.last_processing_preparation = "load_plugin";
                // Delegated to PluginManager
                let (sample_rate, capacity, channels) = self.processor_setup();
                match self.plugin_manager.load_plugin(
                    &path,
                    sample_rate,
                    capacity,
                    channels,
                    self.processing_running(),
                    class_id.as_deref(),
                ) {
                    Ok((id, name, index, processor_opt)) => {
                        // If Audio Thread is active and manager returned a processor, push it
                        if let Some(proc) = processor_opt {
                            let initial_gain = *self.plugin_manager.gains.get(&id).unwrap_or(&1.0);
                            self.queue_add_processor(
                                index,
                                proc,
                                initial_gain,
                                self.plugin_manager.bypassed.contains(&id),
                                self.plugin_manager.muted.contains(&id),
                            );

                            if self.plugin_manager.bypassed.contains(&id) {
                                self.queue_audio_msg(AudioThreadMessage::SetBypass {
                                    index,
                                    active: true,
                                    latency: self.plugin_manager.latency_samples_at(index),
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
                        self.acknowledge_processing_preparation();
                        let opened = self.plugin_manager.plugins.get(&id);
                        self.send_response(Response::PluginLoaded {
                            id,
                            name,
                            vendor: "".to_string(),
                            class_id: opened.map(|instance| instance.class_id.clone()),
                            legacy_class_ambiguous: opened
                                .is_some_and(|instance| instance.legacy_class_ambiguous),
                            channel_layout: opened
                                .map(|instance| {
                                    crate::ipc::ChannelLayout::from_bus(
                                        instance.bus_layout.inputs,
                                        instance.bus_layout.outputs,
                                    )
                                })
                                .unwrap_or_default(),
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
                match crate::audio_engine::restoration::StagedRestore::load(
                    request,
                    operation_id,
                    expires_at_ms,
                )
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

                if self.processing_running() {
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
                self.queue_audio_msg(AudioThreadMessage::SetBypass {
                    index,
                    active,
                    latency: self.plugin_manager.latency_samples_at(index),
                });
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
            Command::ResumePlugin { id } => {
                let Some(index) = self.plugin_manager.rt_index_of(&id) else {
                    self.send_error("Plugin not found".into());
                    return;
                };
                if self.processing_running() {
                    self.queue_audio_msg(AudioThreadMessage::ResumePlugin { index });
                } else {
                    // 停止中は RT の判定が無い。公開済みの値も token 0 にして採用しない。
                    self.plugin_manager
                        .health_shared()
                        .publish(index as usize, false, 0, 0);
                    self.plugin_manager.clear_health_token(index);
                }
                self.send_response(Response::Success);
            }
            Command::SetGlobalMute { active } => {
                if active {
                    self.round_trip.preempt("muted");
                }
                self.set_global_mute_intent(active);
                self.send_response(Response::Success);
            }
            Command::SetGlobalBypass { active } => {
                self.global_bypass = active;
                self.queue_audio_msg(AudioThreadMessage::SetGlobalBypass(active));
                self.send_response(Response::Success);
            }
            Command::SetInputGain { value } => {
                self.builtin.invalidate_history_with_reason(
                    crate::audio_engine::history::Reason::InputChanged,
                );
                self.voice_input_gain = value;
                self.scan_control.set_gain(value);
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
                        self.invalidate_noise_history(
                            crate::audio_engine::history::Reason::SettingsChanged,
                        );
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
                if self.processing_running() {
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
                        self.invalidate_noise_history(
                            crate::audio_engine::history::Reason::SettingsChanged,
                        );
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
                if !self.processing_running() {
                    self.send_response(Response::Error(
                        "音声を開始してから測定してください".into(),
                    ));
                } else {
                    self.round_trip.set_loudness(id.is_some());
                    if id.is_some() {
                        self.round_trip.preempt("stopped");
                    }
                    self.queue_audio_msg(AudioThreadMessage::SetLoudnessMeasurement(id));
                    self.send_response(Response::Success);
                }
            }
            Command::SetOutputGain { value } => match self.request_output_gain(value) {
                Ok(()) => self.send_response(Response::Success),
                Err(e) => self.send_error(e.to_string()),
            },
            Command::SetInputChannels { left, right } => {
                let Some([left, right]) = requested_channels(
                    self.current_host_is_asio,
                    self.processing_running(),
                    [left, right],
                    self.current_input_channels,
                ) else {
                    self.send_error("入力チャンネルが範囲外です".into());
                    return;
                };
                if self.processing_running()
                    && self.validate_output_for_input([left, right]).is_err()
                {
                    self.send_error("選択した入力に対応する出力がありません".into());
                    return;
                }
                self.builtin.invalidate_history_with_reason(
                    crate::audio_engine::history::Reason::InputChanged,
                );
                self.round_trip.preempt("input_changed");
                self.input_channel_l = left;
                self.input_channel_r = right;
                self.queue_audio_msg(AudioThreadMessage::SetInputChannels(left, right));
                self.send_response(Response::Success);
            }
            Command::SetChannelScan { active } => {
                self.set_channel_scan(active);
                self.send_response(Response::Success);
            }
            Command::StartVoiceCheckRecording { max_ms } => {
                if !self.processing_running() || self.stream_failed.load(Ordering::Acquire) {
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
                self.invalidate_noise_history(crate::audio_engine::history::Reason::NewMeasurement);
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
                let max_ms =
                    max_ms.clamp(500, crate::audio_engine::voice_check::VOICE_CHECK_MAX_MS);
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
                self.round_trip.preempt("stopped");
                self.queue_audio_msg(AudioThreadMessage::StartVoiceCheckRecording {
                    buffers,
                    max_frames,
                });
                self.send_response(Response::Success);
            }
            Command::StopVoiceCheckRecording => {
                if self.processing_running() {
                    self.queue_audio_msg(AudioThreadMessage::StopVoiceCheckRecording);
                }
                self.send_response(Response::Success);
            }
            Command::PlayVoiceCheck {
                source,
                loop_playback,
            } => {
                if !self.processing_running() || self.stream_failed.load(Ordering::Acquire) {
                    self.send_error("音声エンジンを開始してから再生してください".into());
                    return;
                }
                let parsed = parse_voice_check_source(&source);
                self.voice_check
                    .loop_playback
                    .store(loop_playback, Ordering::Relaxed);
                self.round_trip.preempt("stopped");
                self.queue_audio_msg(AudioThreadMessage::PlayVoiceCheck {
                    source: parsed,
                    loop_playback,
                });
                self.send_response(Response::Success);
            }
            Command::StopVoiceCheckPlayback => {
                if self.processing_running() {
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
                if let Err(error) = self.sync_mixing_latency() {
                    self.send_error(error.to_string());
                    return;
                }
                let (active_plugin_count, pending_unload_count, burned_library_count) =
                    self.plugin_manager.runtime_stats();
                let enabled_plugin_count =
                    self.plugin_manager.enabled_plugin_count(self.global_bypass);
                let latency_report = self.plugin_manager.latency_report(self.global_bypass);
                let total_plugin_latency_samples = latency_report.0;
                let noise_reduction_latency_samples = if self.noise_reduction_enabled && !music {
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
                    process_input: self.process_shared.as_ref().map(|s| Box::new(s.snapshot())),
                    preparation: Some(Box::new(self.preparation_snapshot())),
                    active_plugin_count,
                    enabled_plugin_count,
                    pending_unload_count,
                    burned_library_count,
                    global_bypass: self.global_bypass,
                    plugin_health: self.plugin_manager.plugin_health_entries(),
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
                    noise_reduction_active: !music && self.noise_reduction_enabled,
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
                    processing_health: Some(Box::new(self.processing_watch.snapshot())),
                });
            }
            Command::CaptureBundleState | Command::CaptureMixingBundleState => {
                match self.capture_bundle_state() {
                    Ok(snapshot) => self.send_response(Response::BundleState(Box::new(snapshot))),
                    Err(error) => self.send_error(error.to_string()),
                }
            }
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
                self.last_processing_preparation = "set_state";
                if self.processing_running() {
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
                if !self.processing_running() {
                    self.send_error("オーディオエンジンが起動していません".to_string());
                    return;
                }
                if self.round_trip.is_active() {
                    self.send_error("往復遅延の測定中はテスト音を再生できません".into());
                    return;
                }
                self.round_trip.note_test_tone(duration_ms);
                self.queue_audio_msg(AudioThreadMessage::StopVoiceCheckPlayback);
                self.queue_audio_msg(AudioThreadMessage::PlayTestTone {
                    freq_hz,
                    duration_ms,
                    level_db,
                });
                self.send_response(Response::Success);
            }
            Command::StopTestTone => {
                self.round_trip.clear_test_tone();
                self.queue_audio_msg(AudioThreadMessage::StopTestTone);
                self.send_response(Response::Success);
            }
            Command::MeasureRoundTrip { level_db } => {
                match self
                    .round_trip
                    .start(self.round_trip_context(level_db.unwrap_or(0.0)))
                {
                    Ok(()) => {
                        self.round_trip
                            .poll(self.stream_failed.load(Ordering::Acquire));
                        self.send_response(Response::RoundTrip(self.round_trip.snapshot()));
                    }
                    Err(reason) => self.send_error(reason.into()),
                }
            }
            Command::CancelMeasurement => {
                self.round_trip.cancel();
                self.round_trip
                    .poll(self.stream_failed.load(Ordering::Acquire));
                self.send_response(Response::RoundTrip(self.round_trip.snapshot()));
            }
            Command::GetRoundTripMeasurement => {
                self.round_trip
                    .poll(self.stream_failed.load(Ordering::Acquire));
                self.send_response(Response::RoundTrip(self.round_trip.snapshot()));
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
        // 既知の処理待ちは、画面の統計pollに依存せず構成変更時にも更新する。
        if latency_may_change && self.sync_mixing_latency().is_err() {
            if let Some(shared) = &self.mixing_shared {
                shared.failed.store(true, Ordering::Release);
            }
        }
    }

    fn round_trip_context(
        &self,
        level_db: f32,
    ) -> crate::audio_engine::latency_measure::StartContext {
        let output = self.device_manager.active_output.as_ref();
        let input = self.device_manager.active_input.as_ref();
        let voice = self.voice_check.state.load(Ordering::Acquire);
        let sample_rate = self.current_sample_rate.round() as u32;
        let device = |info: Option<&crate::ipc::DeviceInfo>| {
            crate::audio_engine::latency_measure::device_identity(
                info.and_then(|item| item.id.as_deref()),
                info.map(|item| item.name.as_str()),
            )
        };
        crate::audio_engine::latency_measure::StartContext {
            running: self.processing_running()
                && self.output_stream.is_some()
                && matches!(self.input_stream, Some(input::InputStream::Device(_))),
            muted: self.global_mute,
            stream_failed: self.stream_failed.load(Ordering::Acquire),
            split: self.post_role
                || self.live_output_config.split_processing
                || self.split_monitor.is_some(),
            process_input: self.process_shared.is_some()
                || matches!(self.input_stream, Some(input::InputStream::Process(_))),
            rates_match: self.current_input_rate != 0 && self.current_input_rate == sample_rate,
            test_tone: self.round_trip.test_tone_active(),
            voice_playback: voice == crate::audio_engine::voice_check::VC_STATE_PLAYING,
            recording: voice == VC_STATE_RECORDING,
            loudness: self.round_trip.loudness_active(),
            auto_gain: self.gain_shared.requested.load(Ordering::Acquire) != 0
                || self.gain_shared.active.load(Ordering::Acquire) != 0,
            sample_rate,
            buffer_size: self.fixed_buffer_request_frames.unwrap_or(0),
            input_channels: self.current_input_channels,
            selected: [self.input_channel_l, self.input_channel_r],
            output_device_id: device(output),
            input_device_id: device(input),
            engine_epoch: self
                .queue_snapshot()
                .map(|snapshot| snapshot.epoch)
                .unwrap_or_else(|| "none".to_string()),
            level_db,
        }
    }
}
