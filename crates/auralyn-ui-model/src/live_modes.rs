//! 歌・雑談モード。
//! モードは「今の音づくり（内蔵の処理）」を歌・雑談として保存しておき、本番中に切り替えるもの。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Singing,
    Talk,
}

impl Mode {
    pub const ALL: [Mode; 2] = [Mode::Singing, Mode::Talk];
}

/// 切り替えの途中経過（ホストの `transaction`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transaction {
    /// `failed`・`recovery_required` なら止まっている。それ以外は進行中。
    pub phase: String,
    pub recovery_available: bool,
    pub error: Option<String>,
}

impl Transaction {
    /// 進行中で、待つしかない。
    pub fn busy(&self) -> bool {
        !matches!(self.phase.as_str(), "failed" | "recovery_required")
    }

    /// 新しい切り替え・保存を断る。
    pub fn blocks_changes(&self) -> bool {
        self.phase != "failed" || self.recovery_available
    }
}

/// 画面に出す状態。
#[derive(Debug, Clone, PartialEq)]
pub struct LiveModes {
    pub running: bool,
    /// 最後にかけたモード。
    pub applied: Option<Mode>,
    /// 切り替え先（切り替え中の表示に使う）。
    pub target: Option<Mode>,
    /// ホストの `phase`：`custom`（手で変えた）・`stopped`・`queued`・`transitioning`・`settled`・`partial`。
    pub phase: String,
    /// 歌・雑談として保存してあるか。
    pub singing_saved: bool,
    pub talk_saved: bool,
    /// 以前の版で VST の構成を結び付けたモード。切り替えると VST も入れ替わるので、選ばせない。
    pub singing_linked: bool,
    pub talk_linked: bool,
    /// 本番保護（ON の間は VST の変更などをホストが断る）。
    pub armed: bool,
    pub transaction: Option<Transaction>,
    pub error: Option<String>,
}

impl LiveModes {
    pub fn saved(&self, mode: Mode) -> bool {
        match mode {
            Mode::Singing => self.singing_saved,
            Mode::Talk => self.talk_saved,
        }
    }

    pub fn linked(&self, mode: Mode) -> bool {
        match mode {
            Mode::Singing => self.singing_linked,
            Mode::Talk => self.talk_linked,
        }
    }

    fn blocked(&self) -> bool {
        self.transaction
            .as_ref()
            .is_some_and(Transaction::blocks_changes)
    }

    /// 切り替えられる。そのモードを保存してあり、途中の切り替えが無いとき。
    /// 止まっていても選べる（ホストが目標として持ち、開始したらかける）。
    pub fn can_select(&self, mode: Mode) -> bool {
        self.saved(mode) && !self.linked(mode) && !self.blocked()
    }

    /// 今の音づくりを登録できる。かかっている内蔵の処理を読むので、音声が動いているときだけ。
    pub fn can_save(&self) -> bool {
        self.running && !self.blocked()
    }

    /// 本番保護を切り替えられる。外すのはいつでもできる（ホストも外すことだけは断らない）。
    pub fn can_protect(&self) -> bool {
        self.armed || (self.running && !self.blocked())
    }

    /// 復旧のボタンを出す。
    pub fn recoverable(&self) -> bool {
        self.transaction
            .as_ref()
            .is_some_and(|t| t.recovery_available && !t.busy())
    }

    /// 選ばれて見えるモード。かけ終わったときだけで、手で変えた後や途中はどちらも選ばない。
    pub fn selected(&self) -> Option<Mode> {
        self.applied.filter(|_| self.phase == "settled")
    }

    /// 切り替え中。
    pub fn switching(&self) -> bool {
        matches!(self.phase.as_str(), "queued" | "transitioning")
            || self.transaction.as_ref().is_some_and(Transaction::busy)
    }

    /// 定期的に読み直すか（登録があるか、切り替えの途中）。
    pub fn polls(&self) -> bool {
        self.singing_saved || self.talk_saved || self.switching() || self.transaction.is_some()
    }

    /// 上の帯に出すモード。切り替え中なら切り替え先（`true`）、終わっていればかかっているモード。
    pub fn shown_mode(&self) -> Option<(Mode, bool)> {
        if self.switching() {
            self.target.map(|mode| (mode, true))
        } else {
            self.selected().map(|mode| (mode, false))
        }
    }
}

