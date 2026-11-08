//! 独立クロック間のSRC。通常の速度差追従と、欠落・満杯の失敗を分ける。
use anyhow::{ensure, Result};
use ringbuf::traits::Consumer;
use rubato::{
    Resampler, SincFixedOut, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

const BLOCK: usize = 256;
pub const TARGET: usize = 2048;
pub const CAPACITY: usize = 16_384;
const LIMIT: f64 = 0.002;
/// 最後の packet からこれ以上空いた underrun は、queue を捨てて再 priming する。
const STALE_PACKET_MS: u64 = 30;
/// packet が新しいまま underrun がこれ以上続けば失敗にし、無音で埋め続けない。
const FRESH_UNDERRUN_FAIL_MS: u64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UnderrunAction {
    /// まだ待っている。queue は捨てず、失敗にもしない。
    Wait,
    /// 古い packet を捨て、resampler を初期化してから新しい音を待つ。
    DiscardAndReprime,
    /// 新しい packet があるのに埋まらない。失敗として止める。
    Fail,
}

/// starved の経過と、最後の packet からの経過だけで次の動作を決める。
/// 両方を満たすときは破棄を優先する。時刻の値そのものは見ない。
#[must_use]
pub(crate) fn underrun_action(packet_age_ms: u64, starved_for_ms: u64) -> UnderrunAction {
    if packet_age_ms >= STALE_PACKET_MS {
        UnderrunAction::DiscardAndReprime
    } else if starved_for_ms >= FRESH_UNDERRUN_FAIL_MS {
        UnderrunAction::Fail
    } else {
        UnderrunAction::Wait
    }
}

pub trait FrameQueue {
    fn frames(&self) -> usize;
    fn pop_frame(&mut self) -> Option<[f32; 2]>;
    fn discard(&mut self) -> usize;
}

#[cfg(test)]
struct Stereo<'a, C>(&'a mut C);
#[cfg(test)]
impl<C: Consumer<Item = [f32; 2]>> FrameQueue for Stereo<'_, C> {
    fn frames(&self) -> usize {
        self.0.occupied_len()
    }
    fn pop_frame(&mut self) -> Option<[f32; 2]> {
        self.0.try_pop()
    }
    fn discard(&mut self) -> usize {
        self.0.skip(self.0.occupied_len())
    }
}

pub struct Interleaved<'a, C>(pub &'a mut C);
impl<C: Consumer<Item = f32>> FrameQueue for Interleaved<'_, C> {
    fn frames(&self) -> usize {
        self.0.occupied_len() / 2
    }
    fn pop_frame(&mut self) -> Option<[f32; 2]> {
        if self.frames() == 0 {
            return None;
        }
        Some([self.0.try_pop()?, self.0.try_pop()?])
    }
    fn discard(&mut self) -> usize {
        self.0.skip(self.frames() * 2) / 2
    }
}

/// 全チャンネルを一度だけ消費し、選んだ組だけを独立クロックのSRCへ渡す。
pub struct MappedInterleaved<'a, C> {
    pub queue: &'a mut C,
    pub channels: usize,
    pub selected: [usize; 2],
}
impl<C: Consumer<Item = f32>> FrameQueue for MappedInterleaved<'_, C> {
    fn frames(&self) -> usize {
        self.queue.occupied_len() / self.channels.max(1)
    }
    fn pop_frame(&mut self) -> Option<[f32; 2]> {
        if self.channels == 0 || self.frames() == 0 {
            return None;
        }
        let mut pair = [0.0; 2];
        for channel in 0..self.channels {
            let value = self.queue.try_pop()?;
            for (slot, selected) in self.selected.iter().enumerate() {
                if channel == *selected {
                    pair[slot] = value;
                }
            }
        }
        Some(pair)
    }
    fn discard(&mut self) -> usize {
        let samples = self.frames() * self.channels;
        self.queue.skip(samples) / self.channels.max(1)
    }
}

