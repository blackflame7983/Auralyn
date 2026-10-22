//! コールバック内で使うDSP状態。確保は構築時に完了し、処理・resetでは確保しない。
use super::{BuiltInEffectsPreset, NoiseControlMode};
use nnnoiseless::DenoiseState;

// ゲイン変更時の段差を抑える一次平滑化。
pub(super) struct Smoother {
    current: f32,
    target: f32,
    coeff: f32,
}

impl Smoother {
    pub(super) fn new(initial_value: f32) -> Self {
        Self {
            current: initial_value,
            target: initial_value,
            coeff: 0.005,
        }
    }

    pub(super) fn new_ramp(start: f32, end: f32) -> Self {
        Self {
            current: start,
            target: end,
            coeff: 0.005,
        }
    }

    pub(super) fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    pub(super) fn current(&self) -> f32 {
        self.current
    }

    pub(super) fn target(&self) -> f32 {
        self.target
    }

    pub(super) fn next(&mut self) -> f32 {
        if (self.current - self.target).abs() < 0.0001 {
            self.current = self.target;
        } else {
            self.current += (self.target - self.current) * self.coeff;
        }
        self.current
    }
}

const DENOISE_FRAME_SIZE: usize = DenoiseState::FRAME_SIZE;
const DENOISE_SCALE: f32 = 32768.0;
pub(super) const NOISE_REDUCTION_MODE_LOW: &str = "low";
pub(super) const NOISE_REDUCTION_MODE_HIGH: &str = "high";
pub(super) const NOISE_REDUCTION_MODE_SMART: &str = "smart";
pub(super) const NOISE_REDUCTION_MODE_VENUE: &str = "venue";

pub(super) fn normalize_noise_control_mode(mode: Option<&str>) -> NoiseControlMode {
    match mode.map(|m| m.trim().to_ascii_lowercase()) {
        Some(m) if m == NOISE_REDUCTION_MODE_HIGH => NoiseControlMode::High,
        Some(m) if m == NOISE_REDUCTION_MODE_SMART => NoiseControlMode::Smart,
        Some(m) if m == NOISE_REDUCTION_MODE_VENUE => NoiseControlMode::Venue,
        _ => NoiseControlMode::Low,
    }
}

pub(super) fn noise_reduction_mix_from_mode(mode: NoiseControlMode, strength: f32) -> f32 {
    let base = match mode {
        NoiseControlMode::Low => 0.6,
        NoiseControlMode::High => 1.0,
        NoiseControlMode::Smart => 0.74,
        NoiseControlMode::Venue => 0.86,
    };
    (base * strength.clamp(0.25, 1.25)).clamp(0.0, 1.0)
}

pub(super) fn normalize_built_in_effects_preset(preset: Option<&str>) -> BuiltInEffectsPreset {
    match preset.map(|p| p.trim().to_ascii_lowercase()) {
        Some(p) if p == "warm" => BuiltInEffectsPreset::Warm,
        Some(p) if p == "bright" => BuiltInEffectsPreset::Bright,
        _ => BuiltInEffectsPreset::Broadcast,
    }
}

pub(super) struct RtNoiseReducer {
    enabled: bool,
    states: [Box<DenoiseState<'static>>; 2],
    input_frame_size: usize,
    input_frames: [Vec<f32>; 2],
    output_frames: [Vec<f32>; 2],
    denoise_input: [[f32; DENOISE_FRAME_SIZE]; 2],
    denoise_output: [[f32; DENOISE_FRAME_SIZE]; 2],
    input_pos: usize,
    output_pos: usize,
    output_ready: usize,
}

impl RtNoiseReducer {
    pub(super) fn new(sample_rate_hz: u32) -> Self {
        let frame_size = ((sample_rate_hz.max(8_000) + 50) / 100) as usize;
        Self {
            enabled: false,
            states: std::array::from_fn(|_| DenoiseState::new()),
            input_frame_size: frame_size,
            input_frames: [vec![0.0; frame_size], vec![0.0; frame_size]],
            output_frames: [vec![0.0; frame_size], vec![0.0; frame_size]],
            denoise_input: [[0.0; DENOISE_FRAME_SIZE]; 2],
            denoise_output: [[0.0; DENOISE_FRAME_SIZE]; 2],
            input_pos: 0,
            output_pos: 0,
            output_ready: 0,
        }
    }

