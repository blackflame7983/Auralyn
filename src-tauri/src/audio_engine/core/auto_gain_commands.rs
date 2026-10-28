use super::*;
use auto_gain::{Request, Snapshot};

impl Engine {
    pub(super) fn request_output_gain(&mut self, value: f32) -> Result<()> {
        if !value.is_finite() || !(0.0..=2.0).contains(&value) {
            return Err(anyhow!("出力ゲインは0〜200%で指定してください"));
        }
        self.invalidate_auto_gain();
        self.output_gain_initialized = true;
        self.output_gain = value;
        self.output_gain_revision = self.gain_revision;
        self.gain_shared.settled.store(false, Ordering::Release);
        // 停止中は次callbackの初期値として保持する。旧revisionを保留すると、
        // 開始時に確定した新revisionを後から巻き戻してしまう。
        if self.command_tx.is_some() {
            self.queue_audio_msg(AudioThreadMessage::SetOutputGain {
                value,
                revision: self.output_gain_revision,
            });
        }
        Ok(())
    }

    fn initialize_output_gain(&mut self, value: f32) -> Result<()> {
        // 起動通知が遅れても、プロファイル・手動操作などの明示設定を上書きしない。
        if !self.output_gain_initialized {
            self.request_output_gain(value)?;
        }
        Ok(())
    }

    pub(super) fn invalidate_auto_gain(&mut self) {
        self.gain_history = None;
        self.gain_revision += 1;
        self.gain_shared.requested.store(0, Ordering::Release);
        self.gain_shared.active.store(0, Ordering::Release);
        self.gain_preview = None;
        if let Some(s) = &mut self.gain_session {
            s.phase = "invalid".into();
            s.error = Some("音声設定が変わりました。録り直してください".into());
            s.samples.clear();
            s.samples.shrink_to_fit();
            s.proposal = None;
        }
    }

    fn gain_settled(&self) -> bool {
        self.output_stream.is_some()
            && !self.stream_failed.load(Ordering::Acquire)
            && self.gain_shared.settled.load(Ordering::Acquire)
            && self.gain_shared.applied_revision.load(Ordering::Acquire)
                == self.output_gain_revision
            && self.gain_shared.confirmed_gain.load(Ordering::Acquire) == self.output_gain.to_bits()
    }

    pub(super) fn poll_auto_gain(&mut self) {
        if let (Some(s), Some(rx)) = (&mut self.gain_session, &mut self.gain_capture_rx) {
            s.drain(rx);
        } else if let Some(rx) = &mut self.gain_capture_rx {
            while rx.try_pop().is_some() {}
        }
        let bad = self.stream_failed.load(Ordering::Acquire);
        if self.gain_session.as_ref().is_some_and(|s| {
            s.phase != "invalid"
                && (bad
                    || (s.phase == "recording" && s.started.elapsed() > Duration::from_secs(15)))
        }) {
            self.invalidate_auto_gain();
        }
        let settled = self.gain_settled();
        // 完了通知をAcquireで読んだ後に末尾を回収する。先のdrainと完了通知の間にも
        // 最終フレームが到着し得るため、末尾ピークを欠いた録音では解析しない。
        if self.gain_session.as_ref().is_some_and(|s| {
            s.phase == "recording" && self.gain_shared.done.load(Ordering::Acquire) == s.id
        }) {
            if let (Some(s), Some(rx)) = (&mut self.gain_session, &mut self.gain_capture_rx) {
                s.drain(rx);
            }
        }
        if let Some(s) = &mut self.gain_session {
            if s.phase == "recording" && self.gain_shared.done.load(Ordering::Acquire) == s.id {
                let result = if self.gain_shared.failed.load(Ordering::Acquire)
                    || s.samples.len() != s.rate as usize * 10
                {
                    Err(anyhow!("入力の過大音または録音の欠落を検出しました。入力音量・負荷を確認して録り直してください"))
                } else {
                    auto_gain::analyze(&s.samples, s.rate, s.before, s.target)
                };
                match result {
                    Ok(p) => {
                        s.proposal = Some(p);
                        s.phase = "ready".into();
                    }
                    Err(e) => {
                        s.phase = "invalid".into();
                        s.error = Some(e.to_string());
                        s.samples.clear();
                        s.samples.shrink_to_fit();
                    }
                }
            }
            if settled && s.phase == "applying" {
                s.phase = "applied".into();
            }
            if settled && s.phase == "restoring" {
                s.phase = "restored".into();
            }
        }
        if self.gain_preview.as_ref().is_some_and(|p| {
            !p.playing.load(Ordering::Acquire) || p.started.elapsed() > Duration::from_secs(12)
        }) {
            if self
                .gain_preview
                .as_ref()
                .is_some_and(|p| p.failed.load(Ordering::Acquire))
            {
                if let Some(s) = &mut self.gain_session {
                    s.error = Some("試聴先との接続が失われました".into());
                }
            }
            self.gain_preview = None;
        }
    }

