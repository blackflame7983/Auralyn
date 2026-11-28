//! 操作を加えず、状態取得そのものと音声処理による状態変化を切り分ける。
use anyhow::{ensure, Result};
use serde::Serialize;
use std::time::Duration;

pub trait DriftTarget {
    fn process_block(&mut self) -> Result<()>;
    fn read_state(&mut self) -> Result<Vec<u8>>;
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct DriftConfig {
    pub seconds: u64,
    pub interval_seconds: u64,
    pub sample_rate: u32,
    pub block_size: u32,
    pub realtime: bool,
}

impl Default for DriftConfig {
    fn default() -> Self {
        Self {
            seconds: 60,
            interval_seconds: 5,
            sample_rate: 48_000,
            block_size: 512,
            realtime: true,
        }
    }
}

impl DriftConfig {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.seconds > 0, "計測の長さは正の秒数で指定してください");
        ensure!(
            self.interval_seconds > 0,
            "取得間隔は正の秒数で指定してください"
        );
        ensure!(self.sample_rate > 0, "rateは正の値で指定してください");
        ensure!(
            self.block_size > 0 && self.block_size <= i32::MAX as u32,
            "blockは1からi32::MAXまでで指定してください"
        );
        // 最後のblockへの切り上げと時刻計算にも余裕を残す。
        ensure!(
            self.seconds
                .checked_mul(u64::from(self.sample_rate))
                .and_then(|n| n.checked_add(u64::from(self.block_size)))
                .is_some(),
            "計測の長さが大きすぎます"
        );
        ensure!(
            self.interval_seconds
                .checked_mul(u64::from(self.sample_rate))
                .is_some(),
            "取得間隔が大きすぎます"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DriftVerdict {
    Stable,
    ChangesOnRead,
    DriftsWithAudio,
}

impl DriftVerdict {
    pub fn explanation(self) -> &'static str {
        match self {
            Self::Stable => "今回の条件では状態の変化はありません。エディターを閉じていれば定期取得はありません。表示中は10秒ごとに取得しますが、同じ内容は再書き込みされません。",
            Self::ChangesOnRead => "処理前の連続2回の取得で状態が変わりました。取得に伴う変化の候補です。エディターを閉じていれば定期取得がなく、書き込みは増えません。表示中も毎回状態が異なれば、10秒ごとの取得で毎回書き込みが起きます。",
            Self::DriftsWithAudio => "処理前の連続取得は一致し、音声処理後に状態が変わりました。エディターを閉じていれば定期取得がなく、書き込みは増えません。表示中は10秒ごとに取得し、前回保存した内容と異なる場合に書き込みます。",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct DriftSample {
    pub elapsed_ms: u64,
    pub size: Option<usize>,
    pub changed_from_previous: Option<bool>,
    pub different_bytes: Option<usize>,
    /// 0始まり。末尾の追加・削除だけの場合は共通部分の長さ。
    pub first_different_byte: Option<usize>,
    pub changed_from_initial: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DriftReport {
    pub config: DriftConfig,
    pub initial_size: Option<usize>,
    pub initial_reads_equal: Option<bool>,
    /// 処理前の2回目も経過0 msのsampleに含める。
    pub samples: Vec<DriftSample>,
    pub processed_frames: u64,
    /// 途中で失敗した場合は判定せず、部分的な観測とerrorを残す。
    pub verdict: Option<DriftVerdict>,
    pub explanation: String,
    pub error: Option<String>,
}

fn difference(previous: &[u8], current: &[u8]) -> (usize, Option<usize>) {
    let common = previous.len().min(current.len());
    let mut count = previous.len().abs_diff(current.len());
    let mut first = None;
    for (index, (left, right)) in previous.iter().zip(current).enumerate() {
        if left != right {
            count += 1;
            first.get_or_insert(index);
        }
    }
    if first.is_none() && count > 0 {
        first = Some(common);
    }
    (count, first)
}

fn elapsed(frames: u64, rate: u32) -> Duration {
    Duration::new(
        frames / u64::from(rate),
        ((frames % u64::from(rate)) * 1_000_000_000 / u64::from(rate)) as u32,
    )
}

fn observe<T: DriftTarget>(
    target: &mut T,
    report: &mut DriftReport,
    initial: Option<&[u8]>,
    previous: Option<&[u8]>,
) -> Option<Vec<u8>> {
    let mut sample = DriftSample {
        elapsed_ms: elapsed(report.processed_frames, report.config.sample_rate)
            .as_millis()
            .min(u128::from(u64::MAX)) as u64,
        size: None,
        changed_from_previous: None,
        different_bytes: None,
        first_different_byte: None,
        changed_from_initial: None,
        error: None,
    };
    let state = match target.read_state() {
        Ok(state) => {
            sample.size = Some(state.len());
            if let Some(previous) = previous {
                let (count, first) = difference(previous, &state);
                sample.changed_from_previous = Some(count > 0);
                sample.different_bytes = Some(count);
                sample.first_different_byte = first;
            }
            sample.changed_from_initial = initial.map(|initial| initial != state);
            Some(state)
        }
        Err(error) => {
            let message = format!("状態取得に失敗（{} ms）：{error:#}", sample.elapsed_ms);
            sample.error = Some(message.clone());
            report.error = Some(message);
            None
        }
    };
    report.samples.push(sample);
    state
}

/// wait_untilには処理開始からの累積音声時間を渡す。CLIはその時刻までの残りだけ待ち、
/// 試験は何もしない関数で壁時計への依存をなくす。失敗後は処理を進めない。
pub fn measure_drift<T: DriftTarget>(
    target: &mut T,
    config: DriftConfig,
    mut wait_until: impl FnMut(Duration),
) -> Result<DriftReport> {
    config.validate()?;
    let mut report = DriftReport {
        config,
        initial_size: None,
        initial_reads_equal: None,
        samples: Vec::new(),
        processed_frames: 0,
        verdict: None,
        explanation: "計測が完了していないため判定できません。".into(),
        error: None,
    };
    let Some(initial) = observe(target, &mut report, None, None) else {
        return Ok(report);
    };
    report.initial_size = Some(initial.len());
    let Some(mut previous) = observe(target, &mut report, Some(&initial), Some(&initial)) else {
        return Ok(report);
    };
    report.initial_reads_equal = Some(initial == previous);
    let total_frames = config.seconds * u64::from(config.sample_rate);
    let interval_frames = config.interval_seconds * u64::from(config.sample_rate);
    let mut next_sample = interval_frames;
    while report.processed_frames < total_frames {
        if let Err(error) = target.process_block() {
            report.error = Some(format!(
                "音声処理に失敗（{} frame処理済み）：{error:#}",
                report.processed_frames
            ));
            return Ok(report);
        }
        report.processed_frames += u64::from(config.block_size);
        if config.realtime {
            wait_until(elapsed(report.processed_frames, config.sample_rate));
        }
        // 間隔をまたいだ最初のblock末尾と、計測終了時に取得する。
        if report.processed_frames >= next_sample || report.processed_frames >= total_frames {
            let Some(state) = observe(target, &mut report, Some(&initial), Some(&previous)) else {
                return Ok(report);
            };
            previous = state;
            next_sample = (report.processed_frames / interval_frames)
                .saturating_add(1)
                .saturating_mul(interval_frames);
        }
    }
    let verdict = if report.initial_reads_equal == Some(false) {
        DriftVerdict::ChangesOnRead
    } else if report
        .samples
        .iter()
        .any(|sample| sample.changed_from_initial == Some(true))
    {
        DriftVerdict::DriftsWithAudio
    } else {
        DriftVerdict::Stable
    };
    report.verdict = Some(verdict);
    report.explanation = verdict.explanation().into();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Target {
        frames: u64,
        reads: usize,
        state: fn(u64, usize) -> Vec<u8>,
        fail_read: usize,
        fail_process: bool,
    }

    impl DriftTarget for Target {
        fn process_block(&mut self) -> Result<()> {
            ensure!(!self.fail_process, "process failed");
            self.frames += 4;
            Ok(())
        }
        fn read_state(&mut self) -> Result<Vec<u8>> {
            self.reads += 1;
            ensure!(self.reads != self.fail_read, "read failed");
            Ok((self.state)(self.frames, self.reads))
        }
    }

    fn target(state: fn(u64, usize) -> Vec<u8>) -> Target {
        Target {
            frames: 0,
            reads: 0,
            state,
            fail_read: 0,
            fail_process: false,
        }
    }

    fn config() -> DriftConfig {
        DriftConfig {
            seconds: 3,
            interval_seconds: 1,
            sample_rate: 10,
            block_size: 4,
            realtime: false,
        }
    }

    #[test]
    fn stable_and_block_rounded_times() {
        let report = measure_drift(&mut target(|_, _| vec![1, 2]), config(), |_| {
            panic!("fastでは待たない")
        })
        .unwrap();
        assert_eq!(report.verdict, Some(DriftVerdict::Stable));
        assert_eq!(report.initial_size, Some(2));
        assert_eq!(report.initial_reads_equal, Some(true));
        assert_eq!(report.processed_frames, 32);
        assert_eq!(
            report
                .samples
                .iter()
                .map(|s| s.elapsed_ms)
                .collect::<Vec<_>>(),
            [0, 0, 1200, 2000, 3200]
        );
        for sample in &report.samples[1..] {
            assert_eq!(sample.changed_from_previous, Some(false));
            assert_eq!(sample.different_bytes, Some(0));
            assert_eq!(sample.first_different_byte, None);
        }
        assert!(serde_json::to_string(&report).unwrap().contains("Stable"));
    }

    #[test]
    fn changes_on_every_read_takes_precedence() {
        let report = measure_drift(
            &mut target(|_, reads| vec![0, reads as u8]),
            config(),
            |_| {},
        )
        .unwrap();
        assert_eq!(report.verdict, Some(DriftVerdict::ChangesOnRead));
        assert_eq!(report.initial_reads_equal, Some(false));
        for sample in &report.samples[1..] {
            assert_eq!(sample.different_bytes, Some(1));
            assert_eq!(sample.first_different_byte, Some(1));
            assert_eq!(sample.changed_from_initial, Some(true));
        }
    }

    #[test]
    fn drifts_at_frame_threshold_and_can_return_to_initial() {
        let report = measure_drift(
            &mut target(|frames, _| vec![0, ((frames / 20) % 2) as u8]),
            DriftConfig {
                seconds: 4,
                ..config()
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(report.verdict, Some(DriftVerdict::DriftsWithAudio));
        assert_eq!(report.samples[2].different_bytes, Some(0));
        assert_eq!(report.samples[3].different_bytes, Some(1));
        let last = report.samples.last().unwrap();
        assert_eq!(last.changed_from_previous, Some(true));
        assert_eq!(last.changed_from_initial, Some(false));
        assert_eq!(last.first_different_byte, Some(1));
    }

    #[test]
    fn length_changes_count_missing_bytes_and_first_offset() {
        assert_eq!(difference(&[1, 2], &[1, 2, 3, 4]), (2, Some(2)));
        assert_eq!(difference(&[1, 2, 3, 4], &[1, 2]), (2, Some(2)));
        assert_eq!(difference(&[1, 2, 3], &[9]), (3, Some(0)));
        assert_eq!(difference(&[], &[1]), (1, Some(0)));
        let report = measure_drift(
            &mut target(|frames, _| vec![1; if frames >= 20 { 4 } else { 2 }]),
            config(),
            |_| {},
        )
        .unwrap();
        assert_eq!(report.verdict, Some(DriftVerdict::DriftsWithAudio));
        assert_eq!(report.samples[3].size, Some(4));
        assert_eq!(report.samples[3].different_bytes, Some(2));
        assert_eq!(report.samples[3].first_different_byte, Some(2));
    }

    #[test]
    fn read_failures_remain_in_report_without_a_verdict() {
        for fail_read in [1, 2, 3] {
            let mut target = target(|_, _| vec![1]);
            target.fail_read = fail_read;
            let report = measure_drift(&mut target, config(), |_| {}).unwrap();
            assert_eq!(report.verdict, None);
            assert!(report.error.as_ref().unwrap().contains("read failed"));
            let sample = report.samples.last().unwrap();
            assert!(sample.error.is_some());
            assert_eq!(sample.changed_from_previous, None);
            assert_eq!(sample.size, None);
            assert_eq!(report.samples.len(), fail_read);
        }
    }

    #[test]
    fn process_failure_and_invalid_configuration_are_errors() {
        let mut target = target(|_, _| vec![]);
        target.fail_process = true;
        let report = measure_drift(&mut target, config(), |_| {}).unwrap();
        assert!(report.error.unwrap().contains("process failed"));
        assert_eq!(report.verdict, None);
        assert_eq!(report.processed_frames, 0);
        for invalid in [
            DriftConfig {
                seconds: 0,
                ..config()
            },
            DriftConfig {
                interval_seconds: 0,
                ..config()
            },
            DriftConfig {
                sample_rate: 0,
                ..config()
            },
            DriftConfig {
                block_size: 0,
                ..config()
            },
            DriftConfig {
                seconds: u64::MAX,
                ..config()
            },
        ] {
            assert!(measure_drift(&mut target, invalid, |_| {}).is_err());
        }
    }

    #[test]
    fn realtime_waits_until_cumulative_audio_time_and_always_samples_end() {
        let mut deadlines = Vec::new();
        let report = measure_drift(
            &mut target(|_, _| vec![]),
            DriftConfig {
                seconds: 1,
                interval_seconds: 5,
                realtime: true,
                ..config()
            },
            |time| deadlines.push(time.as_millis()),
        )
        .unwrap();
        assert_eq!(deadlines, [400, 800, 1200]);
        assert_eq!(report.samples.last().unwrap().elapsed_ms, 1200);
        assert_eq!(report.samples.len(), 3);
    }
}
