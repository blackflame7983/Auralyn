/// 開始の試行の番号と、実際に動いている音声の番号。
///
/// 番号は開始の試行の入口で進め、失敗した試行も番号を使い切る。0 は未試行。
/// 停止の通知には、最後の試行の番号と、そのとき実際に終わった音声の番号を分けて載せる。
/// 動いている A を新しい試行 B が片付けてから B が失敗すると、終わったのは A だが、最後の試行は B になるため。
#[derive(Debug, Default)]
pub(super) struct StreamGenerations {
    attempt: u64,
    live: Option<u64>,
    ended_unreported: Option<u64>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Stopped {
    pub(super) attempt: Option<u64>,
    pub(super) ended: Option<u64>,
}

impl StreamGenerations {
    pub(super) fn begin_attempt(&mut self) {
        self.attempt = self.attempt.saturating_add(1);
    }

    pub(super) fn attempt(&self) -> Option<u64> {
        (self.attempt > 0).then_some(self.attempt)
    }

    /// 今の試行の音声が動き始めた。片付けた前の音声は、この開始で置き換わったので停止として報告しない。
    pub(super) fn started(&mut self) -> Option<u64> {
        self.live = self.attempt();
        self.ended_unreported = None;
        self.live
    }

    /// 音声の資源を片付けた。動いていた音声があれば、次の停止の通知で報告する。
    pub(super) fn cleared(&mut self) {
        if let Some(live) = self.live.take() {
            self.ended_unreported = Some(live);
        }
    }

    pub(super) fn stopped(&mut self) -> Stopped {
        Stopped {
            attempt: self.attempt(),
            ended: self.ended_unreported.take(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_without_any_attempt_has_no_numbers() {
        let mut streams = StreamGenerations::default();
        streams.cleared();
        assert_eq!(
            streams.stopped(),
            Stopped {
                attempt: None,
                ended: None
            }
        );
    }

    #[test]
    fn stopping_a_running_stream_reports_it_as_ended() {
        let mut streams = StreamGenerations::default();
        streams.begin_attempt();
        assert_eq!(streams.started(), Some(1));
        streams.cleared();
        assert_eq!(
            streams.stopped(),
            Stopped {
                attempt: Some(1),
                ended: Some(1)
            }
        );
        // 2回目の停止では、もう終わった音声を報告しない。
        streams.cleared();
        assert_eq!(
            streams.stopped(),
            Stopped {
                attempt: Some(1),
                ended: None
            }
        );
    }

    #[test]
    fn failed_replacement_reports_the_stream_it_ended() {
        let mut streams = StreamGenerations::default();
        streams.begin_attempt();
        streams.started();
        // A(1) が動いている間に B(2)、機器の切り替えで C(3) を試し、どちらも失敗する。
        for _ in 0..2 {
            streams.begin_attempt();
            streams.cleared();
        }
        assert_eq!(
            streams.stopped(),
            Stopped {
                attempt: Some(3),
                ended: Some(1)
            }
        );
    }

    #[test]
    fn successful_replacement_does_not_report_the_replaced_stream_later() {
        let mut streams = StreamGenerations::default();
        streams.begin_attempt();
        streams.started();
        streams.begin_attempt();
        streams.cleared();
        assert_eq!(streams.started(), Some(2));
        streams.cleared();
        assert_eq!(
            streams.stopped(),
            Stopped {
                attempt: Some(2),
                ended: Some(2)
            }
        );
    }
}