    fn gain_snapshot(&self) -> Snapshot {
        let s = self.gain_session.as_ref();
        Snapshot {
            revision: self.gain_revision,
            gain: self.output_gain,
            confirmed_gain: f32::from_bits(self.gain_shared.confirmed_gain.load(Ordering::Acquire)),
            settled: self.gain_settled(),
            running: self.output_stream.is_some() && !self.stream_failed.load(Ordering::Acquire),
            stream_failed: self.stream_failed.load(Ordering::Acquire),
            id: s.map_or(0, |s| s.id),
            phase: s.map_or("idle".into(), |s| s.phase.clone()),
            progress: s.map_or(0.0, |s| s.samples.len() as f32 / (s.rate as f32 * 10.0)),
            proposal: s.and_then(|s| s.proposal.clone()),
            playing: self.gain_preview.is_some(),
            error: s.and_then(|s| s.error.clone()),
            devices: Vec::new(),
            history_id: self.gain_history.as_ref().map(|h| h.id),
            history_epoch: self
                .gain_history
                .as_ref()
                .map(|_| self.builtin.snapshot(false).epoch),
            undo_available: self.gain_history_available(true),
            redo_available: self.gain_history_available(false),
        }
    }

    fn gain_history_available(&self, undo: bool) -> bool {
        self.gain_history.as_ref().is_some_and(|h| {
            h.available(
                undo,
                self.gain_revision,
                self.output_gain,
                self.gain_settled(),
                self.live_modes.armed,
            )
        })
    }

