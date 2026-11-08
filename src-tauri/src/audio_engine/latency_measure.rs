//! 出力機器から入力機器へ戻る往復遅延の測定。
//!
//! スイープの生成と相互相関は制御スレッドで行う。
//! 音声コールバックは、開始前に確保したバッファへ読む・書くだけで、確保も解放もしない。
//! バッファは入力と出力の二つのコールバックが同時に触るため、
//! 片方のコールバックから retire キューへ渡すと、もう片方が書いた直後に解放され得る。
//! 所有の返却は、両方のコールバックがバッファから出たことを確認した制御スレッドが行う。
//!
//! 基準時刻: 出力コールバックがスイープの先頭サンプルを出すブロックの開始時に、
//! 入力コールバックがそれまでに書き終えたフレーム数を一度だけ読む。
//! 遅延は「取得バッファ内でスイープが始まる位置 − そのフレーム数」。
//! ブロック境界の不確かさは、そのときの入力ブロック長と出力ブロック長の和を `resolution_ms` とする。

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use std::cell::UnsafeCell;
use std::sync::atomic::{
    AtomicBool, AtomicPtr, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering,
};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(test)]
use super::test_tone::TEST_TONE_DEFAULT_DBFS;
use super::test_tone::{clamp_level_db, dbfs_to_amplitude};

const SWEEP_SECONDS: f64 = 1.25;
const FADE_MS: f64 = 10.0;
const CANCEL_FADE_MS: f64 = 5.0;
const MAX_DELAY_MS: f64 = 1000.0;
const ARM_SLACK_MS: f64 = 500.0;
const TIMEOUT_MARGIN: Duration = Duration::from_secs(2);
const CLIP_ABS: f32 = 0.999;
const CLIP_COUNT: u32 = 8;
const SILENCE_RMS: f32 = 1.0e-4;
const PEAK_RATIO_MIN: f32 = 1.25;
const SNR_MIN: f32 = 8.0;
const EXCLUDE_MS: f64 = 1.0;

const IDLE: u8 = 0;
const ARMED: u8 = 1;
const RUNNING: u8 = 2;
const FADING: u8 = 3;
const ZEROING: u8 = 4;
const SEALED: u8 = 5;

const END_NONE: u8 = 0;
const END_READY: u8 = 1;
const END_CANCELLED: u8 = 2;
const END_TIMEOUT: u8 = 3;
const END_MUTED: u8 = 4;
const END_STOPPED: u8 = 5;
const END_INPUT_CHANGED: u8 = 6;

/// 取得に使う入力の選び方。
/// 左右が同じ番号なら、そのチャンネルを入力ゲインの前のまま使う。
/// 左右が違う番号なら、二つのチャンネルを等分に足してモノ化する。範囲外は 0。
pub fn select_input_sample(frame: &[f32], selected: [usize; 2]) -> f32 {
    let sample = |index: usize| {
        let value = frame.get(index).copied().unwrap_or(0.0);
        if value.is_finite() {
            value
        } else {
            0.0
        }
    };
    let left = sample(selected[0]);
    if selected[0] == selected[1] {
        left
    } else {
        0.5 * (left + sample(selected[1]))
    }
}

fn selected_clipped(frame: &[f32], selected: [usize; 2]) -> bool {
    selected.into_iter().any(|index| {
        frame
            .get(index)
            .copied()
            .is_some_and(|value| value.is_finite() && value.abs() >= CLIP_ABS)
    })
}

