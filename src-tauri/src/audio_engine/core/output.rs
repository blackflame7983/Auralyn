//! 出力callbackの処理。開始・入力callbackの所有と分ける。
use super::lifecycle::CallbackOwner;
use super::meter::MeterBlock;
use super::startup::{
    apply_commands, flush_pending_retire, measure_output_loudness, route_and_meter_input,
    write_device_silence, write_faded_output_frame, CommandContext, PluginBlock, PluginControls,
};
use super::*;

pub(super) struct OutputCallbackContext<'a> {
    pub(super) info: Option<&'a cpal::OutputCallbackInfo>,
    pub(super) stop_fade: Option<&'a mut super::super::stop_fade::StopFadeRt>,
}

// 出力callbackが所有する状態。構築時に確保し、処理時は借用だけを行う。
pub(super) struct OutputCallback {
    pub(super) dsp_silence: Arc<crate::audio_engine::mode_silence::Shared>,
    pub(super) measure_bridge: Arc<crate::audio_engine::latency_measure::Bridge>,
    pub(super) broadcast_mixer:
        Option<CallbackOwner<crate::audio_engine::mixing::runtime::Broadcast>>,
    pub(super) broadcast_frames: Option<crate::audio_engine::split_monitor::BroadcastRx>,
    pub(super) audio_cons: <Arc<HeapRb<f32>> as Split>::Cons,
    pub(super) queue_input_channels: usize,
    pub(super) rt_peak: crate::audio_engine::peak_protection::Rt,
    pub(super) peak_shared: Arc<crate::audio_engine::peak_protection::Shared>,
    pub(super) live_sender: Option<CallbackOwner<crate::audio_engine::live_output::Sender>>,
    pub(super) worker_generation_controls:
        Option<Arc<crate::audio_engine::split_monitor::Controls>>,
    pub(super) worker_generation: u64,
    pub(super) upstream_consumed: u64,
    pub(super) output_timing: Option<crate::audio_engine::frame_timing::OutputRecorder>,
    pub(super) callback_processors: CallbackOwner<CallbackProcessors>,
    pub(super) output_nr_failed: Arc<AtomicBool>,
    pub(super) output_resampling_failed: Arc<AtomicBool>,
    pub(super) output_stream_failed: Arc<AtomicBool>,
    pub(super) output_capacity_failed: Arc<AtomicBool>,
    pub(super) channels_len: usize,
    pub(super) max_frames_per_callback: usize,
    pub(super) broadcast_block: Vec<crate::audio_engine::split_monitor::BroadcastFrame>,
    pub(super) upstream_recovery: Vec<f32>,
    pub(super) initial_live_ack: bool,
    pub(super) live_shared: Arc<crate::audio_engine::live_modes::Shared>,
    pub(super) initial_live_revision: u64,
    pub(super) retire_prod: <HeapRb<DisposedProcessor> as Split>::Prod,
    pub(super) mmcss_set_out: Arc<AtomicBool>,
    pub(super) frames_counter: Arc<AtomicU64>,
    pub(super) consumer: <HeapRb<AudioThreadMessage> as Split>::Cons,
    pub(super) rt_active_count: usize,
    pub(super) plugin_controls: PluginControls,
    pub(super) rt_cohort_change_applied: bool,
    pub(super) rt_voice: crate::audio_engine::live_modes::RtVoice,
    pub(super) rt_global_mute: bool,
    pub(super) rt_comparison: crate::audio_engine::comparison::Transition,
    pub(super) rt_input_gain: f32,
    pub(super) rt_input_l: usize,
    pub(super) rt_input_r: usize,
    pub(super) rt_physical_input: [usize; 2],
    pub(super) separated: bool,
    pub(super) rt_noise_control: Option<RtNoiseControl>,
    pub(super) rt_noise_learning: RtNoiseLearning,
    pub(super) noise_applied_revision: Arc<AtomicU64>,
    pub(super) builtin_applied: Arc<AtomicU64>,
    pub(super) rt_loudness: LoudnessMeter,
    pub(super) loudness_start: crate::audio_engine::queue_recovery::MeasurementGate,
    pub(super) queue_recovery: crate::audio_engine::queue_recovery::Recovery,
    pub(super) measurement_processed: u64,
    pub(super) rt_output_gain: Smoother,
    pub(super) rt_capture: auto_gain::RtCapture,
    pub(super) rt_voice_check: RtVoiceCheck,
    pub(super) rt_test_tone: RtTestTone,
    pub(super) measure_dry: Vec<f32>,
    pub(super) output_queue_diagnostics: Arc<QueueDiagnostics>,
    pub(super) is_process: bool,
    pub(super) process_renderer:
        Option<CallbackOwner<crate::audio_engine::process_capture::clock::Renderer>>,
    pub(super) process_output_shared: Option<Arc<crate::audio_engine::process_capture::Shared>>,
    pub(super) process_starved_at: Option<u64>,
    pub(super) input_buf: Vec<f32>,
    pub(super) planar_buf_a: Vec<Vec<f32>>,
    pub(super) planar_buf_b: Vec<Vec<f32>>,
    pub(super) planar_buf_dry: Vec<Vec<f32>>,
    pub(super) music_input: bool,
    pub(super) post_mix_controls: Option<Arc<crate::audio_engine::mixing::controls::Shared>>,
    pub(super) post_renderer: Option<CallbackOwner<crate::audio_engine::post_mix::ClientRenderer>>,
    pub(super) post_epoch: u64,
    pub(super) post_previous: Option<(u64, u64, u64)>,
    pub(super) level_prod: <HeapRb<MeterBlock> as Split>::Prod,
    pub(super) rt_output_routing: crate::ipc::OutputRouting,
    pub(super) is_asio: bool,
    pub(super) monitor_trim: crate::audio_engine::gain_ramp::GainRamp,
    pub(super) monitor_levels: Arc<AtomicU64>,
    pub(super) loudness_prod: <HeapRb<LoudnessReading> as Split>::Prod,
    pub(super) callback_diagnostics: Arc<CallbackDiagnostics>,
}

