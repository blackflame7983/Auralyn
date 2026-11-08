//! 内蔵ディエッサー。検出の係数はレート決定時に作り、ハイシェルフは平滑化した減衰量から約 16 サンプルごとに更新する。
//! 第三者の実装や係数表は使わず、RBJ Audio EQ Cookbook の high-shelf（S = 1）と検出用バンドパスだけで組む。
use serde::{Deserialize, Serialize};

/// 歯擦音抑制。`None` は OFF。amount は 0 で減衰なし、1 で最大約 −12 dB。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeEsserParams {
    pub amount: f32,
}

impl DeEsserParams {
    pub fn validate(&self) -> Result<(), String> {
        if self.amount.is_finite() && (0.0..=1.0).contains(&self.amount) {
            Ok(())
        } else {
            Err("歯擦音抑制の量が範囲外です".into())
        }
    }
}

/// サンプル処理に渡すレート依存の係数。シェルフの b/a はここに置かず、減衰量からその場で作る。
#[derive(Clone, Copy, Debug)]
pub struct Coefficients {
    sibilance: [f32; 5],
    voice: [f32; 5],
    /// コーナーの cos(w0)。レート決定時に一度だけ計算する。
    cos_w0: f32,
    /// コーナーの sin(w0)。S = 1 の alpha はゲインに依存しないので、ここから都度取る。
    sin_w0: f32,
    attack: f32,
    release: f32,
    pub(crate) threshold: f32,
    /// 減衰の天井。0 以下。amount 1 で −12 dB。
    max_db: f32,
    smooth: f32,
    command_smooth: f32,
    mix_step: f32,
    enabled: bool,
}

/// しきい値を超えてから、この倍率に達したとき減衰指令を天井まで開く。
const FULL_OPEN_RATIO: f32 = 1.35;
const COEFF_INTERVAL: u8 = 16;

impl Coefficients {
    pub(crate) fn prepare(params: Option<DeEsserParams>, rate: u32) -> Result<Self, String> {
        if let Some(params) = params {
            params.validate()?;
        }
        if !(8_000..=384_000).contains(&rate) {
            return Err("歯擦音抑制のサンプルレートが範囲外です".into());
        }
        let rate_f = f64::from(rate);
        let amount = params.map_or(0.0, |params| params.amount);
        let (threshold, max_db) = gain_law(amount);
        let w0 = std::f64::consts::TAU * shelf_hz(rate_f) / rate_f;
        let (sib_hz, sib_q) = band(4_500.0, 10_000.0, rate_f)?;
        let (voice_hz, voice_q) = band(200.0, 4_000.0, rate_f)?;
        let coefficients = Self {
            sibilance: bandpass(sib_hz, sib_q, rate_f)?,
            voice: bandpass(voice_hz, voice_q, rate_f)?,
            cos_w0: w0.cos() as f32,
            sin_w0: w0.sin() as f32,
            attack: (-1.0 / (rate_f * 0.001)).exp() as f32,
            release: (-1.0 / (rate_f * 0.060)).exp() as f32,
            threshold,
            max_db,
            smooth: (1.0 - (-1.0 / (rate_f * 0.015)).exp()) as f32,
            command_smooth: (1.0 - (-1.0 / (rate_f * 0.008)).exp()) as f32,
            mix_step: (1.0 / (rate_f * 0.015)) as f32,
            enabled: params.is_some(),
        };
        if coefficients.is_finite() {
            Ok(coefficients)
        } else {
            Err("歯擦音抑制の係数を計算できません".into())
        }
    }

    fn is_finite(&self) -> bool {
        self.sibilance
            .iter()
            .chain(&self.voice)
            .all(|v| v.is_finite())
            && [
                self.cos_w0,
                self.sin_w0,
                self.attack,
                self.release,
                self.threshold,
                self.max_db,
                self.smooth,
                self.command_smooth,
                self.mix_step,
            ]
            .iter()
            .all(|v| v.is_finite())
    }
}

/// コーナーは約 4.5 kHz。Nyquist の 0.45 倍以上になるレートでは、その値未満へ下げる。
fn shelf_hz(rate: f64) -> f64 {
    let limit = rate * 0.5 * 0.45;
    4_500.0_f64.min(limit * (1.0 - 1.0e-6)).max(40.0)
}

/// amount 0 は減衰 0 dB、amount 1 は −12 dB。しきい値は広い雑音の揺れより上、狭い歯擦音より下。
fn gain_law(amount: f32) -> (f32, f32) {
    (3.0 - 0.4 * amount, -12.0 * amount)
}