/// 機器 ID が空なら `name:` 付きの表示名を使う。両方空なら `unknown`。
pub fn device_identity(id: Option<&str>, name: Option<&str>) -> String {
    if let Some(id) = id.map(str::trim).filter(|value| !value.is_empty()) {
        return id.to_string();
    }
    if let Some(name) = name.map(str::trim).filter(|value| !value.is_empty()) {
        return format!("name:{name}");
    }
    "unknown".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conditions {
    pub output_device_id: String,
    pub input_device_id: String,
    pub input_channel: u32,
    pub input_channel_right: u32,
    pub input_mixed: bool,
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub engine_epoch: String,
}

pub fn conditions_match(saved: &Conditions, current: &Conditions) -> bool {
    saved == current
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Running,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Success,
    Uncertain,
    Failure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    pub kind: Kind,
    pub reason: Option<String>,
    pub delay_frames: Option<f64>,
    pub delay_ms: Option<f64>,
    pub resolution_ms: Option<f64>,
    pub inverted: bool,
    pub confidence: Option<f32>,
    pub conditions: Conditions,
    pub measured_at_ms: u64,
    pub level_db: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: Phase,
    pub progress: f32,
    pub result: Option<Measurement>,
}

impl Snapshot {
    fn idle() -> Self {
        Self {
            phase: Phase::Idle,
            progress: 0.0,
            result: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerdictKind {
    Success,
    Uncertain,
    Failure,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub kind: VerdictKind,
    pub reason: Option<&'static str>,
    pub delay_frames: Option<f64>,
    pub delay_ms: Option<f64>,
    pub inverted: bool,
    pub confidence: Option<f32>,
}

pub struct Sweep {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub level_db: f32,
    pub f0_hz: f32,
    pub f1_hz: f32,
}

pub fn measurement_sweep(sample_rate: u32, level_db: f32) -> Option<Sweep> {
    generate_sweep(sample_rate, level_db, SWEEP_SECONDS)
}

pub fn generate_sweep(sample_rate: u32, level_db: f32, seconds: f64) -> Option<Sweep> {
    let (f0, f1) = sweep_band(sample_rate)?;
    if !(0.05..=2.0).contains(&seconds) {
        return None;
    }
    let level_db = clamp_level_db(level_db);
    let amplitude = dbfs_to_amplitude(level_db);
    let total = (seconds * f64::from(sample_rate)).round().max(1.0) as usize;
    let fade = ((FADE_MS * 0.001 * f64::from(sample_rate)).round() as usize).clamp(1, total / 2);
    let k = (f64::from(f1) / f64::from(f0)).ln() / seconds;
    let mut samples = Vec::with_capacity(total);
    for index in 0..total {
        let time = index as f64 / f64::from(sample_rate);
        let phase = std::f64::consts::TAU * f64::from(f0) * ((k * time).exp() - 1.0) / k;
        let envelope = edge_fade(index, total, fade);
        samples.push((phase.sin() as f32) * amplitude * envelope);
    }
    Some(Sweep {
        samples,
        sample_rate,
        level_db,
        f0_hz: f0,
        f1_hz: f1,
    })
}

fn sweep_band(sample_rate: u32) -> Option<(f32, f32)> {
    if !(8_000..=384_000).contains(&sample_rate) {
        return None;
    }
    let f1 = (sample_rate as f32 * 0.45).min(12_000.0);
    if f1 <= 150.0 {
        return None;
    }
    Some((100.0, f1))
}

fn edge_fade(index: usize, total: usize, fade: usize) -> f32 {
    let into = if index < fade {
        index as f32 / fade as f32
    } else if total.saturating_sub(index) <= fade {
        total.saturating_sub(index) as f32 / fade as f32
    } else {
        return 1.0;
    };
    0.5 - 0.5 * (std::f32::consts::PI * into.clamp(0.0, 1.0)).cos()
}

pub fn analyze(sweep: &[f32], capture: &[f32], sample_rate: u32, start_frame: u64) -> Verdict {
    if sample_rate < 8_000 || sweep.is_empty() {
        return failure("truncated");
    }
    let start = usize::try_from(start_frame).unwrap_or(usize::MAX);
    if capture.len() < sweep.len() || start.saturating_add(sweep.len()) > capture.len() {
        return failure("truncated");
    }
    let clips = capture
        .iter()
        .filter(|sample| sample.is_finite() && sample.abs() >= CLIP_ABS)
        .count();
    if clips >= CLIP_COUNT as usize {
        return failure("clipped");
    }
    let rms = rms(capture);
    if !rms.is_finite() || rms < SILENCE_RMS {
        return failure("no_signal");
    }
    let correlation = correlate(sweep, capture);
    classify(&correlation, sample_rate, start, sweep.len(), capture.len())
}

fn failure(reason: &'static str) -> Verdict {
    Verdict {
        kind: VerdictKind::Failure,
        reason: Some(reason),
        delay_frames: None,
        delay_ms: None,
        inverted: false,
        confidence: None,
    }
}

fn uncertain(reason: &'static str) -> Verdict {
    Verdict {
        kind: VerdictKind::Uncertain,
        reason: Some(reason),
        ..failure("unused")
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy = samples.iter().fold(0.0f64, |sum, sample| {
        let value = if sample.is_finite() {
            f64::from(*sample)
        } else {
            0.0
        };
        sum + value * value
    });
    (energy / samples.len() as f64).sqrt() as f32
}

fn correlate(reference: &[f32], capture: &[f32]) -> Vec<f32> {
    let length = reference
        .len()
        .saturating_add(capture.len())
        .next_power_of_two()
        .max(2);
    let mut planner = FftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(length);
    let inverse = planner.plan_fft_inverse(length);
    let mut reference_fft = vec![Complex::new(0.0, 0.0); length];
    let mut capture_fft = vec![Complex::new(0.0, 0.0); length];
    for (slot, sample) in reference_fft.iter_mut().zip(reference) {
        slot.re = *sample;
    }
    for (slot, sample) in capture_fft.iter_mut().zip(capture) {
        slot.re = if sample.is_finite() { *sample } else { 0.0 };
    }
    forward.process(&mut reference_fft);
    forward.process(&mut capture_fft);
    for (capture_bin, reference_bin) in capture_fft.iter_mut().zip(&reference_fft) {
        *capture_bin *= reference_bin.conj();
    }
    inverse.process(&mut capture_fft);
    let scale = 1.0 / length as f32;
    capture_fft
        .into_iter()
        .take(capture.len())
        .map(|value| value.re * scale)
        .collect()
}

fn classify(
    correlation: &[f32],
    sample_rate: u32,
    start: usize,
    sweep_len: usize,
    capture_len: usize,
) -> Verdict {
    let max_lag = capture_len.saturating_sub(sweep_len);
    let max_delay = ((MAX_DELAY_MS * 0.001) * f64::from(sample_rate)).round() as usize;
    let window_end = start.saturating_add(max_delay).min(max_lag);
    if start > max_lag {
        return failure("truncated");
    }
    let exclude = ((EXCLUDE_MS * 0.001) * f64::from(sample_rate))
        .round()
        .max(1.0) as isize;
    let inside = best_peak(correlation, start..=window_end);
    let outside = best_peak_excluding(correlation, 0..=max_lag, start, window_end);
    let Some((inside_index, inside_value)) = inside else {
        return failure("out_of_range");
    };
    if let Some((_, outside_value)) = outside {
        if outside_value.abs() > inside_value.abs() * PEAK_RATIO_MIN {
            return failure("out_of_range");
        }
    }
    let second = second_peak(correlation, start..=window_end, inside_index, exclude);
    let main_abs = inside_value.abs();
    let second_abs = second.map(|(_, value)| value.abs()).unwrap_or(0.0);
    let ratio = main_abs / second_abs.max(1.0e-12);
    let noise = correlation_noise(correlation, inside_index, exclude);
    let snr = main_abs / noise.max(1.0e-12);
    if ratio < PEAK_RATIO_MIN {
        return uncertain("multiple_peaks");
    }
    if snr < SNR_MIN {
        return uncertain("low_snr");
    }
    let refined = refine(correlation, inside_index);
    let delay = refined - start as f64;
    if !delay.is_finite() || delay < -0.5 || delay > max_delay as f64 + 0.5 {
        return failure("out_of_range");
    }
    let delay = delay.max(0.0);
    let ratio_score = ((ratio / PEAK_RATIO_MIN) - 1.0).clamp(0.0, 3.0) / 3.0;
    let snr_score = ((snr / SNR_MIN) - 1.0).clamp(0.0, 3.0) / 3.0;
    Verdict {
        kind: VerdictKind::Success,
        reason: None,
        delay_frames: Some(delay),
        delay_ms: Some(delay * 1000.0 / f64::from(sample_rate)),
        inverted: inside_value < 0.0,
        confidence: Some(ratio_score.min(snr_score)),
    }
}

fn best_peak(correlation: &[f32], range: impl Iterator<Item = usize>) -> Option<(usize, f32)> {
    let mut best: Option<(usize, f32)> = None;
    for index in range {
        let Some(value) = correlation.get(index).copied() else {
            continue;
        };
        if !value.is_finite() {
            continue;
        }
        if best.is_none_or(|(_, current)| value.abs() > current.abs()) {
            best = Some((index, value));
        }
    }
    best
}

fn best_peak_excluding(
    correlation: &[f32],
    range: impl Iterator<Item = usize>,
    start: usize,
    end: usize,
) -> Option<(usize, f32)> {
    best_peak(
        correlation,
        range.filter(|index| *index < start || *index > end),
    )
}

fn second_peak(
    correlation: &[f32],
    range: impl Iterator<Item = usize>,
    main: usize,
    exclude: isize,
) -> Option<(usize, f32)> {
    best_peak(
        correlation,
        range.filter(|index| (*index as isize - main as isize).abs() > exclude),
    )
}

fn correlation_noise(correlation: &[f32], main: usize, exclude: isize) -> f32 {
    let mut energy = 0.0f64;
    let mut count = 0usize;
    for (index, value) in correlation.iter().enumerate() {
        if (index as isize - main as isize).abs() <= exclude || !value.is_finite() {
            continue;
        }
        energy += f64::from(*value) * f64::from(*value);
        count += 1;
    }
    if count == 0 {
        return 0.0;
    }
    (energy / count as f64).sqrt() as f32
}

fn refine(correlation: &[f32], index: usize) -> f64 {
    if index == 0 || index + 1 >= correlation.len() {
        return index as f64;
    }
    let earlier = correlation[index - 1];
    let center = correlation[index];
    let later = correlation[index + 1];
    let denominator = earlier - 2.0 * center + later;
    if !denominator.is_finite() || denominator.abs() < 1.0e-12 {
        return index as f64;
    }
    let delta = (0.5 * (earlier - later) / denominator).clamp(-0.5, 0.5);
    index as f64 + f64::from(delta)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputAction {
    Passthrough,
    Replace,
    Muted,
}

impl OutputAction {
    /// 測定が出力を占めているあいだは、配信の live sender へ渡さない。
    pub fn forwards_to_live(self) -> bool {
        matches!(self, Self::Passthrough)
    }
}

struct DropProbe {
    drops: Arc<AtomicUsize>,
    thread: std::thread::ThreadId,
}

impl Drop for DropProbe {
    fn drop(&mut self) {
        assert_eq!(
            std::thread::current().id(),
            self.thread,
            "測定バッファを音声コールバックで解放した"
        );
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

struct Session {
    sweep: Box<[f32]>,
    capture: UnsafeCell<Box<[f32]>>,
    rate: u32,
    device_channels: usize,
    selected: [usize; 2],
    max_delay: usize,
    cancel_fade: usize,
    conditions: Conditions,
    level_db: f32,
    play_pos: AtomicUsize,
    capture_pos: AtomicUsize,
    input_frames: AtomicU64,
    start_frame: AtomicU64,
    input_block: AtomicU32,
    output_block: AtomicU32,
    clip_count: AtomicU32,
    end_reason: AtomicU8,
    fade_left: AtomicU32,
    /// 0: 停止フェード前、1: フェードしたブロック、2: 次ブロックを無音にした。
    stop_stage: AtomicU8,
    capture_done: AtomicBool,
    /// テストが解放スレッドを確認する。本番は None のまま、Drop 以外では読まない。
    #[allow(dead_code)]
    probe: Option<DropProbe>,
}

// SAFETY: sweep は公開後に書き換えない。capture を書くのは入力コールバックだけで、
// busy を増やして稼働中の phase を見てから書く。制御スレッドは SEALED かつ
// 両方の busy が 0 になるまで capture を読まず、その後にポインタを外す。
unsafe impl Sync for Session {}

pub struct Bridge {
    phase: AtomicU8,
    slot: AtomicPtr<Session>,
    input_busy: AtomicU32,
    output_busy: AtomicU32,
}

impl Default for Bridge {
    fn default() -> Self {
        Self::new()
    }
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            phase: AtomicU8::new(IDLE),
            slot: AtomicPtr::new(std::ptr::null_mut()),
            input_busy: AtomicU32::new(0),
            output_busy: AtomicU32::new(0),
        }
    }

    pub fn blocks_downstream(&self) -> bool {
        matches!(
            self.phase.load(Ordering::SeqCst),
            ARMED | RUNNING | FADING | ZEROING
        )
    }

    pub fn request_end(&self, reason: u8) {
        let ptr = self.slot.load(Ordering::SeqCst);
        if ptr.is_null() || reason == END_NONE {
            return;
        }
        // SAFETY: 回収前の公開中だけポインタが有効。書くのは atomic の end_reason だけ。
        unsafe {
            let _ = (*ptr).end_reason.compare_exchange(
                END_NONE,
                reason,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
    }

    pub fn abandon(&self, reason: u8) {
        self.output_busy.fetch_add(1, Ordering::SeqCst);
        self.request_end(reason);
        if self.blocks_downstream() {
            self.phase.store(SEALED, Ordering::SeqCst);
        }
        self.output_busy.fetch_sub(1, Ordering::SeqCst);
    }

    /// ストリーム異常や出力を書けない戻りで、フェードを待たずに制御側へ返す。
    pub fn abandon_stopped(&self) {
        if self.blocks_downstream() {
            self.abandon(END_STOPPED);
        }
    }

    pub fn capture_input(&self, interleaved: &[f32], channels: usize) {
        self.output_or_input(true, |session| session.capture(interleaved, channels));
    }

    pub fn render(&self, frames: usize, muted: bool, dry: &mut [f32]) -> OutputAction {
        if frames == 0 || dry.len() < frames {
            return OutputAction::Passthrough;
        }
        self.output_busy.fetch_add(1, Ordering::SeqCst);
        let phase = self.phase.load(Ordering::SeqCst);
        let ptr = self.slot.load(Ordering::SeqCst);
        let mut action = OutputAction::Passthrough;
        if matches!(phase, ARMED | RUNNING | FADING | ZEROING) && !ptr.is_null() {
            // SAFETY: output busy を保持しているあいだは制御側がポインタを外さない。
            action = unsafe { (*ptr).render(frames, muted, dry) };
            settle_phase(self, action);
        }
        self.output_busy.fetch_sub(1, Ordering::SeqCst);
        action
    }

    pub fn progress(&self) -> f32 {
        let ptr = self.slot.load(Ordering::SeqCst);
        if ptr.is_null() {
            return 0.0;
        }
        // SAFETY: 制御スレッドだけがポインタを外す。ここは atomic の読みだけ。
        let session = unsafe { &*ptr };
        let length = session.sweep.len().max(1) as f32;
        (session.play_pos.load(Ordering::Relaxed) as f32 / length).clamp(0.0, 1.0)
    }

    pub fn capture_complete(&self) -> bool {
        let ptr = self.slot.load(Ordering::SeqCst);
        if ptr.is_null() {
            return false;
        }
        // SAFETY: 回収前の atomic 読み。capture 本体は読まない。
        unsafe { (*ptr).capture_done.load(Ordering::Relaxed) }
    }

    fn output_or_input(&self, input: bool, body: impl FnOnce(&Session)) {
        let busy = if input {
            &self.input_busy
        } else {
            &self.output_busy
        };
        busy.fetch_add(1, Ordering::SeqCst);
        let phase = self.phase.load(Ordering::SeqCst);
        let ptr = self.slot.load(Ordering::SeqCst);
        if matches!(phase, ARMED | RUNNING | FADING | ZEROING) && !ptr.is_null() {
            // SAFETY: busy を増やしたあとの稼働中 phase。SEALED 後の回収は busy が 0 になるまで待たない。
            body(unsafe { &*ptr });
        }
        busy.fetch_sub(1, Ordering::SeqCst);
    }

    fn publish(&self, session: Box<Session>) -> Result<(), Box<Session>> {
        if self.phase.load(Ordering::SeqCst) != IDLE || !self.slot.load(Ordering::SeqCst).is_null()
        {
            return Err(session);
        }
        self.slot.store(Box::into_raw(session), Ordering::SeqCst);
        self.phase.store(ARMED, Ordering::SeqCst);
        Ok(())
    }

    fn try_take(&self) -> Option<Box<Session>> {
        if self.phase.load(Ordering::SeqCst) != SEALED {
            return None;
        }
        if self.input_busy.load(Ordering::SeqCst) != 0
            || self.output_busy.load(Ordering::SeqCst) != 0
        {
            return None;
        }
        if self.phase.load(Ordering::SeqCst) != SEALED {
            return None;
        }
        self.take_pointer()
    }

    fn take_forced(&self) -> Option<Box<Session>> {
        self.take_pointer()
    }

    fn take_pointer(&self) -> Option<Box<Session>> {
        let ptr = self.slot.swap(std::ptr::null_mut(), Ordering::SeqCst);
        self.phase.store(IDLE, Ordering::SeqCst);
        if ptr.is_null() {
            None
        } else {
            // SAFETY: この swap で制御スレッドへ所有を戻した。コールバックは SEALED / IDLE ではポインタを使わない。
            // take_forced は、ストリーム破棄でコールバックが戻った後だけ呼ぶ。
            Some(unsafe { Box::from_raw(ptr) })
        }
    }
}

impl Session {
    fn capture(&self, interleaved: &[f32], channels: usize) {
        let frames = interleaved.len().checked_div(channels).unwrap_or(0);
        if frames == 0 {
            return;
        }
        self.input_block.store(frames as u32, Ordering::Relaxed);
        let mut index = self.capture_pos.load(Ordering::Relaxed);
        // SAFETY: 入力コールバックだけが capture を書く。index はこのコールバックの単一実行で進める。
        let buffer = unsafe { &mut *self.capture.get() };
        for frame in 0..frames {
            if index >= buffer.len() {
                self.end_reason
                    .compare_exchange(END_NONE, END_STOPPED, Ordering::SeqCst, Ordering::SeqCst)
                    .ok();
                break;
            }
            let sample = if channels == self.device_channels {
                let start = frame * channels;
                let input = &interleaved[start..start + channels];
                if selected_clipped(input, self.selected) {
                    self.clip_count.fetch_add(1, Ordering::Relaxed);
                }
                select_input_sample(input, self.selected)
            } else {
                0.0
            };
            buffer[index] = sample;
            index += 1;
        }
        self.capture_pos.store(index, Ordering::Relaxed);
        let written = self
            .input_frames
            .fetch_add(frames as u64, Ordering::Release)
            + frames as u64;
        self.note_capture_complete(written);
    }

    fn note_capture_complete(&self, written: u64) {
        let start = self.start_frame.load(Ordering::Acquire);
        if start == u64::MAX {
            return;
        }
        let need = start
            .saturating_add(self.sweep.len() as u64)
            .saturating_add(self.max_delay as u64);
        if written >= need || self.capture_pos.load(Ordering::Relaxed) >= self.capture_capacity() {
            self.capture_done.store(true, Ordering::Release);
        }
    }

    fn capture_capacity(&self) -> usize {
        self.sweep.len()
            + self.max_delay
            + ((ARM_SLACK_MS * 0.001) * f64::from(self.rate)).round() as usize
    }

    fn render(&self, frames: usize, muted: bool, dry: &mut [f32]) -> OutputAction {
        dry[..frames].fill(0.0);
        if muted {
            let _ = self.end_reason.compare_exchange(
                END_NONE,
                END_MUTED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            // 公開中の phase は Bridge 側の atomic。ここからは Session の終了理由だけを残し、
            // 呼び出し側が Muted を無音経路へ渡す。封印は次の begin で行う。
            self.mark_terminal();
            return OutputAction::Muted;
        }
        self.output_block
            .fetch_max(frames as u32, Ordering::Relaxed);
        if self.end_reason.load(Ordering::SeqCst) == END_MUTED {
            self.mark_terminal();
            return OutputAction::Muted;
        }
        let ending = self.end_reason.load(Ordering::SeqCst);
        if ending != END_NONE && ending != END_READY {
            return self.render_stop(frames, dry);
        }
        if self.play_pos.load(Ordering::Relaxed) == 0
            && self.start_frame.load(Ordering::Acquire) == u64::MAX
        {
            let start = self.input_frames.load(Ordering::Acquire);
            self.start_frame.store(start, Ordering::Release);
        }
        if self.play_pos.load(Ordering::Relaxed) >= self.sweep.len() {
            if self.capture_done.load(Ordering::Acquire) {
                let _ = self.end_reason.compare_exchange(
                    END_NONE,
                    END_READY,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                );
                self.mark_terminal();
            }
            return OutputAction::Replace;
        }
        let mut position = self.play_pos.load(Ordering::Relaxed);
        for sample in &mut dry[..frames] {
            if position >= self.sweep.len() {
                break;
            }
            *sample = self.sweep[position];
            position += 1;
        }
        self.play_pos.store(position, Ordering::Relaxed);
        if position >= self.sweep.len() && self.capture_done.load(Ordering::Acquire) {
            let _ = self.end_reason.compare_exchange(
                END_NONE,
                END_READY,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            self.mark_terminal();
        }
        OutputAction::Replace
    }

    fn render_stop(&self, frames: usize, dry: &mut [f32]) -> OutputAction {
        // 取消を見たブロックで短くフェードし、その次のブロックを完全な無音にしてから終える。
        let region = &mut dry[..frames];
        if self.stop_stage.load(Ordering::Relaxed) >= 1 {
            self.stop_stage.store(2, Ordering::Relaxed);
            return OutputAction::Replace;
        }
        let fade_total = self.cancel_fade.min(frames).max(1);
        let mut position = self.play_pos.load(Ordering::Relaxed);
        for (index, sample) in region.iter_mut().take(fade_total).enumerate() {
            if position >= self.sweep.len() {
                break;
            }
            let gain = 1.0 - index as f32 / fade_total as f32;
            *sample = self.sweep[position] * gain;
            position += 1;
        }
        self.play_pos.store(position, Ordering::Relaxed);
        self.fade_left.store(0, Ordering::Relaxed);
        self.stop_stage.store(1, Ordering::Relaxed);
        OutputAction::Replace
    }

    fn mark_terminal(&self) {
        // phase の封印は Bridge が持つ。Session からは完了フラグだけを立て、
        // Bridge::render の外で phase を更新する。
        self.capture_done.store(
            self.capture_done.load(Ordering::Relaxed)
                || self.end_reason.load(Ordering::SeqCst) != END_NONE,
            Ordering::Relaxed,
        );
    }
}

/// 出力アクションのあと、稼働中なら phase を進める。
fn settle_phase(bridge: &Bridge, action: OutputAction) {
    if !bridge.blocks_downstream() {
        return;
    }
    let ptr = bridge.slot.load(Ordering::SeqCst);
    if ptr.is_null() {
        return;
    }
    // SAFETY: 出力コールバックの render から戻った直後。同じ出力スレッドだけが phase を進める。
    let session = unsafe { &*ptr };
    let ending = session.end_reason.load(Ordering::SeqCst);
    let played = session.play_pos.load(Ordering::Relaxed) >= session.sweep.len();
    let ready = ending == END_READY
        || (played && session.capture_done.load(Ordering::Acquire) && ending == END_NONE);
    let stopped = ending != END_NONE
        && ending != END_READY
        && session.stop_stage.load(Ordering::Relaxed) >= 2;
    let stop_now = matches!(action, OutputAction::Muted) || stopped;
    if ready || stop_now {
        if ending == END_NONE && ready {
            let _ = session.end_reason.compare_exchange(
                END_NONE,
                END_READY,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
        bridge.phase.store(SEALED, Ordering::SeqCst);
    }
}

struct Pending {
    started: Instant,
    timeout: Duration,
}

pub struct StartContext {
    pub running: bool,
    pub muted: bool,
    pub stream_failed: bool,
    pub split: bool,
    pub process_input: bool,
    pub rates_match: bool,
    pub test_tone: bool,
    pub voice_playback: bool,
    pub recording: bool,
    pub loudness: bool,
    pub auto_gain: bool,
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub input_channels: usize,
    pub selected: [usize; 2],
    pub output_device_id: String,
    pub input_device_id: String,
    pub engine_epoch: String,
    pub level_db: f32,
}

pub struct Controller {
    bridge: Arc<Bridge>,
    snapshot: Snapshot,
    pending: Option<Pending>,
    tone_until: Option<Instant>,
    loudness: bool,
}

impl Default for Controller {
    fn default() -> Self {
        Self::new()
    }
}

impl Controller {
    pub fn new() -> Self {
        Self {
            bridge: Arc::new(Bridge::new()),
            snapshot: Snapshot::idle(),
            pending: None,
            tone_until: None,
            loudness: false,
        }
    }

    pub fn bridge(&self) -> Arc<Bridge> {
        self.bridge.clone()
    }

    pub fn is_active(&self) -> bool {
        self.pending.is_some()
    }

    pub fn note_test_tone(&mut self, duration_ms: u32) {
        self.tone_until = Some(Instant::now() + Duration::from_millis(u64::from(duration_ms) + 20));
    }

    pub fn clear_test_tone(&mut self) {
        self.tone_until = None;
    }

    pub fn test_tone_active(&self) -> bool {
        self.tone_until.is_some_and(|until| Instant::now() < until)
    }

    pub fn set_loudness(&mut self, active: bool) {
        self.loudness = active;
    }

    pub fn loudness_active(&self) -> bool {
        self.loudness
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.clone()
    }

    pub fn start(&mut self, context: StartContext) -> Result<(), &'static str> {
        if let Some(reason) = reject_reason(&context, self.is_active()) {
            return Err(reason);
        }
        let sweep =
            measurement_sweep(context.sample_rate, context.level_db).ok_or("not_running")?;
        let max_delay = ((MAX_DELAY_MS * 0.001) * f64::from(context.sample_rate)).round() as usize;
        let slack = ((ARM_SLACK_MS * 0.001) * f64::from(context.sample_rate)).round() as usize;
        let capacity = sweep.samples.len() + max_delay + slack;
        let cancel_fade = ((CANCEL_FADE_MS * 0.001) * f64::from(context.sample_rate))
            .round()
            .max(1.0) as usize;
        let mixed = context.selected[0] != context.selected[1];
        let conditions = Conditions {
            output_device_id: context.output_device_id,
            input_device_id: context.input_device_id,
            input_channel: context.selected[0] as u32,
            input_channel_right: context.selected[1] as u32,
            input_mixed: mixed,
            sample_rate: context.sample_rate,
            buffer_size: context.buffer_size,
            engine_epoch: context.engine_epoch,
        };
        let level_db = sweep.level_db;
        let session = Box::new(Session {
            sweep: sweep.samples.into_boxed_slice(),
            capture: UnsafeCell::new(vec![0.0; capacity].into_boxed_slice()),
            rate: context.sample_rate,
            device_channels: context.input_channels,
            selected: context.selected,
            max_delay,
            cancel_fade,
            conditions,
            level_db,
            play_pos: AtomicUsize::new(0),
            capture_pos: AtomicUsize::new(0),
            input_frames: AtomicU64::new(0),
            start_frame: AtomicU64::new(u64::MAX),
            input_block: AtomicU32::new(0),
            output_block: AtomicU32::new(0),
            clip_count: AtomicU32::new(0),
            end_reason: AtomicU8::new(END_NONE),
            fade_left: AtomicU32::new(0),
            stop_stage: AtomicU8::new(0),
            capture_done: AtomicBool::new(false),
            probe: None,
        });
        self.bridge.publish(session).map_err(|_| "busy")?;
        self.pending = Some(Pending {
            started: Instant::now(),
            timeout: Duration::from_secs_f64(SWEEP_SECONDS) + TIMEOUT_MARGIN,
        });
        self.snapshot.phase = Phase::Running;
        self.snapshot.progress = 0.0;
        Ok(())
    }

    pub fn cancel(&mut self) {
        if self.is_active() {
            self.bridge.request_end(END_CANCELLED);
        }
    }

    pub fn preempt(&mut self, reason: &'static str) {
        if self.is_active() {
            self.bridge.request_end(end_code(reason));
        }
    }

    pub fn poll(&mut self, stream_failed: bool) {
        let Some(pending) = &self.pending else {
            return;
        };
        if stream_failed {
            self.bridge.abandon(END_STOPPED);
        } else if pending.started.elapsed() > pending.timeout && !self.bridge.capture_complete() {
            self.bridge.request_end(END_TIMEOUT);
        }
        self.snapshot.phase = Phase::Running;
        self.snapshot.progress = self.bridge.progress();
        if let Some(session) = self.bridge.try_take() {
            self.finish(session);
        }
    }

    pub fn on_streams_dropped(&mut self) {
        if self.pending.is_none() && self.bridge.slot.load(Ordering::SeqCst).is_null() {
            return;
        }
        self.bridge.request_end(END_STOPPED);
        if let Some(session) = self.bridge.take_forced() {
            if session.end_reason.load(Ordering::SeqCst) == END_NONE {
                session.end_reason.store(END_STOPPED, Ordering::SeqCst);
            }
            self.finish(session);
        }
        self.pending = None;
    }

    fn finish(&mut self, session: Box<Session>) {
        self.pending = None;
        let reason = session.end_reason.load(Ordering::SeqCst);
        let measurement = if reason == END_READY {
            measurement_from_analysis(&session)
        } else {
            failure_measurement(&session, end_label(reason).unwrap_or("stopped"))
        };
        self.snapshot = Snapshot {
            phase: Phase::Done,
            progress: 1.0,
            result: Some(measurement),
        };
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        if Arc::strong_count(&self.bridge) == 1 {
            if let Some(session) = self.bridge.take_forced() {
                drop(session);
            }
        }
    }
}

fn measurement_from_analysis(session: &Session) -> Measurement {
    let start = session.start_frame.load(Ordering::Acquire);
    let written = session.capture_pos.load(Ordering::Relaxed);
    // SAFETY: 所有が制御スレッドへ戻ったあと。capture の書き手はいない。
    let capture = unsafe { &**session.capture.get() };
    let capture = &capture[..written.min(capture.len())];
    if session.clip_count.load(Ordering::Relaxed) >= CLIP_COUNT {
        return failure_measurement(session, "clipped");
    }
    if start == u64::MAX {
        return failure_measurement(session, "truncated");
    }
    let verdict = analyze(&session.sweep, capture, session.rate, start);
    let mut measurement = failure_measurement(session, verdict.reason.unwrap_or("no_signal"));
    if verdict.kind == VerdictKind::Success {
        measurement.kind = Kind::Success;
        measurement.reason = None;
        measurement.delay_frames = verdict.delay_frames;
        measurement.delay_ms = verdict.delay_ms;
        measurement.inverted = verdict.inverted;
        measurement.confidence = verdict.confidence;
        measurement.resolution_ms = Some(resolution_ms(session));
    } else if verdict.kind == VerdictKind::Uncertain {
        measurement.kind = Kind::Uncertain;
        measurement.reason = verdict.reason.map(str::to_string);
    }
    measurement
}

fn resolution_ms(session: &Session) -> f64 {
    let input = session.input_block.load(Ordering::Relaxed).max(1);
    let output = session.output_block.load(Ordering::Relaxed).max(1);
    f64::from(input.saturating_add(output)) * 1000.0 / f64::from(session.rate.max(1))
}

fn failure_measurement(session: &Session, reason: &str) -> Measurement {
    Measurement {
        kind: Kind::Failure,
        reason: Some(reason.to_string()),
        delay_frames: None,
        delay_ms: None,
        resolution_ms: None,
        inverted: false,
        confidence: None,
        conditions: session.conditions.clone(),
        measured_at_ms: unix_ms(),
        level_db: session.level_db,
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn reject_reason(context: &StartContext, active: bool) -> Option<&'static str> {
    if active {
        return Some("busy");
    }
    if !context.running {
        return Some("not_running");
    }
    if context.stream_failed {
        return Some("stream_failed");
    }
    if context.process_input {
        return Some("process_input");
    }
    if context.split {
        return Some("split_output");
    }
    if !context.rates_match || context.sample_rate < 8_000 || context.input_channels == 0 {
        return Some("rate_mismatch");
    }
    if context.muted {
        return Some("muted");
    }
    if context.test_tone {
        return Some("test_tone");
    }
    if context.voice_playback {
        return Some("voice_check");
    }
    if context.recording {
        return Some("recording");
    }
    if context.loudness {
        return Some("loudness");
    }
    if context.auto_gain {
        return Some("auto_gain");
    }
    None
}

fn end_code(reason: &str) -> u8 {
    match reason {
        "cancelled" => END_CANCELLED,
        "timeout" => END_TIMEOUT,
        "muted" => END_MUTED,
        "input_changed" => END_INPUT_CHANGED,
        _ => END_STOPPED,
    }
}

fn end_label(reason: u8) -> Option<&'static str> {
    Some(match reason {
        END_READY => return None,
        END_CANCELLED => "cancelled",
        END_TIMEOUT => "timeout",
        END_MUTED => "muted",
        END_INPUT_CHANGED => "input_changed",
        _ => "stopped",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vst_host::instance::allocation_counts;

    fn place(capture: &mut [f32], sweep: &[f32], delay: f64, invert: bool) {
        let sign = if invert { -1.0 } else { 1.0 };
        for (index, sample) in sweep.iter().enumerate() {
            let position = index as f64 + delay;
            let lower = position.floor() as usize;
            let fraction = (position - lower as f64) as f32;
            if let Some(slot) = capture.get_mut(lower) {
                *slot += sample * sign * (1.0 - fraction);
            }
            if let Some(slot) = capture.get_mut(lower + 1) {
                *slot += sample * sign * fraction;
            }
        }
    }

    fn noise(buffer: &mut [f32], amplitude: f32, mut state: u64) {
        for sample in buffer {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let unit = ((state >> 40) as u32 as f32) / ((1u32 << 24) as f32);
            *sample += (unit * 2.0 - 1.0) * amplitude;
        }
    }

    fn sweep_at(rate: u32) -> Sweep {
        generate_sweep(rate, TEST_TONE_DEFAULT_DBFS, 0.35).expect("sweep")
    }

    fn capture_for(sweep: &Sweep, delay: f64, start: usize) -> Vec<f32> {
        let extra = (delay.ceil() as usize) + start + 64;
        vec![0.0; sweep.samples.len() + extra]
    }

    fn assert_delay(rate: u32, delay: f64, invert: bool) {
        let sweep = sweep_at(rate);
        let start = 80usize;
        let mut capture = capture_for(&sweep, delay, start);
        place(&mut capture[start..], &sweep.samples, delay, invert);
        let verdict = analyze(&sweep.samples, &capture, rate, start as u64);
        assert_eq!(
            verdict.kind,
            VerdictKind::Success,
            "{rate} {delay} {verdict:?}"
        );
        let frames = verdict.delay_frames.expect("frames");
        assert!(
            (frames - delay).abs() < 0.75,
            "delay {frames} expected {delay} at {rate}"
        );
        assert_eq!(verdict.inverted, invert);
        assert!(verdict.confidence.expect("confidence") > 0.0);
    }

    #[test]
    fn sweep_stays_inside_the_test_tone_level_and_duration() {
        let sweep = measurement_sweep(48_000, 0.0).expect("default");
        assert!((sweep.level_db - TEST_TONE_DEFAULT_DBFS).abs() < 0.01);
        let peak = sweep
            .samples
            .iter()
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
        assert!(peak <= dbfs_to_amplitude(-12.0) + 1.0e-5);
        let seconds = sweep.samples.len() as f64 / 48_000.0;
        assert!((1.0..=1.5).contains(&seconds));
        assert!((sweep.f0_hz - 100.0).abs() < 0.1);
        assert!((sweep.f1_hz - 12_000.0).abs() < 1.0);
        let high = measurement_sweep(44_100, -6.0).expect("44.1");
        assert!(high.level_db <= -12.0);
        assert!((high.f1_hz - 12_000.0).abs() < 1.0);
    }

    #[test]
    fn known_delays_polarity_and_rates() {
        for rate in [44_100, 48_000, 96_000] {
            assert_delay(rate, 0.0, false);
            assert_delay(rate, 1.0, false);
            assert_delay(rate, 37.5, false);
            assert_delay(rate, 0.48 * f64::from(rate), false);
            assert_delay(rate, 100.0, true);
        }
    }

    #[test]
    fn silence_clip_truncation_echo_range_and_noise() {
        let rate = 48_000u32;
        let sweep = sweep_at(rate);
        let silent = vec![0.0; sweep.samples.len() + 200];
        assert_eq!(
            analyze(&sweep.samples, &silent, rate, 10).reason,
            Some("no_signal")
        );
        let mut clipped = capture_for(&sweep, 20.0, 0);
        place(&mut clipped, &sweep.samples, 20.0, false);
        for sample in &mut clipped[..CLIP_COUNT as usize] {
            *sample = 1.0;
        }
        assert_eq!(
            analyze(&sweep.samples, &clipped, rate, 0).reason,
            Some("clipped")
        );
        assert_eq!(
            analyze(
                &sweep.samples,
                &sweep.samples[..sweep.samples.len() / 2],
                rate,
                0
            )
            .reason,
            Some("truncated")
        );

        let mut echo = capture_for(&sweep, rate as f64 * 0.13, 0);
        place(&mut echo, &sweep.samples, rate as f64 * 0.04, false);
        place(&mut echo, &sweep.samples, rate as f64 * 0.08, false);
        assert_eq!(
            analyze(&sweep.samples, &echo, rate, 0).reason,
            Some("multiple_peaks")
        );

        let mut far = vec![0.0; sweep.samples.len() + (rate as f64 * 1.3) as usize];
        place(&mut far, &sweep.samples, rate as f64 * 1.2, false);
        assert_eq!(
            analyze(&sweep.samples, &far, rate, 0).reason,
            Some("out_of_range")
        );

        let mut clean = capture_for(&sweep, 30.0, 0);
        place(&mut clean, &sweep.samples, 30.0, false);
        let signal = rms(&sweep.samples).max(1.0e-6);
        noise(&mut clean, signal / 100.0, 0x1234_5678);
        assert_eq!(
            analyze(&sweep.samples, &clean, rate, 0).kind,
            VerdictKind::Success
        );
        let mut harsh = vec![0.0; sweep.samples.len() + 64];
        noise(&mut harsh, 0.08, 0xABCDEF);
        let noisy = analyze(&sweep.samples, &harsh, rate, 0);
        assert_ne!(noisy.kind, VerdictKind::Success, "{noisy:?}");
    }

    #[test]
    fn input_selection_is_pre_gain_and_mono_when_split() {
        let frame = [0.5f32, -0.25, 0.0];
        assert_eq!(select_input_sample(&frame, [0, 0]), 0.5);
        assert_eq!(select_input_sample(&frame, [1, 1]), -0.25);
        assert_eq!(select_input_sample(&frame, [0, 1]), 0.125);
        assert_eq!(select_input_sample(&frame, [3, 3]), 0.0);
    }

    #[test]
    fn conditions_change_when_route_rate_buffer_or_epoch_changes() {
        let saved = Conditions {
            output_device_id: "out".into(),
            input_device_id: "in".into(),
            input_channel: 0,
            input_channel_right: 1,
            input_mixed: true,
            sample_rate: 48_000,
            buffer_size: 256,
            engine_epoch: "epoch-1".into(),
        };
        assert!(conditions_match(&saved, &saved));
        let mut changed = saved.clone();
        changed.engine_epoch = "epoch-2".into();
        assert!(!conditions_match(&saved, &changed));
        changed = saved.clone();
        changed.buffer_size = 128;
        assert!(!conditions_match(&saved, &changed));
        changed = saved.clone();
        changed.input_mixed = false;
        assert!(!conditions_match(&saved, &changed));
    }

    fn context() -> StartContext {
        StartContext {
            running: true,
            muted: false,
            stream_failed: false,
            split: false,
            process_input: false,
            rates_match: true,
            test_tone: false,
            voice_playback: false,
            recording: false,
            loudness: false,
            auto_gain: false,
            sample_rate: 48_000,
            buffer_size: 128,
            input_channels: 2,
            selected: [0, 1],
            output_device_id: "out".into(),
            input_device_id: "in".into(),
            engine_epoch: "epoch".into(),
            level_db: -20.0,
        }
    }

    #[test]
    fn start_rejects_unsafe_or_busy_routes() {
        let mut controller = Controller::new();
        let mut muted = context();
        muted.muted = true;
        assert_eq!(controller.start(muted).unwrap_err(), "muted");
        let mut stopped = context();
        stopped.running = false;
        assert_eq!(controller.start(stopped).unwrap_err(), "not_running");
        controller.start(context()).expect("start");
        assert_eq!(controller.start(context()).unwrap_err(), "busy");
    }

    #[test]
    fn callbacks_do_not_allocate_or_drop_and_cancel_then_mute_are_silent() {
        let drops = Arc::new(AtomicUsize::new(0));
        let bridge = Bridge::new();
        let sweep = generate_sweep(48_000, -20.0, 0.05).expect("sweep");
        let session = Box::new(Session {
            capture: UnsafeCell::new(vec![0.0; sweep.samples.len() + 4_000].into_boxed_slice()),
            sweep: sweep.samples.into_boxed_slice(),
            rate: 48_000,
            device_channels: 2,
            selected: [0, 0],
            max_delay: 48_000,
            cancel_fade: 64,
            conditions: context_conditions(),
            level_db: -20.0,
            play_pos: AtomicUsize::new(0),
            capture_pos: AtomicUsize::new(0),
            input_frames: AtomicU64::new(0),
            start_frame: AtomicU64::new(u64::MAX),
            input_block: AtomicU32::new(0),
            output_block: AtomicU32::new(0),
            clip_count: AtomicU32::new(0),
            end_reason: AtomicU8::new(END_NONE),
            fade_left: AtomicU32::new(0),
            stop_stage: AtomicU8::new(0),
            capture_done: AtomicBool::new(false),
            probe: Some(DropProbe {
                drops: drops.clone(),
                thread: std::thread::current().id(),
            }),
        });
        bridge.publish(session).ok().expect("publish");
        let mut dry = [0.0f32; 128];
        let counts = allocation_counts(|| {
            bridge.capture_input(&[0.2, 0.0, 0.2, 0.0], 2);
            let action = bridge.render(128, false, &mut dry);
            assert!(!action.forwards_to_live());
            assert!(dry.iter().any(|sample| sample.abs() > 0.01));
            bridge.request_end(END_CANCELLED);
            let fading = bridge.render(128, false, &mut dry);
            assert_eq!(fading, OutputAction::Replace);
            assert_eq!(dry[127], 0.0);
            let silent = bridge.render(128, false, &mut dry);
            assert_eq!(silent, OutputAction::Replace);
            assert!(dry.iter().all(|sample| *sample == 0.0));
            assert!(!silent.forwards_to_live());
        });
        assert_eq!(counts, (0, 0), "alloc {counts:?}");
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        drop(bridge.try_take());
        assert_eq!(drops.load(Ordering::SeqCst), 1);

        let drops = Arc::new(AtomicUsize::new(0));
        let bridge = Arc::new(Bridge::new());
        bridge
            .publish(muted_session(drops.clone(), std::thread::current().id()))
            .ok()
            .expect("mute session");
        let remote = bridge.clone();
        let handle = std::thread::spawn(move || {
            let mut block = [0.2f32; 32];
            let counts = allocation_counts(|| {
                let action = remote.render(32, true, &mut block);
                assert!(block.iter().all(|sample| *sample == 0.0));
                assert_eq!(action, OutputAction::Muted);
                assert!(!action.forwards_to_live());
            });
            assert_eq!(counts, (0, 0));
        });
        handle.join().expect("join");
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        drop(bridge.try_take());
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    fn muted_session(drops: Arc<AtomicUsize>, thread: std::thread::ThreadId) -> Box<Session> {
        let sweep = generate_sweep(48_000, -20.0, 0.05).expect("sweep");
        Box::new(Session {
            capture: UnsafeCell::new(vec![0.0; 1_000].into_boxed_slice()),
            sweep: sweep.samples.into_boxed_slice(),
            rate: 48_000,
            device_channels: 1,
            selected: [0, 0],
            max_delay: 1_000,
            cancel_fade: 8,
            conditions: context_conditions(),
            level_db: -20.0,
            play_pos: AtomicUsize::new(0),
            capture_pos: AtomicUsize::new(0),
            input_frames: AtomicU64::new(0),
            start_frame: AtomicU64::new(u64::MAX),
            input_block: AtomicU32::new(0),
            output_block: AtomicU32::new(0),
            clip_count: AtomicU32::new(0),
            end_reason: AtomicU8::new(END_NONE),
            fade_left: AtomicU32::new(0),
            stop_stage: AtomicU8::new(0),
            capture_done: AtomicBool::new(false),
            probe: Some(DropProbe { drops, thread }),
        })
    }

    fn context_conditions() -> Conditions {
        Conditions {
            output_device_id: "out".into(),
            input_device_id: "in".into(),
            input_channel: 0,
            input_channel_right: 0,
            input_mixed: false,
            sample_rate: 48_000,
            buffer_size: 128,
            engine_epoch: "epoch".into(),
        }
    }

    #[test]
    fn clock_offset_is_removed_and_timeout_does_not_invent_a_delay() {
        let mut controller = Controller::new();
        controller.start(context()).expect("start");
        let bridge = controller.bridge();
        let block = 32usize;
        let delay = 64usize;
        let mut dry = vec![0.0f32; block];
        let mut queued = Vec::new();
        bridge.capture_input(&vec![0.0; block * 2], 2);
        assert_eq!(bridge.render(block, false, &mut dry), OutputAction::Replace);
        queued.extend_from_slice(&dry);
        bridge.capture_input(&vec![0.0; delay * 2], 2);
        for _ in 0..8_000 {
            if !bridge.blocks_downstream() {
                break;
            }
            while queued.len() >= block {
                let mut interleaved = Vec::with_capacity(block * 2);
                for sample in queued.drain(..block) {
                    interleaved.push(sample);
                    interleaved.push(sample);
                }
                bridge.capture_input(&interleaved, 2);
            }
            assert_eq!(bridge.render(block, false, &mut dry), OutputAction::Replace);
            queued.extend_from_slice(&dry);
        }
        controller.poll(false);
        let result = controller.snapshot().result.expect("measured");
        assert_eq!(result.kind, Kind::Success, "{result:?}");
        let frames = result.delay_frames.expect("delay");
        assert!(
            (frames - delay as f64).abs() < f64::from(block as u32) + 1.0,
            "{frames}"
        );
        assert!(result.resolution_ms.expect("resolution") > 0.0);
        assert!(!result.inverted);

        let mut controller = Controller::new();
        controller.start(context()).expect("start");
        controller.pending.as_mut().expect("pending").started =
            Instant::now() - Duration::from_secs(10);
        controller.poll(false);
        let bridge = controller.bridge();
        let mut dry = [0.0f32; 64];
        let _ = bridge.render(64, false, &mut dry);
        let silent = bridge.render(64, false, &mut dry);
        assert!(dry.iter().all(|sample| *sample == 0.0), "{silent:?}");
        controller.poll(false);
        let result = controller.snapshot().result.expect("timeout result");
        assert_eq!(result.kind, Kind::Failure);
        assert_eq!(result.reason.as_deref(), Some("timeout"));
        assert!(result.delay_ms.is_none());
    }
}
