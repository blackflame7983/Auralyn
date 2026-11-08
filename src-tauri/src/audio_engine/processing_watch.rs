//! 無音と、処理や出力コールバックの停止を区別する。
//! 制御スレッドだけが時刻を読み、判定する。検知しても再起動・ミュートはしない。
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// 起動直後は、最初の進捗とこの猶予の両方が揃うまで停止と判定しない。
const STARTUP_GRACE: Duration = Duration::from_secs(1);
/// ブロックが極端に短くても、半秒未満の隙間は停止にしない。
const MIN_STALL: Duration = Duration::from_millis(500);
/// 期待周期の8ブロック分。取りこぼし数回では止めず、続きが途切れたときだけにする。
const STALL_PERIODS: u32 = 8;
/// 直近の異常は累積値ではなく、この窓に残った増分だけを数える。
pub const ANOMALY_WINDOW: Duration = Duration::from_secs(60);
pub const ANOMALY_WINDOW_SECS: u32 = 60;
/// 起動時を除く underflow が1分に3回以上。散発の1回は通知しない（#319 の原因特定とは別）。
pub const UNDERFLOW_WARN: u64 = 3;
/// 遅着は可聴の音切れではない。1分に10回以上で、周期へ追いついていない傾向として出す。
pub const LATE_WARN: u64 = 10;
/// 250ms 観測で60秒ぶんの遅着・underflow増分を、窓の内側で落とさない容量。
const RING_CAP: usize = 512;
const KIND_LATE: u8 = 0;
const KIND_UNDERFLOW: u8 = 1;

#[inline]
pub fn note_callback(counter: &AtomicU64) {
    counter.fetch_add(1, Ordering::Relaxed);
}

pub fn stall_after(block_period: Duration) -> Duration {
    block_period
        .checked_mul(STALL_PERIODS)
        .unwrap_or(Duration::MAX)
        .max(MIN_STALL)
}

