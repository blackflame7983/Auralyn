//! ボイスチェックの試聴：配信の送り先とは別の出力先で、録った声（加工前・加工後）を鳴らす。
//! 中核の `voice_check_preview`（Tauri 版の「加工前と加工後を聴く」と同じセッション）を使う。

use super::*;
use vst_host_lib::audio_engine::voice_check::preview::{
    Action, Options, Request, Snapshot, Source as PreviewSource,
};

/// 試聴のセッション。開くたびに番号を進め、変更の操作ごとに操作の番号を進める（Tauri 版と同じ約束）。
#[derive(Default)]
pub(super) struct Session {
    id: u64,
    operation: u64,
    /// 開いたときにエンジンが返す印。`None` は開いていない。
    epoch: Option<String>,
}

const CLIENT: &str = "auralyn-gpui";

impl Control {
    pub(super) fn listen(&mut self, listen: Listen) {
        let opened = self.listen.epoch.is_some();
        if !opened && !matches!(listen, Listen::Open) {
            return;
        }
        let result = self.listen_parts(listen).map(listening);
        let _ = self
            .notices
            .send(Notice::Listening(result.map_err(|e| e.to_string())));
    }

    fn listen_parts(&mut self, listen: Listen) -> anyhow::Result<Snapshot> {
        match listen {
            Listen::Open => {
                self.listen = Session {
                    id: self.listen.id + 1,
                    ..Session::default()
                };
                let opened = self.ask(Action::Open)?;
                self.listen.epoch = Some(opened.epoch);
                // 開いた答えの一覧は空（まだ読んでいない）なので、続けて読む。
                self.ask(Action::Devices)
            }
            Listen::Devices => self.ask(Action::Devices),
            Listen::Status => self.ask(Action::Status),
            Listen::Play {
                recording_id,
                device_id,
                source,
                looped,
            } => self.ask(Action::Start {
                recording_id,
                device_id,
                candidate_id: None,
                options: options(source, looped),
            }),
            Listen::Change { source, looped } => self.ask(Action::Update {
                options: options(source, looped),
            }),
            Listen::Stop => self.ask(Action::Stop),
            Listen::Close => {
                let closed = self.ask(Action::Close);
                self.listen.epoch = None;
                closed
            }
        }
    }

    fn ask(&mut self, action: Action) -> anyhow::Result<Snapshot> {
        if !matches!(action, Action::Status | Action::Devices) {
            self.listen.operation += 1;
        }
        self.host.voice_check_preview(Request {
            client_id: CLIENT.to_owned(),
            session_id: self.listen.id,
            operation_id: self.listen.operation,
            epoch: self.listen.epoch.clone(),
            action,
        })
    }
}

fn options(source: VoiceSource, looped: bool) -> Options {
    Options {
        source: match source {
            VoiceSource::Raw => PreviewSource::Raw,
            VoiceSource::Processed => PreviewSource::Processed,
        },
        loop_playback: looped,
        level_match: false,
    }
}

fn listening(snapshot: Snapshot) -> Listening {
    Listening {
        recording_id: snapshot.recording_id,
        playback: Playback::parse(&snapshot.state),
        position_ms: snapshot.position_ms,
        duration_ms: snapshot.duration_ms,
        source: match snapshot.source {
            PreviewSource::Raw => VoiceSource::Raw,
            PreviewSource::Processed => VoiceSource::Processed,
        },
        looped: snapshot.loop_playback,
        devices: snapshot
            .devices
            .into_iter()
            .map(|d| ListenDevice {
                id: d.id,
                name: d.name,
            })
            .collect(),
        error: snapshot.error,
        stale: snapshot.recording_stale,
    }
}
