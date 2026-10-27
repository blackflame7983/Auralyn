//! 同一録音から作るNRだけの候補。実行中のNR状態や設定を所有しない。
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Variant {
    Current,
    Weaker,
    Stronger,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub mode: String,
    pub strength: f32,
    pub voice_guard: bool,
    pub learned_mix: f32,
    pub has_learned_mix: bool,
    pub profile_rms: Option<f32>,
    pub backend: String,
    pub model: String,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "low".into(),
            strength: 0.8,
            voice_guard: true,
            learned_mix: 0.6,
            has_learned_mix: false,
            profile_rms: None,
            backend: "nnnoiseless-0.5.2".into(),
            model: "bundled-e6de5fbfadf7ec91".into(),
        }
    }
}
impl Config {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !["low", "high", "smart", "venue"].contains(&self.mode.as_str())
            || !self.strength.is_finite()
            || !(0.25..=1.25).contains(&self.strength)
            || !self.learned_mix.is_finite()
            || !(0.0..=1.0).contains(&self.learned_mix)
            || self
                .profile_rms
                .is_some_and(|v| !v.is_finite() || !(0.0..=4.0).contains(&v))
            || self.backend != "nnnoiseless-0.5.2"
            || self.model != "bundled-e6de5fbfadf7ec91"
        {
            return Err("NR候補の条件を確認できません".into());
        }
        Ok(())
    }
    pub(crate) fn variant(&self, variant: Variant) -> Self {
        let mut next = self.clone();
        match variant {
            Variant::Current => {}
            Variant::Weaker => {
                next.enabled = true;
                next.strength = (self.strength - 0.2).clamp(0.25, 1.25);
            }
            Variant::Stronger => {
                next.enabled = true;
                next.strength = (self.strength + 0.2).clamp(0.25, 1.25);
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    fn rendered(raw: &[f32], rate: u32, config: &Config) -> (Vec<[f32; 2]>, u32) {
        let mut output = Vec::new();
        let delay = crate::audio_engine::core::noise_control::render_candidate(
            raw,
            rate,
            config,
            &AtomicBool::new(false),
            |index, sample| {
                assert_eq!(index, output.len());
                output.push(sample);
            },
        )
        .unwrap();
        (output, delay)
    }
    #[test]
    fn off_is_a_bit_exact_unprocessed_reference_and_candidates_do_not_mutate_the_recording() {
        let raw = [0.0, 0.0, 1.2, -1.2, 0.1, 0.1, -0.01, 0.01];
        let original = raw;
        let (off, delay) = rendered(&raw, 48_000, &Config::default());
        assert_eq!(delay, 0);
        assert_eq!(off.into_iter().flatten().collect::<Vec<_>>(), raw);
        for variant in [Variant::Current, Variant::Weaker, Variant::Stronger] {
            let config = Config::default().variant(variant);
            let (output, _) = rendered(&raw, 48_000, &config);
            assert_eq!(output.len(), raw.len() / 2);
            assert_eq!(raw, original);
        }
    }
    #[test]
    fn dry_dominant_impulses_keep_their_position_and_tail_at_each_recording_rate() {
        for rate in [8_000, 44_100, 48_000, 48_050, 96_000, 192_000] {
            let frames = rate as usize / 10;
            let mut raw = vec![0.0; frames * 2];
            for position in [0, frames / 2, frames - 1] {
                raw.fill(0.0);
                raw[position * 2] = 0.5;
                raw[position * 2 + 1] = -0.5;
                let config = Config {
                    enabled: true,
                    strength: 0.25,
                    voice_guard: false,
                    ..Config::default()
                };
                let (output, delay) = rendered(&raw, rate, &config);
                assert_eq!(output.len(), frames);
                assert_eq!(delay, ((rate + 50) / 100) * 2 - 1);
                let peak = output
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1[0].abs().total_cmp(&b.1[0].abs()))
                    .unwrap()
                    .0;
                assert_eq!(peak, position, "{rate}Hz");
                assert!(output.iter().flatten().all(|v| v.is_finite()));
            }
        }
    }
    #[test]
    fn all_modes_are_deterministic_and_cancel_invalid_or_oversized_input_fails_closed() {
        let raw: Vec<_> = (0..1600).map(|n| (n as f32 * 0.1).sin() * 0.1).collect();
        for mode in ["low", "high", "smart", "venue"] {
            let config = Config {
                enabled: true,
                mode: mode.into(),
                profile_rms: Some(0.002),
                has_learned_mix: true,
                ..Config::default()
            };
            assert_eq!(
                rendered(&raw, 8_000, &config),
                rendered(&raw, 8_000, &config)
            );
        }
        for samples in [vec![], vec![0.0], vec![f32::NAN; 2], vec![0.0; 8_000 * 22]] {
            let mut writes = 0;
            assert!(crate::audio_engine::core::noise_control::render_candidate(
                &samples,
                8_000,
                &Config::default(),
                &AtomicBool::new(false),
                |_, _| writes += 1
            )
            .is_err());
            assert_eq!(writes, 0);
        }
        assert!(crate::audio_engine::core::noise_control::render_candidate(
            &raw,
            8_000,
            &Config::default(),
            &AtomicBool::new(true),
            |_, _| panic!("cancelled job wrote audio")
        )
        .is_err());
    }
}