    pub(super) fn auto_gain_command(&mut self, request: Request) -> Result<Snapshot> {
        self.poll_auto_gain();
        match request {
            Request::Status => {}
            Request::Initialize { value } => {
                if self.output_stream.is_some() {
                    self.initialize_output_gain(value)?;
                }
            }
            Request::Devices => {
                let mut s = self.gain_snapshot();
                s.devices = auto_gain_preview::devices()?;
                return Ok(s);
            }
            Request::Cancel => {
                self.gain_shared.requested.store(0, Ordering::Release);
                self.gain_shared.active.store(0, Ordering::Release);
                self.gain_preview = None;
                self.gain_session = None;
            }
            Request::UndoHistory {
                id,
                revision,
                ref epoch,
            }
            | Request::RedoHistory {
                id,
                revision,
                ref epoch,
            } => {
                let undo = matches!(request, Request::UndoHistory { .. });
                if *epoch != self.builtin.snapshot(false).epoch {
                    return Err(anyhow!(
                        "エンジンの世代が変わったため、古い音量履歴は使用できません"
                    ));
                }
                if !self.gain_history_available(undo)
                    || revision != self.gain_revision
                    || self.gain_history.as_ref().is_none_or(|h| h.id != id)
                    || self.voice_preview.active()
                    || self.voice_check.transport_busy()
                {
                    return Err(anyhow!(
                        "履歴の条件または音量の反映を確認できません。現在の設定を確認してください"
                    ));
                }
                self.gain_preview = None;
                let h = self
                    .gain_history
                    .as_mut()
                    .ok_or_else(|| anyhow!("戻せる設定がありません"))?;
                let gain = h.transition(
                    undo,
                    self.gain_revision,
                    self.output_gain,
                    true,
                    self.live_modes.armed,
                )?;
                self.gain_revision = h.revision;
                self.output_gain = gain;
                self.output_gain_initialized = true;
                self.output_gain_revision = self.gain_revision;
                self.gain_shared.settled.store(false, Ordering::Release);
                if let Some(session) = &mut self.gain_session {
                    session.revision = self.gain_revision;
                    session.phase = if undo { "restoring" } else { "applying" }.into();
                }
                self.queue_audio_msg(AudioThreadMessage::SetOutputGain {
                    value: gain,
                    revision: self.output_gain_revision,
                });
            }
            Request::StopPreview => {
                self.gain_preview = None;
            }
            Request::Begin { target, revision } => {
                if self.voice_preview.active() || self.voice_check.transport_busy() {
                    return Err(anyhow!(
                        "ボイスチェックの別出力試聴を停止してから録音してください"
                    ));
                }
                if ![-26.0, -23.0, -20.0, -17.0, -14.0].contains(&target) {
                    return Err(anyhow!("目標値が不正です"));
                }
                if !self.gain_settled()
                    || self.stream_failed.load(Ordering::Acquire)
                    || revision != self.gain_revision
                    || self.output_gain <= 0.0
                {
                    return Err(anyhow!("出力音量の反映を確認してから録音してください"));
                }
                if self.editor_manager.has_open_editors()
                    || self.voice_check.state.load(Ordering::Acquire) == VC_STATE_RECORDING
                    || self.voice_check.state.load(Ordering::Acquire)
                        == super::super::voice_check::VC_STATE_PLAYING
                {
                    return Err(anyhow!(
                        "プラグイン画面とボイスチェックを閉じてから録音してください"
                    ));
                }
                if !(44_100.0..=192_000.0).contains(&self.current_sample_rate) {
                    return Err(anyhow!("このサンプルレートでは測定できません"));
                }
                self.invalidate_auto_gain();
                let rate = self.current_sample_rate as u32;
                self.gain_session = Some(GainSession {
                    id: self.gain_revision,
                    revision: self.gain_revision,
                    phase: "recording".into(),
                    target,
                    before: self.output_gain,
                    rate,
                    samples: Vec::with_capacity(rate as usize * 10),
                    proposal: None,
                    error: None,
                    started: Instant::now(),
                });
                self.gain_shared.failed.store(false, Ordering::Release);
                self.gain_shared.done.store(0, Ordering::Release);
                self.gain_shared
                    .requested
                    .store(self.gain_revision, Ordering::Release);
                self.queue_audio_msg(AudioThreadMessage::StartAutoGainCapture(self.gain_revision));
            }
            Request::Preview { id, after, device } => {
                if self.voice_preview.active() || self.voice_check.transport_busy() {
                    return Err(anyhow!(
                        "ボイスチェックの録音・試聴を停止してから聞き比べてください"
                    ));
                }
                let s = self
                    .gain_session
                    .as_ref()
                    .ok_or_else(|| anyhow!("録り直してください"))?;
                if s.id != id
                    || s.revision != self.gain_revision
                    || !["ready", "applied", "restored"].contains(&s.phase.as_str())
                {
                    return Err(anyhow!("設定が変わりました。録り直してください"));
                }
                let p = s
                    .proposal
                    .as_ref()
                    .ok_or_else(|| anyhow!("変更予定がありません"))?;
                self.gain_preview = None;
                self.gain_preview = Some(auto_gain_preview::Preview::start(
                    &device,
                    s.samples.clone(),
                    s.rate,
                    if after { p.after } else { p.before },
                    self.gain_main_device.as_deref(),
                )?);
            }
            Request::Apply { id, revision } | Request::Restore { id, revision } => {
                let restore = matches!(request, Request::Restore { .. });
                let s = self
                    .gain_session
                    .as_ref()
                    .ok_or_else(|| anyhow!("録り直してください"))?;
                if !self.gain_settled() || !s.accepts(id, revision, self.gain_revision, restore) {
                    return Err(anyhow!(
                        "音声設定が変わったか反映を確認できません。現在の音量を確認してください"
                    ));
                }
                let p = s
                    .proposal
                    .as_ref()
                    .ok_or_else(|| anyhow!("変更予定がありません"))?;
                let gain = if restore { p.before } else { p.after };
                let history = auto_gain::History {
                    id: s.id,
                    revision: self.gain_revision + 1,
                    before: p.before,
                    after: p.after,
                    applied: !restore,
                };
                self.gain_history = Some(history);
                self.gain_preview = None;
                self.gain_revision += 1;
                self.output_gain = gain;
                self.output_gain_initialized = true;
                self.output_gain_revision = self.gain_revision;
                self.gain_shared.settled.store(false, Ordering::Release);
                self.queue_audio_msg(AudioThreadMessage::SetOutputGain {
                    value: gain,
                    revision: self.output_gain_revision,
                });
                if let Some(s) = &mut self.gain_session {
                    s.revision = self.gain_revision;
                    s.phase = if restore { "restoring" } else { "applying" }.into();
                }
            }
        }
        Ok(self.gain_snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stopped_gain_changes_leave_no_old_revision_to_replay_after_start() {
        for gain in [0.0, 0.8, 2.0] {
            let mut engine = Engine::new();
            engine.request_output_gain(0.5).unwrap();
            engine.request_output_gain(gain).unwrap();
            let stopped_revision = engine.output_gain_revision;
            assert!(engine.pending_audio_msgs.is_empty());
            // cleanupなしの初回開始と同じ順序で、開始準備のrevision更新とqueueを作る。
            engine.invalidate_auto_gain();
            let (prod, mut cons) = HeapRb::<AudioThreadMessage>::new(8).split();
            engine.command_tx = Some(prod);
            let (_, _, mut output) = engine.initial_callback_levels();
            assert!(engine.output_gain_revision > stopped_revision);
            assert_eq!(output.next(), gain);
            engine.initialize_output_gain(1.0).unwrap();
            engine.flush_pending_audio_msgs();
            assert!(cons.try_pop().is_none());
            assert!(engine.pending_audio_msgs.is_empty());
            assert_eq!(engine.output_gain, gain);
            assert_eq!(
                engine.gain_shared.applied_revision.load(Ordering::Acquire),
                engine.output_gain_revision
            );
            assert_eq!(
                engine.gain_shared.confirmed_gain.load(Ordering::Acquire),
                gain.to_bits()
            );
            assert!(engine.gain_shared.settled.load(Ordering::Acquire));
            assert!(engine.output_gain_initialized);
        }
    }

    #[test]
    fn legacy_transport_fence_survives_backpressure_and_blocks_auto_gain_until_ack() {
        let mut engine = Engine::new();
        let (prod, mut cons) = HeapRb::<AudioThreadMessage>::new(1).split();
        engine.command_tx = Some(prod);
        engine.queue_audio_msg(AudioThreadMessage::PlayVoiceCheck {
            source: 0,
            loop_playback: true,
        });
        assert!(engine.voice_check.transport_busy());
        assert!(engine
            .auto_gain_command(Request::Preview {
                id: 0,
                after: false,
                device: "unused".into()
            })
            .unwrap_err()
            .to_string()
            .contains("ボイスチェック"));
        assert!(engine
            .auto_gain_command(Request::Begin {
                target: -20.0,
                revision: 0
            })
            .unwrap_err()
            .to_string()
            .contains("ボイスチェック"));
        assert!(matches!(
            cons.try_pop(),
            Some(AudioThreadMessage::PlayVoiceCheck { .. })
        ));
        engine.flush_pending_audio_msgs();
        let Some(AudioThreadMessage::VoiceCheckTransportAck(play)) = cons.try_pop() else {
            panic!("play must be followed by its callback fence");
        };
        engine.queue_audio_msg(AudioThreadMessage::StopVoiceCheckPlayback);
        engine.voice_check.acknowledge_transport(play);
        assert!(engine.voice_check.transport_busy());
        assert!(matches!(
            cons.try_pop(),
            Some(AudioThreadMessage::StopVoiceCheckPlayback)
        ));
        engine.flush_pending_audio_msgs();
        let Some(AudioThreadMessage::VoiceCheckTransportAck(stop)) = cons.try_pop() else {
            panic!("stop must be followed by its callback fence");
        };
        engine.voice_check.acknowledge_transport(stop);
        assert!(!engine.voice_check.transport_busy());
        engine.queue_audio_msg(AudioThreadMessage::StopVoiceCheckPlayback);
        engine.clear_audio_resources();
        assert!(!engine.voice_check.transport_busy());
        assert!(engine.pending_audio_msgs.is_empty());
        engine.queue_audio_msg(AudioThreadMessage::StopVoiceCheckPlayback);
        assert!(engine.voice_check.transport_busy());
        engine.clear_audio_resources();
        assert!(!engine.voice_check.transport_busy());
    }

    #[test]
    fn late_startup_restore_preserves_explicit_profile_or_manual_gain() {
        for saved in [1.0, 0.8] {
            let mut engine = Engine::new();
            let (prod, mut cons) = HeapRb::<AudioThreadMessage>::new(8).split();
            engine.command_tx = Some(prod);
            engine.request_output_gain(0.5).unwrap();
            let revision = engine.gain_revision;
            engine.initialize_output_gain(saved).unwrap();
            assert_eq!(engine.output_gain, 0.5);
            assert_eq!(engine.gain_revision, revision);
            assert!(matches!(
                cons.try_pop(),
                Some(AudioThreadMessage::SetOutputGain { value: 0.5, .. })
            ));
            assert!(cons.try_pop().is_none());
        }
    }

    #[test]
    fn startup_restore_runs_once_and_cannot_override_a_later_change() {
        let mut engine = Engine::new();
        engine.initialize_output_gain(0.8).unwrap();
        assert_eq!(engine.output_gain, 0.8);
        engine.request_output_gain(0.5).unwrap();
        engine.initialize_output_gain(1.0).unwrap();
        assert_eq!(engine.output_gain, 0.5);
    }

    #[test]
    fn backpressure_keeps_actual_gain_messages_in_order() {
        let mut engine = Engine::new();
        let (prod, mut cons) = HeapRb::<AudioThreadMessage>::new(1).split();
        engine.command_tx = Some(prod);
        for revision in 1..=2 {
            engine.queue_audio_msg(AudioThreadMessage::SetOutputGain {
                value: 0.5,
                revision,
            });
        }
        assert!(matches!(
            cons.try_pop(),
            Some(AudioThreadMessage::SetOutputGain { revision: 1, .. })
        ));
        engine.queue_audio_msg(AudioThreadMessage::SetOutputGain {
            value: 0.7,
            revision: 3,
        });
        engine.flush_pending_audio_msgs();
        assert!(matches!(
            cons.try_pop(),
            Some(AudioThreadMessage::SetOutputGain { revision: 2, .. })
        ));
        engine.flush_pending_audio_msgs();
        assert!(matches!(
            cons.try_pop(),
            Some(AudioThreadMessage::SetOutputGain { revision: 3, .. })
        ));
    }
    #[test]
    fn cancel_invalidates_capture_and_drops_only_its_own_recording() {
        let mut engine = Engine::new();
        engine.output_gain = 0.8;
        engine.gain_shared.active.store(10, Ordering::Release);
        engine.gain_session = Some(GainSession {
            id: 10,
            revision: 10,
            phase: "recording".into(),
            target: -20.0,
            before: 0.8,
            rate: 48000,
            samples: vec![[0.2; 2]; 32],
            proposal: None,
            error: None,
            started: Instant::now(),
        });
        let state = engine.auto_gain_command(Request::Cancel).unwrap();
        assert_eq!(state.phase, "idle");
        assert_eq!(state.gain, 0.8);
        assert_eq!(engine.gain_shared.active.load(Ordering::Acquire), 0);
        assert!(engine.gain_session.is_none());
        assert!(engine.voice_check_buffers.current().is_none());
    }
}
