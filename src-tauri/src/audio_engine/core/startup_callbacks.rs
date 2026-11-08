//! 起動時に確保した状態で動作する入力callbackと出力処理段。
use super::super::slot_transition::{
    relative_order_changed, route_for, ChainFade, SlotRoute, SlotTransition,
};
use super::super::*;
use crate::audio_engine::plugin_health::{
    self, block_is_invalid, silence_used, HealthLimits, PluginHealthShared, SlotHealth, Verdict,
};

pub(super) struct CallbackBuffers {
    pub(super) input: Vec<f32>,
    pub(super) planar_a: Vec<Vec<f32>>,
    pub(super) planar_b: Vec<Vec<f32>>,
    /// 遷移中の dry。起動時に確保し、callback ではコピーだけ行う。
    pub(super) planar_dry: Vec<Vec<f32>>,
}

impl CallbackBuffers {
    pub(super) fn new(input_channels: usize, output_channels: usize, max_frames: usize) -> Self {
        let max_ch = output_channels.max(2);
        Self {
            input: vec![0.0; max_frames.saturating_mul(input_channels.max(2))],
            planar_a: (0..max_ch).map(|_| vec![0.0; max_frames]).collect(),
            planar_b: (0..max_ch).map(|_| vec![0.0; max_frames]).collect(),
            planar_dry: (0..max_ch).map(|_| vec![0.0; max_frames]).collect(),
        }
    }
}

/// グローバルミュート、ストリーム障害、停止で戻る経路は、遷移中でもデバイス出力を無音にする。
pub(super) fn write_device_silence(data: &mut [f32]) {
    data.fill(0.0);
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
    pub(in crate::audio_engine::core) transitions: [SlotTransition; MAX_PLUGINS],
    pub(in crate::audio_engine::core) chain: ChainFade,
}

impl PluginControls {
    pub(super) fn new(rate: u32, shared: Arc<PluginHealthShared>) -> Self {
        Self {
            bypassed: [false; MAX_PLUGINS],
            muted: [false; MAX_PLUGINS],
            gains: std::array::from_fn(|_| Smoother::new(1.0)),
            order: [u8::MAX; MAX_PLUGINS],
            order_len: 0,
            health: [SlotHealth::default(); MAX_PLUGINS],
            health_tokens: [0; MAX_PLUGINS],
            limits: HealthLimits::new(rate),
            health_shared: shared,
            transitions: std::array::from_fn(|_| SlotTransition::at_rest(rate, 0, false, false)),
            chain: ChainFade::new(rate),
        }
    }

