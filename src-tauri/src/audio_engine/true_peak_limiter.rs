//! 配信用 sink 向けの先読み true-peak 制限。
//!
//! サンプルピーク保護（`peak_protection`）とは別物で、遅延のある経路だけに使う。
//! 4倍の短い Hann 窓 sinc でサンプル間の山を見積もり、その山が出力へ届く前に
//! 減衰を終える。係数はここで独自に作る。測定試験の長い 8倍 Blackman とは
//! 配列も窓も次数も共有しない。
//!
//! ON/OFF で遅延が変わるときは、短いフェードアウトのあと遅延線を消してから
//! フェードインする。消す前の音を、新しい遅延の先から出さない。
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

const TAPS: usize = 16;
const ANALYZED: usize = 7;
const FUTURE: usize = 8;
const PHASES: [f64; 3] = [0.25, 0.5, 0.75];
/// 短い FIR が見落としやすい分を、検出側の天井だけ少し下げる。
/// 出力の保証値は設定した天井で測る。この係数は外部実装から写していない。
const GUARD_DB: f32 = 0.40;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub ceiling_db: f32,
    pub release_ms: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            ceiling_db: -1.0,
            release_ms: 100.0,
        }
    }
}

impl Config {
    pub fn validate(self) -> Result<Self, String> {
        if !self.ceiling_db.is_finite()
            || !(-12.0..=-0.1).contains(&self.ceiling_db)
            || !self.release_ms.is_finite()
            || !(20.0..=1000.0).contains(&self.release_ms)
        {
            return Err("配信用 true-peak 制限の天井または復帰時間を確認してください".into());
        }
        Ok(self)
    }

