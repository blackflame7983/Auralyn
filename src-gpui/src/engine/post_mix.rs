//! ミックス後の VST（配信音だけを仕上げる、声用とは別の並び）。Tauri 版と同じ `AudioHost::post_mix` を使い、保存も同じ。
//! 変える操作には、最後に読んだ世代（epoch・revision）を付ける。ずれていれば断られるので、読み直して画面へ送る。

use super::*;
use auralyn_ui_model::post_mix::{self as rules, Entry, PostMix};
use vst_host_lib::post_mix::{Request as PostRequest, Snapshot as PostSnapshot};

/// ミックス後の VST の操作。
#[derive(Debug, Clone)]
pub enum PostAction {
    Read,
    Enable(bool),
    /// 保存した並びを読み込む（起動し直したあと、有効にする前に要る）。
    Restore,
    Add(Candidate),
    Remove(String),
    Move {
        id: String,
        up: bool,
    },
    Enabled {
        id: String,
        enabled: bool,
    },
    Muted {
        id: String,
        muted: bool,
    },
    Gain {
        id: String,
        gain: f32,
    },
    Editor(String),
    Save,
    /// 保存していない変更を捨てて、保存した並びに戻す。
    Reload,
}

impl Control {
    /// 読むだけなら状態を送る。変える操作なら、その結果（`PostMixDone`）を送ってから、今の状態を送る。
    pub(super) fn post_mix(&mut self, action: PostAction) {
        let request = match action {
            PostAction::Read => {
                let result = self.host.post_mix(PostRequest::Snapshot);
                return self.send_post(result);
            }
            PostAction::Move { id, up } => {
                let Some(ids) = self.posted.as_ref().and_then(|s| moved(s, &id, up)) else {
                    return;
                };
                Request::Reorder(ids)
            }
            other => Request::Plain(other),
        };
        let result = self.post_request(request);
        let done = result.as_ref().map(|_| ()).map_err(|e| e.to_string());
        let _ = self.notices.send(Notice::PostMixDone(done));
        let result = result.or_else(|_| self.host.post_mix(PostRequest::Snapshot));
        self.send_post(result);
    }

    fn send_post(&mut self, result: anyhow::Result<PostSnapshot>) {
        let notice = match result {
            Ok(snapshot) => {
                let view = view(&snapshot);
                self.posted = Some(snapshot);
                Ok(view)
            }
            Err(e) => Err(e.to_string()),
        };
        let _ = self.notices.send(Notice::PostMix(notice));
    }

    /// 最後に読んだ世代を付けて頼む。まだ読んでいなければ先に読む。
    fn post_request(&mut self, request: Request) -> anyhow::Result<PostSnapshot> {
        if self.posted.is_none() {
            self.posted = Some(self.host.post_mix(PostRequest::Snapshot)?);
        }
        let (epoch, revision) = self
            .posted
            .as_ref()
            .map(|s| (s.epoch.clone(), s.revision.clone()))
            .unwrap_or_default();
        self.host.post_mix(request.with(epoch, revision))
    }
}

/// 世代を付ける前の頼みごと。
enum Request {
    Plain(PostAction),
    Reorder(Vec<String>),
}

impl Request {
    fn with(self, expected_epoch: String, expected_revision: String) -> PostRequest {
        let action = match self {
            Self::Reorder(ids) => {
                return PostRequest::Reorder {
                    expected_epoch,
                    expected_revision,
                    ids,
                }
            }
            Self::Plain(action) => action,
        };
        match action {
            PostAction::Read | PostAction::Move { .. } => PostRequest::Snapshot,
            PostAction::Enable(enabled) => PostRequest::Enable {
                expected_epoch,
                expected_revision,
                enabled,
            },
            PostAction::Restore => PostRequest::RestoreSaved {
                expected_epoch,
                expected_revision,
            },
            PostAction::Add(candidate) => PostRequest::Add {
                expected_epoch,
                expected_revision,
                path: candidate.path,
                class_id: candidate.class_id,
            },
            PostAction::Remove(id) => PostRequest::Remove {
                expected_epoch,
                expected_revision,
                id,
            },
            PostAction::Enabled { id, enabled } => PostRequest::Bypass {
                expected_epoch,
                expected_revision,
                id,
                active: !enabled,
            },
            PostAction::Muted { id, muted } => PostRequest::Mute {
                expected_epoch,
                expected_revision,
                id,
                active: muted,
            },
            PostAction::Gain { id, gain } => PostRequest::Gain {
                expected_epoch,
                expected_revision,
                id,
                value: gain,
            },
            PostAction::Editor(id) => PostRequest::Editor {
                expected_epoch,
                expected_revision,
                id,
            },
            PostAction::Save => PostRequest::Save {
                expected_epoch,
                expected_revision,
            },
            PostAction::Reload => PostRequest::Reload {
                expected_epoch,
                expected_revision,
            },
        }
    }
}

/// 1つ上（下）へ動かしたあとの順。端なら `None`。
fn moved(snapshot: &PostSnapshot, id: &str, up: bool) -> Option<Vec<String>> {
    let items: Vec<(String, bool)> = snapshot
        .plugins
        .iter()
        .map(|p| (p.id.clone(), true))
        .collect();
    let index = items.iter().position(|(other, _)| other == id)?;
    rack::reordered(&items, index, up).map(|(_, ids)| ids)
}

fn view(snapshot: &PostSnapshot) -> (PostMix, Vec<Slot>) {
    let saved: Vec<Entry> = snapshot
        .saved_plugins
        .iter()
        .map(|p| Entry {
            path: p.path.clone(),
            class_id: p.class_id.clone(),
            enabled: p.enabled,
            muted: p.muted,
            gain: p.gain,
        })
        .collect();
    let current: Vec<Entry> = snapshot
        .plugins
        .iter()
        .map(|p| Entry {
            path: p.path.clone(),
            class_id: p.class_id.clone(),
            enabled: p.enabled,
            muted: p.muted,
            gain: p.gain,
        })
        .collect();
    let slots = snapshot
        .plugins
        .iter()
        .map(|p| Slot {
            id: p.id.clone(),
            name: p.name.clone(),
            enabled: p.enabled,
            muted: p.muted,
            gain: p.gain,
            loaded: true,
            path: p.path.clone(),
            class_id: p.class_id.clone(),
            state: None,
        })
        .collect();
    let post = PostMix {
        enabled: snapshot.enabled,
        running: snapshot.running,
        saved: snapshot
            .saved_plugins
            .iter()
            .map(|p| p.name.clone())
            .collect(),
        restored: snapshot.restored,
        unsaved: snapshot.restored && rules::unsaved(&saved, &current),
        failed: snapshot.failed == Some(true),
        error: snapshot.error.clone(),
    };
    (post, slots)
}