    // 強度・モード変更では履歴を保ち、OFFから再開するときだけ古い音声を捨てる。
    pub(super) fn set_enabled(&mut self, enabled: bool) {
        if enabled && !self.enabled {
            self.reset_state();
        }
        self.enabled = enabled;
    }

    pub(super) fn reset_state(&mut self) {
        for state in &mut self.states {
            state.reset();
        }
        self.input_pos = 0;
        self.output_pos = 0;
        self.output_ready = 0;
        for ch in 0..2 {
            self.input_frames[ch].fill(0.0);
            self.output_frames[ch].fill(0.0);
            self.denoise_input[ch].fill(0.0);
            self.denoise_output[ch].fill(0.0);
        }
    }

    pub(super) fn resample_linear(input: &[f32], output: &mut [f32]) {
        if input.is_empty() || output.is_empty() {
            return;
        }
        if input.len() == 1 {
            output.fill(input[0]);
            return;
        }
        if output.len() == 1 {
            output[0] = input[0];
            return;
        }

        let in_last = (input.len() - 1) as f32;
        let out_last = (output.len() - 1) as f32;
        for (i, out) in output.iter_mut().enumerate() {
            let pos = (i as f32) * in_last / out_last;
            let idx0 = pos.floor() as usize;
            let idx1 = (idx0 + 1).min(input.len() - 1);
            let frac = pos - idx0 as f32;
            *out = input[idx0] * (1.0 - frac) + input[idx1] * frac;
        }
    }

    pub(super) fn process_sample(&mut self, left: f32, right: f32) -> (f32, f32) {
        let left = finite_audio_sample(left);
        let right = finite_audio_sample(right);
        self.input_frames[0][self.input_pos] = (left * DENOISE_SCALE).clamp(-32768.0, 32767.0);
        self.input_frames[1][self.input_pos] = (right * DENOISE_SCALE).clamp(-32768.0, 32767.0);
        self.input_pos += 1;

        if self.input_pos >= self.input_frame_size {
            for ch in 0..2 {
                if self.input_frame_size == DENOISE_FRAME_SIZE {
                    self.denoise_input[ch]
                        .copy_from_slice(&self.input_frames[ch][..DENOISE_FRAME_SIZE]);
                } else {
                    Self::resample_linear(
                        &self.input_frames[ch][..self.input_frame_size],
                        &mut self.denoise_input[ch],
                    );
                }
            }

            self.states[0].process_frame(&mut self.denoise_output[0], &self.denoise_input[0]);
            self.states[1].process_frame(&mut self.denoise_output[1], &self.denoise_input[1]);

            for ch in 0..2 {
                if self.input_frame_size == DENOISE_FRAME_SIZE {
                    self.output_frames[ch][..DENOISE_FRAME_SIZE]
                        .copy_from_slice(&self.denoise_output[ch]);
                } else {
                    Self::resample_linear(
                        &self.denoise_output[ch],
                        &mut self.output_frames[ch][..self.input_frame_size],
                    );
                }
            }

            self.input_pos = 0;
            self.output_pos = 0;
            self.output_ready = self.input_frame_size;
        }

        if self.output_ready == 0 {
            return (0.0, 0.0);
        }

        let l = (self.output_frames[0][self.output_pos] / DENOISE_SCALE).clamp(-1.0, 1.0);
        let r = (self.output_frames[1][self.output_pos] / DENOISE_SCALE).clamp(-1.0, 1.0);
        self.output_pos += 1;
        self.output_ready -= 1;
        (l, r)
    }
}

pub(super) fn finite_audio_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

pub(super) struct RtBuiltInVoiceChain {
    hp_last_in: [f32; 2],
    hp_last_out: [f32; 2],
    comp_env: f32,
    hp_alpha: [f32; 3],
}

impl RtBuiltInVoiceChain {
    pub(super) fn new(sample_rate_hz: u32) -> Self {
        Self {
            hp_last_in: [0.0; 2],
            hp_last_out: [0.0; 2],
            comp_env: 0.0,
            hp_alpha: [70.0_f32, 105.0, 85.0].map(|cutoff| {
                let rc = 1.0 / (std::f32::consts::TAU * cutoff.max(20.0));
                let dt = 1.0 / sample_rate_hz.max(8_000) as f32;
                rc / (rc + dt)
            }),
        }
    }

