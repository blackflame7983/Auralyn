//! ASIO の入力チャンネルの信号：どの入力に音が来ているかと、音が来ている入力への切り替えの勧め。
//!
//! エンジンはチャンネルごとのピーク（最大 32）を音があるあいだ送る。曲や話の切れ目で表示がちらつかないよう、
//! 最後に音が来てから `HOLD` のあいだは「来ている」とみなす。

use std::time::{Duration, Instant};

/// 音が来ているとみなすピーク（Tauri 版の信号表示と同じ）。
pub const THRESHOLD: f32 = 0.05;
/// 最後に音が来てから、来ているとみなし続ける時間。
pub const HOLD: Duration = Duration::from_secs(2);

/// チャンネルごとに、最後に音が来た時刻。
#[derive(Clone, Debug, Default)]
pub struct Signal {
    last: Vec<Option<Instant>>,
}

impl Signal {
    /// エンジンから届いたピークを記録する。
    pub fn record(&mut self, levels: &[f32], now: Instant) {
        if self.last.len() < levels.len() {
            self.last.resize(levels.len(), None);
        }
        for (last, level) in self.last.iter_mut().zip(levels) {
            if level.is_finite() && *level > THRESHOLD {
                *last = Some(now);
            }
        }
    }

    /// 監視をやめた・機器が替わった。前の機器の信号を残さない。
    pub fn clear(&mut self) {
        self.last.clear();
    }

    /// まだ一度も届いていない（監視を始めたばかり）。
    pub fn is_empty(&self) -> bool {
        self.last.is_empty()
    }

    /// いま音が来ているチャンネル（0 から数える）。
    pub fn heard(&self, now: Instant) -> Vec<usize> {
        self.last
            .iter()
            .enumerate()
            .filter(|(_, last)| last.is_some_and(|at| now.saturating_duration_since(at) < HOLD))
            .map(|(channel, _)| channel)
            .collect()
    }
}

/// 組のどちらかに音が来ているか。
pub fn pair_heard(heard: &[usize], pair: [usize; 2]) -> bool {
    pair.iter().any(|channel| heard.contains(channel))
}

/// 音が来ている組（1-2・3-4… の並び）。エンジンが知らせるのは先頭の 32 チャンネルまで。
pub fn heard_pairs(heard: &[usize]) -> Vec<[usize; 2]> {
    let count = heard
        .iter()
        .max()
        .map_or(0, |&last| u16::try_from(last + 2).unwrap_or(u16::MAX));
    crate::mix::pairs(count)
        .into_iter()
        .filter(|&pair| pair_heard(heard, pair))
        .collect()
}

/// 選んでいる組が無音で、ほかの組に音が来ていれば、その最初の組を勧める。
/// 選んでいる組に音が来ているなら勧めない（話の切れ目にほかの音へ替えさせない）。
pub fn suggestion(heard: &[usize], current: [usize; 2]) -> Option<[usize; 2]> {
    if pair_heard(heard, current) {
        return None;
    }
    heard_pairs(heard).into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_channel_counts_as_heard_until_the_hold_passes() {
        let start = Instant::now();
        let mut signal = Signal::default();
        assert!(signal.is_empty());
        signal.record(&[0.0, 0.01, 0.0, 0.0, 0.0, 0.0, 0.3, 0.2], start);
        assert_eq!(signal.heard(start), [6, 7]);
        signal.record(&[0.0; 8], start + HOLD / 2);
        assert_eq!(signal.heard(start + HOLD / 2), [6, 7]);
        assert!(signal.heard(start + HOLD).is_empty());
        signal.clear();
        assert!(signal.is_empty());
    }

    #[test]
    fn broken_levels_do_not_count_as_sound() {
        let now = Instant::now();
        let mut signal = Signal::default();
        signal.record(&[f32::NAN, f32::INFINITY, THRESHOLD], now);
        assert!(signal.heard(now).is_empty());
    }

    #[test]
    fn suggests_the_pair_with_sound_when_the_chosen_one_is_silent() {
        // Voicemeeter Insert：曲は 7-8 に来て、選んでいるのは 1-2。
        assert_eq!(suggestion(&[6, 7], [0, 1]), Some([6, 7]));
        // 選んでいる組に音が来ていれば、ほかに音があっても勧めない。
        assert_eq!(suggestion(&[0, 6], [0, 1]), None);
        assert_eq!(suggestion(&[], [0, 1]), None);
    }

    #[test]
    fn heard_channels_become_stereo_pairs() {
        assert_eq!(heard_pairs(&[6, 7]), [[6, 7]]);
        assert_eq!(heard_pairs(&[6]), [[6, 7]]);
        assert_eq!(heard_pairs(&[1, 4]), [[0, 1], [4, 5]]);
        assert!(heard_pairs(&[]).is_empty());
    }
}
