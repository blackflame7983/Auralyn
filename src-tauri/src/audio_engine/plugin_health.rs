//! VST 出力の非有限値を、固定長のカウンタだけで判定する。
//!
//! 音声コールバックから呼ぶ。割当・ロック・待機・I/O はしない。
//! 有限の大振幅は対象にしない。最終段のピーク保護が担当し、
//! ここが大振幅で停止すると正常な音まで止めてしまう。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use super::plugins::MAX_PLUGINS;

/// 連続して無効な音声がこの時間以上、かつ 2 ブロック以上で停止する。
/// 48 kHz / 256 サンプルなら 100 ms は 4800 フレームで、19 ブロック目に届く。
const CONTINUOUS_INVALID_MS: u64 = 100;
/// 1 ブロックだけの異常では停止しない。44.1 kHz / 4096 でもこの下限が先に効く。
const CONTINUOUS_MIN_BLOCKS: u32 = 2;
/// 散発判定の固定窓。`window_elapsed_frames` がサンプルレート以上で窓を閉じる。
const SPORADIC_WINDOW_MS: u64 = 1_000;
/// 窓内の無効時間合計がこの値以上で停止する。
/// 48 kHz / 256 サンプルなら 250 ms は 12000 フレームで、約 47 ブロック分。
const SPORADIC_INVALID_MS: u64 = 250;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HealthLimits {
    continuous_frames: u64,
    window_frames: u64,
    sporadic_frames: u64,
}

impl HealthLimits {
    pub(crate) fn new(sample_rate: u32) -> Self {
        let rate = u64::from(sample_rate);
        Self {
            continuous_frames: rate.saturating_mul(CONTINUOUS_INVALID_MS) / 1_000,
            window_frames: rate.saturating_mul(SPORADIC_WINDOW_MS) / 1_000,
            sporadic_frames: rate.saturating_mul(SPORADIC_INVALID_MS) / 1_000,
        }
    }

    #[cfg(test)]
    pub(crate) fn continuous_frames(self) -> u64 {
        self.continuous_frames
    }

    #[cfg(test)]
    pub(crate) fn window_frames(self) -> u64 {
        self.window_frames
    }

