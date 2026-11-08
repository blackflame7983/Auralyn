//! slot 単位の wet/dry 遷移と、並べ替え用のチェーンフェード。
//! 係数と残フレームだけを持ち、処理中に確保・解放しない。

use crate::audio_engine::plugins::MAX_PLUGINS;

const EPS: f32 = 1.0e-4;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(in crate::audio_engine::core) enum TransitionMethod {
    /// 申告遅延 0。wet と dry を同じ長さで入れ替える。
    Crossfade,
    /// 遅延あり、または不明。無音を挟んでから次の経路へ戻す。
    Dip,
    /// 無音との出入り。遅延の違う音を重ねない。
    Level,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(in crate::audio_engine::core) enum SlotRoute {
    Wet,
    Dry,
    Silent,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Direct,
    /// いったん両方の係数を 0 にし、その後 `pending_*` へ戻す。
    DipOut,
}

#[derive(Clone, Copy)]
pub(in crate::audio_engine::core) struct SlotTransition {
    wet: f32,
    dry: f32,
    wet_start: f32,
    dry_start: f32,
    wet_target: f32,
    dry_target: f32,
    pending_wet: f32,
    pending_dry: f32,
    remaining: u32,
    duration: u32,
    half: u32,
    full: u32,
    phase: Phase,
    requested: SlotRoute,
    method: TransitionMethod,
    /// 削除待ち。完了まで別の目標は受け付けない。
    pub(in crate::audio_engine::core) retiring: bool,
    /// 順序に入った最初のブロックで dry から目標へ進める。
    pub(in crate::audio_engine::core) armed: bool,
    pub(in crate::audio_engine::core) latency: u32,
}

impl SlotTransition {
    pub(in crate::audio_engine::core) fn at_rest(
        rate: u32,
        latency: u32,
        bypassed: bool,
        muted: bool,
    ) -> Self {
        let mut slot = Self::from_rate(rate);
        slot.latency = latency;
        slot.settle(bypassed, muted);
        slot
    }

    fn from_rate(rate: u32) -> Self {
        // T = rate/100。半分は T/2。0 除算を避けるため最短 1 フレーム。
        let full = (rate / 100).max(1);
        let half = (rate / 200).max(1);
        Self::from_lengths(full, half)
    }

    fn from_lengths(full: u32, half: u32) -> Self {
        Self {
            wet: 1.0,
            dry: 0.0,
            wet_start: 1.0,
            dry_start: 0.0,
            wet_target: 1.0,
            dry_target: 0.0,
            pending_wet: 1.0,
            pending_dry: 0.0,
            remaining: 0,
            duration: 1,
            half: half.max(1),
            full: full.max(1),
            phase: Phase::Direct,
            requested: SlotRoute::Wet,
            method: TransitionMethod::Crossfade,
            retiring: false,
            armed: false,
            latency: 0,
        }
    }

    #[cfg(test)]
    pub(in crate::audio_engine::core) fn full_frames(&self) -> u32 {
        self.full
    }

    #[cfg(test)]
    pub(in crate::audio_engine::core) fn half_frames(&self) -> u32 {
        self.half
    }

    #[cfg(test)]
    pub(in crate::audio_engine::core) fn method(&self) -> TransitionMethod {
        self.method
    }

    pub(in crate::audio_engine::core) fn reset_idle(&mut self) {
        let full = self.full;
        let half = self.half;
        *self = Self::from_lengths(full, half);
    }

    pub(in crate::audio_engine::core) fn settle(&mut self, bypassed: bool, muted: bool) {
        let full = self.full;
        let half = self.half;
        let latency = self.latency;
        *self = Self::from_lengths(full, half);
        self.latency = latency;
        if bypassed {
            self.force(SlotRoute::Dry);
        } else if muted {
            self.force(SlotRoute::Silent);
        }
    }

    fn force(&mut self, route: SlotRoute) {
        let (wet, dry) = targets(route);
        self.wet = wet;
        self.dry = dry;
        self.wet_start = wet;
        self.dry_start = dry;
        self.wet_target = wet;
        self.dry_target = dry;
        self.pending_wet = wet;
        self.pending_dry = dry;
        self.remaining = 0;
        self.phase = Phase::Direct;
        self.requested = route;
        self.armed = false;
        self.retiring = false;
    }

    pub(in crate::audio_engine::core) fn note_added(
        &mut self,
        latency: u32,
        bypassed: bool,
        muted: bool,
    ) {
        self.latency = latency;
        self.settle(bypassed, muted);
        if !bypassed && !muted {
            // 追加直後は dry のまま待ち、順序に入ったブロックから wet へ進む。
            self.force(SlotRoute::Dry);
            self.latency = latency;
            self.armed = true;
        }
    }

    pub(in crate::audio_engine::core) fn resume_from_silence(
        &mut self,
        bypassed: bool,
        muted: bool,
    ) {
        if self.retiring {
            return;
        }
        self.wet = 0.0;
        self.dry = 0.0;
        self.remaining = 0;
        self.phase = Phase::Direct;
        self.requested = SlotRoute::Silent;
        self.wet_target = 0.0;
        self.dry_target = 0.0;
        self.armed = false;
        let route = if bypassed {
            SlotRoute::Dry
        } else if muted {
            SlotRoute::Silent
        } else {
            SlotRoute::Wet
        };
        self.retarget(route);
    }

    pub(in crate::audio_engine::core) fn retarget(&mut self, requested: SlotRoute) {
        if self.retiring && requested != SlotRoute::Dry {
            return;
        }
        let (tw, td) = targets(requested);
        if self.same_destination(tw, td) {
            self.requested = requested;
            return;
        }
        self.requested = requested;
        let dip =
            self.latency != 0 && ((self.wet > EPS && td > EPS) || (self.dry > EPS && tw > EPS));
        self.method = if dip {
            TransitionMethod::Dip
        } else if requested == SlotRoute::Silent || (self.wet <= EPS && self.dry <= EPS) {
            TransitionMethod::Level
        } else {
            TransitionMethod::Crossfade
        };
        if dip {
            self.pending_wet = tw;
            self.pending_dry = td;
            if self.wet <= EPS && self.dry <= EPS {
                self.phase = Phase::Direct;
                self.ramp(tw, td, self.half);
            } else if self.phase == Phase::DipOut {
                // 無音へ向かう途中の目標変更は、着地だけ差し替える。
            } else {
                self.phase = Phase::DipOut;
                self.ramp(0.0, 0.0, self.half);
            }
        } else {
            self.phase = Phase::Direct;
            self.pending_wet = tw;
            self.pending_dry = td;
            self.ramp(tw, td, self.full);
        }
    }

    fn same_destination(&self, tw: f32, td: f32) -> bool {
        let at_target = self.remaining == 0
            && (self.wet - tw).abs() <= EPS
            && (self.dry - td).abs() <= EPS
            && self.phase == Phase::Direct;
        let same_ramp = self.phase == Phase::Direct
            && (self.wet_target - tw).abs() <= EPS
            && (self.dry_target - td).abs() <= EPS
            && self.remaining > 0;
        let same_dip = self.phase == Phase::DipOut
            && (self.pending_wet - tw).abs() <= EPS
            && (self.pending_dry - td).abs() <= EPS;
        at_target || same_ramp || same_dip
    }

    fn ramp(&mut self, wet_target: f32, dry_target: f32, frames: u32) {
        self.wet_start = self.wet;
        self.dry_start = self.dry;
        self.wet_target = wet_target;
        self.dry_target = dry_target;
        let frames = frames.max(1);
        self.duration = frames;
        self.remaining = frames;
    }

    pub(in crate::audio_engine::core) fn is_settled_wet(&self) -> bool {
        !self.armed
            && !self.retiring
            && self.phase == Phase::Direct
            && self.remaining == 0
            && self.wet >= 1.0 - EPS
            && self.dry <= EPS
    }

    pub(in crate::audio_engine::core) fn is_settled_dry(&self) -> bool {
        !self.armed
            && self.phase == Phase::Direct
            && self.remaining == 0
            && self.wet <= EPS
            && self.dry >= 1.0 - EPS
    }

    pub(in crate::audio_engine::core) fn is_settled_silent(&self) -> bool {
        !self.armed
            && self.phase == Phase::Direct
            && self.remaining == 0
            && self.requested == SlotRoute::Silent
            && self.wet <= EPS
            && self.dry <= EPS
    }

    pub(in crate::audio_engine::core) fn block_needs_wet(&self) -> bool {
        self.wet > EPS
            || self.wet_target > EPS
            || (self.phase == Phase::DipOut && self.pending_wet > EPS)
    }

    pub(in crate::audio_engine::core) fn block_needs_dry(&self) -> bool {
        self.dry > EPS
            || self.dry_target > EPS
            || (self.phase == Phase::DipOut && self.pending_dry > EPS)
    }

    pub(in crate::audio_engine::core) fn next_frame(&mut self) -> (f32, f32) {
        if self.remaining > 0 {
            self.remaining -= 1;
            let scale = self.remaining as f32 / self.duration.max(1) as f32;
            self.wet = self.wet_target + (self.wet_start - self.wet_target) * scale;
            self.dry = self.dry_target + (self.dry_start - self.dry_target) * scale;
        }
        if self.phase == Phase::DipOut && self.remaining == 0 {
            self.phase = Phase::Direct;
            let (wet, dry) = (self.pending_wet, self.pending_dry);
            self.ramp(wet, dry, self.half);
        }
        (self.wet.clamp(0.0, 1.0), self.dry.clamp(0.0, 1.0))
    }

    pub(in crate::audio_engine::core) fn ready_to_retire(&self) -> bool {
        self.retiring && self.is_settled_dry()
    }
}

fn targets(route: SlotRoute) -> (f32, f32) {
    match route {
        SlotRoute::Wet => (1.0, 0.0),
        SlotRoute::Dry => (0.0, 1.0),
        SlotRoute::Silent => (0.0, 0.0),
    }
}

/// 並べ替えのとき、チェーン出力を無音まで下げてから順序を差し替える。
#[derive(Clone, Copy)]
pub(in crate::audio_engine::core) struct ChainFade {
    gain: f32,
    start: f32,
    target: f32,
    remaining: u32,
    duration: u32,
    half: u32,
    pending: bool,
    pending_order: [u8; MAX_PLUGINS],
    pending_len: usize,
}

impl ChainFade {
    pub(in crate::audio_engine::core) fn new(rate: u32) -> Self {
        Self {
            gain: 1.0,
            start: 1.0,
            target: 1.0,
            remaining: 0,
            duration: 1,
            half: (rate / 200).max(1),
            pending: false,
            pending_order: [u8::MAX; MAX_PLUGINS],
            pending_len: 0,
        }
    }

    pub(in crate::audio_engine::core) fn set_pending(
        &mut self,
        order: [u8; MAX_PLUGINS],
        len: usize,
    ) {
        self.pending_order = order;
        self.pending_len = len.min(MAX_PLUGINS);
        self.pending = true;
    }

    pub(in crate::audio_engine::core) fn clear_pending(&mut self) {
        self.pending = false;
    }

    /// 全体 bypass 中は音がプラグインを通らないので、無音を挟まず順序だけ差し替える。
    pub(in crate::audio_engine::core) fn take_pending_now(
        &mut self,
    ) -> Option<([u8; MAX_PLUGINS], usize)> {
        if !self.pending {
            return None;
        }
        self.pending = false;
        self.gain = 1.0;
        self.start = 1.0;
        self.target = 1.0;
        self.remaining = 0;
        Some((self.pending_order, self.pending_len))
    }

    pub(in crate::audio_engine::core) fn idle(&self) -> bool {
        !self.pending && self.remaining == 0 && (self.gain - 1.0).abs() <= EPS
    }

    pub(in crate::audio_engine::core) fn snap_idle(&mut self) {
        self.gain = 1.0;
        self.start = 1.0;
        self.target = 1.0;
        self.remaining = 0;
    }

    /// 無音に到達済みなら、ためた順序を返してフェードインを始める。
    pub(in crate::audio_engine::core) fn begin_block(
        &mut self,
        frames: u32,
    ) -> Option<([u8; MAX_PLUGINS], usize)> {
        if frames == 0 {
            return None;
        }
        let apply = if self.pending && self.remaining == 0 && self.gain <= EPS {
            let order = self.pending_order;
            let len = self.pending_len;
            self.pending = false;
            self.ramp(1.0, self.half);
            Some((order, len))
        } else {
            if self.pending {
                if self.target > EPS {
                    self.ramp(0.0, self.half);
                }
            } else if self.target <= EPS || (self.gain - 1.0).abs() > EPS && self.remaining == 0 {
                self.ramp(1.0, self.half);
            }
            None
        };
        // フェードアウトがブロック途中で終わると、無音の途中から次の経路が聞こえる。
        // 全体比較と同じく、0 へ向かう区間はブロック末尾まで伸ばす。
        if self.target <= EPS && self.remaining < frames {
            self.ramp(0.0, frames.max(1));
        }
        apply
    }

    fn ramp(&mut self, target: f32, frames: u32) {
        self.start = self.gain;
        self.target = target;
        let frames = frames.max(1);
        self.duration = frames;
        self.remaining = frames;
    }

    pub(in crate::audio_engine::core) fn next_gain(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            self.gain = self.target
                + (self.start - self.target) * self.remaining as f32 / self.duration.max(1) as f32;
        }
        self.gain
    }
}

