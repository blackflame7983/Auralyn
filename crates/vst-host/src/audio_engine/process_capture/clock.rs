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
// 窓の底の丸め・callback到着順の余裕。SRCの消費単位（BLOCK）とは別に取る。
const RESUME_MARGIN: usize = 32;
const RESUME_WINDOW_MS: usize = 40;

fn correction_span() -> usize {
    (LIMIT / 0.004 * TARGET as f64).round() as usize
}
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
/// starved の経過は破棄しない場合だけ読む（RT の時計読取り回数を切り出し前と同じに保つ）。
#[must_use]
pub(crate) fn underrun_action(
    packet_age_ms: u64,
    starved_for_ms: impl FnOnce() -> u64,
) -> UnderrunAction {
    if packet_age_ms >= STALE_PACKET_MS {
        UnderrunAction::DiscardAndReprime
    } else if starved_for_ms() >= FRESH_UNDERRUN_FAIL_MS {
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

// 下げる変換では、sincの長さが入力のsample数で数えられ、遷移帯域が比率の分だけ広がる。
// 出力rateで見た長さを一定に保つため、比率（最大4）に合わせて伸ばす（#486）。
fn sinc_len(input_rate: u32, output_rate: u32) -> usize {
    // 48→44.1kHz のような小さな比は従来の長さのまま、整数比に近い下げだけを伸ばす。
    let ratio = (f64::from(input_rate) / f64::from(output_rate))
        .round()
        .clamp(1.0, 4.0) as usize;
    128 * ratio
}

// SRCが保持する前後の履歴。sincの長さの両側と、補間の余裕。
fn src_history(input_rate: u32, output_rate: u32) -> usize {
    2 * sinc_len(input_rate, output_rate) + 4
}

// 1 callback全体とSRCの先読みを満たす。実行中の確保は行わない。
fn callback_target(input_rate: u32, output_rate: u32, frames: usize) -> usize {
    let output = frames.div_ceil(BLOCK) * BLOCK;
    TARGET
        + (output as f64 * f64::from(input_rate) / f64::from(output_rate) / (1.0 - LIMIT)).ceil()
            as usize
        + src_history(input_rate, output_rate)
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
    previous_floor: Option<usize>,
    window_floor: usize,
    window_frames: usize,
    fade_out: usize,
    fade_out_gain: f32,
    fade_in: usize,
    resume_resets: u64,
    resume_discarded: u64,
    pending_resume: Option<usize>,
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
        self.previous_floor = None;
        self.window_floor = usize::MAX;
        self.window_frames = 0;
        self.fade_out = 0;
        self.fade_in = 0;
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
                sinc_len: sinc_len(input_rate, output_rate),
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
                + src_history(input_rate, output_rate))
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
            previous_floor: None,
            window_floor: usize::MAX,
            window_frames: 0,
            fade_out: 0,
            fade_out_gain: 1.0,
            fade_in: 0,
            resume_resets: 0,
            resume_discarded: 0,
            pending_resume: None,
            failed: false,
            failed_underrun: false,
            underruns: 0,
            rendered: 0,
            waiting: 0,
            max_queued: 0,
            correction_ppm: 0.0,
        })
    }

    /// 既存のsnapshot統計へ一度だけ加算する（音声callback内で確保しない）。
    pub(crate) fn report_resume(&mut self, shared: &super::Shared) {
        if let Some(discarded) = self.pending_resume.take() {
            shared.paused(discarded);
        }
    }

    fn fade_frames(&self) -> usize {
        (self.output_rate as usize / 200).max(1)
    }

    pub fn render(&mut self, samples: &mut [f32], rx: &mut impl FrameQueue) {
        self.render_inner(samples, rx);
        let frames = samples.len() / 2;
        if frames == 0 || self.failed || self.fade_out > 0 || (!self.primed && self.fade_in == 0) {
            return;
        }
        // render後の底を、出力時間40ms以上の非スライディング窓で比較する。
        // frame数を積算するのでcallback長が変わっても40ms未満では判定せず、確保もしない。
        // packetの鋸歯状の揺れを除く代わりに、検出まで最大約2窓（約80ms、
        // callback単位の切上げ分を除く）だけ余分に古い音を鳴らすことを許容する。
        self.window_floor = self.window_floor.min(rx.frames());
        self.window_frames += frames;
        if self.window_frames < (self.output_rate as usize * RESUME_WINDOW_MS).div_ceil(1000) {
            return;
        }
        let floor = self.window_floor;
        self.window_floor = usize::MAX;
        self.window_frames = 0;
        let target = callback_target(self.input_rate, self.output_rate, frames);
        if floor > target + correction_span()
            && self
                .previous_floor
                .is_some_and(|previous| floor.saturating_sub(previous) > BLOCK + RESUME_MARGIN)
        {
            // 底そのものの跳びだけを再開として数え、緩やかなクロック差では発火しない。
            // fade in中の再停止も、現在のgainから滑らかに下げる。
            self.fade_out_gain = 1.0 - self.fade_in as f32 / self.fade_frames() as f32;
            self.fade_out = self.fade_frames();
            self.fade_in = 0;
            self.previous_floor = None;
        } else {
            self.previous_floor = Some(floor);
        }
    }

    fn render_inner(&mut self, samples: &mut [f32], rx: &mut impl FrameQueue) {
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
        for (index, frame) in samples.as_chunks_mut::<2>().0.iter_mut().enumerate() {
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
            if self.fade_out > 0 {
                self.fade_out -= 1;
                let gain = self.fade_out_gain * self.fade_out as f32 / self.fade_frames() as f32;
                frame[0] *= gain;
                frame[1] *= gain;
                if self.fade_out == 0 {
                    // 破棄直後の古さの上限は入力target frame。SRC内の旧世代もresetする。
                    let to_discard = rx.frames().saturating_sub(target);
                    let mut discarded = 0;
                    for _ in 0..to_discard {
                        if rx.pop_frame().is_none() {
                            break;
                        }
                        discarded += 1;
                    }
                    self.wait_for_audio();
                    self.fade_in = self.fade_frames();
                    self.resume_resets += 1;
                    self.resume_discarded += discarded as u64;
                    self.pending_resume = Some(discarded);
                    // 残りは意図した無音。次callbackから新しい世代をfade inする。
                    self.rendered += (frames - index - 1) as u64;
                    return;
                }
            } else if self.fade_in > 0 {
                self.fade_in -= 1;
                let gain = 1.0 - self.fade_in as f32 / self.fade_frames() as f32;
                frame[0] *= gain;
                frame[1] *= gain;
            }
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
    fn dsp464_clock_high_rate_sines_reject_aliases_at_ratio_limits() {
        for (input_rate, output_rate) in [(96_000, 48_000), (176_400, 44_100), (192_000, 48_000)] {
            for ppm in [-2_000.0, 0.0, 2_000.0] {
                for frequency in [1_000.0, 30_000.0, 40_000.0] {
                    let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
                    let mut renderer = Renderer::with_rates(input_rate, output_rate).unwrap();
                    let target = callback_target(input_rate, output_rate, BLOCK);
                    let depth = (target as isize - (ppm / 2_000.0 * 1024.0) as isize) as usize;
                    let mut ordinal = 0usize;
                    let mut output = [0.0; BLOCK * 2];
                    let mut power = 0.0;
                    let mut measured = 0;
                    for block in 0..64 {
                        // 最初だけ正規の深さでprimeし、その後はキュー深さで比率端へ動かす。
                        let fill = if block == 0 { target } else { depth };
                        while rx.occupied_len() < fill {
                            let x = (0.5
                                * (std::f64::consts::TAU * frequency * ordinal as f64
                                    / f64::from(input_rate))
                                .sin()) as f32;
                            tx.try_push([x, -x]).unwrap();
                            ordinal += 1;
                        }
                        renderer.render(&mut output, &mut Stereo(&mut rx));
                        assert!(!renderer.failed, "{input_rate}->{output_rate}, {ppm}ppm");
                        if block >= 16 {
                            assert!((renderer.correction_ppm - ppm).abs() < 1e-6);
                            for frame in output.as_chunks::<2>().0 {
                                assert_eq!(frame[0], -frame[1]);
                                power += f64::from(frame[0]).powi(2);
                                measured += 1;
                            }
                        }
                    }
                    // 入力振幅0.5の正弦波RMSを基準とし、立上がり4096出力frameは除く。
                    let db = 10.0 * (power / measured as f64 / 0.125).log10();
                    eprintln!("#464 clock {input_rate}->{output_rate} {ppm:+}ppm {frequency}Hz: {db:.6} dB");
                    assert!(db.is_finite());
                    if frequency == 1_000.0 {
                        assert!(
                            db.abs() <= 0.5,
                            "{input_rate}->{output_rate}, {ppm}ppm: {db} dB"
                        );
                    } else {
                        // sincの長さを比率に合わせる前は、192→48kHz・30kHz入力で−70dBだった（#486）。
                        assert!(
                            db <= -120.0,
                            "{input_rate}->{output_rate}, {ppm}ppm {frequency}Hz: {db} dB"
                        );
                    }
                }
            }
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
        assert_eq!(underrun_action(0, || 0), UnderrunAction::Wait);
        assert_eq!(underrun_action(29, || 99), UnderrunAction::Wait);
        assert_eq!(underrun_action(30, || 0), UnderrunAction::DiscardAndReprime);
        assert_eq!(underrun_action(29, || 100), UnderrunAction::Fail);
        // 破棄する場合は starved の経過を読まない（時計読取りを増やさない）。
        assert_eq!(
            underrun_action(30, || unreachable!("破棄時は経過時間を読まない")),
            UnderrunAction::DiscardAndReprime
        );
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

    // 100Hz・振幅0.2（逆相stereo）。callback間も含めた隣接差を測る。
    fn resume478_push_tone(
        tx: &mut impl Producer<Item = [f32; 2]>,
        ordinal: &mut usize,
        n: usize,
        rate: u32,
    ) {
        for _ in 0..n {
            let x = (std::f64::consts::TAU * 100.0 * *ordinal as f64 / f64::from(rate)).sin()
                as f32
                * 0.2;
            tx.try_push([x, -x]).unwrap();
            *ordinal += 1;
        }
    }

    #[test]
    fn resume478_repeated_consumer_pauses_bound_depth_steps_and_allocations() {
        for (input_rate, output_rate, frames) in [
            (48_000, 48_000, 256),
            (44_100, 48_000, 128),
            (96_000, 48_000, 1024),
        ] {
            for pause_ms in [20, 100, 500] {
                // 500msも保持できる設定。既定容量を越える場合は別試験で失敗を固定する。
                let capacity = 65_536;
                let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(capacity).split();
                let mut renderer =
                    Renderer::with_rates_and_capacity(input_rate, output_rate, capacity).unwrap();
                let target = callback_target(input_rate, output_rate, frames);
                let mut output = vec![0.0; frames * 2];
                let shared = super::super::Shared::new(std::sync::Arc::default());
                let mut ordinal = 0;
                let mut fraction = 0.0;
                let mut previous = [0.0f32; 2];
                let mut max_step = 0.0f32;
                resume478_push_tone(&mut tx, &mut ordinal, target, input_rate);
                for _ in 0..16 {
                    resume478_push_tone(
                        &mut tx,
                        &mut ordinal,
                        frames * input_rate as usize / output_rate as usize,
                        input_rate,
                    );
                    renderer.render(&mut output, &mut Stereo(&mut rx));
                    previous.copy_from_slice(&output[output.len() - 2..]);
                }
                let mut depths = [0usize; 5];
                let window_callbacks =
                    (output_rate as usize * RESUME_WINDOW_MS).div_ceil(1000 * frames);
                let settled_callback =
                    2 * window_callbacks + 2 * renderer.fade_frames().div_ceil(frames);
                for depth in &mut depths {
                    // producerは動き続け、consumerだけを止める。
                    resume478_push_tone(
                        &mut tx,
                        &mut ordinal,
                        input_rate as usize * pause_ms / 1000,
                        input_rate,
                    );
                    for callback in 0..40.max(settled_callback + 1) {
                        fraction += frames as f64 * f64::from(input_rate) / f64::from(output_rate);
                        let incoming = fraction as usize;
                        fraction -= incoming as f64;
                        let counts = allocation_counts(|| {
                            resume478_push_tone(&mut tx, &mut ordinal, incoming, input_rate);
                            let resets = renderer.resume_resets;
                            renderer.render(&mut output, &mut Stereo(&mut rx));
                            if renderer.resume_resets > resets {
                                assert_eq!(rx.occupied_len(), target);
                            }
                            renderer.report_resume(&shared);
                        });
                        assert_eq!(counts, (0, 0));
                        assert!(
                            !renderer.failed,
                            "{input_rate}->{output_rate}, {pause_ms}ms"
                        );
                        for pair in output.as_chunks::<2>().0 {
                            assert_eq!(pair[0], -pair[1]);
                            for ch in 0..2 {
                                max_step = max_step.max((pair[ch] - previous[ch]).abs());
                            }
                            previous = *pair;
                        }
                        // 2窓分の検出待ちとfade out/inの後で、繰返しの深さを比較する。
                        if callback == settled_callback {
                            *depth = rx.occupied_len();
                            assert_depth_after_render(*depth, target, 0.0);
                        }
                    }
                    assert_eq!(renderer.fade_out, 0);
                    assert_eq!(renderer.fade_in, 0);
                }
                assert!(
                    max_step < 0.01,
                    "{input_rate}->{output_rate}, {pause_ms}ms: step={max_step}"
                );
                assert_eq!(renderer.underruns, 0);
                let snapshot = shared.snapshot();
                assert_eq!(snapshot.pause_resets, renderer.resume_resets);
                assert_eq!(snapshot.waiting_discarded_frames, renderer.resume_discarded);
                if pause_ms >= 100 {
                    assert_eq!(renderer.resume_resets, 5);
                }
                eprintln!("#478 {input_rate}->{output_rate} frames={frames} pause={pause_ms}ms target={target} depths={depths:?} max_step={max_step:.8} resets={}", renderer.resume_resets);
            }
        }
    }

    #[test]
    fn resume478_discards_old_queue_and_src_history_even_when_fades_cross_callbacks() {
        let frames = 128;
        let target = callback_target(48_000, 48_000, frames);
        let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
        let mut renderer = Renderer::new(48_000).unwrap();
        let mut output = [0.0; 256];
        let window_callbacks = (48_000 * RESUME_WINDOW_MS).div_ceil(1000 * frames);
        for _ in 0..target + BLOCK {
            tx.try_push([0.5, -0.5]).unwrap();
        }
        for _ in 0..8 {
            for _ in 0..frames {
                tx.try_push([0.5, -0.5]).unwrap();
            }
            renderer.render(&mut output, &mut Stereo(&mut rx));
        }
        assert!(output.iter().any(|sample| *sample > 0.49));
        for _ in 0..4800 {
            tx.try_push([0.5, -0.5]).unwrap();
        }
        for _ in 0..target {
            tx.try_push([-0.2, 0.2]).unwrap();
        }
        for _ in 0..2 * window_callbacks + renderer.fade_frames().div_ceil(frames) {
            for _ in 0..frames {
                tx.try_push([-0.2, 0.2]).unwrap();
            }
            assert_eq!(
                allocation_counts(|| renderer.render(&mut output, &mut Stereo(&mut rx))),
                (0, 0)
            );
            if renderer.resume_resets == 1 {
                break;
            }
        }
        assert_eq!(renderer.resume_resets, 1);
        assert_eq!(rx.occupied_len(), target);
        assert_eq!(output[output.len() - 2..], [0.0; 2]);
        // 新しい音だけを出す。SRC内部の0.5も、queue先頭の旧世代も残さない。
        let mut previous = 0.0f32;
        let mut max_step = 0.0f32;
        for callback in 0..2 * window_callbacks + 2 * renderer.fade_frames().div_ceil(frames) + 1 {
            for _ in 0..frames {
                tx.try_push([-0.2, 0.2]).unwrap();
            }
            assert_eq!(
                allocation_counts(|| renderer.render(&mut output, &mut Stereo(&mut rx))),
                (0, 0)
            );
            for pair in output.as_chunks::<2>().0 {
                assert!(pair[0] <= 1e-4 && pair[0] > -0.25);
                max_step = max_step.max((pair[0] - previous).abs());
                previous = pair[0];
            }
            if callback == 0 {
                // fade in途中で再びconsumerを止めても、窓の再集計後に旧音を破棄する。
                for _ in 0..4800 {
                    tx.try_push([-0.2, 0.2]).unwrap();
                }
            }
        }
        assert!(!renderer.failed);
        assert_eq!(renderer.resume_resets, 2);
        assert!(max_step < 0.01, "step={max_step}");
        eprintln!(
            "#478 history depth={} target={target} max_step={max_step:.8} resets={}",
            rx.occupied_len(),
            renderer.resume_resets
        );
    }

    #[test]
    fn resume478_default_capacity_500ms_fails_without_hiding_overflow() {
        for _ in 0..5 {
            let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
            let mut renderer = Renderer::new(48_000).unwrap();
            let mut output = [0.0; BLOCK * 2];
            for _ in 0..callback_target(48_000, 48_000, BLOCK) {
                tx.try_push([0.2; 2]).unwrap();
            }
            renderer.render(&mut output, &mut Stereo(&mut rx));
            let mut rejected = 0;
            let counts = allocation_counts(|| {
                for _ in 0..24_000 {
                    rejected += usize::from(tx.try_push([0.2; 2]).is_err());
                }
                renderer.render(&mut output, &mut Stereo(&mut rx));
            });
            assert_eq!(counts, (0, 0));
            assert!(rejected > 0);
            assert!(renderer.failed && !renderer.failed_underrun);
            assert_eq!(renderer.resume_resets, 0);
            assert!(output.iter().all(|s| *s == 0.0));
            renderer.render(&mut output, &mut Stereo(&mut rx));
            assert!(renderer.failed);
            assert!(output.iter().all(|s| *s == 0.0));
        }
    }

    #[test]
    fn resume478_gradual_1500ppm_drift_never_triggers_a_resume() {
        for (input_rate, output_rate) in [(48_000, 48_000), (44_100, 48_000), (96_000, 44_100)] {
            let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
            let mut renderer = Renderer::with_rates(input_rate, output_rate).unwrap();
            let mut output = [0.0; BLOCK * 2];
            let target = callback_target(input_rate, output_rate, BLOCK);
            for _ in 0..target {
                tx.try_push([0.2, -0.2]).unwrap();
            }
            renderer.render(&mut output, &mut Stereo(&mut rx));
            let mut fraction = 0.0;
            for _ in 0..4000 {
                assert_eq!(
                    allocation_counts(|| {
                        push_fractional(
                            &mut tx,
                            &mut fraction,
                            BLOCK as f64 * f64::from(input_rate) / f64::from(output_rate) * 1.0015,
                            [0.2, -0.2],
                        );
                        renderer.render(&mut output, &mut Stereo(&mut rx));
                    }),
                    (0, 0)
                );
                assert!(!renderer.failed);
                assert_depth_after_render(rx.occupied_len(), target, 1500.0);
                assert!(renderer.correction_ppm.abs() <= 2000.0 + 1e-3);
            }
            assert_eq!(renderer.resume_resets, 0);
            assert_eq!(renderer.resume_discarded, 0);
        }
    }

    // 10msのpacket到着で瞬間的に補正帯を越えても、窓の底が跳ばなければ再開と扱わない。
    #[test]
    fn resume478_packet_bursts_with_1500ppm_drift_never_trigger_a_resume() {
        for (input_rate, output_rate) in [(48_000u32, 48_000u32), (96_000, 48_000)] {
            let packet = input_rate as usize / 100;
            let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
            let mut renderer = Renderer::with_rates(input_rate, output_rate).unwrap();
            let mut output = [0.0; BLOCK * 2];
            let target = callback_target(input_rate, output_rate, BLOCK);
            for _ in 0..target {
                tx.try_push([0.2, -0.2]).unwrap();
            }
            renderer.render(&mut output, &mut Stereo(&mut rx));
            let per_callback =
                BLOCK as f64 * f64::from(input_rate) / f64::from(output_rate) * 1.0015;
            let mut owed = 0.0;
            for _ in 0..4000 {
                owed += per_callback;
                while owed >= packet as f64 {
                    for _ in 0..packet {
                        tx.try_push([0.2, -0.2]).unwrap();
                    }
                    owed -= packet as f64;
                }
                renderer.render(&mut output, &mut Stereo(&mut rx));
                assert!(!renderer.failed, "{input_rate}->{output_rate}");
                assert!(rx.occupied_len() <= target + correction_span() + packet);
            }
            assert_eq!(renderer.resume_resets, 0, "{input_rate}->{output_rate}");
            assert_eq!(renderer.resume_discarded, 0);
            eprintln!(
                "#478 packet {input_rate}->{output_rate} depth={} target={target} resume_resets={}",
                rx.occupied_len(),
                renderer.resume_resets
            );
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
