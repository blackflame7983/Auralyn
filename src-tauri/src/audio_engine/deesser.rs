//! 内蔵ディエッサー。係数は制御側で作り、サンプル処理では固定状態だけを更新する。
//! 第三者の実装や係数表は使わず、RBJ の2次フィルタと相補の引き算だけで組む。
use serde::{Deserialize, Serialize};

/// 歯擦音抑制。`None` は OFF。amount は 0 で減衰なし、1 で最大約 -10 dB。
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

/// サンプル処理に渡す固定係数。フィルタ係数はレート決定時に一度だけ計算する。
#[derive(Clone, Copy, Debug)]
pub struct Coefficients {
    lowpass: [f32; 5],
    sibilance: [f32; 5],
    voice: [f32; 5],
    attack: f32,
    release: f32,
    pub(crate) threshold: f32,
    pub(crate) min_gain: f32,
    smooth: f32,
    mix_step: f32,
    enabled: bool,
}

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
        let (min_gain, threshold) = gain_law(amount);
        let lowpass = lowpass(5_500.0_f64.min(rate_f * 0.45).max(200.0), rate_f)?;
        let (sib_hz, sib_q) = band(4_500.0, 10_000.0, rate_f)?;
        let (voice_hz, voice_q) = band(200.0, 4_000.0, rate_f)?;
        let coefficients = Self {
            lowpass,
            sibilance: bandpass(sib_hz, sib_q, rate_f)?,
            voice: bandpass(voice_hz, voice_q, rate_f)?,
            attack: (-1.0 / (rate_f * 0.001)).exp() as f32,
            release: (-1.0 / (rate_f * 0.060)).exp() as f32,
            threshold,
            min_gain,
            smooth: (1.0 - (-1.0 / (rate_f * 0.015)).exp()) as f32,
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
        self.lowpass
            .iter()
            .chain(&self.sibilance)
            .chain(&self.voice)
            .all(|v| v.is_finite())
            && [
                self.attack,
                self.release,
                self.threshold,
                self.min_gain,
                self.smooth,
                self.mix_step,
            ]
            .iter()
            .all(|v| v.is_finite())
    }
}

/// amount 0 は減衰 0 dB、amount 1 は -10 dB。しきい値は広い雑音より上、狭い歯擦音より下。
fn gain_law(amount: f32) -> (f32, f32) {
    let min_gain = if amount == 0.0 {
        1.0
    } else {
        10.0f32.powf(-10.0 * amount / 20.0)
    };
    (min_gain, 3.0 - 1.4 * amount)
}

