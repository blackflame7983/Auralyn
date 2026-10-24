//! 入力cohortの処理ordinalと通常mic出力slotの受渡し。信号点対応は測らない。
use super::{QuantileRange, BUCKETS, BUCKET_NS, CAPACITY, DRAIN_LIMIT};
use crate::audio_engine::resampling::{CohortEmission, CohortGeometry};
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapRb,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
const WORK: usize = 2048;
type Tx<T> = <HeapRb<T> as Split>::Prod;
type Rx<T> = <HeapRb<T> as Split>::Cons;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InvalidReason {
    GeometryMismatch,
    InputMetadataGap,
    OutputMetadataGap,
    PendingCapacity,
    CounterOverflow,
    TimestampOrder,
    RecoverySkip,
    OrdinalMismatch,
    NonMicOutput,
    ConditionsChanged,
}
impl InvalidReason {
    fn bit(self) -> u64 {
        1 << self as u8
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArrivalRange {
    pub p50: Option<QuantileRange>,
    pub p95: Option<QuantileRange>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: u8,
    pub window_id: String,
    pub requested_revision: String,
    pub completed_revision: String,
    /// RTメッセージ受理・状態反映。平滑化やVST内部完了ではない。
    pub applied_revision: String,
    pub rejected_revision: Option<String>,
    pub normal_mic_output: bool,
    pub stream_consumed_frames: u64,
    pub epoch: String,
    pub mode: String,
    pub status: String,
    pub signal_correspondence: String,
    pub geometry: Option<CohortGeometry>,
    pub received_input_frames: u64,
    pub cohort_input_frames: u64,
    pub unemitted_input_frames: Option<u64>,
    pub consumed_frames: u64,
    pub matched_frames: u64,
    pub pending_frames: u64,
    pub unknown_frames: u64,
    pub zero_filled_frames: u64,
    pub coverage_percent: Option<f64>,
    pub earliest_arrival_to_end: ArrivalRange,
    pub latest_arrival_to_end: ArrivalRange,
    pub invalid_reasons: Vec<InvalidReason>,
}
#[derive(Default)]
struct Shared {
    invalid: AtomicU64,
    consumed: AtomicU64,
    requested: AtomicU64,
    requested_revision: AtomicU64,
    window_serial: AtomicU64,
}
impl Shared {
    fn invalidate(&self, reason: InvalidReason) {
        self.invalid.fetch_or(reason.bit(), Ordering::Release);
    }
}
#[derive(Clone, Copy)]
struct Span {
    start: u64,
    count: u64,
    arrival: u64,
}
#[derive(Clone, Copy)]
struct Emit {
    ordinal: CohortEmission,
    accepted: u64,
    queue: u64,
}
#[derive(Clone, Copy)]
enum InputKind {
    Span(Span),
    Emit(Emit),
}
#[derive(Clone, Copy)]
struct InputEvent {
    seq: u64,
    kind: InputKind,
}
#[derive(Clone, Copy, Default)]
struct Window {
    serial: u64,
    completed: u64,
    applied: u64,
    rejected: Option<u64>,
    normal: bool,
}
#[derive(Clone, Copy)]
struct OutputEvent {
    window: Window,
    requested: u64,
    accounted: bool,
    seq: u64,
    queue: u64,
    count: u64,
    end: u64,
}
#[derive(Clone, Copy)]
struct Segment {
    queue: u64,
    count: u64,
    earliest: u64,
    latest: u64,
}
struct Progress {
    emit: Emit,
    input_done: u64,
    unit_done: u64,
    output_done: u64,
    earliest: u64,
    latest: u64,
}
pub struct Input {
    tx: Tx<InputEvent>,
    shared: Arc<Shared>,
    seq: u64,
    source: u64,
    queue: u64,
    generated: u64,
}
pub struct Output {
    window: Window,
    tx: Tx<OutputEvent>,
    shared: Arc<Shared>,
    seq: u64,
    queue: u64,
    requested: u64,
}
impl Input {
    pub fn invalidate(&self, reason: InvalidReason) {
        self.shared.invalidate(reason);
    }
    fn push(&mut self, kind: InputKind) {
        let Some(seq) = self.seq.checked_add(1) else {
            self.shared.invalidate(InvalidReason::CounterOverflow);
            return;
        };
        self.seq = seq;
        if self.tx.try_push(InputEvent { seq, kind }).is_err() {
            self.shared.invalidate(InvalidReason::InputMetadataGap);
        }
    }
    pub fn span(&mut self, frames: usize, arrival: u64) {
        if self.shared.invalid.load(Ordering::Acquire) != 0 {
            return;
        }
        let Some(end) = self.source.checked_add(frames as u64) else {
            self.shared.invalidate(InvalidReason::CounterOverflow);
            return;
        };
        self.push(InputKind::Span(Span {
            start: self.source,
            count: frames as u64,
            arrival,
        }));
        self.source = end;
    }
    pub fn direct_emit(&mut self, frames: usize, accepted: usize) {
        let Some(start) = self.source.checked_sub(frames as u64) else {
            self.invalidate(InvalidReason::OrdinalMismatch);
            return;
        };
        self.emit(
            Some(CohortEmission {
                input_start: start,
                input_count: frames as u64,
                output_start: self.generated,
                output_count: frames as u64,
            }),
            accepted,
        );
    }
    pub fn emit(&mut self, ordinal: Option<CohortEmission>, accepted: usize) {
        if self.shared.invalid.load(Ordering::Acquire) != 0 {
            return;
        }
        let Some(ordinal) = ordinal else {
            self.shared.invalidate(InvalidReason::GeometryMismatch);
            return;
        };
        let accepted = accepted as u64;
        if ordinal.output_start != self.generated || accepted > ordinal.output_count {
            self.shared.invalidate(InvalidReason::OrdinalMismatch);
            return;
        }
        let Some(end) = self.queue.checked_add(accepted) else {
            self.shared.invalidate(InvalidReason::CounterOverflow);
            return;
        };
        let Some(generated) = self.generated.checked_add(ordinal.output_count) else {
            self.shared.invalidate(InvalidReason::CounterOverflow);
            return;
        };
        self.push(InputKind::Emit(Emit {
            ordinal,
            accepted,
            queue: self.queue,
        }));
        self.queue = end;
        self.generated = generated;
    }
}
impl Output {
    fn advance_window(&mut self) {
        if let Some(serial) = self.window.serial.checked_add(1) {
            self.window.serial = serial;
        } else {
            self.invalidate(InvalidReason::CounterOverflow);
        }
    }
    pub fn complete_window(&mut self, revision: u64, applied: bool) -> bool {
        if self.shared.invalid.load(Ordering::Acquire) != 0
            || revision <= self.window.completed
            || revision > self.shared.requested_revision.load(Ordering::Acquire)
        {
            return false;
        }
        self.window.completed = revision;
        if applied {
            self.window.applied = revision;
            self.window.rejected = None;
        } else {
            self.window.rejected = Some(revision);
        }
        self.advance_window();
        true
    }
    pub fn invalidate(&self, reason: InvalidReason) {
        self.shared.invalidate(reason);
    }
    pub fn record(&mut self, consumed: usize, requested: usize, end: u64, normal_mic: bool) {
        let Some(queue) = self.queue.checked_add(consumed as u64) else {
            self.invalidate(InvalidReason::CounterOverflow);
            return;
        };
        let Some(total) = self.requested.checked_add(requested as u64) else {
            self.invalidate(InvalidReason::CounterOverflow);
            return;
        };
        self.shared.consumed.store(queue, Ordering::Release);
        self.shared.requested.store(total, Ordering::Release);
        if consumed > requested {
            self.invalidate(InvalidReason::OrdinalMismatch);
        }
        if self.window.serial == 0 || self.window.normal != normal_mic {
            self.window.normal = normal_mic;
            self.advance_window();
        }
        self.shared
            .window_serial
            .store(self.window.serial, Ordering::Release);
        if self.shared.invalid.load(Ordering::Acquire) == 0 {
            if let Some(seq) = self.seq.checked_add(1) {
                self.seq = seq;
                if self
                    .tx
                    .try_push(OutputEvent {
                        window: self.window,
                        requested: requested as u64,
                        accounted: false,
                        seq,
                        queue: self.queue,
                        count: consumed as u64,
                        end,
                    })
                    .is_err()
                {
                    self.invalidate(InvalidReason::OutputMetadataGap);
                }
            } else {
                self.invalidate(InvalidReason::CounterOverflow);
            }
        }
        self.queue = queue;
        self.requested = total;
    }
}
pub struct Observer {
    window: Window,
    window_consumed: u64,
    window_zero_filled: u64,
    epoch: String,
    geometry: Option<CohortGeometry>,
    shared: Arc<Shared>,
    input_rx: Rx<InputEvent>,
    output_rx: Rx<OutputEvent>,
    spans: VecDeque<Span>,
    emits: VecDeque<Emit>,
    segments: VecDeque<Segment>,
    outputs: VecDeque<OutputEvent>,
    progress: Option<Progress>,
    earliest: Box<[u64]>,
    latest: Box<[u64]>,
    matched: u64,
    input_seq: u64,
    output_seq: u64,
    input_end: u64,
    emit_input_end: u64,
    emit_output_end: u64,
    output_end: u64,
    output_time: u64,
    emit_queue_end: u64,
    arrival: u64,
    sealed: bool,
    sealed_snapshot: Option<Snapshot>,
}
impl Observer {
    pub fn new(epoch: String, geometry: Option<CohortGeometry>) -> (Self, Input, Output) {
        let geometry = geometry.filter(|g| g.input_unit_frames > 0 && g.output_unit_frames > 0);
        let shared = Arc::new(Shared::default());
        if geometry.is_none() {
            shared.invalidate(InvalidReason::GeometryMismatch);
        }
        let (itx, irx) = HeapRb::new(CAPACITY).split();
        let (otx, orx) = HeapRb::new(CAPACITY).split();
        let input = Input {
            tx: itx,
            shared: shared.clone(),
            seq: 0,
            source: 0,
            queue: 0,
            generated: 0,
        };
        let output = Output {
            window: Window {
                normal: true,
                ..Window::default()
            },
            tx: otx,
            shared: shared.clone(),
            seq: 0,
            queue: 0,
            requested: 0,
        };
        (
            Self {
                window: Window::default(),
                window_consumed: 0,
                window_zero_filled: 0,
                epoch,
                geometry,
                shared,
                input_rx: irx,
                output_rx: orx,
                spans: VecDeque::with_capacity(CAPACITY),
                emits: VecDeque::with_capacity(CAPACITY),
                segments: VecDeque::with_capacity(CAPACITY),
                outputs: VecDeque::with_capacity(CAPACITY),
                progress: None,
                earliest: vec![0; BUCKETS].into_boxed_slice(),
                latest: vec![0; BUCKETS].into_boxed_slice(),
                matched: 0,
                input_seq: 0,
                output_seq: 0,
                input_end: 0,
                emit_input_end: 0,
                emit_output_end: 0,
                output_end: 0,
                output_time: 0,
                emit_queue_end: 0,
                arrival: 0,
                sealed: false,
                sealed_snapshot: None,
            },
            input,
            output,
        )
    }
    fn invalid(&self) -> bool {
        self.shared.invalid.load(Ordering::Acquire) != 0
    }
    fn fail(&self, r: InvalidReason) {
        self.shared.invalidate(r);
    }
    pub fn request_window(&self) -> Option<u64> {
        if self.sealed || self.invalid() {
            return None;
        }
        let current = self.shared.requested_revision.load(Ordering::Acquire);
        let Some(next) = current.checked_add(1) else {
            self.fail(InvalidReason::CounterOverflow);
            return None;
        };
        self.shared
            .requested_revision
            .store(next, Ordering::Release);
        Some(next)
    }
    pub fn drain(&mut self) {
        if self.sealed {
            return;
        }
        for _ in 0..DRAIN_LIMIT {
            let Some(event) = self.input_rx.try_pop() else {
                break;
            };
            if self.invalid() {
                continue;
            }
            if Some(event.seq) != self.input_seq.checked_add(1) {
                self.fail(InvalidReason::InputMetadataGap);
                continue;
            }
            self.input_seq = event.seq;
            match event.kind {
                InputKind::Span(span) => {
                    if span.start != self.input_end || span.arrival < self.arrival {
                        self.fail(InvalidReason::TimestampOrder);
                        continue;
                    }
                    let Some(end) = span.start.checked_add(span.count) else {
                        self.fail(InvalidReason::CounterOverflow);
                        continue;
                    };
                    self.input_end = end;
                    self.arrival = span.arrival;
                    if span.count > 0 {
                        if self.spans.len() == CAPACITY {
                            self.fail(InvalidReason::PendingCapacity);
                        } else {
                            self.spans.push_back(span);
                        }
                    }
                }
                InputKind::Emit(emit) => {
                    let g = self.geometry.unwrap();
                    let e = emit.ordinal;
                    if emit.queue != self.emit_queue_end
                        || e.input_start != self.emit_input_end
                        || e.output_start != self.emit_output_end
                        || e.input_count % g.input_unit_frames != 0
                        || e.output_count / g.output_unit_frames
                            != e.input_count / g.input_unit_frames
                        || e.output_count % g.output_unit_frames != 0
                        || emit.accepted > e.output_count
                    {
                        self.fail(InvalidReason::OrdinalMismatch);
                        continue;
                    }
                    let Some(queue_end) = emit.queue.checked_add(emit.accepted) else {
                        self.fail(InvalidReason::CounterOverflow);
                        continue;
                    };
                    self.emit_queue_end = queue_end;
                    let Some(end) = e.input_start.checked_add(e.input_count) else {
                        self.fail(InvalidReason::CounterOverflow);
                        continue;
                    };
                    self.emit_input_end = end;
                    let Some(end) = e.output_start.checked_add(e.output_count) else {
                        self.fail(InvalidReason::CounterOverflow);
                        continue;
                    };
                    self.emit_output_end = end;
                    if self.emit_input_end > self.input_end {
                        self.fail(InvalidReason::OrdinalMismatch);
                        continue;
                    }
                    if self.emits.len() == CAPACITY {
                        self.fail(InvalidReason::PendingCapacity);
                    } else if e.output_count > 0 {
                        self.emits.push_back(emit);
                    }
                }
            }
        }
        for _ in 0..DRAIN_LIMIT {
            let Some(event) = self.output_rx.try_pop() else {
                break;
            };
            if self.invalid() {
                continue;
            }
            if Some(event.seq) != self.output_seq.checked_add(1) || event.queue != self.output_end {
                self.fail(InvalidReason::OutputMetadataGap);
                continue;
            }
            if event.end < self.output_time {
                self.fail(InvalidReason::TimestampOrder);
                continue;
            }
            self.output_time = event.end;
            self.output_seq = event.seq;
            let Some(end) = event.queue.checked_add(event.count) else {
                self.fail(InvalidReason::CounterOverflow);
                continue;
            };
            self.output_end = end;
            if self.outputs.len() == CAPACITY {
                self.fail(InvalidReason::PendingCapacity);
            } else {
                self.outputs.push_back(event);
            }
        }
        for _ in 0..WORK {
            if self.invalid() {
                break;
            }
            if self.join_one() {
                continue;
            }
            if !self.expand_one() {
                break;
            }
        }
    }
    fn expand_one(&mut self) -> bool {
        let g = self.geometry.unwrap();
        if self.progress.is_none() {
            let Some(emit) = self.emits.pop_front() else {
                return false;
            };
            self.progress = Some(Progress {
                emit,
                input_done: 0,
                unit_done: 0,
                output_done: 0,
                earliest: u64::MAX,
                latest: 0,
            });
        }
        let p = self.progress.as_mut().unwrap();
        let Some(span) = self.spans.front_mut() else {
            self.fail(InvalidReason::InputMetadataGap);
            return false;
        };
        if span.start != p.emit.ordinal.input_start + p.input_done {
            self.fail(InvalidReason::OrdinalMismatch);
            return false;
        }
        let direct = g.input_unit_frames == 1 && g.output_unit_frames == 1;
        let unit_input = if direct {
            span.count.min(p.emit.ordinal.input_count - p.input_done)
        } else {
            g.input_unit_frames
        };
        let unit_output = if direct {
            unit_input
        } else {
            g.output_unit_frames
        };
        let take = span.count.min(unit_input - p.unit_done);
        p.earliest = p.earliest.min(span.arrival);
        p.latest = p.latest.max(span.arrival);
        p.unit_done += take;
        p.input_done += take;
        span.start += take;
        span.count -= take;
        if span.count == 0 {
            self.spans.pop_front();
        }
        if p.unit_done == unit_input {
            let count = p
                .emit
                .accepted
                .saturating_sub(p.output_done)
                .min(unit_output);
            if count > 0 {
                if self.segments.len() == CAPACITY {
                    self.fail(InvalidReason::PendingCapacity);
                    return false;
                }
                self.segments.push_back(Segment {
                    queue: p.emit.queue + p.output_done,
                    count,
                    earliest: p.earliest,
                    latest: p.latest,
                });
            }
            p.output_done += unit_output;
            p.unit_done = 0;
            p.earliest = u64::MAX;
            p.latest = 0;
            if p.output_done == p.emit.ordinal.output_count {
                self.progress = None;
            }
        }
        true
    }
    fn join_one(&mut self) -> bool {
        let Some(mut output) = self.outputs.front().copied() else {
            return false;
        };
        if !output.accounted {
            if output.window.serial < self.window.serial {
                self.fail(InvalidReason::OrdinalMismatch);
                return false;
            }
            if output.window.serial > self.window.serial {
                self.window = output.window;
                self.window_consumed = 0;
                self.window_zero_filled = 0;
                self.matched = 0;
                self.earliest.fill(0);
                self.latest.fill(0);
            }
            let Some(consumed) = self.window_consumed.checked_add(output.count) else {
                self.fail(InvalidReason::CounterOverflow);
                return false;
            };
            self.window_consumed = consumed;
            let Some(zero) = self
                .window_zero_filled
                .checked_add(output.requested - output.count)
            else {
                self.fail(InvalidReason::CounterOverflow);
                return false;
            };
            self.window_zero_filled = zero;
            output.accounted = true;
            self.outputs.front_mut().unwrap().accounted = true;
        }
        if output.count == 0 {
            self.outputs.pop_front();
            return true;
        }
        let Some(segment) = self.segments.front().copied() else {
            return false;
        };
        if segment.queue != output.queue {
            self.fail(InvalidReason::OrdinalMismatch);
            return false;
        }
        if segment.latest > output.end {
            self.fail(InvalidReason::TimestampOrder);
            return false;
        }
        let count = segment.count.min(output.count);
        if output.window.normal {
            for (hist, arrival) in [
                (&mut self.earliest, segment.earliest),
                (&mut self.latest, segment.latest),
            ] {
                let index = ((output.end - arrival) / BUCKET_NS).min((BUCKETS - 1) as u64) as usize;
                let Some(value) = hist[index].checked_add(count) else {
                    self.shared.invalidate(InvalidReason::CounterOverflow);
                    return false;
                };
                hist[index] = value;
            }
            let Some(matched) = self.matched.checked_add(count) else {
                self.fail(InvalidReason::CounterOverflow);
                return false;
            };
            self.matched = matched;
        }
        if count == segment.count {
            self.segments.pop_front();
        } else {
            let s = self.segments.front_mut().unwrap();
            s.queue += count;
            s.count -= count;
        }
        if count == output.count {
            self.outputs.pop_front();
        } else {
            let o = self.outputs.front_mut().unwrap();
            o.queue += count;
            o.count -= count;
        }
        true
    }
    pub fn seal(&mut self) {
        if self.sealed {
            return;
        }
        for _ in 0..(CAPACITY / DRAIN_LIMIT + CAPACITY * 4 / WORK + 2) {
            self.drain();
        }
        self.sealed = true;
        self.sealed_snapshot = Some(self.snapshot());
    }
    fn quantile(&self, hist: &[u64], percent: u64) -> Option<QuantileRange> {
        if self.invalid()
            || self.matched == 0
            || !self.window.normal
            || self.window.serial != self.shared.window_serial.load(Ordering::Acquire)
            || self.window.completed != self.shared.requested_revision.load(Ordering::Acquire)
        {
            return None;
        }
        let target = (u128::from(self.matched) * u128::from(percent)).div_ceil(100) as u64;
        let mut sum = 0;
        for (i, n) in hist.iter().enumerate() {
            sum += n;
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
        if let Some(snapshot) = &self.sealed_snapshot {
            return snapshot.clone();
        }
        let stream_consumed = self.shared.consumed.load(Ordering::Acquire);
        let consumed = self.window_consumed;
        let requested_revision = self.shared.requested_revision.load(Ordering::Acquire);
        let window_current = self.window.serial
            == self.shared.window_serial.load(Ordering::Acquire)
            && self.window.completed == requested_revision;

        let invalid = self.shared.invalid.load(Ordering::Acquire);
        let matched = if invalid == 0 && self.window.normal {
            self.matched
        } else {
            0
        };
        let reasons = [
            InvalidReason::GeometryMismatch,
            InvalidReason::InputMetadataGap,
            InvalidReason::OutputMetadataGap,
            InvalidReason::PendingCapacity,
            InvalidReason::CounterOverflow,
            InvalidReason::TimestampOrder,
            InvalidReason::RecoverySkip,
            InvalidReason::OrdinalMismatch,
            InvalidReason::NonMicOutput,
            InvalidReason::ConditionsChanged,
        ]
        .into_iter()
        .filter(|r| invalid & r.bit() != 0)
        .collect();
        let pending = if !self.sealed && invalid == 0 && self.window.normal {
            consumed.saturating_sub(matched)
        } else {
            0
        };
        Snapshot {
            schema_version: 2,
            window_id: self.window.serial.to_string(),
            requested_revision: requested_revision.to_string(),
            completed_revision: self.window.completed.to_string(),
            applied_revision: self.window.applied.to_string(),
            rejected_revision: self.window.rejected.map(|r| r.to_string()),
            normal_mic_output: self.window.normal,
            stream_consumed_frames: stream_consumed,
            epoch: self.epoch.clone(),
            mode: if self
                .geometry
                .is_some_and(|g| g.input_unit_frames == 1 && g.output_unit_frames == 1)
            {
                "sameRateInputToOutputBufferEnd"
            } else {
                "inputCohortToOutputBufferEnd"
            }
            .into(),
            status: if self.geometry.is_none() {
                "unsupported"
            } else if invalid != 0 {
                "invalid"
            } else if self.sealed {
                "sealed"
            } else if !window_current {
                "pending"
            } else if !self.window.normal {
                "substituted"
            } else if consumed == 0 {
                "collecting"
            } else {
                "partial"
            }
            .into(),
            signal_correspondence: "notMeasured".into(),
            geometry: self.geometry,
            received_input_frames: self.input_end,
            cohort_input_frames: self.emit_input_end,
            unemitted_input_frames: (invalid == 0)
                .then(|| self.input_end.saturating_sub(self.emit_input_end)),
            consumed_frames: consumed,
            matched_frames: matched,
            pending_frames: pending,
            unknown_frames: consumed.saturating_sub(matched).saturating_sub(pending),
            zero_filled_frames: self.window_zero_filled,
            coverage_percent: (invalid == 0
                && consumed > 0
                && self.window.normal
                && window_current)
                .then(|| 100.0 * matched as f64 / consumed as f64),
            earliest_arrival_to_end: ArrivalRange {
                p50: self.quantile(&self.earliest, 50),
                p95: self.quantile(&self.earliest, 95),
            },
            latest_arrival_to_end: ArrivalRange {
                p50: self.quantile(&self.latest, 50),
                p95: self.quantile(&self.latest, 95),
            },
            invalid_reasons: reasons,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Observer, Input, Output) {
        Observer::new(
            "new-epoch".into(),
            Some(CohortGeometry {
                input_unit_frames: 4,
                output_unit_frames: 6,
            }),
        )
    }
    fn emission(start: u64, output: u64) -> CohortEmission {
        CohortEmission {
            input_start: start,
            input_count: 4,
            output_start: output,
            output_count: 6,
        }
    }
    #[test]
    fn accumulated_arrival_range_drop_partial_read_and_zero_fill_are_distinct() {
        let (mut observer, mut input, mut output) = fixture();
        input.span(1, 100_000);
        input.span(3, 400_000);
        input.emit(Some(emission(0, 0)), 3);
        input.span(6, 700_000);
        input.emit(Some(emission(4, 6)), 6);
        output.record(2, 2, 10_000_000, true);
        output.record(7, 9, 20_000_000, true);
        observer.seal();
        let s = observer.snapshot();
        assert_eq!(
            (
                s.consumed_frames,
                s.matched_frames,
                s.unknown_frames,
                s.zero_filled_frames
            ),
            (9, 9, 0, 2)
        );
        assert_eq!(
            (
                s.received_input_frames,
                s.cohort_input_frames,
                s.unemitted_input_frames
            ),
            (10, 8, Some(2))
        );
        assert_eq!(
            s.earliest_arrival_to_end.p50.as_ref().unwrap().lower_ms,
            19.3
        );
        assert_eq!(s.latest_arrival_to_end.p50.as_ref().unwrap().lower_ms, 19.3);
        assert_eq!(s.signal_correspondence, "notMeasured");
        assert!(s.invalid_reasons.is_empty());
    }
    #[test]
    fn zero_emit_callbacks_and_internal_carry_are_joined_by_original_input() {
        let (mut observer, mut input, mut output) = fixture();
        input.span(3, 100_000);
        observer.drain();
        assert_eq!(observer.snapshot().matched_frames, 0);
        input.span(3, 500_000);
        input.emit(Some(emission(0, 0)), 6);
        output.record(6, 6, 1_000_000, true);
        observer.drain();
        let s = observer.snapshot();
        assert_eq!(s.earliest_arrival_to_end.p50.unwrap().lower_ms, 0.9);
        assert_eq!(s.latest_arrival_to_end.p50.unwrap().lower_ms, 0.5);
        input.span(2, 900_000);
        input.emit(Some(emission(4, 6)), 6);
        output.record(6, 6, 2_000_000, true);
        observer.seal();
        assert_eq!(observer.snapshot().matched_frames, 12);
    }
    #[test]
    fn metadata_overflow_gap_reverse_and_non_mic_never_create_valid_measurement() {
        for kind in [0, 1, 2, 3, 5] {
            let (mut observer, mut input, mut output) = fixture();
            match kind {
                0 => {
                    for _ in 0..=CAPACITY {
                        input.span(1, 1);
                    }
                }
                1 => {
                    input.seq = 1;
                    input.span(4, 1);
                }
                2 => {
                    input.span(2, 10);
                    input.span(2, 9);
                }
                3 => {
                    input.span(4, 20);
                    input.emit(Some(emission(0, 0)), 6);
                    output.record(6, 6, 10, true);
                }
                4 => {
                    input.span(4, 1);
                    input.emit(Some(emission(0, 0)), 6);
                    output.record(6, 6, 10, false);
                }
                _ => {
                    input.span(4, 1);
                    input.emit(None, 0);
                }
            }
            observer.seal();
            let s = observer.snapshot();
            assert!(!s.invalid_reasons.is_empty());
            assert_eq!(s.matched_frames, 0);
            assert!(s.coverage_percent.is_none());
            assert!(s.earliest_arrival_to_end.p50.is_none());
        }
    }
    #[test]
    fn output_gap_pending_capacity_and_unsupported_are_explicit() {
        let (mut observer, mut input, mut output) = fixture();
        input.span(4, 1);
        input.emit(Some(emission(0, 0)), 6);
        output.seq = 1;
        output.record(6, 6, 10, true);
        observer.seal();
        assert!(observer
            .snapshot()
            .invalid_reasons
            .contains(&InvalidReason::OutputMetadataGap));
        let (mut observer, mut input, _) = fixture();
        for _ in 0..CAPACITY / DRAIN_LIMIT {
            for _ in 0..DRAIN_LIMIT {
                input.span(1, 1);
            }
            observer.drain();
        }
        input.span(1, 1);
        observer.drain();
        assert!(observer
            .snapshot()
            .invalid_reasons
            .contains(&InvalidReason::PendingCapacity));
        let (mut observer, _, _) = Observer::new("unsupported".into(), None);
        observer.seal();
        assert_eq!(observer.snapshot().status, "unsupported");
    }
    #[test]
    fn skip_invalidates_before_discard_and_seal_is_immutable() {
        let (mut observer, mut input, mut output) = fixture();
        input.span(4, 1);
        input.emit(Some(emission(0, 0)), 6);
        output.record(6, 6, 10, true);
        observer.drain();
        assert_eq!(observer.snapshot().matched_frames, 6);
        output.invalidate(InvalidReason::RecoverySkip);
        assert!(observer.snapshot().coverage_percent.is_none());
        observer.seal();
        let before = serde_json::to_value(observer.snapshot()).unwrap();
        input.span(4, 20);
        output.record(2, 2, 30, false);
        observer.drain();
        assert_eq!(serde_json::to_value(observer.snapshot()).unwrap(), before);
        let (new, _, _) = fixture();
        assert!(new.snapshot().invalid_reasons.is_empty());
    }
    #[test]
    fn output_time_reversal_and_consumed_above_requested_invalidate() {
        for reversed in [true, false] {
            let (mut observer, mut input, mut output) = fixture();
            input.span(4, 1);
            input.emit(Some(emission(0, 0)), 6);
            if reversed {
                output.record(3, 3, 30, true);
                output.record(3, 3, 20, true);
            } else {
                output.record(6, 5, 30, true);
            }
            observer.seal();
            assert!(observer.snapshot().coverage_percent.is_none());
            assert!(!observer.snapshot().invalid_reasons.is_empty());
        }
    }

    #[test]
    fn requested_applied_rejected_and_source_windows_reset_only_cdf_not_input_carry() {
        let (mut observer, mut input, mut output) = fixture();
        input.span(3, 100_000);
        assert_eq!(observer.request_window(), Some(1));
        assert_eq!(observer.request_window(), Some(2));
        assert!(output.complete_window(1, true));
        output.record(0, 0, 300_000, true);
        observer.drain();
        assert_eq!(observer.snapshot().status, "pending");
        assert!(output.complete_window(2, true));
        assert!(!output.complete_window(1, true));
        input.span(1, 500_000);
        input.emit(Some(emission(0, 0)), 6);
        output.record(6, 6, 1_000_000, true);
        observer.drain();
        let s = observer.snapshot();
        assert_eq!(
            (s.requested_revision.as_str(), s.applied_revision.as_str()),
            ("2", "2")
        );
        assert_eq!(s.matched_frames, 6);
        assert_eq!(s.earliest_arrival_to_end.p50.unwrap().lower_ms, 0.9);
        assert_eq!(observer.request_window(), Some(3));
        assert!(output.complete_window(3, false));
        input.span(4, 1_100_000);
        input.emit(Some(emission(4, 6)), 6);
        output.record(6, 6, 2_000_000, true);
        observer.drain();
        let s = observer.snapshot();
        assert_eq!(
            (
                s.completed_revision.as_str(),
                s.applied_revision.as_str(),
                s.rejected_revision.as_deref()
            ),
            ("3", "2", Some("3"))
        );
        assert_eq!(
            (
                s.stream_consumed_frames,
                s.consumed_frames,
                s.matched_frames
            ),
            (12, 6, 6)
        );
        input.span(4, 2_100_000);
        input.emit(Some(emission(8, 12)), 6);
        output.record(6, 6, 3_000_000, false);
        observer.drain();
        assert_eq!(observer.snapshot().status, "substituted");
        assert!(observer.snapshot().coverage_percent.is_none());
        input.span(4, 3_100_000);
        input.emit(Some(emission(12, 18)), 6);
        output.record(6, 6, 4_000_000, true);
        observer.seal();
        let s = observer.snapshot();
        assert_eq!((s.consumed_frames, s.matched_frames), (6, 6));
        assert!(s.invalid_reasons.is_empty());
    }
    #[test]
    fn metadata_fault_and_skip_cannot_be_recovered_by_setting_ack() {
        for reason in [
            InvalidReason::InputMetadataGap,
            InvalidReason::OutputMetadataGap,
            InvalidReason::RecoverySkip,
        ] {
            let (mut observer, mut input, mut output) = fixture();
            let revision = observer.request_window().unwrap();
            output.invalidate(reason);
            assert!(observer.request_window().is_none());
            assert!(!output.complete_window(revision, true));
            input.span(4, 1);
            input.emit(Some(emission(0, 0)), 6);
            output.record(6, 6, 10, true);
            observer.seal();
            assert_eq!(observer.snapshot().status, "invalid");
        }
    }
    #[test]
    fn direct_mode_span_mapping_handles_large_callback_without_per_frame_work() {
        let (mut observer, mut input, mut output) = Observer::new(
            "direct".into(),
            Some(CohortGeometry {
                input_unit_frames: 1,
                output_unit_frames: 1,
            }),
        );
        input.span(65_536, 100_000);
        input.direct_emit(65_536, 65_534);
        output.record(10, 12, 1_000_000, true);
        output.record(65_524, 65_524, 2_000_000, true);
        observer.seal();
        let s = observer.snapshot();
        assert_eq!(s.mode, "sameRateInputToOutputBufferEnd");
        assert_eq!(
            (s.consumed_frames, s.matched_frames, s.zero_filled_frames),
            (65_534, 65_534, 2)
        );
        assert!(s.invalid_reasons.is_empty());
    }

    #[test]
    fn recording_metadata_and_output_is_rt_allocation_and_free_free() {
        let (mut observer, mut input, mut output) = fixture();
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| {
                input.span(4, 1);
                input.emit(Some(emission(0, 0)), 6);
                output.record(6, 8, 10, true);
            }),
            (0, 0)
        );
        observer.seal();
        assert_eq!(observer.snapshot().matched_frames, 6);
    }
    #[test]
    fn known_signals_keep_audio_and_cohort_counts_through_real_resampler() {
        use crate::audio_engine::resampling::{CohortGeometry, StreamResampler};
        for (ir, or) in [(44100, 48000), (48000, 44100)] {
            let mut rs = StreamResampler::new(ir, or, 2).unwrap();
            let d = rs.timing_descriptor();
            let (mut observer, mut input, mut output) =
                Observer::new("signal-epoch".into(), CohortGeometry::from_descriptor(&d));
            let mut frame = 0usize;
            let mut output_frames = 0;
            for (index, frames) in [128, 127, 513, 1, 1024, 79, 512, 1024]
                .into_iter()
                .enumerate()
            {
                let data: Vec<f32> = (0..frames * 2)
                    .map(|i| {
                        if frame + i / 2 == 3 {
                            1.0
                        } else {
                            ((frame + i / 2) as f32 * 0.031).sin() * 0.02
                        }
                    })
                    .collect();
                frame += frames;
                input.span(frames, index as u64 * 1_000_000);
                rs.process_into_observed(&data, |samples, e| {
                    assert!(samples.iter().all(|v| v.is_finite()));
                    let n = samples.len() / 2;
                    input.emit(e, n);
                    output.record(n, n, (index as u64 + 1) * 1_000_000, true);
                    output_frames += n;
                })
                .unwrap();
                observer.drain();
            }
            observer.seal();
            let s = observer.snapshot();
            assert_eq!(s.matched_frames, output_frames as u64);
            assert!(s.invalid_reasons.is_empty());
            assert_eq!(s.signal_correspondence, "notMeasured");
        }
    }
}