pub(in crate::audio_engine::core) fn route_for(bypassed: bool, muted: bool) -> SlotRoute {
    if bypassed {
        SlotRoute::Dry
    } else if muted {
        SlotRoute::Silent
    } else {
        SlotRoute::Wet
    }
}

/// 共通 slot の相対順が変わるときだけ、チェーン全体を無音経由で入れ替える。
pub(in crate::audio_engine::core) fn relative_order_changed(old: &[u8], new: &[u8]) -> bool {
    let mut filtered_old = [0u8; MAX_PLUGINS];
    let mut filtered_new = [0u8; MAX_PLUGINS];
    let mut old_count = 0usize;
    let mut new_count = 0usize;
    for &slot in old {
        if slot != u8::MAX && new.contains(&slot) && old_count < MAX_PLUGINS {
            filtered_old[old_count] = slot;
            old_count += 1;
        }
    }
    for &slot in new {
        if slot != u8::MAX && old.contains(&slot) && new_count < MAX_PLUGINS {
            filtered_new[new_count] = slot;
            new_count += 1;
        }
    }
    filtered_old[..old_count] != filtered_new[..new_count]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    #[test]
    fn zero_latency_crossfade_keeps_unit_sum_and_dip_stays_single_path() {
        let mut cross = SlotTransition::at_rest(48_000, 0, false, false);
        cross.retarget(SlotRoute::Dry);
        assert_eq!(cross.method(), TransitionMethod::Crossfade);
        let mut previous = (1.0, 0.0);
        for _ in 0..cross.full_frames() {
            let now = cross.next_frame();
            assert!((now.0 + now.1 - 1.0).abs() < 1.0e-4);
            assert!((now.0 - previous.0).abs() <= 1.0 / cross.full_frames() as f32 + 1.0e-4);
            previous = now;
        }
        assert!(cross.is_settled_dry());

        let mut dip = SlotTransition::at_rest(48_000, 32, false, false);
        dip.retarget(SlotRoute::Dry);
        assert_eq!(dip.method(), TransitionMethod::Dip);
        let mut saw_silence = false;
        let mut dry_after = false;
        for _ in 0..(dip.half_frames() * 3) {
            let (wet, dry) = dip.next_frame();
            assert!(wet <= EPS || dry <= EPS, "dip overlaid wet and dry");
            if wet <= EPS && dry <= EPS {
                saw_silence = true;
            }
            if saw_silence && dry > EPS {
                dry_after = true;
            }
        }
        assert!(saw_silence && dry_after);
        assert!(dip.is_settled_dry());
    }

    #[test]
    fn retarget_continues_from_the_current_mix_and_duplicates_do_not_restart() {
        let mut slot = SlotTransition::at_rest(48_000, 0, false, false);
        slot.retarget(SlotRoute::Dry);
        for _ in 0..30 {
            slot.next_frame();
        }
        let mid = slot.wet;
        slot.retarget(SlotRoute::Wet);
        let next = slot.next_frame();
        assert!((next.0 - mid).abs() <= 1.0 / slot.full_frames() as f32 + 1.0e-3);
        assert!(next.0 >= mid - 1.0e-4);
        let remaining_before = {
            slot.retarget(SlotRoute::Wet);
            // 同じ目標の再送ではランプを最初からやり直さない。
            slot.remaining
        };
        slot.retarget(SlotRoute::Wet);
        assert_eq!(slot.remaining, remaining_before);
    }

    #[test]
    fn envelope_stepping_does_not_allocate() {
        let mut slot = SlotTransition::at_rest(96_000, 8, false, false);
        let mut chain = ChainFade::new(96_000);
        assert_eq!(
            allocation_counts(|| {
                slot.retarget(SlotRoute::Dry);
                for _ in 0..2_000 {
                    let _ = slot.next_frame();
                }
                let mut order = [u8::MAX; MAX_PLUGINS];
                order[0] = 1;
                order[1] = 0;
                chain.set_pending(order, 2);
                let _ = chain.begin_block(128);
                for _ in 0..1_000 {
                    let _ = chain.next_gain();
                }
            }),
            (0, 0)
        );
    }
}
