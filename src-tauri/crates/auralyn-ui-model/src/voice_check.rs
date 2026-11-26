//! ボイスチェックの録音：録る・止める・加工前／加工後を WAV で保存する。
//!
//! 状態は音声エンジンの `voice-check-state`（Tauri 版と同じ通知）で受ける。録音は音声が流れているときだけできる。
//!
//! 試聴は、配信の送り先とは別の出力先（ヘッドホンなど）で鳴らす（Tauri 版の「加工前と加工後を聴く」と同じ）。
//! 出力先が配信・通話に取り込まれていないと利用者が確かめるまで、再生させない。

/// 1回に録る長さの上限（Tauri 版と同じ 10 秒）。
pub const MAX_MS: u32 = 10_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum State {
    #[default]
    Idle,
    Recording,
    /// 録り終えて、保存・試聴できる。
    Ready,
    Playing,
}

impl State {
    /// 通知の `state`。知らない値は `Idle`（録音が無いものとして扱う）。
    pub fn parse(label: &str) -> Self {
        match label {
            "recording" => Self::Recording,
            "ready" => Self::Ready,
            "playing" => Self::Playing,
            _ => Self::Idle,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Recording {
    pub state: State,
    pub position_ms: u32,
    pub duration_ms: u32,
}

impl Recording {
    pub fn can_record(&self, running: bool) -> bool {
        running && matches!(self.state, State::Idle | State::Ready)
    }

    pub fn can_stop(&self) -> bool {
        self.state == State::Recording
    }

    /// 音声が止まっている間は保存させない。止めたあとも録った音は残るが、子が落ちて作り直されたときは
    /// 新しい子が何も持たないまま通知を出さないので、止まっている間はどちらか分からない。
    pub fn can_save(&self, running: bool) -> bool {
        running && self.state == State::Ready && self.duration_ms > 0
    }

    pub fn remaining_ms(&self) -> u32 {
        MAX_MS.saturating_sub(self.position_ms)
    }
}

/// 保存する音。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// 加工前（マイク音量のあと、エフェクトの前）。
    Raw,
    Processed,
}

impl Source {
    /// エンジンへ渡す名前。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Processed => "processed",
        }
    }
}

/// 試聴の再生の状態（エンジンの答えの `state`）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Playback {
    #[default]
    Idle,
    Playing,
    Stopping,
    Stopped,
    Failed,
    Closed,
}

impl Playback {
    /// 知らない値は `Failed`（鳴っているか分からないものを、止まっているとは見せない）。
    pub fn parse(label: &str) -> Self {
        match label {
            "idle" => Self::Idle,
            "playing" => Self::Playing,
            "stopping" => Self::Stopping,
            "stopped" => Self::Stopped,
            "closed" => Self::Closed,
            _ => Self::Failed,
        }
    }
}

/// 試聴できる出力先。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub name: String,
}

/// 試聴のいまの様子（エンジンの答え）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listening {
    /// 試聴する録音。`None` は録音が無い。
    pub recording_id: Option<u64>,
    pub playback: Playback,
    pub position_ms: u32,
    pub duration_ms: u32,
    pub source: Source,
    pub looped: bool,
    pub devices: Vec<Device>,
    pub error: Option<String>,
    /// 録ったあとに条件が変わった（録り直しが要る）。
    pub stale: bool,
}

impl Listening {
    /// 出力先を選び、配信・通話に取り込まれていないと確かめたときだけ鳴らせる。
    pub fn can_play(&self, device_chosen: bool, checked_safe: bool) -> bool {
        device_chosen
            && checked_safe
            && self.recording_id.is_some()
            && !self.stale
            && matches!(
                self.playback,
                Playback::Idle | Playback::Stopped | Playback::Failed
            )
    }

    pub fn can_stop(&self) -> bool {
        self.playback == Playback::Playing
    }
}

/// 時間の表示（Tauri 版と同じ「3.4s」。0.1 秒未満は切り捨て）。
pub fn seconds(ms: u32) -> String {
    format!("{}.{}s", ms / 1000, ms % 1000 / 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(state: State, position_ms: u32, duration_ms: u32) -> Recording {
        Recording {
            state,
            position_ms,
            duration_ms,
        }
    }

    #[test]
    fn unknown_states_mean_nothing_recorded() {
        assert_eq!(State::parse("recording"), State::Recording);
        assert_eq!(State::parse("ready"), State::Ready);
        assert_eq!(State::parse("playing"), State::Playing);
        assert_eq!(State::parse("something"), State::Idle);
    }

    #[test]
    fn records_only_while_audio_runs_and_nothing_else_is_busy() {
        assert!(at(State::Idle, 0, 0).can_record(true));
        assert!(at(State::Ready, 0, 4000).can_record(true));
        assert!(!at(State::Idle, 0, 0).can_record(false));
        assert!(!at(State::Recording, 100, 100).can_record(true));
        assert!(!at(State::Playing, 100, 4000).can_record(true));
    }

    #[test]
    fn saves_only_a_finished_take() {
        assert!(at(State::Ready, 0, 4000).can_save(true));
        assert!(!at(State::Ready, 0, 4000).can_save(false));
        assert!(!at(State::Ready, 0, 0).can_save(true));
        assert!(!at(State::Recording, 4000, 4000).can_save(true));
        assert!(at(State::Recording, 4000, 4000).can_stop());
    }

    fn listening(playback: Playback) -> Listening {
        Listening {
            recording_id: Some(1),
            playback,
            position_ms: 0,
            duration_ms: 4000,
            source: Source::Processed,
            looped: true,
            devices: Vec::new(),
            error: None,
            stale: false,
        }
    }

    #[test]
    fn plays_only_on_a_checked_device() {
        let idle = listening(Playback::Idle);
        assert!(idle.can_play(true, true));
        assert!(!idle.can_play(false, true));
        assert!(!idle.can_play(true, false));
        assert!(!listening(Playback::Playing).can_play(true, true));
        assert!(!listening(Playback::Closed).can_play(true, true));
        assert!(listening(Playback::Playing).can_stop());
        let stale = Listening {
            stale: true,
            ..listening(Playback::Idle)
        };
        assert!(!stale.can_play(true, true));
        let empty = Listening {
            recording_id: None,
            ..listening(Playback::Idle)
        };
        assert!(!empty.can_play(true, true));
        assert_eq!(Playback::parse("odd"), Playback::Failed);
    }

    #[test]
    fn time_left_and_labels() {
        assert_eq!(at(State::Recording, 3_450, 3_450).remaining_ms(), 6_550);
        assert_eq!(at(State::Recording, 12_000, 12_000).remaining_ms(), 0);
        assert_eq!(seconds(3_450), "3.4s");
        assert_eq!(seconds(10_000), "10.0s");
        assert_eq!(Source::Raw.as_str(), "raw");
    }
}
