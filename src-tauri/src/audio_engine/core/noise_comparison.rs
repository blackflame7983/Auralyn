//! NR候補の採用と条件付きUndo/Redo。変更は同じ制御dispatch内で行う。
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
    applied: bool,
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
    fn valid_noise_history(&self) -> Option<&Undo> {
        self.noise_undo.as_ref().filter(|undo| {
            self.noise_command_revision < u64::MAX
                && undo.revision == self.noise_command_revision
                && undo.measurement_generation
                    == self.noise_learning.generation.load(Ordering::Acquire)
                && undo.input_revision == self.noise_input_revision
                && undo.stream_attempt == self.queue_attempt
                && (if undo.applied {
                    &undo.after
                } else {
                    &undo.before
                }) == &self.noise_candidate_settings()
        })
    }
    pub(super) fn noise_undo_token(&self) -> Option<String> {
        self.valid_noise_history()
            .filter(|undo| undo.applied)
            .map(|undo| undo.token.clone())
    }
    pub(super) fn noise_redo_token(&self) -> Option<String> {
        self.valid_noise_history()
            .filter(|undo| !undo.applied)
            .map(|undo| undo.token.clone())
    }
    /// 学習結果の時間切れだけで、採用済み設定の履歴まで失効させない。
    /// 呼び出し側が取消前の有効性を確認した場合にのみ、新しい世代へ束縛する。
    pub(super) fn noise_history_valid_before_expiry(&self) -> bool {
        self.valid_noise_history().is_some()
    }
    pub(super) fn rebind_noise_history_after_expiry(&mut self, was_valid: bool) {
        if !was_valid {
            return;
        }
        let revision = self.noise_command_revision;
        let generation = self.noise_learning.generation.load(Ordering::Acquire);
        let current = self.noise_candidate_settings();
        if let Some(history) = self.noise_undo.as_mut() {
            if current
                == if history.applied {
                    &history.after
                } else {
                    &history.before
                }
                .clone()
            {
                history.revision = revision;
                history.measurement_generation = generation;
            }
        }
    }
    fn complete_noise_history_transition(&mut self, applied: bool) -> Result<()> {
        let expected = self
            .noise_undo
            .as_ref()
            .ok_or_else(|| anyhow!("復元対象がありません"))?;
        if self.noise_candidate_settings()
            != if applied {
                expected.after.clone()
            } else {
                expected.before.clone()
            }
        {
            return Err(anyhow!("NR設定の反映結果を確認できません"));
        }
        let history = self
            .noise_undo
            .as_mut()
            .ok_or_else(|| anyhow!("復元対象がありません"))?;
        history.applied = applied;
        history.revision = self.noise_command_revision;
        history.token = format!(
            "nr-{}-{}",
            if applied { "undo" } else { "redo" },
            self.noise_command_revision
        );
        Ok(())
    }
    fn adopt_noise_settings(&mut self, config: &Config) -> Result<()> {
        config.validate().map_err(|e| anyhow!(e))?;
        let next_revision = self
            .voice_revision
            .checked_add(1)
            .filter(|revision| *revision < u64::MAX)
            .ok_or_else(|| anyhow!("NR操作回数の上限です。エンジンを開き直してください"))?;
        if self.noise_command_revision >= u64::MAX - 1 {
            return Err(anyhow!(
                "NR操作回数の上限です。エンジンを開き直してください"
            ));
        }
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
        self.voice_revision = next_revision;
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
                    token: format!("nr-undo-{}", self.noise_command_revision),
                    before,
                    after: self.noise_candidate_settings(),
                    revision: self.noise_command_revision,
                    measurement_generation: self.noise_learning.generation.load(Ordering::Acquire),
                    input_revision: self.noise_input_revision,
                    stream_attempt: self.queue_attempt,
                    applied: true,
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
                self.complete_noise_history_transition(false)?;
            }
            Action::RedoNoise { token } => {
                if self.noise_redo_token().as_ref() != Some(token) {
                    return Err(anyhow!("NRの再適用条件が変わりました"));
                }
                let after = self
                    .noise_undo
                    .as_ref()
                    .ok_or_else(|| anyhow!("再適用対象がありません"))?
                    .after
                    .clone();
                self.adopt_noise_settings(&after)?;
                self.complete_noise_history_transition(true)?;
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

    fn history_fixture(engine: &mut Engine) -> (Config, Config) {
        let before = engine.noise_candidate_settings();
        let mut after = before.clone();
        after.strength = 0.4;
        engine.noise_control_strength = after.strength;
        engine.voice_revision = 10;
        engine.noise_command_revision = 10;
        engine.noise_undo = Some(Undo {
            token: "nr-undo-10".into(),
            before: before.clone(),
            after: after.clone(),
            revision: engine.noise_command_revision,
            measurement_generation: engine.noise_learning.generation.load(Ordering::Acquire),
            input_revision: engine.noise_input_revision,
            stream_attempt: engine.queue_attempt,
            applied: true,
        });
        (before, after)
    }

    #[test]
    fn one_history_alternates_before_after_and_rotates_token_without_adding_entries() {
        let mut engine = Engine::new();
        let (before, after) = history_fixture(&mut engine);
        let original_token = engine.noise_undo_token().unwrap();
        assert!(engine.noise_redo_token().is_none());
        // VSTなど対象外の編集だけでは、NR履歴を失効させない。
        engine.voice_revision += 1;
        assert_eq!(
            engine.noise_undo_token().as_deref(),
            Some(original_token.as_str())
        );
        // 実ストリームがない場合は変更を拒否し、履歴を消費しない。
        assert!(engine.adopt_noise_settings(&before).is_err());
        assert_eq!(
            engine.noise_undo_token().as_deref(),
            Some(original_token.as_str())
        );

        // 制御側の適用完了後にのみ向きを進める。
        engine.noise_control_strength = before.strength;
        engine.voice_revision += 1;
        engine.noise_command_revision += 1;
        engine.complete_noise_history_transition(false).unwrap();
        let redo = engine.noise_redo_token().unwrap();
        assert_ne!(redo, original_token);
        assert!(engine.noise_undo_token().is_none());
        assert_eq!(engine.noise_candidate_settings(), before);

        engine.noise_control_strength = after.strength;
        engine.voice_revision += 1;
        engine.noise_command_revision += 1;
        engine.complete_noise_history_transition(true).unwrap();
        assert!(engine.noise_redo_token().is_none());
        assert_ne!(engine.noise_undo_token().unwrap(), original_token);
        assert_eq!(engine.noise_candidate_settings(), after);

        engine.noise_control_strength = before.strength;
        engine.voice_revision += 1;
        engine.noise_command_revision += 1;
        engine.complete_noise_history_transition(false).unwrap();
        assert!(engine.noise_redo_token().is_some());
        assert_eq!(engine.noise_undo.as_ref().unwrap().before, before);
        assert_eq!(engine.noise_undo.as_ref().unwrap().after, after);
    }

    #[test]
    fn changed_stream_learning_or_input_invalidates_history_on_both_sides() {
        for condition in 0..3 {
            let mut engine = Engine::new();
            history_fixture(&mut engine);
            match condition {
                0 => engine.queue_attempt += 1,
                1 => {
                    engine
                        .noise_learning
                        .generation
                        .fetch_add(1, Ordering::AcqRel);
                }
                _ => engine.noise_input_revision += 1,
            }
            assert!(engine.noise_undo_token().is_none());
            assert!(engine.noise_redo_token().is_none());
        }
    }

    #[test]
    fn saturated_revision_never_revives_a_stale_history() {
        let mut engine = Engine::new();
        let (before, _) = history_fixture(&mut engine);
        engine.noise_command_revision = u64::MAX;
        engine.noise_undo.as_mut().unwrap().revision = u64::MAX;
        assert!(engine.noise_undo_token().is_none());
        assert!(engine.adopt_noise_settings(&before).is_err());
    }

    #[test]
    fn expiry_rebind_keeps_only_unchanged_valid_history() {
        let mut engine = Engine::new();
        history_fixture(&mut engine);
        engine.invalidate_noise_measurement("expired");
        assert!(engine.noise_undo_token().is_some());

        // 有効だったと記録しても、その後の関連設定が変われば再束縛しない。
        let was_valid = engine.noise_history_valid_before_expiry();
        engine.noise_learning.cancel_capture();
        engine.voice_revision += 1;
        engine.noise_control_strength = 0.7;
        engine.rebind_noise_history_after_expiry(was_valid);
        assert!(engine.noise_undo_token().is_none());
        assert!(engine.noise_redo_token().is_none());
    }
    #[test]
    fn undo_rejects_later_edits_environment_changes_and_aba_without_touching_other_controls() {
        let mut e = Engine::new();
        let original = e.noise_candidate_settings();
        e.voice_revision = 10;
        e.noise_command_revision = 10;
        e.noise_undo = Some(Undo {
            token: "undo-test".into(),
            before: original.clone(),
            after: original,
            revision: e.noise_command_revision,
            measurement_generation: e.noise_learning.generation.load(Ordering::Acquire),
            input_revision: e.noise_input_revision,
            stream_attempt: e.queue_attempt,
            applied: true,
        });
        assert_eq!(e.noise_undo_token().as_deref(), Some("undo-test"));
        e.noise_control_strength = 1.2;
        e.voice_revision += 1;
        e.noise_command_revision += 1;
        e.noise_control_strength = 0.8;
        e.voice_revision += 1;
        e.noise_command_revision += 1;
        assert!(e.noise_undo_token().is_none());
        e.voice_revision = 10;
        e.noise_command_revision = 10;
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