/// 比がしきい値以下なら 0。`FULL_OPEN_RATIO` 倍で 1 になり、それ以上は天井で止める。
fn openness(ratio: f32, threshold: f32) -> f32 {
    if !(ratio.is_finite() && threshold > 0.0 && ratio > threshold) {
        return 0.0;
    }
    let span = threshold * (FULL_OPEN_RATIO - 1.0);
    ((ratio - threshold) / span).clamp(0.0, 1.0)
}

/// RBJ high-shelf。戻り値は正規化前の (b0, b1, b2) と (a0, a1, a2)。S = 1。
fn high_shelf_parts(cos_w0: f64, sin_w0: f64, gain_db: f64) -> ([f64; 3], [f64; 3]) {
    let amplitude = if gain_db == 0.0 {
        1.0
    } else {
        10.0_f64.powf(gain_db / 40.0)
    };
    let alpha = sin_w0 * std::f64::consts::FRAC_1_SQRT_2;
    let sqrt_a = if gain_db == 0.0 {
        1.0
    } else {
        amplitude.sqrt()
    };
    let ap = amplitude + 1.0;
    let am = amplitude - 1.0;
    let two = 2.0 * sqrt_a * alpha;
    let cos_ap = ap * cos_w0;
    let cos_am = am * cos_w0;
    (
        [
            amplitude * (ap + cos_am + two),
            -2.0 * amplitude * (am + cos_ap),
            amplitude * (ap + cos_am - two),
        ],
        [ap - cos_am + two, 2.0 * (am - cos_ap), ap - cos_am - two],
    )
}

/// 正規化済み [b0, b1, b2, a1, a2]。0 dB では b = a なので、状態 0 の TDF-II は入力と一致する。
fn high_shelf(cos_w0: f32, sin_w0: f32, gain_db: f32) -> [f32; 5] {
    let (b, a) = high_shelf_parts(f64::from(cos_w0), f64::from(sin_w0), f64::from(gain_db));
    if !(a[0].is_finite() && a[0].abs() > 1.0e-18 && b.iter().chain(&a).all(|v| v.is_finite())) {
        return [1.0, 0.0, 0.0, 0.0, 0.0];
    }
    let inv = 1.0 / a[0];
    let coeffs = [
        (b[0] * inv) as f32,
        (b[1] * inv) as f32,
        (b[2] * inv) as f32,
        (a[1] * inv) as f32,
        (a[2] * inv) as f32,
    ];
    if coeffs.iter().all(|value| value.is_finite()) {
        coeffs
    } else {
        [1.0, 0.0, 0.0, 0.0, 0.0]
    }
}

fn bandpass(hz: f64, q: f64, rate: f64) -> Result<[f32; 5], String> {
    let w = std::f64::consts::TAU * hz / rate;
    let c = w.cos();
    let alpha = w.sin() / (2.0 * q);
    let norm = 1.0 + alpha;
    biquad([alpha, 0.0, -alpha, -2.0 * c, 1.0 - alpha], norm)
}

fn biquad(raw: [f64; 5], norm: f64) -> Result<[f32; 5], String> {
    if !(norm.is_finite() && norm.abs() > 1.0e-12) {
        return Err("歯擦音抑制のフィルタを正規化できません".into());
    }
    let coeffs = raw.map(|value| (value / norm) as f32);
    if coeffs.iter().all(|value| value.is_finite()) {
        Ok(coeffs)
    } else {
        Err("歯擦音抑制のフィルタ係数が不正です".into())
    }
}

/// 検出帯域を Nyquist より下へ収める。中心は幾何平均、Q は帯域幅から取る。
fn band(low_hz: f64, high_hz: f64, rate: f64) -> Result<(f64, f64), String> {
    let ceiling = rate * 0.45;
    if !(ceiling.is_finite() && ceiling > 80.0) {
        return Err("歯擦音抑制のサンプルレートが範囲外です".into());
    }
    let high = high_hz.min(ceiling).max(120.0);
    let low = low_hz.min(high / 1.5).max(40.0);
    let high = high.max(low * 1.25);
    let center = (low * high).sqrt().min(ceiling);
    let bandwidth = (high - low).max(center * 0.2);
    let q = (center / bandwidth).clamp(0.3, 4.0);
    if center.is_finite() && q.is_finite() && center > 0.0 {
        Ok((center, q))
    } else {
        Err("歯擦音抑制の検出帯域を計算できません".into())
    }
}

#[derive(Clone, Copy, Default)]
struct Filter {
    z: [f32; 2],
}

