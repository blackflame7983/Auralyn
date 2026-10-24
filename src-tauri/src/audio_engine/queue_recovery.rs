//! 有限回の滞留回復。速度差を繰り返しの破棄で隠さず、ASRCは行わない。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Running,
    Down,
    Silent,
    Up,
}

pub struct Recovery {
    capacity: usize,
    rate: usize,
    target_blocks: usize,
    high_blocks: usize,
    block: usize,
    high_frames: usize,
    fade_frames: usize,
    gain: f32,
    phase: Phase,
    used: bool,
    unsupported: bool,
    exhausted: bool,
}

impl Recovery {
    pub fn new(capacity: usize, rate: usize, target_blocks: usize, high_blocks: usize) -> Self {
        Self {
            capacity,
            rate,
            target_blocks,
            high_blocks,
            block: 0,
            high_frames: 0,
            fade_frames: (rate / 100).max(1),
            gain: 1.0,
            phase: Phase::Running,
            used: false,
            unsupported: false,
            exhausted: false,
        }
    }
    /// 読出し前の完全frame数。burstは入力側が観測した最大生成量。
    /// 返却した破棄量はconsumerだけが、gain=0の境界で実行する。
    pub fn begin_block(
        &mut self,
        queued: usize,
        frames: usize,
        burst: usize,
        blocked: bool,
    ) -> usize {
        self.block = self.block.max(frames).max(burst);
        let required = self.block.checked_mul(self.high_blocks + 1);
        if self.block == 0 || required.is_none_or(|n| n > self.capacity) {
            self.unsupported = true;
        }
        if blocked || self.unsupported {
            self.high_frames = 0;
            if self.phase != Phase::Running {
                self.phase = Phase::Up;
            }
            return 0;
        }
        if self.phase == Phase::Silent {
            self.used = true;
            self.phase = Phase::Up;
            return queued.saturating_sub(self.target_blocks * self.block);
        }
        if self.phase == Phase::Running {
            if queued > self.high_blocks * self.block {
                self.high_frames = self.high_frames.saturating_add(frames);
                if self.high_frames >= self.rate / 10 {
                    if self.used {
                        self.exhausted = true;
                    } else {
                        self.phase = Phase::Down;
                    }
                }
            } else {
                self.high_frames = 0;
            }
        }
        0
    }
    pub fn next_gain(&mut self) -> f32 {
        let step = 1.0 / self.fade_frames as f32;
        match self.phase {
            Phase::Down => {
                self.gain = (self.gain - step).max(0.0);
                if self.gain == 0.0 {
                    self.phase = Phase::Silent;
                }
            }
            Phase::Up => {
                self.gain = (self.gain + step).min(1.0);
                if self.gain == 1.0 {
                    self.phase = Phase::Running;
                }
            }
            _ => {}
        }
        self.gain
    }
    pub fn status(&self) -> u64 {
        if self.unsupported {
            1
        } else if self.exhausted {
            2
        } else {
            0
        }
    }
    pub fn active(&self) -> bool {
        self.phase != Phase::Running
    }
    pub fn target(&self) -> usize {
        self.target_blocks * self.block
    }
    pub fn high(&self) -> usize {
        self.high_blocks * self.block
    }
}

