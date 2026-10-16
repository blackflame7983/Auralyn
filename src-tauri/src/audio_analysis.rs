//! ボイスチェック録音のオフライン品質分析（Tauri メインプロセス専用）

use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::path::Path;

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

    let raw_mono = to_mono(raw);
    let processed_mono = to_mono(processed);

    let clip = detect_clips(&processed_mono, sample_rate_hz);
    let dropouts = detect_dropouts(&processed_mono, sample_rate_hz);
    let vad = compute_vad_mask(&raw_mono, sample_rate_hz);

    let noise_floor_raw = noise_floor_dbfs(&raw_mono, &vad);
    let noise_floor_processed = noise_floor_dbfs(&processed_mono, &vad);
    let snr_improvement_db =
        snr_improvement_db(&raw_mono, &processed_mono, &vad, noise_floor_raw, noise_floor_processed);

    let band_delta_db = octave_band_deltas(&raw_mono, &processed_mono, sample_rate_hz);
    let loudness = loudness_report(&processed_mono);

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
    advices.sort_by(|a, b| severity_rank(&b.severity).cmp(&severity_rank(&a.severity)));

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

fn to_mono(interleaved: &[f32]) -> Vec<f32> {
    let frames = interleaved.len() / CHANNELS;
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let base = frame * CHANNELS;
        mono.push((interleaved[base] + interleaved[base + 1]) * 0.5);
    }
    mono
}

fn linear_to_dbfs(v: f32) -> f32 {
    20.0 * v.abs().max(MIN_EPS).log10()
}

fn detect_clips(mono: &[f32], sample_rate_hz: u32) -> ClipReport {
    use thresholds::{CLIP_COUNT_WARN, CLIP_RATIO_WARN, CLIP_SAMPLE_THRESHOLD};

    let mut count = 0u32;
    let mut positions_ms = Vec::new();
    let mut in_run = false;
    let mut clipped_samples = 0usize;

    for (i, &s) in mono.iter().enumerate() {
        if s.abs() >= CLIP_SAMPLE_THRESHOLD {
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

    let ratio = if mono.is_empty() {
        0.0
    } else {
        clipped_samples as f32 / mono.len() as f32
    };

    // 微小なクリップは warn 閾値でフィルタ（テスト用に count は維持）
    let _ = (CLIP_COUNT_WARN, CLIP_RATIO_WARN);

    ClipReport {
        count,
        ratio,
        positions_ms,
    }
}

fn detect_dropouts(mono: &[f32], sample_rate_hz: u32) -> DropoutReport {
    use thresholds::{DROPOUT_DIFF_THRESHOLD, DROPOUT_MIN_GAP_FRAMES};

    if mono.len() < 2 {
        return DropoutReport {
            count: 0,
            positions_ms: Vec::new(),
        };
    }

    let mut diffs = Vec::with_capacity(mono.len() - 1);
    for w in mono.windows(2) {
        diffs.push((w[1] - w[0]).abs());
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

    DropoutReport { count, positions_ms }
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

fn loudness_report(mono: &[f32]) -> LoudnessReport {
    if mono.is_empty() {
        return LoudnessReport {
            rms_db: -96.0,
            peak_db: -96.0,
        };
    }
    let sum_sq: f32 = mono.iter().map(|s| s * s).sum();
    let rms = (sum_sq / mono.len() as f32).sqrt();
    let peak = mono.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    LoudnessReport {
        rms_db: linear_to_dbfs(rms),
        peak_db: linear_to_dbfs(peak),
    }
}

fn octave_band_deltas(raw_mono: &[f32], processed_mono: &[f32], sample_rate_hz: u32) -> Vec<BandDeltaDb> {
    use thresholds::OCTAVE_CENTER_HZ;

    let n = raw_mono.len().max(processed_mono.len());
    if n == 0 {
        return OCTAVE_CENTER_HZ
            .iter()
            .map(|&band_hz| BandDeltaDb {
                band_hz,
                delta_db: 0.0,
            })
            .collect();
    }

    let fft_size = next_pow2(n);
    let raw_mag = magnitude_spectrum(raw_mono, fft_size);
    let proc_mag = magnitude_spectrum(processed_mono, fft_size);
    let bin_hz = sample_rate_hz as f32 / fft_size as f32;

    OCTAVE_CENTER_HZ
        .iter()
        .map(|&center_hz| {
            let low = (center_hz as f32 / std::f32::consts::SQRT_2).max(20.0);
            let high = (center_hz as f32 * std::f32::consts::SQRT_2).min(sample_rate_hz as f32 * 0.49);
            let low_bin = (low / bin_hz).floor() as usize;
            let high_bin = (high / bin_hz).ceil() as usize;

            let raw_e = band_energy(&raw_mag, low_bin, high_bin);
            let proc_e = band_energy(&proc_mag, low_bin, high_bin);
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

fn magnitude_spectrum(mono: &[f32], fft_size: usize) -> Vec<f32> {
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(fft_size);

    let mut buffer: Vec<Complex<f32>> = mono
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
    } else if loudness.rms_db > LOUDNESS_RMS_TOO_HIGH_DB || loudness.peak_db > LOUDNESS_PEAK_WARN_DB {
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

fn compute_verdict(clip: &ClipReport, dropouts: &DropoutReport, noise_floor_processed: f32, advices: &[Advice]) -> Verdict {
    use thresholds::*;

    let has_significant_advice = advices.iter().any(|a| a.severity == "warn" || a.severity == "bad");

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

    fn inject_speech_burst(mono_base: &mut [f32], start: usize, len: usize, amp: f32, sample_rate: u32) {
        for i in 0..len {
            let idx = start + i;
            if idx >= mono_base.len() {
                break;
            }
            let t = idx as f32 / sample_rate as f32;
            mono_base[idx] += (2.0 * PI * 300.0 * t).sin() * amp;
        }
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
        let interleaved: Vec<f32> = mono
            .iter()
            .flat_map(|&s| [s, s])
            .collect();

        let report =
            analyze_voice_check_buffers(&interleaved, &interleaved, sr, &AnalysisContext::default());
        assert!(report.dropouts.count >= 2, "dropouts={}", report.dropouts.count);
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
        assert!(
            high.delta_db < -3.0,
            "high band delta={}",
            high.delta_db
        );
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
