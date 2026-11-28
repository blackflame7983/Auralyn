//! ホームの「接続の確認」：音づくり・ボイスチェック・送り先を利用者が確かめた記録と、設定が変わったときの失効。
//! 確かめた時点の音声の条件を「鍵」の文字列で持ち、読み直した鍵と違えば失効にする。鍵の中身はエンジンを読む側が作る。

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Location {
    #[default]
    Home,
    Venue,
}

impl Location {
    pub const ALL: [Location; 2] = [Location::Home, Location::Venue];

    /// 保存に使う名前。
    pub fn key(self) -> &'static str {
        match self {
            Location::Home => "home",
            Location::Venue => "venue",
        }
    }
}

/// ゲーム音とマイクの入力。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Signal {
    #[default]
    Unknown,
    Separate,
    Mixed,
}

impl Signal {
    pub const ALL: [Signal; 3] = [Signal::Unknown, Signal::Separate, Signal::Mixed];

    pub fn key(self) -> &'static str {
        match self {
            Signal::Unknown => "unknown",
            Signal::Separate => "separate",
            Signal::Mixed => "mixed",
        }
    }
}

/// 声の送り先。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Usage {
    Obs,
    Discord,
    Other,
    Listening,
}

impl Usage {
    pub const ALL: [Usage; 4] = [Usage::Obs, Usage::Discord, Usage::Other, Usage::Listening];

    pub fn key(self) -> &'static str {
        match self {
            Usage::Obs => "obs",
            Usage::Discord => "discord",
            Usage::Other => "other",
            Usage::Listening => "listening",
        }
    }
}

/// 保存した名前から選ぶ。知らない名前は `None`。
pub fn from_key<T: Copy>(all: &[T], key: impl Fn(T) -> &'static str, text: &str) -> Option<T> {
    all.iter().copied().find(|value| key(*value) == text)
}

