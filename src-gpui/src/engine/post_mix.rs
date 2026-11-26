//! ミックス後の VST（配信音だけを仕上げる、声用とは別の並び）。Tauri 版と同じ `AudioHost::post_mix` を使い、保存も同じ。
//! 変える操作には、画面が最後に見た世代（epoch・revision）を付ける。見た後に変わっていれば断られる（二度押しや古い行への操作を通さない）。
//! どの操作のあとも読み直して画面へ送る。

use super::*;
use auralyn_ui_model::post_mix::PostMix;
use vst_host_lib::post_mix::{Request as PostRequest, Snapshot as PostSnapshot};

/// 画面が最後に見た世代（epoch・revision）。変える操作に付けて、見た後に変わっていれば断らせる。
pub type Witness = (String, String);

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
    /// 保存が読めないときの復旧：今の保存を脇へ保管し、無効にする。
    Reset,
}

impl Control {
    /// 読むだけなら状態を送る。変える操作なら、画面が見た世代を付けて頼み、その結果（`PostMixDone`）を送ってから、今の状態を送る。
    pub(super) fn post_mix(&mut self, action: PostAction, seen: Option<Witness>) {
        let request = match (action, seen) {
            (PostAction::Read, _) => None,
            (_, None) => Some(Err(anyhow::anyhow!("post-mix state has not been read yet"))),
            (action, Some((epoch, revision))) => {
                request(action, epoch, revision, self.posted.as_ref()).map(Ok)
            }
        };
        if let Some(request) = request {
            let result = request.and_then(|request| self.host.post_mix(request));
            let done = result.as_ref().map(|_| ()).map_err(|e| e.to_string());
            let _ = self.notices.send(Notice::PostMixDone(done));
        }
        let result = self.host.post_mix(PostRequest::Snapshot);
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

    /// 診断に出す配信ミックスの値（Tauri 版の「オケ・配信VSTの診断」と同じ項目）。読めない部分は空のまま。
    pub(super) fn mix_stats(&mut self) -> diagnostics::Mix {
        let mut stats = diagnostics::Mix::default();
        if let Ok(snapshot) = self.host.mixing(vst_host_lib::mixing::Request::Snapshot) {
            let engine = snapshot.engine;
            if let Some(a) = engine.accompaniment {
                stats.captured = Some((a.captured_frames, a.nonzero_frames));
                stats.queued = Some(a.queued_frames);
                stats.correction_ppm = Some(a.correction_ppm);
                stats.discontinuities = Some(a.discontinuities);
                stats.timestamp_errors = Some(a.timestamp_errors);
                stats.nonfinite = Some(a.nonfinite_samples);
                stats.discarded = Some(a.waiting_discarded_frames);
            }
            if let Some(clock) = engine.primary_clock {
                stats.primary_queued = Some(clock.queued_frames);
                stats.primary_correction_ppm = Some(clock.correction_ppm);
                stats.underruns = clock.underruns;
            }
            stats.voice_frames = engine.known_voice_processing_frames;
        }
        if let Ok(post) = self.host.post_mix(PostRequest::Snapshot) {
            stats.attached = post.attached;
            stats.ready = post.ready;
            stats.failed = post.failed;
            stats.packets = post.processed_packets;
            stats.sample_rate = post.sample_rate;
            stats.transport_frames = Some(post.transport_latency_frames);
            stats.declared_frames = post.declared_plugin_latency_frames;
        }
        stats
    }
}

/// 画面が見た世代を付けた頼みごと。読むだけ・動かせない（端）なら `None`。
/// 並べ替えの順は最後に読んだ並びから作る（画面が見た世代と違えば、ホストが断る）。
fn request(
    action: PostAction,
    expected_epoch: String,
    expected_revision: String,
    posted: Option<&PostSnapshot>,
) -> Option<PostRequest> {
    Some(match action {
        PostAction::Read => return None,
        PostAction::Move { id, up } => PostRequest::Reorder {
            expected_epoch,
            expected_revision,
            ids: moved(posted?, &id, up)?,
        },
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
        PostAction::Reset => PostRequest::Reset {
            expected_epoch,
            expected_revision,
        },
    })
}

/// 1つ上（下）へ動かしたあとの順。端なら `None`。
fn moved(snapshot: &PostSnapshot, id: &str, up: bool) -> Option<Vec<String>> {
    let ids: Vec<&str> = snapshot.plugins.iter().map(|p| p.id.as_str()).collect();
    let index = ids.iter().position(|other| *other == id)?;
    let other = rack::neighbour(ids.len(), index, up)?;
    let mut ids: Vec<String> = ids.into_iter().map(str::to_owned).collect();
    ids.swap(index, other);
    Some(ids)
}

fn view(snapshot: &PostSnapshot) -> (PostMix, Vec<Slot>) {
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
        seen: (snapshot.epoch.clone(), snapshot.revision.clone()),
        enabled: snapshot.enabled,
        running: snapshot.running,
        saved: snapshot
            .saved_plugins
            .iter()
            .map(|p| p.name.clone())
            .collect(),
        restored: snapshot.restored,
        failed: snapshot.failed == Some(true),
        error: snapshot.error.clone(),
    };
    (post, slots)
}
