//! NR候補の採用/取消/条件付きUndo。実際の変更は同じ制御dispatch内で行う。
use super::*;
use crate::audio_engine::{
    noise_candidate::Config,
    voice_check::preview::{Action, Request, Snapshot},
};

#[derive(Clone)]
pub(super) struct Undo {
    token: String,
    before: Config,
    after: Config,
    revision: u64,
    measurement_generation: u64,
    input_revision: u64,
    stream_attempt: u64,
}
impl Engine {
    pub(super) fn noise_candidate_settings(&self) -> Config {
        Config {
            enabled: self.noise_reduction_enabled,
            mode: self.noise_control_mode.as_str().into(),
            strength: self.noise_control_strength,
            voice_guard: self.noise_voice_guard,
            learned_mix: self.noise_learning.applied_mix(),
            has_learned_mix: self.noise_learning.has_applied_mix.load(Ordering::Acquire),
            profile_rms: self
                .noise_learning
                .profile_valid
                .load(Ordering::Acquire)
                .then(|| {
                    self.noise_learning.accepted_rms_ppm.load(Ordering::Relaxed) as f32
                        / 1_000_000.0
                }),
            ..Config::default()
        }
    }
    pub(super) fn noise_candidate_basis(&self, config: &Config) -> String {
        serde_json::to_string(&(
            self.builtin.snapshot(false).epoch,
            self.voice_revision.to_string(),
            self.noise_learning
                .generation
                .load(Ordering::Acquire)
                .to_string(),
            self.noise_input_revision.to_string(),
            self.queue_attempt.to_string(),
            &self.noise_input_identity,
            config,
        ))
        .unwrap_or_default()
    }
    pub(super) fn noise_undo_token(&self) -> Option<String> {
        self.noise_undo
            .as_ref()
            .filter(|undo| {
                undo.revision == self.voice_revision
                    && undo.measurement_generation
                        == self.noise_learning.generation.load(Ordering::Acquire)
                    && undo.input_revision == self.noise_input_revision
                    && undo.stream_attempt == self.queue_attempt
                    && undo.after == self.noise_candidate_settings()
            })
            .map(|u| u.token.clone())
    }
    fn adopt_noise_settings(&mut self, config: &Config) -> Result<()> {
        config.validate().map_err(|e| anyhow!(e))?;
        if self.output_stream.is_none()
            || self.stream_failed.load(Ordering::Acquire)
            || self.live_modes.armed
        {
            return Err(anyhow!(
                "音声を開始し、本番保護を解除してからNRを変更してください"
            ));
        }
        self.apply_noise_intent(
            config.enabled,
            normalize_noise_control_mode(Some(&config.mode)),
            config.strength,
            config.voice_guard,
            Some(self.current_sample_rate as u32),
        )
        .map_err(|e| anyhow!(e))?;
        self.voice_revision = self.voice_revision.saturating_add(1);
        self.voice_preview.invalidate_candidate();
        self.invalidate_auto_gain();
        Ok(())
    }
    pub(super) fn noise_voice_preview_command(&mut self, request: Request) -> Result<Snapshot> {
        let context = self.voice_preview_context();
        let result = self.voice_preview.command(request.clone(), context)?;
        match &request.action {
            Action::ApplyNoise { candidate_id, .. } => {
                let config = result
                    .candidate
                    .as_ref()
                    .filter(|c| c.id == *candidate_id)
                    .and_then(|c| c.noise.as_ref())
                    .ok_or_else(|| anyhow!("NR候補の条件を読み戻せません"))?
                    .clone();
                let before = self.noise_candidate_settings();
                self.adopt_noise_settings(&config)?;
                self.noise_undo = Some(Undo {
                    token: format!("nr-undo-{}", self.voice_revision),
                    before,
                    after: self.noise_candidate_settings(),
                    revision: self.voice_revision,
                    measurement_generation: self.noise_learning.generation.load(Ordering::Acquire),
                    input_revision: self.noise_input_revision,
                    stream_attempt: self.queue_attempt,
                });
            }
            Action::UndoNoise { token } => {
                if self.noise_undo_token().as_ref() != Some(token) {
                    return Err(anyhow!("NRの復元条件が変わりました"));
                }
                let previous = self
                    .noise_undo
                    .as_ref()
                    .ok_or_else(|| anyhow!("復元対象がありません"))?
                    .before
                    .clone();
                self.adopt_noise_settings(&previous)?;
                self.noise_undo = None;
            }
            _ => return Ok(result),
        }
        let context = self.voice_preview_context();
        self.voice_preview.command(
            Request {
                action: Action::Status,
                ..request
            },
            context,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn undo_rejects_later_edits_environment_changes_and_aba_without_touching_other_controls() {
        let mut e = Engine::new();
        let original = e.noise_candidate_settings();
        e.voice_revision = 10;
        e.noise_undo = Some(Undo {
            token: "undo-test".into(),
            before: original.clone(),
            after: original,
            revision: e.voice_revision,
            measurement_generation: e.noise_learning.generation.load(Ordering::Acquire),
            input_revision: e.noise_input_revision,
            stream_attempt: e.queue_attempt,
        });
        assert_eq!(e.noise_undo_token().as_deref(), Some("undo-test"));
        e.noise_control_strength = 1.2;
        e.voice_revision += 1;
        e.noise_control_strength = 0.8;
        e.voice_revision += 1;
        assert!(e.noise_undo_token().is_none());
        e.voice_revision = 10;
        e.invalidate_noise_measurement("room-changed");
        assert!(e.noise_undo_token().is_none());
        let before = e.noise_candidate_settings();
        assert!(e
            .adopt_noise_settings(
                &before.variant(crate::audio_engine::noise_candidate::Variant::Stronger)
            )
            .is_err());
        assert_eq!(e.noise_candidate_settings(), before);
        assert!(e.pending_audio_msgs.is_empty());
    }
}
