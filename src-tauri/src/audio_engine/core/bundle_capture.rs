//! 制御スレッドだけで採取する。component stateの内部変動とcontroller別stateは保証外。
use super::*;
impl Engine {
    pub(super) fn prepare_start_routing(&mut self, routing: Option<crate::ipc::ChannelRouting>) {
        self.start_routing = routing;
        if let Some(routing) = routing {
            self.output_routing = routing.output_routing;
        }
    }
    pub(super) fn validate_output_for_input(&self, input: [usize; 2]) -> Result<()> {
        crate::ipc::ChannelRouting {
            input_channels: Some(input),
            output_routing: self.output_routing,
        }
        .resolve(
            self.current_host_is_asio,
            self.current_input_channels,
            self.current_channels,
        )
        .map(|_| ())
        .map_err(|error| anyhow!(error))
    }
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
        self.output_routing = controls.output_routing;
        Ok(())
    }
    pub(super) fn normalize_start_channels(&mut self) {
        [self.input_channel_l, self.input_channel_r] = normalized_channels(
            self.current_host_is_asio,
            [self.input_channel_l, self.input_channel_r],
            self.current_input_channels,
        );
    }
    pub(super) fn resolve_start_channels(&mut self) -> Result<()> {
        if let Some(routing) = self.start_routing {
            let (resolved, _) = routing
                .resolve(
                    self.current_host_is_asio,
                    self.current_input_channels,
                    self.current_channels,
                )
                .map_err(|error| anyhow!(error))?;
            [self.input_channel_l, self.input_channel_r] =
                resolved.input_channels.expect("resolved input channels");
            self.output_routing = resolved.output_routing;
        } else {
            if self.output_routing == crate::ipc::OutputRouting::Legacy {
                self.normalize_start_channels();
            }
            let (resolved, _) = crate::ipc::ChannelRouting {
                input_channels: Some([self.input_channel_l, self.input_channel_r]),
                output_routing: self.output_routing,
            }
            .resolve(
                self.current_host_is_asio,
                self.current_input_channels,
                self.current_channels,
            )
            .map_err(|error| anyhow!(error))?;
            self.output_routing = resolved.output_routing;
        }
        Ok(())
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
                    class_id: Some(instance.class_id.clone()).filter(|id| !id.is_empty()),
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
            output_routing: self.output_routing,
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
                deesser: self.builtin.config.deesser,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_same_spec_restart_without_routing_preserves_held_output() {
        use crate::ipc::{ChannelRouting, Command, OutputRouting};
        let start = Command::Start {
            input_source: None,
            host: "ASIO".into(),
            input: Some("input".into()),
            output: Some("output".into()),
            input_id: None,
            output_id: None,
            buffer_size: Some(512),
            sample_rate: Some(48000),
            initial_controls: None,
            channel_routing: None,
        };
        let bound = crate::audio_engine::live_modes::StartSpec::from_command(&start).unwrap();
        assert!(crate::audio_engine::live_modes::guard(true, Some(&bound), &start).is_ok());
        for (routing, output) in [
            (OutputRouting::Independent { channels: [0, 1] }, [0, 1]),
            (OutputRouting::Insert, [2, 3]),
        ] {
            let mut engine = Engine::new();
            engine.current_host_is_asio = true;
            engine.current_input_channels = 4;
            engine.current_channels = 4;
            [engine.input_channel_l, engine.input_channel_r] = [2, 3];
            engine.output_routing = routing;
            engine.prepare_start_routing(None);
            engine.resolve_start_channels().unwrap();
            assert_eq!(engine.output_routing, routing);
            assert_eq!(
                crate::audio_engine::queue_diagnostics::routed_output_pair(
                    routing,
                    true,
                    [engine.input_channel_l, engine.input_channel_r],
                    4
                ),
                output
            );
        }
        let mut engine = Engine::new();
        engine.current_host_is_asio = true;
        engine.current_input_channels = 4;
        engine.current_channels = 2;
        [engine.input_channel_l, engine.input_channel_r] = [2, 3];
        engine.output_routing = OutputRouting::Insert;
        engine.prepare_start_routing(None);
        assert!(engine.resolve_start_channels().is_err());
        engine.prepare_start_routing(Some(ChannelRouting {
            input_channels: Some([2, 3]),
            output_routing: OutputRouting::Independent { channels: [0, 1] },
        }));
        engine.resolve_start_channels().unwrap();
        assert_eq!(
            engine.output_routing,
            OutputRouting::Independent { channels: [0, 1] }
        );
        engine.current_input_channels = 2;
        engine.prepare_start_routing(None);
        assert!(engine.resolve_start_channels().is_err());
    }
    #[test]
    fn input_changes_require_insert_outputs_and_keep_independent_output() {
        use crate::ipc::OutputRouting;
        let mut engine = Engine::new();
        engine.current_host_is_asio = true;
        engine.current_input_channels = 4;
        engine.current_channels = 2;
        engine.output_routing = OutputRouting::Insert;
        assert!(engine.validate_output_for_input([2, 3]).is_err());
        assert!(engine.validate_output_for_input([0, 1]).is_ok());
        engine.output_routing = OutputRouting::Independent { channels: [0, 1] };
        assert!(engine.validate_output_for_input([2, 3]).is_ok());
        assert_eq!(
            engine.output_routing,
            OutputRouting::Independent { channels: [0, 1] }
        );
    }
    #[test]
    fn controls_only_start_checks_output_bounds_and_insert_before_callbacks() {
        use crate::ipc::OutputRouting;
        let mut engine = Engine::new();
        engine.current_host_is_asio = true;
        engine.current_input_channels = 4;
        engine.current_channels = 2;
        let mut controls = crate::ipc::StartControls {
            input_gain: 0.5,
            output_gain: 0.6,
            input_channels: [2, 3],
            output_routing: OutputRouting::Insert,
            muted: true,
            bypassed: true,
        };
        engine.prepare_initial_controls(controls).unwrap();
        engine.start_routing = Some(controls.routing());
        assert!(engine.resolve_start_channels().is_err());
        controls.output_routing = OutputRouting::Independent { channels: [0, 2] };
        engine.start_routing = Some(controls.routing());
        assert!(engine.resolve_start_channels().is_err());
        controls.output_routing = OutputRouting::Independent { channels: [0, 1] };
        engine.start_routing = Some(controls.routing());
        engine.resolve_start_channels().unwrap();
        assert_eq!([engine.input_channel_l, engine.input_channel_r], [2, 3]);
        assert_eq!(engine.output_routing, controls.output_routing);
        assert!(engine.global_mute && engine.global_bypass);
    }
    #[test]
    fn explicit_start_routing_resolves_before_callback_without_changing_controls() {
        let mut engine = Engine::new();
        engine.current_host_is_asio = true;
        engine.current_input_channels = 4;
        engine.current_channels = 4;
        engine.input_channel_l = 0;
        engine.input_channel_r = 1;
        engine.voice_input_gain = 0.4;
        engine.global_mute = true;
        engine.global_bypass = true;
        engine.start_routing = Some(crate::ipc::ChannelRouting {
            input_channels: Some([2, 3]),
            output_routing: crate::ipc::OutputRouting::Independent { channels: [0, 1] },
        });
        engine.resolve_start_channels().unwrap();
        assert_eq!([engine.input_channel_l, engine.input_channel_r], [2, 3]);
        assert_eq!(engine.voice_input_gain, 0.4);
        assert!(engine.global_mute && engine.global_bypass);
        engine.start_routing.as_mut().unwrap().input_channels = Some([2, 4]);
        assert!(engine.resolve_start_channels().is_err());
        engine.start_routing.as_mut().unwrap().input_channels = Some([2, 3]);
        engine.start_routing.as_mut().unwrap().output_routing =
            crate::ipc::OutputRouting::Independent { channels: [0, 4] };
        assert!(engine.resolve_start_channels().is_err());
    }
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
                    output_routing: crate::ipc::OutputRouting::Legacy,
                    muted: true,
                    bypassed: true,
                })
                .unwrap();
            assert_eq!([engine.input_channel_l, engine.input_channel_r], channels);
            engine.current_host_is_asio = true;
            engine.current_input_channels = 22;
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
                output_routing: crate::ipc::OutputRouting::Legacy,
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
