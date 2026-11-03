use super::*;
use crate::audio_engine::mixing::{controls::Shared, Request, Snapshot};

impl Engine {
    pub(super) fn mixing_snapshot(&self) -> Snapshot {
        let shared = self.mixing_shared.as_deref();
        let settings = shared.and_then(Shared::read);
        let failed = self.mixing_output_failure_reported
            || shared.is_some_and(|shared| shared.failed.load(Ordering::Acquire));
        Snapshot {
            epoch: self.builtin.snapshot(false).epoch,
            revision: self.mixing_revision.to_string(),
            config: self.mixing_start.as_ref().map(|start| start.config.clone()),
            running: self.output_stream.is_some(),
            accompaniment: self
                .mixing_input_shared
                .as_ref()
                .map(|source| Box::new(source.snapshot())),
            voice_peak: shared.map_or([0.0; 2], |shared| Shared::peaks(&shared.voice_peak)),
            accompaniment_peak: shared
                .map_or([0.0; 2], |shared| Shared::peaks(&shared.accompaniment_peak)),
            mix_peak: shared.map_or([0.0; 2], |shared| Shared::peaks(&shared.mix_peak)),
            known_voice_processing_frames: settings
                .as_ref()
                .and_then(|settings| settings.known_voice_frames),
            pending: self.output_stream.is_some()
                && !failed
                && shared.is_some_and(|shared| {
                    shared.applied_revision.load(Ordering::Acquire) != self.mixing_revision
                }),
            failed,
            primary_clock: shared
                .filter(|shared| shared.primary_input_rate.load(Ordering::Relaxed) != 0)
                .map(|shared| crate::audio_engine::mixing::ClockSnapshot {
                    adaptive: shared.primary_adaptive.load(Ordering::Relaxed),
                    input_rate_hz: shared.primary_input_rate.load(Ordering::Relaxed),
                    output_rate_hz: shared.primary_output_rate.load(Ordering::Relaxed),
                    queued_frames: shared.primary_queued.load(Ordering::Relaxed),
                    correction_ppm: shared.primary_correction.load(Ordering::Relaxed),
                    underruns: shared
                        .primary_adaptive
                        .load(Ordering::Relaxed)
                        .then(|| shared.primary_underruns.load(Ordering::Relaxed)),
                }),
        }
    }
    pub(super) fn mixing_command(
        &mut self,
        request: Request,
    ) -> std::result::Result<Snapshot, String> {
        if let Request::Snapshot = request {
            return Ok(self.mixing_snapshot());
        }
        let (epoch, revision) = match &request {
            Request::Configure {
                expected_epoch,
                expected_revision,
                ..
            }
            | Request::Levels {
                expected_epoch,
                expected_revision,
                ..
            } => (expected_epoch, expected_revision),
            Request::Snapshot => unreachable!(),
        };
        if *epoch != self.builtin.snapshot(false).epoch
            || *revision != self.mixing_revision.to_string()
        {
            return Err("ミックスの条件が変わりました。現在の設定を読み直してください".into());
        }
        match request {
            Request::Configure { start, .. } => {
                if self.output_stream.is_some() || self.live_modes.armed {
                    return Err("音声と本番保護を停止してからオケの入力元を変更してください".into());
                }
                if let Some(start) = &start {
                    start.validate()?;
                }
                let next = self
                    .mixing_revision
                    .checked_add(2)
                    .ok_or("ミックス設定の世代を更新できません")?;
                self.mixing_shared = start
                    .as_ref()
                    .map(|start| Arc::new(Shared::new_at(&start.config.levels, next)));
                self.mixing_start = start;
                self.mixing_revision = next;
            }
            Request::Levels { levels, .. } => {
                levels.validate()?;
                let shared = self
                    .mixing_shared
                    .as_ref()
                    .ok_or("オケの入力元を先に設定してください")?;
                let current = shared.read().ok_or("ミックスの反映を待ってください")?;
                shared.update(&levels, current.known_voice_frames)?;
                self.mixing_revision = shared.revision();
                if let Some(start) = &mut self.mixing_start {
                    start.config.levels = levels;
                }
            }
            Request::Snapshot => unreachable!(),
        }
        self.builtin.invalidate_history();
        Ok(self.mixing_snapshot())
    }
    pub(super) fn sync_mixing_latency(&mut self) -> Result<()> {
        let Some(shared) = &self.mixing_shared else {
            return Ok(());
        };
        let state = shared
            .read()
            .ok_or_else(|| anyhow!("ミックス設定を取得できません"))?;
        let report = self.plugin_manager.latency_report(self.global_bypass);
        let known = report.1.and_then(|plugin| {
            let nr = if self.noise_reduction_enabled && !self.global_bypass {
                (self.current_sample_rate / 100.0).round() as u32
            } else {
                0
            };
            plugin.checked_add(nr)
        });
        if state.known_voice_frames != known {
            shared
                .update(&state.levels, known)
                .map_err(anyhow::Error::msg)?;
            self.mixing_revision = shared.revision();
        }
        Ok(())
    }
    pub(super) fn validate_mixing_start(&self, command: &Command) -> Result<()> {
        if self.mixing_start.is_none() {
            return Ok(());
        }
        match command {
            Command::CaptureBundleState => {
                anyhow::bail!("二入力の保存・復帰に対応する全体保存を使ってください")
            }
            Command::LiveOutput {
                config: Some(config),
            } => {
                anyhow::ensure!(
                    config.split_processing && config.device_id.is_some(),
                    "二入力では本人用と配信用の処理・出力を分けてください"
                );
                if let Some(crate::audio_engine::mixing::Start {
                    config:
                        crate::audio_engine::mixing::Config {
                            source: crate::audio_engine::mixing::Source::ProcessLoopback(source),
                            ..
                        },
                    ..
                }) = &self.mixing_start
                {
                    anyhow::ensure!(
                        config
                            .device_id
                            .as_deref()
                            .and_then(|id| id.strip_prefix("wasapi:"))
                            != Some(source.raw_endpoint_id.as_str()),
                        "原音用と配信用には別の出力先を指定してください"
                    );
                }
            }
            Command::Start {
                input_source,
                input_id,
                output_id,
                ..
            } => {
                anyhow::ensure!(
                    input_source.as_ref().is_none_or(
                        |source| source.source == crate::input_source::Config::default()
                    ),
                    "二入力の主入力は声用途のマイク機器を選んでください"
                );
                anyhow::ensure!(
                    self.live_output_config.split_processing
                        && self.live_output_config.device_id.is_some(),
                    "二入力では本人用と配信用の処理・出力を分けてください"
                );
                let start = self.mixing_start.as_ref().expect("確認済みの二入力設定");
                start.validate().map_err(anyhow::Error::msg)?;
                match &start.config.source {
                    crate::audio_engine::mixing::Source::Device(device) => {
                        anyhow::ensure!(
                            input_id.as_ref() != Some(&device.input_id),
                            "マイクとオケに同じ入力機器を重複指定できません"
                        );
                    }
                    crate::audio_engine::mixing::Source::ProcessLoopback(process) => {
                        anyhow::ensure!(
                            self.live_output_config
                                .device_id
                                .as_deref()
                                .and_then(|id| id.strip_prefix("wasapi:"))
                                != Some(process.raw_endpoint_id.as_str()),
                            "原音用と配信用には別の出力先を指定してください"
                        );
                        anyhow::ensure!(
                            output_id
                                .as_ref()
                                .is_none_or(|output| output.strip_prefix("wasapi:")
                                    != Some(process.raw_endpoint_id.as_str())),
                            "本人用とは別の原音用出力を指定してください"
                        );
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accompaniment_raw_endpoint_cannot_also_be_the_broadcast_sink() {
        let mut engine = Engine::new();
        engine.mixing_start = Some(serde_json::from_value(serde_json::json!({
            "config":{"version":1,"source":{"kind":"process_loopback","config":{"appKey":"a".repeat(64),"appName":"player.exe","rawEndpointId":"raw-id","purpose":"music"}},
            "levels":{"voice":{"gain":1.0,"muted":false},"accompaniment":{"gain":1.0,"muted":false},"monitorAccompaniment":true,"offsetMs":0}},
            "target":{"pid":123,"created":456}
        })).unwrap());
        let mut config = crate::audio_engine::live_output::Config {
            split_processing: true,
            device_id: Some("wasapi:raw-id".into()),
            ..Default::default()
        };
        assert!(engine
            .validate_mixing_start(&Command::LiveOutput {
                config: Some(config.clone())
            })
            .is_err());
        config.device_id = Some("wasapi:broadcast-id".into());
        assert!(engine
            .validate_mixing_start(&Command::LiveOutput {
                config: Some(config)
            })
            .is_ok());
    }
}