    pub(crate) fn prepare(self, rate: u32) -> Prepared {
        let rate = rate.max(1);
        Prepared {
            enabled: self.enabled,
            ceiling: 10.0f32.powf(self.ceiling_db / 20.0),
            release: (-1.0 / (rate as f32 * self.release_ms / 1000.0)).exp(),
            ramp: 1.0 / (rate as f32 * 0.005).max(1.0),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Prepared {
    enabled: bool,
    ceiling: f32,
    release: f32,
    ramp: f32,
}

/// 48 kHz で約 1 ms。レートに比例し、フィルタが収まる長さを下回らない。
/// すべてのレートで 0.5 ms とは限らない。
pub(crate) fn lookahead_samples(rate: u32) -> u32 {
    let proportional = (f64::from(rate.max(1)) * 0.001).round() as u32;
    proportional.max((FUTURE + TAPS) as u32)
}

pub(crate) fn lookahead_ms(rate: u32) -> f64 {
    f64::from(lookahead_samples(rate)) * 1000.0 / f64::from(rate.max(1))
}

pub(crate) struct Shared {
    revision: AtomicU64,
    enabled: AtomicBool,
    ceiling: AtomicU32,
    release: AtomicU32,
    ramp: AtomicU32,
    applied: AtomicU64,
    minimum_gain: AtomicU32,
}

impl Default for Shared {
    fn default() -> Self {
        let prepared = Config::default().prepare(48_000);
        Self {
            revision: AtomicU64::new(0),
            enabled: AtomicBool::new(prepared.enabled),
            ceiling: AtomicU32::new(prepared.ceiling.to_bits()),
            release: AtomicU32::new(prepared.release.to_bits()),
            ramp: AtomicU32::new(prepared.ramp.to_bits()),
            applied: AtomicU64::new(0),
            minimum_gain: AtomicU32::new(1.0f32.to_bits()),
        }
    }
}

impl Shared {
    pub(crate) fn publish(&self, prepared: Prepared) -> u64 {
        let revision = self.revision.load(Ordering::SeqCst).saturating_add(2);
        self.revision.store(revision - 1, Ordering::SeqCst);
        self.enabled.store(prepared.enabled, Ordering::SeqCst);
        self.ceiling
            .store(prepared.ceiling.to_bits(), Ordering::SeqCst);
        self.release
            .store(prepared.release.to_bits(), Ordering::SeqCst);
        self.ramp.store(prepared.ramp.to_bits(), Ordering::SeqCst);
        self.revision.store(revision, Ordering::SeqCst);
        revision
    }

    fn read(&self) -> Option<(u64, Prepared)> {
        let revision = self.revision.load(Ordering::SeqCst);
        if revision & 1 != 0 {
            return None;
        }
        let prepared = Prepared {
            enabled: self.enabled.load(Ordering::SeqCst),
            ceiling: f32::from_bits(self.ceiling.load(Ordering::SeqCst)),
            release: f32::from_bits(self.release.load(Ordering::SeqCst)),
            ramp: f32::from_bits(self.ramp.load(Ordering::SeqCst)),
        };
        (revision == self.revision.load(Ordering::SeqCst)).then_some((revision, prepared))
    }

    pub(crate) fn pending(&self) -> bool {
        self.applied.load(Ordering::Acquire) != self.revision.load(Ordering::Acquire)
    }

    pub(crate) fn status(
        &self,
        config: Config,
        running: bool,
        sink_active: bool,
        rate: u32,
    ) -> Snapshot {
        let minimum = f32::from_bits(self.minimum_gain.swap(1.0f32.to_bits(), Ordering::AcqRel));
        Snapshot {
            config,
            running,
            pending: running && sink_active && self.pending(),
            revision: self.revision.load(Ordering::Acquire).to_string(),
            reduction_db: -20.0 * minimum.max(1.0e-12).log10(),
            added_latency_samples: if config.enabled {
                lookahead_samples(rate)
            } else {
                0
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub config: Config,
    pub running: bool,
    pub pending: bool,
    pub revision: String,
    pub reduction_db: f32,
    pub added_latency_samples: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Stable,
    FadeOut,
    /// 遅延を消したあと、新しい音で先読みを埋める間は無音にする。
    Prime,
    FadeIn,
}

pub(crate) struct Rt {
    #[cfg_attr(not(test), allow(dead_code))]
    rate: u32,
    lookahead: usize,
    coeff: [[f32; TAPS]; 3],
    guard: f32,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    pos: usize,
    hist_l: [f32; TAPS],
    hist_r: [f32; TAPS],
    seen: u32,
    gain: f32,
    attack_step: f32,
    attack_left: u32,
    ceiling: f32,
    applied_ceiling: f32,
    release: f32,
    ramp: f32,
    fade_step: f32,
    fade: f32,
    prime_left: u32,
    stage: Stage,
    wet: bool,
    target_enabled: bool,
    revision: u64,
    minimum: f32,
}

impl Rt {
    pub(crate) fn new(config: Config, rate: u32) -> Self {
        let prepared = config.prepare(rate);
        let lookahead = lookahead_samples(rate) as usize;
        let mut coeff = [[0.0f32; TAPS]; 3];
        for (phase, frac) in PHASES.iter().enumerate() {
            coeff[phase] = design_hann_phase(*frac);
        }
        Self {
            rate,
            lookahead,
            coeff,
            guard: 10.0f32.powf(-GUARD_DB / 20.0),
            delay_l: vec![0.0; lookahead],
            delay_r: vec![0.0; lookahead],
            pos: 0,
            hist_l: [0.0; TAPS],
            hist_r: [0.0; TAPS],
            seen: 0,
            gain: 1.0,
            attack_step: 0.0,
            attack_left: 0,
            ceiling: prepared.ceiling,
            applied_ceiling: prepared.ceiling,
            release: prepared.release,
            ramp: prepared.ramp,
            fade_step: 2.0 / lookahead.max(2) as f32,
            fade: 1.0,
            prime_left: 0,
            stage: Stage::Stable,
            wet: prepared.enabled,
            target_enabled: prepared.enabled,
            revision: 0,
            minimum: 1.0,
        }
    }

    /// 今の経路の遅延。バイパス中は 0。試験と、切替途中の実遅延の確認に使う。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn added_latency_samples(&self) -> u32 {
        if self.wet {
            self.lookahead as u32
        } else {
            0
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + (self.delay_l.capacity() + self.delay_r.capacity()) * std::mem::size_of::<f32>()
    }

    pub(crate) fn sync(&mut self, shared: &Shared) {
        if let Some((revision, prepared)) = shared.read() {
            self.revision = revision;
            self.ceiling = prepared.ceiling;
            self.release = prepared.release;
            self.ramp = prepared.ramp;
            self.target_enabled = prepared.enabled;
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn apply_config(&mut self, config: Config) {
        let prepared = config.prepare(self.rate);
        self.ceiling = prepared.ceiling;
        self.release = prepared.release;
        self.ramp = prepared.ramp;
        self.target_enabled = prepared.enabled;
    }

    /// 停止から再開するとき、サンプルをまたいでフェードしてから遅延を消す。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn request_reset(&mut self) {
        if self.stage != Stage::FadeOut {
            self.stage = Stage::FadeOut;
        }
    }

    /// 無音へ落ちた callback で、遅延に残った音を出さない。割当はしない。
    pub(crate) fn reset_audio(&mut self) {
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.hist_l = [0.0; TAPS];
        self.hist_r = [0.0; TAPS];
        self.pos = 0;
        self.seen = 0;
        self.gain = 1.0;
        self.attack_step = 0.0;
        self.attack_left = 0;
    }

    /// レート変更で作り直す。制御スレッド専用で、古いサンプルは持たない。
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn rebuild(&mut self, rate: u32) {
        let enabled = self.target_enabled;
        let ceiling_db = 20.0 * self.ceiling.max(1.0e-12).log10();
        let release_ms = release_ms_from_coeff(self.release, self.rate);
        *self = Self::new(
            Config {
                enabled,
                ceiling_db,
                release_ms,
            },
            rate,
        );
    }

    pub(crate) fn process(&mut self, sample: [f32; 2]) -> [f32; 2] {
        self.applied_ceiling = approach(self.applied_ceiling, self.ceiling, self.ramp);
        if (self.stage == Stage::Stable || self.stage == Stage::FadeIn)
            && self.wet != self.target_enabled
        {
            self.stage = Stage::FadeOut;
        }
        if self.stage == Stage::Stable && !self.wet {
            return sample;
        }
        let finite = sanitize(sample);
        if self.stage == Stage::Prime {
            let _ = self.process_wet(finite);
            self.prime_left = self.prime_left.saturating_sub(1);
            if self.prime_left == 0 {
                self.fade = 0.0;
                self.stage = Stage::FadeIn;
            }
            return [0.0; 2];
        }
        let wet = if self.wet || self.stage != Stage::Stable {
            self.process_wet(finite)
        } else {
            finite
        };
        match self.stage {
            Stage::Stable => wet,
            Stage::Prime => [0.0; 2],
            Stage::FadeOut => {
                self.fade = (self.fade - self.fade_step).max(0.0);
                let source = if self.wet { wet } else { finite };
                let faded = source.map(|value| value * self.fade);
                if self.fade <= 0.0 {
                    self.reset_audio();
                    self.wet = self.target_enabled;
                    if self.wet {
                        self.prime_left = self.lookahead as u32;
                        self.stage = Stage::Prime;
                    } else {
                        self.stage = Stage::FadeIn;
                    }
                }
                faded
            }
            Stage::FadeIn => {
                self.fade = (self.fade + self.fade_step).min(1.0);
                let source = if self.wet { wet } else { finite };
                if self.fade >= 1.0 {
                    self.fade = 1.0;
                    self.stage = Stage::Stable;
                }
                source.map(|value| value * self.fade)
            }
        }
    }

    pub(crate) fn report(&mut self, shared: &Shared) {
        shared
            .minimum_gain
            .fetch_min(self.minimum.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        self.minimum = 1.0;
        if self.stage == Stage::Stable
            && self.wet == self.target_enabled
            && (self.applied_ceiling - self.ceiling).abs() < 1.0e-5
        {
            shared.applied.store(self.revision, Ordering::Release);
        }
    }

    fn process_wet(&mut self, sample: [f32; 2]) -> [f32; 2] {
        let delayed = [self.delay_l[self.pos], self.delay_r[self.pos]];
        self.push_hist(sample);
        self.seen = self.seen.saturating_add(1);
        // 先読みの未来側が揃ったサンプルから検出する。バッファ全体を待たない。
        let need = if self.seen > FUTURE as u32 {
            let ceiling = self.applied_ceiling * self.guard;
            let peak = self.estimate();
            let need = if peak <= ceiling {
                1.0
            } else {
                (ceiling / peak).clamp(0.0, 1.0)
            };
            self.retune(need);
            Some(need)
        } else {
            None
        };
        self.advance_gain(need);
        self.delay_l[self.pos] = sample[0];
        self.delay_r[self.pos] = sample[1];
        self.pos += 1;
        if self.pos == self.lookahead {
            self.pos = 0;
        }
        let gain = self.gain;
        self.minimum = self.minimum.min(gain);
        delayed.map(|value| value * gain)
    }

    fn retune(&mut self, need: f32) {
        // 山が出力へ届くより少し前に減衰を終える。
        let deadline = self.lookahead.saturating_sub(FUTURE + 8).max(1) as u32;
        if need + 1.0e-6 < self.gain {
            let projected = self.gain - self.attack_step * deadline as f32;
            if self.attack_left == 0 || need < projected - 1.0e-5 {
                self.attack_step = (self.gain - need) / deadline as f32;
                self.attack_left = deadline;
            }
        }
    }

    fn advance_gain(&mut self, need: Option<f32>) {
        if self.attack_left > 0 {
            self.gain = (self.gain - self.attack_step).max(0.0);
            self.attack_left -= 1;
            if self.attack_left == 0 {
                self.attack_step = 0.0;
            }
            return;
        }
        if let Some(need) = need {
            // 必要な減衰より速く戻さない。山が続いている間は need で頭を押さえる。
            let released = 1.0 - (1.0 - self.gain) * self.release;
            self.gain = released.min(need).clamp(0.0, 1.0);
        }
    }

    fn push_hist(&mut self, sample: [f32; 2]) {
        for index in 0..TAPS - 1 {
            self.hist_l[index] = self.hist_l[index + 1];
            self.hist_r[index] = self.hist_r[index + 1];
        }
        self.hist_l[TAPS - 1] = sample[0];
        self.hist_r[TAPS - 1] = sample[1];
    }

    fn estimate(&self) -> f32 {
        let mut peak = self.hist_l[ANALYZED].abs().max(self.hist_r[ANALYZED].abs());
        for phase in &self.coeff {
            let left: f32 = self
                .hist_l
                .iter()
                .zip(phase)
                .map(|(sample, coeff)| sample * coeff)
                .sum();
            let right: f32 = self
                .hist_r
                .iter()
                .zip(phase)
                .map(|(sample, coeff)| sample * coeff)
                .sum();
            peak = peak.max(left.abs()).max(right.abs());
        }
        if peak.is_finite() {
            peak
        } else {
            0.0
        }
    }
}

fn approach(current: f32, target: f32, step: f32) -> f32 {
    current + (target - current).clamp(-step, step)
}

fn sanitize(sample: [f32; 2]) -> [f32; 2] {
    sample.map(|value| if value.is_finite() { value } else { 0.0 })
}

fn design_hann_phase(frac: f64) -> [f32; TAPS] {
    let mut sum = 0.0f64;
    let mut windowed = [0.0f64; TAPS];
    let width = (TAPS - 1) as f64;
    for (index, slot) in windowed.iter_mut().enumerate() {
        let offset = index as f64 - ANALYZED as f64 - frac;
        let hann = 0.5 - 0.5 * (std::f64::consts::TAU * index as f64 / width).cos();
        let value = hann_sinc(offset) * hann;
        *slot = value;
        sum += value;
    }
    let scale = if sum.abs() < 1.0e-18 { 1.0 } else { 1.0 / sum };
    let mut coeff = [0.0f32; TAPS];
    for (slot, value) in coeff.iter_mut().zip(windowed) {
        *slot = (value * scale) as f32;
    }
    coeff
}

fn hann_sinc(offset: f64) -> f64 {
    if offset.abs() < 1.0e-12 {
        1.0
    } else {
        (std::f64::consts::PI * offset).sin() / (std::f64::consts::PI * offset)
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn release_ms_from_coeff(release: f32, rate: u32) -> f32 {
    let denom = -(rate.max(1) as f32) * release.clamp(1.0e-6, 0.999_999).ln();
    if denom.is_finite() && denom > 0.0 {
        (1000.0 / denom).clamp(20.0, 1000.0)
    } else {
        100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    fn enabled(rate: u32) -> Rt {
        Rt::new(
            Config {
                enabled: true,
                ceiling_db: -1.0,
                release_ms: 100.0,
            },
            rate,
        )
    }

    #[test]
    fn meter_matches_the_analytic_quarter_cycle_peak_and_a_low_sine() {
        let mut meter = TruePeakMeter::new();
        let mut hot = 0.0f64;
        let mut quiet_peak = 0.0f64;
        for index in 0..16_384 {
            let quarter =
                (std::f64::consts::PI * index as f64 / 2.0 + std::f64::consts::FRAC_PI_4).sin();
            let peak = meter.push(quarter);
            if index > 512 {
                hot = hot.max(peak);
            }
        }
        let mut low = TruePeakMeter::new();
        for index in 0..16_384 {
            let sine = (2.0 * std::f64::consts::PI * 100.0 * index as f64 / 48_000.0).sin();
            let peak = low.push(sine);
            if index > 512 {
                quiet_peak = quiet_peak.max(peak);
            }
        }
        let hot_db = 20.0 * hot.log10();
        assert!(
            hot_db.abs() < 0.05,
            "fs/4 45° の真の山は 0 dBFS のはずですが、測定器は {hot_db:.3} dB ({hot:.5}) でした"
        );
        let low_db = 20.0 * quiet_peak.log10();
        assert!(
            low_db.abs() < 0.05,
            "低い正弦の true-peak はサンプルピークにほぼ一致するはずですが {low_db:.3} dB でした"
        );
    }

    #[test]
    fn lookahead_scales_with_rate_and_bypass_adds_no_delay() {
        for (rate, samples) in [(44_100, 44u32), (48_000, 48), (96_000, 96), (192_000, 192)] {
            assert_eq!(lookahead_samples(rate), samples.max((FUTURE + TAPS) as u32));
            let mut bypass = Rt::new(Config::default(), rate);
            assert_eq!(bypass.added_latency_samples(), 0);
            assert_eq!(bypass.process([0.2, -0.4]), [0.2, -0.4]);
            let limited = enabled(rate);
            assert_eq!(limited.added_latency_samples(), lookahead_samples(rate));
            let ms = lookahead_ms(rate);
            assert!((ms - 1.0).abs() < 0.05, "{rate} Hz の先読みは {ms:.3} ms");
        }
    }

    #[test]
    fn under_ceiling_sine_stays_aligned_and_hot_quarter_cycle_beats_sample_peak() {
        let rate = 48_000u32;
        let ceiling = 10.0f32.powf(-1.0 / 20.0) as f64;
        let quiet = render_sine(1_000.0, -20.0, 0.0, rate, Processor::Candidate);
        let latency = lookahead_samples(rate) as usize;
        let mut error = 0.0f64;
        for index in latency + 64..quiet.output.len() {
            error = error.max((quiet.output[index] - quiet.input[index - latency]).abs());
        }
        assert!(error < 1.0e-4, "天井未満の誤差 {error}");

        let bare = render_quarter(2.0, rate, Processor::Bare);
        let sample = render_quarter(2.0, rate, Processor::SamplePeak);
        let candidate = render_quarter(2.0, rate, Processor::Candidate);
        assert!(
            bare.overshoot_db > 6.0,
            "保護なしの fs/4 は大きく超えるはずです: {:.3}",
            bare.overshoot_db
        );
        assert!(
            sample.overshoot_db > 2.5,
            "fs/4 45° では sample-peak 後も約 +3 dB 残ります: {:.3}",
            sample.overshoot_db
        );
        assert!(
            candidate.overshoot_db <= 0.1,
            "候補の超過 {:.3} dB は 0.1 dB を超えています",
            candidate.overshoot_db
        );
        assert!(
            candidate.overshoot_db + 2.0 < sample.overshoot_db,
            "候補 {:.3} dB、サンプルピーク {:.3} dB",
            candidate.overshoot_db,
            sample.overshoot_db
        );
        for rate in [44_100u32, 96_000, 192_000] {
            let sample = render_quarter(2.0, rate, Processor::SamplePeak);
            let candidate = render_quarter(2.0, rate, Processor::Candidate);
            assert!(
                sample.overshoot_db > 2.0,
                "{rate} Hz の sample-peak 超過 {:.3} dB",
                sample.overshoot_db
            );
            assert!(
                candidate.overshoot_db <= 0.1,
                "{rate} Hz の候補超過 {:.3} dB",
                candidate.overshoot_db
            );
        }
        assert!(candidate.output.iter().all(|value| value.is_finite()));
        let _ = ceiling;
    }

    #[test]
    fn switches_ceiling_rate_and_restart_do_not_click_or_replay_old_audio() {
        let mut rt = enabled(48_000);
        let mut previous = 0.0f32;
        for _ in 0..2_000 {
            previous = rt.process([0.75, 0.75])[0];
        }
        let mut worst = 0.0f32;
        rt.apply_config(Config {
            enabled: false,
            ceiling_db: -1.0,
            release_ms: 100.0,
        });
        let mut tail = Vec::new();
        for index in 0..1_200 {
            let sample = rt.process([0.75, 0.75])[0];
            worst = worst.max((sample - previous).abs());
            previous = sample;
            if index > 800 {
                tail.push(sample);
            }
        }
        assert!(worst < 0.05, "ON→OFF の隣接差 {worst}");
        assert!(
            tail.iter().all(|value| (*value - 0.75).abs() < 1.0e-3),
            "OFF 後は遅延なしの入力そのものになるはずです"
        );

        worst = 0.0;
        rt.apply_config(Config {
            enabled: true,
            ceiling_db: -1.0,
            release_ms: 100.0,
        });
        for _ in 0..2_000 {
            let sample = rt.process([0.75, 0.75])[0];
            worst = worst.max((sample - previous).abs());
            previous = sample;
        }
        assert!(worst < 0.05, "OFF→ON の隣接差 {worst}");

        for _ in 0..500 {
            previous = rt.process([0.95, 0.95])[0];
        }
        worst = 0.0;
        rt.apply_config(Config {
            enabled: true,
            ceiling_db: -6.0,
            release_ms: 100.0,
        });
        for _ in 0..2_000 {
            let sample = rt.process([0.95, 0.95])[0];
            worst = worst.max((sample - previous).abs());
            previous = sample;
        }
        assert!(worst < 0.05, "天井変更の隣接差 {worst}");

        worst = 0.0;
        rt.request_reset();
        let mut restarted = Vec::new();
        for index in 0..1_200 {
            let sample = rt.process([0.0, 0.0])[0];
            worst = worst.max((sample - previous).abs());
            previous = sample;
            if index > 800 {
                restarted.push(sample.abs());
            }
        }
        assert!(worst < 0.05, "再開フェードの隣接差 {worst}");
        assert!(restarted.iter().all(|value| *value < 1.0e-4));

        for _ in 0..500 {
            rt.process([0.8, -0.2]);
        }
        rt.rebuild(96_000);
        let leaked = (0..400)
            .map(|_| rt.process([0.0, 0.0])[0].abs())
            .fold(0.0, f32::max);
        assert!(leaked < 1.0e-5, "レート変更後に古い音 {leaked}");
        assert_eq!(rt.added_latency_samples(), lookahead_samples(96_000));
    }

    #[test]
    fn processing_reports_and_resets_allocate_nothing_and_stay_finite() {
        let shared = Shared::default();
        let mut rt = enabled(48_000);
        let counts = allocation_counts(|| {
            for index in 0..4_000u32 {
                let sample = if index == 10 {
                    [f32::NAN, f32::INFINITY]
                } else {
                    [(index as f32 * 0.01).sin(), 0.2]
                };
                let output = rt.process(sample);
                assert!(output.iter().all(|value| value.is_finite()));
                rt.sync(&shared);
                rt.report(&shared);
                if index == 100 {
                    rt.request_reset();
                }
                if index == 2_000 {
                    rt.reset_audio();
                }
            }
        });
        assert_eq!(counts, (0, 0));
        let mut hot = enabled(48_000);
        for _ in 0..4_000 {
            let output = hot.process([3.0, -2.0]);
            assert!(output
                .iter()
                .all(|value| value.is_finite() && value.abs() <= 1.0));
        }
    }

    #[test]
    fn stereo_link_keeps_ratio_and_rejects_bad_settings() {
        let mut rt = enabled(48_000);
        let mut left = Vec::new();
        let mut right = Vec::new();
        for index in 0..4_000 {
            let phase = std::f64::consts::PI * index as f64 / 2.0 + 0.4;
            let output = rt.process([(phase.sin() as f32) * 1.6, (phase.sin() as f32) * 0.8]);
            if index > 2_000 {
                left.push(output[0] as f64);
                right.push(output[1] as f64);
            }
        }
        let mut ratio_error = 0.0f64;
        for (l, r) in left.iter().zip(&right) {
            if l.abs() > 0.05 {
                ratio_error = ratio_error.max((r / l - 0.5).abs());
            }
        }
        assert!(ratio_error < 1.0e-3, "左右比のずれ {ratio_error}");
        let mut one_sided = enabled(48_000);
        for index in 0..2_000 {
            let sample = (std::f64::consts::PI * index as f64 / 2.0).sin() as f32 * 2.0;
            let output = one_sided.process([sample, 0.0]);
            assert_eq!(output[1], 0.0);
        }
        for config in [
            Config {
                ceiling_db: 0.0,
                ..Config::default()
            },
            Config {
                release_ms: f32::NAN,
                ..Config::default()
            },
            Config {
                release_ms: 10.0,
                ..Config::default()
            },
        ] {
            assert!(config.validate().is_err());
        }
    }

    #[test]
    fn evaluation_table_shows_a_clear_true_peak_reduction() {
        let rate = 48_000u32;
        let mut rows = Vec::new();
        let mut worst_candidate = f64::NEG_INFINITY;
        let mut weak_margin = f64::INFINITY;
        let mut clear_failures = 0u32;
        let mut push_row = |label: &str, metric: [Metric; 3]| {
            worst_candidate = worst_candidate.max(metric[2].overshoot_db);
            if metric[1].overshoot_db > 0.3 {
                clear_failures += 1;
                weak_margin = weak_margin.min(metric[1].overshoot_db - metric[2].overshoot_db);
            }
            rows.push(format!(
                "| {label} | {bare:.2} | {sample:.2} | {candidate:.2} | {exceed:.3} | {atten:.2} | {thd:.3} |",
                bare = metric[0].overshoot_db,
                sample = metric[1].overshoot_db,
                candidate = metric[2].overshoot_db,
                exceed = metric[2].exceed_ratio * 100.0,
                atten = metric[2].attenuation_db,
                thd = metric[2].thd,
            ));
        };
        push_row(
            "12 kHz (fs/4) / 45°",
            [
                render_quarter(1.8, rate, Processor::Bare),
                render_quarter(1.8, rate, Processor::SamplePeak),
                render_quarter(1.8, rate, Processor::Candidate),
            ],
        );
        for (freq, phase) in [
            (11_000.0, 0.0),
            (11_000.0, 45.0),
            (15_000.0, 20.0),
            (15_000.0, 75.0),
            (19_000.0, 10.0),
            (19_000.0, 45.0),
            (19_000.0, 90.0),
        ] {
            let bare = render_tone(freq, phase, 1.8, rate, Processor::Bare);
            let sample = render_tone(freq, phase, 1.8, rate, Processor::SamplePeak);
            let candidate = render_tone(freq, phase, 1.8, rate, Processor::Candidate);
            worst_candidate = worst_candidate.max(candidate.overshoot_db);
            if sample.overshoot_db > 0.3 {
                clear_failures += 1;
                weak_margin = weak_margin.min(sample.overshoot_db - candidate.overshoot_db);
            }
            rows.push(format!(
                "| {freq:.0} Hz / {phase:.0}° | {bare:.2} | {sample:.2} | {candidate:.2} | {exceed:.3} | {atten:.2} | {thd:.3} |",
                bare = bare.overshoot_db,
                sample = sample.overshoot_db,
                candidate = candidate.overshoot_db,
                exceed = candidate.exceed_ratio * 100.0,
                atten = candidate.attenuation_db,
                thd = candidate.thd,
            ));
        }
        let impulse = render_custom(&bandlimited_impulse(48_000), rate);
        let noise = render_custom(&bandlimited_noise(48_000), rate);
        let onset = render_custom(&sudden_onset(48_000), rate);
        let one_sided = render_custom(&one_sided_hot(48_000), rate);
        eprintln!("評価（48 kHz、天井 -1 dBFS、超過は測定器の true-peak）");
        eprintln!("| 信号 | 保護なし dB | sample-peak dB | 候補 dB | 候補の超過率 % | 候補の平均減衰 dB | 候補 THD |");
        for row in &rows {
            eprintln!("{row}");
        }
        for (name, metric) in [
            ("帯域制限インパルス", impulse),
            ("帯域制限雑音", noise),
            ("急な立上り", onset),
            ("左だけの過大音", one_sided),
        ] {
            eprintln!(
                "| {name} | {:.2} | {:.2} | {:.2} | {:.3} | {:.2} | {:.3} |",
                metric[0].overshoot_db,
                metric[1].overshoot_db,
                metric[2].overshoot_db,
                metric[2].exceed_ratio * 100.0,
                metric[2].attenuation_db,
                metric[2].thd
            );
            worst_candidate = worst_candidate.max(metric[2].overshoot_db);
            if metric[1].overshoot_db > 0.3 {
                clear_failures += 1;
                weak_margin = weak_margin.min(metric[1].overshoot_db - metric[2].overshoot_db);
            }
        }
        let mut latency = String::new();
        for rate in [44_100u32, 48_000, 96_000, 192_000] {
            let samples = lookahead_samples(rate);
            latency.push_str(&format!(
                "{rate} Hz: {samples} sample / {:.3} ms\n",
                lookahead_ms(rate)
            ));
        }
        eprintln!("{latency}");
        let memory = enabled(48_000).retained_bytes();
        eprintln!("保持メモリ（48 kHz）: {memory} bytes");
        assert!(
            worst_candidate <= 0.1,
            "最大超過 {worst_candidate:.3} dB。表は --nocapture を参照"
        );
        assert!(
            clear_failures > 0,
            "sample-peak が超過する比較信号がありません"
        );
        assert!(
            weak_margin > 0.5,
            "sample-peak が超過する信号での改善が小さいです: {weak_margin:.3} dB"
        );
        let _ = rows;
    }

    #[test]
    #[ignore]
    fn bench_one_second_against_sample_peak() {
        let rate = 48_000usize;
        let mut candidate = enabled(rate as u32);
        let mut sample = super::super::peak_protection::Rt::new(
            super::super::peak_protection::Config {
                enabled: true,
                ceiling_db: -1.0,
                release_ms: 100.0,
            },
            rate as u32,
        );
        let mut signal = vec![[0.0f32; 2]; rate];
        for (index, frame) in signal.iter_mut().enumerate() {
            let value =
                (2.0 * std::f64::consts::PI * 19_000.0 * index as f64 / rate as f64).sin() as f32;
            *frame = [value * 1.5, value * -1.2];
        }
        let candidate_time = time_processor(&mut signal, |frame| {
            candidate.process(frame);
        });
        let sample_time = time_processor(&mut signal, |frame| {
            sample.process(frame);
        });
        let ratio = candidate_time.as_secs_f64() / sample_time.as_secs_f64().max(1.0e-9);
        eprintln!(
            "1秒: 候補 {:?} / sample-peak {:?} / 比 {ratio:.2}",
            candidate_time, sample_time
        );
        assert!(ratio < 12.0, "CPU比 {ratio:.2}");
    }

    fn time_processor(
        signal: &mut [[f32; 2]],
        mut process: impl FnMut([f32; 2]),
    ) -> std::time::Duration {
        let start = std::time::Instant::now();
        for frame in signal.iter().copied() {
            process(std::hint::black_box(frame));
        }
        start.elapsed()
    }

    #[derive(Clone, Copy)]
    enum Processor {
        Bare,
        SamplePeak,
        Candidate,
    }

    struct Metric {
        overshoot_db: f64,
        exceed_ratio: f64,
        attenuation_db: f64,
        thd: f64,
        output: Vec<f64>,
        input: Vec<f64>,
    }

    fn render_sine(
        freq: f64,
        level_db: f64,
        phase_deg: f64,
        rate: u32,
        processor: Processor,
    ) -> Metric {
        let amplitude = 10.0f64.powf(level_db / 20.0);
        render_tone(freq, phase_deg, amplitude as f32, rate, processor)
    }

    fn render_quarter(amplitude: f32, rate: u32, processor: Processor) -> Metric {
        let input: Vec<[f32; 2]> = (0..8_192)
            .map(|index| {
                let value = (std::f64::consts::PI * index as f64 / 2.0
                    + std::f64::consts::FRAC_PI_4)
                    .sin() as f32
                    * amplitude;
                [value, value * 0.5]
            })
            .collect();
        measure(&input, rate, processor, Some(rate as f64 / 4.0))
    }

    fn render_tone(
        freq: f64,
        phase_deg: f64,
        amplitude: f32,
        rate: u32,
        processor: Processor,
    ) -> Metric {
        let input: Vec<[f32; 2]> = (0..8_192)
            .map(|index| {
                let phase = 2.0 * std::f64::consts::PI * freq * index as f64 / rate as f64
                    + phase_deg * std::f64::consts::PI / 180.0;
                let value = phase.sin() as f32 * amplitude;
                [value, -value]
            })
            .collect();
        measure(&input, rate, processor, Some(freq))
    }

    fn render_custom(input: &[[f32; 2]], rate: u32) -> [Metric; 3] {
        [
            measure(input, rate, Processor::Bare, None),
            measure(input, rate, Processor::SamplePeak, None),
            measure(input, rate, Processor::Candidate, None),
        ]
    }

    fn measure(input: &[[f32; 2]], rate: u32, processor: Processor, freq: Option<f64>) -> Metric {
        let mut meter = TruePeakMeter::new();
        let ceiling = 10.0f64.powf(-1.0 / 20.0);
        let latency = match processor {
            Processor::Candidate => lookahead_samples(rate) as usize,
            _ => 0,
        };
        let mut candidate = enabled(rate);
        let mut sample_peak = super::super::peak_protection::Rt::new(
            super::super::peak_protection::Config {
                enabled: true,
                ..Default::default()
            },
            rate,
        );
        let skip = latency + 128;
        let mut max_abs = 0.0f64;
        let mut exceed = 0u64;
        let mut points = 0u64;
        let mut output = Vec::with_capacity(input.len());
        let mut dry = Vec::with_capacity(input.len());
        let mut out_sq = 0.0f64;
        let mut in_sq = 0.0f64;
        let mut counted = 0u64;
        for (index, frame) in input.iter().enumerate() {
            let processed = match processor {
                Processor::Bare => *frame,
                Processor::SamplePeak => sample_peak.process(*frame),
                Processor::Candidate => candidate.process(*frame),
            };
            output.push(processed[0] as f64);
            dry.push(frame[0] as f64);
            if index < skip {
                meter.push(processed[0] as f64);
                continue;
            }
            let oversampled = meter.push_points(processed[0] as f64);
            for value in oversampled {
                max_abs = max_abs.max(value.abs());
                points += 1;
                if value.abs() > ceiling * 10.0f64.powf(0.001 / 20.0) {
                    exceed += 1;
                }
            }
            let aligned = input[index - latency][0] as f64;
            out_sq += (processed[0] as f64) * (processed[0] as f64);
            in_sq += aligned * aligned;
            counted += 1;
        }
        let overshoot_db = if max_abs > 0.0 {
            20.0 * (max_abs / ceiling).log10()
        } else {
            -120.0
        };
        let attenuation_db = if counted > 0 && in_sq > 0.0 {
            10.0 * (out_sq / in_sq).log10()
        } else {
            0.0
        };
        Metric {
            overshoot_db,
            exceed_ratio: if points == 0 {
                0.0
            } else {
                exceed as f64 / points as f64
            },
            attenuation_db,
            thd: freq
                .map(|freq| residual_ratio(&output[skip..], freq, rate))
                .unwrap_or(0.0),
            output,
            input: dry,
        }
    }

    fn residual_ratio(output: &[f64], freq: f64, rate: u32) -> f64 {
        if output.len() < 32 {
            return 0.0;
        }
        let mut sin_energy = 0.0;
        let mut cos_energy = 0.0;
        let mut cross = 0.0;
        let mut sin_proj = 0.0;
        let mut cos_proj = 0.0;
        for (index, value) in output.iter().enumerate() {
            let angle = 2.0 * std::f64::consts::PI * freq * index as f64 / f64::from(rate);
            let sine = angle.sin();
            let cosine = angle.cos();
            sin_energy += sine * sine;
            cos_energy += cosine * cosine;
            cross += sine * cosine;
            sin_proj += value * sine;
            cos_proj += value * cosine;
        }
        let det = sin_energy * cos_energy - cross * cross;
        if det.abs() < 1.0e-12 {
            return 0.0;
        }
        let sine_gain = (sin_proj * cos_energy - cos_proj * cross) / det;
        let cosine_gain = (cos_proj * sin_energy - sin_proj * cross) / det;
        let mut error = 0.0;
        let mut energy = 0.0;
        for (index, value) in output.iter().enumerate() {
            let angle = 2.0 * std::f64::consts::PI * freq * index as f64 / f64::from(rate);
            let predicted = sine_gain * angle.sin() + cosine_gain * angle.cos();
            let delta = value - predicted;
            error += delta * delta;
            energy += value * value;
        }
        if energy == 0.0 {
            0.0
        } else {
            (error / energy).sqrt()
        }
    }

    fn bandlimited_impulse(rate: u32) -> Vec<[f32; 2]> {
        let mut input = vec![[0.0; 2]; 4_096];
        let center = 2_048.0;
        for (index, frame) in input.iter_mut().enumerate() {
            let x = index as f64 - center;
            let value = if x.abs() < 1.0e-9 {
                1.0
            } else {
                (std::f64::consts::PI * 0.45 * x).sin() / (std::f64::consts::PI * 0.45 * x)
                    * (0.5 + 0.5 * (std::f64::consts::PI * x / 64.0).cos())
            };
            let scaled = (value * 1.7) as f32;
            *frame = [scaled, scaled];
        }
        let _ = rate;
        input
    }

    fn bandlimited_noise(rate: u32) -> Vec<[f32; 2]> {
        let mut state = 0x1234_5678u32;
        let mut white = vec![0.0f64; 8_192];
        for sample in &mut white {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *sample = f64::from(state) / f64::from(u32::MAX) * 2.0 - 1.0;
        }
        let mut filtered = vec![0.0f64; white.len()];
        let taps = 31;
        for index in taps..white.len() {
            let mut acc = 0.0;
            for tap in 0..taps {
                let offset = tap as f64 - 15.0;
                let window = 0.5 + 0.5 * (std::f64::consts::PI * offset / 15.0).cos();
                let sinc = if offset.abs() < 1.0e-9 {
                    1.0
                } else {
                    (std::f64::consts::PI * 0.6 * offset).sin()
                        / (std::f64::consts::PI * 0.6 * offset)
                };
                acc += white[index - tap] * sinc * window;
            }
            filtered[index] = acc;
        }
        let peak = filtered
            .iter()
            .map(|value| value.abs())
            .fold(0.0, f64::max)
            .max(1.0e-9);
        filtered
            .into_iter()
            .map(|value| {
                let scaled = (value / peak * 1.6) as f32;
                [scaled, scaled * -0.7]
            })
            .collect::<Vec<_>>()
            .into_iter()
            .take(rate as usize)
            .collect()
    }

    fn sudden_onset(rate: u32) -> Vec<[f32; 2]> {
        (0..8_192)
            .map(|index| {
                if index < 1_000 {
                    [0.0; 2]
                } else {
                    let angle = 2.0 * std::f64::consts::PI * 15_000.0 * (index - 1_000) as f64
                        / f64::from(rate)
                        + std::f64::consts::FRAC_PI_2;
                    let value = angle.sin() as f32 * 1.8;
                    [value, value]
                }
            })
            .collect()
    }

    fn one_sided_hot(rate: u32) -> Vec<[f32; 2]> {
        (0..8_192)
            .map(|index| {
                let angle = std::f64::consts::PI * index as f64 / 2.0 + 0.3;
                [angle.sin() as f32 * 2.0, 0.0]
            })
            .take(rate as usize)
            .collect()
    }

    struct TruePeakMeter {
        phases: [[f64; 64]; 7],
        hist: [f64; 64],
    }

    impl TruePeakMeter {
        fn new() -> Self {
            let mut phases = [[0.0f64; 64]; 7];
            for step in 1..8 {
                phases[step - 1] = design_blackman_phase(step as f64 / 8.0);
            }
            Self {
                phases,
                hist: [0.0; 64],
            }
        }

        fn push(&mut self, sample: f64) -> f64 {
            self.push_points(sample)
                .into_iter()
                .map(|value| value.abs())
                .fold(0.0, f64::max)
        }

        fn push_points(&mut self, sample: f64) -> [f64; 8] {
            for index in 0..63 {
                self.hist[index] = self.hist[index + 1];
            }
            self.hist[63] = sample;
            let mut points = [0.0; 8];
            points[0] = self.hist[32];
            for (index, phase) in self.phases.iter().enumerate() {
                let mut acc = 0.0;
                for (tap, coeff) in phase.iter().enumerate() {
                    acc += self.hist[tap] * coeff;
                }
                points[index + 1] = acc;
            }
            points
        }
    }

    fn design_blackman_phase(frac: f64) -> [f64; 64] {
        const TAPS: usize = 64;
        let position = 31.0 + frac;
        let mut sum = 0.0;
        let mut coeff = [0.0; TAPS];
        for (index, slot) in coeff.iter_mut().enumerate() {
            let x = index as f64 / (TAPS - 1) as f64;
            let blackman = 0.42 - 0.5 * (std::f64::consts::TAU * x).cos()
                + 0.08 * (2.0 * std::f64::consts::TAU * x).cos();
            let offset = index as f64 - position;
            let sinc = if offset.abs() < 1.0e-12 {
                1.0
            } else {
                (std::f64::consts::PI * offset).sin() / (std::f64::consts::PI * offset)
            };
            *slot = sinc * blackman;
            sum += *slot;
        }
        let scale = 1.0 / sum;
        for value in &mut coeff {
            *value *= scale;
        }
        coeff
    }
}