pub fn frequency_warning(recent_late: u64, recent_underflow: u64) -> bool {
    recent_underflow >= UNDERFLOW_WARN || recent_late >= LATE_WARN
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthState {
    #[default]
    Idle,
    Grace,
    Normal,
    Stalled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StallKind {
    OutputCallback,
    Processing,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessingHealthSnapshot {
    pub state: HealthState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall_kind: Option<StallKind>,
    pub stalled_ms: u64,
    pub recent_late: u64,
    pub recent_underflow: u64,
    pub window_secs: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct ProgressSample {
    pub attempt_epoch: u64,
    pub running: bool,
    pub paused_by_mode_silence: bool,
    pub output_callbacks: u64,
    pub processed_blocks: u64,
    pub input_callbacks: u64,
    pub late_callbacks: u64,
    pub underflow_callbacks: u64,
    pub block_period: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatchOutput {
    pub snapshot: ProcessingHealthSnapshot,
    pub emit: bool,
}

#[derive(Clone, Copy)]
struct Anomaly {
    at: Instant,
    kind: u8,
    delta: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Signature {
    state: HealthState,
    kind: Option<StallKind>,
    warning: bool,
}

pub struct ProcessingWatch {
    epoch: Option<u64>,
    active: bool,
    suspended: bool,
    grace_started: Option<Instant>,
    seen_progress: bool,
    base_output: u64,
    base_processed: u64,
    base_input: u64,
    base_late: u64,
    base_underflow: u64,
    output_at: Option<Instant>,
    processed_at: Option<Instant>,
    stalled_since: Option<Instant>,
    ring: Vec<Anomaly>,
    ring_len: usize,
    ring_next: usize,
    published: Option<Signature>,
    latest: ProcessingHealthSnapshot,
}

impl Default for ProcessingWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessingWatch {
    pub fn new() -> Self {
        let origin = Instant::now();
        Self {
            epoch: None,
            active: false,
            suspended: false,
            grace_started: None,
            seen_progress: false,
            base_output: 0,
            base_processed: 0,
            base_input: 0,
            base_late: 0,
            base_underflow: 0,
            output_at: None,
            processed_at: None,
            stalled_since: None,
            ring: vec![
                Anomaly {
                    at: origin,
                    kind: KIND_LATE,
                    delta: 0,
                };
                RING_CAP
            ],
            ring_len: 0,
            ring_next: 0,
            published: None,
            latest: ProcessingHealthSnapshot {
                window_secs: ANOMALY_WINDOW_SECS,
                ..ProcessingHealthSnapshot::default()
            },
        }
    }

    pub fn snapshot(&self) -> ProcessingHealthSnapshot {
        self.latest
    }

    pub fn observe_at(&mut self, now: Instant, sample: ProgressSample) -> WatchOutput {
        if !sample.running {
            if self.active || self.epoch.is_some() {
                self.hard_reset(sample);
            }
            self.active = false;
            return self.finish(now, HealthState::Idle, None);
        }
        if self.epoch != Some(sample.attempt_epoch) || self.decreased(&sample) {
            self.hard_reset(sample);
            self.arm(now);
            self.active = true;
            self.suspended = sample.paused_by_mode_silence;
            return self.finish(now, HealthState::Grace, None);
        }
        if sample.paused_by_mode_silence {
            // 入力を止めている間の隙間や、排出中の不足は停止にも直近回数にも入れない。
            self.adopt_counters(&sample);
            self.suspended = true;
            self.stalled_since = None;
            self.active = true;
            return self.finish(now, HealthState::Grace, None);
        }
        if self.suspended || !self.active {
            self.arm(now);
            self.suspended = false;
            self.active = true;
            return self.finish(now, HealthState::Grace, None);
        }
        self.record_anomalies(now, &sample);
        self.note_progress(now, &sample);
        self.adopt_counters(&sample);
        self.judge(now, sample.block_period)
    }

    fn decreased(&self, sample: &ProgressSample) -> bool {
        sample.output_callbacks < self.base_output
            || sample.processed_blocks < self.base_processed
            || sample.input_callbacks < self.base_input
            || sample.late_callbacks < self.base_late
            || sample.underflow_callbacks < self.base_underflow
    }

    fn hard_reset(&mut self, sample: ProgressSample) {
        self.ring_len = 0;
        self.ring_next = 0;
        self.epoch = Some(sample.attempt_epoch);
        self.adopt_counters(&sample);
        self.grace_started = None;
        self.seen_progress = false;
        self.output_at = None;
        self.processed_at = None;
        self.stalled_since = None;
        self.suspended = false;
    }

    fn arm(&mut self, now: Instant) {
        self.grace_started = Some(now);
        self.seen_progress = false;
        self.output_at = None;
        self.processed_at = None;
        self.stalled_since = None;
    }

    fn adopt_counters(&mut self, sample: &ProgressSample) {
        self.base_output = sample.output_callbacks;
        self.base_processed = sample.processed_blocks;
        self.base_input = sample.input_callbacks;
        self.base_late = sample.late_callbacks;
        self.base_underflow = sample.underflow_callbacks;
    }

    fn record_anomalies(&mut self, now: Instant, sample: &ProgressSample) {
        self.push(now, KIND_LATE, sample.late_callbacks - self.base_late);
        self.push(
            now,
            KIND_UNDERFLOW,
            sample.underflow_callbacks - self.base_underflow,
        );
    }

    fn note_progress(&mut self, now: Instant, sample: &ProgressSample) {
        if sample.output_callbacks > self.base_output {
            self.output_at = Some(now);
            self.seen_progress = true;
        }
        if sample.processed_blocks > self.base_processed {
            self.processed_at = Some(now);
            self.seen_progress = true;
        }
    }

    fn judge(&mut self, now: Instant, block_period: Duration) -> WatchOutput {
        let grace_done = self
            .grace_started
            .and_then(|started| now.checked_duration_since(started))
            .is_some_and(|elapsed| elapsed >= STARTUP_GRACE);
        if !self.seen_progress || !grace_done {
            self.stalled_since = None;
            return self.finish(now, HealthState::Grace, None);
        }
        let limit = stall_after(block_period);
        let output_stale = self.stale(now, self.output_at, limit);
        let processed_stale = self.stale(now, self.processed_at, limit);
        if !output_stale && !processed_stale {
            self.stalled_since = None;
            return self.finish(now, HealthState::Normal, None);
        }
        // 出力コールバックが止まっていれば、処理の有無より先にそちらを出す。
        let kind = if output_stale {
            StallKind::OutputCallback
        } else {
            StallKind::Processing
        };
        if self.stalled_since.is_none() {
            self.stalled_since = Some(now);
        }
        self.finish(now, HealthState::Stalled, Some(kind))
    }

    fn stale(&self, now: Instant, at: Option<Instant>, limit: Duration) -> bool {
        match at.and_then(|at| now.checked_duration_since(at)) {
            Some(elapsed) => elapsed >= limit,
            None => true,
        }
    }

    fn push(&mut self, now: Instant, kind: u8, delta: u64) {
        if delta == 0 {
            return;
        }
        self.ring[self.ring_next] = Anomaly {
            at: now,
            kind,
            delta,
        };
        self.ring_next = (self.ring_next + 1) % RING_CAP;
        self.ring_len = (self.ring_len + 1).min(RING_CAP);
    }

    fn recent(&self, now: Instant) -> (u64, u64) {
        let mut late = 0u64;
        let mut underflow = 0u64;
        if self.ring_len == 0 {
            return (0, 0);
        }
        let start = if self.ring_len == RING_CAP {
            self.ring_next
        } else {
            0
        };
        for offset in 0..self.ring_len {
            let slot = self.ring[(start + offset) % RING_CAP];
            let Some(age) = now.checked_duration_since(slot.at) else {
                continue;
            };
            if age > ANOMALY_WINDOW {
                continue;
            }
            if slot.kind == KIND_LATE {
                late = late.saturating_add(slot.delta);
            } else {
                underflow = underflow.saturating_add(slot.delta);
            }
        }
        (late, underflow)
    }

    fn finish(&mut self, now: Instant, state: HealthState, kind: Option<StallKind>) -> WatchOutput {
        let (recent_late, recent_underflow) = if state == HealthState::Idle {
            (0, 0)
        } else {
            self.recent(now)
        };
        let stalled_ms = if state == HealthState::Stalled {
            self.stalled_since
                .and_then(|started| now.checked_duration_since(started))
                .map(|elapsed| elapsed.as_millis() as u64)
                .unwrap_or(0)
        } else {
            0
        };
        let snapshot = ProcessingHealthSnapshot {
            state,
            stall_kind: kind.filter(|_| state == HealthState::Stalled),
            stalled_ms,
            recent_late,
            recent_underflow,
            window_secs: ANOMALY_WINDOW_SECS,
        };
        let signature = Signature {
            state,
            kind: snapshot.stall_kind,
            warning: frequency_warning(recent_late, recent_underflow),
        };
        let emit = self.published != Some(signature);
        self.published = Some(signature);
        self.latest = snapshot;
        WatchOutput { snapshot, emit }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    fn running(epoch: u64) -> ProgressSample {
        ProgressSample {
            attempt_epoch: epoch,
            running: true,
            paused_by_mode_silence: false,
            output_callbacks: 0,
            processed_blocks: 0,
            input_callbacks: 0,
            late_callbacks: 0,
            underflow_callbacks: 0,
            block_period: Duration::from_millis(10),
        }
    }

    fn progress(sample: &mut ProgressSample, steps: u64) {
        sample.output_callbacks += steps;
        sample.processed_blocks += steps;
        sample.input_callbacks += steps;
    }

    #[test]
    fn callback_note_does_not_allocate() {
        let counter = AtomicU64::new(0);
        let counts = crate::dsp_verification_allocator::allocation_counts(|| {
            note_callback(&counter);
            note_callback(&counter);
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(counter.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn silence_with_progress_does_not_warn() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        watch.observe_at(start, sample);
        for step in 1..=30 {
            progress(&mut sample, 1);
            let output = watch.observe_at(at(start, step * 100), sample);
            assert_ne!(output.snapshot.state, HealthState::Stalled);
        }
    }

    #[test]
    fn stall_is_reported_after_grace_and_stall_limit() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        watch.observe_at(start, sample);
        progress(&mut sample, 1);
        let early = watch.observe_at(at(start, 100), sample);
        assert_eq!(early.snapshot.state, HealthState::Grace);
        let still_grace = watch.observe_at(at(start, 999), sample);
        assert_eq!(still_grace.snapshot.state, HealthState::Grace);
        let stalled = watch.observe_at(at(start, 1000), sample);
        assert_eq!(stalled.snapshot.state, HealthState::Stalled);
        assert_eq!(stalled.snapshot.stall_kind, Some(StallKind::OutputCallback));
        assert!(stalled.emit);
    }

    #[test]
    fn longer_block_period_extends_the_stall_limit() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        sample.block_period = Duration::from_millis(100);
        assert_eq!(stall_after(sample.block_period), Duration::from_millis(800));
        watch.observe_at(start, sample);
        progress(&mut sample, 1);
        watch.observe_at(at(start, 1100), sample);
        let before = watch.observe_at(at(start, 1100 + 799), sample);
        assert_ne!(before.snapshot.state, HealthState::Stalled);
        let stalled = watch.observe_at(at(start, 1100 + 800), sample);
        assert_eq!(stalled.snapshot.state, HealthState::Stalled);
    }

    #[test]
    fn processing_stall_is_distinct_when_output_callbacks_continue() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        watch.observe_at(start, sample);
        progress(&mut sample, 1);
        watch.observe_at(at(start, 100), sample);
        for step in 2..=9 {
            sample.output_callbacks += 1;
            sample.input_callbacks += 1;
            let output = watch.observe_at(at(start, step * 100), sample);
            assert_ne!(output.snapshot.state, HealthState::Stalled);
        }
        sample.output_callbacks += 1;
        let stalled = watch.observe_at(at(start, 1_000), sample);
        assert_eq!(stalled.snapshot.state, HealthState::Stalled);
        assert_eq!(stalled.snapshot.stall_kind, Some(StallKind::Processing));
    }

    #[test]
    fn no_judgment_before_grace_or_the_first_progress() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let sample = running(1);
        for ms in [0, 500, 1000, 5_000] {
            let output = watch.observe_at(at(start, ms), sample);
            assert_eq!(output.snapshot.state, HealthState::Grace);
            assert!(output.snapshot.stall_kind.is_none());
        }
    }

    #[test]
    fn stop_epoch_change_and_counter_rewind_do_not_warn() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(7);
        watch.observe_at(start, sample);
        progress(&mut sample, 2);
        watch.observe_at(at(start, 100), sample);
        let stalled = watch.observe_at(at(start, 1_000), sample);
        assert_eq!(stalled.snapshot.state, HealthState::Stalled);

        sample.running = false;
        let stopped = watch.observe_at(at(start, 1_200), sample);
        assert_eq!(stopped.snapshot.state, HealthState::Idle);
        assert!(stopped.snapshot.stall_kind.is_none());
        assert_eq!(stopped.snapshot.recent_late, 0);

        sample.running = true;
        sample.attempt_epoch = 8;
        sample.output_callbacks = 0;
        sample.processed_blocks = 0;
        let restarted = watch.observe_at(at(start, 1_500), sample);
        assert_eq!(restarted.snapshot.state, HealthState::Grace);
        let still = watch.observe_at(at(start, 9_000), sample);
        assert_ne!(still.snapshot.state, HealthState::Stalled);

        progress(&mut sample, 3);
        watch.observe_at(at(start, 9_100), sample);
        sample.output_callbacks = 1;
        let rewound = watch.observe_at(at(start, 20_000), sample);
        assert_eq!(rewound.snapshot.state, HealthState::Grace);
        assert!(rewound.snapshot.stall_kind.is_none());
    }

    #[test]
    fn mode_silence_pause_is_not_a_stall() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        watch.observe_at(start, sample);
        progress(&mut sample, 1);
        watch.observe_at(at(start, 100), sample);
        sample.paused_by_mode_silence = true;
        for ms in [1_000, 5_000, 30_000] {
            let output = watch.observe_at(at(start, ms), sample);
            assert_ne!(output.snapshot.state, HealthState::Stalled);
        }
        sample.paused_by_mode_silence = false;
        let resumed = watch.observe_at(at(start, 30_100), sample);
        assert_eq!(resumed.snapshot.state, HealthState::Grace);
    }

    #[test]
    fn input_callbacks_stopping_alone_is_not_a_processing_stall() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        watch.observe_at(start, sample);
        progress(&mut sample, 1);
        watch.observe_at(at(start, 100), sample);
        for step in 2..=20 {
            sample.output_callbacks += 1;
            sample.processed_blocks += 1;
            let output = watch.observe_at(at(start, step * 100), sample);
            assert_ne!(output.snapshot.state, HealthState::Stalled);
        }
    }

    #[test]
    fn clustered_underflows_warn_and_sparse_ones_age_out() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        sample.underflow_callbacks = 40;
        sample.late_callbacks = 40;
        let baseline = watch.observe_at(start, sample);
        assert_eq!(baseline.snapshot.recent_underflow, 0);
        assert!(!frequency_warning(0, 0));

        sample.underflow_callbacks = 43;
        let burst = watch.observe_at(at(start, 1_000), sample);
        assert_eq!(burst.snapshot.recent_underflow, 3);
        assert!(frequency_warning(
            burst.snapshot.recent_late,
            burst.snapshot.recent_underflow
        ));
        assert!(burst.emit);

        let mut sparse = ProcessingWatch::new();
        let mut scattered = running(2);
        sparse.observe_at(start, scattered);
        for (ms, total) in [(1_000, 1u64), (31_000, 2), (71_000, 3)] {
            scattered.underflow_callbacks = total;
            let output = sparse.observe_at(at(start, ms), scattered);
            assert!(output.snapshot.recent_underflow < UNDERFLOW_WARN);
        }

        let cleared = watch.observe_at(at(start, 62_000), sample);
        assert_eq!(cleared.snapshot.recent_underflow, 0);
        assert!(!frequency_warning(0, 0));
    }

    #[test]
    fn late_arrivals_use_their_own_threshold_and_do_not_stick() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        watch.observe_at(start, sample);
        sample.late_callbacks = 9;
        let below = watch.observe_at(at(start, 1_000), sample);
        assert_eq!(below.snapshot.recent_late, 9);
        assert!(!frequency_warning(9, 0));
        sample.late_callbacks = 10;
        let warned = watch.observe_at(at(start, 1_100), sample);
        assert!(frequency_warning(warned.snapshot.recent_late, 0));
        let cleared = watch.observe_at(at(start, 62_000), sample);
        assert_eq!(cleared.snapshot.recent_late, 0);
        assert!(cleared.emit);
    }

    #[test]
    fn recovery_emits_once_and_returns_to_normal() {
        let start = Instant::now();
        let mut watch = ProcessingWatch::new();
        let mut sample = running(1);
        watch.observe_at(start, sample);
        progress(&mut sample, 1);
        watch.observe_at(at(start, 100), sample);
        let stalled = watch.observe_at(at(start, 1_000), sample);
        assert_eq!(stalled.snapshot.state, HealthState::Stalled);
        progress(&mut sample, 1);
        let recovered = watch.observe_at(at(start, 1_100), sample);
        assert_eq!(recovered.snapshot.state, HealthState::Normal);
        assert!(recovered.snapshot.stall_kind.is_none());
        assert!(recovered.emit);
        let again = watch.observe_at(at(start, 1_200), sample);
        assert!(!again.emit);
        assert_eq!(again.snapshot.state, HealthState::Normal);
    }
}