#[cfg(test)]
fn correction(queued: usize) -> f64 {
    correction_at(queued, TARGET)
}

fn correction_at(queued: usize, target: usize) -> f64 {
    let error = (queued as f64 - target as f64) / TARGET as f64;
    -(error * 0.004).clamp(-LIMIT, LIMIT)
}

// 1 callback全体とSRCの先読みを満たす。実行中の確保は行わない。
fn callback_target(input_rate: u32, output_rate: u32, frames: usize) -> usize {
    let output = frames.div_ceil(BLOCK) * BLOCK;
    TARGET
        + (output as f64 * f64::from(input_rate) / f64::from(output_rate) / (1.0 - LIMIT)).ceil()
            as usize
        + 260
}

pub fn queue_capacity(input_rate: u32, output_rate: u32, max_frames: usize) -> Result<usize> {
    ensure!(
        (8000..=192000).contains(&input_rate),
        "入力のrateが範囲外です"
    );
    ensure!(
        (8000..=192000).contains(&output_rate),
        "返しのrateが範囲外です"
    );
    ensure!(
        (1..=65_536).contains(&max_frames),
        "出力の処理単位が範囲外です"
    );
    // 初回の蓄積が入力packet単位で閾値を越えても保持できる余裕を取る。
    Ok(CAPACITY.max(2 * callback_target(input_rate, output_rate, max_frames) + BLOCK))
}

pub struct Renderer {
    input_rate: u32,
    output_rate: u32,
    capacity: usize,
    resampler: SincFixedOut<f32>,
    input: Vec<Vec<f32>>,
    output: Vec<Vec<f32>>,
    cursor: usize,
    primed: bool,
    pub failed: bool,
    pub failed_underrun: bool,
    pub underruns: u64,
    pub rendered: u64,
    pub waiting: u64,
    pub max_queued: usize,
    pub correction_ppm: f64,
}

impl Renderer {
    pub fn wait_for_audio(&mut self) {
        self.resampler.reset();
        self.cursor = BLOCK;
        self.primed = false;
        self.failed = false;
        self.failed_underrun = false;
    }
    #[cfg(test)]
    pub fn new(output_rate: u32) -> Result<Self> {
        Self::with_rates(48000, output_rate)
    }

    // 二入力では、機器から届くrateを保持したまま出力の時計へ追従する。
    #[cfg(test)]
    pub fn with_rates(input_rate: u32, output_rate: u32) -> Result<Self> {
        Self::with_rates_and_capacity(input_rate, output_rate, CAPACITY)
    }

    pub fn with_rates_and_capacity(
        input_rate: u32,
        output_rate: u32,
        capacity: usize,
    ) -> Result<Self> {
        ensure!(capacity >= CAPACITY, "入力キューの容量が不足しています");
        ensure!(
            (8000..=192000).contains(&input_rate),
            "入力のrateが範囲外です"
        );
        ensure!(
            (8000..=192000).contains(&output_rate),
            "返しのrateが範囲外です"
        );
        let resampler = SincFixedOut::<f32>::new(
            f64::from(output_rate) / f64::from(input_rate),
            1.01,
            SincInterpolationParameters {
                sinc_len: 128,
                f_cutoff: 0.94,
                interpolation: SincInterpolationType::Cubic,
                oversampling_factor: 128,
                window: WindowFunction::BlackmanHarris2,
            },
            BLOCK,
            2,
        )?;
        // 固定版rubatoのinput_frames_maxは低い出力rateで過小になるため、
        // 比率の逆数とFIR履歴を含む保守的な容量を開始時に確保する。
        let max_input =
            ((BLOCK as f64 * f64::from(input_rate) / f64::from(output_rate) / (1.0 - LIMIT)).ceil()
                as usize
                + 260)
                .max(resampler.input_frames_max());
        let input = vec![vec![0.0; max_input]; 2];
        let output = resampler.output_buffer_allocate(true);
        Ok(Self {
            input_rate,
            output_rate,
            capacity,
            resampler,
            input,
            output,
            cursor: BLOCK,
            primed: false,
            failed: false,
            failed_underrun: false,
            underruns: 0,
            rendered: 0,
            waiting: 0,
            max_queued: 0,
            correction_ppm: 0.0,
        })
    }