/// はじめての設定で選んだ使い道を、送り先にする。
impl From<crate::setup::Goal> for Usage {
    fn from(goal: crate::setup::Goal) -> Self {
        match goal {
            crate::setup::Goal::Obs => Usage::Obs,
            crate::setup::Goal::Chat => Usage::Discord,
            crate::setup::Goal::Listen => Usage::Listening,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Context {
    pub location: Location,
    pub signal: Signal,
    pub usage: Option<Usage>,
    /// 送り先の入力名・ソース名（200 文字まで、前後の空白なし）。
    pub receiver: String,
}

pub const MAX_RECEIVER_CHARS: usize = 200;

pub fn normalize_receiver(text: &str) -> String {
    text.chars()
        .take(MAX_RECEIVER_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

impl Context {
    /// 送り先の種類を替える。名前は前の送り先のものなので消す。
    pub fn with_usage(&self, usage: Usage) -> Context {
        Context {
            usage: Some(usage),
            receiver: if self.usage == Some(usage) {
                self.receiver.clone()
            } else {
                String::new()
            },
            ..self.clone()
        }
    }

    /// 変えると、どの確認が失効するか。場所と入力の種類は音づくりから、送り先は送り先の確認だけ。
    pub fn expires(&self, next: &Context) -> &'static [Stage] {
        if self.location != next.location || self.signal != next.signal {
            &Stage::ALL
        } else if self.usage != next.usage || self.receiver != next.receiver {
            &[Stage::Receiver]
        } else {
            &[]
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Stage {
    Sound,
    Listen,
    Receiver,
}

impl Stage {
    pub const ALL: [Stage; 3] = [Stage::Sound, Stage::Listen, Stage::Receiver];

    fn index(self) -> usize {
        self as usize
    }
}

/// 音声が使えるか。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Availability {
    Unknown,
    Unconfigured,
    Stopped,
    Failed,
    /// 設定の反映を待っている。
    Pending,
    /// 出力のミュートか、出力音量ゼロ。
    Muted,
    Ready,
}

impl Availability {
    /// 音は流れている（ミュート・反映待ちでも、設定の問題ではない）。
    pub fn usable(self) -> bool {
        matches!(
            self,
            Availability::Ready | Availability::Muted | Availability::Pending
        )
    }
}

/// エンジンから読んだ事実。読めなかったものは `false`/`None`。
#[derive(Clone, Copy, Debug, Default)]
pub struct Facts {
    pub configured: bool,
    pub running: bool,
    /// 配信用の出力・アプリの音声・音声の受け渡しのどこかが失敗している。
    pub failed: bool,
    /// 状態の読み取りがそろっている（壊れた値がない）。
    pub readable: bool,
    /// 配信用の出力の行き先が無い・動いていない（読み取りがそろったときだけ失敗とみなす）。
    pub output_missing: bool,
    pub controls_pending: bool,
    pub muted: bool,
    pub output_gain_zero: bool,
}

pub fn availability(facts: Facts) -> Availability {
    if !facts.configured {
        Availability::Unconfigured
    } else if !facts.running {
        Availability::Stopped
    } else if facts.failed {
        Availability::Failed
    } else if !facts.readable {
        Availability::Unknown
    } else if facts.output_missing {
        Availability::Failed
    } else if facts.controls_pending {
        Availability::Pending
    } else if facts.muted || facts.output_gain_zero {
        Availability::Muted
    } else {
        Availability::Ready
    }
}

/// 確かめた記録。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmation {
    pub key: String,
    /// 確かめた相手（入力名・送り先の名前）。
    pub target: String,
    pub expired: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Unconfirmed,
    Confirmed,
    /// 確かめたあと設定が変わった。
    Stale,
}

/// 3つの確認の記録（このセッションだけ持つ）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Records([Option<Confirmation>; 3]);

impl Records {
    pub fn get(&self, stage: Stage) -> Option<&Confirmation> {
        self.0[stage.index()].as_ref()
    }

    pub fn state(&self, stage: Stage) -> State {
        match self.get(stage) {
            None => State::Unconfirmed,
            Some(c) if c.expired => State::Stale,
            Some(_) => State::Confirmed,
        }
    }

    /// 確かめたことを記録する。頼んだときの鍵 `expected` と読み直した鍵が同じで、
    /// 音声が使えて送り先を選んでいるときだけ。記録したら `true`。
    pub fn confirm(
        &mut self,
        stage: Stage,
        expected: &str,
        keys: Option<&Keys>,
        availability: Availability,
        context: &Context,
        target: String,
    ) -> bool {
        let ready = availability == Availability::Ready && context.usage.is_some();
        let Some(key) = keys
            .map(|keys| keys.get(stage))
            .filter(|key| ready && *key == expected)
        else {
            return false;
        };
        self.0[stage.index()] = Some(Confirmation {
            key: key.to_string(),
            target,
            expired: false,
        });
        true
    }

    pub fn expire(&mut self, stage: Stage) {
        if let Some(c) = self.0[stage.index()].as_mut() {
            c.expired = true;
        }
    }

    pub fn expire_all(&mut self) {
        Stage::ALL.into_iter().for_each(|stage| self.expire(stage));
    }

    /// 読み直した鍵と違う記録を失効にする。鍵が読めなければすべて失効。
    /// 一度失効した記録は、設定を元に戻しても確認済みに戻さない。
    pub fn expire_changed(&mut self, keys: Option<&Keys>) {
        for stage in Stage::ALL {
            let changed =
                keys.is_none_or(|keys| self.get(stage).is_some_and(|c| c.key != keys.get(stage)));
            if changed {
                self.expire(stage);
            }
        }
    }
}

/// 確かめた時点の条件。音づくりの鍵は声の流れ、ボイスチェックは出力、送り先は送り先の名前を足していく。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keys([String; 3]);

impl Keys {
    /// `sound` は入力と処理、`output` は出力と配信用の出力の条件（どちらもエンジンを読む側が作る文字列）。
    pub fn new(sound: &str, output: &str, context: &Context) -> Self {
        let sound = format!("{sound}|{:?}|{:?}", context.location, context.signal);
        let listen = format!("{sound}|{output}");
        let receiver = format!("{listen}|{:?}|{}", context.usage, context.receiver);
        Keys([sound, listen, receiver])
    }

    pub fn get(&self, stage: Stage) -> &str {
        &self.0[stage.index()]
    }
}

/// 次に確かめること。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    /// 音声が使えるようにする。
    Connect,
    /// 送り先を選ぶ。
    Purpose,
    Stage(Stage),
    Done,
}

pub fn next(availability: Availability, records: &Records, context: &Context) -> Next {
    if availability != Availability::Ready {
        return Next::Connect;
    }
    if context.usage.is_none() {
        return Next::Purpose;
    }
    Stage::ALL
        .into_iter()
        .find(|stage| records.state(*stage) != State::Confirmed)
        .map_or(Next::Done, Next::Stage)
}

/// 確かめた記録に残す相手。音づくりとボイスチェックは入力、送り先は名前か送り先の種類（その他のアプリは出力先）。
pub fn target(stage: Stage, context: &Context, input: &str, output: &str) -> String {
    if stage != Stage::Receiver {
        return input.into();
    }
    if !context.receiver.is_empty() {
        return context.receiver.clone();
    }
    match context.usage {
        Some(Usage::Obs) => "OBS".into(),
        Some(Usage::Discord) => "Discord".into(),
        Some(Usage::Other) => output.into(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Facts {
        Facts {
            configured: true,
            running: true,
            readable: true,
            ..Facts::default()
        }
    }

    #[test]
    fn availability_checks_in_order() {
        assert_eq!(availability(Facts::default()), Availability::Unconfigured);
        assert_eq!(
            availability(Facts {
                running: false,
                ..ready()
            }),
            Availability::Stopped
        );
        assert_eq!(
            availability(Facts {
                failed: true,
                readable: false,
                ..ready()
            }),
            Availability::Failed
        );
        assert_eq!(
            availability(Facts {
                readable: false,
                ..ready()
            }),
            Availability::Unknown
        );
        assert_eq!(
            availability(Facts {
                controls_pending: true,
                muted: true,
                ..ready()
            }),
            Availability::Pending
        );
        assert_eq!(
            availability(Facts {
                output_gain_zero: true,
                ..ready()
            }),
            Availability::Muted
        );
        assert_eq!(availability(ready()), Availability::Ready);
    }

    fn confirm(records: &mut Records, keys: &Keys, stage: Stage) {
        let context = Context {
            usage: Some(Usage::Obs),
            ..Context::default()
        };
        let expected = keys.get(stage).to_string();
        assert!(records.confirm(
            stage,
            &expected,
            Some(keys),
            Availability::Ready,
            &context,
            String::new()
        ));
    }

    #[test]
    fn confirm_needs_the_same_key_ready_audio_and_a_purpose() {
        let mut context = Context::default();
        let keys = Keys::new("in", "out", &context);
        let expected = keys.get(Stage::Sound).to_string();
        let mut records = Records::default();
        let mut try_confirm = |keys: Option<&Keys>, availability, context: &Context| {
            records.confirm(
                Stage::Sound,
                &expected,
                keys,
                availability,
                context,
                "マイク".into(),
            )
        };
        assert!(!try_confirm(Some(&keys), Availability::Ready, &context));
        context.usage = Some(Usage::Obs);
        let changed = Keys::new("in2", "out", &context);
        assert!(!try_confirm(Some(&changed), Availability::Ready, &context));
        assert!(!try_confirm(None, Availability::Ready, &context));
        assert!(!try_confirm(Some(&keys), Availability::Muted, &context));
        assert!(try_confirm(Some(&keys), Availability::Ready, &context));
        assert_eq!(records.state(Stage::Sound), State::Confirmed);
        assert_eq!(records.get(Stage::Sound).unwrap().target, "マイク");
    }

    #[test]
    fn saved_names_read_back() {
        for usage in Usage::ALL {
            assert_eq!(from_key(&Usage::ALL, Usage::key, usage.key()), Some(usage));
        }
        for location in Location::ALL {
            assert_eq!(
                from_key(&Location::ALL, Location::key, location.key()),
                Some(location)
            );
        }
        for signal in Signal::ALL {
            assert_eq!(
                from_key(&Signal::ALL, Signal::key, signal.key()),
                Some(signal)
            );
        }
        assert_eq!(from_key(&Usage::ALL, Usage::key, "tv"), None);
        assert!(Availability::Pending.usable() && !Availability::Unknown.usable());
    }

    #[test]
    fn changed_keys_expire_only_the_later_stages_and_never_come_back() {
        let context = Context {
            usage: Some(Usage::Obs),
            ..Context::default()
        };
        let before = Keys::new("in", "out", &context);
        let mut records = Records::default();
        Stage::ALL
            .into_iter()
            .for_each(|stage| confirm(&mut records, &before, stage));
        assert_eq!(next(Availability::Ready, &records, &context), Next::Done);

        let output_changed = Keys::new("in", "out2", &context);
        records.expire_changed(Some(&output_changed));
        assert_eq!(records.state(Stage::Sound), State::Confirmed);
        assert_eq!(records.state(Stage::Listen), State::Stale);
        assert_eq!(records.state(Stage::Receiver), State::Stale);
        assert_eq!(
            next(Availability::Ready, &records, &context),
            Next::Stage(Stage::Listen)
        );

        records.expire_changed(Some(&before));
        assert_eq!(records.state(Stage::Listen), State::Stale);
        records.expire_changed(None);
        assert_eq!(records.state(Stage::Sound), State::Stale);
    }

    #[test]
    fn receiver_and_reach_change_only_the_receiver_key() {
        let mut context = Context {
            usage: Some(Usage::Obs),
            ..Context::default()
        };
        let a = Keys::new("in", "out", &context);
        context.receiver = "マイク".into();
        let b = Keys::new("in", "out", &context);
        assert_eq!(a.get(Stage::Listen), b.get(Stage::Listen));
        assert_ne!(a.get(Stage::Receiver), b.get(Stage::Receiver));
        let venue = Context {
            location: Location::Venue,
            ..context.clone()
        };
        assert_eq!(context.expires(&venue), &Stage::ALL);
        let renamed = Context {
            receiver: "別".into(),
            ..context.clone()
        };
        assert_eq!(context.expires(&renamed), &[Stage::Receiver]);
        assert_eq!(context.with_usage(Usage::Obs).receiver, "マイク");
        assert_eq!(context.with_usage(Usage::Discord).receiver, "");
    }

    #[test]
    fn next_waits_for_audio_and_purpose() {
        let records = Records::default();
        let mut context = Context::default();
        assert_eq!(next(Availability::Muted, &records, &context), Next::Connect);
        assert_eq!(next(Availability::Ready, &records, &context), Next::Purpose);
        context.usage = Some(Usage::Listening);
        assert_eq!(
            next(Availability::Ready, &records, &context),
            Next::Stage(Stage::Sound)
        );
    }

    #[test]
    fn target_falls_back_to_the_usage() {
        let mut context = Context {
            usage: Some(Usage::Other),
            ..Context::default()
        };
        assert_eq!(
            target(Stage::Receiver, &context, "Mic", "Speakers"),
            "Speakers"
        );
        assert_eq!(target(Stage::Listen, &context, "Mic", "Speakers"), "Mic");
        context.usage = Some(Usage::Discord);
        assert_eq!(
            target(Stage::Receiver, &context, "Mic", "Speakers"),
            "Discord"
        );
        assert_eq!(normalize_receiver("  名前  "), "名前");
        assert_eq!(normalize_receiver(&"あ".repeat(300)).chars().count(), 200);
    }
}
