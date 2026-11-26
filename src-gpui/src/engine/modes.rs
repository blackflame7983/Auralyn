//! 歌・雑談モード。Tauri 版と同じ `AudioHost::live_modes` を使い、保存もホストの同じ場所。
//! 切り替え・保護の操作には、最後に読んだ `epoch` と、この窓の id・通し番号を付ける（ホストが古い操作を断る）。

use super::*;
use auralyn_ui_model::live_modes::{LiveModes, Mode, Transaction};
use vst_host_lib::audio_engine::builtin::Request as BuiltinRequest;
use vst_host_lib::audio_engine::live_modes::{
    Intent, Mode as HostMode, Request as ModesRequest, Snapshot as ModesSnapshot,
};

/// 歌・雑談モードの操作。
#[derive(Debug, Clone, PartialEq)]
pub enum ModeAction {
    Read,
    Select(Mode),
    /// 本番保護を付ける・外す。
    Protect(bool),
    /// 今の音づくりを、そのモードとして保存する。`drop_reverb` は雑談で残響を切って保存する（Tauri 版と同じ確認のあと）。
    Save {
        mode: Mode,
        drop_reverb: bool,
    },
    Recover,
}

impl Control {
    /// 読むだけなら状態を送る。変える操作なら結果（`ModesDone`）を送ってから状態を送る。
    /// 切り替えると音づくりが変わるので、読み直して保存もする。
    pub(super) fn live_modes(&mut self, action: ModeAction) {
        let switched = matches!(action, ModeAction::Select(_) | ModeAction::Recover);
        let result = match action {
            ModeAction::Read => {
                let result = self.host.live_modes(ModesRequest::Snapshot);
                return self.send_modes(result);
            }
            ModeAction::Select(mode) => self.modes_intent(|intent| match mode {
                Mode::Singing => ModesRequest::SingingOn { intent },
                Mode::Talk => ModesRequest::TalkOn { intent },
            }),
            ModeAction::Protect(armed) => self.modes_intent(|intent| {
                if armed {
                    ModesRequest::Arm { intent }
                } else {
                    ModesRequest::Disarm { intent }
                }
            }),
            ModeAction::Save { mode, drop_reverb } => self.save_mode(mode, drop_reverb),
            ModeAction::Recover => self.modes_last().and_then(|last| {
                self.host.live_modes(ModesRequest::Recover {
                    expected_epoch: last.epoch,
                })
            }),
        };
        let notice = match &result {
            Err(e) if e.is::<KeepsReverb>() => Notice::ModesKeepsReverb,
            _ => Notice::ModesDone(result.as_ref().map(|_| ()).map_err(|e| e.to_string())),
        };
        let _ = self.notices.send(notice);
        let result = result.or_else(|_| self.host.live_modes(ModesRequest::Snapshot));
        self.send_modes(result);
        if switched {
            self.reread_and_save_sound();
        }
    }

    fn send_modes(&mut self, result: anyhow::Result<ModesSnapshot>) {
        let notice = result
            .map(|snapshot| view(&snapshot))
            .map_err(|e| e.to_string());
        let _ = self.notices.send(Notice::Modes(notice));
    }

    /// 今の状態（操作に付ける世代・保存の版を取るため、毎回読む）。
    fn modes_last(&mut self) -> anyhow::Result<ModesSnapshot> {
        self.host.live_modes(ModesRequest::Snapshot)
    }

    fn modes_intent(
        &mut self,
        request: impl FnOnce(Intent) -> ModesRequest,
    ) -> anyhow::Result<ModesSnapshot> {
        let last = self.modes_last()?;
        self.modes_sequence += 1;
        self.host.live_modes(request(Intent {
            client_id: format!("gpui-{}", std::process::id()),
            sequence: self.modes_sequence,
            expected_epoch: last.epoch,
        }))
    }

    /// 今の内蔵の処理を読んで、そのモードとして保存する（もう片方は保存してあるものを保つ）。
    fn save_mode(&mut self, mode: Mode, drop_reverb: bool) -> anyhow::Result<ModesSnapshot> {
        let last = self.modes_last()?;
        let applied = self.host.builtin_effects(BuiltinRequest::Snapshot)?;
        anyhow::ensure!(
            !applied.pending,
            "the sound settings are still being applied"
        );
        let mut config = applied.config;
        if mode == Mode::Talk {
            if let Some(reverb) = config.reverb.as_mut().filter(|r| r.enabled) {
                anyhow::ensure!(drop_reverb, KeepsReverb);
                reverb.enabled = false;
            }
        }
        let (singing, talk) = match mode {
            Mode::Singing => (Some(config), last.definitions.talk),
            Mode::Talk => (last.definitions.singing, Some(config)),
        };
        self.host.live_modes(ModesRequest::Save {
            expected_version: last.definitions.version,
            singing,
            talk,
        })
    }
}

/// 雑談として登録しようとした音づくりで、残響が ON だった。
#[derive(Debug)]
struct KeepsReverb;

impl std::fmt::Display for KeepsReverb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("talk mode would keep the reverb")
    }
}

impl std::error::Error for KeepsReverb {}

fn mode(mode: HostMode) -> Mode {
    match mode {
        HostMode::Singing => Mode::Singing,
        HostMode::Talk => Mode::Talk,
    }
}

fn view(snapshot: &ModesSnapshot) -> LiveModes {
    LiveModes {
        running: snapshot.running,
        applied: snapshot.applied.map(mode),
        target: snapshot.target.map(mode),
        phase: snapshot.phase.clone(),
        singing_saved: snapshot.definitions.singing.is_some(),
        talk_saved: snapshot.definitions.talk.is_some(),
        armed: snapshot.armed,
        transaction: snapshot.transaction.as_ref().map(|t| Transaction {
            phase: t.phase.clone(),
            recovery_available: t.recovery_available,
            error: t.error.clone(),
        }),
        error: snapshot.error.clone(),
    }
}