    #[cfg(test)]
    pub(crate) fn sporadic_frames(self) -> u64 {
        self.sporadic_frames
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SlotHealth {
    pub(crate) consecutive_invalid_frames: u64,
    pub(crate) window_elapsed_frames: u64,
    pub(crate) window_invalid_frames: u64,
    pub(crate) consecutive_invalid_blocks: u32,
    pub(crate) total_invalid_blocks: u32,
    pub(crate) isolated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Pass,
    Silenced,
    Isolated,
}

impl SlotHealth {
    /// 有効ブロックは連続カウンタだけを戻し、窓は維持する。
    /// すでに停止している slot はカウンタを進めない。
    pub(crate) fn observe(
        &mut self,
        invalid: bool,
        frames: usize,
        limits: &HealthLimits,
    ) -> Verdict {
        if self.isolated {
            return Verdict::Isolated;
        }
        let frames = frames as u64;
        if invalid {
            self.consecutive_invalid_frames =
                self.consecutive_invalid_frames.saturating_add(frames);
            self.consecutive_invalid_blocks = self.consecutive_invalid_blocks.saturating_add(1);
            self.total_invalid_blocks = self.total_invalid_blocks.saturating_add(1);
            self.window_invalid_frames = self.window_invalid_frames.saturating_add(frames);
        } else {
            self.consecutive_invalid_frames = 0;
            self.consecutive_invalid_blocks = 0;
        }
        self.window_elapsed_frames = self.window_elapsed_frames.saturating_add(frames);
        // 連続は「100 ms 以上」かつ「2 ブロック以上」。散発も最初の 1 ブロックだけでは止めない。
        let continuous = self.consecutive_invalid_blocks >= CONTINUOUS_MIN_BLOCKS
            && self.consecutive_invalid_frames >= limits.continuous_frames;
        let sporadic = self.total_invalid_blocks >= CONTINUOUS_MIN_BLOCKS
            && self.window_invalid_frames >= limits.sporadic_frames;
        if continuous || sporadic {
            self.isolated = true;
        }
        if limits.window_frames > 0 && self.window_elapsed_frames >= limits.window_frames {
            self.window_elapsed_frames = 0;
            self.window_invalid_frames = 0;
        }
        if self.isolated {
            Verdict::Isolated
        } else if invalid {
            Verdict::Silenced
        } else {
            Verdict::Pass
        }
    }
}

/// 使用チャンネルの `[..frames]` に NaN または ±Inf があれば true。
/// チャンネル数が足りないときは、その先を読まず無効にもしない。
pub(crate) fn block_is_invalid(outputs: &[Vec<f32>], channels: usize, frames: usize) -> bool {
    outputs.iter().take(channels).any(|channel| {
        channel
            .get(..frames)
            .is_some_and(|samples| samples.iter().any(|sample| !sample.is_finite()))
    })
}

pub(crate) fn silence_used(outputs: &mut [Vec<f32>], channels: usize, frames: usize) {
    for channel in outputs.iter_mut().take(channels) {
        if let Some(region) = channel.get_mut(..frames) {
            region.fill(0.0);
        }
    }
}

struct SlotPublication {
    isolated: AtomicBool,
    invalid_blocks: AtomicU32,
    token: AtomicU64,
}

pub(crate) struct PluginHealthShared {
    slots: [SlotPublication; MAX_PLUGINS],
}

impl PluginHealthShared {
    pub(crate) fn new() -> Self {
        Self {
            slots: std::array::from_fn(|_| SlotPublication {
                isolated: AtomicBool::new(false),
                invalid_blocks: AtomicU32::new(0),
                token: AtomicU64::new(0),
            }),
        }
    }

    /// 値を Relaxed で書いてから、token を Release で公開する。
    pub(crate) fn publish(&self, slot: usize, isolated: bool, invalid_blocks: u32, token: u64) {
        let Some(slot) = self.slots.get(slot) else {
            return;
        };
        slot.invalid_blocks.store(invalid_blocks, Ordering::Relaxed);
        slot.isolated.store(isolated, Ordering::Relaxed);
        slot.token.store(token, Ordering::Release);
    }

    /// 制御側が今の instance に割り当てた token と一致するときだけ、停止中の件数を返す。
    pub(crate) fn isolated_blocks(&self, slot: usize, expected_token: u64) -> Option<u32> {
        if expected_token == 0 {
            return None;
        }
        let slot = self.slots.get(slot)?;
        let token = slot.token.load(Ordering::Acquire);
        if token != expected_token {
            return None;
        }
        let isolated = slot.isolated.load(Ordering::Relaxed);
        let blocks = slot.invalid_blocks.load(Ordering::Relaxed);
        if slot.token.load(Ordering::Acquire) != expected_token {
            return None;
        }
        isolated.then_some(blocks)
    }
}

pub(crate) fn install_slot(
    health: &mut [SlotHealth; MAX_PLUGINS],
    tokens: &mut [u64; MAX_PLUGINS],
    shared: &PluginHealthShared,
    index: u8,
    token: u64,
) {
    if (index as usize) >= MAX_PLUGINS {
        return;
    }
    let slot = index as usize;
    health[slot] = SlotHealth::default();
    tokens[slot] = token;
    shared.publish(slot, false, 0, token);
}

pub(crate) fn clear_slot(
    health: &mut [SlotHealth; MAX_PLUGINS],
    tokens: &mut [u64; MAX_PLUGINS],
    shared: &PluginHealthShared,
    index: u8,
) {
    if (index as usize) >= MAX_PLUGINS {
        return;
    }
    let slot = index as usize;
    health[slot] = SlotHealth::default();
    tokens[slot] = 0;
    shared.publish(slot, false, 0, 0);
}

pub(crate) fn resume_slot(
    health: &mut [SlotHealth; MAX_PLUGINS],
    tokens: &[u64; MAX_PLUGINS],
    shared: &PluginHealthShared,
    index: u8,
) {
    if (index as usize) >= MAX_PLUGINS {
        return;
    }
    let slot = index as usize;
    let token = tokens[slot];
    health[slot] = SlotHealth::default();
    shared.publish(slot, false, 0, token);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(samples: &[f32]) -> Vec<f32> {
        samples.to_vec()
    }

    #[test]
    fn finite_audio_including_large_values_is_valid() {
        let outputs = vec![
            channel(&[0.0, 1.0, -1.0, 1.0e20, f32::MAX]),
            channel(&[f32::MIN, -1.0e20, 0.5, 0.25, -0.5]),
        ];
        assert!(!block_is_invalid(&outputs, 2, 5));
        assert!(!block_is_invalid(&outputs, 0, 5));
        assert!(!block_is_invalid(&outputs, 2, 0));
    }

    #[test]
    fn nan_and_infinities_on_either_side_are_invalid() {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let left = vec![channel(&[0.25, value]), channel(&[0.25, 0.25])];
            let right = vec![channel(&[0.25, 0.25]), channel(&[0.25, value])];
            let both = vec![channel(&[value, 0.25]), channel(&[0.25, value])];
            assert!(block_is_invalid(&left, 2, 2), "{value}");
            assert!(block_is_invalid(&right, 2, 2), "{value}");
            assert!(block_is_invalid(&both, 2, 2), "{value}");
        }
        let unused = vec![channel(&[0.2]), channel(&[0.2]), channel(&[f32::NAN])];
        assert!(!block_is_invalid(&unused, 2, 1));
    }

    #[test]
    fn one_block_never_isolates_even_when_it_exceeds_both_time_limits() {
        for rate in [44_100, 48_000, 96_000] {
            let limits = HealthLimits::new(rate);
            let mut health = SlotHealth::default();
            let verdict = health.observe(true, rate as usize, &limits);
            assert_eq!(verdict, Verdict::Silenced);
            assert!(!health.isolated);
            assert_eq!(health.consecutive_invalid_blocks, 1);
            assert_eq!(health.total_invalid_blocks, 1);
        }
    }

    #[test]
    fn continuous_invalid_audio_isolates_at_100ms_and_a_valid_block_restarts_it() {
        let limits = HealthLimits::new(48_000);
        assert_eq!(limits.continuous_frames(), 4_800);
        let mut health = SlotHealth::default();
        for block in 1..19 {
            let verdict = health.observe(true, 256, &limits);
            assert_eq!(verdict, Verdict::Silenced, "block {block}");
            assert!(!health.isolated);
        }
        assert_eq!(health.observe(true, 256, &limits), Verdict::Isolated);
        assert!(health.isolated);
        assert_eq!(health.total_invalid_blocks, 19);

        health = SlotHealth::default();
        for _ in 0..18 {
            health.observe(true, 256, &limits);
        }
        assert_eq!(health.observe(false, 256, &limits), Verdict::Pass);
        assert_eq!(health.consecutive_invalid_frames, 0);
        assert!(health.window_invalid_frames > 0);
        for _ in 0..18 {
            assert_eq!(health.observe(true, 256, &limits), Verdict::Silenced);
        }
        assert_eq!(health.observe(true, 256, &limits), Verdict::Isolated);
    }

    #[test]
    fn sporadic_invalid_audio_isolates_at_250ms_and_the_window_resets() {
        let limits = HealthLimits::new(48_000);
        assert_eq!(limits.sporadic_frames(), 12_000);
        assert_eq!(limits.window_frames(), 48_000);
        let mut health = SlotHealth::default();
        let burst = 2_048usize;
        for _ in 0..5 {
            assert_eq!(health.observe(true, burst, &limits), Verdict::Silenced);
            assert_eq!(health.observe(false, 64, &limits), Verdict::Pass);
        }
        assert_eq!(health.window_invalid_frames, 5 * burst as u64);
        let rest = (limits.window_frames() - health.window_elapsed_frames) as usize;
        assert_eq!(health.observe(false, rest, &limits), Verdict::Pass);
        assert_eq!(health.window_elapsed_frames, 0);
        assert_eq!(health.window_invalid_frames, 0);
        for _ in 0..5 {
            assert_eq!(health.observe(true, burst, &limits), Verdict::Silenced);
            assert_eq!(health.observe(false, 64, &limits), Verdict::Pass);
        }
        assert_eq!(health.observe(true, burst, &limits), Verdict::Isolated);
    }

    #[test]
    fn thresholds_follow_time_at_each_rate_and_block_size() {
        for rate in [44_100u32, 48_000, 96_000] {
            let limits = HealthLimits::new(rate);
            assert_eq!(
                limits.continuous_frames(),
                u64::from(rate) * CONTINUOUS_INVALID_MS / 1_000
            );
            assert_eq!(limits.window_frames(), u64::from(rate));
            assert_eq!(
                limits.sporadic_frames(),
                u64::from(rate) * SPORADIC_INVALID_MS / 1_000
            );
            for block in [64usize, 256, 4_096] {
                let mut health = SlotHealth::default();
                assert_eq!(health.observe(true, block, &limits), Verdict::Silenced);
                let mut blocks = 1u32;
                while !health.isolated {
                    blocks += 1;
                    let verdict = health.observe(true, block, &limits);
                    if health.isolated {
                        assert_eq!(verdict, Verdict::Isolated);
                    }
                    assert!(blocks < 10_000, "rate {rate} block {block}");
                }
                let frames = u64::from(blocks) * block as u64;
                let continuous = frames >= limits.continuous_frames() && blocks >= 2;
                let sporadic = frames >= limits.sporadic_frames() && blocks >= 2;
                assert!(
                    continuous || sporadic,
                    "rate {rate} block {block} blocks {blocks}"
                );
                let previous = frames - block as u64;
                let previous_blocks = blocks - 1;
                let previous_continuous =
                    previous >= limits.continuous_frames() && previous_blocks >= 2;
                let previous_sporadic =
                    previous >= limits.sporadic_frames() && previous_blocks >= 2;
                assert!(
                    !previous_continuous && !previous_sporadic,
                    "rate {rate} block {block} stopped late at {blocks}"
                );
            }
        }
        // 44.1 kHz / 4096 は 1 ブロックが 100 ms 未満。2 ブロック目で連続条件に届く。
        let limits = HealthLimits::new(44_100);
        let mut health = SlotHealth::default();
        assert_eq!(health.observe(true, 4_096, &limits), Verdict::Silenced);
        assert_eq!(health.observe(true, 4_096, &limits), Verdict::Isolated);
    }

    #[test]
    fn published_state_is_adopted_only_for_the_current_token() {
        let shared = PluginHealthShared::new();
        shared.publish(0, true, 4, 1);
        assert_eq!(shared.isolated_blocks(0, 1), Some(4));
        assert_eq!(shared.isolated_blocks(0, 2), None);
        assert_eq!(shared.isolated_blocks(0, 0), None);
        shared.publish(0, false, 0, 2);
        assert_eq!(shared.isolated_blocks(0, 1), None);
        assert_eq!(shared.isolated_blocks(0, 2), None);
    }

    #[test]
    fn slot_reset_clears_isolation_and_resume_keeps_the_token() {
        let shared = PluginHealthShared::new();
        let mut health = [SlotHealth::default(); MAX_PLUGINS];
        let mut tokens = [0; MAX_PLUGINS];
        install_slot(&mut health, &mut tokens, &shared, 3, 8);
        health[3].isolated = true;
        health[3].total_invalid_blocks = 6;
        shared.publish(3, true, 6, 8);
        assert_eq!(shared.isolated_blocks(3, 8), Some(6));
        clear_slot(&mut health, &mut tokens, &shared, 3);
        assert!(!health[3].isolated);
        assert_eq!(tokens[3], 0);
        assert_eq!(shared.isolated_blocks(3, 8), None);
        install_slot(&mut health, &mut tokens, &shared, 3, 9);
        health[3].isolated = true;
        shared.publish(3, true, 2, 9);
        resume_slot(&mut health, &tokens, &shared, 3);
        assert!(!health[3].isolated);
        assert_eq!(tokens[3], 9);
        assert_eq!(shared.isolated_blocks(3, 9), None);
    }
}