fn lowpass(hz: f64, rate: f64) -> Result<[f32; 5], String> {
    let w = std::f64::consts::TAU * hz / rate;
    let c = w.cos();
    let alpha = w.sin() / std::f64::consts::SQRT_2;
    let norm = 1.0 + alpha;
    biquad(
        [
            (1.0 - c) * 0.5,
            1.0 - c,
            (1.0 - c) * 0.5,
            -2.0 * c,
            1.0 - alpha,
        ],
        norm,
    )
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

/// 追加遅延 0 の分割帯域ディエッサー。無効化が完了したあとは入力をそのまま返す。
pub(crate) struct DeEsser {
    coeffs: Coefficients,
    low: [Filter; 2],
    sib: [Filter; 2],
    voice: [Filter; 2],
    sib_env: f32,
    voice_env: f32,
    threshold: f32,
    min_gain: f32,
    gain: f32,
    mix: f32,
}

impl DeEsser {
    pub(crate) fn new(coefficients: Coefficients) -> Self {
        Self {
            threshold: coefficients.threshold,
            min_gain: coefficients.min_gain,
            gain: 1.0,
            mix: if coefficients.enabled { 1.0 } else { 0.0 },
            sib_env: 0.0,
            voice_env: 0.0,
            low: [Filter::default(); 2],
            sib: [Filter::default(); 2],
            voice: [Filter::default(); 2],
            coeffs: coefficients,
        }
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
        self.low = [Filter::default(); 2];
        self.sib = [Filter::default(); 2];
        self.voice = [Filter::default(); 2];
        self.sib_env = 0.0;
        self.voice_env = 0.0;
        self.threshold = self.coeffs.threshold;
        self.min_gain = self.coeffs.min_gain;
        self.gain = 1.0;
    }

    pub(crate) fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        if !self.coeffs.enabled && self.mix == 0.0 {
            return input;
        }
        let blend = self.coeffs.smooth;
        self.threshold += (self.coeffs.threshold - self.threshold) * blend;
        self.min_gain += (self.coeffs.min_gain - self.min_gain) * blend;
        let x = input.map(|sample| if sample.is_finite() { sample } else { 0.0 });
        let mut low = [0.0; 2];
        let mut sib = [0.0; 2];
        let mut voice = [0.0; 2];
        for ch in 0..2 {
            low[ch] = self.low[ch].sample(x[ch], self.coeffs.lowpass);
            sib[ch] = self.sib[ch].sample(x[ch], self.coeffs.sibilance);
            voice[ch] = self.voice[ch].sample(x[ch], self.coeffs.voice);
        }
        self.follow(sib[0] * sib[0], sib[1] * sib[1], true);
        self.follow(voice[0] * voice[0], voice[1] * voice[1], false);
        let ratio = self.sib_env / (self.voice_env + 1.0e-8);
        let openness = if ratio.is_finite() && ratio > self.threshold {
            (1.0 - self.threshold / ratio).clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.gain = 1.0 + (self.min_gain - 1.0) * openness;
        if !self.gain.is_finite() {
            self.gain = 1.0;
            self.reset();
        }
        let wet = std::array::from_fn(|ch| {
            if self.gain == 1.0 {
                x[ch]
            } else {
                let y = x[ch] + (self.gain - 1.0) * (x[ch] - low[ch]);
                if y.is_finite() {
                    y
                } else {
                    0.0
                }
            }
        });
        let target = if self.coeffs.enabled { 1.0 } else { 0.0 };
        let step = self.coeffs.mix_step;
        if self.mix != target {
            self.mix = (self.mix + (target - self.mix).clamp(-step, step)).clamp(0.0, 1.0);
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

    fn rms(samples: &[f32]) -> f32 {
        let energy = samples
            .iter()
            .map(|sample| f64::from(*sample).powi(2))
            .sum::<f64>();
        (energy / samples.len() as f64).sqrt() as f32
    }

    fn db(processed: f32, dry: f32) -> f32 {
        20.0 * (processed / dry).log10()
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

    fn channel(samples: &[[f32; 2]], ch: usize) -> Vec<f32> {
        samples.iter().map(|frame| frame[ch]).collect()
    }

    /// 交差と同じ2次ローパスの補信号。窓の先頭はフィルタの立ち上がりを除く。
    fn high_band_db(dry: &[f32], wet: &[f32], rate: u32) -> f32 {
        let coeffs = lowpass(
            5_500.0_f64.min(f64::from(rate) * 0.45).max(200.0),
            f64::from(rate),
        )
        .unwrap();
        let skip = (rate / 50) as usize;
        let energy = |samples: &[f32]| {
            let mut filter = Filter::default();
            let mut sum = 0.0f64;
            let mut count = 0usize;
            for (index, sample) in samples.iter().enumerate() {
                let high = *sample - filter.sample(*sample, coeffs);
                if index >= skip && high.is_finite() {
                    sum += f64::from(high).powi(2);
                    count += 1;
                }
            }
            (sum / count.max(1) as f64).sqrt() as f32
        };
        db(energy(wet), energy(dry))
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
        for (name, mono) in cases {
            let input: Vec<[f32; 2]> = mono.iter().map(|sample| [*sample, *sample * 0.8]).collect();
            for amount in [0.5, 1.0] {
                let output = run(rate, Some(amount), &input);
                assert!(
                    output.iter().flatten().all(|sample| sample.is_finite()),
                    "{name} amount={amount}"
                );
                let dry = window(&input, rate, 250, 400);
                let wet = window(&output, rate, 250, 400);
                let change = db(rms(&channel(wet, 0)), rms(&channel(dry, 0)));
                let high = high_band_db(&channel(dry, 0), &channel(wet, 0), rate);
                let peak = output
                    .iter()
                    .map(|frame| frame[0].abs())
                    .fold(0.0, f32::max);
                eprintln!("deesser {name} amount={amount} db={change:.3} high_db={high:.3} peak={peak:.4}");
                assert!(peak.is_finite() && peak < 1.5, "{name} peak={peak}");
                if name == "vowel" {
                    assert!(change.abs() < 0.5, "母音 {change} dB");
                }
                if name == "sibilance" && amount == 1.0 {
                    assert!((-10.5..-2.0).contains(&change), "歯擦音 {change} dB");
                }
            }
            let half = db(
                rms(&channel(
                    window(&run(rate, Some(0.5), &input), rate, 250, 400),
                    0,
                )),
                rms(&channel(window(&input, rate, 250, 400), 0)),
            );
            let full = db(
                rms(&channel(
                    window(&run(rate, Some(1.0), &input), rate, 250, 400),
                    0,
                )),
                rms(&channel(window(&input, rate, 250, 400), 0)),
            );
            if name == "sibilance" {
                assert!(
                    full < half - 0.5,
                    "量を上げると減衰が増える half={half} full={full}"
                );
            }
            if name == "breath" || name == "broadband" {
                let sibilance = db(
                    rms(&channel(
                        window(
                            &run(rate, Some(1.0), &{
                                let noise = band_noise(rate, n, 0.45);
                                noise
                                    .iter()
                                    .map(|sample| [*sample, *sample])
                                    .collect::<Vec<_>>()
                            }),
                            rate,
                            250,
                            400,
                        ),
                        0,
                    )),
                    rms(&channel(
                        window(
                            &{
                                let noise = band_noise(rate, n, 0.45);
                                noise
                                    .iter()
                                    .map(|sample| [*sample, *sample])
                                    .collect::<Vec<_>>()
                            },
                            rate,
                            250,
                            400,
                        ),
                        0,
                    )),
                );
                assert!(
                    full > sibilance + 1.0,
                    "{name} {full} dB が歯擦音 {sibilance} dB 以上に削れている"
                );
            }
        }
        for rate in [16_000, 44_100, 48_000, 96_000, 192_000] {
            let n = rate as usize / 2;
            let vowel_in: Vec<[f32; 2]> = vowel(rate, n)
                .into_iter()
                .map(|sample| [sample, sample])
                .collect();
            let sib_in: Vec<[f32; 2]> = band_noise(rate, n, 0.45)
                .into_iter()
                .map(|sample| [sample, sample])
                .collect();
            let measure = |input: &[[f32; 2]]| {
                db(
                    rms(&channel(
                        window(&run(rate, Some(1.0), input), rate, 150, 200),
                        0,
                    )),
                    rms(&channel(window(input, rate, 150, 200), 0)),
                )
            };
            let vowel_db = measure(&vowel_in);
            let sib_db = measure(&sib_in);
            eprintln!("deesser rate={rate} vowel={vowel_db:.3} sibilance={sib_db:.3}");
            assert!(vowel_db.abs() < 0.5, "rate={rate} 母音 {vowel_db}");
            assert!(
                (-10.5..-1.0).contains(&sib_db),
                "rate={rate} 歯擦音 {sib_db}"
            );
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
        let loud_out = run(rate, Some(1.0), &loud);
        let one_out = run(rate, Some(1.0), &one);
        let scaled_out = run(rate, Some(1.0), &scaled);
        let loud_db = db(
            rms(&channel(window(&loud_out, rate, 150, 200), 0)),
            rms(&channel(window(&loud, rate, 150, 200), 0)),
        );
        let one_db = db(
            rms(&channel(window(&one_out, rate, 150, 200), 0)),
            rms(&channel(window(&one, rate, 150, 200), 0)),
        );
        eprintln!("deesser linked loud={loud_db:.3} one_side={one_db:.3}");
        assert!(
            (loud_db - one_db).abs() < 0.4,
            "片側でも検出が落ちる loud={loud_db} one={one_db}"
        );
        let compared = window(&scaled_out, rate, 150, 200);
        let ratio_error = compared
            .iter()
            .filter(|frame| frame[0].abs() > 0.02)
            .map(|frame| (frame[1] / frame[0] - 0.2).abs())
            .fold(0.0, f32::max);
        assert!(ratio_error < 0.02, "左右のゲインがずれている {ratio_error}");
    }

    #[test]
    fn enable_amount_and_reset_do_not_click_or_keep_old_detection() {
        let rate = 48_000u32;
        let n = rate as usize;
        let sib = band_noise(rate, n, 0.4);
        let mut active =
            DeEsser::new(Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), rate).unwrap());
        let mut previous = 0.0f32;
        let mut steady = 0.0f32;
        let mut transition = 0.0f32;
        for (i, sample) in sib.iter().copied().enumerate() {
            let frame = active.process([sample, sample]);
            let jump = (frame[0] - previous).abs();
            if (rate as usize / 5..rate as usize / 2).contains(&i) {
                steady = steady.max(jump);
            }
            if i == rate as usize / 2 {
                active.update(Coefficients::prepare(None, rate).unwrap());
            }
            if (rate as usize / 2..rate as usize / 2 + rate as usize / 20).contains(&i) {
                transition = transition.max(jump);
            }
            previous = frame[0];
            assert!(frame[0].is_finite());
        }
        eprintln!("deesser click steady={steady:.5} disable={transition:.5}");
        assert!(
            transition < steady * 1.5 + 0.02,
            "OFF で差分が跳ねる steady={steady} transition={transition}"
        );

        let mut shaped =
            DeEsser::new(Coefficients::prepare(Some(DeEsserParams { amount: 0.2 }), rate).unwrap());
        previous = 0.0;
        steady = 0.0;
        transition = 0.0;
        for (i, sample) in sib.iter().copied().enumerate() {
            if i == rate as usize / 2 {
                shaped.update(
                    Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), rate).unwrap(),
                );
            }
            let frame = shaped.process([sample, sample]);
            let jump = (frame[0] - previous).abs();
            if (rate as usize / 5..rate as usize / 2).contains(&i) {
                steady = steady.max(jump);
            }
            if (rate as usize / 2..rate as usize / 2 + rate as usize / 20).contains(&i) {
                transition = transition.max(jump);
            }
            previous = frame[0];
        }
        eprintln!("deesser click amount steady={steady:.5} change={transition:.5}");
        assert!(transition < steady * 1.5 + 0.02, "量の変更で差分が跳ねる");

        let mut used =
            DeEsser::new(Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), rate).unwrap());
        for sample in sib.iter().take(rate as usize / 5) {
            used.process([*sample, *sample]);
        }
        used.reset();
        let mut fresh =
            DeEsser::new(Coefficients::prepare(Some(DeEsserParams { amount: 1.0 }), rate).unwrap());
        let vowel = vowel(rate, rate as usize / 10);
        for sample in &vowel {
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
        assert!(
            change < -2.0,
            "Voice の後段で歯擦音が下がっていない {change}"
        );
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