impl OutputCallback {
    pub(super) fn process(&mut self, data: &mut [f32], output_context: OutputCallbackContext<'_>) {
        let OutputCallbackContext {
            info,
            mut stop_fade,
        } = output_context;
        if self.dsp_silence.drain_worker() {
            self.measure_bridge.abandon_stopped();
            if let Some(mixer) = &mut self.broadcast_mixer {
                mixer.get_mut().reset();
            }
            if let Some(queue) = &mut self.broadcast_frames {
                queue.skip(queue.occupied_len());
            } else {
                self.audio_cons.skip(
                    self.audio_cons.occupied_len() / self.queue_input_channels
                        * self.queue_input_channels,
                );
            }
            self.dsp_silence.worker_drained();
            data.fill(0.0);
            return;
        }
        self.rt_peak.sync(&self.peak_shared);
        if let Some(sender) = &mut self.live_sender {
            sender.get_mut().begin_block();
        }
        if let Some(controls) = &self.worker_generation_controls {
            let generation = controls.generation.load(Ordering::Acquire);
            if generation != self.worker_generation {
                if let Some(mixer) = &mut self.broadcast_mixer {
                    mixer.get_mut().reset();
                }
                let skipped = self.broadcast_frames.as_mut().map_or_else(
                    || self.audio_cons.skip(self.audio_cons.occupied_len() / 2 * 2) / 2,
                    |queue| queue.skip(queue.occupied_len()),
                );
                self.upstream_consumed = self.upstream_consumed.saturating_add(skipped as u64);
                self.worker_generation = generation;
                self.measure_bridge.abandon_stopped();
                data.fill(0.0);
                return;
            }
        }
        let timing_begin = self
            .output_timing
            .as_ref()
            .map_or(0, |timing| timing.now_ns());
        let CallbackProcessors {
            processors: rt_processors,
            reverb: rt_reverb,
            pending_retire,
            pending_rejected,
        } = self.callback_processors.get_mut();
        if self.output_nr_failed.load(Ordering::Acquire)
            || self.output_resampling_failed.load(Ordering::Acquire)
            || self.output_stream_failed.load(Ordering::Acquire)
        {
            self.measure_bridge.abandon_stopped();
            write_device_silence(data);
            return;
        }
        let Some(actual_frames) = lifecycle::output_block_frames(
            data,
            self.channels_len,
            self.max_frames_per_callback,
            &self.output_stream_failed,
            &self.output_capacity_failed,
        ) else {
            self.measure_bridge.abandon_stopped();
            return;
        };
        let measurement_ticket = self
            .worker_generation_controls
            .as_ref()
            .map(|c| c.measurement_ticket());
        let upstream_first_frame = self.upstream_consumed;
        if let Some(queue) = &mut self.broadcast_frames {
            for (index, frame) in self.broadcast_block[..actual_frames].iter_mut().enumerate() {
                let Some(value) = queue.try_pop() else {
                    self.output_stream_failed.store(true, Ordering::Release);
                    self.measure_bridge.abandon_stopped();
                    write_device_silence(data);
                    return;
                };
                *frame = value;
                self.upstream_recovery[index] = value.recovery_gain;
            }
            self.upstream_consumed = self.upstream_consumed.saturating_add(actual_frames as u64);
        }
        // Monitorのunity ACKと、このblock自体の回復係数が揃うまで開始要求をFIFOに残す。
        // 既に転送済みのfade blockを録音・測定の先頭として扱わない。
        let measurement_ready = self
            .worker_generation_controls
            .as_ref()
            .zip(measurement_ticket)
            .is_none_or(|(c, ticket)| {
                c.measurement_ready_at(ticket, upstream_first_frame)
                    && self.upstream_recovery[..actual_frames]
                        .iter()
                        .all(|gain| *gain == 1.0)
            });
        if !self.initial_live_ack {
            self.live_shared
                .accepted
                .fetch_max(self.initial_live_revision, Ordering::Release);
            self.live_shared
                .completed
                .fetch_max(self.initial_live_revision, Ordering::Release);
            self.initial_live_ack = true;
        }
        flush_pending_retire(pending_retire, &mut self.retire_prod);

        let now = Instant::now();
        if !self.mmcss_set_out.load(Ordering::Relaxed) {
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
            self.mmcss_set_out.store(true, Ordering::Relaxed);
        }

        if let Some(frames) = data.len().checked_div(self.channels_len) {
            let _ = self
                .frames_counter
                .fetch_add(frames as u64, Ordering::Relaxed);
        }

        if !apply_commands(CommandContext {
            consumer: &mut self.consumer,
            retire_prod: &mut self.retire_prod,
            pending_rejected,
            pending_retire,
            rt_processors,
            rt_active_count: &mut self.rt_active_count,
            controls: &mut self.plugin_controls,
            rt_cohort_change_applied: &mut self.rt_cohort_change_applied,
            output_timing: &mut self.output_timing,
            worker_generation_controls: self.worker_generation_controls.as_deref(),
            measurement_ready,
            upstream_first_frame,
            rt_voice: &mut self.rt_voice,
            rt_reverb,
            live_shared: &self.live_shared,
            rt_global_mute: &mut self.rt_global_mute,
            rt_comparison: &mut self.rt_comparison,
            rt_input_gain: &mut self.rt_input_gain,
            rt_input_l: &mut self.rt_input_l,
            rt_input_r: &mut self.rt_input_r,
            rt_physical_input: &mut self.rt_physical_input,
            separated: self.separated,
            rt_noise_control: &mut self.rt_noise_control,
            rt_noise_learning: &mut self.rt_noise_learning,
            output_nr_failed: &self.output_nr_failed,
            noise_applied_revision: &self.noise_applied_revision,
            builtin_applied: &self.builtin_applied,
            rt_loudness: &mut self.rt_loudness,
            loudness_start: &mut self.loudness_start,
            queue_recovery: &self.queue_recovery,
            measurement_processed: &mut self.measurement_processed,
            rt_output_gain: &mut self.rt_output_gain,
            rt_capture: &mut self.rt_capture,
            rt_voice_check: &mut self.rt_voice_check,
            rt_test_tone: &mut self.rt_test_tone,
        }) {
            self.measure_bridge.abandon_stopped();
            write_device_silence(data);
            return;
        }

        let channels = self.channels_len;
        let frames = actual_frames;
        // 先頭サンプルを出すブロックの開始側で、入力が書き終えたフレーム数を一度読む。
        let measure_hold = self.measure_bridge.blocks_downstream();
        let measure_action = if frames <= self.measure_dry.len() {
            self.measure_bridge
                .render(frames, self.rt_global_mute, &mut self.measure_dry)
        } else {
            self.measure_bridge.abandon_stopped();
            super::super::latency_measure::OutputAction::Passthrough
        };

        // --- 1. Efficient Input Data Fetch & De-interleaving ---
        // 測定・別再生中は通常マイクの回復を開始しない。
        if let Some(id) = self.loudness_start.take_ready(&self.queue_recovery) {
            self.rt_loudness.reset(Some(id));
        }
        let recovery_blocked = self.rt_global_mute
            || measure_hold
            || self.rt_test_tone.is_active()
            || self.rt_voice_check.is_playback_active()
            || self.rt_voice_check.is_recording_active()
            || self.rt_capture.is_active()
            || self.rt_loudness.id.is_some()
            || self.loudness_start.blocks_recovery();
        let skip_frames = self.queue_recovery.begin_block(
            self.audio_cons.occupied_len() / self.queue_input_channels,
            frames,
            self.output_queue_diagnostics.max_burst(),
            recovery_blocked || self.separated || self.is_process,
        );
        if skip_frames > 0 {
            if let Some(timing) = &self.output_timing {
                timing.invalidate_recovery();
            }
            // f32のskipはindex更新。完全frameだけをconsumerが回収する。
            let skipped = self
                .audio_cons
                .skip(skip_frames * self.queue_input_channels)
                / self.queue_input_channels;
            self.output_queue_diagnostics.record_recovery(
                skipped,
                self.queue_recovery.status(),
                self.queue_recovery.target(),
                self.queue_recovery.high(),
            );
        } else {
            self.output_queue_diagnostics.record_recovery(
                0,
                self.queue_recovery.status(),
                self.queue_recovery.target(),
                self.queue_recovery.high(),
            );
        }
        let to_read = frames * self.queue_input_channels;
        let mut reprime_wait = false;
        let (consumed_frames, timing_read) = if self.broadcast_frames.is_some() {
            for (output, frame) in self.input_buf[..to_read]
                .as_chunks_mut::<2>()
                .0
                .iter_mut()
                .zip(&self.broadcast_block[..frames])
            {
                *output = frame.voice;
            }
            (frames, 0)
        } else if let Some(renderer) = &mut self.process_renderer {
            use crate::audio_engine::process_capture::clock::{
                underrun_action, Interleaved, UnderrunAction,
            };
            let renderer = renderer.get_mut();
            let before = renderer.rendered;
            let waiting_before = renderer.waiting;
            renderer.render(
                &mut self.input_buf[..to_read],
                &mut Interleaved(&mut self.audio_cons),
            );
            if renderer.failed {
                let shared = self
                    .process_output_shared
                    .as_ref()
                    .expect("プロセス取得の共有状態");
                if !renderer.failed_underrun {
                    shared.failed.store(true, Ordering::Release);
                } else {
                    let began = self.process_starved_at.get_or_insert(shared.elapsed_ms());
                    match underrun_action(shared.packet_age_ms(), || {
                        shared.elapsed_ms().saturating_sub(*began)
                    }) {
                        UnderrunAction::DiscardAndReprime => {
                            let discarded = self.audio_cons.occupied_len() / 2;
                            self.audio_cons.skip(discarded * 2);
                            shared.paused(discarded);
                            renderer.wait_for_audio();
                            self.process_starved_at = None;
                        }
                        UnderrunAction::Fail => {
                            shared.failed.store(true, Ordering::Release);
                        }
                        UnderrunAction::Wait => {}
                    }
                }
            }
            if let Some(shared) = &self.process_output_shared {
                renderer.report_resume(shared);
                shared.rendered(renderer, self.audio_cons.occupied_len() / 2);
            }
            // 再primingの待ちは無音を返す正常な状態。このcallbackの不足は警告に入れない。
            reprime_wait = renderer.waiting > waiting_before;
            (renderer.rendered.saturating_sub(before) as usize, 0)
        } else if let Some(timing) = &self.output_timing {
            queue_diagnostics::read_complete_frames_observed(
                &mut self.audio_cons,
                &mut self.input_buf[..to_read],
                self.queue_input_channels,
                || timing.now_ns(),
            )
        } else {
            (
                queue_diagnostics::read_complete_frames(
                    &mut self.audio_cons,
                    &mut self.input_buf[..to_read],
                    self.queue_input_channels,
                ),
                0,
            )
        };
        // 分離時の主入力キューは本人用callbackだけが読む。
        // 配信workerまで加えると読出しと不足を二重計上してしまう。
        if !self.separated {
            if reprime_wait {
                self.output_queue_diagnostics
                    .record_reprime_wait(frames, consumed_frames);
            } else {
                self.output_queue_diagnostics
                    .record_output(frames, consumed_frames);
            }
        }

        let ([in_max_l, in_max_r], record_block_start) = route_and_meter_input(
            frames,
            self.queue_input_channels,
            &self.input_buf,
            self.rt_input_l,
            self.rt_input_r,
            self.rt_input_gain,
            &mut self.planar_buf_a,
            channels,
            &mut self.rt_voice_check,
        );

        // テスト音・往復測定・ボイスチェックの再生中は、マイクの音を後段へ流さない。
        // そのあいだの段の計測は、配信者の声の加工を表さないので送らない。
        let mic_flowing = !(self.rt_test_tone.is_active()
            || measure_hold
            || measure_action == super::super::latency_measure::OutputAction::Replace
            || self.rt_voice_check.is_playback_active());
        let mut stage = MeterBlock::default();
        if self.rt_voice_check.is_playback_active() {
            // 再生中はマイク入力をミュート（処理チェーンは無音で継続）
            for channel in &mut self.planar_buf_a[..channels.min(2)] {
                channel[..frames].fill(0.0);
            }
        }

        if self.rt_test_tone.is_active() || measure_hold {
            // テスト音と往復測定のあいだは、マイクを配信と本人用の後段へ流さない。
            for channel in &mut self.planar_buf_a[..channels.min(2)] {
                channel[..frames].fill(0.0);
            }
        }

        if !self.music_input {
            if channels >= 2 {
                self.rt_noise_learning.analyze_block(
                    &self.planar_buf_a[0][..frames],
                    Some(&self.planar_buf_a[1][..frames]),
                    frames,
                );
            } else if channels == 1 {
                self.rt_noise_learning
                    .analyze_block(&self.planar_buf_a[0][..frames], None, frames);
            }

            if let Some(control) = &mut self.rt_noise_control {
                let profile_available = self
                    .rt_noise_learning
                    .shared
                    .profile_valid
                    .load(Ordering::Acquire);
                control.begin_block(NoiseAnalysis {
                    speech: self
                        .rt_noise_learning
                        .shared
                        .speech_detected
                        .load(Ordering::Relaxed),
                    profile_rms: profile_available.then(|| {
                        self.rt_noise_learning
                            .shared
                            .accepted_rms_ppm
                            .load(Ordering::Relaxed) as f32
                            / 1_000_000.0
                    }),
                    learned_mix: self.rt_noise_learning.shared.applied_mix(),
                    has_learned_mix: self
                        .rt_noise_learning
                        .shared
                        .has_applied_mix
                        .load(Ordering::Acquire),
                });
                if channels >= 2 {
                    let (left, right) = self.planar_buf_a.split_at_mut(1);
                    for (left, right) in left[0][..frames].iter_mut().zip(&mut right[0][..frames]) {
                        let output = control.process_sample(*left, *right);
                        *left = output[0];
                        *right = output[1];
                    }
                } else if channels == 1 {
                    for sample in &mut self.planar_buf_a[0][..frames] {
                        *sample = control.process_sample(*sample, *sample)[0];
                    }
                }
                stage.noise = control.take_measurement().filter(|_| mic_flowing);
            }
            stage.speech = mic_flowing.then(|| {
                self.rt_noise_learning
                    .shared
                    .speech_detected
                    .load(Ordering::Relaxed)
            });

            if channels >= 2 {
                let (left, right) = self.planar_buf_a.split_at_mut(1);
                for (left, right) in left[0].iter_mut().zip(right[0].iter_mut()).take(frames) {
                    let output = self.rt_voice.process([*left, *right]);
                    *left = output[0];
                    *right = output[1];
                }
            } else {
                for sample in self.planar_buf_a[0].iter_mut().take(frames) {
                    *sample = self.rt_voice.process([*sample; 2])[0];
                }
            }
            stage.voice_gain = self.rt_voice.take_min_gain().filter(|_| mic_flowing);
            if let Some((revision, builtin_revision)) = self.rt_voice.take_completed() {
                self.live_shared
                    .completed
                    .fetch_max(revision, Ordering::Release);
                self.builtin_applied
                    .fetch_max(builtin_revision, Ordering::Release);
            }

            // 独立残響: voiceのactiveに依存させず、VSTへ渡す前に加算する。
            if self.rt_global_mute {
                rt_reverb.reset();
            } else if channels > 1 {
                let (left, remaining) = self.planar_buf_a.split_at_mut(1);
                for (left, right) in left[0].iter_mut().zip(remaining[0].iter_mut()).take(frames) {
                    let result = rt_reverb.process([*left, *right], false);
                    *left = result[0];
                    *right = result[1];
                }
            } else {
                for sample in self.planar_buf_a[0].iter_mut().take(frames) {
                    *sample = rt_reverb.process([*sample; 2], false)[0];
                }
            }
        }

        self.rt_comparison.begin_block(
            frames,
            self.rt_active_count > 0 && self.plugin_controls.order_len > 0,
        );
        let comparison_settled = self.rt_comparison.settled();
        let current_source_is_a = self.plugin_controls.process(PluginBlock {
            processors: rt_processors,
            planar_buf_a: &mut self.planar_buf_a,
            planar_buf_b: &mut self.planar_buf_b,
            dry: &mut self.planar_buf_dry,
            channels,
            frames,
            active_count: &mut self.rt_active_count,
            global_bypass: self.rt_comparison.bypassed(),
            retire_prod: Some(&mut self.retire_prod),
            pending_retire: Some(pending_retire),
        });

        // --- 3. Result Interleaving & Output Metering ---
        let final_buf = if current_source_is_a {
            &mut self.planar_buf_a
        } else {
            &mut self.planar_buf_b
        };
        self.rt_comparison.apply(final_buf, channels, frames);
        if mic_flowing {
            stage.processed = Some(planar_peak(final_buf, channels, frames));
        }

        if self.rt_capture.is_active() {
            let invalid = self.rt_global_mute
                || self.rt_test_tone.is_active()
                || self.rt_voice_check.is_playback_active()
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
                self.rt_capture.sample(
                    auto_gain::capture_channels(l, r, self.rt_input_l == self.rt_input_r),
                    invalid,
                );
            }
        }
        if self.rt_voice_check.is_recording_active() {
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
                self.rt_voice_check.record_processed_at(
                    record_block_start + i as u64,
                    proc_l,
                    proc_r,
                );
            }
            // 加工前後の最終ブロックが揃ってから公開・完了通知する。
            self.rt_voice_check.advance_recording(frames);
        }
        if let Some(mixer) = &mut self.broadcast_mixer {
            mixer
                .get_mut()
                .process(final_buf, &self.broadcast_block[..frames]);
        }
        if let Some(renderer) = &mut self.post_renderer {
            let music_generation = self
                .post_mix_controls
                .as_ref()
                .and_then(|shared| shared.read())
                .map_or(0, |settings| settings.mute_generation);
            let current = (
                self.dsp_silence.ticket(),
                self.worker_generation,
                music_generation,
            );
            if self.post_previous != Some(current) {
                self.post_epoch = self.post_epoch.wrapping_add(1);
                self.post_previous = Some(current);
            }
            let generation = self.post_epoch;
            if !renderer.get_mut().process(
                final_buf,
                frames,
                self.rt_global_mute,
                generation,
                self.rt_comparison.bypassed(),
            ) {
                self.output_stream_failed.store(true, Ordering::Release);
                self.measure_bridge.abandon_stopped();
                write_device_silence(data);
                return;
            }
        }

        let cohort_normal_mic = comparison_settled
            && !self.rt_global_mute
            && !measure_hold
            && !self.rt_test_tone.is_active()
            && !self.rt_voice_check.is_playback_active();
        if let Some(sender) = &mut self.live_sender {
            sender.get_mut().normal(cohort_normal_mic);
        }
        if self.rt_global_mute
            || measure_hold
            || self.rt_test_tone.is_active()
            || self.rt_voice_check.is_playback_active()
        {
            for _ in 0..frames {
                self.queue_recovery.next_gain();
            }
        }
        // 入力選択とは独立した、実際に存在する出力ペアへ送る。
        let output_pair = if self.separated {
            [0, 1]
        } else {
            super::super::queue_diagnostics::routed_output_pair(
                self.rt_output_routing,
                self.is_asio,
                self.rt_physical_input,
                channels,
            )
        };
        let (input, output) = if self.rt_global_mute {
            // ミュート中もゲインの反映を完了させる。出力は無音のまま。
            for _ in 0..frames {
                self.rt_output_gain.next();
                self.rt_peak.process([0.0; 2]);
            }
            write_device_silence(data);
            // Zero metering too implies output is silence
            ([in_max_l, in_max_r], [0.0, 0.0])
        } else if measure_action == super::super::latency_measure::OutputAction::Replace {
            // テスト音と同じく gain とピーク保護だけを通し、配信へは送らない。
            data.fill(0.0);
            let mut out_max_l = 0.0f32;
            let mut out_max_r = 0.0f32;
            for i in 0..frames {
                let gain = self.rt_output_gain.next();
                let sample = self.measure_dry.get(i).copied().unwrap_or(0.0) * gain;
                let [main_l, main_r] = self.rt_peak.process([sample, sample]);
                let sent = write_faded_output_frame(
                    &mut data[i * channels..(i + 1) * channels],
                    output_pair,
                    [main_l, main_r],
                    stop_fade.as_deref_mut(),
                );
                out_max_l = out_max_l.max(sent[0]);
                out_max_r = out_max_r.max(sent[1]);
            }
            ([0.0, 0.0], [out_max_l, out_max_r])
        } else if self.rt_test_tone.is_active() {
            data.fill(0.0);
            let mut out_max_l = 0.0f32;
            let mut out_max_r = 0.0f32;

            for i in 0..frames {
                let gain = self.rt_output_gain.next();
                let (tone_l, tone_r) = self.rt_test_tone.sample();
                let main_l = tone_l * gain;
                let main_r = tone_r * gain;
                let [main_l, main_r] = self.rt_peak.process([main_l, main_r]);

                let sent = write_faded_output_frame(
                    &mut data[i * channels..(i + 1) * channels],
                    output_pair,
                    [main_l, main_r],
                    stop_fade.as_deref_mut(),
                );
                out_max_l = out_max_l.max(sent[0]);
                out_max_r = out_max_r.max(sent[1]);
            }

            ([0.0, 0.0], [out_max_l, out_max_r])
        } else if self.rt_voice_check.is_playback_active() {
            data.fill(0.0);
            let mut out_max_l = 0.0f32;
            let mut out_max_r = 0.0f32;

            for i in 0..frames {
                let gain = self.rt_output_gain.next();
                let (main_l, main_r) = self.rt_voice_check.read_playback_sample();
                let main_l = main_l * gain;
                let main_r = main_r * gain;
                let [main_l, main_r] = self.rt_peak.process([main_l, main_r]);

                let sent = write_faded_output_frame(
                    &mut data[i * channels..(i + 1) * channels],
                    output_pair,
                    [main_l, main_r],
                    stop_fade.as_deref_mut(),
                );
                out_max_l = out_max_l.max(sent[0]);
                out_max_r = out_max_r.max(sent[1]);
            }

            ([0.0, 0.0], [out_max_l, out_max_r])
        } else {
            // Initialize output with silence
            data.fill(0.0);

            let mut out_max_l = 0.0f32;
            let mut out_max_r = 0.0f32;
            for i in 0..frames {
                let gain = self.rt_output_gain.next();
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
                let recovery_gain = self.queue_recovery.next_gain() * self.upstream_recovery[i];
                let main_l = main_l * recovery_gain;
                let main_r = main_r * recovery_gain;
                let [main_l, main_r] = self.rt_peak.process([main_l, main_r]);

                if let Some(sender) = &mut self.live_sender {
                    sender.get_mut().send([main_l, main_r]);
                }
                let levels = self.monitor_levels.load(Ordering::Relaxed);
                let monitor_gain = if self.separated {
                    1.0
                } else if levels >> 32 != 0 {
                    0.0
                } else {
                    f32::from_bits(levels as u32)
                };
                self.monitor_trim.set_target(monitor_gain);
                let monitor_gain = self.monitor_trim.next();
                let main_l = main_l * monitor_gain;
                let main_r = main_r * monitor_gain;
                // Left
                let sent = write_faded_output_frame(
                    &mut data[i * channels..(i + 1) * channels],
                    output_pair,
                    [main_l, main_r],
                    stop_fade.as_deref_mut(),
                );
                out_max_l = out_max_l.max(sent[0]);
                out_max_r = out_max_r.max(sent[1]);
            }

            ([in_max_l, in_max_r], [out_max_l, out_max_r])
        };
        // 段の計測は読むだけで、出力のサンプルを変えない。満杯なら捨て、待たない。
        let _ = self.level_prod.try_push(MeterBlock {
            input,
            output,
            peak_gain: self.rt_peak.block_gain(),
            ..stage
        });
        self.rt_peak.report(&self.peak_shared, 0);
        measure_output_loudness(
            data,
            channels,
            output_pair,
            &mut self.rt_loudness,
            &mut self.loudness_prod,
        );
        self.rt_capture
            .shared
            .confirmed_gain
            .store(self.rt_output_gain.current().to_bits(), Ordering::Release);
        self.rt_capture.shared.settled.store(
            self.rt_output_gain.current() == self.rt_output_gain.target(),
            Ordering::Release,
        );
        if measurement_ready
            && measurement_ticket
                .is_some_and(|ticket| ticket & !3 == self.measurement_processed & !3)
        {
            if let Some((controls, ticket)) = self
                .worker_generation_controls
                .as_ref()
                .zip(measurement_ticket)
            {
                controls.finish_measurement_block(
                    ticket,
                    self.rt_voice_check.is_recording_active()
                        || self.rt_capture.is_active()
                        || self.rt_loudness.id.is_some()
                        || self.loudness_start.blocks_recovery(),
                );
            }
        }
        self.callback_diagnostics
            .record(actual_frames, now.elapsed().as_micros() as u64);
        if let Some(timing) = &mut self.output_timing {
            timing.record_context(
                consumed_frames,
                frames,
                timing_begin,
                timing_read,
                info.map(|info| info.timestamp().callback),
                cohort_normal_mic
                    && (self.separated || self.monitor_levels.load(Ordering::Acquire) >> 32 == 0),
            );
        }
    }
}

