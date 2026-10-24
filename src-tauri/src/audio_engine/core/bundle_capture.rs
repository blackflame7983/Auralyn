//! 制御スレッドだけで採取する。component stateの内部変動とcontroller別stateは保証外。
use super::*;
impl Engine {
    pub(super) fn prepare_initial_controls(
        &mut self,
        controls: crate::ipc::StartControls,
    ) -> Result<()> {
        controls.validate().map_err(|error| anyhow!(error))?;
        // 実行中の旧callbackを回収してから、次のcallbackの初期値を一度に保持する。
        if self.input_stream.is_some() || self.output_stream.is_some() {
            self.stop_audio();
        }
        self.voice_input_gain = controls.input_gain;
        self.request_output_gain(controls.output_gain)?;
        self.global_mute = controls.muted;
        self.global_bypass = controls.bypassed;
        // 既定WASAPI/ch2では正規化しない。開始先が確定した箇所で処理する。
        [self.input_channel_l, self.input_channel_r] = controls.input_channels;
        Ok(())
    }
    pub(super) fn normalize_start_channels(&mut self) {
        [self.input_channel_l, self.input_channel_r] = normalized_channels(
            self.current_host_is_asio,
            [self.input_channel_l, self.input_channel_r],
            self.current_channels,
        );
    }
    pub(super) fn capture_bundle_state(&self) -> Result<crate::bundle::EngineCapture> {
        let running = self.output_stream.is_some();
        anyhow::ensure!(
            !self.stream_failed.load(Ordering::Acquire),
            "音声異常中は配信状態を取得できません"
        );
        anyhow::ensure!(
            self.pending_restore.is_none()
                && self.plugin_manager.pending_init.is_empty()
                && self.plugin_manager.pending_drop_by_index.is_empty(),
            "VSTの準備・終了を待ってください"
        );
        anyhow::ensure!(
            self.gain_preview.is_none()
                && self.gain_shared.active.load(Ordering::Acquire) == 0
                && self.gain_shared.requested.load(Ordering::Acquire) == 0,
            "自動ゲインの録音・試聴を止めてください"
        );
        if running {
            let live = self.live_modes.snapshot(String::new(), true);
            anyhow::ensure!(
                !matches!(live.phase.as_str(), "queued" | "transitioning")
                    && !self.builtin.snapshot(true).pending,
                "モード・内蔵処理の反映を待ってください"
            );
            anyhow::ensure!(
                self.pending_audio_msgs.is_empty()
                    && self.command_tx.as_ref().is_none_or(|q| q.is_empty())
                    && self.gain_shared.settled.load(Ordering::Acquire)
                    && self.gain_shared.applied_revision.load(Ordering::Acquire)
                        == self.output_gain_revision
                    && self.gain_shared.confirmed_gain.load(Ordering::Acquire)
                        == self.output_gain.to_bits(),
                "音声設定の反映を待ってください"
            );
        }
        let mut plugins = Vec::new();
        for id in &self.plugin_manager.order {
            let instance = self
                .plugin_manager
                .get(id)
                .ok_or_else(|| anyhow!("VST構成を確認できません"))?;
            let state = instance.get_state()?;
            plugins.push(crate::bundle::CapturedPlugin {
                id: id.clone(),
                plugin: crate::vst_host::presets::PresetPlugin {
                    path: instance.path.clone(),
                    name: instance.name.clone(),
                    vendor: String::new(),
                    version: String::new(),
                    enabled: !self.plugin_manager.bypassed.contains(id),
                    muted: self.plugin_manager.muted.contains(id),
                    gain: *self.plugin_manager.gains.get(id).unwrap_or(&1.0),
                    state: Some(state),
                },
            });
        }
        Ok(crate::bundle::EngineCapture {
            control_revision: format!(
                "{}:{}:{}:{}",
                self.voice_revision,
                self.builtin.revision,
                self.output_gain_revision,
                self.live_modes.snapshot(String::new(), running).revision
            ),
            running,
            fixed_buffer_request_frames: if running {
                self.fixed_buffer_request_frames
            } else {
                self.bundle_last_fixed_buffer_request.flatten()
            },
            plugins,
            input_channels: vec![self.input_channel_l, self.input_channel_r],
            input_gain: self.voice_input_gain,
            output_gain: self.output_gain,
            global_mute: self.global_mute,
            global_bypass: self.global_bypass,
            noise: crate::vst_host::presets::ProfileNoiseControl {
                enabled: self.noise_reduction_enabled,
                mode: self.noise_control_mode.as_str().into(),
                strength: self.noise_control_strength,
                voice_guard: self.noise_voice_guard,
                learned_profile: None,
            },
            builtin: crate::vst_host::presets::ProfileBuiltinFx {
                preset: self.builtin.config.preset.as_str().into(),
                enabled: self.builtin.config.active,
                amount: self.builtin.config.amount,
                singing: self.builtin.config.singing,
                reverb: self.builtin.config.reverb,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_start_controls_reach_actual_asio_normalization_and_first_callback_levels() {
        for channels in [[4, 5], [6, 6]] {
            let mut engine = Engine::new();
            assert!(!engine.current_host_is_asio);
            engine
                .prepare_initial_controls(crate::ipc::StartControls {
                    input_gain: 0.,
                    output_gain: 0.,
                    input_channels: channels,
                    muted: true,
                    bypassed: true,
                })
                .unwrap();
            assert_eq!([engine.input_channel_l, engine.input_channel_r], channels);
            engine.current_host_is_asio = true;
            engine.current_channels = 22;
            engine.normalize_start_channels();
            assert_eq!([engine.input_channel_l, engine.input_channel_r], channels);
            let (muted, input_gain, mut output_gain) = engine.initial_callback_levels();
            assert!(muted && engine.global_bypass);
            assert_eq!(input_gain, 0.);
            assert_eq!(output_gain.next(), 0.);
        }
        let mut engine = Engine::new();
        engine
            .prepare_initial_controls(crate::ipc::StartControls {
                input_gain: 0.,
                output_gain: 0.,
                input_channels: [4, 5],
                muted: false,
                bypassed: false,
            })
            .unwrap();
        engine.normalize_start_channels();
        assert_eq!([engine.input_channel_l, engine.input_channel_r], [0, 1]);
    }
    #[test]
    fn stopped_capture_preserves_control_intent_without_rt_ack_or_audio_device() {
        let mut engine = Engine::new();
        engine.voice_input_gain = 0.;
        engine.input_channel_l = 4;
        engine.input_channel_r = 5;
        engine.set_global_mute_intent(true);
        engine.output_gain = 0.;
        let revision = engine.voice_revision;
        engine
            .pending_audio_msgs
            .push(AudioThreadMessage::SetInputGain(0.));
        let snapshot = engine.capture_bundle_state().unwrap();
        assert!(!snapshot.running);
        assert_eq!(snapshot.input_channels, [4, 5]);
        assert_eq!(snapshot.input_gain, 0.);
        assert_eq!(snapshot.output_gain, 0.);
        assert!(snapshot.global_mute);
        assert_eq!(engine.voice_revision, revision);
        assert_eq!(engine.pending_audio_msgs.len(), 1);
        engine.plugin_manager.pending_init.push("pending".into());
        assert!(engine.capture_bundle_state().is_err());
    }
}