impl Filter {
    /// Transposed direct form II。係数を差し替えても遅延線を組み直さない。
    fn sample(&mut self, x: f32, c: [f32; 5]) -> f32 {
        let y = c[0] * x + self.z[0];
        self.z[0] = tiny(c[1] * x - c[3] * y + self.z[1]);
        self.z[1] = tiny(c[2] * x - c[4] * y);
        if y.is_finite() {
            y
        } else {
            *self = Self::default();
            0.0
        }
    }
}

fn tiny(x: f32) -> f32 {
    if x.is_finite() && x.abs() >= 1.0e-30 {
        x
    } else {
        0.0
    }
}

/// 動的ハイシェルフ。無効化が完了したあとは入力をそのまま返す。
pub(crate) struct DeEsser {
    coeffs: Coefficients,
    shelf: [Filter; 2],
    shelf_c: [f32; 5],
    sib: [Filter; 2],
    voice: [Filter; 2],
    sib_env: f32,
    voice_env: f32,
    threshold: f32,
    max_db: f32,
    command_db: f32,
    applied_db: f32,
    ratio: f32,
    mix: f32,
    hold: u8,
}

impl DeEsser {
    pub(crate) fn new(coefficients: Coefficients) -> Self {
        let mut processor = Self {
            threshold: coefficients.threshold,
            max_db: coefficients.max_db,
            command_db: 0.0,
            applied_db: 0.0,
            ratio: 0.0,
            mix: if coefficients.enabled { 1.0 } else { 0.0 },
            sib_env: 0.0,
            voice_env: 0.0,
            shelf: [Filter::default(); 2],
            shelf_c: [1.0, 0.0, 0.0, 0.0, 0.0],
            sib: [Filter::default(); 2],
            voice: [Filter::default(); 2],
            hold: 0,
            coeffs: coefficients,
        };
        processor.shelf_c = high_shelf(coefficients.cos_w0, coefficients.sin_w0, 0.0);
        processor
    }

    pub(crate) fn update(&mut self, coefficients: Coefficients) {
        let enabling = coefficients.enabled && self.mix == 0.0;
        self.coeffs = coefficients;
        if enabling {
            self.reset();
        }
    }

    /// 検出とフィルタの状態を消す。ON/OFF のランプ位置は維持する。
    pub(crate) fn reset(&mut self) {
        self.shelf = [Filter::default(); 2];
        self.sib = [Filter::default(); 2];
        self.voice = [Filter::default(); 2];
        self.sib_env = 0.0;
        self.voice_env = 0.0;
        self.threshold = self.coeffs.threshold;
        self.max_db = self.coeffs.max_db;
        self.command_db = 0.0;
        self.applied_db = 0.0;
        self.ratio = 0.0;
        self.hold = 0;
        self.shelf_c = high_shelf(self.coeffs.cos_w0, self.coeffs.sin_w0, 0.0);
    }

    /// 直近サンプルの検出比と、シェルフへ実際に渡した減衰指令（dB、0 以下）。
    #[cfg(test)]
    fn observation(&self) -> (f32, f32) {
        (self.ratio, self.applied_db)
    }

