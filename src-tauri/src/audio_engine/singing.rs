//! 歌向け固定初期処理。係数は制御側で準備し、RTは固定状態だけを更新する。
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingingParams {
    pub low_cut_hz: f32,
    pub dynamics: f32,
    pub brightness_db: f32,
}
impl Default for SingingParams {
    fn default() -> Self {
        Self {
            low_cut_hz: 80.0,
            dynamics: 0.35,
            brightness_db: 0.0,
        }
    }
}
impl SingingParams {
    pub fn validate(&self) -> Result<(), String> {
        if !self.low_cut_hz.is_finite()
            || !(40.0..=160.0).contains(&self.low_cut_hz)
            || !self.dynamics.is_finite()
            || !(0.0..=1.0).contains(&self.dynamics)
            || !self.brightness_db.is_finite()
            || !(-3.0..=3.0).contains(&self.brightness_db)
        {
            return Err("歌向け内蔵処理の値が範囲外です".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Coefficients {
    hp: [f32; 5],
    shelf: [f32; 5],
    attack: f32,
    release: f32,
    threshold: f32,
    exponent: f32,
    smoothing: f32,
    mix_step: f32,
}
impl Coefficients {
    pub(crate) fn prepare(params: SingingParams, rate: u32) -> Result<Self, String> {
        params.validate()?;
        if !(8_000..=384_000).contains(&rate) {
            return Err("歌向け処理のサンプルレートが範囲外です".into());
        }
        let rate = rate as f64;
        let w = std::f64::consts::TAU * params.low_cut_hz as f64 / rate;
        let c = w.cos();
        let alpha = w.sin() / std::f64::consts::SQRT_2;
        let norm = 1.0 + alpha;
        let hp = [
            ((1.0 + c) / 2.0) / norm,
            -(1.0 + c) / norm,
            ((1.0 + c) / 2.0) / norm,
            -2.0 * c / norm,
            (1.0 - alpha) / norm,
        ]
        .map(|x| x as f32);
        let shelf = if params.brightness_db == 0.0 {
            [1.0, 0.0, 0.0, 0.0, 0.0]
        } else {
            let a = 10.0f64.powf(params.brightness_db as f64 / 40.0);
            let w = std::f64::consts::TAU * 3000.0f64.min(rate * 0.4) / rate;
            let c = w.cos();
            let beta = 2.0 * a.sqrt() * w.sin() / std::f64::consts::SQRT_2;
            let norm = (a + 1.0) - (a - 1.0) * c + beta;
            [
                a * ((a + 1.0) + (a - 1.0) * c + beta) / norm,
                -2.0 * a * ((a - 1.0) + (a + 1.0) * c) / norm,
                a * ((a + 1.0) + (a - 1.0) * c - beta) / norm,
                2.0 * ((a - 1.0) - (a + 1.0) * c) / norm,
                ((a + 1.0) - (a - 1.0) * c - beta) / norm,
            ]
            .map(|x| x as f32)
        };
        let ratio = 1.0 + 2.0 * params.dynamics;
        Ok(Self {
            hp,
            shelf,
            attack: (-1.0 / (rate * 0.012)).exp() as f32,
            release: (-1.0 / (rate * 0.120)).exp() as f32,
            threshold: 10.0f32.powf((-12.0 - 12.0 * params.dynamics) / 20.0),
            exponent: 1.0 - 1.0 / ratio,
            smoothing: (1.0 - (-1.0 / (rate * 0.020)).exp()) as f32,
            mix_step: (1.0 / (rate * 0.020)) as f32,
        })
    }
    fn approach(&mut self, target: Self) {
        let blend = self.smoothing;
        for (current, desired) in self.hp.iter_mut().zip(target.hp) {
            *current += (desired - *current) * blend;
        }
        for (current, desired) in self.shelf.iter_mut().zip(target.shelf) {
            *current += (desired - *current) * blend;
        }
        self.threshold += (target.threshold - self.threshold) * blend;
        self.exponent += (target.exponent - self.exponent) * blend;
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
    if x.is_finite() && x.abs() >= 1e-30 {
        x
    } else {
        0.0
    }
}

/// 固定Copyの観測値。通常DSPは同じ演算経路をno-op observerへ渡す。
#[derive(Clone, Copy, Debug)]
pub(crate) struct Observation {
    pub hp: [f32; 2],
    pub gained: [f32; 2],
    pub gain: f32,
    pub pre_clamp: [f32; 2],
}
pub(crate) struct SingingChain {
    current: Coefficients,
    target: Coefficients,
    hp: [Filter; 2],
    shelf: [Filter; 2],
    envelope: f32,
    mix: f32,
    enabled: bool,
}
impl SingingChain {
    pub(crate) fn new(coefficients: Coefficients, enabled: bool) -> Self {
        Self {
            current: coefficients,
            target: coefficients,
            hp: [Filter::default(); 2],
            shelf: [Filter::default(); 2],
            envelope: 0.0,
            mix: if enabled { 1.0 } else { 0.0 },
            enabled,
        }
    }
    pub(crate) fn update(&mut self, coefficients: Coefficients, enabled: bool) {
        self.target = coefficients;
        if enabled && self.mix == 0.0 {
            self.reset();
        }
        self.enabled = enabled;
    }
    pub(crate) fn active(&self) -> bool {
        self.enabled || self.mix > 0.0
    }
    pub(crate) fn reset(&mut self) {
        self.hp = [Filter::default(); 2];
        self.shelf = [Filter::default(); 2];
        self.envelope = 0.0;
    }
    pub(crate) fn process(&mut self, raw: [f32; 2], base: [f32; 2]) -> [f32; 2] {
        self.process_observed(raw, base, |_| {})
    }
    pub(crate) fn process_observed(
        &mut self,
        raw: [f32; 2],
        base: [f32; 2],
        mut observe: impl FnMut(Observation),
    ) -> [f32; 2] {
        self.current.approach(self.target);
        let mut wet = raw.map(|sample| if sample.is_finite() { sample } else { 0.0 });
        for (ch, sample) in wet.iter_mut().enumerate() {
            *sample = self.hp[ch].sample(*sample, self.current.hp);
        }
        let hp = wet;
        let level = wet[0].abs().max(wet[1].abs());
        let coefficient = if level > self.envelope {
            self.current.attack
        } else {
            self.current.release
        };
        self.envelope = tiny(coefficient * self.envelope + (1.0 - coefficient) * level);
        let gain = if self.envelope > self.current.threshold {
            (self.current.threshold / self.envelope).powf(self.current.exponent)
        } else {
            1.0
        };
        let gained = hp.map(|x| x * gain);
        let mut pre_clamp = [0.0; 2];
        for (ch, sample) in wet.iter_mut().enumerate() {
            pre_clamp[ch] = self.shelf[ch].sample(gained[ch], self.current.shelf);
            *sample = pre_clamp[ch].clamp(-0.98, 0.98);
        }
        observe(Observation {
            hp,
            gained,
            gain,
            pre_clamp,
        });
        let target = if self.enabled { 1.0 } else { 0.0 };
        self.mix += (target - self.mix).clamp(-self.current.mix_step, self.current.mix_step);
        std::array::from_fn(|ch| {
            let result = base[ch] * (1.0 - self.mix) + wet[ch] * self.mix;
            if result.is_finite() {
                result
            } else {
                0.0
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;
    fn rms(rate: u32, frequency: f32, brightness: f32) -> f32 {
        let mut params = SingingParams {
            dynamics: 0.0,
            brightness_db: brightness,
            ..SingingParams::default()
        };
        params.low_cut_hz = 80.0;
        let mut chain = SingingChain::new(Coefficients::prepare(params, rate).unwrap(), true);
        let mut sum = 0.0f64;
        for i in 0..rate / 2 {
            let x = 0.05 * (std::f32::consts::TAU * frequency * i as f32 / rate as f32).sin();
            let y = chain.process([x, x], [x, x])[0];
            if i > rate / 4 {
                sum += (y * y) as f64;
            }
        }
        (sum / (rate / 4) as f64).sqrt() as f32
    }
    #[test]
    fn singing_frequency_dc_finite_phase_linked_detector_and_no_rt_allocations() {
        for rate in [44_100, 48_000, 96_000, 192_000] {
            assert!(rms(rate, 20.0, 0.0) < rms(rate, 1000.0, 0.0) * 0.12);
            assert!(rms(rate, 8000.0, 3.0) > rms(rate, 8000.0, -3.0) * 1.6);
            let coefficients = Coefficients::prepare(SingingParams::default(), rate).unwrap();
            let mut mono = SingingChain::new(coefficients, true);
            let mut antiphase = SingingChain::new(coefficients, true);
            let mut one = SingingChain::new(coefficients, true);
            assert_eq!(
                allocation_counts(|| {
                    for i in 0..rate / 4 {
                        let x = 0.8 * (i as f32 * 0.11).sin();
                        let a = mono.process([x, x], [x, x]);
                        let b = antiphase.process([x, -x], [x, -x]);
                        let c = one.process([x, 0.0], [x, 0.0]);
                        assert!((a[0] - b[0]).abs() < 1e-6 && (a[0] - c[0]).abs() < 1e-6);
                        assert!(b.iter().all(|sample| sample.is_finite()));
                        assert!(c[1].abs() < 1e-7);
                    }
                    mono.update(coefficients, false);
                    for _ in 0..rate / 20 {
                        assert!(mono
                            .process([f32::NAN, f32::INFINITY], [0.0, 0.0])
                            .iter()
                            .all(|sample| sample.is_finite()));
                    }
                    mono.reset();
                }),
                (0, 0)
            );
            let mut dc = SingingChain::new(coefficients, true);
            let mut last = [0.0; 2];
            for _ in 0..rate {
                last = dc.process([0.2, 0.2], [0.2, 0.2]);
            }
            assert!(last[0].abs() < 1e-4);
            let mut fresh = SingingChain::new(coefficients, true);
            dc.reset();
            assert_eq!(
                dc.process([0.1, -0.1], [0.1, -0.1]),
                fresh.process([0.1, -0.1], [0.1, -0.1])
            );
        }
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;
    fn previous(s: &mut SingingChain, raw: [f32; 2], base: [f32; 2]) -> [f32; 2] {
        s.current.approach(s.target);
        let mut wet = raw.map(|v| if v.is_finite() { v } else { 0.0 });
        for (ch, v) in wet.iter_mut().enumerate() {
            *v = s.hp[ch].sample(*v, s.current.hp);
        }
        let level = wet[0].abs().max(wet[1].abs());
        let c = if level > s.envelope {
            s.current.attack
        } else {
            s.current.release
        };
        s.envelope = tiny(c * s.envelope + (1.0 - c) * level);
        let gain = if s.envelope > s.current.threshold {
            (s.current.threshold / s.envelope).powf(s.current.exponent)
        } else {
            1.0
        };
        for (ch, v) in wet.iter_mut().enumerate() {
            *v = s.shelf[ch]
                .sample(*v * gain, s.current.shelf)
                .clamp(-0.98, 0.98);
        }
        let target = if s.enabled { 1.0 } else { 0.0 };
        s.mix += (target - s.mix).clamp(-s.current.mix_step, s.current.mix_step);
        std::array::from_fn(|ch| {
            let y = base[ch] * (1.0 - s.mix) + wet[ch] * s.mix;
            if y.is_finite() {
                y
            } else {
                0.0
            }
        })
    }
    #[test]
    fn observer_and_normal_path_are_bitexact_to_previous_math_without_rt_allocation() {
        for rate in [44100, 48000, 96000, 192000, 384000] {
            let c = Coefficients::prepare(SingingParams::default(), rate).unwrap();
            let mut normal = SingingChain::new(c, true);
            let mut observed = SingingChain::new(c, true);
            let mut reference = SingingChain::new(c, true);
            let mut count = 0;
            let counts = allocation_counts(|| {
                for i in 0..8192 {
                    let x = (i as f32 * 0.37).sin() * 0.8;
                    let raw = [x, -x];
                    let expected = previous(&mut reference, raw, raw);
                    let actual = observed.process_observed(raw, raw, |o| {
                        count += 1;
                        assert!(o.gain.is_finite());
                    });
                    assert_eq!(actual.map(f32::to_bits), expected.map(f32::to_bits));
                    assert_eq!(
                        normal.process(raw, raw).map(f32::to_bits),
                        expected.map(f32::to_bits)
                    );
                }
            });
            assert_eq!(counts, (0, 0));
            assert_eq!(count, 8192);
        }
    }
    #[test]
    fn zero_dynamics_clamp_does_not_create_a_gain_reduction_observation() {
        let c = Coefficients::prepare(
            SingingParams {
                dynamics: 0.0,
                brightness_db: 3.0,
                ..Default::default()
            },
            48000,
        )
        .unwrap();
        let mut chain = SingingChain::new(c, true);
        let mut overs = 0;
        for i in 0..1024 {
            let x = if i % 2 == 0 { 2.0 } else { -2.0 };
            let y = chain.process_observed([x, -x], [x, -x], |o| {
                assert_eq!(o.gain, 1.0);
                overs += o.pre_clamp.iter().filter(|v| v.abs() > 0.98).count();
            });
            assert!(y.iter().all(|v| v.abs() <= 0.98));
        }
        assert!(overs > 0);
    }
}