/// 読み直したら音づくりも読み直すか：切り替えが終わって別のモードがかかったとき。
/// 手で変えて「いまの調整」になったとき（かかったモードが無い）は、画面の値がもう新しいので読み直さない。
pub fn reload_after(before: Option<&LiveModes>, after: &LiveModes) -> bool {
    let seen = |m: &LiveModes| (m.switching(), m.selected());
    let now = seen(after);
    before.is_some_and(|b| seen(b) != now) && !now.0 && now.1.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modes() -> LiveModes {
        LiveModes {
            running: true,
            applied: Some(Mode::Singing),
            target: Some(Mode::Singing),
            phase: "custom".to_owned(),
            singing_saved: true,
            talk_saved: false,
            singing_linked: false,
            talk_linked: false,
            armed: false,
            transaction: None,
            error: None,
        }
    }

    #[test]
    fn sound_is_reread_only_when_a_switch_lands_on_a_mode() {
        let settled = |mode| LiveModes {
            phase: "settled".to_owned(),
            applied: Some(mode),
            ..modes()
        };
        let switching = LiveModes {
            phase: "transitioning".to_owned(),
            target: Some(Mode::Talk),
            ..modes()
        };
        assert!(reload_after(Some(&switching), &settled(Mode::Talk)));
        assert!(reload_after(
            Some(&settled(Mode::Singing)),
            &settled(Mode::Talk)
        ));
        assert!(!reload_after(Some(&settled(Mode::Talk)), &modes()));
        assert!(!reload_after(None, &settled(Mode::Talk)));
        assert!(!reload_after(Some(&settled(Mode::Talk)), &switching));
        assert_eq!(switching.shown_mode(), Some((Mode::Talk, true)));
        assert_eq!(
            settled(Mode::Singing).shown_mode(),
            Some((Mode::Singing, false))
        );
        assert_eq!(modes().shown_mode(), None);
        let unregistered = LiveModes {
            singing_saved: false,
            ..modes()
        };
        assert!(modes().polls() && !unregistered.polls() && LiveModes { ..switching }.polls());
    }

    fn transaction(phase: &str, recovery_available: bool) -> Option<Transaction> {
        Some(Transaction {
            phase: phase.to_owned(),
            recovery_available,
            error: None,
        })
    }

    #[test]
    fn only_saved_modes_can_be_selected_and_saving_needs_audio() {
        let live = modes();
        assert!(live.can_select(Mode::Singing));
        assert!(!live.can_select(Mode::Talk));
        let stopped = LiveModes {
            running: false,
            ..modes()
        };
        assert!(stopped.can_select(Mode::Singing));
        assert!(!stopped.can_save());
        let linked = LiveModes {
            singing_linked: true,
            ..modes()
        };
        assert!(!linked.can_select(Mode::Singing));
    }

    #[test]
    fn a_pending_or_recoverable_transaction_blocks_changes() {
        for (phase, recovery, blocked) in [
            ("applying", false, true),
            ("failed", false, false),
            ("failed", true, true),
            ("recovery_required", true, true),
        ] {
            let live = LiveModes {
                transaction: transaction(phase, recovery),
                ..modes()
            };
            assert_eq!(
                !live.can_select(Mode::Singing),
                blocked,
                "{phase} {recovery}"
            );
            assert_eq!(!live.can_save(), blocked, "{phase} {recovery}");
        }
    }

    #[test]
    fn recovery_shows_only_when_the_host_offers_it_and_nothing_is_running() {
        let failed = LiveModes {
            transaction: transaction("failed", true),
            ..modes()
        };
        assert!(failed.recoverable());
        let running = LiveModes {
            transaction: transaction("applying", true),
            ..modes()
        };
        assert!(!running.recoverable());
        assert!(running.switching());
    }

    #[test]
    fn a_mode_looks_selected_only_once_it_has_settled() {
        assert_eq!(modes().selected(), None);
        let settled = LiveModes {
            phase: "settled".to_owned(),
            ..modes()
        };
        assert_eq!(settled.selected(), Some(Mode::Singing));
        let queued = LiveModes {
            phase: "queued".to_owned(),
            ..modes()
        };
        assert!(queued.switching());
    }

    #[test]
    fn protection_can_always_be_turned_off() {
        let armed = LiveModes {
            armed: true,
            running: false,
            transaction: transaction("applying", false),
            ..modes()
        };
        assert!(armed.can_protect());
        let stopped = LiveModes {
            running: false,
            ..modes()
        };
        assert!(!stopped.can_protect());
    }
}
