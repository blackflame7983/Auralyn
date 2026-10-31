//! ボイスチェック録音のオフライン品質分析（Tauri メインプロセス専用）

use rustfft::{num_complex::Complex, Fft, FftPlanner};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

/// 判定・アドバイス用の閾値（実測で調整する前提で 1 箇所に集約）
pub mod thresholds {
    pub const CLIP_SAMPLE_THRESHOLD: f32 = 0.999;
    pub const CLIP_RATIO_WARN: f32 = 0.0001;
    pub const CLIP_COUNT_WARN: u32 = 1;
    pub const CLIP_COUNT_BAD: u32 = 5;

    pub const DROPOUT_DIFF_THRESHOLD: f32 = 0.35;
    pub const DROPOUT_MIN_GAP_FRAMES: usize = 48;
    pub const DROPOUT_COUNT_WARN: u32 = 2;
    pub const DROPOUT_COUNT_BAD: u32 = 8;

    pub const VAD_FRAME_MS: f32 = 20.0;
    pub const VAD_ENERGY_THRESHOLD: f32 = 0.012;

    pub const NOISE_FLOOR_WARN_DB: f32 = -50.0;
    pub const NOISE_FLOOR_BAD_DB: f32 = -40.0;
    pub const SNR_IMPROVEMENT_WEAK_DB: f32 = 1.5;

    pub const HIGH_BAND_HZ: u32 = 4000;
    pub const HIGH_BAND_DELTA_WARN_DB: f32 = -6.0;

    pub const LOUDNESS_RMS_TOO_LOW_DB: f32 = -24.0;
    pub const LOUDNESS_RMS_TOO_HIGH_DB: f32 = -6.0;
    pub const LOUDNESS_PEAK_WARN_DB: f32 = -1.0;

    pub const OCTAVE_CENTER_HZ: [u32; 8] = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
}

