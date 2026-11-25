//! 大きな音を抑える（ピーク保護）。エンジンの状態から、画面に出す注記を決める。
//!
//! 設定はアプリの中だけで持ち、再起動すると OFF と既定の値に戻る（Tauri 版と同じ）。

/// エンジンが返したピーク保護の状態。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Peak {
    pub enabled: bool,
    /// 天井（dBFS）。
    pub ceiling_db: f32,
    /// 復帰時間（ms）。
    pub release_ms: f32,
    /// 音声処理が動いている。
    pub running: bool,
    /// 設定の反映を待っている。
    pub pending: bool,
}

/// スイッチの下に出す注記。ON/OFF はスイッチだけが示すので、読めない・反映待ち・停止のときだけ出す。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    Unknown,
    Pending,
    Stopped,
}

/// 天井の範囲と刻み（エンジンの `peak_protection::Config::validate` と同じ範囲）。
pub const CEILING_DB: (f32, f32, f32) = (-12.0, -0.1, 0.1);
/// 復帰時間の範囲と刻み。
pub const RELEASE_MS: (f32, f32, f32) = (20.0, 1000.0, 10.0);

/// スライダーの値を、刻みにそろえて範囲に収める（浮動小数の誤差でエンジンに断られないように）。
pub fn snap((min, max, step): (f32, f32, f32), value: f32) -> f32 {
    ((value / step).round() * step).clamp(min, max)
}

/// `None` は状態を読めていない（音声が止まっているときも読めない）。
pub fn notes(peak: Option<Peak>) -> Vec<Note> {
    match peak {
        None => vec![Note::Unknown],
        Some(peak) => [
            (peak.pending, Note::Pending),
            (!peak.running, Note::Stopped),
        ]
        .into_iter()
        .filter_map(|(show, note)| show.then_some(note))
        .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peak(running: bool, pending: bool) -> Option<Peak> {
        Some(Peak {
            enabled: true,
            ceiling_db: -1.0,
            release_ms: 100.0,
            running,
            pending,
        })
    }

    #[test]
    fn notes_only_for_unknown_pending_or_stopped() {
        assert_eq!(notes(None), [Note::Unknown]);
        assert_eq!(notes(peak(true, false)), []);
        assert_eq!(notes(peak(true, true)), [Note::Pending]);
        assert_eq!(notes(peak(false, true)), [Note::Pending, Note::Stopped]);
    }

    #[test]
    fn snap_keeps_values_on_the_step_and_inside_the_range() {
        assert_eq!(snap(CEILING_DB, -1.04), -1.0);
        assert_eq!(snap(CEILING_DB, -0.02), -0.1);
        assert_eq!(snap(CEILING_DB, -20.0), -12.0);
        assert_eq!(snap(RELEASE_MS, 104.0), 100.0);
        assert_eq!(snap(RELEASE_MS, 5.0), 20.0);
        assert_eq!(snap(RELEASE_MS, 2000.0), 1000.0);
    }
}
