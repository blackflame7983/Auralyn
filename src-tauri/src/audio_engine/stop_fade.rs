//! 停止直前の10 msフェード。共有値はAtomicのみ、RT状態は出力ごとに所有する。
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

pub(crate) const MAIN: usize = 0;
pub(crate) const MONITOR: usize = 1;
pub(crate) const SINK: usize = 2;
const OUTPUTS: usize = 3;
const TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Default)]
pub(crate) struct StopFade {
    request: AtomicU64,
    acks: [AtomicU64; OUTPUTS],
    // mode_silenceだけは、既存の排出確認が終わった後に同じstreamを再開する。
    resumed: AtomicU64,
}

impl StopFade {
    pub(crate) fn request(&self) -> u64 {
        self.request.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub(crate) fn acknowledged(&self, roles: u8, generation: u64) -> bool {
        (0..OUTPUTS).all(|role| {
            roles & (1 << role) == 0 || self.acks[role].load(Ordering::Acquire) == generation
        })
    }

    /// 制御スレッド専用。callback停止・途中の機器故障でも有限時間で回収へ進む。
    pub(crate) fn fade_and_wait(&self, roles: u8, failed: &AtomicBool) {
        if roles == 0 || failed.load(Ordering::Acquire) {
            return;
        }
        let generation = self.request();
        let deadline = Instant::now() + TIMEOUT;
        while !self.acknowledged(roles, generation) && !failed.load(Ordering::Acquire) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            std::thread::sleep(remaining.min(Duration::from_millis(1)));
        }
    }

    pub(crate) fn resume(&self) {
        self.resumed
            .store(self.request.load(Ordering::Acquire), Ordering::Release);
    }
}

pub(crate) struct StopFadeRt {
    shared: Arc<StopFade>,
    role: usize,
    generation: u64,
    resumed: u64,
    samples: u32,
    remaining: u32,
    gain: f32,
    frames: usize,
}

impl StopFadeRt {
    pub(crate) fn new(shared: Arc<StopFade>, role: usize, rate: u32) -> Self {
        Self {
            shared,
            role,
            generation: 0,
            resumed: 0,
            samples: (rate as f64 * 0.010).round().max(1.0) as u32,
            remaining: 0,
            gain: 1.0,
            frames: 0,
        }
    }

    pub(crate) fn begin_block(&mut self) {
        self.frames = 0;
        let resumed = self.shared.resumed.load(Ordering::Acquire);
        let generation = self.shared.request.load(Ordering::Acquire);
        if resumed != self.resumed {
            self.resumed = resumed;
            self.generation = resumed;
            self.remaining = 0;
            // 再開を観測する前に次の停止が来たなら、無音から音量を戻さない。
            if generation == resumed {
                self.gain = 1.0;
            }
        }
        if generation != self.generation {
            self.generation = generation;
            // すでに無音なら新要求でも音量を戻さない。
            self.remaining = (self.gain * self.samples as f32).round() as u32;
        }
    }

    /// 左右・全チャンネルに同じ倍率を使い、1 frameにつき一度だけ進める。
    pub(crate) fn apply(&mut self, frame: [f32; 2]) -> [f32; 2] {
        self.frames += 1;
        if self.remaining > 0 {
            self.remaining -= 1;
            self.gain = self.remaining as f32 / self.samples as f32;
        }
        if self.gain == 1.0 {
            frame // 要求なしでは符号付きゼロを含めビットを変えない。
        } else if self.gain == 0.0 {
            [0.0; 2]
        } else {
            frame.map(|sample| sample * self.gain)
        }
    }

    pub(crate) fn end_block(&mut self, frames: usize) {
        // 途中returnや全体muteですでに無音を書いたframeも時間として進める。
        if self.remaining > 0 && frames > self.frames {
            self.remaining = self
                .remaining
                .saturating_sub((frames - self.frames).min(u32::MAX as usize) as u32);
            self.gain = self.remaining as f32 / self.samples as f32;
        }
        if self.generation != 0 && self.gain == 0.0 {
            self.shared.acks[self.role].store(self.generation, Ordering::Release);
        }
    }
}