    fn high_pass(&mut self, ch: usize, sample: f32, alpha: f32) -> f32 {
        let out = alpha * (self.hp_last_out[ch] + sample - self.hp_last_in[ch]);
        self.hp_last_in[ch] = sample;
        self.hp_last_out[ch] = out;
        out
    }

    pub(super) fn process_sample(
        &mut self,
        left: f32,
        right: f32,
        preset: BuiltInEffectsPreset,
        amount: f32,
    ) -> (f32, f32) {
        let amount = amount.clamp(0.0, 1.0);
        let alpha = self.hp_alpha[match preset {
            BuiltInEffectsPreset::Warm => 0,
            BuiltInEffectsPreset::Bright => 1,
            BuiltInEffectsPreset::Broadcast => 2,
        }];
        let mut l = self.high_pass(0, left, alpha);
        let mut r = self.high_pass(1, right, alpha);

        let mono_abs = ((l + r) * 0.5).abs();
        let attack = 0.18;
        let release = 0.008;
        if mono_abs > self.comp_env {
            self.comp_env += (mono_abs - self.comp_env) * attack;
        } else {
            self.comp_env += (mono_abs - self.comp_env) * release;
        }

        let threshold = match preset {
            BuiltInEffectsPreset::Warm => 0.2,
            BuiltInEffectsPreset::Bright => 0.16,
            BuiltInEffectsPreset::Broadcast => 0.18,
        };
        let ratio = 2.0 + amount * 2.0;
        let gain = if self.comp_env > threshold {
            let over = self.comp_env / threshold;
            (1.0 / over.powf(1.0 - 1.0 / ratio)).clamp(0.35, 1.0)
        } else {
            1.0
        };
        let makeup = 1.0 + amount * 0.22;
        l *= gain * makeup;
        r *= gain * makeup;

        let tone = match preset {
            BuiltInEffectsPreset::Warm => -0.03,
            BuiltInEffectsPreset::Bright => 0.04,
            BuiltInEffectsPreset::Broadcast => 0.015,
        } * amount;
        l = (l + (l - left) * tone).clamp(-0.98, 0.98);
        r = (r + (r - right) * tone).clamp(-0.98, 0.98);
        (l, r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    #[test]
    fn active_setting_updates_keep_denoiser_history_but_reenable_discards_old_audio() {
        let mut actual = RtNoiseReducer::new(48_000);
        let mut reference = RtNoiseReducer::new(48_000);
        actual.set_enabled(true);
        reference.set_enabled(true);
        assert_eq!(
            allocation_counts(|| {
                for frame in 0..1_923 {
                    let sample = (frame as f32 * 0.071).sin() * 0.25;
                    if frame % 137 == 0 {
                        actual.set_enabled(true);
                    }
                    let got = actual.process_sample(sample, -sample);
                    let expected = reference.process_sample(sample, -sample);
                    assert_eq!(
                        (got.0.to_bits(), got.1.to_bits()),
                        (expected.0.to_bits(), expected.1.to_bits())
                    );
                }
            }),
            (0, 0)
        );
        let mut fresh = RtNoiseReducer::new(48_000);
        assert_eq!(
            allocation_counts(|| {
                actual.set_enabled(false);
                actual.set_enabled(true);
                for frame in 0..960 {
                    let sample = (frame as f32 * 0.11).sin() * 0.2;
                    let got = actual.process_sample(sample, sample);
                    let expected = fresh.process_sample(sample, sample);
                    assert_eq!(
                        (got.0.to_bits(), got.1.to_bits()),
                        (expected.0.to_bits(), expected.1.to_bits())
                    );
                }
            }),
            (0, 0)
        );
    }

    #[test]
    fn invalid_samples_are_silenced_before_they_can_poison_denoiser_history() {
        let mut actual = RtNoiseReducer::new(48_000);
        let mut reference = RtNoiseReducer::new(48_000);
        assert_eq!(
            allocation_counts(|| {
                for frame in 0..1_920 {
                    let sample = if frame % 7 == 0 {
                        f32::NAN
                    } else if frame % 11 == 0 {
                        f32::INFINITY
                    } else {
                        0.1
                    };
                    let got = actual.process_sample(sample, -sample);
                    let expected = reference
                        .process_sample(finite_audio_sample(sample), finite_audio_sample(-sample));
                    assert!(got.0.is_finite() && got.1.is_finite());
                    assert_eq!(
                        (got.0.to_bits(), got.1.to_bits()),
                        (expected.0.to_bits(), expected.1.to_bits())
                    );
                }
            }),
            (0, 0)
        );
    }

    // 係数キャッシュ前の計算を比較対象として固定し、レートとプリセット変更を跨いで検証する。
    struct ReferenceChain {
        hp_last_in: [f32; 2],
        hp_last_out: [f32; 2],
        comp_env: f32,
        sample_rate: f32,
    }

    impl ReferenceChain {
        fn new(sample_rate_hz: u32) -> Self {
            Self {
                hp_last_in: [0.0; 2],
                hp_last_out: [0.0; 2],
                comp_env: 0.0,
                sample_rate: sample_rate_hz.max(8_000) as f32,
            }
        }

        fn high_pass(&mut self, ch: usize, sample: f32, cutoff_hz: f32) -> f32 {
            let rc = 1.0 / (std::f32::consts::TAU * cutoff_hz.max(20.0));
            let dt = 1.0 / self.sample_rate;
            let alpha = rc / (rc + dt);
            let out = alpha * (self.hp_last_out[ch] + sample - self.hp_last_in[ch]);
            self.hp_last_in[ch] = sample;
            self.hp_last_out[ch] = out;
            out
        }

        fn process_sample(
            &mut self,
            left: f32,
            right: f32,
            preset: BuiltInEffectsPreset,
            amount: f32,
        ) -> (f32, f32) {
            let amount = amount.clamp(0.0, 1.0);
            let cutoff = match preset {
                BuiltInEffectsPreset::Warm => 70.0,
                BuiltInEffectsPreset::Bright => 105.0,
                BuiltInEffectsPreset::Broadcast => 85.0,
            };
            let mut l = self.high_pass(0, left, cutoff);
            let mut r = self.high_pass(1, right, cutoff);

            let mono_abs = ((l + r) * 0.5).abs();
            let attack = 0.18;
            let release = 0.008;
            if mono_abs > self.comp_env {
                self.comp_env += (mono_abs - self.comp_env) * attack;
            } else {
                self.comp_env += (mono_abs - self.comp_env) * release;
            }

            let threshold = match preset {
                BuiltInEffectsPreset::Warm => 0.2,
                BuiltInEffectsPreset::Bright => 0.16,
                BuiltInEffectsPreset::Broadcast => 0.18,
            };
            let ratio = 2.0 + amount * 2.0;
            let gain = if self.comp_env > threshold {
                let over = self.comp_env / threshold;
                (1.0 / over.powf(1.0 - 1.0 / ratio)).clamp(0.35, 1.0)
            } else {
                1.0
            };
            let makeup = 1.0 + amount * 0.22;
            l *= gain * makeup;
            r *= gain * makeup;

            let tone = match preset {
                BuiltInEffectsPreset::Warm => -0.03,
                BuiltInEffectsPreset::Bright => 0.04,
                BuiltInEffectsPreset::Broadcast => 0.015,
            } * amount;
            l = (l + (l - left) * tone).clamp(-0.98, 0.98);
            r = (r + (r - right) * tone).clamp(-0.98, 0.98);
            (l, r)
        }
    }

    #[test]
    fn cached_coefficients_preserve_output_bits_without_allocating() {
        for rate in [8_000, 44_100, 48_000, 96_000, 192_000] {
            let mut actual = RtBuiltInVoiceChain::new(rate);
            let mut reference = ReferenceChain::new(rate);
            let counts = allocation_counts(|| {
                for n in 0..4096 {
                    let preset = match (n / 128) % 3 {
                        0 => BuiltInEffectsPreset::Warm,
                        1 => BuiltInEffectsPreset::Bright,
                        _ => BuiltInEffectsPreset::Broadcast,
                    };
                    let amount = (n % 17) as f32 / 16.0;
                    let left = (n as f32 * 0.071).sin() * 0.9;
                    let right = (n as f32 * 0.113).cos() * 0.6;
                    let (l, r) = actual.process_sample(left, right, preset, amount);
                    let (expected_l, expected_r) =
                        reference.process_sample(left, right, preset, amount);
                    assert_eq!(l.to_bits(), expected_l.to_bits());
                    assert_eq!(r.to_bits(), expected_r.to_bits());
                }
            });
            assert_eq!(counts, (0, 0));
        }
    }
}
