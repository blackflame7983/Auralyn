//! 配信ミックス（声にオケを混ぜる）。Tauri 版と同じ `AudioHost::mixing` を使い、保存も同じ `mixing.json`。
//! 変更の操作には、最後に読んだ世代（epoch・revision）を付ける。ずれていれば断られるので、読み直して画面へ送る。

use super::*;
use auralyn_ui_model::mix::{Change as MixChange, Levels as MixLevels, Mix, Source as MixSource};
use vst_host_lib::audio::mixing::{Request as MixRequest, Snapshot as MixSnapshot};
use vst_host_lib::audio_engine::mixing::{
    Config as MixConfig, Device as MixDevice, Levels as EngineLevels, Source as EngineSource, Track,
};

/// 配信ミックスの操作。
#[derive(Debug, Clone)]
pub enum MixAction {
    Read,
    /// 入力機器の2チャンネルを混ぜ始める（音量は今の値を引き継ぐ）。
    Apply {
        input_id: String,
        channels: [usize; 2],
    },
    /// 混ぜるのをやめる（保存も消える。Tauri 版と同じ）。
    Disable,
    Levels(MixChange),
}

impl Control {
    /// 読むだけなら状態を送る。変える操作なら、その結果（`MixDone`）を送ってから、今の状態を送る
    /// （断られたら読み直す。世代のずれなら、次の操作は通る）。
    pub(super) fn mix(&mut self, action: MixAction) {
        let result = match action {
            MixAction::Read => {
                let result = self.host.mixing(MixRequest::Snapshot);
                return self.send_mix(result);
            }
            MixAction::Apply { input_id, channels } => {
                let levels = self.mix_engine_levels().unwrap_or_default();
                self.mix_request(|epoch, revision| MixRequest::Configure {
                    expected_epoch: epoch,
                    expected_revision: revision,
                    config: Some(MixConfig {
                        version: 1,
                        source: EngineSource::Device(MixDevice {
                            host: "WASAPI".into(),
                            input_id,
                            input_channels: channels,
                        }),
                        levels,
                    }),
                    candidate_id: None,
                })
            }
            MixAction::Disable => self.mix_request(|epoch, revision| MixRequest::Configure {
                expected_epoch: epoch,
                expected_revision: revision,
                config: None,
                candidate_id: None,
            }),
            MixAction::Levels(change) => match self.mix_engine_levels() {
                Some(levels) => {
                    let levels = with(levels, change);
                    self.mix_request(|epoch, revision| MixRequest::Levels {
                        expected_epoch: epoch,
                        expected_revision: revision,
                        levels,
                    })
                }
                None => Err(anyhow::anyhow!("mixing is not active")),
            },
        };
        let done = result.as_ref().map(|_| ()).map_err(|e| e.to_string());
        let _ = self.notices.send(Notice::MixDone(done));
        let result = result.or_else(|_| self.host.mixing(MixRequest::Snapshot));
        self.send_mix(result);
    }

    fn send_mix(&mut self, result: anyhow::Result<MixSnapshot>) {
        let notice = match result {
            Ok(snapshot) => {
                let view = view(&snapshot);
                self.mixed = Some(snapshot);
                Ok(view)
            }
            Err(e) => Err(e.to_string()),
        };
        let _ = self.notices.send(Notice::Mix(notice));
    }

    /// 最後に読んだ世代を付けて頼む。まだ読んでいなければ先に読む。
    fn mix_request(
        &mut self,
        request: impl FnOnce(String, String) -> MixRequest,
    ) -> anyhow::Result<MixSnapshot> {
        if self.mixed.is_none() {
            self.mixed = Some(self.host.mixing(MixRequest::Snapshot)?);
        }
        let last = self
            .mixed
            .as_ref()
            .map(|s| (s.engine.epoch.clone(), s.engine.revision.clone()));
        let (epoch, revision) = last.unwrap_or_default();
        self.host.mixing(request(epoch, revision))
    }

    /// 適用中、無ければ保存のエンジン側の音量（オフセットを保つため、画面の値でなくこちらに重ねる）。
    fn mix_engine_levels(&self) -> Option<EngineLevels> {
        let snapshot = self.mixed.as_ref()?;
        snapshot
            .engine
            .config
            .as_ref()
            .or(snapshot.saved_config.as_ref())
            .map(|config| config.levels.clone())
    }
}

fn with(levels: EngineLevels, change: MixChange) -> EngineLevels {
    let next = ui_levels(&levels).with(change);
    EngineLevels {
        voice: Track {
            gain: next.voice_gain,
            muted: next.voice_muted,
        },
        accompaniment: Track {
            gain: next.music_gain,
            muted: next.music_muted,
        },
        monitor_accompaniment: next.monitor_music,
        ..levels
    }
}

fn ui_levels(levels: &EngineLevels) -> MixLevels {
    MixLevels {
        voice_gain: levels.voice.gain,
        voice_muted: levels.voice.muted,
        music_gain: levels.accompaniment.gain,
        music_muted: levels.accompaniment.muted,
        monitor_music: levels.monitor_accompaniment,
    }
}

fn source(config: &MixConfig) -> MixSource {
    match &config.source {
        EngineSource::Device(device) => MixSource::Device {
            input_id: device.input_id.clone(),
            channels: device.input_channels,
        },
        EngineSource::ProcessLoopback(app) => MixSource::App {
            name: app.app_name.clone(),
        },
    }
}

fn view(snapshot: &MixSnapshot) -> Mix {
    let active = snapshot.engine.config.as_ref();
    Mix {
        active: active.map(source),
        saved: snapshot.saved_config.as_ref().map(source),
        levels: active
            .or(snapshot.saved_config.as_ref())
            .map(|config| ui_levels(&config.levels)),
        running: snapshot.engine.running,
        failed: snapshot.engine.failed,
        error: snapshot.error.clone(),
    }
}