/// 正弦波自体の傾きと、fadeが加える段差を分けて測る。
#[cfg(test)]
#[derive(Default)]
pub(crate) struct SignalCheck {
    previous: Option<(f32, f32)>,
    pub(crate) max_step: f32,
    pub(crate) max_excess: f32,
}
#[cfg(test)]
impl SignalCheck {
    pub(crate) fn frame(&mut self, output: [f32; 2], dry: [f32; 2], gain: f32, n: u32) {
        for ch in 0..2 {
            assert!((output[ch] - dry[ch] * gain).abs() < 2.0e-6);
        }
        if let Some((previous, previous_dry)) = self.previous {
            let step = (output[0] - previous).abs();
            let signal_step = (dry[0] - previous_dry).abs();
            self.max_step = self.max_step.max(step);
            self.max_excess = self.max_excess.max(step - signal_step);
            assert!(step <= signal_step + 0.5 / n as f32 + 2.0e-6);
        }
        self.previous = Some((output[0], dry[0]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fade481_ten_ms_monotonic_exact_zero_and_block_end_ack_without_allocations() {
        for rate in [0, 1, 8_000, 44_100, 48_000, 96_000, 192_000] {
            let shared = Arc::new(StopFade::default());
            let mut rt = StopFadeRt::new(shared.clone(), MAIN, rate);
            let generation = shared.request();
            let n = rt.samples;
            let mut previous = 1.0;
            let mut worst = 0.0f32;
            assert_eq!(
                crate::dsp_verification_allocator::allocation_counts(|| {
                    rt.begin_block();
                    for _ in 0..n - 1 {
                        let [gain, right] = rt.apply([1.0; 2]);
                        assert_eq!(gain, right);
                        assert!(gain <= previous && gain > 0.0);
                        let step = previous - gain;
                        assert!(step <= 1.0 / n as f32 + f32::EPSILON);
                        worst = worst.max(step);
                        previous = gain;
                    }
                    rt.end_block((n - 1) as usize);
                    assert!(!shared.acknowledged(1 << MAIN, generation));
                    rt.begin_block();
                    assert_eq!(rt.apply([1.0; 2]), [0.0; 2]);
                    assert!(previous <= 1.0 / n as f32 + f32::EPSILON);
                    worst = worst.max(previous);
                    assert!(!shared.acknowledged(1 << MAIN, generation));
                    for _ in 0..128 {
                        assert_eq!(rt.apply([1.0; 2]), [0.0; 2]);
                    }
                    rt.end_block(129);
                    assert!(shared.acknowledged(1 << MAIN, generation));
                    assert!(!shared.acknowledged(1 << SINK, generation));
                }),
                (0, 0)
            );
            eprintln!("fade481 gain {rate} Hz: n={n}, max_step={worst:.9}");
        }
    }

    #[test]
    fn fade481_no_request_is_bit_identical_and_silent_blocks_can_ack() {
        let shared = Arc::new(StopFade::default());
        let mut rt = StopFadeRt::new(shared.clone(), MAIN, 48_000);
        for bits in [0, 0x8000_0000, 0x3f12_3456, 0x7fc0_0001, 0x7f80_0000] {
            rt.begin_block();
            let input = [f32::from_bits(bits); 2];
            assert_eq!(rt.apply(input).map(f32::to_bits), input.map(f32::to_bits));
            rt.end_block(1);
        }
        let generation = shared.request();
        rt.begin_block();
        rt.end_block(480);
        assert!(shared.acknowledged(1 << MAIN, generation));
        let generation = shared.request();
        rt.begin_block();
        assert_eq!(rt.apply([1.0; 2]), [0.0; 2]);
        rt.end_block(1);
        assert!(shared.acknowledged(1 << MAIN, generation));
        shared.resume();
        rt.begin_block();
        assert_eq!(rt.apply([-0.5, 0.5]), [-0.5, 0.5]);
        shared.request();
        rt.begin_block();
        assert!(rt.apply([1.0; 2])[0] < 1.0);
        rt.end_block(480);
        shared.resume();
        shared.request();
        rt.begin_block();
        assert_eq!(rt.apply([1.0; 2]), [0.0; 2]);
    }

    #[test]
    fn fade481_control_timeout_failure_and_inactive_roles_are_bounded() {
        let shared = StopFade::default();
        let failed = AtomicBool::new(false);
        let start = Instant::now();
        shared.fade_and_wait(1 << SINK, &failed);
        let elapsed = start.elapsed();
        assert!(
            elapsed >= TIMEOUT && elapsed < Duration::from_millis(500),
            "{elapsed:?}"
        );
        assert!(!shared.acknowledged(1 << SINK, 1));
        eprintln!("fade481 no callback timeout: {elapsed:?}");
        failed.store(true, Ordering::Release);
        let start = Instant::now();
        shared.fade_and_wait(0b111, &failed);
        assert!(start.elapsed() < Duration::from_millis(50));
        assert_eq!(shared.request.load(Ordering::Acquire), 1);
        failed.store(false, Ordering::Release);
        shared.fade_and_wait(0, &failed);
        assert_eq!(shared.request.load(Ordering::Acquire), 1);
    }

    #[test]
    fn fade481_control_waits_only_selected_outputs_and_interrupts_on_failure() {
        let shared = Arc::new(StopFade::default());
        let failed = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut main = StopFadeRt::new(shared.clone(), MAIN, 48000);
                let mut sink = StopFadeRt::new(shared.clone(), SINK, 48000);
                while shared.request.load(Ordering::Acquire) == 0 {
                    std::thread::yield_now();
                }
                for rt in [&mut main, &mut sink] {
                    rt.begin_block();
                    for _ in 0..480 {
                        rt.apply([0.5; 2]);
                    }
                    rt.end_block(480);
                }
            });
            shared.fade_and_wait((1 << MAIN) | (1 << SINK), &failed);
        });
        assert!(shared.acknowledged((1 << MAIN) | (1 << SINK), 1));
        assert!(!shared.acknowledged(1 << MONITOR, 1));
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while shared.request.load(Ordering::Acquire) != 2 {
                    std::thread::yield_now();
                }
                failed.store(true, Ordering::Release);
            });
            shared.fade_and_wait(1 << MAIN, &failed);
        });
        assert!(!shared.acknowledged(1 << MAIN, 2));
    }
}
