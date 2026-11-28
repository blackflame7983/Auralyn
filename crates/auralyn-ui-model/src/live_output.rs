//! 配信用の出力：加工後の声を、自分用（通常の出力）とは別の WASAPI 出力へも送る（OBS はその出力に対応する入力を取り込む）。
//! 選べる機器・値の範囲・確認の約束は Tauri 版（`LiveOutputPanel.tsx`・`audio_engine/live_output.rs`）に揃える。

use crate::connect::Device;

/// 配信用に選べる出力：WASAPI の出力で、ID があり、2チャンネルのもの。
pub fn outputs(devices: &[Device]) -> Vec<&Device> {
    devices
        .iter()
        .filter(|d| {
            !d.is_input
                && d.host.to_lowercase().contains("wasapi")
                && d.channels == 2
                && d.id.as_deref().is_some_and(|id| !id.is_empty())
        })
        .collect()
}

/// 画面で変えられる部分。音量は 0〜1。
#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    /// 配信用の出力。`None` は分けない。
    pub device_id: Option<String>,
    pub monitor_trim: f32,
    pub broadcast_trim: f32,
    /// 自分だけ聴かない（配信は続ける）。
    pub monitor_muted: bool,
    /// 自分用と配信用で処理を分ける（伴奏を混ぜるのに要る）。配信用の出力が無ければ分けない。
    pub split: bool,
}

/// 1つの変更。どれを変えても、保存の前の確認はやり直す（Tauri 版と同じ）。
#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Device(Option<String>),
    MonitorTrim(f32),
    BroadcastTrim(f32),
    MonitorMuted(bool),
    Split(bool),
}

impl Draft {
    pub fn with(self, change: Change) -> Self {
        let trim = |value: f32| {
            if value.is_finite() {
                value.clamp(0.0, 1.0)
            } else {
                1.0
            }
        };
        match change {
            // 出力を外したら、分けるのもやめる（Tauri 版と同じ）。
            Change::Device(device_id) => Self {
                split: self.split && device_id.is_some(),
                device_id,
                ..self
            },
            Change::MonitorTrim(value) => Self {
                monitor_trim: trim(value),
                ..self
            },
            Change::BroadcastTrim(value) => Self {
                broadcast_trim: trim(value),
                ..self
            },
            Change::MonitorMuted(monitor_muted) => Self {
                monitor_muted,
                ..self
            },
            Change::Split(split) => Self {
                split: split && self.device_id.is_some(),
                ..self
            },
        }
    }
}

/// エンジンから読んだ配信用の出力の状態。
#[derive(Clone, Debug, PartialEq)]
pub struct Live {
    /// 保存・反映されている構成。
    pub saved: Draft,
    /// 配信用の出力が音を受け取っている。
    pub active: bool,
    /// 配信用の出力が止まった。
    pub failed: bool,
    /// 配信用の出力を開けないなどの理由（Tauri 版と同じく、あれば止まったものとして扱う）。
    pub error: Option<String>,
}

/// 状態の一言。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// 分けていない。
    Off,
    Active,
    /// 選んであるが、音声が止まっているなどで送っていない。
    Inactive,
    Failed,
}

impl Live {
    pub fn verdict(&self) -> Verdict {
        if self.saved.device_id.is_none() {
            Verdict::Off
        } else if self.failed || self.error.is_some() {
            Verdict::Failed
        } else if self.active {
            Verdict::Active
        } else {
            Verdict::Inactive
        }
    }
}

/// 保存できるか：下書きが保存と違い、確認の印が付いていること。
pub fn can_save(draft: &Draft, saved: &Draft, confirmed: bool) -> bool {
    save_blocker(draft, saved, confirmed).is_none()
}

/// 保存できない理由。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveBlocker {
    Unchanged,
    Unconfirmed,
}

/// 保存できない最初の理由。変えていなければ、確認より先にそれを伝える。
pub fn save_blocker(draft: &Draft, saved: &Draft, confirmed: bool) -> Option<SaveBlocker> {
    if draft == saved {
        Some(SaveBlocker::Unchanged)
    } else if !confirmed {
        Some(SaveBlocker::Unconfirmed)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(host: &str, id: &str, is_input: bool, channels: u16) -> Device {
        Device {
            host: host.into(),
            name: id.into(),
            id: Some(id.into()),
            is_input,
            is_default: false,
            channels,
            rates: None,
            buffers: None,
        }
    }

    fn draft() -> Draft {
        Draft {
            device_id: None,
            monitor_trim: 1.0,
            broadcast_trim: 1.0,
            monitor_muted: false,
            split: false,
        }
    }

    #[test]
    fn only_stereo_wasapi_outputs_are_offered() {
        let devices = [
            device("WASAPI", "cable", false, 2),
            device("WASAPI", "surround", false, 8),
            device("ASIO", "asio", false, 2),
            device("WASAPI", "mic", true, 2),
        ];
        let names: Vec<_> = outputs(&devices).iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["cable"]);
    }

    #[test]
    fn trims_stay_in_range_and_saving_needs_a_change_and_the_mark() {
        let saved = draft();
        let changed = saved.clone().with(Change::BroadcastTrim(1.5));
        assert_eq!(changed.broadcast_trim, 1.0);
        let changed = saved.clone().with(Change::MonitorTrim(0.5));
        assert!(!can_save(&changed, &saved, false));
        assert!(can_save(&changed, &saved, true));
        assert!(!can_save(&saved, &saved, true));
        assert_eq!(
            save_blocker(&saved, &saved, false),
            Some(SaveBlocker::Unchanged)
        );
        assert_eq!(
            save_blocker(&changed, &saved, false),
            Some(SaveBlocker::Unconfirmed)
        );
        // 出力が無ければ分けられず、出力を外すと分けるのもやめる。
        assert!(!saved.clone().with(Change::Split(true)).split);
        let split = saved
            .with(Change::Device(Some("cable".into())))
            .with(Change::Split(true));
        assert!(split.split);
        assert!(!split.with(Change::Device(None)).split);
    }

    #[test]
    fn verdict_follows_the_sink() {
        let live = |device: Option<&str>, active, failed| Live {
            saved: Draft {
                device_id: device.map(str::to_owned),
                ..draft()
            },
            active,
            failed,
            error: None,
        };
        assert_eq!(live(None, true, false).verdict(), Verdict::Off);
        assert_eq!(live(Some("x"), true, false).verdict(), Verdict::Active);
        assert_eq!(live(Some("x"), false, false).verdict(), Verdict::Inactive);
        assert_eq!(live(Some("x"), true, true).verdict(), Verdict::Failed);
        let errored = Live {
            error: Some("open failed".into()),
            ..live(Some("x"), false, false)
        };
        assert_eq!(errored.verdict(), Verdict::Failed);
    }
}
