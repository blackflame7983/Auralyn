//! 同率raw frame／異率batch-ready callbackと実queue読出しを非RTで結合する。
//! 異率の位置は生成出力frameであり、元の入力sampleとの点対応ではない。
pub mod cohort;
mod periods;
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapRb,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};

pub const CAPACITY: usize = 1024;
const DRAIN_LIMIT: usize = 256;
const BUCKET_NS: u64 = 100_000;
const BUCKETS: usize = 10_001; // 最終bucketは1秒以上。上限は保証しない。
const TRACE_CAPACITY: usize = 64;
type Tx<T> = <HeapRb<T> as Split>::Prod;
type Rx<T> = <HeapRb<T> as Split>::Cons;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantileRange {
    pub lower_ms: f64,
    pub upper_ms: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Input,
    Output,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClockComparison {
    EqualCallbackTimestamp,
    InputTimestampEarlier,
    InputTimestampLater,
    Missing,
    Unverified,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockCounters {
    pub missing: u64,
    pub duplicate: u64,
    pub backward: u64,
    pub unverified: u64,
    pub sequence_gaps: u64,
    pub nonincreasing_sequence: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackTrace {
    pub direction: Direction,
    pub sequence: u64,
    pub queue_start: u64,
    pub count: u64,
    pub source_start: Option<u64>,
    pub source_count: Option<u64>,
    pub begin_ns: u64,
    pub read_completed_ns: Option<u64>,
    pub end_ns: Option<u64>,
    pub cpal_relative_ns: Option<String>,
    pub cpal_previous_delta_ns: Option<String>,
    pub sequence_gap: u64,
    pub nonincreasing_sequence: bool,
    pub cpal_duplicate: bool,
    pub cpal_backward: bool,
    pub cpal_missing: bool,
    pub cpal_comparison_unverified: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentTrace {
    pub queue_start: u64,
    pub count: u64,
    pub source_start: u64,
    pub input_sequence: u64,
    pub output_sequence: u64,
    pub arrival_ns: u64,
    pub output_begin_ns: u64,
    pub read_completed_ns: u64,
    pub output_end_ns: u64,
    pub valid_arrival_order: bool,
    pub input_cpal_relative_ns: Option<String>,
    pub output_cpal_relative_ns: Option<String>,
    pub input_minus_output_cpal_ns: Option<String>,
    pub callback_timestamp_comparison: ClockComparison,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trace {
    pub epoch: String,
    pub sealed: bool,
    pub callback_capacity: usize,
    pub segment_capacity: usize,
    pub callback_evictions: u64,
    pub segment_evictions: u64,
    pub input_clock: ClockCounters,
    pub output_clock: ClockCounters,
    pub callbacks: Vec<CallbackTrace>,
    pub segments: Vec<SegmentTrace>,
    pub clock_interpretation: String,
}

// Ordと公開duration_sinceだけで符号を付ける。CPAL以外の純粋値でも検証する。
fn compare_clock<T: Ord>(
    left: Option<&T>,
    right: Option<&T>,
    distance: impl Fn(&T, &T) -> Option<u128>,
) -> (ClockComparison, Option<i128>) {
    use std::cmp::Ordering;
    let (Some(left), Some(right)) = (left, right) else {
        return (ClockComparison::Missing, None);
    };
    let (comparison, delta) = match left.cmp(right) {
        Ordering::Equal => (ClockComparison::EqualCallbackTimestamp, Some(0)),
        Ordering::Less => (
            ClockComparison::InputTimestampEarlier,
            distance(right, left)
                .and_then(|n| i128::try_from(n).ok())
                .map(|n| -n),
        ),
        Ordering::Greater => (
            ClockComparison::InputTimestampLater,
            distance(left, right).and_then(|n| i128::try_from(n).ok()),
        ),
    };
    if delta.is_none() {
        (ClockComparison::Unverified, None)
    } else {
        (comparison, delta)
    }
}
fn cpal_comparison(
    left: Option<&cpal::StreamInstant>,
    right: Option<&cpal::StreamInstant>,
) -> (ClockComparison, Option<i128>) {
    compare_clock(left, right, |later, earlier| {
        later
            .duration_since(earlier)
            .map(|duration| duration.as_nanos())
    })
}

#[derive(Clone, Copy)]
struct CallbackRecord {
    direction: Direction,
    seq: u64,
    queue_start: u64,
    count: u64,
    source: Option<(u64, u64)>,
    begin: u64,
    read: Option<u64>,
    end: Option<u64>,
    relative: Option<i128>,
    previous_delta: Option<i128>,
    gap: u64,
    nonincreasing: bool,
    comparison: ClockComparison,
    missing: bool,
}
#[derive(Clone, Copy)]
struct SegmentRecord {
    queue_start: u64,
    count: u64,
    source_start: u64,
    input: InputEvent,
    output: OutputEvent,
}
#[derive(Default)]
struct ClockState {
    previous: Option<cpal::StreamInstant>,
    sequence: u64,
    counters: ClockCounters,
}
impl ClockState {
    fn observe<T: Ord>(
        sequence: &mut u64,
        counters: &mut ClockCounters,
        seq: u64,
        current: Option<&T>,
        previous: Option<&T>,
        distance: impl Fn(&T, &T) -> Option<u128>,
    ) -> (u64, bool, ClockComparison, Option<i128>) {
        let gap = seq.saturating_sub(sequence.saturating_add(1));
        let nonincreasing = seq <= *sequence;
        counters.sequence_gaps = counters.sequence_gaps.saturating_add(gap);
        counters.nonincreasing_sequence += u64::from(nonincreasing);
        *sequence = (*sequence).max(seq);
        let (comparison, delta) = compare_clock(current, previous, distance);
        if current.is_none() {
            counters.missing += 1;
        }
        match comparison {
            ClockComparison::EqualCallbackTimestamp => counters.duplicate += 1,
            ClockComparison::InputTimestampEarlier => counters.backward += 1,
            ClockComparison::Unverified => counters.unverified += 1,
            _ => {}
        }
        (gap, nonincreasing, comparison, delta)
    }
}

struct TraceState {
    anchor: Option<cpal::StreamInstant>,
    input: ClockState,
    output: ClockState,
    callbacks: Vec<CallbackRecord>,
    segments: VecDeque<SegmentRecord>,
    callback_evictions: u64,
    segment_evictions: u64,
}
impl TraceState {
    fn new() -> Self {
        Self {
            anchor: None,
            input: ClockState::default(),
            output: ClockState::default(),
            callbacks: Vec::with_capacity(TRACE_CAPACITY),
            segments: VecDeque::with_capacity(TRACE_CAPACITY),
            callback_evictions: 0,
            segment_evictions: 0,
        }
    }
    fn callback(&mut self, mut record: CallbackRecord, timestamp: Option<cpal::StreamInstant>) {
        if self.anchor.is_none() {
            self.anchor = timestamp;
        }
        record.relative = cpal_comparison(timestamp.as_ref(), self.anchor.as_ref()).1;
        let state = match record.direction {
            Direction::Input => &mut self.input,
            Direction::Output => &mut self.output,
        };
        (
            record.gap,
            record.nonincreasing,
            record.comparison,
            record.previous_delta,
        ) = ClockState::observe(
            &mut state.sequence,
            &mut state.counters,
            record.seq,
            timestamp.as_ref(),
            state.previous.as_ref(),
            |later, earlier| later.duration_since(earlier).map(|d| d.as_nanos()),
        );
        state.previous = timestamp;
        record.missing = timestamp.is_none();
        // ingest順は入力→出力なので、共通Instant上のcallback開始順で最近64件を保つ。
        let key = |r: &CallbackRecord| (r.begin, matches!(r.direction, Direction::Output), r.seq);
        let position = self.callbacks.partition_point(|r| key(r) <= key(&record));
        let position = if self.callbacks.len() == TRACE_CAPACITY {
            self.callback_evictions += 1;
            if position == 0 {
                return;
            }
            self.callbacks.remove(0);
            position - 1
        } else {
            position
        };
        self.callbacks.insert(position, record);
    }
    fn segment(&mut self, segment: SegmentRecord) {
        if self.segments.len() == TRACE_CAPACITY {
            self.segments.pop_front();
            self.segment_evictions += 1;
        }
        self.segments.push_back(segment);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub epoch: String,
    pub supported: bool,
    pub sealed: bool,
    pub counter_invalid: bool,
    pub consumed_frames: u64,
    pub matched_frames: u64,
    pub pending_frames: u64,
    pub unknown_frames: u64,
    pub coverage_percent: Option<f64>,
    pub p50: Option<QuantileRange>,
    pub p95: Option<QuantileRange>,
    pub histogram_resolution_ms: f64,
    pub observation_ms: f64,
    pub input_metadata_dropped: u64,
    pub output_metadata_dropped: u64,
    pub invalid_events: u64,
    pub pending_evictions: u64,
    pub overlapping_callback_frames: u64,
    pub asio_cycle_classification: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BatchMode {
    CallbackBatchReadiness,
}

/// 同率raw観測と別の公開形式。申告delayは分位へ加算・減算しない。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSnapshot {
    pub mode: BatchMode,
    pub declared_resampler: super::resampling::TimingDescriptor,
    #[serde(flatten)]
    pub observation: Snapshot,
}

/// 1入力callback全体の受入が、生成出力の単一prefixであることだけを検査する。
/// 逸脱しても音声の転送を変えず、観測を失効させる。
#[derive(Default)]
pub(super) struct AcceptedPrefix {
    closed: bool,
    invalid: bool,
}
impl AcceptedPrefix {
    pub fn record(&mut self, offered: usize, accepted: usize) {
        self.invalid |= accepted > offered || (self.closed && accepted > 0);
        self.closed |= accepted < offered;
    }
    pub fn valid(&self) -> bool {
        !self.invalid
    }
}

#[derive(Clone, Copy, Debug)]
struct InputEvent {
    epoch: u64,
    seq: u64,
    source_start: u64,
    source_count: u64,
    queue_start: u64,
    count: u64,
    arrival_ns: u64,
    // CPALの時計はstd Instantと減算しない。初版では周期の品質を保証しない。
    _cpal_callback: Option<cpal::StreamInstant>,
}
#[derive(Clone, Copy, Debug)]
struct OutputEvent {
    epoch: u64,
    seq: u64,
    queue_start: u64,
    count: u64,
    begin_ns: u64,
    read_ns: u64,
    end_ns: u64,
    _cpal_callback: Option<cpal::StreamInstant>,
}

#[derive(Default)]
struct Shared {
    consumed: AtomicU64,
    input_lost: AtomicU64,
    output_lost: AtomicU64,
    invalid: AtomicBool,
}

pub struct InputRecorder {
    cohort: Option<cohort::Input>,
    tx: Tx<InputEvent>,
    shared: Arc<Shared>,
    origin: Instant,
    epoch: u64,
    seq: u64,
    source: u64,
    queue: u64,
}
pub struct OutputRecorder {
    cohort: Option<cohort::Output>,
    tx: Tx<OutputEvent>,
    shared: Arc<Shared>,
    origin: Instant,
    epoch: u64,
    seq: u64,
    queue: u64,
}

impl InputRecorder {
    pub fn invalidate(&self) {
        self.shared.invalid.store(true, Ordering::Release);
        if let Some(cohort) = &self.cohort {
            cohort.invalidate(cohort::InvalidReason::OrdinalMismatch);
        }
    }
    pub fn record_span(&mut self, frames: usize, arrival: u64) {
        if let Some(c) = &mut self.cohort {
            c.span(frames, arrival);
        }
    }
    pub fn record_direct_emission(&mut self, frames: usize, accepted: usize) {
        if let Some(c) = &mut self.cohort {
            c.direct_emit(frames, accepted);
        }
    }
    pub fn record_emission(
        &mut self,
        emission: Option<super::resampling::CohortEmission>,
        accepted: usize,
    ) {
        if let Some(c) = &mut self.cohort {
            c.emit(emission, accepted);
        }
    }
    pub fn now_ns(&self) -> u64 {
        elapsed_ns(self.origin)
    }
    pub fn record(
        &mut self,
        // 同率は受信入力frame、異率は生成出力frame（dropを含む）。
        received: usize,
        accepted: usize,
        arrival_ns: u64,
        callback: Option<cpal::StreamInstant>,
    ) {
        if self.shared.invalid.load(Ordering::Acquire) {
            return;
        }
        let Some(source_end) = self.source.checked_add(received as u64) else {
            self.shared.invalid.store(true, Ordering::Relaxed);
            return;
        };
        let Some(queue_end) = self.queue.checked_add(accepted as u64) else {
            self.shared.invalid.store(true, Ordering::Relaxed);
            return;
        };
        let Some(seq) = self.seq.checked_add(1) else {
            self.shared.invalid.store(true, Ordering::Relaxed);
            return;
        };
        if accepted > received {
            self.shared.invalid.store(true, Ordering::Relaxed);
            return;
        }
        let event = InputEvent {
            epoch: self.epoch,
            seq,
            source_start: self.source,
            source_count: received as u64,
            queue_start: self.queue,
            count: accepted as u64,
            arrival_ns,
            _cpal_callback: callback,
        };
        self.source = source_end;
        self.queue = queue_end;
        self.seq = seq;
        if self.tx.try_push(event).is_err() {
            self.shared.input_lost.fetch_add(1, Ordering::Relaxed);
        }
    }
}
impl OutputRecorder {
    /// consumerの破棄前に当試行の対応frame観測を失効する。
    pub fn invalidate_recovery(&self) {
        self.shared.invalid.store(true, Ordering::Release);
        if let Some(c) = &self.cohort {
            c.invalidate(cohort::InvalidReason::RecoverySkip);
        }
    }
    pub fn complete_cohort_window(&mut self, revision: u64, applied: bool) -> bool {
        self.cohort
            .as_mut()
            .is_some_and(|c| c.complete_window(revision, applied))
    }
    pub fn now_ns(&self) -> u64 {
        elapsed_ns(self.origin)
    }
    pub fn record(
        &mut self,
        consumed: usize,
        begin_ns: u64,
        read_ns: u64,
        callback: Option<cpal::StreamInstant>,
    ) {
        self.record_context(consumed, consumed, begin_ns, read_ns, callback, true);
    }
    pub fn record_context(
        &mut self,
        consumed: usize,
        requested: usize,
        begin_ns: u64,
        read_ns: u64,
        callback: Option<cpal::StreamInstant>,
        normal_mic: bool,
    ) {
        let end_ns = self.now_ns();
        if let Some(c) = &mut self.cohort {
            c.record(consumed, requested, end_ns, normal_mic);
        }
        if self.shared.invalid.load(Ordering::Acquire) {
            return;
        }
        let Some(end) = self.queue.checked_add(consumed as u64) else {
            self.shared.invalid.store(true, Ordering::Relaxed);
            return;
        };
        let Some(seq) = self.seq.checked_add(1) else {
            self.shared.invalid.store(true, Ordering::Relaxed);
            return;
        };
        let event = OutputEvent {
            epoch: self.epoch,
            seq,
            queue_start: self.queue,
            count: consumed as u64,
            begin_ns,
            read_ns,
            end_ns,
            _cpal_callback: callback,
        };
        self.queue = end;
        self.seq = seq;
        if self.tx.try_push(event).is_err() {
            self.shared.output_lost.fetch_add(1, Ordering::Relaxed);
        }
        self.shared.consumed.store(end, Ordering::Release);
    }
}
fn elapsed_ns(origin: Instant) -> u64 {
    origin.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

/// consumerとSharedをstreamより長く制御側で保持し、RTの最後のArc解放を防ぐ。
pub struct Observer {
    cohort: Option<cohort::Observer>,
    epoch: String,
    epoch_id: u64,
    supported: bool,
    batch_descriptor: Option<super::resampling::TimingDescriptor>,
    sealed_ns: Option<u64>,
    origin: Instant,
    shared: Arc<Shared>,
    input_rx: Rx<InputEvent>,
    output_rx: Rx<OutputEvent>,
    inputs: VecDeque<InputEvent>,
    outputs: VecDeque<OutputEvent>,
    histogram: Box<[u64]>,
    matched: u64,
    consumed_seen: u64,
    overlap: u64,
    input_seq: u64,
    output_seq: u64,
    input_end: u64,
    source_end: u64,
    output_end: u64,
    invalid_events: u64,
    evictions: u64,
    trace: TraceState,
}

impl Observer {
    pub fn new(
        epoch: String,
        epoch_id: u64,
        supported: bool,
    ) -> (Self, Option<InputRecorder>, Option<OutputRecorder>) {
        Self::construct(epoch, epoch_id, supported, None)
    }
    fn construct(
        epoch: String,
        epoch_id: u64,
        supported: bool,
        descriptor: Option<super::resampling::TimingDescriptor>,
    ) -> (Self, Option<InputRecorder>, Option<OutputRecorder>) {
        let (cohort, cohort_input, cohort_output) = if supported {
            let geometry = descriptor.as_ref().map_or(
                Some(super::resampling::CohortGeometry {
                    input_unit_frames: 1,
                    output_unit_frames: 1,
                }),
                super::resampling::CohortGeometry::from_descriptor,
            );
            let (c, i, o) = cohort::Observer::new(epoch.clone(), geometry);
            (Some(c), Some(i), Some(o))
        } else {
            (None, None, None)
        };
        let origin = Instant::now();
        let shared = Arc::new(Shared::default());
        let (input_tx, input_rx) = HeapRb::new(CAPACITY).split();
        let (output_tx, output_rx) = HeapRb::new(CAPACITY).split();
        let input = supported.then(|| InputRecorder {
            cohort: cohort_input,
            tx: input_tx,
            shared: shared.clone(),
            origin,
            epoch: epoch_id,
            seq: 0,
            source: 0,
            queue: 0,
        });
        let output = supported.then(|| OutputRecorder {
            cohort: cohort_output,
            tx: output_tx,
            shared: shared.clone(),
            origin,
            epoch: epoch_id,
            seq: 0,
            queue: 0,
        });
        (
            Self {
                cohort,
                epoch,
                epoch_id,
                supported,
                batch_descriptor: descriptor,
                sealed_ns: None,
                origin,
                shared,
                input_rx,
                output_rx,
                inputs: VecDeque::with_capacity(CAPACITY),
                outputs: VecDeque::with_capacity(CAPACITY),
                histogram: vec![0; BUCKETS].into_boxed_slice(),
                matched: 0,
                consumed_seen: 0,
                overlap: 0,
                input_seq: 0,
                output_seq: 0,
                input_end: 0,
                source_end: 0,
                output_end: 0,
                invalid_events: 0,
                evictions: 0,
                trace: TraceState::new(),
            },
            input,
            output,
        )
    }

    /// 同じ有界結合器を使うが、raw traceとして異率の生成位置を公開しない。
    pub fn new_batch(
        epoch: String,
        epoch_id: u64,
        descriptor: super::resampling::TimingDescriptor,
    ) -> (Self, Option<InputRecorder>, Option<OutputRecorder>) {
        Self::construct(epoch, epoch_id, true, Some(descriptor))
    }

    pub fn request_cohort_window(&self) -> Option<u64> {
        self.cohort.as_ref().and_then(|c| c.request_window())
    }
    pub fn cohort_snapshot(&self) -> Option<cohort::Snapshot> {
        self.cohort.as_ref().map(|c| c.snapshot())
    }

    pub fn raw_snapshot(&self) -> Option<Snapshot> {
        self.batch_descriptor.is_none().then(|| self.snapshot())
    }

    pub fn batch_snapshot(&self) -> Option<BatchSnapshot> {
        self.batch_descriptor
            .as_ref()
            .map(|descriptor| BatchSnapshot {
                mode: BatchMode::CallbackBatchReadiness,
                declared_resampler: descriptor.clone(),
                observation: self.snapshot(),
            })
    }

    /// UI pollから独立して制御ループで呼ぶ。処理量・保持量の上限を固定する。
    pub fn drain(&mut self) {
        if let Some(c) = &mut self.cohort {
            c.drain();
            c.publish_periods(elapsed_ns(self.origin));
        }
        if self.sealed_ns.is_some() {
            return;
        }
        for _ in 0..DRAIN_LIMIT {
            let Some(event) = self.input_rx.try_pop() else {
                break;
            };
            self.ingest_input(event);
        }
        for _ in 0..DRAIN_LIMIT {
            let Some(event) = self.output_rx.try_pop() else {
                break;
            };
            self.ingest_output(event);
        }
        self.join();
    }

    fn ingest_input(&mut self, event: InputEvent) {
        if self.sealed_ns.is_some() {
            return;
        }
        if event.epoch == self.epoch_id {
            self.trace.callback(
                CallbackRecord {
                    direction: Direction::Input,
                    seq: event.seq,
                    queue_start: event.queue_start,
                    count: event.count,
                    source: Some((event.source_start, event.source_count)),
                    begin: event.arrival_ns,
                    read: None,
                    end: None,
                    relative: None,
                    previous_delta: None,
                    gap: 0,
                    nonincreasing: false,
                    comparison: ClockComparison::Unverified,
                    missing: false,
                },
                event._cpal_callback,
            );
        }
        let end = event.queue_start.checked_add(event.count);
        let source_end = event.source_start.checked_add(event.source_count);
        if event.epoch != self.epoch_id
            || event.seq <= self.input_seq
            || event.queue_start < self.input_end
            || event.source_start < self.source_end
            || event.count > event.source_count
            || end.is_none()
            || source_end.is_none()
        {
            self.invalid_events += 1;
            return;
        }
        self.input_seq = event.seq;
        self.input_end = end.unwrap();
        self.source_end = source_end.unwrap();
        if event.count == 0 {
            return;
        }
        if self.inputs.len() == CAPACITY {
            self.inputs.pop_front();
            self.evictions += 1;
        }
        self.inputs.push_back(event);
    }
    fn ingest_output(&mut self, event: OutputEvent) {
        if self.sealed_ns.is_some() {
            return;
        }
        if event.epoch == self.epoch_id {
            self.trace.callback(
                CallbackRecord {
                    direction: Direction::Output,
                    seq: event.seq,
                    queue_start: event.queue_start,
                    count: event.count,
                    source: None,
                    begin: event.begin_ns,
                    read: Some(event.read_ns),
                    end: Some(event.end_ns),
                    relative: None,
                    previous_delta: None,
                    gap: 0,
                    nonincreasing: false,
                    comparison: ClockComparison::Unverified,
                    missing: false,
                },
                event._cpal_callback,
            );
        }
        let end = event.queue_start.checked_add(event.count);
        if event.epoch != self.epoch_id
            || event.seq <= self.output_seq
            || event.queue_start < self.output_end
            || event.begin_ns > event.read_ns
            || event.read_ns > event.end_ns
            || end.is_none()
        {
            self.invalid_events += 1;
            return;
        }
        self.output_seq = event.seq;
        self.output_end = end.unwrap();
        self.consumed_seen = self.consumed_seen.max(self.output_end);
        if event.count == 0 {
            return;
        }
        if self.outputs.len() == CAPACITY {
            self.outputs.pop_front();
            self.evictions += 1;
        }
        self.outputs.push_back(event);
    }

    fn join(&mut self) {
        // 各反復で片方の先頭範囲を消費するので最大2*CAPACITY回。
        while let (Some(input), Some(output)) =
            (self.inputs.front().copied(), self.outputs.front().copied())
        {
            let input_end = input.queue_start + input.count;
            let output_end = output.queue_start + output.count;
            if input_end <= output.queue_start {
                self.inputs.pop_front();
                continue;
            }
            if output_end <= input.queue_start {
                self.outputs.pop_front();
                continue;
            }
            let start = input.queue_start.max(output.queue_start);
            let end = input_end.min(output_end);
            let count = end - start;
            self.trace.segment(SegmentRecord {
                queue_start: start,
                count,
                source_start: input.source_start + (start - input.queue_start),
                input,
                output,
            });
            if input.arrival_ns <= output.read_ns {
                let index = ((output.read_ns - input.arrival_ns) / BUCKET_NS)
                    .min((BUCKETS - 1) as u64) as usize;
                self.histogram[index] += count;
                self.matched += count;
                if input.arrival_ns > output.begin_ns {
                    self.overlap += count;
                }
            } else {
                self.invalid_events += 1;
            }
            if end == input_end {
                self.inputs.pop_front();
            }
            if end == output_end {
                self.outputs.pop_front();
            } else if let Some(front) = self.outputs.front_mut() {
                front.queue_start = end;
                front.count = output_end - end;
            }
        }
    }

    /// 両callbackが終了してから呼ぶ。最大1024件ずつを有限回で最終回収する。
    pub fn seal(&mut self) {
        if self.sealed_ns.is_some() {
            return;
        }
        for _ in 0..CAPACITY / DRAIN_LIMIT {
            self.drain();
        }
        if let Some(c) = &mut self.cohort {
            c.seal();
        }
        self.inputs.clear();
        self.outputs.clear();
        self.sealed_ns = Some(elapsed_ns(self.origin));
    }
    fn quantile(&self, percent: u64) -> Option<QuantileRange> {
        if self.matched == 0 {
            return None;
        }
        let target = (u128::from(self.matched) * u128::from(percent)).div_ceil(100) as u64;
        let mut sum = 0;
        for (i, count) in self.histogram.iter().enumerate() {
            sum += count;
            if sum >= target {
                return Some(QuantileRange {
                    lower_ms: i as f64 * 0.1,
                    upper_ms: (i + 1 < BUCKETS).then_some((i + 1) as f64 * 0.1),
                });
            }
        }
        None
    }
    pub fn snapshot(&self) -> Snapshot {
        let consumed = self
            .shared
            .consumed
            .load(Ordering::Acquire)
            .max(self.consumed_seen);
        let cached_pending: u64 = self.outputs.iter().map(|event| event.count).sum();
        // RTの読出cursorはSPSCのdrainより先へ進む。末尾は未回収と欠落をまだ
        // 区別できないため保留し、後続eventの終端または停止sealで確定する。
        let unread_tail = if self.sealed_ns.is_none() {
            consumed.saturating_sub(self.consumed_seen)
        } else {
            0
        };
        let pending = cached_pending.saturating_add(unread_tail);
        let invalid = self.shared.invalid.load(Ordering::Acquire);
        Snapshot {
            epoch: self.epoch.clone(),
            supported: self.supported,
            sealed: self.sealed_ns.is_some(),
            counter_invalid: invalid,
            consumed_frames: consumed,
            matched_frames: self.matched,
            pending_frames: pending,
            unknown_frames: consumed
                .saturating_sub(self.matched)
                .saturating_sub(pending),
            coverage_percent: (consumed > 0 && !invalid)
                .then(|| self.matched as f64 / consumed as f64 * 100.0),
            p50: (!invalid).then(|| self.quantile(50)).flatten(),
            p95: (!invalid).then(|| self.quantile(95)).flatten(),
            histogram_resolution_ms: BUCKET_NS as f64 / 1_000_000.0,
            observation_ms: self.sealed_ns.unwrap_or_else(|| elapsed_ns(self.origin)) as f64
                / 1_000_000.0,
            input_metadata_dropped: self.shared.input_lost.load(Ordering::Relaxed),
            output_metadata_dropped: self.shared.output_lost.load(Ordering::Relaxed),
            invalid_events: self.invalid_events,
            pending_evictions: self.evictions,
            overlapping_callback_frames: self.overlap,
            asio_cycle_classification: "unknownUnverifiedClock".into(),
        }
    }

    /// 明示的なepoch付き読出しだけで固定上限の診断を作る。drainや条件変更をしない。
    pub fn trace(&self, expected_epoch: &str) -> Result<Trace, &'static str> {
        if expected_epoch != self.epoch {
            return Err("古い音声試行のtraceは取得できません");
        }
        if self.shared.invalid.load(Ordering::Acquire) {
            return Err("frame対応が失効しました。音声を開始し直して観測してください");
        }
        if !self.supported || self.batch_descriptor.is_some() {
            return Err("異なるレートの対応frame traceは未対応です");
        }
        let callbacks = self
            .trace
            .callbacks
            .iter()
            .map(|record| CallbackTrace {
                direction: record.direction,
                sequence: record.seq,
                queue_start: record.queue_start,
                count: record.count,
                source_start: record.source.map(|s| s.0),
                source_count: record.source.map(|s| s.1),
                begin_ns: record.begin,
                read_completed_ns: record.read,
                end_ns: record.end,
                cpal_relative_ns: record.relative.map(|n| n.to_string()),
                cpal_previous_delta_ns: record.previous_delta.map(|n| n.to_string()),
                sequence_gap: record.gap,
                nonincreasing_sequence: record.nonincreasing,
                cpal_duplicate: record.comparison == ClockComparison::EqualCallbackTimestamp,
                cpal_backward: record.comparison == ClockComparison::InputTimestampEarlier,
                cpal_missing: record.missing,
                cpal_comparison_unverified: record.comparison == ClockComparison::Unverified
                    || (record.comparison == ClockComparison::Missing && !record.missing),
            })
            .collect();
        let segments = self
            .trace
            .segments
            .iter()
            .map(|record| {
                let (comparison, delta) = cpal_comparison(
                    record.input._cpal_callback.as_ref(),
                    record.output._cpal_callback.as_ref(),
                );
                SegmentTrace {
                    queue_start: record.queue_start,
                    count: record.count,
                    source_start: record.source_start,
                    input_sequence: record.input.seq,
                    output_sequence: record.output.seq,
                    arrival_ns: record.input.arrival_ns,
                    output_begin_ns: record.output.begin_ns,
                    read_completed_ns: record.output.read_ns,
                    output_end_ns: record.output.end_ns,
                    valid_arrival_order: record.input.arrival_ns <= record.output.read_ns,
                    input_cpal_relative_ns: cpal_comparison(
                        record.input._cpal_callback.as_ref(),
                        self.trace.anchor.as_ref(),
                    )
                    .1
                    .map(|n| n.to_string()),
                    output_cpal_relative_ns: cpal_comparison(
                        record.output._cpal_callback.as_ref(),
                        self.trace.anchor.as_ref(),
                    )
                    .1
                    .map(|n| n.to_string()),
                    input_minus_output_cpal_ns: delta.map(|n| n.to_string()),
                    callback_timestamp_comparison: comparison,
                }
            })
            .collect();
        Ok(Trace {
            epoch: self.epoch.clone(),
            sealed: self.sealed_ns.is_some(),
            callback_capacity: TRACE_CAPACITY,
            segment_capacity: TRACE_CAPACITY,
            callback_evictions: self.trace.callback_evictions,
            segment_evictions: self.trace.segment_evictions,
            input_clock: self.trace.input.counters,
            output_clock: self.trace.output.counters,
            callbacks,
            segments,
            clock_interpretation: "callbackTimestampLabelsOnlyUnverifiedStreamOriginsAndFlags"
                .into(),
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn same_rate_end_boundary_is_separate_from_legacy_raw_read_quantiles() {
        let (mut observer, input, output) = Observer::new("direct-boundary".into(), 1, true);
        let (mut input, mut output) = (input.unwrap(), output.unwrap());
        input.record_span(8, 100_000);
        input.record_direct_emission(8, 6);
        input.record_span(4, 700_000);
        input.record_direct_emission(4, 4);
        observer.ingest_input(InputEvent {
            epoch: 1,
            seq: 1,
            source_start: 0,
            source_count: 8,
            queue_start: 0,
            count: 6,
            arrival_ns: 100_000,
            _cpal_callback: None,
        });
        observer.ingest_input(InputEvent {
            epoch: 1,
            seq: 2,
            source_start: 8,
            source_count: 4,
            queue_start: 6,
            count: 4,
            arrival_ns: 700_000,
            _cpal_callback: None,
        });
        for (seq, start, count, read, end) in [
            (1, 0, 4, 500_000, 2_000_000),
            (2, 4, 6, 1_000_000, 3_000_000),
        ] {
            observer.ingest_output(OutputEvent {
                epoch: 1,
                seq,
                queue_start: start,
                count,
                begin_ns: read - 1,
                read_ns: read,
                end_ns: end,
                _cpal_callback: None,
            });
            output.cohort.as_mut().unwrap().record(
                count as usize,
                (count + if seq == 1 { 2 } else { 0 }) as usize,
                end,
                true,
            );
        }
        observer.join();
        observer.seal();
        let raw = observer.raw_snapshot().unwrap();
        let end = observer.cohort_snapshot().unwrap();
        assert!((raw.p50.unwrap().lower_ms - 0.4).abs() < 1e-9);
        assert!((end.latest_arrival_to_end.p50.unwrap().lower_ms - 2.3).abs() < 1e-9);
        assert_eq!(
            (
                raw.matched_frames,
                end.matched_frames,
                end.zero_filled_frames
            ),
            (10, 10, 2)
        );
        assert!(observer.batch_snapshot().is_none());
        assert_eq!(end.mode, "sameRateInputToOutputBufferEnd");
    }

    #[test]
    fn cohort_full_rt_input_resample_queue_output_path_never_allocates_or_frees() {
        use crate::audio_engine::queue_diagnostics::{push_mapped_frames, read_complete_frames};
        use crate::audio_engine::resampling::StreamResampler;
        for (ir, or) in [(44100, 48000), (48000, 44100)] {
            let mut resampler = StreamResampler::new(ir, or, 2).unwrap();
            let (mut observer, input, output) =
                Observer::new_batch("rt-cohort-epoch".into(), 1, resampler.timing_descriptor());
            let (mut input, mut output) = (input.unwrap(), output.unwrap());
            let (mut producer, mut consumer) = HeapRb::new(1401).split();
            let data = vec![0.1; 2048];
            let mut out = vec![0.0; 256];
            let failed = AtomicBool::new(false);
            let notification = AtomicBool::new(false);
            let mut consumed_total = 0;
            let mut consumed_current = 0;
            let revision = observer.request_cohort_window().unwrap();
            assert_eq!(
                allocation_counts(|| {
                    for index in 0..64 {
                        if index == 17 {
                            assert!(output.complete_cohort_window(revision, true));
                        }
                        let frames = if index % 3 == 0 { 1024 } else { 128 };
                        let arrival = input.now_ns();
                        input.record_span(frames, arrival);
                        let (mut generated, mut accepted) = (0, 0);
                        let mut budget = None;
                        let mut prefix = AcceptedPrefix::default();
                        resampler.process_realtime_observed(
                            &data[..frames * 2],
                            |chunk, ordinal| {
                                let p = push_mapped_frames(&mut producer, chunk, 2, 2, &mut budget);
                                input.record_emission(ordinal, p.accepted);
                                prefix.record(p.offered, p.accepted);
                                generated += p.offered;
                                accepted += p.accepted;
                            },
                            &failed,
                            &notification,
                        );
                        assert!(prefix.valid());
                        input.record(generated, accepted, arrival, None);
                        let begin = output.now_ns();
                        let consumed = read_complete_frames(&mut consumer, &mut out, 2);
                        let read = output.now_ns();
                        output.record_context(consumed, 128, begin, read, None, index != 33);
                        consumed_total += consumed;
                        if index >= 34 {
                            consumed_current += consumed;
                        }
                    }
                }),
                (0, 0)
            );
            assert!(!failed.load(Ordering::Acquire));
            observer.seal();
            let s = observer.cohort_snapshot().unwrap();
            assert!(s.invalid_reasons.is_empty());
            assert_eq!(s.matched_frames, consumed_current as u64);
            assert_eq!(s.stream_consumed_frames, consumed_total as u64);
            assert_eq!(
                observer
                    .batch_snapshot()
                    .unwrap()
                    .observation
                    .matched_frames,
                consumed_total as u64
            );
        }
    }

    fn batch_observer() -> (Observer, InputRecorder, OutputRecorder) {
        let descriptor = crate::audio_engine::resampling::StreamResampler::new(44_100, 48_000, 2)
            .unwrap()
            .timing_descriptor();
        let (observer, input, output) = Observer::new_batch("batch:1".into(), 1, descriptor);
        (observer, input.unwrap(), output.unwrap())
    }

    #[test]
    fn batch_readiness_real_resampler_prefix_carry_wrap_and_zero_fill_are_bounded() {
        use crate::audio_engine::{
            queue_diagnostics::{push_mapped_frames, read_complete_frames},
            resampling::StreamResampler,
        };
        for (input_rate, output_rate) in [
            (44_100, 48_000),
            (48_000, 44_100),
            (48_000, 96_000),
            (96_000, 48_000),
        ] {
            for pattern in [
                &[128][..],
                &[512][..],
                &[1024][..],
                &[1, 127, 9413, 64, 1023][..],
            ] {
                let mut resampler = StreamResampler::new(input_rate, output_rate, 2).unwrap();
                let descriptor = resampler.timing_descriptor();
                let input_chunk_frames = descriptor.input_chunk_frames;
                let (mut observer, input, output) =
                    Observer::new_batch("batch:1".into(), 1, descriptor);
                let (mut input, mut output) = (input.unwrap(), output.unwrap());
                // 最小batchより小さい完全127frame＋端数1slotで、512でもdrop/wrapを確実に起こす。
                let (mut producer, mut consumer) = HeapRb::<f32>::new(127 * 2 + 1).split();
                let mut out = [0.0; 1024];
                let mut total_generated = 0;
                let mut total_accepted = 0;
                let mut total_consumed = 0;
                let mut zero_emit = false;
                let mut multi_emit = false;
                for callback in 0..32 {
                    let frames = pattern[callback % pattern.len()];
                    let samples = vec![0.125; frames * 2];
                    let (mut generated, mut accepted, mut emits) = (0, 0, 0);
                    let mut consumed = 0;
                    let mut budget = None;
                    let mut prefix = AcceptedPrefix::default();
                    assert_eq!(
                        allocation_counts(|| {
                            resampler
                                .process_into(&samples, |chunk| {
                                    let pushed =
                                        push_mapped_frames(&mut producer, chunk, 2, 2, &mut budget);
                                    prefix.record(pushed.offered, pushed.accepted);
                                    generated += pushed.offered;
                                    accepted += pushed.accepted;
                                    emits += 1;
                                })
                                .unwrap();
                            assert!(prefix.valid());
                            input.record(generated, accepted, 0, None);
                            consumed = read_complete_frames(&mut consumer, &mut out, 2);
                            output.record(consumed, 0, 0, None);
                            total_consumed += consumed;
                        }),
                        (0, 0)
                    );
                    zero_emit |= emits == 0;
                    multi_emit |= emits > 1;
                    total_generated += generated;
                    total_accepted += accepted;
                    assert_eq!(input.source, total_generated as u64);
                    assert_eq!(input.queue, total_accepted as u64);
                    assert!(out.iter().all(|s| s.is_finite()));
                    assert!(out[consumed * 2..].iter().all(|&s| s == 0.0));
                    observer.drain();
                    assert_eq!(observer.input_seq, callback as u64 + 1);
                    assert_accounting(&observer.snapshot());
                }
                if pattern[0] < input_chunk_frames {
                    assert!(zero_emit);
                }
                if pattern
                    .iter()
                    .any(|&frames| frames >= 2 * input_chunk_frames)
                {
                    assert!(multi_emit);
                }
                assert!(
                    total_generated > total_accepted,
                    "満杯で生成sourceに穴が残る"
                );
                drop(input);
                drop(output);
                observer.seal();
                let batch = observer.batch_snapshot().unwrap();
                assert_eq!(batch.mode, BatchMode::CallbackBatchReadiness);
                assert_eq!(batch.declared_resampler.input_rate_hz, input_rate);
                assert_eq!(batch.observation.matched_frames, total_consumed as u64);
                assert_eq!(batch.observation.unknown_frames, 0);
                assert!(observer.raw_snapshot().is_none());
                assert!(observer.trace("batch:1").is_err());
                let sealed = serde_json::to_string(&batch).unwrap();
                observer.drain();
                observer.seal();
                assert_eq!(
                    sealed,
                    serde_json::to_string(&observer.batch_snapshot().unwrap()).unwrap()
                );
            }
        }
    }

    #[test]
    fn batch_readiness_uses_ready_callback_not_earlier_carry_or_declared_delay() {
        let (mut observer, _, _) = batch_observer();
        // 初回callbackはcarryを溜めるだけ。2回目に2batch揃った想定の単一prefix。
        observer.ingest_input(input(1, 0, 0, 0, 0));
        let mut ready = input(2, 0, 0, 6, 20_000_000);
        ready.source_count = 10; // 生成10、受入6。原入力の数とは比較しない。
        observer.ingest_output(output(1, 0, 6, 20_900_000, 21_050_000));
        observer.join();
        assert_eq!(observer.snapshot().pending_frames, 6);
        observer.ingest_input(ready);
        observer.join();
        let batch = observer.batch_snapshot().unwrap();
        assert_eq!(batch.observation.p50.unwrap().lower_ms, 1.0);
        assert_eq!(batch.observation.matched_frames, 6);
        // 20msの過去入力蓄積待ちも申告filter delayも分布へ混ぜない。
        assert!(batch.declared_resampler.declared_output_delay_frames > 0);
        observer.ingest_input(input(3, 10, 6, 2, 22_000_000));
        observer.ingest_output(output(2, 6, 2, 22_900_000, 23_050_000));
        observer.join();
        assert_eq!(observer.trace.segments.back().unwrap().source_start, 10);
        assert_eq!(observer.snapshot().matched_frames, 8);
    }

    #[test]
    fn batch_readiness_prefix_failure_and_recovery_invalidate_without_rt_allocation() {
        let (mut observer, input, output) = batch_observer();
        let mut prefix = AcceptedPrefix::default();
        assert_eq!(
            allocation_counts(|| {
                prefix.record(10, 6);
                prefix.record(10, 0);
                assert!(prefix.valid());
                prefix.record(10, 1); // consumerの進行を理由に後続emitを受けたら単一prefixではない。
                assert!(!prefix.valid());
                input.invalidate();
                output.invalidate_recovery();
                drop(input);
                drop(output);
            }),
            (0, 0)
        );
        assert!(
            observer
                .batch_snapshot()
                .unwrap()
                .observation
                .counter_invalid
        );
        assert!(observer.batch_snapshot().unwrap().observation.p50.is_none());
        observer.seal();
        let fresh = batch_observer().0;
        assert!(!fresh.batch_snapshot().unwrap().observation.counter_invalid);
        assert_eq!(fresh.snapshot().consumed_frames, 0);
    }

    #[test]
    fn batch_readiness_missing_metadata_and_epoch_mismatch_stay_unknown() {
        let (mut observer, mut input, mut output) = batch_observer();
        for _ in 0..CAPACITY + 1 {
            input.record(10, 1, 0, None);
            output.record(1, 0, 0, None);
        }
        for _ in 0..CAPACITY / DRAIN_LIMIT {
            observer.drain();
        }
        input.record(10, 1, 0, None);
        output.record(1, 0, 0, None);
        observer.drain();
        let mut stale = self::input(CAPACITY as u64 + 3, 0, 0, 1, 0);
        stale.epoch = 99;
        observer.ingest_input(stale);
        drop(input);
        drop(output);
        observer.seal();
        let snapshot = observer.batch_snapshot().unwrap().observation;
        assert_eq!(snapshot.input_metadata_dropped, 1);
        assert_eq!(snapshot.output_metadata_dropped, 1);
        assert_eq!(snapshot.unknown_frames, 1);
        assert_eq!(snapshot.pending_frames, 0);
        assert_eq!(snapshot.invalid_events, 1);
        assert_accounting(&snapshot);
    }

    #[test]
    fn recovery_invalidation_is_allocation_free_and_seal_is_immutable() {
        let (mut observer, input, output) = super::Observer::new("recovery".into(), 1, true);
        let output = output.unwrap();
        assert_eq!(
            crate::dsp_verification_allocator::allocation_counts(|| output.invalidate_recovery()),
            (0, 0)
        );
        assert!(observer.snapshot().counter_invalid);
        assert!(observer.snapshot().p50.is_none());
        assert!(observer.snapshot().coverage_percent.is_none());
        assert!(observer.trace("recovery").is_err());
        drop(input);
        drop(output);
        observer.seal();
        let fixed = serde_json::to_string(&observer.snapshot()).unwrap();
        observer.drain();
        observer.seal();
        assert_eq!(fixed, serde_json::to_string(&observer.snapshot()).unwrap());
    }

    use super::*;
    use crate::vst_host::instance::allocation_counts;

    #[test]
    fn trace_public_clock_comparison_is_signed_and_does_not_invent_cpal_instants() {
        let distance = |later: &u64, earlier: &u64| Some(u128::from(later - earlier));
        for (left, right, comparison, delta) in [
            (
                Some(10),
                Some(10),
                ClockComparison::EqualCallbackTimestamp,
                Some(0),
            ),
            (
                Some(8),
                Some(10),
                ClockComparison::InputTimestampEarlier,
                Some(-2),
            ),
            (
                Some(12),
                Some(10),
                ClockComparison::InputTimestampLater,
                Some(2),
            ),
            (None, Some(10), ClockComparison::Missing, None),
        ] {
            assert_eq!(
                compare_clock(left.as_ref(), right.as_ref(), distance),
                (comparison, delta)
            );
        }
        assert_eq!(
            compare_clock(Some(&1_u64), Some(&2), |_, _| Some(u128::MAX)),
            (ClockComparison::Unverified, None)
        );
        let mut sequence = 0;
        let mut counters = ClockCounters::default();
        ClockState::observe(
            &mut sequence,
            &mut counters,
            1,
            Some(&10_u64),
            None,
            distance,
        );
        ClockState::observe(
            &mut sequence,
            &mut counters,
            3,
            Some(&10_u64),
            Some(&10),
            distance,
        );
        ClockState::observe(
            &mut sequence,
            &mut counters,
            4,
            Some(&9_u64),
            Some(&10),
            distance,
        );
        ClockState::observe(
            &mut sequence,
            &mut counters,
            4,
            None,
            Some(&9_u64),
            distance,
        );
        assert_eq!(
            (
                counters.missing,
                counters.duplicate,
                counters.backward,
                counters.sequence_gaps,
                counters.nonincreasing_sequence
            ),
            (1, 1, 1, 1, 1)
        );
    }

    #[test]
    fn trace_retains_latest_callback_times_including_zero_count_without_changing_histogram() {
        let mut o = observer();
        for n in 1..=80 {
            o.ingest_input(input(n, 0, 0, 0, n * 2));
            o.ingest_output(output(n, 0, 0, n * 2 + 1, n * 2 + 2));
        }
        let trace = o.trace("engine:queue:1").unwrap();
        assert_eq!(
            (
                trace.callbacks.len(),
                trace.callback_evictions,
                trace.segments.len()
            ),
            (64, 96, 0)
        );
        assert!(trace
            .callbacks
            .windows(2)
            .all(|pair| pair[0].begin_ns <= pair[1].begin_ns));
        assert_eq!(
            trace
                .callbacks
                .iter()
                .filter(|r| r.direction == Direction::Input)
                .count(),
            32
        );
        assert!(trace.callbacks.iter().all(|record| record.count == 0
            && record.cpal_missing
            && record.cpal_relative_ns.is_none()));
        assert_eq!(
            (trace.input_clock.missing, trace.output_clock.missing),
            (80, 80)
        );
        assert_eq!(
            (
                o.snapshot().matched_frames,
                o.snapshot().unknown_frames,
                o.snapshot().pending_evictions
            ),
            (0, 0, 0)
        );
    }

    #[test]
    fn trace_segment_cap_evictions_do_not_change_coverage_and_seal_is_frozen() {
        let (mut o, input, output) = Observer::new("epoch".into(), 1, true);
        let (mut input, mut output) = (input.unwrap(), output.unwrap());
        for _ in 0..80 {
            input.record(1, 1, 0, None);
            output.record(1, 0, 0, None);
            o.drain();
        }
        let trace = o.trace("epoch").unwrap();
        assert_eq!((trace.segments.len(), trace.segment_evictions), (64, 16));
        assert_eq!(
            (
                trace.segments[0].queue_start,
                trace.segments[0].source_start
            ),
            (16, 16)
        );
        assert_eq!(trace.segments.last().unwrap().queue_start, 79);
        assert!(trace
            .segments
            .iter()
            .all(|segment| segment.callback_timestamp_comparison == ClockComparison::Missing));
        let stats = o.snapshot();
        assert_eq!(
            (
                stats.matched_frames,
                stats.unknown_frames,
                stats.input_metadata_dropped,
                stats.output_metadata_dropped,
                stats.pending_evictions
            ),
            (80, 0, 0, 0, 0)
        );
        drop(input);
        drop(output);
        o.seal();
        let frozen = serde_json::to_value(o.trace("epoch").unwrap()).unwrap();
        o.drain();
        o.ingest_input(super::tests::input(99, 99, 99, 0, 999));
        assert_eq!(
            serde_json::to_value(o.trace("epoch").unwrap()).unwrap(),
            frozen
        );
        assert!(o.trace("old").is_err());
        let next = Observer::new("new".into(), 2, true).0;
        assert!(next.trace("epoch").is_err());
        assert!(next.trace("new").unwrap().callbacks.is_empty());
        assert!(Observer::new("differentRates".into(), 3, false)
            .0
            .trace("differentRates")
            .is_err());
    }

    #[test]
    fn trace_read_is_pure_and_does_not_drain_queued_events_or_change_aggregate_schema() {
        let (o, input, output) = Observer::new("epoch".into(), 1, true);
        let (mut input, mut output) = (input.unwrap(), output.unwrap());
        input.record(2, 2, 0, None);
        output.record(2, 0, 0, None);
        assert!(o.trace("epoch").unwrap().callbacks.is_empty());
        assert!(o.trace("epoch").unwrap().segments.is_empty());
        let s = o.snapshot();
        assert_eq!(
            (
                s.consumed_frames,
                s.matched_frames,
                s.pending_frames,
                s.unknown_frames
            ),
            (2, 0, 2, 0)
        );
        let json = serde_json::to_value(s).unwrap();
        assert!(json.get("callbacks").is_none() && json.get("segments").is_none());
    }

    fn observer() -> Observer {
        Observer::new("engine:queue:1".into(), 1, true).0
    }
    fn assert_accounting(s: &Snapshot) {
        assert_eq!(
            s.matched_frames + s.pending_frames + s.unknown_frames,
            s.consumed_frames
        );
    }
    #[test]
    fn unread_output_metadata_is_pending_until_drain_matches_it() {
        let (mut o, input, output) = Observer::new("epoch".into(), 1, true);
        let (mut input, mut output) = (input.unwrap(), output.unwrap());
        input.record(7, 5, 0, None);
        output.record(5, 0, 0, None);
        let before = o.snapshot();
        assert_eq!(
            (
                before.matched_frames,
                before.pending_frames,
                before.unknown_frames
            ),
            (0, 5, 0)
        );
        assert_accounting(&before);
        o.drain();
        let after = o.snapshot();
        assert_eq!(
            (
                after.matched_frames,
                after.pending_frames,
                after.unknown_frames
            ),
            (5, 0, 0)
        );
        assert_accounting(&after);
        assert_eq!(
            (after.input_metadata_dropped, after.output_metadata_dropped),
            (0, 0)
        );
    }
    #[test]
    fn lost_middle_output_metadata_becomes_unknown_when_later_end_is_received() {
        let (mut o, input, output) = Observer::new("epoch".into(), 1, true);
        let (mut input, mut output) = (input.unwrap(), output.unwrap());
        input.record(CAPACITY + 2, CAPACITY + 2, 0, None);
        for _ in 0..CAPACITY + 1 {
            output.record(1, 0, 0, None);
        }
        for _ in 0..CAPACITY / DRAIN_LIMIT {
            o.drain();
        }
        let tail = o.snapshot();
        assert_eq!(
            (
                tail.matched_frames,
                tail.pending_frames,
                tail.unknown_frames
            ),
            (CAPACITY as u64, 1, 0)
        );
        assert_eq!(tail.output_metadata_dropped, 1);
        assert_accounting(&tail);
        output.record(1, 0, 0, None);
        o.drain();
        let resolved = o.snapshot();
        assert_eq!(
            (
                resolved.matched_frames,
                resolved.pending_frames,
                resolved.unknown_frames
            ),
            ((CAPACITY + 1) as u64, 0, 1)
        );
        assert_accounting(&resolved);
        drop(input);
        drop(output);
        o.seal();
        let sealed = o.snapshot();
        assert_eq!((sealed.pending_frames, sealed.unknown_frames), (0, 1));
        assert_accounting(&sealed);
    }
    #[test]
    fn lost_tail_output_metadata_stays_pending_until_stop_finalizes_it_as_unknown() {
        let (mut o, input, output) = Observer::new("epoch".into(), 1, true);
        let (mut input, mut output) = (input.unwrap(), output.unwrap());
        input.record(CAPACITY + 1, CAPACITY + 1, 0, None);
        for _ in 0..CAPACITY + 1 {
            output.record(1, 0, 0, None);
        }
        for _ in 0..CAPACITY / DRAIN_LIMIT {
            o.drain();
        }
        let active = o.snapshot();
        assert_eq!((active.pending_frames, active.unknown_frames), (1, 0));
        assert_accounting(&active);
        drop(input);
        drop(output);
        o.seal();
        let sealed = o.snapshot();
        assert_eq!(
            (
                sealed.matched_frames,
                sealed.pending_frames,
                sealed.unknown_frames
            ),
            (CAPACITY as u64, 0, 1)
        );
        assert_accounting(&sealed);
        assert!(sealed.coverage_percent.unwrap() < 100.0);
    }
    fn input(seq: u64, source: u64, start: u64, count: u64, arrival: u64) -> InputEvent {
        InputEvent {
            epoch: 1,
            seq,
            source_start: source,
            source_count: count,
            queue_start: start,
            count,
            arrival_ns: arrival,
            _cpal_callback: None,
        }
    }
    fn output(seq: u64, start: u64, count: u64, begin: u64, read: u64) -> OutputEvent {
        OutputEvent {
            epoch: 1,
            seq,
            queue_start: start,
            count,
            begin_ns: begin,
            read_ns: read,
            end_ns: read + 1,
            _cpal_callback: None,
        }
    }
    #[test]
    fn weighted_histogram_joins_split_frames_instead_of_callback_counts() {
        let mut o = observer();
        o.ingest_input(input(1, 0, 0, 1, 0));
        o.ingest_input(input(2, 1, 1, 99, 0));
        o.ingest_output(output(1, 0, 1, 100_000, 150_000));
        o.ingest_output(output(2, 1, 50, 900_000, 1_050_000));
        o.ingest_output(output(3, 51, 49, 900_000, 1_050_000));
        o.join();
        let s = o.snapshot();
        assert_eq!(
            (
                s.consumed_frames,
                s.matched_frames,
                s.pending_frames,
                s.unknown_frames
            ),
            (100, 100, 0, 0)
        );
        assert_eq!(s.p50.unwrap().lower_ms, 1.0);
        assert_eq!(s.p95.unwrap().upper_ms, Some(1.1));
    }
    #[test]
    fn output_first_and_arrival_during_callback_are_valid_and_source_drop_holes_survive() {
        let mut o = observer();
        o.ingest_output(output(1, 0, 4, 100, 300));
        o.join();
        assert_eq!(o.snapshot().pending_frames, 4);
        let mut first = input(1, 0, 0, 2, 200);
        first.source_count = 100; // 末尾98frameを音声の満杯方針で破棄。
        o.ingest_input(first);
        o.ingest_input(input(2, 100, 2, 2, 210));
        o.join();
        let s = o.snapshot();
        assert_eq!(
            (
                s.matched_frames,
                s.overlapping_callback_frames,
                s.unknown_frames
            ),
            (4, 4, 0)
        );
        assert_eq!(s.invalid_events, 0);
    }
    #[test]
    fn both_metadata_overflows_leave_unknown_frames_and_next_absolute_range_resynchronizes() {
        let (mut o, i, p) = Observer::new("epoch".into(), 1, true);
        let (mut i, mut p) = (i.unwrap(), p.unwrap());
        for _ in 0..CAPACITY + 1 {
            i.record(1, 1, 0, None);
            p.record(1, 0, 0, None);
        }
        o.drain();
        assert_eq!(o.input_seq, DRAIN_LIMIT as u64);
        assert_eq!(o.output_seq, DRAIN_LIMIT as u64);
        for _ in 0..3 {
            o.drain();
        }
        i.record(1, 1, 0, None);
        p.record(1, 0, 0, None);
        o.drain();
        o.seal();
        let s = o.snapshot();
        assert_eq!(s.input_metadata_dropped, 1);
        assert_eq!(s.output_metadata_dropped, 1);
        assert_eq!(s.consumed_frames, (CAPACITY + 2) as u64);
        assert_eq!(s.matched_frames, (CAPACITY + 1) as u64);
        assert_eq!(s.unknown_frames, 1);
        assert!(s.coverage_percent.unwrap() < 100.0);
    }
    #[test]
    fn metadata_gaps_bad_times_epochs_and_bounded_pending_never_invent_zero_latency() {
        let mut o = observer();
        let mut old = input(1, 0, 0, 1, 0);
        old.epoch = 9;
        o.ingest_input(old);
        o.ingest_input(input(2, 1, 1, 1, 200));
        o.ingest_output(output(1, 0, 2, 0, 100));
        o.join(); // queue0欠測、queue1は読出しより後の到着で不正。
        let s = o.snapshot();
        assert_eq!((s.matched_frames, s.unknown_frames), (0, 2));
        assert_eq!(s.invalid_events, 2);
        assert!(s.p50.is_none());
        for n in 2..CAPACITY as u64 + 3 {
            o.ingest_output(output(n, n, 1, 0, 100));
        }
        assert_eq!(o.outputs.len(), CAPACITY);
        assert!(o.evictions > 0);
        o.seal();
        assert_eq!(o.snapshot().pending_frames, 0);
    }
    #[test]
    fn stop_seals_pending_but_not_unconsumed_input_and_new_epoch_is_empty() {
        let mut o = observer();
        o.ingest_output(output(1, 0, 2, 0, 10));
        o.seal();
        let sealed = o.snapshot();
        o.seal();
        assert_eq!(o.snapshot().observation_ms, sealed.observation_ms);
        assert_eq!(
            (
                sealed.consumed_frames,
                sealed.unknown_frames,
                sealed.pending_frames
            ),
            (2, 2, 0)
        );
        let mut fresh = Observer::new("next".into(), 2, true).0;
        fresh.ingest_input(input(1, 0, 0, 2, 0));
        assert_eq!(fresh.invalid_events, 1);
        assert_eq!(fresh.snapshot().consumed_frames, 0);
        assert!(fresh.snapshot().coverage_percent.is_none());
        let (unsupported, i, p) = Observer::new("differentRates".into(), 3, false);
        assert!(!unsupported.snapshot().supported);
        assert!(i.is_none() && p.is_none());
    }
    #[test]
    fn rt_events_and_handle_destruction_do_not_allocate_free_or_drop_last_owner() {
        eprintln!("frame timing layout: input={} output={} observer={} shared={} inputRecorder={} outputRecorder={}", std::mem::size_of::<InputEvent>(), std::mem::size_of::<OutputEvent>(), std::mem::size_of::<Observer>(), std::mem::size_of::<Shared>(), std::mem::size_of::<InputRecorder>(), std::mem::size_of::<OutputRecorder>());
        assert!(std::mem::size_of::<InputEvent>() <= 96);
        assert!(std::mem::size_of::<OutputEvent>() <= 96);
        let (mut o, i, p) = Observer::new("epoch".into(), 1, true);
        eprintln!("frame timing storage: ringHeader={} ringAlignment={} tx={} rx={} pendingInput={} pendingOutput={} histogramLen={} histogramBytes={} snapshot={}", std::mem::size_of::<HeapRb<InputEvent>>(), std::mem::align_of::<HeapRb<InputEvent>>(), std::mem::size_of::<Tx<InputEvent>>(), std::mem::size_of::<Rx<InputEvent>>(), o.inputs.capacity(), o.outputs.capacity(), o.histogram.len(), std::mem::size_of_val(&*o.histogram), std::mem::size_of::<Snapshot>());
        eprintln!("frame trace storage: traceState={} callbackRecord={} segmentRecord={} callbackTrace={} segmentTrace={} trace={} callbackCapacity={} segmentCapacity={}", std::mem::size_of::<TraceState>(), std::mem::size_of::<CallbackRecord>(), std::mem::size_of::<SegmentRecord>(), std::mem::size_of::<CallbackTrace>(), std::mem::size_of::<SegmentTrace>(), std::mem::size_of::<Trace>(), o.trace.callbacks.capacity(), o.trace.segments.capacity());
        let (mut i, mut p) = (i.unwrap(), p.unwrap());
        assert_eq!(
            allocation_counts(|| {
                for _ in 0..CAPACITY + 2 {
                    let arrival = i.now_ns();
                    i.record(2, 1, arrival, None);
                    let begin = p.now_ns();
                    let read = p.now_ns();
                    p.record(1, begin, read, None);
                }
                drop(i);
                drop(p);
            }),
            (0, 0)
        );
        o.seal();
        assert_eq!(o.snapshot().unknown_frames, 2);
    }
    #[test]
    fn cumulative_tail_bucket_has_no_false_upper_bound_and_cursor_overflow_disables_observation() {
        let mut o = observer();
        o.ingest_input(input(1, 0, 0, 1, 0));
        o.ingest_output(output(1, 0, 1, 0, 2_000_000_000));
        o.join();
        assert!(o.snapshot().p50.unwrap().upper_ms.is_none());
        let (o, i, _) = Observer::new("epoch".into(), 1, true);
        let mut i = i.unwrap();
        i.source = u64::MAX;
        i.record(1, 1, 0, None);
        assert!(o.snapshot().counter_invalid);
        assert!(o.snapshot().p50.is_none());
    }
    #[test]
    fn real_ring_partial_publish_wrap_and_prefix_drop_preserve_frame_correspondence() {
        use crate::audio_engine::queue_diagnostics::{push_mapped_frames, read_complete_frames};
        for ch in [1, 2, 22] {
            let (mut producer, mut consumer) =
                HeapRb::<f32>::new(ch * 3 + usize::from(ch > 1)).split();
            let (mut o, i, p) = Observer::new("epoch".into(), 1, true);
            let (mut i, mut p) = (i.unwrap(), p.unwrap());
            let samples = vec![0.25; 5];
            let mut out = vec![0.0; ch * 2];
            for _ in 0..8 {
                let pushed = push_mapped_frames(&mut producer, &samples, 1, ch, &mut None);
                let consumed = read_complete_frames(&mut consumer, &mut out, ch);
                p.record(consumed, 0, 0, None); // 音声pop後、input metadataより先に公開。
                o.drain();
                i.record(5, pushed.accepted, 0, None);
                o.drain();
            }
            o.seal();
            let s = o.snapshot();
            assert_eq!(
                (s.consumed_frames, s.matched_frames, s.unknown_frames),
                (16, 16, 0)
            );
            assert!(s.matched_frames < i.source);
            if ch > 1 {
                let (mut producer, mut consumer) = HeapRb::<f32>::new(ch + 1).split();
                producer.try_push(1.0).unwrap();
                assert_eq!(read_complete_frames(&mut consumer, &mut out, ch), 0);
                for _ in 1..ch {
                    producer.try_push(2.0).unwrap();
                }
                assert_eq!(read_complete_frames(&mut consumer, &mut out, ch), 1);
            }
        }
    }
    #[test]
    fn post_pop_observation_occurs_once_without_rt_allocation_and_preserves_zero_fill() {
        use crate::audio_engine::queue_diagnostics::read_complete_frames_observed;
        let (mut producer, mut consumer) = HeapRb::<f32>::new(8).split();
        producer.try_push(0.25).unwrap();
        producer.try_push(0.75).unwrap();
        let mut out = [9.0; 8];
        let mut observed = 0;
        assert_eq!(
            allocation_counts(|| {
                let (frames, stamp) =
                    read_complete_frames_observed(&mut consumer, &mut out, 2, || {
                        observed += 1;
                        123_u64
                    });
                assert_eq!((frames, stamp), (1, 123));
            }),
            (0, 0)
        );
        assert_eq!(observed, 1);
        assert_eq!(out, [0.25, 0.75, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    }
}
