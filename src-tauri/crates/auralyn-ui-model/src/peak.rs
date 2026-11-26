//! 大きな音を抑える（ピーク保護）と、配信用の true-peak 制限。エンジンの状態から、画面に出す注記を決める。
//!
//! 設定はアプリの中だけで持ち、再起動すると OFF と既定の値に戻る（Tauri 版と同じ）。

/// どちらの制限か。天井と復帰時間の範囲はどちらも同じ。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    /// 大きな音を抑える（出力音量の後、配信用と自分用のそれぞれ）。
    Sample,
    /// 配信用 true-peak 制限（分離した配信用出力の最終段だけ。先読みの遅れがある）。
    TruePeak,
}

impl Limit {
    pub const ALL: [Limit; 2] = [Limit::Sample, Limit::TruePeak];
}

/// true-peak 制限だけが返す、先読みの状態。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lookahead {
    /// 分離した配信用出力で、いま効いている。
    pub applied: bool,
    /// いま抑えた量（dB）。
    pub reduction_db: f32,
    /// 配信用に足した遅れ（サンプル）。
    pub samples: u32,
}

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
    /// true-peak 制限のときだけ。
    pub lookahead: Option<Lookahead>,
}

/// スイッチの下に出す注記。ON/OFF はスイッチだけが示すので、読めない・反映待ち・停止のときだけ出す。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    Unknown,
    Pending,
    Stopped,
    /// ON だが、配信用の出力を分けていないので効いていない（true-peak 制限だけ）。
    NotApplied,
}

/// 天井の範囲と刻み（エンジンの `peak_protection::Config::validate` と同じ範囲）。
pub const CEILING_DB: (f32, f32, f32) = (-12.0, -0.1, 0.1);
/// 復帰時間の範囲と刻み。
pub const RELEASE_MS: (f32, f32, f32) = (20.0, 1000.0, 10.0);

/// スライダーの値を、刻みにそろえて範囲に収める（浮動小数の誤差でエンジンに断られないように）。
pub fn snap((min, max, step): (f32, f32, f32), value: f32) -> f32 {
    ((value / step).round() * step).clamp(min, max)
}

/// 画面を見ている間、500ms ごとに読み直すか。反映待ちのあいだと、ON の true-peak 制限
/// （「いま抑えた量」はホストが読むたびに戻すので、Tauri 版と同じく読み続けないと古い値が残る）。
pub fn polls(peak: Option<Peak>) -> bool {
    peak.is_some_and(|peak| peak.pending || (peak.enabled && peak.lookahead.is_some()))
}

/// `None` は状態を読めていない（音声が止まっているときも読めない）。
pub fn notes(peak: Option<Peak>) -> Vec<Note> {
    match peak {
        None => vec![Note::Unknown],
        Some(peak) => [
            (peak.pending, Note::Pending),
            (!peak.running, Note::Stopped),
            (
                peak.enabled && peak.lookahead.is_some_and(|l| !l.applied),
                Note::NotApplied,
            ),
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
            lookahead: None,
        })
    }

    #[test]
    fn notes_only_for_unknown_pending_or_stopped() {
        assert_eq!(notes(None), [Note::Unknown]);
        assert_eq!(notes(peak(true, false)), []);
        assert_eq!(notes(peak(true, true)), [Note::Pending]);
        assert_eq!(notes(peak(false, true)), [Note::Pending, Note::Stopped]);
        let unsplit = |enabled| {
            Some(Peak {
                enabled,
                lookahead: Some(Lookahead {
                    applied: false,
                    reduction_db: 0.0,
                    samples: 0,
                }),
                ..peak(true, false).unwrap()
            })
        };
        assert_eq!(notes(unsplit(true)), [Note::NotApplied]);
        assert_eq!(notes(unsplit(false)), []);
        assert!(polls(unsplit(true)) && !polls(unsplit(false)));
        assert!(polls(peak(true, true)) && !polls(peak(true, false)) && !polls(None));
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