    pub fn render(&mut self, samples: &mut [f32], rx: &mut impl FrameQueue) {
        samples.fill(0.0);
        if self.failed {
            return;
        }
        self.max_queued = self.max_queued.max(rx.frames());
        let frames = samples.len() / 2;
        if frames == 0 {
            return;
        }
        let target = callback_target(self.input_rate, self.output_rate, frames);
        if target >= self.capacity - BLOCK || rx.frames() >= self.capacity - BLOCK {
            self.failed = true;
            return;
        }
        if !self.primed {
            if rx.frames() < target {
                self.waiting += frames as u64;
                return;
            }
            self.primed = true;
        }
        // callback内の消費によるキューの減少をクロック差と誤認しない。
        let ratio = 1.0 + correction_at(rx.frames(), target);
        self.correction_ppm = (ratio - 1.0) * 1_000_000.0;
        if self
            .resampler
            .set_resample_ratio_relative(ratio, true)
            .is_err()
        {
            self.failed = true;
            return;
        }
        for frame in samples.as_chunks_mut::<2>().0 {
            if self.cursor == BLOCK {
                let needed = self.resampler.input_frames_next();
                if needed > self.input[0].len() || rx.frames() < needed {
                    // 無期限の旧音再生や、破棄を繰り返して速度差を隠す回復はしない。
                    self.failed_underrun = true;
                    self.underruns += 1;
                    self.failed = true;
                    return;
                }
                for index in 0..needed {
                    let Some(input) = rx.pop_frame() else {
                        self.failed = true;
                        return;
                    };
                    self.input[0][index] = input[0];
                    self.input[1][index] = input[1];
                }
                if self
                    .resampler
                    .process_into_buffer(&self.input, &mut self.output, None)
                    .is_err()
                {
                    self.failed = true;
                    return;
                }
                self.cursor = 0;
            }
            frame[0] = self.output[0][self.cursor];
            frame[1] = self.output[1][self.cursor];
            if !frame[0].is_finite() || !frame[1].is_finite() {
                frame.fill(0.0);
                self.failed = true;
                return;
            }
            self.cursor += 1;
            self.rendered += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;
    use ringbuf::{
        traits::{Observer, Producer, Split},
        HeapRb,
    };

    fn correction_span() -> usize {
        (LIMIT / 0.004 * TARGET as f64).round() as usize
    }

    fn assert_depth_after_render(queued: usize, setpoint: usize, ppm: f64) {
        let span = correction_span();
        // render 直後なので、飽和幅から 1 block だけ下へずれた値も範囲に含める。
        assert!(
            queued + span + BLOCK >= setpoint && queued <= setpoint + span,
            "ppm={ppm}, queued={queued}, setpoint={setpoint}, span={span}"
        );
    }

    fn push_fractional(
        tx: &mut impl Producer<Item = [f32; 2]>,
        fraction: &mut f64,
        frames: f64,
        sample: [f32; 2],
    ) {
        *fraction += frames;
        let incoming = *fraction as usize;
        *fraction -= incoming as f64;
        for _ in 0..incoming {
            tx.try_push(sample).unwrap();
        }
    }

    #[test]
    fn signed_clock_offsets_stay_bounded_and_limits_are_explicit() {
        for ppm in [-1500.0, -500.0, 0.0, 500.0, 1500.0] {
            let mut queued = TARGET as f64;
            for _ in 0..360_000 {
                queued +=
                    480.0 * (1.0 + ppm / 1_000_000.0) - 480.0 / (1.0 + correction(queued as usize));
                assert!(
                    (1024.0..4096.0).contains(&queued),
                    "ppm={ppm}, queued={queued}"
                );
            }
        }
        assert_eq!(correction(0), LIMIT);
        assert_eq!(correction(CAPACITY), -LIMIT);
    }

    #[test]
    fn pause_and_resume_clear_old_audio_without_rt_allocation() {
        let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
        let mut renderer = Renderer::new(48000).unwrap();
        let mut output = [0.0; BLOCK * 2];
        for _ in 0..TARGET + 1024 {
            tx.try_push([0.2, -0.2]).unwrap();
        }
        renderer.render(&mut output, &mut Stereo(&mut rx));
        while rx.try_pop().is_some() {}
        renderer.render(&mut output, &mut Stereo(&mut rx));
        assert!(renderer.failed && renderer.failed_underrun);
        let counts = crate::vst_host::instance::allocation_counts(|| {
            renderer.wait_for_audio();
            renderer.render(&mut output, &mut Stereo(&mut rx));
        });
        assert_eq!(counts, (0, 0));
        assert!(!renderer.failed);
        assert_eq!(output, [0.0; BLOCK * 2]);
        for _ in 0..TARGET + 1024 {
            tx.try_push([-0.1, 0.1]).unwrap();
        }
        renderer.render(&mut output, &mut Stereo(&mut rx));
        assert!(!renderer.failed);
        assert!(output
            .as_chunks::<2>()
            .0
            .iter()
            .any(|f| f[0] < -0.09 && f[1] > 0.09));
        while tx.vacant_len() > 0 {
            tx.try_push([0.0; 2]).unwrap();
        }
        let counts = crate::vst_host::instance::allocation_counts(|| {
            renderer.render(&mut output, &mut Stereo(&mut rx))
        });
        assert_eq!(counts, (0, 0));
        assert!(renderer.failed && !renderer.failed_underrun);
        assert_eq!(output, [0.0; BLOCK * 2]);
    }

    #[test]
    fn actual_src_consumption_tracks_both_clock_directions_without_frame_drops() {
        for rate in [44100, 48000, 96000] {
            for ppm in [-1500.0, 1500.0] {
                let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
                let mut renderer = Renderer::new(rate).unwrap();
                let mut output = [0.0; BLOCK * 2];
                for _ in 0..TARGET {
                    tx.try_push([0.1, -0.1]).unwrap();
                }
                let mut fraction = 0.0;
                for _ in 0..6000 {
                    fraction +=
                        BLOCK as f64 * 48000.0 / f64::from(rate) * (1.0 + ppm / 1_000_000.0);
                    let incoming = fraction as usize;
                    fraction -= incoming as f64;
                    for _ in 0..incoming {
                        tx.try_push([0.1, -0.1]).unwrap();
                    }
                    renderer.render(&mut output, &mut Stereo(&mut rx));
                    assert!(!renderer.failed, "rate={rate}, ppm={ppm}");
                    assert!(rx.occupied_len() < 4096);
                    assert!(output.iter().all(|s| s.is_finite() && s.abs() < 0.12));
                }
                assert_eq!(renderer.underruns, 0);
            }
        }
    }

    #[test]
    fn mapped_queue_consumes_whole_frames_and_duplicates_only_the_selected_channel() {
        let (mut tx, mut rx) = HeapRb::<f32>::new(32).split();
        for value in [1.0, 2.0, 3.0, 4.0, 11.0, 12.0, 13.0, 14.0, 99.0] {
            tx.try_push(value).unwrap();
        }
        let mut queue = MappedInterleaved {
            queue: &mut rx,
            channels: 4,
            selected: [2, 2],
        };
        assert_eq!(queue.pop_frame(), Some([3.0, 3.0]));
        queue.selected = [3, 0];
        assert_eq!(queue.pop_frame(), Some([14.0, 11.0]));
        assert_eq!(queue.pop_frame(), None);
        assert_eq!(rx.occupied_len(), 1);
    }

    #[test]
    fn independent_device_rates_follow_both_clock_directions_without_allocating() {
        assert!(Renderer::with_rates(0, 48000).is_err());
        assert!(Renderer::with_rates(48000, 192001).is_err());
        for (input_rate, output_rate) in [(44100, 48000), (48000, 44100), (96000, 48000)] {
            for ppm in [-1200.0, 1200.0] {
                let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
                let mut renderer = Renderer::with_rates(input_rate, output_rate).unwrap();
                let mut output = [0.0; BLOCK * 2];
                for _ in 0..TARGET {
                    tx.try_push([0.125, -0.125]).unwrap();
                }
                let mut fraction = 0.0;
                for _ in 0..3000 {
                    fraction += BLOCK as f64 * f64::from(input_rate) / f64::from(output_rate)
                        * (1.0 + ppm / 1_000_000.0);
                    let incoming = fraction as usize;
                    fraction -= incoming as f64;
                    for _ in 0..incoming {
                        tx.try_push([0.125, -0.125]).unwrap();
                    }
                    let counts = crate::vst_host::instance::allocation_counts(|| {
                        renderer.render(&mut output, &mut Stereo(&mut rx));
                    });
                    assert_eq!(counts, (0, 0));
                    assert!(!renderer.failed, "{input_rate}/{output_rate}, {ppm} ppm");
                    assert!(rx.occupied_len() < 4096);
                    assert!(output.as_chunks::<2>().0.iter().all(|frame| {
                        frame[0].is_finite() && (frame[0] + frame[1]).abs() < 0.00001
                    }));
                }
                assert_eq!(renderer.underruns, 0);
            }
        }
    }

    #[test]
    fn variable_ratio_src_and_failure_are_allocation_free_and_keep_stereo_order() {
        for rate in [44100, 48000, 96000] {
            let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
            let mut renderer = Renderer::new(rate).unwrap();
            let mut output = [0.0; 512];
            for _ in 0..TARGET + 1024 {
                tx.try_push([0.25, -0.25]).unwrap();
            }
            let counts = crate::vst_host::instance::allocation_counts(|| {
                renderer.render(&mut output, &mut Stereo(&mut rx))
            });
            assert_eq!(counts, (0, 0));
            assert!(!renderer.failed);
            assert!(output
                .as_chunks::<2>()
                .0
                .iter()
                .all(|f| (f[0] + f[1]).abs() < 1e-5));
            assert!(output.iter().any(|x| x.abs() > 0.2));
            while rx.try_pop().is_some() {}
            let counts = crate::vst_host::instance::allocation_counts(|| {
                renderer.render(&mut output, &mut Stereo(&mut rx))
            });
            assert_eq!(counts, (0, 0));
            assert!(renderer.failed);
            renderer.render(&mut output, &mut Stereo(&mut rx));
            assert_eq!(output, [0.0; 512]);
        }
    }

    #[test]
    fn underrun_action_discards_from_30ms_and_fails_a_fresh_gap_at_100ms() {
        assert_eq!(underrun_action(0, 0), UnderrunAction::Wait);
        assert_eq!(underrun_action(29, 99), UnderrunAction::Wait);
        assert_eq!(underrun_action(30, 0), UnderrunAction::DiscardAndReprime);
        assert_eq!(underrun_action(30, 100), UnderrunAction::DiscardAndReprime);
        assert_eq!(underrun_action(29, 100), UnderrunAction::Fail);
        assert_eq!(correction_span(), 1024);
    }

    #[test]
    fn stale_resume_discards_the_queued_impulse_and_depth_stays_inside_the_correction_band() {
        let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
        let mut renderer = Renderer::new(48_000).unwrap();
        let mut output = [0.0; BLOCK * 2];
        let setpoint = callback_target(48_000, 48_000, BLOCK);
        let mut fraction = 0.0;
        for _ in 0..setpoint {
            tx.try_push([0.55, -0.55]).unwrap();
        }
        let mut saw_old = false;
        for _ in 0..4 {
            push_fractional(&mut tx, &mut fraction, BLOCK as f64, [0.55, -0.55]);
            renderer.render(&mut output, &mut Stereo(&mut rx));
            assert!(!renderer.failed);
            if output.iter().any(|sample| *sample > 0.4) {
                saw_old = true;
                break;
            }
        }
        assert!(saw_old, "再開前に古い振幅へ入っていること");
        let queued_before = rx.occupied_len();
        tx.try_push([0.85, -0.85]).unwrap();
        for _ in 0..64 {
            tx.try_push([0.55, -0.55]).unwrap();
        }
        let stale = queued_before + 65;
        assert_eq!(rx.occupied_len(), stale);
        let counts = allocation_counts(|| {
            assert_eq!(Stereo(&mut rx).discard(), stale);
            renderer.wait_for_audio();
            assert_eq!(rx.occupied_len(), 0);
            for _ in 0..setpoint {
                tx.try_push([-0.2, -0.2]).unwrap();
            }
            renderer.render(&mut output, &mut Stereo(&mut rx));
        });
        assert_eq!(counts, (0, 0));
        assert!(!renderer.failed && !renderer.failed_underrun);
        assert!(
            output
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() < 0.35),
            "古い 0.55 が再 priming 後に残った"
        );
        // 制御が無いと +1500ppm は 4000 callback で約 1536 frame 溜まり、±1024 を超える。
        for ppm in [1_500.0, -1_500.0] {
            fraction = 0.0;
            for _ in 0..4000 {
                push_fractional(
                    &mut tx,
                    &mut fraction,
                    BLOCK as f64 * (1.0 + ppm / 1_000_000.0),
                    [-0.2, -0.2],
                );
                renderer.render(&mut output, &mut Stereo(&mut rx));
                assert!(!renderer.failed, "ppm={ppm}");
                assert!(renderer.correction_ppm.abs() <= LIMIT * 1_000_000.0 + 1e-3);
                assert_depth_after_render(rx.occupied_len(), setpoint, ppm);
                assert!(output
                    .iter()
                    .all(|sample| sample.is_finite() && sample.abs() < 0.35));
            }
            assert_eq!(renderer.underruns, 0);
            assert!(output.iter().any(|sample| *sample < -0.1));
        }
    }

    #[test]
    fn consumer_pause_below_overfull_returns_depth_inside_the_correction_band() {
        let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
        let mut renderer = Renderer::new(48_000).unwrap();
        let mut output = [0.0; BLOCK * 2];
        let setpoint = callback_target(48_000, 48_000, BLOCK);
        for _ in 0..setpoint {
            tx.try_push([0.1, -0.1]).unwrap();
        }
        renderer.render(&mut output, &mut Stereo(&mut rx));
        assert!(!renderer.failed);
        let extra = 1_500;
        for _ in 0..extra {
            tx.try_push([0.1, -0.1]).unwrap();
        }
        let paused = rx.occupied_len();
        assert!(paused > setpoint + correction_span());
        assert!(paused < CAPACITY - BLOCK);
        let net_drain = BLOCK as f64 * (1.0 / (1.0 - LIMIT) - 1.0);
        let shed = (paused - setpoint) as f64;
        let limit_callbacks = (shed / net_drain).ceil() as usize + BLOCK;
        let mut fraction = 0.0;
        let mut entered = None;
        let counts = allocation_counts(|| {
            for step in 0..limit_callbacks {
                push_fractional(&mut tx, &mut fraction, BLOCK as f64, [0.1, -0.1]);
                renderer.render(&mut output, &mut Stereo(&mut rx));
                assert!(!renderer.failed);
                assert!(rx.occupied_len() < CAPACITY - BLOCK);
                if rx.occupied_len() + correction_span() + BLOCK >= setpoint
                    && rx.occupied_len() <= setpoint + correction_span()
                {
                    entered = Some(step);
                    break;
                }
            }
        });
        assert_eq!(counts, (0, 0));
        let entered = entered.expect("停止中の滞留が補正の範囲へ戻らない");
        for _ in 0..200 {
            push_fractional(&mut tx, &mut fraction, BLOCK as f64, [0.1, -0.1]);
            renderer.render(&mut output, &mut Stereo(&mut rx));
            assert!(!renderer.failed);
            assert_depth_after_render(rx.occupied_len(), setpoint, 0.0);
        }
        assert!(entered < limit_callbacks);
        assert_eq!(renderer.underruns, 0);
        assert!(output.iter().all(|sample| sample.is_finite()));
    }

    #[test]
    fn packet_burst_overfull_fails_and_stays_silent() {
        let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
        let mut renderer = Renderer::new(48_000).unwrap();
        let mut output = [0.0; BLOCK * 2];
        let setpoint = callback_target(48_000, 48_000, BLOCK);
        for _ in 0..setpoint {
            tx.try_push([0.1, -0.1]).unwrap();
        }
        renderer.render(&mut output, &mut Stereo(&mut rx));
        assert!(!renderer.failed);
        while rx.occupied_len() < CAPACITY - BLOCK {
            tx.try_push([0.9, -0.9]).unwrap();
        }
        let counts = allocation_counts(|| {
            renderer.render(&mut output, &mut Stereo(&mut rx));
        });
        assert_eq!(counts, (0, 0));
        assert!(renderer.failed && !renderer.failed_underrun);
        assert_eq!(renderer.underruns, 0);
        assert_eq!(output, [0.0; BLOCK * 2]);
        while rx.occupied_len() > setpoint {
            rx.try_pop().unwrap();
        }
        let counts = allocation_counts(|| {
            renderer.render(&mut output, &mut Stereo(&mut rx));
        });
        assert_eq!(counts, (0, 0));
        assert!(renderer.failed && !renderer.failed_underrun);
        assert_eq!(output, [0.0; BLOCK * 2]);
    }

    #[test]
    fn new_renderer_after_rate_change_does_not_keep_the_previous_signal() {
        let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
        let mut old = Renderer::new(48_000).unwrap();
        let mut output = [0.0; BLOCK * 2];
        for _ in 0..callback_target(48_000, 48_000, BLOCK) {
            tx.try_push([0.4, -0.4]).unwrap();
        }
        old.render(&mut output, &mut Stereo(&mut rx));
        assert!(old.rendered > 0);
        while rx.try_pop().is_some() {}
        old.render(&mut output, &mut Stereo(&mut rx));
        assert!(old.failed && old.failed_underrun);

        let (mut fresh_tx, mut fresh_rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
        let mut fresh = Renderer::with_rates(44_100, 48_000).unwrap();
        assert!(!fresh.failed && !fresh.failed_underrun);
        assert_eq!(fresh.rendered, 0);
        assert_eq!(fresh.underruns, 0);
        let counts = allocation_counts(|| {
            fresh.render(&mut output, &mut Stereo(&mut fresh_rx));
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(output, [0.0; BLOCK * 2]);
        assert!(!fresh.failed);
        assert!(old.failed);
        let primed = callback_target(44_100, 48_000, BLOCK);
        for _ in 0..primed {
            fresh_tx.try_push([-0.15, -0.15]).unwrap();
        }
        let counts = allocation_counts(|| {
            fresh.render(&mut output, &mut Stereo(&mut fresh_rx));
        });
        assert_eq!(counts, (0, 0));
        assert!(!fresh.failed, "queued={}", fresh_rx.occupied_len());
        assert!(fresh.rendered > 0);
        assert!(output
            .iter()
            .all(|sample| sample.is_finite() && *sample < 0.2));
        assert!(output.iter().any(|sample| *sample < -0.05));
    }
}

#[cfg(test)]
mod callback_size_tests {
    use super::*;
    use ringbuf::{
        traits::{Observer, Producer, Split},
        HeapRb,
    };

    #[test]
    fn priming_waits_for_the_whole_callback_and_real_depletion_still_fails() {
        for (input, output, frames) in [
            (192000, 16000, 256),
            (48000, 48000, 4096),
            (48000, 48000, 8192),
        ] {
            let capacity = queue_capacity(input, output, frames).unwrap();
            let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(capacity).split();
            let mut renderer = Renderer::with_rates_and_capacity(input, output, capacity).unwrap();
            let mut data = vec![0.0; frames * 2];
            for _ in 0..TARGET {
                tx.try_push([0.1, -0.1]).unwrap();
            }
            let counts = crate::vst_host::instance::allocation_counts(|| {
                renderer.render(&mut data, &mut Stereo(&mut rx))
            });
            assert_eq!(counts, (0, 0));
            assert!(!renderer.failed && !renderer.failed_underrun);
            assert_eq!(renderer.rendered, 0);
            assert!(data.iter().all(|value| *value == 0.0));
            while rx.occupied_len() < callback_target(input, output, frames) {
                tx.try_push([0.1, -0.1]).unwrap();
            }
            let counts = crate::vst_host::instance::allocation_counts(|| {
                renderer.render(&mut data, &mut Stereo(&mut rx))
            });
            assert_eq!(counts, (0, 0));
            assert!(!renderer.failed, "{input}/{output}, {frames}");
            assert_eq!(renderer.rendered, frames as u64);
            while rx.try_pop().is_some() {}
            renderer.render(&mut data, &mut Stereo(&mut rx));
            assert!(renderer.failed && renderer.failed_underrun);
            renderer.wait_for_audio();
            renderer.render(&mut data, &mut Stereo(&mut rx));
            assert!(!renderer.failed);
        }
    }

    #[test]
    fn large_callbacks_follow_clock_drift_without_sawtooth_correction_or_allocation() {
        for ppm in [-1500.0, 1500.0] {
            let frames = 8192;
            let capacity = queue_capacity(48000, 48000, frames).unwrap();
            let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(capacity).split();
            let mut renderer = Renderer::with_rates_and_capacity(48000, 48000, capacity).unwrap();
            let mut data = vec![0.0; frames * 2];
            for _ in 0..callback_target(48000, 48000, frames) {
                tx.try_push([0.1, -0.1]).unwrap();
            }
            renderer.render(&mut data, &mut Stereo(&mut rx));
            let mut fraction = 0.0;
            for _ in 0..256 {
                fraction += frames as f64 * (1.0 + ppm / 1_000_000.0);
                let incoming = fraction as usize;
                fraction -= incoming as f64;
                for _ in 0..incoming {
                    tx.try_push([0.1, -0.1]).unwrap();
                }
                let counts = crate::vst_host::instance::allocation_counts(|| {
                    renderer.render(&mut data, &mut Stereo(&mut rx))
                });
                assert_eq!(counts, (0, 0));
                assert!(!renderer.failed, "{ppm}");
                assert!(data.iter().all(|value| value.is_finite()));
            }
            assert_eq!(renderer.underruns, 0);
        }
    }

    #[test]
    fn maximum_callback_capacity_is_reserved_before_rendering() {
        assert!(queue_capacity(192000, 8000, 0).is_err());
        assert!(queue_capacity(192000, 8000, 65_537).is_err());
        let frames = 65_536;
        let capacity = queue_capacity(192000, 8000, frames).unwrap();
        assert!(capacity > callback_target(192000, 8000, frames) + BLOCK);
        assert!(capacity > CAPACITY);
        let mut renderer = Renderer::with_rates_and_capacity(192000, 8000, capacity).unwrap();
        let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(capacity).split();
        for _ in 0..callback_target(192000, 8000, frames) {
            tx.try_push([0.1, -0.1]).unwrap();
        }
        let mut data = vec![0.0; frames * 2];
        let counts = crate::vst_host::instance::allocation_counts(|| {
            renderer.render(&mut data, &mut Stereo(&mut rx))
        });
        assert_eq!(counts, (0, 0));
        assert!(!renderer.failed);
        assert_eq!(renderer.rendered, frames as u64);
    }
}
