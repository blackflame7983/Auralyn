//! 音声の開始・停止の状態（先頭の帯の状態の札と、開始・停止のボタン）。
//!
//! 利用者の操作（開始・停止）と、エンジンからの結果（開始した・止まった・失敗した）だけで進む。
//! 操作の結果を待つあいだはボタンを押せなくし、同じ操作を重ねて送らない。

/// 音声の状態。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// 保存した入出力の設定がない。開始の代わりに接続の画面へ案内する。
    Unconfigured,
    Stopped,
    /// 開始を送り、結果を待っている。
    Starting,
    Running,
    /// 停止を送り、結果を待っている。
    Stopping,
}

/// 状態を進める出来事。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// 利用者が開始を押した。
    StartRequested,
    /// 利用者が停止を押した。
    StopRequested,
    Started,
    /// 止まった（利用者の停止、またはストリームの異常）。
    Stopped,
    StartFailed,
    StopFailed,
    /// 保存した設定がないと分かった。
    NoSavedConfig,
}

impl Phase {
    /// 起動の直後。エンジンは保存した設定で自動で開始を試みる。
    pub const LAUNCH: Phase = Phase::Starting;

    /// 出来事を受けた後の状態。今の状態で意味のない出来事では変わらない。
    #[must_use]
    pub fn next(self, event: Event) -> Phase {
        match (self, event) {
            (Phase::Stopped, Event::StartRequested) => Phase::Starting,
            (Phase::Running, Event::StopRequested) => Phase::Stopping,
            (_, Event::Started) => Phase::Running,
            (Phase::Unconfigured, Event::Stopped) => Phase::Unconfigured,
            (_, Event::Stopped) => Phase::Stopped,
            (Phase::Starting, Event::StartFailed) => Phase::Stopped,
            (Phase::Stopping, Event::StopFailed) => Phase::Running,
            (_, Event::NoSavedConfig) => Phase::Unconfigured,
            (phase, _) => phase,
        }
    }

    /// 結果を待っている。帯のボタンを押せなくする。
    pub fn busy(self) -> bool {
        matches!(self, Phase::Starting | Phase::Stopping)
    }

    /// 音が流れている（または止める途中で、まだ流れている）。
    pub fn running(self) -> bool {
        matches!(self, Phase::Running | Phase::Stopping)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_waits_for_the_engine_before_running() {
        let phase = Phase::Stopped.next(Event::StartRequested);
        assert_eq!(phase, Phase::Starting);
        assert!(phase.busy());
        assert_eq!(phase.next(Event::Started), Phase::Running);
    }

    #[test]
    fn failed_start_returns_to_stopped() {
        assert_eq!(Phase::Starting.next(Event::StartFailed), Phase::Stopped);
    }

    #[test]
    fn failed_stop_keeps_running() {
        let phase = Phase::Running.next(Event::StopRequested);
        assert!(phase.busy());
        assert_eq!(phase.next(Event::StopFailed), Phase::Running);
    }

    #[test]
    fn stream_error_while_running_stops() {
        assert_eq!(Phase::Running.next(Event::Stopped), Phase::Stopped);
    }

    #[test]
    fn repeated_presses_are_ignored_while_waiting() {
        assert_eq!(Phase::Starting.next(Event::StartRequested), Phase::Starting);
        assert_eq!(Phase::Stopping.next(Event::StopRequested), Phase::Stopping);
        assert_eq!(Phase::Stopped.next(Event::StopRequested), Phase::Stopped);
    }

    #[test]
    fn missing_config_leads_to_setup_until_started() {
        let phase = Phase::LAUNCH.next(Event::NoSavedConfig);
        assert_eq!(phase, Phase::Unconfigured);
        assert_eq!(phase.next(Event::Stopped), Phase::Unconfigured);
        assert_eq!(phase.next(Event::StartRequested), Phase::Unconfigured);
        assert_eq!(phase.next(Event::Started), Phase::Running);
    }

    #[test]
    fn running_covers_stopping() {
        assert!(Phase::Running.running());
        assert!(Phase::Stopping.running());
        assert!(!Phase::Starting.running());
    }
}
