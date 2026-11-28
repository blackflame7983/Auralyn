//! 配信ミックス（声にオケを混ぜる。オケは入力機器かアプリの音）。`AudioHost::mixing` を使い、保存も同じ `mixing.json`。
//! 変更の操作には、最後に読んだ世代（epoch・revision）を付ける。ずれていれば断られるので、読み直して画面へ送る。

use super::*;
use auralyn_ui_model::mix::{
    self as rules, App as MixApp, Change as MixChange, Levels as MixLevels, Mix, Route as MixRoute,
    Source as MixSource,
};
use vst_host_lib::audio_engine::mixing::{
    Config as MixConfig, Device as MixDevice, Levels as EngineLevels, OffsetContext,
    Source as EngineSource, Track,
};
use vst_host_lib::input_source::{Config as InputSource, ProcessConfig, Purpose};
use vst_host_lib::mixing::{Request as MixRequest, Snapshot as MixSnapshot};

/// 配信ミックスの操作。
#[derive(Debug, Clone, PartialEq)]
pub enum MixAction {
    Read,
    /// 入力機器の2チャンネルを混ぜ始める（音量は今の値を引き継ぐ）。
    Apply {
        input_id: String,
        channels: [usize; 2],
    },
    /// アプリの音を混ぜ始める。`candidate_id` は最後に読んだ一覧のもの、`route` はそのアプリが音を出している出力先。
    ApplyApp {
        candidate_id: String,
        key: String,
        name: String,
        route: String,
    },
    /// オケに選べる起動中のアプリを読む。
    Apps,
    /// 混ぜるのをやめる（保存も消える）。
    Disable,
    /// 保存を読み直す（保存が読めない・書き換えられたあと。音声を止めているときだけ）。
    Reload,
    /// 音量・ミュート・返し・時間差。時間差を変えたら、今の機材の組み合わせを一緒に記録する。
    Levels(MixChange),
    /// 今の時間差を、今の機材で確かめたものとして記録する。
    ConfirmOffset,
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
            MixAction::Apps => {
                let apps = vst_host_lib::mixing::apps(&mut self.host)
                    .map(|apps| apps.into_iter().map(app).collect())
                    .map_err(|e| e.to_string());
                let _ = self.notices.send(Notice::MixApps(apps));
                return;
            }
            MixAction::Apply { input_id, channels } => self.configure(
                EngineSource::Device(MixDevice {
                    host: "WASAPI".into(),
                    input_id,
                    input_channels: channels,
                }),
                None,
            ),
            MixAction::ApplyApp {
                candidate_id,
                key,
                name,
                route,
            } => self.configure(
                EngineSource::ProcessLoopback(ProcessConfig {
                    app_key: key,
                    app_name: name,
                    raw_endpoint_id: route,
                    purpose: Purpose::Music,
                }),
                Some(candidate_id),
            ),
            MixAction::Disable => self.mix_request(|epoch, revision| MixRequest::Configure {
                expected_epoch: epoch,
                expected_revision: revision,
                config: None,
                candidate_id: None,
            }),
            MixAction::Reload => self.mix_request(|epoch, revision| MixRequest::Reload {
                expected_epoch: epoch,
                expected_revision: revision,
            }),
            MixAction::Levels(change) => self.set_levels(Some(change)),
            MixAction::ConfirmOffset => self.set_levels(None),
        };
        let done = result.as_ref().map(|_| ()).map_err(|e| e.to_string());
        let _ = self.notices.send(Notice::MixDone(done));
        let result = result.or_else(|_| self.host.mixing(MixRequest::Snapshot));
        self.send_mix(result);
    }

    fn send_mix(&mut self, result: anyhow::Result<MixSnapshot>) {
        let notice = match result {
            Ok(snapshot) => {
                // 表示の「確認済みか」だけなので、今の組み合わせを読めなければ「分からない」と出す。
                let current = match &snapshot.engine.config {
                    Some(config) => self.offset_context(&config.source).ok().flatten(),
                    None => None,
                };
                let view = view(&snapshot, current.as_ref());
                self.mixed = Some(snapshot);
                Ok(view)
            }
            Err(e) => Err(e.to_string()),
        };
        let _ = self.notices.send(Notice::Mix(notice));
    }

    /// 取り込み口を変える（音量は今の値を引き継ぐ）。
    fn configure(
        &mut self,
        source: EngineSource,
        candidate_id: Option<String>,
    ) -> anyhow::Result<MixSnapshot> {
        let levels = self.mix_engine_levels().unwrap_or_default();
        self.mix_request(|epoch, revision| MixRequest::Configure {
            expected_epoch: epoch,
            expected_revision: revision,
            config: Some(MixConfig {
                version: 1,
                source,
                levels,
            }),
            candidate_id,
        })
    }

    /// 音量・ミュート・返し・時間差を変える。時間差を変えたら今の機材の組み合わせで記録を置き換え、
    /// 変えなければ前の記録を保つ。`None` は何も変えずに、今の機材で記録し直す（確認済みにする）。
    fn set_levels(&mut self, change: Option<MixChange>) -> anyhow::Result<MixSnapshot> {
        let confirm = change.is_none();
        let previous = self
            .mix_engine_levels()
            .ok_or_else(|| anyhow::anyhow!("mixing is not active"))?;
        let source = self
            .mixed
            .as_ref()
            .and_then(|s| s.engine.config.as_ref())
            .map(|config| config.source.clone())
            .ok_or_else(|| anyhow::anyhow!("mixing is not active"))?;
        let mut levels = match change {
            Some(change) => with(previous.clone(), change),
            None => previous.clone(),
        };
        if confirm || levels.offset_ms != previous.offset_ms {
            let context = self.offset_context(&source)?;
            anyhow::ensure!(
                context.is_some() || !confirm,
                "the current audio devices are unknown"
            );
            levels.offset_context = context;
        }
        self.mix_request(|epoch, revision| MixRequest::Levels {
            expected_epoch: epoch,
            expected_revision: revision,
            levels,
        })
    }

    /// 今の機材の組み合わせ。`source` は適用中のオケの取り込み口。
    /// 声にアプリの音を使っている・まだ開始していないときは `None`。配信用の出力を読めなければ `Err`。
    fn offset_context(&mut self, source: &EngineSource) -> anyhow::Result<Option<OffsetContext>> {
        let Some(audio) = self.host.get_state().config else {
            return Ok(None);
        };
        let broadcast_id = self.host.live_output(None)?.config.device_id;
        if matches!(audio.input_source, Some(InputSource::ProcessLoopback(_))) {
            return Ok(None);
        }
        let ids = (
            rules::identity(audio.input_id.as_deref(), audio.input.as_deref()),
            rules::identity(audio.output_id.as_deref(), audio.output.as_deref()),
            audio.routing.and_then(|routing| routing.input_channels),
        );
        let (Some(voice_input_id), Some(output_id), Some(voice_channels)) = ids else {
            return Ok(None);
        };
        // 区切り文字を含む ID でもぶつからないよう JSON の配列にする（保存済みの値と同じ文字列になる）。
        let accompaniment = match source {
            EngineSource::Device(device) => serde_json::json!([
                "device",
                device.input_id,
                device.input_channels[0],
                device.input_channels[1]
            ]),
            EngineSource::ProcessLoopback(app) => {
                serde_json::json!(["process_loopback", app.app_key, app.raw_endpoint_id])
            }
        }
        .to_string();
        Ok(Some(OffsetContext {
            voice_input_id,
            voice_channels,
            accompaniment,
            output_id,
            broadcast_id,
        }))
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
        offset_ms: next.offset_ms,
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
        offset_ms: levels.offset_ms,
    }
}