    pub(crate) fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        if !self.coeffs.enabled && self.mix == 0.0 {
            return input;
        }
        let blend = self.coeffs.smooth;
        self.threshold += (self.coeffs.threshold - self.threshold) * blend;
        self.max_db += (self.coeffs.max_db - self.max_db) * blend;
        let x = input.map(|sample| if sample.is_finite() { sample } else { 0.0 });
        let mut sib = [0.0; 2];
        let mut voice = [0.0; 2];
        for ch in 0..2 {
            sib[ch] = self.sib[ch].sample(x[ch], self.coeffs.sibilance);
            voice[ch] = self.voice[ch].sample(x[ch], self.coeffs.voice);
        }
        self.follow(sib[0] * sib[0], sib[1] * sib[1], true);
        self.follow(voice[0] * voice[0], voice[1] * voice[1], false);
        let ratio = self.sib_env / (self.voice_env + 1.0e-8);
        self.ratio = if ratio.is_finite() { ratio } else { 0.0 };
        let target = self.max_db * openness(self.ratio, self.threshold);
        let floor = self.max_db.min(0.0);
        self.command_db = (self.command_db
            + (target - self.command_db) * self.coeffs.command_smooth)
            .clamp(floor, 0.0);
        if !self.command_db.is_finite() {
            self.command_db = 0.0;
            self.reset();
        }
        if self.hold == 0 {
            self.shelf_c = high_shelf(self.coeffs.cos_w0, self.coeffs.sin_w0, self.command_db);
            self.applied_db = self.command_db;
        }
        self.hold = (self.hold + 1) % COEFF_INTERVAL;
        let wet = std::array::from_fn(|ch| self.shelf[ch].sample(x[ch], self.shelf_c));
        let target_mix = if self.coeffs.enabled { 1.0 } else { 0.0 };
        let step = self.coeffs.mix_step;
        if self.mix != target_mix {
            self.mix = (self.mix + (target_mix - self.mix).clamp(-step, step)).clamp(0.0, 1.0);
        }
        let output = if self.mix == 0.0 {
            x
        } else if self.mix == 1.0 {
            wet
        } else {
            std::array::from_fn(|ch| {
                let y = x[ch] + (wet[ch] - x[ch]) * self.mix;
                if y.is_finite() {
                    y
                } else {
                    0.0
                }
            })
        };
        if !self.coeffs.enabled && self.mix == 0.0 {
            self.reset();
        }
        output
    }

    fn follow(&mut self, left: f32, right: f32, sibilance: bool) {
        let level = if left.is_finite() && right.is_finite() {
            left.max(right)
        } else {
            0.0
        };
        let env = if sibilance {
            &mut self.sib_env
        } else {
            &mut self.voice_env
        };
        let coefficient = if level > *env {
            self.coeffs.attack
        } else {
            self.coeffs.release
        };
        *env = tiny(coefficient * *env + (1.0 - coefficient) * level);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    fn vowel(rate: u32, n: usize) -> Vec<f32> {
        let harmonics = [
            200.0, 400.0, 600.0, 800.0, 1000.0, 1200.0, 1600.0, 2000.0, 2500.0, 3200.0,
        ];
        (0..n)
            .map(|i| {
                harmonics
                    .iter()
                    .enumerate()
                    .map(|(k, hz)| {
                        (std::f32::consts::TAU * hz * i as f32 / rate as f32).sin() / (k + 1) as f32
                    })
                    .sum::<f32>()
                    * 0.15
            })
            .collect()
    }

    fn white(seed: u32, n: usize, amp: f32) -> Vec<f32> {
        let mut state = seed;
        (0..n)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 8) as f32 / 16_777_216.0 * 2.0 - 1.0) * amp
            })
            .collect()
    }

    /// 試験刺激用。本体の検出フィルタとは別の狭い帯域を作る。
    fn band_noise(rate: u32, n: usize, amp: f32) -> Vec<f32> {
        let coeffs = bandpass(6_000.0, 4.0, f64::from(rate)).unwrap();
        let noise = white(0x51b1_51b1, n, amp);
        let mut filter = [Filter::default(); 2];
        noise
            .iter()
            .map(|sample| {
                let y = filter[0].sample(*sample, coeffs);
                filter[1].sample(y, coeffs)
            })
            .collect()
    }

    fn stereo(mono: &[f32]) -> Vec<[f32; 2]> {
        mono.iter().map(|sample| [*sample, *sample * 0.8]).collect()
    }

    struct Probe {
        db: f32,
        ratio: f32,
        command_db: f32,
        peak: f32,
    }

    /// 検出比・シェルフへ渡した減衰指令・実出力の RMS を、同じ窓で分けて取る。
    fn probe(rate: u32, amount: f32, input: &[[f32; 2]], skip_ms: u32, take_ms: u32) -> Probe {
        let mut deesser =
            DeEsser::new(Coefficients::prepare(Some(DeEsserParams { amount }), rate).unwrap());
        let start = (u64::from(rate) * u64::from(skip_ms) / 1000) as usize;
        let take = (u64::from(rate) * u64::from(take_ms) / 1000) as usize;
        let mut dry = 0.0f64;
        let mut wet = 0.0f64;
        let mut ratio = 0.0f64;
        let mut command = 0.0f64;
        let mut peak = 0.0f32;
        let mut count = 0usize;
        for (index, frame) in input.iter().copied().enumerate() {
            let y = deesser.process(frame);
            assert!(y.iter().all(|sample| sample.is_finite()));
            peak = peak.max(y[0].abs());
            if (start..start + take).contains(&index) {
                dry += f64::from(frame[0]).powi(2);
                wet += f64::from(y[0]).powi(2);
                let (read_ratio, read_command) = deesser.observation();
                ratio += f64::from(read_ratio);
                command += f64::from(read_command);
                count += 1;
            }
        }
        Probe {
            db: 10.0 * (wet / dry).log10() as f32,
            ratio: (ratio / count.max(1) as f64) as f32,
            command_db: (command / count.max(1) as f64) as f32,
            peak,
        }
    }

    fn run(rate: u32, amount: Option<f32>, input: &[[f32; 2]]) -> Vec<[f32; 2]> {
        let params = amount.map(|amount| DeEsserParams { amount });
        let mut deesser = DeEsser::new(Coefficients::prepare(params, rate).unwrap());
        input
            .iter()
            .copied()
            .map(|frame| deesser.process(frame))
            .collect()
    }

    fn window(samples: &[[f32; 2]], rate: u32, skip_ms: u32, take_ms: u32) -> &[[f32; 2]] {
        let start = (u64::from(rate) * u64::from(skip_ms) / 1000) as usize;
        let take = (u64::from(rate) * u64::from(take_ms) / 1000) as usize;
        &samples[start..start + take]
    }

    #[test]
    fn zero_db_shelf_coefficients_match_and_pass_audio_unchanged() {
        for rate in [8_000, 16_000, 44_100, 48_000, 96_000, 192_000] {
            let hz = shelf_hz(f64::from(rate));
            assert!(
                hz < f64::from(rate) * 0.5 * 0.45,
                "コーナーが Nyquist の 0.45 倍以上 rate={rate} hz={hz}"
            );
            let w0 = std::f64::consts::TAU * hz / f64::from(rate);
            let (b, a) = high_shelf_parts(w0.cos(), w0.sin(), 0.0);
            assert_eq!(b, a, "0 dB で b と a が一致しない rate={rate}");
            let coeffs = high_shelf(w0.cos() as f32, w0.sin() as f32, 0.0);
            assert_eq!(coeffs[0], 1.0);
            assert_eq!(coeffs[1], coeffs[3]);
            assert_eq!(coeffs[2], coeffs[4]);
            let mut filter = Filter::default();
            for i in 0..256 {
                let sample = (i as f32 * 0.17).sin() * 0.4;
                assert_eq!(filter.sample(sample, coeffs), sample, "rate={rate}");
            }
            for gain in [0.0, -6.0, -12.0] {
                let shelf = high_shelf(w0.cos() as f32, w0.sin() as f32, gain);
                assert!(
                    shelf.iter().all(|value| value.is_finite()),
                    "rate={rate} gain={gain}"
                );
            }
        }
        let rate = 48_000u32;
        let hz = shelf_hz(f64::from(rate));
        let w0 = std::f64::consts::TAU * hz / f64::from(rate);
        let cut = high_shelf(w0.cos() as f32, w0.sin() as f32, -12.0);
        let mut filter = Filter::default();
        assert!(
            filter.sample(1.0, cut).abs() > 0.05,
            "先頭サンプルに応答がない"
        );
        let tone = |frequency: f32| {
            let mut filter = Filter::default();
            let skip = rate as usize / 20;
            let n = rate as usize / 5;
            let mut dry = 0.0f64;
            let mut wet = 0.0f64;
            for i in 0..n {
                let x = (std::f32::consts::TAU * frequency * i as f32 / rate as f32).sin() * 0.5;
                let y = filter.sample(x, cut);
                if i >= skip {
                    dry += f64::from(x).powi(2);
                    wet += f64::from(y).powi(2);
                }
            }
            10.0 * (wet / dry).log10() as f32
        };
        let low = tone(200.0);
        let six = tone(6_000.0);
        let eight = tone(8_000.0);
        eprintln!("deesser shelf low={low:.3} six={six:.3} eight={eight:.3}");
        assert!(low > -0.25, "低域まで削れている {low}");
        assert!(six <= -8.0, "6 kHz が −8 dB に届かない {six}");
        assert!(
            eight < six,
            "8 kHz が 6 kHz より浅くない eight={eight} six={six}"
        );
    }

    #[test]
    fn disabled_and_zero_amount_match_the_input_and_add_no_delay() {
        for rate in [16_000, 44_100, 48_000, 96_000, 192_000] {
            let n = rate as usize / 20;
            let input: Vec<[f32; 2]> = (0..n)
                .map(|i| {
                    let sample = if i == 0 {
                        0.8
                    } else {
                        (i as f32 * 0.17).sin() * 0.25
                    };
                    [sample, -sample * 0.5]
                })
                .collect();
            for amount in [None, Some(0.0)] {
                let output = run(rate, amount, &input);
                assert_eq!(output, input, "rate={rate} amount={amount:?}");
            }
            let impulse = run(rate, Some(1.0), &{
                let mut frames = vec![[0.0; 2]; 64];
                frames[0] = [1.0, -0.4];
                frames
            });
            assert!(
                impulse[0][0].abs() > 0.5,
                "先頭サンプルが遅延している rate={rate}"
            );
            assert_eq!(
                impulse
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1[0].abs().total_cmp(&b.1[0].abs()))
                    .unwrap()
                    .0,
                0
            );
        }
    }

    #[test]
    fn known_signals_reduce_sibilance_and_keep_vowels_finite() {
        let rate = 48_000;
        let n = rate as usize;
        let cases = [
            ("vowel", vowel(rate, n)),
            ("sibilance", band_noise(rate, n, 0.45)),
            ("breath", white(7, n, 0.02)),
            ("broadband", white(11, n, 0.2)),
        ];
        let mut sibilance_full = 0.0f32;
        for (name, mono) in &cases {
            let input = stereo(mono);
            for amount in [0.5, 1.0] {
                let reading = probe(rate, amount, &input, 250, 400);
                eprintln!(
                    "deesser {name} amount={amount} ratio={:.3} command_db={:.3} out_db={:.3} peak={:.4}",
                    reading.ratio, reading.command_db, reading.db, reading.peak
                );
                assert!(
                    reading.peak.is_finite() && reading.peak < 1.5,
                    "{name} peak={}",
                    reading.peak
                );
                assert!(
                    reading.db.is_finite() && reading.command_db.is_finite(),
                    "{name}"
                );
                if *name == "vowel" {
                    assert!(reading.db.abs() < 0.5, "母音 {} dB", reading.db);
                }
                if *name == "sibilance" && amount == 1.0 {
                    sibilance_full = reading.db;
                    assert!(reading.db <= -8.0, "歯擦音の実出力 {} dB", reading.db);
                    assert!(
                        reading.command_db <= -8.0,
                        "減衰指令 {} dB",
                        reading.command_db
                    );
                }
                if (*name == "breath" || *name == "broadband") && amount == 1.0 {
                    assert!(reading.db > -1.5, "{name} の誤作動 {} dB", reading.db);
                }
            }
            if *name == "sibilance" {
                let half = probe(rate, 0.5, &input, 250, 400).db;
                let full = probe(rate, 1.0, &input, 250, 400).db;
                assert!(
                    full < half - 0.5,
                    "量を上げると減衰が増える half={half} full={full}"
                );
            }
        }
        for (name, mono) in &cases {
            if *name == "breath" || *name == "broadband" {
                let full = probe(rate, 1.0, &stereo(mono), 250, 400).db;
                assert!(
                    full > sibilance_full + 1.0,
                    "{name} {full} dB が歯擦音 {sibilance_full} dB 以上に削れている"
                );
            }
        }
        for rate in [16_000, 44_100, 48_000, 96_000, 192_000] {
            let n = rate as usize / 2;
            let vowel_in = stereo(&vowel(rate, n));
            let sib_in = stereo(&band_noise(rate, n, 0.45));
            let vowel_reading = probe(rate, 1.0, &vowel_in, 150, 200);
            let sib_reading = probe(rate, 1.0, &sib_in, 150, 200);
            eprintln!(
                "deesser rate={rate} vowel_db={:.3} vowel_ratio={:.3} sib_db={:.3} sib_ratio={:.3} sib_command={:.3}",
                vowel_reading.db, vowel_reading.ratio, sib_reading.db, sib_reading.ratio, sib_reading.command_db
            );
            assert!(
                vowel_reading.db.abs() < 0.5,
                "rate={rate} 母音 {}",
                vowel_reading.db
            );
            assert!(
                sib_reading.db.is_finite() && sib_reading.peak < 1.5,
                "rate={rate}"
            );
            assert!(
                sib_reading.db < -1.0,
                "rate={rate} 歯擦音 {}",
                sib_reading.db
            );
            if rate == 48_000 {
                assert!(sib_reading.db <= -8.0, "48 kHz の実出力 {}", sib_reading.db);
            }
        }
    }

    #[test]
    fn linked_channels_share_gain_even_when_only_one_side_is_sibilant() {
        let rate = 48_000;
        let n = rate as usize / 2;
        let sib = band_noise(rate, n, 0.5);
        let loud: Vec<[f32; 2]> = sib.iter().map(|sample| [*sample, *sample]).collect();
        let one: Vec<[f32; 2]> = sib.iter().map(|sample| [*sample, 0.0]).collect();
        let scaled: Vec<[f32; 2]> = sib.iter().map(|sample| [*sample, *sample * 0.2]).collect();
        let loud_db = probe(rate, 1.0, &loud, 150, 200).db;
        let one_db = probe(rate, 1.0, &one, 150, 200).db;
        eprintln!("deesser linked loud={loud_db:.3} one_side={one_db:.3}");
        assert!(
            (loud_db - one_db).abs() < 0.4,
            "片側でも検出が落ちる loud={loud_db} one={one_db}"
        );
        let scaled_out = run(rate, Some(1.0), &scaled);
        let compared = window(&scaled_out, rate, 150, 200);
        let ratio_error = compared
            .iter()
            .filter(|frame| frame[0].abs() > 0.02)
            .map(|frame| (frame[1] / frame[0] - 0.2).abs())
            .fold(0.0, f32::max);
        assert!(ratio_error < 0.02, "左右のゲインがずれている {ratio_error}");
    }

    /// 出力のサンプル差が、同じ区間の入力差をどれだけ超えるか。高域が戻るだけではクリックにしない。
    fn transition_excess(start: Option<f32>, next: Option<f32>) -> f32 {
        let rate = 48_000usize;
        let update_at = rate / 2;
        let sib = band_noise(rate as u32, rate, 0.4);
        let params = |amount: Option<f32>| amount.map(|amount| DeEsserParams { amount });
        let mut processor =
            DeEsser::new(Coefficients::prepare(params(start), rate as u32).unwrap());
        let mut previous = 0.0f32;
        let mut previous_in = 0.0f32;
        let mut excess = 0.0f32;
        for (i, sample) in sib.iter().copied().enumerate() {
            if i == update_at {
                processor.update(Coefficients::prepare(params(next), rate as u32).unwrap());
            }
            let frame = processor.process([sample, sample]);
            if i > 0 && (update_at..update_at + rate / 20).contains(&i) {
                let out_jump = (frame[0] - previous).abs();
                let in_jump = (sample - previous_in).abs();
                excess = excess.max(out_jump - in_jump);
            }
            previous = frame[0];
            previous_in = sample;
            assert!(frame[0].is_finite());
        }
        excess
    }

    #[test]
    fn enable_amount_reset_and_coefficient_updates_do_not_click() {
        let rate = 48_000u32;
        let disable = transition_excess(Some(1.0), None);
        let enable = transition_excess(None, Some(1.0));
        eprintln!("deesser click excess disable={disable:.5} enable={enable:.5}");
        assert!(disable < 0.08, "OFF で入力以上に跳ねる {disable}");
        assert!(enable < 0.08, "OFF→ON で入力以上に跳ねる {enable}");

        let n = rate as usize;
        let sib = band_noise(rate, n, 0.4);
        let mut shaped =
            DeEsser::new(Coefficients::prepare(Some(DeEsserParams { amount: 0.2 }), rate).unwrap());
        let mut previous = 0.0f32;
        let mut steady = 0.0f32;
        let mut transition = 0.0f32;
        let mut on_update = 0.0f32;
        let mut off_update = 0.0f32;
        for (i, sample) in sib.iter().copied().enumerate() {
            if i == n / 2 {
                shaped.update(
                    Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), rate).unwrap(),
                );
            }
            let frame = shaped.process([sample, sample]);
            let jump = (frame[0] - previous).abs();
            if (n / 5..n / 2).contains(&i) {
                steady = steady.max(jump);
                if i % usize::from(COEFF_INTERVAL) == 0 {
                    on_update = on_update.max(jump);
                } else {
                    off_update = off_update.max(jump);
                }
            }
            if (n / 2..n / 2 + n / 20).contains(&i) {
                transition = transition.max(jump);
            }
            previous = frame[0];
        }
        eprintln!(
            "deesser click amount steady={steady:.5} change={transition:.5} coeff_on={on_update:.5} coeff_off={off_update:.5}"
        );
        assert!(transition < steady * 1.5 + 0.02, "量の変更で差分が跳ねる");
        assert!(
            on_update < off_update * 1.25 + 0.02,
            "係数更新のサンプルだけ跳ねる on={on_update} off={off_update}"
        );

        let mut used =
            DeEsser::new(Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), rate).unwrap());
        let vowel = vowel(rate, rate as usize / 5);
        let mut previous = 0.0f32;
        let mut steady = 0.0f32;
        let mut boundary = 0.0f32;
        for (i, sample) in vowel.iter().enumerate() {
            if i == vowel.len() / 2 {
                used.reset();
            }
            let frame = used.process([*sample, *sample]);
            let jump = (frame[0] - previous).abs();
            if (rate as usize / 50..vowel.len() / 2).contains(&i) {
                steady = steady.max(jump);
            }
            if i == vowel.len() / 2 {
                boundary = jump;
            }
            previous = frame[0];
        }
        eprintln!("deesser click reset steady={steady:.5} boundary={boundary:.5}");
        assert!(
            boundary < steady * 1.5 + 0.02,
            "reset で母音が跳ねる steady={steady} boundary={boundary}"
        );

        let mut fresh =
            DeEsser::new(Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), rate).unwrap());
        used.reset();
        fresh.reset();
        for sample in vowel.iter().take(rate as usize / 10) {
            assert_eq!(
                used.process([*sample, *sample]),
                fresh.process([*sample, *sample])
            );
        }
    }

    #[test]
    fn non_finite_input_does_not_poison_later_samples() {
        let mut deesser = DeEsser::new(
            Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), 48_000).unwrap(),
        );
        let poisoned = deesser.process([f32::NAN, f32::INFINITY]);
        assert!(poisoned.iter().all(|sample| sample.is_finite()));
        let next = deesser.process([0.2, -0.2]);
        assert!(next.iter().all(|sample| sample.is_finite()));
        deesser.reset();
        assert_eq!(deesser.process([0.0, 0.0]), [0.0, 0.0]);
    }

    #[test]
    fn sample_processing_reset_and_update_allocate_nothing() {
        let coeffs = Coefficients::prepare(Some(DeEsserParams { amount: 0.7 }), 48_000).unwrap();
        let off = Coefficients::prepare(None, 48_000).unwrap();
        let mut deesser = DeEsser::new(coeffs);
        assert_eq!(
            allocation_counts(|| {
                for i in 0..4_096 {
                    let sample = (i as f32 * 0.2).sin() * 0.3;
                    std::hint::black_box(deesser.process(std::hint::black_box([sample, -sample])));
                }
                deesser.update(off);
                deesser.reset();
                deesser.update(coeffs);
            }),
            (0, 0)
        );
        eprintln!(
            "deesser bytes processor={} coefficients={}",
            std::mem::size_of::<DeEsser>(),
            std::mem::size_of::<Coefficients>()
        );
        assert!(std::mem::size_of::<DeEsser>() < 512);
        assert!(std::mem::size_of::<Coefficients>() < 128);
    }

    #[test]
    fn voice_chain_keeps_identity_until_deesser_is_enabled() {
        use crate::audio_engine::builtin::{Config, Preset};
        use crate::audio_engine::live_modes::Voice;
        let dry = Config {
            active: true,
            preset: Preset::Broadcast,
            ..Config::default()
        };
        let mut plain = Voice::prepare(&dry, 48_000).unwrap();
        let mut held = Voice::prepare(&dry, 48_000).unwrap();
        for i in 0..2_048 {
            let frame = [(i as f32 * 0.07).sin() * 0.3, -0.1];
            assert_eq!(plain.process(frame), held.process(frame));
        }
        let enabled = Config {
            deesser: Some(DeEsserParams { amount: 1.0 }),
            ..dry
        };
        let mut reference = Voice::prepare(&dry, 48_000).unwrap();
        let mut deessed = Voice::prepare(&enabled, 48_000).unwrap();
        let sib = band_noise(48_000, 24_000, 0.4);
        let mut plain_energy = 0.0f64;
        let mut wet_energy = 0.0f64;
        for sample in sib.iter().skip(8_000) {
            let frame = [*sample, *sample];
            plain_energy += f64::from(reference.process(frame)[0]).powi(2);
            wet_energy += f64::from(deessed.process(frame)[0]).powi(2);
        }
        let change = 10.0 * (wet_energy / plain_energy).log10();
        eprintln!("deesser after voice chain db={change:.3}");
        assert!(change < -8.0, "Voice の後段で歯擦音が −8 dB 未満 {change}");
    }

    #[test]
    #[ignore = "1秒分の処理時間の計測。通常の合否には含めない"]
    fn cpu_one_second_at_48k() {
        let mut deesser = DeEsser::new(
            Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), 48_000).unwrap(),
        );
        let started = std::time::Instant::now();
        let mut acc = 0.0f32;
        for i in 0..48_000u32 {
            let sample =
                (i as f32 * 0.13).sin() * 0.2 + ((i.wrapping_mul(17) % 100) as f32 - 50.0) * 0.001;
            acc += deesser.process([sample, -sample])[0];
        }
        eprintln!(
            "deesser cpu 48000 frames elapsed_us={} acc={acc}",
            started.elapsed().as_micros()
        );
        assert!(acc.is_finite());
    }
}
