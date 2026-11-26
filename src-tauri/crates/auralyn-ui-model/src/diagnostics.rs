//! 設定の画面の診断：音声処理の稼働統計（読み込み済みの VST の数・最大ジッター・グリッチ回数・直近の遅着と音切れの可能性）。

/// 直近の遅着がこの回数以上なら多いと知らせる（Tauri 版・`processing_watch.rs` と同じ境界）。
pub const RECENT_LATE_WARN: u64 = 10;
pub const RECENT_UNDERFLOW_WARN: u64 = 3;

/// 直近の遅着と、音切れの可能性（キューが空だった回数）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Health {
    pub recent_late: u64,
    pub recent_underflow: u64,
    pub window_secs: u32,
}

impl Health {
    pub fn warns(&self) -> bool {
        self.recent_late >= RECENT_LATE_WARN || self.recent_underflow >= RECENT_UNDERFLOW_WARN
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub loaded: u32,
    pub enabled: u32,
    pub pending_unload: u32,
    pub burned: u32,
    pub max_jitter_us: u64,
    pub glitches: u64,
    pub health: Option<Health>,
}

impl Stats {
    /// 最大ジッターの表示（Tauri 版と同じ「1.23 ms」）。
    pub fn jitter(&self) -> String {
        format!("{:.2} ms", self.max_jitter_us as f64 / 1000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_at_the_same_bounds_as_the_engine() {
        let health = |late, underflow| Health {
            recent_late: late,
            recent_underflow: underflow,
            window_secs: 60,
        };
        assert!(!health(9, 2).warns());
        assert!(health(10, 0).warns());
        assert!(health(0, 3).warns());
    }

    #[test]
    fn jitter_is_shown_in_milliseconds() {
        let stats = Stats {
            max_jitter_us: 1234,
            ..Stats::default()
        };
        assert_eq!(stats.jitter(), "1.23 ms");
    }
}
