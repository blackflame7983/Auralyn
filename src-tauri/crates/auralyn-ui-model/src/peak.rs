//! 大きな音を抑える（ピーク保護）。エンジンの状態から、画面に出す注記を決める。
//!
//! 設定はアプリの中だけで持ち、再起動すると OFF に戻る（Tauri 版と同じ）。天井と復帰時間は、まだ GPUI 版で変えない。

/// エンジンが返したピーク保護の状態。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Peak {
    pub enabled: bool,
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
}
