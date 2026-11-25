//! 周囲の音の測定（ノイズ低減の「測定値で調整」の元になる）：状態の読み方と、押せるボタン。
//!
//! 測定は「3秒測る → 結果を確かめる → 話していないと確かめて採用する」の順。エンジンは測定ごとに
//! `epoch`・`generation` を付け、開始・中止・採用はその組で頼む（古い画面の操作で別の測定を変えない）。

/// 測定の状態。知らない状態は読めないものとして扱う（`parse` が `None`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// 今の条件ではまだ測っていない。
    Idle,
    Capturing,
    /// 測り終わり、採用するか確かめているところ。
    Review,
    Approved,
    /// 測れたが使えない（無音・短すぎるなど）。
    Invalid,
    /// 前の測定が、今の条件では確かめられていない。
    Stale,
}

impl State {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "idle" => Some(Self::Idle),
            "capturing" => Some(Self::Capturing),
            "review" => Some(Self::Review),
            "approved" => Some(Self::Approved),
            "invalid" => Some(Self::Invalid),
            "stale" => Some(Self::Stale),
            _ => None,
        }
    }
}

/// 測定の結果についての注意。知らない注意は `Uncertain`（判別できない）にまとめる。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    NonFinite,
    Silent,
    Clipped,
    Short,
    Variable,
    Uncertain,
}

impl Quality {
    pub fn parse(text: &str) -> Self {
        match text {
            "nonFinite" => Self::NonFinite,
            "silent" => Self::Silent,
            "clipped" => Self::Clipped,
            "short" => Self::Short,
            "variable" => Self::Variable,
            _ => Self::Uncertain,
        }
    }
}

/// 測定の組。開始・中止・採用はこれを添えて頼む。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Take {
    pub epoch: String,
    pub generation: String,
}

/// エンジンから読んだ測定。
#[derive(Clone, Debug, PartialEq)]
pub struct Measurement {
    pub take: Take,
    pub state: State,
    /// 測定中の進み（0〜1）。
    pub progress: f32,
    pub quality: Vec<Quality>,
    /// 以前に採用した値が残っている。
    pub previous: bool,
}

/// 画面から頼むこと。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Read,
    Start(Take),
    Cancel(Take),
    Approve(Take),
}

impl Measurement {
    pub fn can_start(&self) -> bool {
        self.state != State::Capturing
    }

    pub fn can_cancel(&self) -> bool {
        self.state == State::Capturing
    }

    /// 採用は、結果を確かめているときに、話していないと確かめた（`quiet`）ときだけ。
    pub fn can_approve(&self, quiet: bool) -> bool {
        self.state == State::Review && quiet
    }

    /// 以前の値が残っている旨は、今の測定を採用していないときだけ出す。
    pub fn shows_previous(&self) -> bool {
        self.previous && self.state != State::Approved
    }

    /// 進みの百分率（測定中だけ）。
    pub fn percent(&self) -> Option<u32> {
        (self.state == State::Capturing)
            .then(|| (self.progress.clamp(0.0, 1.0) * 100.0).round() as u32)
    }
}

/// 「話していないと確かめた」の印は、別の測定に移ったら外す。
pub fn keeps_quiet(before: Option<&Take>, after: &Take) -> bool {
    before == Some(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn take(generation: &str) -> Take {
        Take {
            epoch: "e".into(),
            generation: generation.into(),
        }
    }

    fn measurement(state: State) -> Measurement {
        Measurement {
            take: take("1"),
            state,
            progress: 0.42,
            quality: Vec::new(),
            previous: true,
        }
    }

    #[test]
    fn unknown_states_are_unreadable_and_unknown_quality_is_uncertain() {
        assert_eq!(State::parse("review"), Some(State::Review));
        assert_eq!(State::parse("Review"), None);
        assert_eq!(Quality::parse("clipped"), Quality::Clipped);
        assert_eq!(Quality::parse("new"), Quality::Uncertain);
    }

    #[test]
    fn buttons_follow_the_state() {
        let capturing = measurement(State::Capturing);
        assert!(!capturing.can_start() && capturing.can_cancel());
        assert_eq!(capturing.percent(), Some(42));
        let review = measurement(State::Review);
        assert!(review.can_start() && !review.can_cancel());
        assert!(!review.can_approve(false) && review.can_approve(true));
        assert!(!measurement(State::Approved).can_approve(true));
        assert_eq!(review.percent(), None);
    }

    #[test]
    fn previous_value_note_hides_once_approved() {
        assert!(measurement(State::Stale).shows_previous());
        assert!(!measurement(State::Approved).shows_previous());
    }

    #[test]
    fn quiet_check_resets_on_a_new_take() {
        assert!(keeps_quiet(Some(&take("1")), &take("1")));
        assert!(!keeps_quiet(Some(&take("1")), &take("2")));
        assert!(!keeps_quiet(None, &take("1")));
    }
}
