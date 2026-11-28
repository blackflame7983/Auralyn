//! 独自4-delay FDN。第三者コード・IRは使用しない。確保は制御側のみ。
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReverbParams {
    pub enabled: bool,
    pub mix: f32,
    pub decay_seconds: f32,
    pub damping: f32,
}
impl Default for ReverbParams {
    fn default() -> Self {
        Self {
            enabled: false,
            mix: 0.08,
            decay_seconds: 1.2,
            damping: 0.5,
        }
    }
}
impl ReverbParams {
    pub fn validate(self) -> Result<(), String> {
        if !self.mix.is_finite()
            || !(0.0..=0.25).contains(&self.mix)
            || !self.decay_seconds.is_finite()
            || !(0.3..=2.5).contains(&self.decay_seconds)
            || !self.damping.is_finite()
            || !(0.0..=1.0).contains(&self.damping)
        {
            return Err("残響の値が範囲外です".into());
        }
        Ok(())
    }
    pub(crate) fn tail_frames(self, rate: u32) -> Result<usize, String> {
        self.validate()?;
        Ok(if self.enabled {
            ((2.0 * self.decay_seconds as f64 + 0.1) * rate as f64).ceil() as usize
        } else {
            0
        })
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Coefficients {
    feedback: [f32; 4],
    damping: f32,
    dc: f32,
    blend: f32,
    step: f32,
    params: ReverbParams,
}
const DELAYS: [f64; 4] = [0.0297, 0.0371, 0.0411, 0.0437];
fn lengths(rate: u32) -> [usize; 4] {
    DELAYS.map(|seconds| (seconds * rate as f64).ceil() as usize)
}
impl Coefficients {
    pub(crate) fn prepare(params: ReverbParams, rate: u32) -> Result<Self, String> {
        params.validate()?;
        if !(8_000..=384_000).contains(&rate) {
            return Err("残響のサンプルレートが範囲外です".into());
        }
        let sample_rate = rate as f64;
        let damping_hz = 10_000.0 - params.damping as f64 * 8_000.0;
        Ok(Self {
            feedback: lengths(rate).map(|length| {
                10.0f64.powf(-3.0 * length as f64 / sample_rate / params.decay_seconds as f64)
                    as f32
            }),
            damping: (-std::f64::consts::TAU * damping_hz / sample_rate).exp() as f32,
            dc: (-std::f64::consts::TAU * 80.0 / sample_rate).exp() as f32,
            blend: (1.0 - (-1.0 / (sample_rate * 0.020)).exp()) as f32,
            step: (1.0 / (sample_rate * 0.020)) as f32,
            params,
        })
    }
}
struct Delay {
    data: Box<[f32]>,
    index: usize,
    valid: usize,
}
impl Delay {
    fn read(&self) -> f32 {
        if self.valid == self.data.len() {
            self.data[self.index]
        } else {
            0.0
        }
    }
    fn write(&mut self, value: f32) {
        self.data[self.index] = value;
        self.index = (self.index + 1) % self.data.len();
        self.valid = (self.valid + 1).min(self.data.len());
    }
    fn reset(&mut self) {
        self.index = 0;
        self.valid = 0;
    }
}
pub(crate) struct Reverb {
    delays: [Delay; 4],
    current: Coefficients,
    target: Coefficients,
    damp: [f32; 4],
    dc_x: [f32; 2],
    dc_y: [f32; 2],
    input_send: f32,
    tail_output: f32,
    target_send: f32,
    target_output: f32,
}
fn finite(value: f32) -> f32 {
    if value.is_finite() && value.abs() >= 1e-30 {
        value
    } else {
        0.0
    }
}
fn ramp(value: f32, target: f32, step: f32) -> f32 {
    value + (target - value).clamp(-step, step)
}
impl Reverb {
    pub(crate) fn new(params: ReverbParams, rate: u32) -> Result<Self, String> {
        let coefficients = Coefficients::prepare(params, rate)?;
        let sizes = lengths(rate);
        let active = if params.enabled { 1.0 } else { 0.0 };
        Ok(Self {
            delays: std::array::from_fn(|i| Delay {
                data: vec![0.0; sizes[i]].into_boxed_slice(),
                index: 0,
                valid: 0,
            }),
            current: coefficients,
            target: coefficients,
            damp: [0.0; 4],
            dc_x: [0.0; 2],
            dc_y: [0.0; 2],
            input_send: active,
            tail_output: active,
            target_send: active,
            target_output: active,
        })
    }
    pub(crate) fn update(&mut self, coefficients: Coefficients) {
        self.target = coefficients;
        let active = if coefficients.params.enabled {
            1.0
        } else {
            0.0
        };
        self.set_transport(active, active);
    }
    /// 無音ゲート内の復旧用。失敗先のtailと係数の遷移を持ち越さない。
    pub(crate) fn restore(&mut self, coefficients: Coefficients) {
        self.reset();
        self.update(coefficients);
        self.current = coefficients;
        self.input_send = self.target_send;
        self.tail_output = self.target_output;
    }
    // #36用: 送入停止と既存tailの出力を別々に制御する。公開APIではまだ使用しない。
    pub(crate) fn set_transport(&mut self, send: f32, output: f32) {
        self.target_send = send.clamp(0.0, 1.0);
        self.target_output = output.clamp(0.0, 1.0);
    }
    pub(crate) fn reset(&mut self) {
        for delay in &mut self.delays {
            delay.reset();
        }
        self.damp = [0.0; 4];
        self.dc_x = [0.0; 2];
        self.dc_y = [0.0; 2];
    }
    pub(crate) fn process(&mut self, dry: [f32; 2], muted: bool) -> [f32; 2] {
        if muted {
            self.reset();
            return [0.0; 2];
        }
        if self.target_output == 0.0 && self.tail_output == 0.0 {
            return dry; // OFFは旧処理とbit一致。
        }
        let blend = self.current.blend;
        for i in 0..4 {
            self.current.feedback[i] +=
                (self.target.feedback[i] - self.current.feedback[i]) * blend;
        }
        self.current.damping += (self.target.damping - self.current.damping) * blend;
        self.current.params.mix += (self.target.params.mix - self.current.params.mix) * blend;
        self.input_send = ramp(self.input_send, self.target_send, self.current.step);
        self.tail_output = ramp(self.tail_output, self.target_output, self.current.step);
        if self.tail_output == 0.0 && self.target_output == 0.0 {
            self.reset();
            return dry;
        }
        let mut input = [0.0; 2];
        for ch in 0..2 {
            let x = finite(dry[ch]).clamp(-1.0, 1.0);
            let y = finite(x - self.dc_x[ch] + self.current.dc * self.dc_y[ch]);
            self.dc_x[ch] = x;
            self.dc_y[ch] = y;
            input[ch] = y.clamp(-1.0, 1.0) * self.input_send * 0.125;
        }
        let mut read = [0.0; 4];
        for (i, sample) in read.iter_mut().enumerate() {
            self.damp[i] = finite(
                self.current.damping * self.damp[i]
                    + (1.0 - self.current.damping) * self.delays[i].read(),
            );
            *sample = self.damp[i];
        }
        let [a, b, c, d] = read;
        let feedback = [
            (a + b + c + d) * 0.5,
            (a - b + c - d) * 0.5,
            (a + b - c - d) * 0.5,
            (a - b - c + d) * 0.5,
        ];
        let inject = [input[0], input[1], -input[0], -input[1]];
        for i in 0..4 {
            self.delays[i]
                .write(finite(feedback[i] * self.current.feedback[i] + inject[i]).clamp(-4.0, 4.0));
        }
        let wet = [(a + b - c - d) * 0.0625, (a - b + c - d) * 0.0625];
        std::array::from_fn(|ch| {
            // f64和により有限巨大dryでもf32加算overflowを避ける。通常dryは減衰しない。
            (finite(dry[ch]) as f64 + (wet[ch] * self.current.params.mix * self.tail_output) as f64)
                .clamp(-(f32::MAX as f64), f32::MAX as f64) as f32
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maximum_decay_mix_and_damping_extremes_keep_continuous_input_and_overdrive_bounded() {
        for damping in [0.0, 1.0] {
            let mut reverb = Reverb::new(
                ReverbParams {
                    enabled: true,
                    mix: 0.25,
                    decay_seconds: 2.5,
                    damping,
                },
                48_000,
            )
            .unwrap();
            for frame in 0..48_000 * 6 {
                let x = if frame < 48_000 * 3 {
                    1.0
                } else {
                    (frame as f32 * 0.11).sin()
                };
                let dry = [x, -x];
                let output = reverb.process(dry, false);
                for ch in 0..2 {
                    assert!(output[ch].is_finite() && output[ch].abs() <= 1.250001);
                    assert!((output[ch] - dry[ch]).abs() <= 0.250001);
                }
            }
            for delay in &reverb.delays {
                assert!(delay
                    .data
                    .iter()
                    .all(|sample| sample.is_finite() && sample.abs() <= 4.0));
            }
            for _ in 0..48_000 {
                assert!(reverb
                    .process([f32::MAX, -f32::MAX], false)
                    .iter()
                    .all(|sample| sample.is_finite()));
            }
        }
    }

    #[test]
    fn reverb_five_rates_decay_dc_stereo_bounds_reset_disable_and_rt_noalloc() {
        use crate::dsp_verification_allocator::allocation_counts;
        for rate in [44_100, 48_000, 96_000, 192_000, 384_000] {
            let params = ReverbParams {
                enabled: true,
                mix: 0.25,
                decay_seconds: 0.3,
                damping: 0.5,
            };
            let mut reverb = Reverb::new(params, rate).unwrap();
            let coefficients = Coefficients::prepare(params, rate).unwrap();
            assert!(coefficients
                .feedback
                .iter()
                .all(|gain| *gain > 0.0 && *gain < 0.925));
            let ring_bytes: usize = reverb.delays.iter().map(|delay| delay.data.len() * 4).sum();
            assert!(ring_bytes <= (0.152 * rate as f64).ceil() as usize * 4 + 16);
            let mut first_energy = 0.0f64;
            let mut late_energy = 0.0f64;
            let mut nonzero_stereo = [false; 2];
            let counts = allocation_counts(|| {
                reverb.update(coefficients);
                reverb.reset();
                for frame in 0..rate as usize {
                    let dry = if frame == 0 { [1.0, -1.0] } else { [0.0; 2] };
                    let result = reverb.process(dry, false);
                    assert!(result.iter().all(|value| value.is_finite()));
                    if frame > 0 {
                        for ch in 0..2 {
                            nonzero_stereo[ch] |= result[ch] != 0.0;
                        }
                        let energy = result
                            .iter()
                            .map(|value| (*value as f64).powi(2))
                            .sum::<f64>();
                        if frame < rate as usize / 4 {
                            first_energy += energy;
                        }
                        if frame > rate as usize * 3 / 4 {
                            late_energy += energy;
                        }
                    }
                }
            });
            assert_eq!(counts, (0, 0));
            assert!(nonzero_stereo.into_iter().all(|nonzero| nonzero));
            assert!(first_energy > 0.0 && late_energy < first_energy * 0.001);
            // 連続DCと有声音の安全境界。dry自体は減衰させない。
            reverb.reset();
            let mut dc_end = 0.0f32;
            for frame in 0..rate as usize {
                let result = reverb.process([1.0, -1.0], false);
                assert!(result
                    .iter()
                    .all(|value| value.is_finite() && value.abs() <= 1.250001));
                if frame > rate as usize * 3 / 4 {
                    dc_end = dc_end.max((result[0] - 1.0).abs());
                }
            }
            assert!(dc_end < 0.001);
            for frame in 0..4096 {
                let x = (frame as f32 * 0.1).sin();
                let result = reverb.process([x, -x], false);
                assert!(result
                    .iter()
                    .all(|value| value.is_finite() && value.abs() <= 1.250001));
            }
            for dry in [[f32::MAX; 2], [-f32::MAX; 2], [f32::NAN, f32::INFINITY]] {
                assert!(reverb
                    .process(dry, false)
                    .iter()
                    .all(|value| value.is_finite()));
            }
            let changed = Coefficients::prepare(
                ReverbParams {
                    mix: 0.01,
                    decay_seconds: 2.5,
                    damping: 1.0,
                    ..params
                },
                rate,
            )
            .unwrap();
            assert_eq!(
                allocation_counts(|| {
                    reverb.update(changed);
                    reverb.process([1.0; 2], true);
                    reverb.reset();
                    reverb.update(coefficients);
                }),
                (0, 0)
            );
            assert_eq!(reverb.process([1.0; 2], true), [0.0; 2]);
            for _ in 0..rate as usize / 4 {
                assert_eq!(reverb.process([0.0; 2], false), [0.0; 2]);
            }
            let mut fresh = Reverb::new(params, rate).unwrap();
            reverb.reset();
            for frame in 0..4096 {
                let dry = if frame == 0 { [0.25, 0.0] } else { [0.0; 2] };
                assert_eq!(reverb.process(dry, false), fresh.process(dry, false));
            }
            reverb.update(
                Coefficients::prepare(
                    ReverbParams {
                        enabled: false,
                        ..params
                    },
                    rate,
                )
                .unwrap(),
            );
            for _ in 0..(rate / 20) {
                reverb.process([0.0; 2], false);
            }
            assert_eq!(reverb.tail_output, 0.0);
            assert!(reverb.delays.iter().all(|delay| delay.valid == 0));
            reverb.update(coefficients);
            for _ in 0..rate / 10 {
                assert_eq!(reverb.process([0.0; 2], false), [0.0; 2]);
            }
        }
    }
    #[test]
    fn reverb_off_is_bit_exact_and_transport_send_cut_keeps_tail_until_emergency_reset() {
        let mut off = Reverb::new(ReverbParams::default(), 48_000).unwrap();
        for dry in [[-0.0, 0.0], [0.7, -0.4], [f32::MAX, -f32::MAX]] {
            assert_eq!(
                off.process(dry, false).map(f32::to_bits),
                dry.map(f32::to_bits)
            );
        }
        let mut on = Reverb::new(
            ReverbParams {
                enabled: true,
                ..Default::default()
            },
            48_000,
        )
        .unwrap();
        on.process([1.0, -1.0], false);
        on.set_transport(0.0, 1.0);
        let mut tail = 0.0f32;
        for _ in 0..12_000 {
            tail = tail.max(on.process([0.0; 2], false)[0].abs());
        }
        assert!(tail > 0.0);
        on.process([0.0; 2], true);
        for _ in 0..12_000 {
            assert_eq!(on.process([0.0; 2], false), [0.0; 2]);
        }
        // レート変更は新規構築し、旧ringを持ち越さない。
        let mut changed = Reverb::new(
            ReverbParams {
                enabled: true,
                ..Default::default()
            },
            96_000,
        )
        .unwrap();
        for _ in 0..12_000 {
            assert_eq!(changed.process([0.0; 2], false), [0.0; 2]);
        }
    }
}