fn ui_context(context: &OffsetContext) -> rules::OffsetContext {
    rules::OffsetContext {
        voice_input_id: context.voice_input_id.clone(),
        voice_channels: context.voice_channels,
        accompaniment: context.accompaniment.clone(),
        output_id: context.output_id.clone(),
        broadcast_id: context.broadcast_id.clone(),
    }
}

fn source(config: &MixConfig) -> MixSource {
    match &config.source {
        EngineSource::Device(device) => MixSource::Device {
            input_id: device.input_id.clone(),
            channels: device.input_channels,
        },
        EngineSource::ProcessLoopback(app) => MixSource::App {
            key: app.app_key.clone(),
            name: app.app_name.clone(),
            route: app.raw_endpoint_id.clone(),
        },
    }
}

fn app(app: vst_host_lib::mixing::App) -> MixApp {
    MixApp {
        id: app.id,
        key: app.app_key,
        name: app.name,
        routes: app
            .routes
            .into_iter()
            .map(|r| MixRoute {
                id: r.id,
                name: r.name,
                muted: r.muted,
            })
            .collect(),
    }
}

/// `current` は今の機材の組み合わせ（分からなければ `None`）。
fn view(snapshot: &MixSnapshot, current: Option<&OffsetContext>) -> Mix {
    let active = snapshot.engine.config.as_ref();
    let offset = match active {
        Some(config) => rules::offset_status(
            config.levels.offset_ms,
            config
                .levels
                .offset_context
                .as_ref()
                .map(ui_context)
                .as_ref(),
            current.map(ui_context).as_ref(),
        ),
        None => rules::OffsetStatus::None,
    };
    Mix {
        offset,
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