    // コマンドで更新する設定と、その設定に基づくVST処理を同じ状態にまとめる。
    pub(in crate::audio_engine::core) fn process(&mut self, block: PluginBlock<'_>) -> bool {
        let PluginBlock {
            processors,
            planar_buf_a,
            planar_buf_b,
            dry,
            channels,
            frames,
            active_count,
            global_bypass,
            mut retire_prod,
            mut pending_retire,
        } = block;
        // 各 callback は新しい入力を A に置いて始まる。戻り値は結果が入っている側。
        let mut current_source_is_a = true;
        let mut retire_later = [false; MAX_PLUGINS];
        if frames == 0 {
            return true;
        }
        if global_bypass {
            // 全体 bypass 中はプラグインを通らない。順序は無音を挟まず差し替え、
            // 途中だったチェーンフェードは 1 に戻して後から不意に下げない。
            if let Some((order, len)) = self.chain.take_pending_now() {
                self.replace_order(
                    order,
                    len,
                    processors,
                    active_count,
                    retire_prod,
                    pending_retire,
                );
            }
            self.chain.snap_idle();
            return true;
        }
        if let Some((order, len)) = self.chain.begin_block(frames as u32) {
            self.replace_order(
                order,
                len,
                processors,
                active_count,
                retire_prod.as_deref_mut(),
                pending_retire.as_deref_mut(),
            );
        }
        if *active_count > 0 && self.order_len > 0 {
            let positions = self.order_len;
            for position in 0..positions {
                let index = self.order[position];
                let idx = index as usize;
                if idx >= MAX_PLUGINS {
                    continue;
                }
                // 停止中は遷移させず無音のまま後段へ渡す。VST は呼ばない。
                if self.health[idx].isolated {
                    let current = if current_source_is_a {
                        &mut *planar_buf_a
                    } else {
                        &mut *planar_buf_b
                    };
                    silence_used(current, channels, frames);
                    continue;
                }
                if self.transitions[idx].armed {
                    self.transitions[idx].armed = false;
                    let route = route_for(self.bypassed[idx], self.muted[idx]);
                    self.transitions[idx].retarget(route);
                }
                // 削除フェードが前のブロックで終わっている。このブロックでは槽を通さない。
                if self.transitions[idx].ready_to_retire() {
                    retire_later[idx] = true;
                    continue;
                }
                if self.transitions[idx].is_settled_dry() {
                    copy_planar(
                        planar_buf_a,
                        planar_buf_b,
                        current_source_is_a,
                        channels,
                        frames,
                    );
                    current_source_is_a = !current_source_is_a;
                    continue;
                }
                if self.transitions[idx].is_settled_silent() {
                    let current = if current_source_is_a {
                        &mut *planar_buf_a
                    } else {
                        &mut *planar_buf_b
                    };
                    silence_used(current, channels, frames);
                    continue;
                }
                if self.transitions[idx].is_settled_wet() {
                    let ran = if let Some(proc) = processors[idx].as_mut() {
                        let (in_bufs, out_bufs) = if current_source_is_a {
                            (&*planar_buf_a, &mut *planar_buf_b)
                        } else {
                            (&*planar_buf_b, &mut *planar_buf_a)
                        };
                        proc.process_planar(in_bufs, out_bufs, frames);
                        self.note_processed(idx, out_bufs, channels, frames);
                        true
                    } else {
                        false
                    };
                    if ran {
                        current_source_is_a = !current_source_is_a;
                        let smoother = &mut self.gains[idx];
                        if (smoother.current() - 1.0).abs() > 0.0001
                            || (smoother.target() - 1.0).abs() > 0.0001
                        {
                            let target_buf = if current_source_is_a {
                                &mut *planar_buf_a
                            } else {
                                &mut *planar_buf_b
                            };
                            for frame_idx in 0..frames {
                                let gain = smoother.next();
                                for channel in target_buf.iter_mut().take(channels) {
                                    if let Some(sample) = channel.get_mut(frame_idx) {
                                        *sample *= gain;
                                    }
                                }
                            }
                        }
                    }
                    continue;
                }
                let needs_wet = self.transitions[idx].block_needs_wet();
                let needs_dry = self.transitions[idx].block_needs_dry();
                let (in_bufs, out_bufs) = if current_source_is_a {
                    (&*planar_buf_a, &mut *planar_buf_b)
                } else {
                    (&*planar_buf_b, &mut *planar_buf_a)
                };
                if needs_dry {
                    copy_dry(in_bufs, dry, channels, frames);
                }
                let called = if needs_wet {
                    if let Some(proc) = processors[idx].as_mut() {
                        proc.process_planar(in_bufs, out_bufs, frames);
                        true
                    } else {
                        silence_used(out_bufs, channels, frames);
                        false
                    }
                } else {
                    false
                };
                if called {
                    self.note_processed(idx, out_bufs, channels, frames);
                }
                for frame_idx in 0..frames {
                    let (wet, dry_gain) = self.transitions[idx].next_frame();
                    let gain = if wet > 0.0 {
                        self.gains[idx].next()
                    } else {
                        self.gains[idx].current()
                    };
                    for ch in 0..channels {
                        let wet_sample = if called {
                            out_bufs[ch].get(frame_idx).copied().unwrap_or(0.0)
                        } else {
                            0.0
                        };
                        let dry_sample = if dry_gain > 0.0 {
                            dry[ch].get(frame_idx).copied().unwrap_or(0.0)
                        } else {
                            0.0
                        };
                        if let Some(sample) = out_bufs[ch].get_mut(frame_idx) {
                            *sample = wet_sample * gain * wet + dry_sample * dry_gain;
                        }
                    }
                }
                current_source_is_a = !current_source_is_a;
                if self.transitions[idx].ready_to_retire() {
                    retire_later[idx] = true;
                }
            }
        }
        for (slot, retire) in retire_later.iter().enumerate() {
            if *retire {
                self.retire_slot(
                    slot,
                    processors,
                    active_count,
                    retire_prod.as_deref_mut(),
                    pending_retire.as_deref_mut(),
                );
            }
        }
        if !self.chain.idle() {
            let output = if current_source_is_a {
                &mut *planar_buf_a
            } else {
                &mut *planar_buf_b
            };
            for frame_idx in 0..frames {
                let gain = self.chain.next_gain();
                for channel in output.iter_mut().take(channels) {
                    if let Some(sample) = channel.get_mut(frame_idx) {
                        *sample *= gain;
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
        let slot = index as usize;
        if slot >= MAX_PLUGINS {
            return;
        }
        // 停止中は無音だった。復帰は無音から目標の経路へフェードインする。
        self.transitions[slot].resume_from_silence(self.bypassed[slot], self.muted[slot]);
    }

    pub(in crate::audio_engine::core) fn request_bypass(
        &mut self,
        slot: usize,
        active: bool,
        latency: u32,
    ) {
        if slot >= MAX_PLUGINS || self.transitions[slot].retiring {
            return;
        }
        self.bypassed[slot] = active;
        self.transitions[slot].latency = latency;
        if self.health[slot].isolated {
            return;
        }
        self.transitions[slot].retarget(route_for(active, self.muted[slot]));
    }

    pub(in crate::audio_engine::core) fn request_mute(&mut self, slot: usize, active: bool) {
        if slot >= MAX_PLUGINS || self.transitions[slot].retiring {
            return;
        }
        self.muted[slot] = active;
        if self.health[slot].isolated {
            return;
        }
        self.transitions[slot].retarget(route_for(self.bypassed[slot], active));
    }

    pub(in crate::audio_engine::core) fn note_added(
        &mut self,
        slot: usize,
        initial_gain: f32,
        bypassed: bool,
        muted: bool,
        latency: u32,
    ) {
        if slot >= MAX_PLUGINS {
            return;
        }
        self.gains[slot] = Smoother::new(initial_gain);
        self.bypassed[slot] = bypassed;
        self.muted[slot] = muted;
        self.transitions[slot].note_added(latency, bypassed, muted);
    }

    /// 即時に取り除けるとき true。処理中なら dry への遷移を始め、完了ブロックで retire する。
    pub(in crate::audio_engine::core) fn begin_remove(&mut self, slot: usize) -> bool {
        if slot >= MAX_PLUGINS || self.transitions[slot].retiring {
            return false;
        }
        let index = slot as u8;
        let in_order = self.order[..self.order_len].contains(&index);
        // bypass 済みは既に dry なので除去しても波形が変わらない。
        // isolated は無音固定（#448）のまま動かすと悪い VST を呼ぶので、ここでは即時。
        // mute は無音から dry へ戻す段差が出るため、T のフェードを使う。
        if !in_order || self.health[slot].isolated || self.transitions[slot].is_settled_dry() {
            return true;
        }
        self.transitions[slot].retiring = true;
        self.transitions[slot].retarget(SlotRoute::Dry);
        false
    }

    /// 直ちに retire する slot を返す。並べ替えそのものはここで順序へ反映する。
    pub(in crate::audio_engine::core) fn begin_reorder(
        &mut self,
        new_order: [u8; MAX_PLUGINS],
        len: u8,
    ) -> [bool; MAX_PLUGINS] {
        let new_len = (len as usize).min(MAX_PLUGINS);
        let old = self.order;
        let old_len = self.order_len;
        if old_len == new_len && old[..old_len] == new_order[..new_len] {
            self.chain.clear_pending();
            return [false; MAX_PLUGINS];
        }
        let mut drop_now = [false; MAX_PLUGINS];
        for &slot in &old[..old_len] {
            let idx = slot as usize;
            if slot == u8::MAX || idx >= MAX_PLUGINS || new_order[..new_len].contains(&slot) {
                continue;
            }
            if self.health[idx].isolated || self.transitions[idx].is_settled_dry() {
                drop_now[idx] = true;
            } else if !self.transitions[idx].retiring {
                self.transitions[idx].retiring = true;
                self.transitions[idx].retarget(SlotRoute::Dry);
            }
        }
        if relative_order_changed(&old[..old_len], &new_order[..new_len]) {
            self.chain.set_pending(new_order, new_len);
            let mut live = [u8::MAX; MAX_PLUGINS];
            let mut live_len = 0usize;
            for &slot in &old[..old_len] {
                let idx = slot as usize;
                if slot == u8::MAX || idx >= MAX_PLUGINS || drop_now[idx] {
                    continue;
                }
                live[live_len] = slot;
                live_len += 1;
            }
            self.order = live;
            self.order_len = live_len;
        } else {
            self.chain.clear_pending();
            commit_soft_order(self, &old, old_len, &new_order, new_len);
        }
        drop_now
    }

    fn replace_order(
        &mut self,
        order: [u8; MAX_PLUGINS],
        len: usize,
        processors: &mut [Option<VstProcessor>; MAX_PLUGINS],
        active_count: &mut usize,
        mut retire_prod: Option<&mut <HeapRb<DisposedProcessor> as Split>::Prod>,
        mut pending_retire: Option<&mut [Option<DisposedProcessor>; MAX_PLUGINS]>,
    ) {
        let previous = self.order;
        let previous_len = self.order_len;
        let len = len.min(MAX_PLUGINS);
        self.order = order;
        self.order_len = len;
        for &slot in &previous[..previous_len] {
            let idx = slot as usize;
            if slot == u8::MAX || idx >= MAX_PLUGINS || self.order[..len].contains(&slot) {
                continue;
            }
            self.retire_slot(
                idx,
                processors,
                active_count,
                retire_prod.as_deref_mut(),
                pending_retire.as_deref_mut(),
            );
        }
    }

    fn retire_slot(
        &mut self,
        slot: usize,
        processors: &mut [Option<VstProcessor>; MAX_PLUGINS],
        active_count: &mut usize,
        retire_prod: Option<&mut <HeapRb<DisposedProcessor> as Split>::Prod>,
        pending_retire: Option<&mut [Option<DisposedProcessor>; MAX_PLUGINS]>,
    ) {
        if slot >= MAX_PLUGINS {
            return;
        }
        self.bypassed[slot] = false;
        self.muted[slot] = false;
        self.gains[slot] = Smoother::new(1.0);
        self.transitions[slot].reset_idle();
        remove_from_order(&mut self.order, &mut self.order_len, slot as u8);
        plugin_health::clear_slot(
            &mut self.health,
            &mut self.health_tokens,
            &self.health_shared,
            slot as u8,
        );
        let (Some(prod), Some(pending)) = (retire_prod, pending_retire) else {
            return;
        };
        if pending[slot].is_some() {
            return;
        }
        let Some(processor) = processors[slot].take() else {
            return;
        };
        *active_count = active_count.saturating_sub(1);
        let retired = DisposedProcessor::Retired(RetiredProcessor {
            index: slot as u8,
            processor,
        });
        if let Err(retired) = prod.try_push(retired) {
            pending[slot] = Some(retired);
        }
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

pub(in crate::audio_engine::core) struct PluginBlock<'a> {
    pub(in crate::audio_engine::core) processors: &'a mut [Option<VstProcessor>; MAX_PLUGINS],
    pub(in crate::audio_engine::core) planar_buf_a: &'a mut [Vec<f32>],
    pub(in crate::audio_engine::core) planar_buf_b: &'a mut [Vec<f32>],
    pub(in crate::audio_engine::core) dry: &'a mut [Vec<f32>],
    pub(in crate::audio_engine::core) channels: usize,
    pub(in crate::audio_engine::core) frames: usize,
    pub(in crate::audio_engine::core) active_count: &'a mut usize,
    pub(in crate::audio_engine::core) global_bypass: bool,
    pub(in crate::audio_engine::core) retire_prod:
        Option<&'a mut <HeapRb<DisposedProcessor> as Split>::Prod>,
    pub(in crate::audio_engine::core) pending_retire:
        Option<&'a mut [Option<DisposedProcessor>; MAX_PLUGINS]>,
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

fn commit_soft_order(
    controls: &mut PluginControls,
    old: &[u8; MAX_PLUGINS],
    old_len: usize,
    new_order: &[u8; MAX_PLUGINS],
    new_len: usize,
) {
    let mut live = [u8::MAX; MAX_PLUGINS];
    let mut live_len = 0usize;
    for &slot in &new_order[..new_len] {
        if slot == u8::MAX || live_len >= MAX_PLUGINS || live[..live_len].contains(&slot) {
            continue;
        }
        live[live_len] = slot;
        live_len += 1;
    }
    for (index, &slot) in old[..old_len].iter().enumerate() {
        let idx = slot as usize;
        if slot == u8::MAX
            || idx >= MAX_PLUGINS
            || live[..live_len].contains(&slot)
            || live_len >= MAX_PLUGINS
        {
            continue;
        }
        // 削除フェードが終わるまで、その slot は今の位置に残す。
        if !(controls.transitions[idx].retiring && !controls.transitions[idx].is_settled_dry()) {
            continue;
        }
        let at = index.min(live_len);
        for cursor in (at..live_len).rev() {
            live[cursor + 1] = live[cursor];
        }
        live[at] = slot;
        live_len += 1;
    }
    controls.order = live;
    controls.order_len = live_len;
}

fn copy_dry(input: &[Vec<f32>], dry: &mut [Vec<f32>], channels: usize, frames: usize) {
    for channel in 0..channels {
        let Some(source) = input.get(channel).and_then(|buf| buf.get(..frames)) else {
            continue;
        };
        let Some(target) = dry.get_mut(channel).and_then(|buf| buf.get_mut(..frames)) else {
            continue;
        };
        target.copy_from_slice(source);
    }
}

fn copy_planar(
    planar_a: &mut [Vec<f32>],
    planar_b: &mut [Vec<f32>],
    source_is_a: bool,
    channels: usize,
    frames: usize,
) {
    for channel in 0..channels {
        if source_is_a {
            let Some(source) = planar_a.get(channel).map(|buf| buf.get(..frames)) else {
                continue;
            };
            let Some(source) = source else { continue };
            let Some(target) = planar_b
                .get_mut(channel)
                .and_then(|buf| buf.get_mut(..frames))
            else {
                continue;
            };
            target.copy_from_slice(source);
        } else {
            let Some(source) = planar_b.get(channel).map(|buf| buf.get(..frames)) else {
                continue;
            };
            let Some(source) = source else { continue };
            let Some(target) = planar_a
                .get_mut(channel)
                .and_then(|buf| buf.get_mut(..frames))
            else {
                continue;
            };
            target.copy_from_slice(source);
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
    pub(super) controls: &'a mut PluginControls,
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
        controls,
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
                latency,
            } => {
                let slot = index as usize;
                if slot < MAX_PLUGINS && rt_processors[slot].is_none() {
                    rt_processors[slot] = Some(processor);
                    *rt_active_count += 1;
                    controls.note_added(
                        slot,
                        initial_gain,
                        initial_bypassed,
                        initial_muted,
                        latency,
                    );
                    plugin_health::install_slot(
                        &mut controls.health,
                        &mut controls.health_tokens,
                        &controls.health_shared,
                        index,
                        health_token,
                    );
                } else {
                    pending_rejected.defer(DisposedProcessor::Rejected(processor), retire_prod);
                }
            }
            AudioThreadMessage::RemoveProcessor { index } => {
                let slot = index as usize;
                if controls.begin_remove(slot) {
                    controls.retire_slot(
                        slot,
                        rt_processors,
                        rt_active_count,
                        Some(&mut *retire_prod),
                        Some(&mut *pending_retire),
                    );
                }
            }
            AudioThreadMessage::ReorderProcessors { order, len } => {
                let drop_now = controls.begin_reorder(order, len);
                for (slot, drop) in drop_now.iter().enumerate() {
                    if *drop {
                        controls.retire_slot(
                            slot,
                            rt_processors,
                            rt_active_count,
                            Some(&mut *retire_prod),
                            Some(&mut *pending_retire),
                        );
                    }
                }
            }
            AudioThreadMessage::SetBypass {
                index,
                active,
                latency,
            } => {
                controls.request_bypass(index as usize, active, latency);
            }
            AudioThreadMessage::SetMute { index, active } => {
                controls.request_mute(index as usize, active);
            }
            AudioThreadMessage::SetGain { index, value } => {
                let slot = index as usize;
                if slot < MAX_PLUGINS && !controls.transitions[slot].retiring {
                    controls.gains[slot].set_target(value);
                }
            }
            AudioThreadMessage::ResumePlugin { index } => {
                controls.resume_slot(index);
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
            // 停止はストリームを閉じる。遷移の尾をデバイスへは出さない。
            AudioThreadMessage::Stop => {}
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vst_host::instance::{allocation_counts, ScriptedVst};

    fn fresh_controls(rate: u32) -> (PluginControls, Arc<PluginHealthShared>) {
        let shared = Arc::new(PluginHealthShared::new());
        let controls = PluginControls::new(rate, shared.clone());
        (controls, shared)
    }

    type Planar = Vec<Vec<f32>>;

    fn buffers(frames: usize, value: f32) -> (Planar, Planar, Planar) {
        (
            vec![vec![value; frames]; 2],
            vec![vec![0.0; frames]; 2],
            vec![vec![0.0; frames]; 2],
        )
    }

    fn run(
        controls: &mut PluginControls,
        processors: &mut [Option<VstProcessor>; MAX_PLUGINS],
        planar_a: &mut [Vec<f32>],
        planar_b: &mut [Vec<f32>],
        dry: &mut [Vec<f32>],
        frames: usize,
    ) -> bool {
        let mut active = 2usize;
        controls.process(PluginBlock {
            processors,
            planar_buf_a: planar_a,
            planar_buf_b: planar_b,
            dry,
            channels: 2,
            frames,
            active_count: &mut active,
            global_bypass: false,
            retire_prod: None,
            pending_retire: None,
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
        let (mut controls, shared) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order_len = 2;
        controls.install_slot(0, 11);
        controls.install_slot(1, 12);
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(bad.take());
        processors[1] = Some(next.take());
        let frames = 256;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.25);
        let mut finite = true;
        let mut silent = true;
        let counts = allocation_counts(|| {
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
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
                    &mut dry,
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
        assert_eq!(
            shared
                .isolated_publication(0, 11)
                .map(|state| state.isolation_seq),
            Some(1)
        );

        let counts = allocation_counts(|| {
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            silent = output(source_a, &planar_a, &planar_b)
                .iter()
                .all(|channel| channel.iter().all(|sample| *sample == 0.0));
        });
        assert_eq!(counts, (0, 0));
        assert!(silent);
        assert_eq!((bad.calls(), next.calls()), (19, 20));
        assert_eq!(
            shared
                .isolated_publication(0, 11)
                .map(|state| state.isolation_seq),
            Some(1)
        );

        controls.resume_slot(0);
        assert!(!controls.health[0].isolated);
        assert_eq!(shared.isolated_blocks(0, 11), None);
        let _ = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
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
                &mut dry,
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
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order_len = 2;
        controls.install_slot(0, 1);
        controls.bypassed[0] = true;
        controls.transitions[0].settle(true, false);
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(bad.take());
        processors[1] = Some(next.take());
        let frames = 64;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.4);
        let source_a = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
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
        controls.transitions[0].settle(false, true);
        let _ = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
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
        let (mut controls, _) = fresh_controls(44_100);
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order_len = 2;
        controls.install_slot(0, 3);
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(bad.take());
        processors[1] = Some(next.take());
        let frames = 128;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.2);
        let counts = allocation_counts(|| {
            let _ = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
        });
        assert_eq!(counts, (0, 0));
        assert!(!next.saw_non_finite());
        assert_eq!(bad.calls(), 1);
        assert!(!controls.health[0].isolated);
        drop(processors);
    }

    use super::super::super::slot_transition::TransitionMethod;
    use super::super::super::DisposedProcessor;
    use ringbuf::traits::{Consumer, Split};
    use ringbuf::HeapRb;

    fn click_limit(rate: u32) -> f32 {
        1.0 / (rate / 200).max(1) as f32 + 1.0e-3
    }

    fn max_step(samples: &[f32]) -> f32 {
        samples
            .windows(2)
            .fold(0.0_f32, |max, pair| max.max((pair[1] - pair[0]).abs()))
    }

    fn fill(planar_a: &mut [Vec<f32>], frames: usize, left: f32, right: f32) {
        planar_a[0][..frames].fill(left);
        planar_a[1][..frames].fill(right);
    }

    fn collect(
        stream: &mut [Vec<f32>; 2],
        source_a: bool,
        planar_a: &[Vec<f32>],
        planar_b: &[Vec<f32>],
        frames: usize,
    ) {
        let produced = output(source_a, planar_a, planar_b);
        for channel in 0..2 {
            stream[channel].extend_from_slice(&produced[channel][..frames]);
        }
    }

    fn within_bound(stream: &[Vec<f32>; 2], limit: f32) -> bool {
        stream.iter().all(|channel| max_step(channel) <= limit)
    }

    #[test]
    fn zero_latency_bypass_crossfade_stays_below_the_click_bound() {
        for &rate in &[44_100_u32, 48_000, 96_000] {
            for &frames in &[32_usize, 64, 480, 1056] {
                crossfade_case(rate, frames, 0.5, 0.0);
            }
        }
        // 右だけ鳴っているときも、左は 0 のまま独立して遷移する。
        crossfade_case(48_000, 64, 0.0, -0.4);
    }

    fn crossfade_case(rate: u32, frames: usize, left: f32, right: f32) {
        let mut plugin = ScriptedVst::scale(-1.0);
        let (mut controls, _) = fresh_controls(rate);
        controls.order[0] = 0;
        controls.order_len = 1;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(plugin.take());
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        let mut heard = [Vec::new(), Vec::new()];
        fill(&mut planar_a, frames, left, right);
        let source_a = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
            frames,
        );
        collect(&mut heard, source_a, &planar_a, &planar_b, frames);
        for active in [true, false] {
            controls.request_bypass(0, active, 0);
            assert_eq!(
                controls.transitions[0].method(),
                TransitionMethod::Crossfade
            );
            for _ in 0..80 {
                fill(&mut planar_a, frames, left, right);
                let source_a = run(
                    &mut controls,
                    &mut processors,
                    &mut planar_a,
                    &mut planar_b,
                    &mut dry,
                    frames,
                );
                collect(&mut heard, source_a, &planar_a, &planar_b, frames);
                let settled = if active {
                    controls.transitions[0].is_settled_dry()
                } else {
                    controls.transitions[0].is_settled_wet()
                };
                if settled {
                    break;
                }
            }
            let settled = if active {
                controls.transitions[0].is_settled_dry()
            } else {
                controls.transitions[0].is_settled_wet()
            };
            assert!(settled);
            // 完了ブロックの途中にはフェードの末尾が残る。次のブロック全体が目標値。
            fill(&mut planar_a, frames, left, right);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
            let expect = if active { 1.0 } else { -1.0 };
            let produced = output(source_a, &planar_a, &planar_b);
            for sample in &produced[0][..frames] {
                assert!((sample - left * expect).abs() < 1.0e-3, "{sample}");
            }
            for sample in &produced[1][..frames] {
                assert!((sample - right * expect).abs() < 1.0e-3, "{sample}");
            }
        }
        let limit = click_limit(rate);
        assert!(
            within_bound(&heard, limit),
            "rate {rate} frames {frames} step {} > {limit}",
            heard.iter().map(|ch| max_step(ch)).fold(0.0_f32, f32::max)
        );
        let ceiling = left.abs().max(right.abs()) + 1.0e-4;
        for channel in &heard {
            assert!(channel.iter().all(|sample| sample.abs() <= ceiling));
        }
        if left == 0.0 {
            assert!(heard[0].iter().all(|sample| *sample == 0.0));
        }
        if right == 0.0 {
            assert!(heard[1].iter().all(|sample| *sample == 0.0));
        }
        // 遷移なしの反転は振幅の 2 倍が一サンプルで動く。フェードの段差はその 1/4 より小さい。
        let instant = 2.0 * left.abs().max(right.abs());
        if instant > 0.0 {
            let step = heard.iter().map(|ch| max_step(ch)).fold(0.0_f32, f32::max);
            assert!(step < instant / 4.0, "{step} vs {instant}");
        }
        drop(processors);
    }

    #[test]
    fn delayed_or_unknown_latency_dips_and_an_impulse_is_not_doubled() {
        let (mut probe, _) = fresh_controls(48_000);
        probe.request_bypass(0, true, u32::MAX);
        assert_eq!(probe.transitions[0].method(), TransitionMethod::Dip);

        let latency = 8u32;
        let mut constant = ScriptedVst::delay(latency);
        assert_eq!(constant.declared_latency(), latency);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order_len = 1;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(constant.take());
        let frames = 64usize;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        for _ in 0..4 {
            fill(&mut planar_a, frames, 1.0, 0.0);
            let _ = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
        }
        controls.request_bypass(0, true, latency);
        assert_eq!(controls.transitions[0].method(), TransitionMethod::Dip);
        let mut heard = [Vec::new(), Vec::new()];
        for _ in 0..40 {
            fill(&mut planar_a, frames, 1.0, 0.0);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
            if controls.transitions[0].is_settled_dry() {
                break;
            }
        }
        assert!(controls.transitions[0].is_settled_dry());
        assert!(heard[0].iter().any(|sample| sample.abs() < 0.05));
        assert!((heard[0].last().copied().unwrap() - 1.0).abs() < 1.0e-3);
        assert!(heard[1].iter().all(|sample| *sample == 0.0));
        assert!(within_bound(&heard, click_limit(48_000)));
        assert!(heard[0].iter().all(|sample| sample.abs() <= 1.0 + 1.0e-4));
        drop(processors);

        // 無音の遅延線に、フェードアウト途中のインパルスを1つだけ入れる。
        // クロスフェードなら即時の dry と L サンプル後の wet で2回鳴る。
        let mut impulse = ScriptedVst::delay(latency);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order_len = 1;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(impulse.take());
        controls.request_bypass(0, true, latency);
        let mut heard = [Vec::new(), Vec::new()];
        for block in 0..40 {
            fill(&mut planar_a, frames, 0.0, 0.0);
            if block == 1 {
                planar_a[0][56] = 1.0;
            }
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
            if controls.transitions[0].is_settled_dry() {
                break;
            }
        }
        let mut peaks = 0u32;
        let mut above = false;
        for sample in &heard[0] {
            let hot = sample.abs() > 0.2;
            if hot && !above {
                peaks += 1;
            }
            above = hot;
        }
        assert_eq!(peaks, 1, "impulse was doubled");
        assert!(heard[1].iter().all(|sample| *sample == 0.0));
        drop(processors);
        drop(constant);
        drop(impulse);
    }

    #[test]
    fn mute_fades_out_while_calling_the_plugin_and_then_skips_it() {
        let mut plugin = ScriptedVst::scale(1.0);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order_len = 1;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(plugin.take());
        let frames = 64usize;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        fill(&mut planar_a, frames, 0.8, 0.0);
        let _ = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
            frames,
        );
        controls.request_mute(0, true);
        assert_eq!(controls.transitions[0].method(), TransitionMethod::Level);
        let mut heard = [Vec::new(), Vec::new()];
        for _ in 0..40 {
            fill(&mut planar_a, frames, 0.8, 0.0);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
            if controls.transitions[0].is_settled_silent() {
                break;
            }
        }
        assert!(controls.transitions[0].is_settled_silent());
        let calls_while_fading = plugin.calls();
        assert!(calls_while_fading > 1);
        for _ in 0..3 {
            fill(&mut planar_a, frames, 0.8, 0.0);
            let _ = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
        }
        assert_eq!(plugin.calls(), calls_while_fading);
        assert!(heard[0].last().copied().unwrap_or(1.0).abs() < 1.0e-3);
        assert!(heard[1].iter().all(|sample| *sample == 0.0));
        assert!(within_bound(&heard, click_limit(48_000)));
        controls.request_mute(0, false);
        for _ in 0..40 {
            fill(&mut planar_a, frames, 0.8, 0.0);
            let _ = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            if controls.transitions[0].is_settled_wet() {
                break;
            }
        }
        assert!(controls.transitions[0].is_settled_wet());
        assert!(plugin.calls() > calls_while_fading);
        drop(processors);
    }

    #[test]
    fn add_fades_from_dry_and_a_latent_plugin_dips_through_silence() {
        let frames = 64usize;
        let mut gain = ScriptedVst::scale(0.5);
        let (mut controls, _) = fresh_controls(48_000);
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(gain.take());
        controls.note_added(0, 1.0, false, false, 0);
        let mut order = [u8::MAX; MAX_PLUGINS];
        order[0] = 0;
        let _ = controls.begin_reorder(order, 1);
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        let mut heard = [Vec::new(), Vec::new()];
        for _ in 0..40 {
            fill(&mut planar_a, frames, 1.0, 0.0);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
            if controls.transitions[0].is_settled_wet() {
                break;
            }
        }
        assert_eq!(
            controls.transitions[0].method(),
            TransitionMethod::Crossfade
        );
        assert!(controls.transitions[0].is_settled_wet());
        assert!(heard[0].iter().all(|sample| (0.5..=1.0).contains(sample)));
        assert!(heard[1].iter().all(|sample| *sample == 0.0));
        assert!((heard[0].last().copied().unwrap() - 0.5).abs() < 1.0e-3);
        assert!(within_bound(&heard, click_limit(48_000)));
        // processor が mock を指したまま ScriptedVst を先に捨てない。
        drop(processors);

        let mut latent = ScriptedVst::delay(16);
        let (mut controls, _) = fresh_controls(48_000);
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(latent.take());
        controls.note_added(0, 1.0, false, false, 16);
        let _ = controls.begin_reorder(order, 1);
        let mut heard = [Vec::new(), Vec::new()];
        for _ in 0..40 {
            fill(&mut planar_a, frames, 1.0, 0.0);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
            if controls.transitions[0].is_settled_wet() {
                break;
            }
        }
        assert_eq!(controls.transitions[0].method(), TransitionMethod::Dip);
        assert!(controls.transitions[0].is_settled_wet());
        assert!(heard[0].iter().any(|sample| sample.abs() < 0.05));
        assert!(heard[0].iter().all(|sample| sample.abs() <= 1.0 + 1.0e-4));
        assert!((heard[0].last().copied().unwrap() - 1.0).abs() < 1.0e-3);
        assert!(heard[1].iter().all(|sample| *sample == 0.0));
        drop(processors);
        drop(gain);
        drop(latent);
    }

    #[test]
    fn add_starts_the_gain_smoother_at_the_initial_value() {
        let mut plugin = ScriptedVst::scale(1.0);
        let (mut controls, _) = fresh_controls(48_000);
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(plugin.take());
        controls.note_added(0, 0.5, false, false, 0);
        assert!((controls.gains[0].current() - 0.5).abs() < 1.0e-4);
        let mut order = [u8::MAX; MAX_PLUGINS];
        order[0] = 0;
        let _ = controls.begin_reorder(order, 1);
        let frames = 64usize;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        let mut heard = Vec::new();
        for _ in 0..40 {
            fill(&mut planar_a, frames, 1.0, 0.0);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            let produced = output(source_a, &planar_a, &planar_b);
            heard.extend_from_slice(&produced[0][..frames]);
            if controls.transitions[0].is_settled_wet() {
                break;
            }
        }
        assert!(heard.iter().all(|sample| (0.5..=1.0).contains(sample)));
        assert!((heard.last().copied().unwrap() - 0.5).abs() < 1.0e-3);
        drop(processors);
    }

    #[test]
    fn remove_fades_then_retires_off_the_audio_thread_and_drops_the_old_tail() {
        let mut bypassed = ScriptedVst::scale(1.0);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order_len = 1;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(bypassed.take());
        controls.request_bypass(0, true, 0);
        let frames = 64usize;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 1.0);
        for _ in 0..20 {
            fill(&mut planar_a, frames, 1.0, 0.0);
            let _ = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            if controls.transitions[0].is_settled_dry() {
                break;
            }
        }
        assert!(controls.begin_remove(0));
        controls.muted[0] = true;
        controls.transitions[0].settle(false, true);
        assert!(!controls.begin_remove(0));
        controls.health[0].isolated = true;
        controls.transitions[0].retiring = false;
        assert!(controls.begin_remove(0));
        drop(processors);

        let mut tail = ScriptedVst::tail(0.9);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order_len = 1;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(tail.take());
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        for _ in 0..30 {
            fill(&mut planar_a, frames, 1.0, 0.0);
            let _ = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
        }
        let ring = HeapRb::<DisposedProcessor>::new(4);
        let (mut prod, mut cons) = ring.split();
        let mut pending: [Option<DisposedProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        let mut active = 1usize;
        let mut peak = 0.0f32;
        let counts = allocation_counts(|| {
            assert!(!controls.begin_remove(0));
            let empty = [u8::MAX; MAX_PLUGINS];
            let _ = controls.begin_reorder(empty, 0);
            for _ in 0..48 {
                fill(&mut planar_a, frames, 0.0, 0.0);
                let source_a = controls.process(PluginBlock {
                    processors: &mut processors,
                    planar_buf_a: &mut planar_a,
                    planar_buf_b: &mut planar_b,
                    dry: &mut dry,
                    channels: 2,
                    frames,
                    active_count: &mut active,
                    global_bypass: false,
                    retire_prod: Some(&mut prod),
                    pending_retire: Some(&mut pending),
                });
                if processors[0].is_some() {
                    let produced = output(source_a, &planar_a, &planar_b);
                    for sample in &produced[0][..frames] {
                        peak = peak.max(sample.abs());
                    }
                } else {
                    break;
                }
            }
        });
        assert_eq!(counts, (0, 0));
        assert!(processors[0].is_none());
        assert!(peak > 1.0, "tail was cut before the fade");
        assert!(matches!(
            cons.try_pop(),
            Some(DisposedProcessor::Retired(_))
        ));
        assert!(pending.iter().all(|slot| slot.is_none()));
        let calls = tail.calls();
        for _ in 0..4 {
            fill(&mut planar_a, frames, 0.25, -0.25);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            let produced = output(source_a, &planar_a, &planar_b);
            assert!((produced[0][0] - 0.25).abs() < 1.0e-3);
            assert!((produced[1][0] - -0.25).abs() < 1.0e-3);
        }
        assert_eq!(tail.calls(), calls);
        drop(prod);
        drop(cons);
        drop(pending);
    }

    #[test]
    fn rapid_bypass_and_cancel_keep_the_last_request_without_a_jump() {
        let mut plugin = ScriptedVst::scale(-1.0);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order_len = 1;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(plugin.take());
        let frames = 64usize;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        let mut heard = [Vec::new(), Vec::new()];
        fill(&mut planar_a, frames, 0.5, 0.0);
        let source_a = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
            frames,
        );
        collect(&mut heard, source_a, &planar_a, &planar_b, frames);
        for block in 0..12 {
            let bypass = block % 2 == 0;
            controls.request_bypass(0, bypass, 0);
            controls.request_bypass(0, bypass, 0);
            fill(&mut planar_a, frames, 0.5, 0.0);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
        }
        // 最後の block 11 は bypass を外している。そのまま wet まで戻す。
        for _ in 0..40 {
            fill(&mut planar_a, frames, 0.5, 0.0);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
            if controls.transitions[0].is_settled_wet() {
                break;
            }
        }
        assert!(controls.transitions[0].is_settled_wet());
        assert!((heard[0].last().copied().unwrap() + 0.5).abs() < 1.0e-3);
        assert!(heard[1].iter().all(|sample| *sample == 0.0));
        assert!(within_bound(&heard, click_limit(48_000)));
        assert!(heard[0].iter().all(|sample| sample.abs() <= 0.5 + 1.0e-4));
        drop(processors);
    }

    #[test]
    fn reorder_dips_the_chain_and_applies_only_the_latest_order() {
        let mut first = ScriptedVst::constant(0.2);
        let mut middle = ScriptedVst::scale(1.0);
        let mut last = ScriptedVst::constant(0.8);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order[2] = 2;
        controls.order_len = 3;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(first.take());
        processors[1] = Some(middle.take());
        processors[2] = Some(last.take());
        let frames = 128usize;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        fill(&mut planar_a, frames, 1.0, 1.0);
        let source_a = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
            frames,
        );
        let started = output(source_a, &planar_a, &planar_b);
        assert!((started[0][0] - 0.8).abs() < 1.0e-4);
        let mut swapped = [u8::MAX; MAX_PLUGINS];
        swapped[0] = 1;
        swapped[1] = 0;
        swapped[2] = 2;
        let _ = controls.begin_reorder(swapped, 3);
        let mut latest = [u8::MAX; MAX_PLUGINS];
        latest[0] = 2;
        latest[1] = 1;
        latest[2] = 0;
        let _ = controls.begin_reorder(latest, 3);
        let mut heard = [Vec::new(), Vec::new()];
        for _ in 0..30 {
            fill(&mut planar_a, frames, 1.0, 1.0);
            let source_a = run(
                &mut controls,
                &mut processors,
                &mut planar_a,
                &mut planar_b,
                &mut dry,
                frames,
            );
            collect(&mut heard, source_a, &planar_a, &planar_b, frames);
            if controls.chain.idle()
                && controls.order_len == 3
                && controls.order[0] == 2
                && controls.order[2] == 0
            {
                break;
            }
        }
        assert!(controls.chain.idle());
        assert_eq!(&controls.order[..3], &[2, 1, 0]);
        assert!(heard[0].iter().any(|sample| sample.abs() < 0.05));
        assert!((heard[0].last().copied().unwrap() - 0.2).abs() < 1.0e-3);
        assert!((heard[1].last().copied().unwrap() - 0.2).abs() < 1.0e-3);
        assert!(heard
            .iter()
            .all(|ch| ch.iter().all(|sample| sample.abs() <= 0.8 + 1.0e-4)));
        assert!(within_bound(&heard, click_limit(48_000)));
        drop(processors);
    }

    #[test]
    fn isolated_slot_ignores_transitions_and_resume_fades_in_from_silence() {
        let mut plugin = ScriptedVst::scale(0.5);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order_len = 1;
        controls.health[0].isolated = true;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(plugin.take());
        let frames = 64usize;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.0);
        controls.request_bypass(0, true, 0);
        fill(&mut planar_a, frames, 1.0, 0.0);
        let source_a = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
            frames,
        );
        let produced = output(source_a, &planar_a, &planar_b);
        assert_eq!(plugin.calls(), 0);
        assert!(produced
            .iter()
            .all(|ch| ch[..frames].iter().all(|sample| *sample == 0.0)));
        // 停止中の bypass 解除は経路を動かさない。復帰してから無音→wet へフェードする。
        controls.request_bypass(0, false, 0);
        assert_eq!(plugin.calls(), 0);
        controls.resume_slot(0);
        fill(&mut planar_a, frames, 1.0, 0.0);
        let source_a = run(
            &mut controls,
            &mut processors,
            &mut planar_a,
            &mut planar_b,
            &mut dry,
            frames,
        );
        let produced = output(source_a, &planar_a, &planar_b);
        assert!(plugin.calls() >= 1);
        assert!(produced[0][0].abs() < 0.05);
        assert!(produced[1].iter().take(frames).all(|sample| *sample == 0.0));
        assert!(!controls.health[0].isolated);
        drop(processors);
    }

    #[test]
    fn device_silence_overrides_a_hot_transition_buffer() {
        // グローバルミュートとストリーム障害は、プラグイン鎖のあとでデバイスバッファを消す。
        // Stop はストリームを閉じ、遷移の尾を出さない。
        let mut device = vec![0.8_f32; 32];
        write_device_silence(&mut device);
        assert!(device.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn bypass_storm_and_reorder_do_not_allocate_on_the_audio_thread() {
        let mut left = ScriptedVst::scale(0.5);
        let mut right = ScriptedVst::constant(0.25);
        let (mut controls, _) = fresh_controls(48_000);
        controls.order[0] = 0;
        controls.order[1] = 1;
        controls.order_len = 2;
        let mut processors: [Option<VstProcessor>; MAX_PLUGINS] = std::array::from_fn(|_| None);
        processors[0] = Some(left.take());
        processors[1] = Some(right.take());
        let frames = 32usize;
        let (mut planar_a, mut planar_b, mut dry) = buffers(frames, 0.2);
        let mut forward = [u8::MAX; MAX_PLUGINS];
        forward[0] = 0;
        forward[1] = 1;
        let mut backward = [u8::MAX; MAX_PLUGINS];
        backward[0] = 1;
        backward[1] = 0;
        let counts = allocation_counts(|| {
            for step in 0..20 {
                controls.request_bypass(0, step % 2 == 0, 0);
                controls.request_mute(1, step % 3 == 0);
                let _ = if step % 2 == 0 {
                    controls.begin_reorder(backward, 2)
                } else {
                    controls.begin_reorder(forward, 2)
                };
                fill(&mut planar_a, frames, 0.2, -0.2);
                let _ = run(
                    &mut controls,
                    &mut processors,
                    &mut planar_a,
                    &mut planar_b,
                    &mut dry,
                    frames,
                );
            }
        });
        assert_eq!(counts, (0, 0));
        drop(processors);
    }
}
