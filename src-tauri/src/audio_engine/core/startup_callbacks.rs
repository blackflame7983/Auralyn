//! 起動時に確保した状態で動作する入力callbackと出力処理段。
use super::super::*;
use crate::audio_engine::plugin_health::{
    self, block_is_invalid, silence_used, HealthLimits, PluginHealthShared, SlotHealth, Verdict,
};

pub(super) struct CallbackBuffers {
    pub(super) input: Vec<f32>,
    pub(super) planar_a: Vec<Vec<f32>>,
    pub(super) planar_b: Vec<Vec<f32>>,
}

impl CallbackBuffers {
    pub(super) fn new(input_channels: usize, output_channels: usize, max_frames: usize) -> Self {
        let max_ch = output_channels.max(2);
        Self {
            input: vec![0.0; max_frames.saturating_mul(input_channels.max(2))],
            planar_a: (0..max_ch).map(|_| vec![0.0; max_frames]).collect(),
            planar_b: (0..max_ch).map(|_| vec![0.0; max_frames]).collect(),
        }
    }
}

pub(in crate::audio_engine::core) struct PluginControls {
    pub(in crate::audio_engine::core) bypassed: [bool; MAX_PLUGINS],
    pub(in crate::audio_engine::core) muted: [bool; MAX_PLUGINS],
    pub(in crate::audio_engine::core) gains: [Smoother; MAX_PLUGINS],
    pub(in crate::audio_engine::core) order: [u8; MAX_PLUGINS],
    pub(in crate::audio_engine::core) order_len: usize,
    pub(in crate::audio_engine::core) health: [SlotHealth; MAX_PLUGINS],
    pub(in crate::audio_engine::core) health_tokens: [u64; MAX_PLUGINS],
    pub(in crate::audio_engine::core) limits: HealthLimits,
    pub(in crate::audio_engine::core) health_shared: Arc<PluginHealthShared>,
}