const CHANNELS: usize = 2;
const MIN_EPS: f32 = 1e-12;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipReport {
    pub count: u32,
    pub ratio: f32,
    pub positions_ms: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropoutReport {
    pub count: u32,
    pub positions_ms: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseFloorDb {
    pub raw: f32,
    pub processed: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BandDeltaDb {
    pub band_hz: u32,
    pub delta_db: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoudnessReport {
    pub rms_db: f32,
    pub peak_db: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Good,
    Warn,
    Bad,
}

impl Verdict {
    fn as_str(&self) -> &'static str {
        match self {
            Verdict::Good => "good",
            Verdict::Warn => "warn",
            Verdict::Bad => "bad",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    pub severity: String,
    pub message_key: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityReport {
    pub clip: ClipReport,
    pub dropouts: DropoutReport,
    pub noise_floor_db: NoiseFloorDb,
    pub snr_improvement_db: f32,
    pub band_delta_db: Vec<BandDeltaDb>,
    pub loudness: LoudnessReport,
    pub verdict: String,
    pub advices: Vec<Advice>,
}

#[derive(Default)]
pub struct AnalysisContext {
    pub buffer_size: Option<u32>,
}

/// インターリーブステレオ f32 バッファから品質レポートを生成
pub fn analyze_voice_check_buffers(
    raw: &[f32],
    processed: &[f32],
    sample_rate_hz: u32,
    ctx: &AnalysisContext,
) -> QualityReport {
    let frames = raw.len().min(processed.len()) / CHANNELS;
    let raw = &raw[..frames * CHANNELS];
    let processed = &processed[..frames * CHANNELS];

    // エネルギーの平均を使い、逆位相でも相殺しない。時間差分には使わない。
    let raw_mono = frame_rms(raw);
    let processed_mono = frame_rms(processed);

    let clip = detect_clips(processed, sample_rate_hz);
    let dropouts = detect_dropouts(processed, sample_rate_hz);
    let vad = compute_vad_mask(&raw_mono, sample_rate_hz);

    let noise_floor_raw = noise_floor_dbfs(&raw_mono, &vad);
    let noise_floor_processed = noise_floor_dbfs(&processed_mono, &vad);
    let snr_improvement_db = snr_improvement_db(
        &raw_mono,
        &processed_mono,
        &vad,
        noise_floor_raw,
        noise_floor_processed,
    );

    let band_delta_db = octave_band_deltas(raw, processed, sample_rate_hz);
    let loudness = loudness_report(processed);

    let mut advices = generate_advices(AdviceInputs {
        clip: &clip,
        dropouts: &dropouts,
        noise_floor_raw,
        noise_floor_processed,
        snr_improvement_db,
        band_delta_db: &band_delta_db,
        loudness: &loudness,
        ctx,
    });

    let verdict = compute_verdict(&clip, &dropouts, noise_floor_processed, &advices);
    advices.sort_by_key(|advice| std::cmp::Reverse(severity_rank(&advice.severity)));

    QualityReport {
        clip,
        dropouts,
        noise_floor_db: NoiseFloorDb {
            raw: noise_floor_raw,
            processed: noise_floor_processed,
        },
        snr_improvement_db,
        band_delta_db,
        loudness,
        verdict: verdict.as_str().to_string(),
        advices,
    }
}

fn severity_rank(severity: &str) -> u8 {
    match severity {
        "bad" => 3,
        "warn" => 2,
        _ => 1,
    }
}

fn frame_rms(interleaved: &[f32]) -> Vec<f32> {
    interleaved
        .as_chunks::<CHANNELS>()
        .0
        .iter()
        .map(|frame| ((frame[0] * frame[0] + frame[1] * frame[1]) * 0.5).sqrt())
        .collect()
}

fn linear_to_dbfs(v: f32) -> f32 {
    20.0 * v.abs().max(MIN_EPS).log10()
}

fn detect_clips(interleaved: &[f32], sample_rate_hz: u32) -> ClipReport {
    use thresholds::{CLIP_COUNT_WARN, CLIP_RATIO_WARN, CLIP_SAMPLE_THRESHOLD};

    let mut count = 0u32;
    let mut positions_ms = Vec::new();
    let mut in_run = false;
    let mut clipped_samples = 0usize;

    for (i, frame) in interleaved.as_chunks::<CHANNELS>().0.iter().enumerate() {
        if frame.iter().any(|s| s.abs() >= CLIP_SAMPLE_THRESHOLD) {
            clipped_samples += 1;
            if !in_run {
                count += 1;
                positions_ms.push(frame_to_ms(i, sample_rate_hz));
                in_run = true;
            }
        } else {
            in_run = false;
        }
    }

    let frames = interleaved.len() / CHANNELS;
    let ratio = if frames == 0 {
        0.0
    } else {
        clipped_samples as f32 / frames as f32
    };

    // 微小なクリップは warn 閾値でフィルタ（テスト用に count は維持）
    let _ = (CLIP_COUNT_WARN, CLIP_RATIO_WARN);

    ClipReport {
        count,
        ratio,
        positions_ms,
    }
}

fn detect_dropouts(interleaved: &[f32], sample_rate_hz: u32) -> DropoutReport {
    use thresholds::{DROPOUT_DIFF_THRESHOLD, DROPOUT_MIN_GAP_FRAMES};

    let frames = interleaved.len() / CHANNELS;
    if frames < 2 {
        return DropoutReport {
            count: 0,
            positions_ms: Vec::new(),
        };
    }

    let mut diffs = Vec::with_capacity(frames - 1);
    for pair in interleaved.windows(CHANNELS * 2).step_by(CHANNELS) {
        // 各チャンネルの実際の差分だけを比較し、符号合成による偽の不連続を避ける。
        diffs.push((pair[2] - pair[0]).abs().max((pair[3] - pair[1]).abs()));
    }

    let mean = diffs.iter().sum::<f32>() / diffs.len() as f32;
    let variance = diffs.iter().map(|d| (d - mean).powi(2)).sum::<f32>() / diffs.len() as f32;
    let std = variance.sqrt();
    let adaptive = mean + 4.0 * std;
    let threshold = DROPOUT_DIFF_THRESHOLD.max(adaptive);

    let mut count = 0u32;
    let mut positions_ms = Vec::new();
    let mut last_event = usize::MAX;

    for (i, &diff) in diffs.iter().enumerate() {
        if diff >= threshold
            && (last_event == usize::MAX || i.saturating_sub(last_event) >= DROPOUT_MIN_GAP_FRAMES)
        {
            count += 1;
            positions_ms.push(frame_to_ms(i + 1, sample_rate_hz));
            last_event = i;
        }
    }

    DropoutReport {
        count,
        positions_ms,
    }
}

fn frame_to_ms(frame: usize, sample_rate_hz: u32) -> u32 {
    let sr = sample_rate_hz.max(1) as f64;
    ((frame as f64 * 1000.0) / sr).round() as u32
}

fn compute_vad_mask(mono: &[f32], sample_rate_hz: u32) -> Vec<bool> {
    use thresholds::{VAD_ENERGY_THRESHOLD, VAD_FRAME_MS};

    if mono.is_empty() {
        return Vec::new();
    }

    let frame_len = ((sample_rate_hz as f32 * VAD_FRAME_MS) / 1000.0)
        .round()
        .max(1.0) as usize;
    let frame_count = mono.len().div_ceil(frame_len);
    let mut speech_frames = vec![false; frame_count];

    for (fi, speech) in speech_frames.iter_mut().enumerate() {
        let start = fi * frame_len;
        let end = (start + frame_len).min(mono.len());
        if start >= end {
            continue;
        }
        let rms = {
            let sum: f32 = mono[start..end].iter().map(|s| s * s).sum();
            (sum / (end - start) as f32).sqrt()
        };
        *speech = rms >= VAD_ENERGY_THRESHOLD;
    }

    let mut mask = vec![false; mono.len()];
    for (fi, &is_speech) in speech_frames.iter().enumerate() {
        let start = fi * frame_len;
        let end = (start + frame_len).min(mono.len());
        for slot in &mut mask[start..end] {
            *slot = is_speech;
        }
    }
    mask
}

fn noise_floor_dbfs(mono: &[f32], vad: &[bool]) -> f32 {
    let mut sum_sq = 0.0f32;
    let mut count = 0usize;
    for (i, &s) in mono.iter().enumerate() {
        if vad.get(i) == Some(&false) {
            sum_sq += s * s;
            count += 1;
        }
    }
    if count == 0 {
        return -96.0;
    }
    let rms = (sum_sq / count as f32).sqrt();
    linear_to_dbfs(rms)
}

fn speech_rms_dbfs(mono: &[f32], vad: &[bool]) -> f32 {
    let mut sum_sq = 0.0f32;
    let mut count = 0usize;
    for (i, &s) in mono.iter().enumerate() {
        if vad.get(i) == Some(&true) {
            sum_sq += s * s;
            count += 1;
        }
    }
    if count == 0 {
        return -96.0;
    }
    let rms = (sum_sq / count as f32).sqrt();
    linear_to_dbfs(rms)
}

fn snr_improvement_db(
    raw_mono: &[f32],
    processed_mono: &[f32],
    vad: &[bool],
    noise_floor_raw: f32,
    noise_floor_processed: f32,
) -> f32 {
    let snr_raw = speech_rms_dbfs(raw_mono, vad) - noise_floor_raw;
    let snr_processed = speech_rms_dbfs(processed_mono, vad) - noise_floor_processed;
    snr_processed - snr_raw
}

fn loudness_report(interleaved: &[f32]) -> LoudnessReport {
    if interleaved.is_empty() {
        return LoudnessReport {
            rms_db: -96.0,
            peak_db: -96.0,
        };
    }
    let sum_sq: f32 = interleaved.iter().map(|s| s * s).sum();
    let rms = (sum_sq / interleaved.len() as f32).sqrt();
    let peak = interleaved.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    LoudnessReport {
        rms_db: linear_to_dbfs(rms),
        peak_db: linear_to_dbfs(peak),
    }
}

fn octave_band_deltas(raw: &[f32], processed: &[f32], sample_rate_hz: u32) -> Vec<BandDeltaDb> {
    octave_band_deltas_with_plan(raw, processed, sample_rate_hz, |fft_size| {
        FftPlanner::new().plan_fft_forward(fft_size)
    })
}

fn octave_band_deltas_with_plan(
    raw: &[f32],
    processed: &[f32],
    sample_rate_hz: u32,
    plan: impl FnOnce(usize) -> Arc<dyn Fft<f32>>,
) -> Vec<BandDeltaDb> {
    use thresholds::OCTAVE_CENTER_HZ;

    let n = raw.len().max(processed.len()) / CHANNELS;
    // 元音と処理音が同じ有限サンプル列なら、全帯域の差は厳密に0。
    // FXを使わない録音でも大きなFFTを4回行っていたため、比較だけで確定する。
    // 非有限値や長さ違いは通常の解析へ渡し、異常値を同一音として隠さない。
    let identical = raw.len() == processed.len()
        && raw
            .iter()
            .zip(processed)
            .all(|(a, b)| a.is_finite() && a == b);
    if n == 0 || identical {
        return OCTAVE_CENTER_HZ
            .iter()
            .map(|&band_hz| BandDeltaDb {
                band_hz,
                delta_db: 0.0,
            })
            .collect();
    }

    let fft_size = next_pow2(n);
    // 同じ解析内の4回のFFTで計画と作業領域を共有する。
    let fft = plan(fft_size);
    let mut buffer = vec![Complex::new(0.0, 0.0); fft_size];
    let mut scratch = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
    let raw_mag = stereo_magnitude_spectrum(raw, &*fft, &mut buffer, &mut scratch);
    let proc_mag = stereo_magnitude_spectrum(processed, &*fft, &mut buffer, &mut scratch);
    band_deltas_from_spectra(&raw_mag, &proc_mag, fft_size, sample_rate_hz)
}

fn band_deltas_from_spectra(
    raw_mag: &[f32],
    proc_mag: &[f32],
    fft_size: usize,
    sample_rate_hz: u32,
) -> Vec<BandDeltaDb> {
    use thresholds::OCTAVE_CENTER_HZ;
    let bin_hz = sample_rate_hz as f32 / fft_size as f32;

    OCTAVE_CENTER_HZ
        .iter()
        .map(|&center_hz| {
            let low = (center_hz as f32 / std::f32::consts::SQRT_2).max(20.0);
            let high =
                (center_hz as f32 * std::f32::consts::SQRT_2).min(sample_rate_hz as f32 * 0.49);
            let low_bin = (low / bin_hz).floor() as usize;
            let high_bin = (high / bin_hz).ceil() as usize;

            let raw_e = band_energy(raw_mag, low_bin, high_bin);
            let proc_e = band_energy(proc_mag, low_bin, high_bin);
            let delta_db = 10.0 * (proc_e / raw_e.max(MIN_EPS)).log10();

            BandDeltaDb {
                band_hz: center_hz,
                delta_db,
            }
        })
        .collect()
}

fn next_pow2(n: usize) -> usize {
    let mut p = 1usize;
    while p < n {
        p <<= 1;
    }
    p.max(256)
}

fn stereo_magnitude_spectrum(
    interleaved: &[f32],
    fft: &dyn Fft<f32>,
    buffer: &mut [Complex<f32>],
    scratch: &mut [Complex<f32>],
) -> Vec<f32> {
    let mut magnitude = vec![0.0; buffer.len() / 2 + 1];
    for channel in 0..CHANNELS {
        buffer.fill(Complex::new(0.0, 0.0));
        for (slot, frame) in buffer
            .iter_mut()
            .zip(interleaved.as_chunks::<CHANNELS>().0.iter())
        {
            slot.re = frame[channel];
        }
        fft.process_with_scratch(buffer, scratch);
        for (sum, value) in magnitude.iter_mut().zip(buffer.iter()) {
            *sum += value.norm_sqr();
        }
    }
    for value in &mut magnitude {
        *value *= 0.5;
    }
    magnitude
}

fn band_energy(mag_sqr: &[f32], low_bin: usize, high_bin: usize) -> f32 {
    if mag_sqr.is_empty() {
        return MIN_EPS;
    }
    let low = low_bin.min(mag_sqr.len() - 1);
    let high = high_bin.min(mag_sqr.len() - 1);
    if high < low {
        return MIN_EPS;
    }
    mag_sqr[low..=high].iter().sum::<f32>().max(MIN_EPS)
}

struct AdviceInputs<'a> {
    clip: &'a ClipReport,
    dropouts: &'a DropoutReport,
    noise_floor_raw: f32,
    noise_floor_processed: f32,
    snr_improvement_db: f32,
    band_delta_db: &'a [BandDeltaDb],
    loudness: &'a LoudnessReport,
    ctx: &'a AnalysisContext,
}

fn clip_gain_reduction_db(ratio: f32) -> f32 {
    let reduction = ratio * 20.0 + 3.0;
    // min(12).max(3)はNaNを12へ置換する。clamp単独ではこの挙動が変わる。
    if reduction.is_nan() {
        12.0
    } else {
        reduction.clamp(3.0, 12.0)
    }
}

fn generate_advices(inputs: AdviceInputs<'_>) -> Vec<Advice> {
    let AdviceInputs {
        clip,
        dropouts,
        noise_floor_raw,
        noise_floor_processed,
        snr_improvement_db,
        band_delta_db,
        loudness,
        ctx,
    } = inputs;
    use thresholds::*;

    let mut advices = Vec::new();

    if clip.count > 0 {
        let recommended_gain_reduction_db = clip_gain_reduction_db(clip.ratio);
        advices.push(Advice {
            severity: if clip.count >= CLIP_COUNT_BAD {
                "bad".to_string()
            } else {
                "warn".to_string()
            },
            message_key: "clip_detected".to_string(),
            params: serde_json::json!({
                "count": clip.count,
                "recommendedGainReductionDb": (recommended_gain_reduction_db * 10.0).round() / 10.0,
            }),
        });
    }

    if dropouts.count >= DROPOUT_COUNT_WARN {
        let current = ctx.buffer_size.unwrap_or(512);
        let recommended = ((current as f32) * 2.0).round() as u32;
        advices.push(Advice {
            severity: if dropouts.count >= DROPOUT_COUNT_BAD {
                "bad".to_string()
            } else {
                "warn".to_string()
            },
            message_key: "dropout_detected".to_string(),
            params: serde_json::json!({
                "count": dropouts.count,
                "currentBufferSize": current,
                "recommendedBufferSize": recommended,
            }),
        });
    }

    if noise_floor_processed > NOISE_FLOOR_WARN_DB {
        advices.push(Advice {
            severity: if noise_floor_processed > NOISE_FLOOR_BAD_DB {
                "bad".to_string()
            } else {
                "warn".to_string()
            },
            message_key: "noise_floor_high".to_string(),
            params: serde_json::json!({
                "noiseFloorDb": (noise_floor_processed * 10.0).round() / 10.0,
                "rawNoiseFloorDb": (noise_floor_raw * 10.0).round() / 10.0,
            }),
        });
    }

    if snr_improvement_db < SNR_IMPROVEMENT_WEAK_DB {
        advices.push(Advice {
            severity: "info".to_string(),
            message_key: "noise_suppression_weak".to_string(),
            params: serde_json::json!({
                "snrImprovementDb": (snr_improvement_db * 10.0).round() / 10.0,
            }),
        });
    }

    if let Some(high_band) = band_delta_db
        .iter()
        .find(|b| b.band_hz >= HIGH_BAND_HZ && b.delta_db <= HIGH_BAND_DELTA_WARN_DB)
    {
        advices.push(Advice {
            severity: "warn".to_string(),
            message_key: "high_freq_attenuation".to_string(),
            params: serde_json::json!({
                "bandHz": high_band.band_hz,
                "deltaDb": (high_band.delta_db * 10.0).round() / 10.0,
            }),
        });
    }

    if loudness.rms_db < LOUDNESS_RMS_TOO_LOW_DB {
        advices.push(Advice {
            severity: "info".to_string(),
            message_key: "loudness_low".to_string(),
            params: serde_json::json!({
                "rmsDb": (loudness.rms_db * 10.0).round() / 10.0,
            }),
        });
    } else if loudness.rms_db > LOUDNESS_RMS_TOO_HIGH_DB || loudness.peak_db > LOUDNESS_PEAK_WARN_DB
    {
        advices.push(Advice {
            severity: "warn".to_string(),
            message_key: "loudness_high".to_string(),
            params: serde_json::json!({
                "rmsDb": (loudness.rms_db * 10.0).round() / 10.0,
                "peakDb": (loudness.peak_db * 10.0).round() / 10.0,
            }),
        });
    }

    advices
}

fn compute_verdict(
    clip: &ClipReport,
    dropouts: &DropoutReport,
    noise_floor_processed: f32,
    advices: &[Advice],
) -> Verdict {
    use thresholds::*;

    let has_significant_advice = advices
        .iter()
        .any(|a| a.severity == "warn" || a.severity == "bad");

    if advices.iter().any(|a| a.severity == "bad")
        || clip.count >= CLIP_COUNT_BAD
        || dropouts.count >= DROPOUT_COUNT_BAD
        || noise_floor_processed > NOISE_FLOOR_BAD_DB
    {
        return Verdict::Bad;
    }

    if has_significant_advice
        || clip.count >= CLIP_COUNT_WARN
        || clip.ratio >= CLIP_RATIO_WARN
        || dropouts.count >= DROPOUT_COUNT_WARN
        || noise_floor_processed > NOISE_FLOOR_WARN_DB
    {
        return Verdict::Warn;
    }

    Verdict::Good
}

/// hound で float WAV を読み込み（ステレオ interleaved）
pub fn load_wav_interleaved_f32(path: &Path) -> anyhow::Result<(Vec<f32>, u32)> {
    let reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    if spec.channels != CHANNELS as u16 {
        anyhow::bail!("ステレオ WAV のみ対応しています");
    }
    let sample_rate = spec.sample_rate;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = ((1i64 << (spec.bits_per_sample.saturating_sub(1))) as f32).max(1.0);
            reader
                .into_samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    Ok((samples, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    fn sine_stereo(freq_hz: f32, sample_rate: u32, frames: usize, amp: f32) -> Vec<f32> {
        let mut buf = Vec::with_capacity(frames * CHANNELS);
        for i in 0..frames {
            let t = i as f32 / sample_rate as f32;
            let s = (2.0 * PI * freq_hz * t).sin() * amp;
            buf.push(s);
            buf.push(s);
        }
        buf
    }

    fn inject_speech_burst(
        mono_base: &mut [f32],
        start: usize,
        len: usize,
        amp: f32,
        sample_rate: u32,
    ) {
        for i in 0..len {
            let idx = start + i;
            if idx >= mono_base.len() {
                break;
            }
            let t = idx as f32 / sample_rate as f32;
            mono_base[idx] += (2.0 * PI * 300.0 * t).sin() * amp;
        }
    }

    // Issue #182 時点の4回計画する実装を比較基準として保持する。
    fn baseline_band_deltas(raw: &[f32], processed: &[f32], sr: u32) -> Vec<BandDeltaDb> {
        fn spectrum(input: &[f32], fft_size: usize) -> Vec<f32> {
            let mut planner = FftPlanner::new();
            let fft = planner.plan_fft_forward(fft_size);
            let mut buffer: Vec<_> = input
                .iter()
                .take(fft_size)
                .map(|&s| Complex::new(s, 0.0))
                .collect();
            buffer.resize(fft_size, Complex::new(0.0, 0.0));
            fft.process(&mut buffer);
            buffer
                .iter()
                .take(fft_size / 2 + 1)
                .map(|c| c.norm_sqr())
                .collect()
        }
        fn stereo(input: &[f32], fft_size: usize) -> Vec<f32> {
            let left: Vec<_> = input
                .as_chunks::<CHANNELS>()
                .0
                .iter()
                .map(|f| f[0])
                .collect();
            let right: Vec<_> = input
                .as_chunks::<CHANNELS>()
                .0
                .iter()
                .map(|f| f[1])
                .collect();
            spectrum(&left, fft_size)
                .into_iter()
                .zip(spectrum(&right, fft_size))
                .map(|(l, r)| (l + r) * 0.5)
                .collect()
        }
        let n = raw.len().max(processed.len()) / CHANNELS;
        if n == 0 {
            return thresholds::OCTAVE_CENTER_HZ
                .iter()
                .map(|&band_hz| BandDeltaDb {
                    band_hz,
                    delta_db: 0.0,
                })
                .collect();
        }
        let size = next_pow2(n);
        band_deltas_from_spectra(&stereo(raw, size), &stereo(processed, size), size, sr)
    }

    #[test]
    fn fft_plan_reuse_matches_baseline_and_plans_once_when_needed() {
        use std::cell::Cell;
        let sr = 48_000;
        for frames in [0, 1, 255, 256, 257, 4096] {
            let raw = sine_stereo(1000.0, sr, frames, 0.4);
            let mut processed = sine_stereo(3000.0, sr, frames, 0.2);
            for frame in processed.as_chunks_mut::<2>().0.iter_mut() {
                frame[1] *= -0.5;
            }
            let calls = Cell::new(0);
            let actual = octave_band_deltas_with_plan(&raw, &processed, sr, |size| {
                calls.set(calls.get() + 1);
                FftPlanner::new().plan_fft_forward(size)
            });
            let expected = baseline_band_deltas(&raw, &processed, sr);
            assert_eq!(calls.get(), usize::from(frames != 0 && raw != processed));
            for (actual, expected) in actual.iter().zip(&expected) {
                assert_eq!(actual.band_hz, expected.band_hz);
                assert!(
                    (actual.delta_db - expected.delta_db).abs() < 0.0001,
                    "frames={frames} band={} actual={} expected={}",
                    actual.band_hz,
                    actual.delta_db,
                    expected.delta_db
                );
            }
        }
    }

    #[test]
    fn identical_finite_recordings_preserve_band_deltas_without_fft() {
        for frames in [0, 1, 255, 256, 4096] {
            let mut audio = sine_stereo(1000.0, 48_000, frames, 0.4);
            for frame in audio.as_chunks_mut::<2>().0 {
                frame[1] *= -0.5;
            }
            let actual = octave_band_deltas_with_plan(&audio, &audio, 48_000, |_| {
                panic!("同一音の帯域差にFFTは不要");
            });
            let expected = baseline_band_deltas(&audio, &audio, 48_000);
            assert_eq!(actual.len(), expected.len());
            for (actual, expected) in actual.iter().zip(expected) {
                assert_eq!(actual.band_hz, expected.band_hz);
                assert_eq!(actual.delta_db, expected.delta_db);
                assert_eq!(actual.delta_db, 0.0);
            }
        }
    }

    #[test]
    fn fft_is_not_skipped_for_nonfinite_or_different_samples() {
        use std::cell::Cell;
        for (raw, processed) in [
            ([f32::INFINITY, 0.0], [f32::INFINITY, 0.0]),
            ([f32::NAN, 0.0], [f32::NAN, 0.0]),
            ([0.5, 0.5], [f32::from_bits(0.5f32.to_bits() + 1), 0.5]),
        ] {
            let calls = Cell::new(0);
            octave_band_deltas_with_plan(&raw, &processed, 48_000, |size| {
                calls.set(calls.get() + 1);
                FftPlanner::new().plan_fft_forward(size)
            });
            assert_eq!(calls.get(), 1);
        }
    }

    #[test]
    #[ignore = "手動の非RT FFT計測"]
    fn measure_fft_plan_reuse() {
        use std::{hint::black_box, time::Instant};
        let sr = 48_000;
        for (seconds, iterations) in [(1, 10), (30, 3)] {
            let raw = sine_stereo(440.0, sr, sr as usize * seconds, 0.3);
            let processed = sine_stereo(1000.0, sr, sr as usize * seconds, 0.2);
            let start = Instant::now();
            for _ in 0..iterations {
                black_box(baseline_band_deltas(
                    black_box(&raw),
                    black_box(&processed),
                    sr,
                ));
            }
            let baseline = start.elapsed();
            let start = Instant::now();
            for _ in 0..iterations {
                black_box(octave_band_deltas(
                    black_box(&raw),
                    black_box(&processed),
                    sr,
                ));
            }
            let reused = start.elapsed();
            eprintln!("FFT {seconds}s {iterations}回: 旧={baseline:?}, 再利用={reused:?}");
        }
    }

    #[test]
    fn stereo_energy_preserves_phase_and_single_channel() {
        let sr = 8_000;
        let frames = 8_000;
        let same = sine_stereo(1000.0, sr, frames, 0.4);
        let opposite: Vec<f32> = same
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|f| [f[0], -f[1]])
            .collect();
        let one_side: Vec<f32> = same
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|f| [f[0], 0.0])
            .collect();
        let scaled_same: Vec<f32> = same.iter().map(|s| s * 0.5).collect();
        let scaled_opposite: Vec<f32> = opposite.iter().map(|s| s * 0.5).collect();
        let scaled_one_side: Vec<f32> = one_side.iter().map(|s| s * 0.5).collect();
        let analyze = |raw: &[f32], processed: &[f32]| {
            analyze_voice_check_buffers(raw, processed, sr, &AnalysisContext::default())
        };
        let same_report = analyze(&same, &scaled_same);
        let opposite_report = analyze(&opposite, &scaled_opposite);
        let one_side_report = analyze(&one_side, &scaled_one_side);
        let expected_rms = linear_to_dbfs(0.2 / 2.0_f32.sqrt());
        assert!((same_report.loudness.rms_db - expected_rms).abs() < 0.01);
        assert!((opposite_report.loudness.rms_db - expected_rms).abs() < 0.01);
        assert!((one_side_report.loudness.rms_db - (expected_rms - 3.0103)).abs() < 0.01);
        assert!((one_side_report.loudness.peak_db - linear_to_dbfs(0.2)).abs() < 0.01);
        for report in [&same_report, &opposite_report, &one_side_report] {
            let band = report
                .band_delta_db
                .iter()
                .find(|b| b.band_hz == 1000)
                .unwrap();
            assert!(
                (band.delta_db + 6.0206).abs() < 0.01,
                "delta={}",
                band.delta_db
            );
            assert_eq!(report.dropouts.count, 0);
        }
    }

    #[test]
    fn stereo_clips_count_frames_and_channel_transitions() {
        let audio = [0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, -1.0, 1.0];
        let report = analyze_voice_check_buffers(&audio, &audio, 1000, &AnalysisContext::default());
        assert_eq!(report.clip.count, 2);
        assert_eq!(report.clip.positions_ms, vec![1, 4]);
        assert!((report.clip.ratio - 0.6).abs() < f32::EPSILON);
    }

    #[test]
    fn stereo_vad_noise_and_dropouts_do_not_cancel() {
        let sr = 1000;
        let mut raw = vec![0.0; 400 * CHANNELS];
        let mut processed = raw.clone();
        for i in 0..400 {
            let amplitude = if i < 200 { 0.004 } else { 0.2 };
            raw[i * 2] = amplitude;
            raw[i * 2 + 1] = -amplitude;
            processed[i * 2] = amplitude * if i < 200 { 0.5 } else { 1.0 };
            processed[i * 2 + 1] = -processed[i * 2];
        }
        let report = analyze_voice_check_buffers(&raw, &processed, sr, &AnalysisContext::default());
        assert!((report.noise_floor_db.raw - linear_to_dbfs(0.004)).abs() < 0.01);
        assert!((report.noise_floor_db.processed - linear_to_dbfs(0.002)).abs() < 0.01);
        assert!((report.snr_improvement_db - 6.0206).abs() < 0.01);
        assert_eq!(report.dropouts.count, 0);
        processed[300 * 2 + 1] = 0.8;
        let report = analyze_voice_check_buffers(&raw, &processed, sr, &AnalysisContext::default());
        assert_eq!(report.dropouts.count, 1);
        assert_eq!(report.dropouts.positions_ms, vec![300]);
    }

    #[test]
    fn stereo_silence_keeps_finite_baseline() {
        let silence = vec![0.0; 400];
        let report =
            analyze_voice_check_buffers(&silence, &silence, 1000, &AnalysisContext::default());
        assert_eq!(report.clip.count, 0);
        assert_eq!(report.clip.ratio, 0.0);
        assert_eq!(report.dropouts.count, 0);
        assert_eq!(report.loudness.rms_db, linear_to_dbfs(0.0));
        assert_eq!(report.loudness.peak_db, linear_to_dbfs(0.0));
        assert_eq!(report.noise_floor_db.raw, linear_to_dbfs(0.0));
        assert_eq!(report.snr_improvement_db, 0.0);
        assert!(report.band_delta_db.iter().all(|b| b.delta_db == 0.0));
    }

    #[test]
    fn detects_clipped_sine_wave() {
        let sr = 48_000u32;
        let frames = sr as usize;
        let mut processed = sine_stereo(440.0, sr, frames, 1.05);
        // クリップ相当のサンプルを明示的に挿入
        for i in (10_000..10_050).step_by(2) {
            processed[i] = 1.0;
            processed[i + 1] = -1.0;
        }
        let raw = sine_stereo(440.0, sr, frames, 0.5);

        let report = analyze_voice_check_buffers(&raw, &processed, sr, &AnalysisContext::default());
        assert!(report.clip.count >= 1, "clip count={}", report.clip.count);
        assert!(report.clip.ratio > 0.0);
        assert!(!report.clip.positions_ms.is_empty());
    }

    #[test]
    fn noise_floor_matches_expected_level() {
        let sr = 48_000u32;
        let frames = sr as usize * 2;
        let noise_amp = 0.006f32;
        let mut mono = vec![0.0f32; frames];
        for (i, sample) in mono.iter_mut().enumerate() {
            let n = ((i as f32 * 12_989.0).sin() * 43_758.547).fract() * 2.0 - 1.0;
            *sample = n * noise_amp;
        }
        let raw: Vec<f32> = mono.iter().flat_map(|&s| [s, s]).collect();
        let processed: Vec<f32> = mono.iter().flat_map(|&s| [s * 0.5, s * 0.5]).collect();

        let rms = (mono.iter().map(|s| s * s).sum::<f32>() / mono.len() as f32).sqrt();
        let expected = linear_to_dbfs(rms);

        let report = analyze_voice_check_buffers(&raw, &processed, sr, &AnalysisContext::default());
        assert!(
            (report.noise_floor_db.raw - expected).abs() < 1.5,
            "raw floor={} expected~{}",
            report.noise_floor_db.raw,
            expected
        );
        assert!(report.noise_floor_db.processed < report.noise_floor_db.raw);
    }

    #[test]
    fn detects_inserted_dropouts() {
        let sr = 48_000u32;
        let frames = sr as usize;
        let mut mono = vec![0.0f32; frames];
        inject_speech_burst(&mut mono, 1000, 4000, 0.2, sr);
        for &pos in &[20_000usize, 30_000, 40_000] {
            if pos + 1 < mono.len() {
                mono[pos] = 0.9;
                mono[pos + 1] = -0.85;
            }
        }
        let interleaved: Vec<f32> = mono.iter().flat_map(|&s| [s, s]).collect();

        let report = analyze_voice_check_buffers(
            &interleaved,
            &interleaved,
            sr,
            &AnalysisContext::default(),
        );
        assert!(
            report.dropouts.count >= 2,
            "dropouts={}",
            report.dropouts.count
        );
        assert!(report.dropouts.positions_ms.len() >= 2);
    }

    #[test]
    fn high_band_attenuation_detected() {
        let sr = 48_000u32;
        let frames = sr as usize * 2;
        let raw = sine_stereo(6000.0, sr, frames, 0.4);
        // 低域のみ残す（高音減衰を模擬）
        let processed = sine_stereo(200.0, sr, frames, 0.4);

        let report = analyze_voice_check_buffers(&raw, &processed, sr, &AnalysisContext::default());
        let high = report
            .band_delta_db
            .iter()
            .find(|b| b.band_hz >= 4000)
            .expect("4k band");
        assert!(high.delta_db < -3.0, "high band delta={}", high.delta_db);
        assert!(report
            .advices
            .iter()
            .any(|a| a.message_key == "high_freq_attenuation"));
    }

    #[test]
    fn snr_improves_when_noise_reduced() {
        let sr = 48_000u32;
        let frames = sr as usize * 4;
        let mut mono_raw = vec![0.0f32; frames];
        let mut mono_proc = vec![0.0f32; frames];
        let noise_hi = 0.01f32;
        let noise_lo = 0.002f32;

        for i in 0..frames {
            let in_speech = i >= sr as usize * 2 && i < sr as usize * 3;
            if !in_speech {
                mono_raw[i] = noise_hi;
                mono_proc[i] = noise_lo;
            }
        }
        inject_speech_burst(&mut mono_raw, sr as usize * 2, sr as usize, 0.45, sr);
        inject_speech_burst(&mut mono_proc, sr as usize * 2, sr as usize, 0.45, sr);

        let raw: Vec<f32> = mono_raw.iter().flat_map(|&s| [s, s]).collect();
        let processed: Vec<f32> = mono_proc.iter().flat_map(|&s| [s, s]).collect();

        let report = analyze_voice_check_buffers(&raw, &processed, sr, &AnalysisContext::default());
        assert!(
            report.noise_floor_db.processed < report.noise_floor_db.raw,
            "raw={} proc={}",
            report.noise_floor_db.raw,
            report.noise_floor_db.processed
        );
        assert!(
            report.snr_improvement_db > 0.5,
            "snr improvement={}",
            report.snr_improvement_db
        );
    }

    #[test]
    fn clean_signal_verdict_good() {
        let sr = 48_000u32;
        let frames = sr as usize;
        let raw = sine_stereo(440.0, sr, frames, 0.15);
        let processed = sine_stereo(440.0, sr, frames, 0.14);
        let report = analyze_voice_check_buffers(&raw, &processed, sr, &AnalysisContext::default());
        assert_eq!(report.verdict, "good");
        assert!(report.clip.count == 0);
    }

    #[test]
    fn clip_advice_preserves_nan_infinities_and_boundary_rounding() {
        for (ratio, expected) in [
            (f32::NAN, 12.0_f32),
            (f32::INFINITY, 12.0),
            (f32::NEG_INFINITY, 3.0),
            (-0.0, 3.0),
            (0.0, 3.0),
            (-1.0, 3.0),
            (0.1, 5.0),
            (0.45, 12.0),
            (0.450_000_02, 12.0),
            (1.0, 12.0),
        ] {
            assert_eq!(clip_gain_reduction_db(ratio).to_bits(), expected.to_bits());
        }
        // ノイズ生成のテスト用定数もf32では同じビット列。
        assert_eq!(43_758.547_f32.to_bits(), 0x472a_ee8c);
    }
}