/// 出力音量を掛ける前の加工後のピーク。モノラルは左の値を右にも入れる。
fn planar_peak(buffers: &[Vec<f32>], channels: usize, frames: usize) -> [f32; 2] {
    let peak = |ch: usize| {
        buffers.get(ch).map_or(0.0, |buffer| {
            buffer
                .iter()
                .take(frames)
                .fold(0.0f32, |peak, sample| peak.max(sample.abs()))
        })
    };
    let left = peak(0);
    [left, if channels >= 2 { peak(1) } else { left }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_engine::core::lifecycle::callback_owner;
    use crate::audio_engine::deferred_drop::DeferredDrop;
    use crate::audio_engine::live_modes::{RtVoice, Voice};
    use crate::audio_engine::plugin_health::PluginHealthShared;
    use crate::audio_engine::reverb::Reverb;
    use crate::dsp_verification_allocator::allocation_counts;
    use crate::vst_host::instance::VstProcessor;

    const RATE: u32 = 48_000;
    const FRAMES: usize = 128;

    fn callback(audio_cons: <Arc<HeapRb<f32>> as Split>::Cons) -> OutputCallback {
        let (callback_processors, _returned) = callback_owner(CallbackProcessors {
            reverb: Reverb::new(Default::default(), RATE).unwrap(),
            processors: std::array::from_fn(|_| None::<VstProcessor>),
            pending_retire: std::array::from_fn(|_| None),
            pending_rejected: DeferredDrop::new(),
        });
        let (_, consumer) = HeapRb::<AudioThreadMessage>::new(32).split();
        let (retire_prod, _) = HeapRb::<DisposedProcessor>::new(32).split();
        let (level_prod, _) = HeapRb::<MeterBlock>::new(32).split();
        let (loudness_prod, _) = HeapRb::<LoudnessReading>::new(64).split();
        let (capture_tx, _) = auto_gain::capture_queue();
        let diagnostics = QueueDiagnostics::new_input_queue("t".into(), RATE, RATE, 2, 2, 4096);
        OutputCallback {
            dsp_silence: Arc::default(),
            measure_bridge: Arc::new(crate::audio_engine::latency_measure::Bridge::new()),
            broadcast_mixer: None,
            broadcast_frames: None,
            audio_cons,
            queue_input_channels: 2,
            rt_peak: crate::audio_engine::peak_protection::Rt::new(Default::default(), RATE),
            peak_shared: Arc::default(),
            live_sender: None,
            worker_generation_controls: None,
            worker_generation: 0,
            upstream_consumed: 0,
            output_timing: None,
            callback_processors,
            output_nr_failed: Arc::default(),
            output_resampling_failed: Arc::default(),
            output_stream_failed: Arc::default(),
            output_capacity_failed: Arc::default(),
            channels_len: 2,
            max_frames_per_callback: FRAMES,
            broadcast_block: Vec::new(),
            upstream_recovery: vec![1.0; FRAMES],
            initial_live_ack: false,
            live_shared: Arc::default(),
            initial_live_revision: 1,
            retire_prod,
            mmcss_set_out: Arc::new(AtomicBool::new(true)),
            frames_counter: Arc::default(),
            consumer,
            rt_active_count: 0,
            plugin_controls: PluginControls::new(RATE, Arc::new(PluginHealthShared::new())),
            rt_cohort_change_applied: false,
            rt_voice: RtVoice::new(Voice::prepare(&Default::default(), RATE).unwrap()),
            rt_global_mute: false,
            rt_comparison: crate::audio_engine::comparison::Transition::new(false, RATE),
            rt_input_gain: 1.0,
            rt_input_l: 0,
            rt_input_r: 1,
            rt_physical_input: [0, 1],
            separated: false,
            rt_noise_control: None,
            rt_noise_learning: RtNoiseLearning::new(Arc::new(NoiseLearningShared::new())),
            noise_applied_revision: Arc::default(),
            builtin_applied: Arc::default(),
            rt_loudness: LoudnessMeter::new(RATE),
            loudness_start: Default::default(),
            queue_recovery: crate::audio_engine::queue_recovery::Recovery::new(4096, 48_000, 1, 3),
            measurement_processed: 0,
            rt_output_gain: Smoother::new(1.0),
            rt_capture: auto_gain::RtCapture::new(Arc::default(), capture_tx, RATE),
            rt_voice_check: RtVoiceCheck::new(Arc::default(), RATE),
            rt_test_tone: RtTestTone::new(RATE),
            measure_dry: vec![0.0; FRAMES],
            output_queue_diagnostics: Arc::new(diagnostics),
            is_process: false,
            process_renderer: None,
            process_output_shared: None,
            process_starved_at: None,
            input_buf: vec![0.0; FRAMES * 2],
            planar_buf_a: vec![vec![0.0; FRAMES]; 2],
            planar_buf_b: vec![vec![0.0; FRAMES]; 2],
            planar_buf_dry: vec![vec![0.0; FRAMES]; 2],
            music_input: true,
            post_mix_controls: None,
            post_renderer: None,
            post_epoch: 0,
            post_previous: None,
            level_prod,
            rt_output_routing: Default::default(),
            is_asio: false,
            monitor_trim: crate::audio_engine::gain_ramp::GainRamp::new(1.0, RATE),
            monitor_levels: Arc::new(AtomicU64::new(u64::from(1.0f32.to_bits()))),
            loudness_prod,
            callback_diagnostics: Arc::default(),
        }
    }

    #[test]
    fn input_queue_reaches_the_output_without_allocating() {
        let (mut input, audio_cons) = HeapRb::<f32>::new(4096).split();
        let mut callback = Box::new(callback(audio_cons));
        let expected: Vec<f32> = (0..FRAMES * 2).map(|i| 0.001 * (i % 100) as f32).collect();
        let mut data = vec![0.0f32; FRAMES * 2];
        for block in 0..4 {
            assert_eq!(input.push_slice(&expected), expected.len());
            data.fill(1.0);
            let counts = allocation_counts(|| {
                callback.process(
                    &mut data,
                    OutputCallbackContext {
                        info: None,
                        stop_fade: None,
                    },
                );
            });
            assert_eq!(counts, (0, 0), "block {block}");
            assert!(data.iter().all(|v| v.is_finite()), "block {block}");
            let worst = data
                .iter()
                .zip(&expected)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f32::max);
            assert!(worst < 1e-6, "block {block}: worst error {worst}");
        }
    }
}