/// 測定要求は最新1件だけ保持。フェード中は旧測定を終了し、次のunityブロックを待つ。
#[derive(Default)]
pub struct MeasurementGate {
    pending: Option<u64>,
}
impl MeasurementGate {
    pub fn request(&mut self, id: Option<u64>, recovery: &Recovery) -> Option<u64> {
        self.pending = id.filter(|_| recovery.active());
        if self.pending.is_some() {
            None
        } else {
            id
        }
    }
    pub fn blocks_recovery(&self) -> bool {
        self.pending.is_some()
    }
    pub fn take_ready(&mut self, recovery: &Recovery) -> Option<u64> {
        if recovery.active() {
            None
        } else {
            self.pending.take()
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    #[test]
    fn loudness_request_during_down_or_silent_measures_only_next_unity_block() {
        for silent in [false, true] {
            let mut r = Recovery::new(4363, 96000, 1, 3);
            for _ in 0..19 {
                r.begin_block(4096, 512, 512, false);
            }
            assert_eq!(r.phase, Phase::Down);
            for _ in 0..if silent { 960 } else { 100 } {
                r.next_gain();
            }
            if silent {
                while r.phase != Phase::Silent {
                    r.next_gain();
                }
            }
            let mut gate = MeasurementGate::default();
            let mut meter = crate::audio_engine::loudness::LoudnessMeter::new(96000);
            meter.reset(gate.request(Some(77), &r));
            assert!(meter.id.is_none());
            let counts = allocation_counts(|| {
                for _ in 0..6 {
                    if let Some(id) = gate.take_ready(&r) {
                        meter.reset(Some(id));
                    }
                    let blocked = gate.blocks_recovery() || meter.id.is_some();
                    assert_eq!(r.begin_block(4096, 512, 512, blocked), 0);
                    for _ in 0..512 {
                        let gain = r.next_gain();
                        if meter.id.is_some() {
                            assert_eq!(gain, 1.0);
                            meter.sample([0.1 * gain, -0.1 * gain]);
                        }
                    }
                }
            });
            assert_eq!(counts, (0, 0));
            assert_eq!(meter.id, Some(77));
            assert_eq!(r.gain, 1.0);
        }
    }

    #[test]
    fn pending_measurement_cancel_and_replacement_keep_latest_intent() {
        let mut r = Recovery::new(4363, 96000, 1, 3);
        r.phase = Phase::Silent;
        r.gain = 0.0;
        let mut gate = MeasurementGate::default();
        assert_eq!(gate.request(Some(1), &r), None);
        assert_eq!(gate.request(Some(2), &r), None);
        assert_eq!(gate.request(None, &r), None);
        assert!(!gate.blocks_recovery());
        assert_eq!(gate.request(Some(3), &r), None);
        r.begin_block(4096, 512, 512, true);
        for _ in 0..1024 {
            r.next_gain();
        }
        assert_eq!(gate.take_ready(&r), Some(3));
        assert_eq!(gate.take_ready(&r), None);
    }

    #[test]
    fn one_recovery_then_second_pause_keeps_unity_and_reports_exhausted_without_allocating() {
        let mut r = Recovery::new(4363, 96000, 1, 3);
        let counts = allocation_counts(|| {
            let mut skips = 0;
            for _ in 0..400 {
                let skip = r.begin_block(4096, 512, 512, false);
                if skip > 0 {
                    assert_eq!(r.gain, 0.0);
                    skips += 1;
                }
                for _ in 0..512 {
                    let g = r.next_gain();
                    assert!((0.0..=1.0).contains(&g));
                }
            }
            assert_eq!(skips, 1);
            assert_eq!(r.gain, 1.0);
            assert_eq!(r.status(), 2);
        });
        assert_eq!(counts, (0, 0));
    }

    #[test]
    fn default_growth_and_blocked_measurement_never_skip_or_leave_silence() {
        let mut r = Recovery::new(2181, 48000, 1, 3);
        for _ in 0..50 {
            assert_eq!(r.begin_block(2000, 512, 512, true), 0);
            for _ in 0..512 {
                assert_eq!(r.next_gain(), 1.0);
            }
        }
        for _ in 0..10 {
            r.begin_block(2000, 512, 512, false);
        }
        for _ in 0..30 {
            r.next_gain();
        }
        assert_eq!(r.begin_block(2000, 1024, 1024, false), 0);
        for _ in 0..1024 {
            r.next_gain();
        }
        assert_eq!(r.gain, 1.0);
        assert_eq!(r.status(), 1);
        assert_eq!(Recovery::new(2181, 48000, 1, 3).gain, 1.0);
    }

    #[test]
    fn sine_impulse_and_opposite_channels_have_bounded_silent_skip_boundary() {
        for rate in [44100usize, 48000, 96000, 192000, 384000] {
            for impulse in [false, true] {
                let mut r = Recovery::new(rate, rate, 1, 3);
                let mut phase = 0usize;
                let mut previous = 0.0f32;
                let mut skipped = false;
                for _ in 0..(rate / 512) {
                    let skip = r.begin_block(4096, 512, 512, false);
                    if skip > 0 {
                        assert_eq!(r.gain, 0.0);
                        phase += skip;
                        skipped = true;
                    }
                    for _ in 0..512 {
                        let input = if impulse {
                            if phase.is_multiple_of(1000) {
                                0.1
                            } else {
                                0.0
                            }
                        } else {
                            (phase as f64 * 1000.0 * std::f64::consts::TAU / rate as f64).sin()
                                as f32
                                * 0.1
                        };
                        let sample = input * r.next_gain();
                        assert!(sample.is_finite() && sample.abs() <= 0.1);
                        let bound = if impulse {
                            0.101
                        } else {
                            0.1 * (std::f64::consts::TAU * 1000.0 / rate as f64) as f32
                                + 0.1 / r.fade_frames as f32
                                + 1e-6
                        };
                        assert!((sample - previous).abs() <= bound);
                        let channels = [sample, -sample, -sample];
                        assert_eq!(channels[0] + channels[1], 0.0);
                        previous = sample;
                        phase += 1;
                    }
                }
                assert!(skipped);
            }
        }
    }
}