impl PluginControls {
    // コマンドで更新する設定と、その設定に基づくVST処理を同じ状態にまとめる。
    pub(super) fn process(&mut self, block: PluginBlock<'_>) -> bool {
        let PluginBlock {
            processors,
            planar_buf_a,
            planar_buf_b,
            channels,
            frames,
            active_count,
            global_bypass,
        } = block;
        // --- 2. Ping-Pong Processing Loop ---
        // We toggle between using `planar_buf_a` and `planar_buf_b` as input/output
        // Current Data is always in `current_buffer_index` (0 -> A, 1 -> B)

        let mut current_source_is_a = true; // True usually implies result is in A

        // Global Bypass: Skip all plugin processing (A/B comparison mode)
        // Input remains in planar_buf_a, so current_source_is_a stays true.
        if !global_bypass && active_count > 0 && self.order_len > 0 {
            for position in 0..self.order_len {
                let index = self.order[position];
                let idx = index as usize;
                if idx >= MAX_PLUGINS {
                    continue;
                }

                // Bypass Check
                if self.bypassed[idx] {
                    // Soft Bypass: Explicitly copy input buffer to output buffer
                    // This ensures the processing chain continuity ("Ping-Pong" flow)
                    // and guarantees valid data in the target buffer, resolving "Silence" issues.
                    let (in_bufs, out_bufs) = if current_source_is_a {
                        (&*planar_buf_a, &mut *planar_buf_b)
                    } else {
                        (&*planar_buf_b, &mut *planar_buf_a)
                    };

                    for ch in 0..channels {
                        // Safety bounds check
                        if ch < in_bufs.len()
                            && ch < out_bufs.len()
                            && in_bufs[ch].len() >= frames
                            && out_bufs[ch].len() >= frames
                        {
                            out_bufs[ch][..frames].copy_from_slice(&in_bufs[ch][..frames]);
                        }
                    }

                    // Toggle source to maintain chain state (A -> B or B -> A)
                    current_source_is_a = !current_source_is_a;
                    continue;
                }

                // Mute Check
                if self.muted[idx] {
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

                // 停止中の slot は VST を呼ばない。未加工音へは戻さず、ミュートと同じく無音のまま後段へ渡す。
                if self.health[idx].isolated {
                    let current = if current_source_is_a {
                        &mut *planar_buf_a
                    } else {
                        &mut *planar_buf_b
                    };
                    silence_used(current, channels, frames);
                    continue;
                }

                // Process
                if let Some(proc) = processors[idx].as_mut() {
                    let (in_bufs, out_bufs) = if current_source_is_a {
                        (&*planar_buf_a, &mut *planar_buf_b)
                    } else {
                        (&*planar_buf_b, &mut *planar_buf_a)
                    };

                    // Call new process_planar
                    proc.process_planar(in_bufs, out_bufs, frames);
                    self.note_processed(idx, out_bufs, channels, frames);

                    // Toggle
                    current_source_is_a = !current_source_is_a;

                    // Apply Gain (Smoother)
                    let smoother = &mut self.gains[idx];
                    // Optimization: Check if gain is effectively 1.0 (no change needed)
                    if (smoother.current() - 1.0).abs() > 0.0001
                        || (smoother.target() - 1.0).abs() > 0.0001
                    {
                        let target_buf = if current_source_is_a {
                            &mut *planar_buf_a
                        } else {
                            &mut *planar_buf_b
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

        current_source_is_a
    }

    // ゲインの前に非有限値を消し、停止へ進んだときだけ共有状態へ書く。
    pub(in crate::audio_engine::core) fn note_processed(
        &mut self,
        slot: usize,
        outputs: &mut [Vec<f32>],
        channels: usize,
        frames: usize,
    ) {
        if slot >= MAX_PLUGINS {
            return;
        }
        let invalid = block_is_invalid(outputs, channels, frames);
        if invalid {
            silence_used(outputs, channels, frames);
        }
        let verdict = self.health[slot].observe(invalid, frames, &self.limits);
        if verdict == Verdict::Isolated {
            self.publish_slot(slot);
        }
    }

    #[cfg(test)]
    pub(in crate::audio_engine::core) fn install_slot(&mut self, index: u8, token: u64) {
        plugin_health::install_slot(
            &mut self.health,
            &mut self.health_tokens,
            &self.health_shared,
            index,
            token,
        );
    }

    #[cfg(test)]
    pub(in crate::audio_engine::core) fn clear_slot(&mut self, index: u8) {
        plugin_health::clear_slot(
            &mut self.health,
            &mut self.health_tokens,
            &self.health_shared,
            index,
        );
    }

    pub(in crate::audio_engine::core) fn resume_slot(&mut self, index: u8) {
        plugin_health::resume_slot(
            &mut self.health,
            &self.health_tokens,
            &self.health_shared,
            index,
        );
    }

    fn publish_slot(&self, slot: usize) {
        let Some(health) = self.health.get(slot) else {
            return;
        };
        let token = self.health_tokens.get(slot).copied().unwrap_or(0);
        self.health_shared
            .publish(slot, health.isolated, health.total_invalid_blocks, token);
    }
}

pub(super) struct PluginBlock<'a> {
    pub(super) processors: &'a mut [Option<VstProcessor>; MAX_PLUGINS],
    pub(super) planar_buf_a: &'a mut [Vec<f32>],
    pub(super) planar_buf_b: &'a mut [Vec<f32>],
    pub(super) channels: usize,
    pub(super) frames: usize,
    pub(super) active_count: usize,
    pub(super) global_bypass: bool,
}

// 入力callbackが所有する状態。構築時に確保し、処理時は借用だけを行う。
// 実際の出力値から測定し、無効な間は走査しない。RTでの確保は行わない。
pub(super) fn measure_output_loudness(
    data: &[f32],
    channels: usize,
    output_pair: [usize; 2],
    rt_loudness: &mut LoudnessMeter,
    loudness_prod: &mut <HeapRb<LoudnessReading> as Split>::Prod,
) {
    // 最終ゲイン・ミュート・試聴を含め、デバイスへ実際に渡す値で測る。
    // 測定していない間はフィルター・補間・走査を実行しない。
    if rt_loudness.id.is_some() {
        let [output_l, output_r] = output_pair;
        for frame in data.chunks_exact(channels) {
            let l = frame.get(output_l).copied().unwrap_or(0.0);
            // 同じ物理チャンネルをL/Rへ選んだ場合は二重に加算しない。
            let r = if output_r == output_l {
                0.0
            } else {
                frame.get(output_r).copied().unwrap_or(0.0)
            };
            if let Some(reading) = rt_loudness.sample([l, r]) {
                let _ = loudness_prod.try_push(reading);
            }
        }
    }
}

// 選択入力をplanarへ変換し、同じ信号を録音とメーターへ渡す。
#[allow(clippy::too_many_arguments)]
pub(super) fn route_and_meter_input(
    frames: usize,
    queue_input_channels: usize,
    input_buf: &[f32],
    rt_input_l: usize,
    rt_input_r: usize,
    rt_input_gain: f32,
    planar_buf_a: &mut [Vec<f32>],
    channels: usize,
    rt_voice_check: &mut RtVoiceCheck,
) -> ([f32; 2], u64) {
    // De-interleave & Metering
    let mut in_max_l = 0.0;
    let mut in_max_r = 0.0;

    let record_block_start = rt_voice_check.block_record_start();

    for i in 0..frames {
        // 入力の選択値を先に取得してから、出力形状のplanarへ配置する。
        let frame = &input_buf[i * queue_input_channels..(i + 1) * queue_input_channels];
        let [sample_l, sample_r] = queue_diagnostics::route_input_frame(
            frame,
            [rt_input_l, rt_input_r],
            rt_input_gain,
            planar_buf_a,
            i,
            channels,
        );

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
            rt_voice_check.record_raw_at(record_block_start + i as u64, sample_l, sample_r);
        }
    }

    ([in_max_l, in_max_r], record_block_start)
}

// callbackでは退避失敗したprocessorを保持し続け、解放しない。
pub(super) fn flush_pending_retire(
    pending_retire: &mut [Option<DisposedProcessor>; MAX_PLUGINS],
    retire_prod: &mut <HeapRb<DisposedProcessor> as Split>::Prod,
) {
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
}

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

// 受信済みコマンドの適用先はcallback中だけ借用する。所有値は既存の保持先に残す。
pub(super) struct CommandContext<'a> {
    pub(super) consumer: &'a mut <HeapRb<AudioThreadMessage> as Split>::Cons,
    pub(super) retire_prod: &'a mut <HeapRb<DisposedProcessor> as Split>::Prod,
    pub(super) pending_rejected:
        &'a mut crate::audio_engine::deferred_drop::DeferredDrop<DisposedProcessor>,
    pub(super) pending_retire: &'a mut [Option<DisposedProcessor>; MAX_PLUGINS],
    pub(super) rt_processors: &'a mut [Option<VstProcessor>; MAX_PLUGINS],
    pub(super) rt_active_count: &'a mut usize,
    pub(super) rt_gains: &'a mut [Smoother; MAX_PLUGINS],
    pub(super) rt_bypassed: &'a mut [bool; MAX_PLUGINS],
    pub(super) rt_muted: &'a mut [bool; MAX_PLUGINS],
    pub(super) rt_order: &'a mut [u8; MAX_PLUGINS],
    pub(super) rt_order_len: &'a mut usize,
    pub(super) rt_health: &'a mut [SlotHealth; MAX_PLUGINS],
    pub(super) rt_health_tokens: &'a mut [u64; MAX_PLUGINS],
    pub(super) health_shared: &'a PluginHealthShared,
    pub(super) rt_cohort_change_applied: &'a mut bool,
    pub(super) output_timing: &'a mut Option<crate::audio_engine::frame_timing::OutputRecorder>,
    pub(super) worker_generation_controls: Option<&'a crate::audio_engine::split_monitor::Controls>,
    pub(super) measurement_ready: bool,
    pub(super) upstream_first_frame: u64,
    pub(super) rt_voice: &'a mut crate::audio_engine::live_modes::RtVoice,
    pub(super) rt_reverb: &'a mut crate::audio_engine::reverb::Reverb,
    pub(super) live_shared: &'a crate::audio_engine::live_modes::Shared,
    pub(super) rt_global_mute: &'a mut bool,
    pub(super) rt_comparison: &'a mut crate::audio_engine::comparison::Transition,
    pub(super) rt_input_gain: &'a mut f32,
    pub(super) rt_input_l: &'a mut usize,
    pub(super) rt_input_r: &'a mut usize,
    pub(super) rt_physical_input: &'a mut [usize; 2],
    pub(super) separated: bool,
    pub(super) rt_noise_control: &'a mut Option<RtNoiseControl>,
    pub(super) rt_noise_learning: &'a mut RtNoiseLearning,
    pub(super) output_nr_failed: &'a AtomicBool,
    pub(super) noise_applied_revision: &'a AtomicU64,
    pub(super) builtin_applied: &'a AtomicU64,
    pub(super) rt_loudness: &'a mut LoudnessMeter,
    pub(super) loudness_start: &'a mut crate::audio_engine::queue_recovery::MeasurementGate,
    pub(super) queue_recovery: &'a crate::audio_engine::queue_recovery::Recovery,
    pub(super) measurement_processed: &'a mut u64,
    pub(super) rt_output_gain: &'a mut Smoother,
    pub(super) rt_capture: &'a mut auto_gain::RtCapture,
    pub(super) rt_voice_check: &'a mut RtVoiceCheck,
    pub(super) rt_test_tone: &'a mut RtTestTone,
}

pub(super) fn apply_commands(context: CommandContext<'_>) -> bool {
    let CommandContext {
        consumer,
        retire_prod,
        pending_rejected,
        pending_retire,
        rt_processors,
        rt_active_count,
        rt_gains,
        rt_bypassed,
        rt_muted,
        rt_order,
        rt_order_len,
        rt_health,
        rt_health_tokens,
        health_shared,
        rt_cohort_change_applied,
        output_timing,
        worker_generation_controls,
        measurement_ready,
        upstream_first_frame,
        rt_voice,
        rt_reverb,
        live_shared,
        rt_global_mute,
        rt_comparison,
        rt_input_gain,
        rt_input_l,
        rt_input_r,
        rt_physical_input,
        separated,
        rt_noise_control,
        rt_noise_learning,
        output_nr_failed,
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
    } = context;
    // Process Commands
    // 返却待ちの拒否値がある間は次の所有値を受け取らない。
    // キュー満杯でも保持数を固定し、RT側でprocessorをDropしない。
    while measurement_ready && pending_rejected.flush_to(retire_prod) {
        if consumer.try_peek().is_some_and(|msg| {
            matches!(
                msg,
                AudioThreadMessage::StartVoiceCheckRecording { .. }
                    | AudioThreadMessage::StartAutoGainCapture(_)
                    | AudioThreadMessage::SetLoudnessMeasurement(Some(_))
            )
        }) && (!rt_comparison.settled()
            || worker_generation_controls.is_some_and(|c| {
                !c.measurement_ready_at(c.measurement_ticket(), upstream_first_frame)
            }))
        {
            break;
        }
        let Some(msg) = consumer.try_pop() else {
            break;
        };
        if msg.changes_cohort() {
            *rt_cohort_change_applied = match &msg {
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
                | AudioThreadMessage::SetGain { index, .. }
                | AudioThreadMessage::ResumePlugin { index } => (*index as usize) < MAX_PLUGINS,
                _ => true,
            };
        }
        match msg {
            AudioThreadMessage::CohortWindow { revision } => {
                if let Some(timing) = &mut *output_timing {
                    timing.complete_cohort_window(revision, *rt_cohort_change_applied);
                }
            }
            AudioThreadMessage::AddProcessor {
                index,
                processor,
                initial_gain,
                initial_bypassed,
                initial_muted,
                health_token,
            } => {
                let slot = index as usize;
                if slot < MAX_PLUGINS && rt_processors[slot].is_none() {
                    rt_processors[slot] = Some(processor);
                    *rt_active_count += 1;
                    rt_gains[slot] = Smoother::new_ramp(0.0, initial_gain);
                    rt_bypassed[slot] = initial_bypassed;
                    rt_muted[slot] = initial_muted;
                    plugin_health::install_slot(
                        rt_health,
                        rt_health_tokens,
                        health_shared,
                        index,
                        health_token,
                    );
                } else {
                    pending_rejected.defer(DisposedProcessor::Rejected(processor), retire_prod);
                }
            }
            AudioThreadMessage::RemoveProcessor { index } => {
                let slot = index as usize;
                if slot < MAX_PLUGINS {
                    if pending_retire[slot].is_none() {
                        if let Some(proc) = rt_processors[slot].take() {
                            let retired = DisposedProcessor::Retired(RetiredProcessor {
                                index,
                                processor: proc,
                            });
                            if let Err(retired) = retire_prod.try_push(retired) {
                                pending_retire[slot] = Some(retired);
                            };
                            *rt_active_count = rt_active_count.saturating_sub(1);
                        }
                    }
                    rt_muted[slot] = false;
                    rt_bypassed[slot] = false;
                    rt_gains[slot] = Smoother::new(1.0);
                    remove_from_order(rt_order, rt_order_len, index);
                    plugin_health::clear_slot(rt_health, rt_health_tokens, health_shared, index);
                }
            }
            AudioThreadMessage::ReorderProcessors { order, len } => {
                *rt_order = order;
                *rt_order_len = (len as usize).min(MAX_PLUGINS);
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
            AudioThreadMessage::ResumePlugin { index } => {
                plugin_health::resume_slot(rt_health, rt_health_tokens, health_shared, index);
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
                if *rt_global_mute != active {
                    if let Some(control) = &mut *rt_noise_control {
                        control.reset_state();
                    }
                }
                *rt_global_mute = active;
                if active {
                    rt_reverb.reset();
                }
            }
            AudioThreadMessage::SetGlobalBypass(active) => {
                rt_comparison.request(active);
            }
            AudioThreadMessage::SetInputGain(val) => {
                if !separated {
                    *rt_input_gain = val;
                }
            }
            AudioThreadMessage::StartNoiseLearning {
                duration_frames,
                generation,
                window_frames,
            } => {
                rt_noise_learning.start_with_generation(duration_frames, generation, window_frames);
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
                    return false;
                }
                if let Some(control) = &mut *rt_noise_control {
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
                rt_voice.update_normal(active, preset, amount.clamp(0.0, 1.0), singing);
                rt_reverb.update(reverb);
                builtin_applied.store(revision, Ordering::Release);
            }
            AudioThreadMessage::SetLoudnessMeasurement(id) => {
                rt_loudness.reset(loudness_start.request(id, queue_recovery));
            }
            AudioThreadMessage::MeasurementReservation(ticket) => {
                *measurement_processed = ticket;
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
                *rt_physical_input = [l, r];
                if !separated {
                    *rt_input_l = l;
                    *rt_input_r = r;
                }
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

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vst_host::instance::{allocation_counts, ScriptedVst};

    fn controls(rate: u32) -> (PluginControls, Arc<PluginHealthShared>) {
        let shared = Arc::new(PluginHealthShared::new());
        (
            PluginControls {
                bypassed: [false; MAX_PLUGINS],
                muted: [false; MAX_PLUGINS],
                gains: std::array::from_fn(|_| Smoother::new(1.0)),
                order: [u8::MAX; MAX_PLUGINS],
                order_len: 0,
                health: [SlotHealth::default(); MAX_PLUGINS],
                health_tokens: [0; MAX_PLUGINS],
                limits: HealthLimits::new(rate),
                health_shared: shared.clone(),
            },
            shared,
        )
    }

    fn buffers(frames: usize, value: f32) -> (Vec<Vec<f32>>, Vec<Vec<f32>>) {
        (vec![vec![value; frames]; 2], vec![vec![0.0; frames]; 2])
    }

    fn run(
        controls: &mut PluginControls,
        processors: &mut [Option<VstProcessor>; MAX_PLUGINS],
        planar_a: &mut [Vec<f32>],
        planar_b: &mut [Vec<f32>],
        frames: usize,
    ) -> bool {
        controls.process(PluginBlock {
            processors,
            planar_buf_a: planar_a,
            planar_buf_b: planar_b,
            channels: 2,
            frames,
            active_count: 2,
            global_bypass: false,
        })
    }

    fn output<'a>(
        source_a: bool,
        planar_a: &'a [Vec<f32>],
        planar_b: &'a [Vec<f32>],
    ) -> &'a [Vec<f32>] {
        if source_a {
            planar_a
        } else {
            planar_b
        }
    }

    #[test]
    fn invalid_output_never_reaches_the_next_plugin_and_isolation_stays_allocation_free() {
        let mut bad = ScriptedVst::non_finite(f32::NAN, None);
        let mut next = ScriptedVst::scale(0.5);
        let (mut controls, shared) = controls(48_000);
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order_len = 2;
        controls.install_slot(0, 11);
        controls.install_slot(1, 12);
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(bad.take());
        processors[1] = Some(next.take());
        let frames = 256;
        let (mut planar_a, mut planar_b) = buffers(frames, 0.25);
        let mut finite = true;
        let mut silent = true;
        let counts = allocation_counts(|| {
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                frames,
            );
            let produced = output(source_a, &planar_a, &planar_b);
            finite = produced
                .iter()
                .all(|channel| channel.iter().all(|sample| sample.is_finite()));
            silent = produced
                .iter()
                .all(|channel| channel.iter().all(|sample| *sample == 0.0));
            for _ in 0..18 {
                let _ = run(
                    &mut controls,
                    &mut processors,
                    &mut planar_a,
                    &mut planar_b,
                    frames,
                );
            }
        });
        assert_eq!(counts, (0, 0));
        assert!(finite && silent);
        assert!(!next.saw_non_finite());
        assert!(controls.health[0].isolated);
        assert_eq!((bad.calls(), next.calls()), (19, 19));
        assert_eq!(shared.isolated_blocks(0, 11), Some(19));
        assert_eq!(shared.isolated_blocks(0, 12), None);

        let counts = allocation_counts(|| {
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                frames,
            );
            silent = output(source_a, &planar_a, &planar_b)
                .iter()
                .all(|channel| channel.iter().all(|sample| *sample == 0.0));
        });
        assert_eq!(counts, (0, 0));
        assert!(silent);
        assert_eq!((bad.calls(), next.calls()), (19, 20));

        controls.resume_slot(0);
        assert!(!controls.health[0].isolated);
        assert_eq!(shared.isolated_blocks(0, 11), None);
        let _ = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            frames,
        );
        assert_eq!(bad.calls(), 20);
        assert!(!controls.health[0].isolated);

        controls.clear_slot(0);
        controls.install_slot(0, 99);
        let counts = allocation_counts(|| {
            let _ = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                frames,
            );
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(bad.calls(), 21);
        assert!(!controls.health[0].isolated);
        assert_eq!(shared.isolated_blocks(0, 11), None);
        assert_eq!(shared.isolated_blocks(0, 99), None);
        drop(processors);
    }

    #[test]
    fn bypass_and_mute_do_not_judge_or_call_the_plugin() {
        let mut bad = ScriptedVst::non_finite(f32::INFINITY, Some(0));
        let mut next = ScriptedVst::scale(1.0);
        let (mut controls, _) = controls(48_000);
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order_len = 2;
        controls.install_slot(0, 1);
        controls.bypassed[0] = true;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(bad.take());
        processors[1] = Some(next.take());
        let frames = 64;
        let (mut planar_a, mut planar_b) = buffers(frames, 0.4);
        let source_a = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            frames,
        );
        assert_eq!(bad.calls(), 0);
        assert_eq!(next.calls(), 1);
        assert!(!controls.health[0].isolated);
        assert!(output(source_a, &planar_a, &planar_b)
            .iter()
            .all(|channel| channel.iter().all(|sample| *sample == 0.4)));
        controls.bypassed[0] = false;
        controls.muted[0] = true;
        let _ = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            frames,
        );
        assert_eq!(bad.calls(), 0);
        assert!(!controls.health[0].isolated);
        drop(processors);
    }

    #[test]
    fn one_sided_infinity_is_silenced_before_the_next_plugin() {
        let mut bad = ScriptedVst::non_finite(f32::NEG_INFINITY, Some(1));
        let mut next = ScriptedVst::scale(1.0);
        let (mut controls, _) = controls(44_100);
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order_len = 2;
        controls.install_slot(0, 3);
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(bad.take());
        processors[1] = Some(next.take());
        let frames = 128;
        let (mut planar_a, mut planar_b) = buffers(frames, 0.2);
        let counts = allocation_counts(|| {
            let _ = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                frames,
            );
        });
        assert_eq!(counts, (0, 0));
        assert!(!next.saw_non_finite());
        assert_eq!(bad.calls(), 1);
        assert!(!controls.health[0].isolated);
        drop(processors);
    }
}
