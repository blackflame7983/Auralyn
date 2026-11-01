//! 入力→出力queueの量を観測する。信号遅延の測定・clock補償・音声の自動trimは行わない。
use ringbuf::traits::{Consumer, Producer};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QueueState {
    #[default]
    Preparing,
    Running,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    #[serde(default)]
    pub recovery_discarded_frames: Option<u64>,
    #[serde(default)]
    pub recovery_count: Option<u64>,
    #[serde(default)]
    pub recovery_status: Option<u64>,
    #[serde(default)]
    pub recovery_target_frames: Option<u64>,
    #[serde(default)]
    pub recovery_high_frames: Option<u64>,
    pub epoch: String,
    pub state: QueueState,
    pub input_rate_hz: u32,
    pub output_rate_hz: u32,
    pub input_channels: u16,
    pub output_channels: u16,
    #[serde(default)]
    pub queue_channels: Option<u16>,
    pub capacity_slots: u64,
    pub capacity_frames: u64,
    pub capacity_remainder_slots: u64,
    pub current_slots: Option<u64>,
    pub current_frames: Option<u64>,
    pub current_partial_slots: Option<u64>,
    pub current_audio_ms: Option<f64>,
    pub max_observed_slots: u64,
    pub max_observed_frames: u64,
    pub max_observed_audio_ms: Option<f64>,
    pub queued_slots_at_stop: Option<u64>,
    pub queued_frames_at_stop: Option<u64>,
    pub received_input_frames: u64,
    pub generated_output_frames: u64,
    pub offered_output_frames: u64,
    pub accepted_output_frames: u64,
    pub dropped_output_frames: u64,
    pub requested_output_frames: u64,
    pub consumed_output_frames: u64,
    pub zero_filled_output_frames: u64,
    pub queue_read_callbacks: u64,
    pub underflow_callbacks: u64,
    /// 最初にqueueの実入力を消費するcallbackまでの不足分。総数にも含む。
    #[serde(default)]
    pub startup_zero_filled_output_frames: Option<u64>,
    #[serde(default)]
    pub startup_underflow_callbacks: Option<u64>,
}

// producer/consumer間の不要なcache line共有を避け、sample単位では更新しない。
#[repr(align(64))]
#[derive(Default)]
struct InputCounters {
    received: AtomicU64,
    generated: AtomicU64,
    offered: AtomicU64,
    accepted: AtomicU64,
    dropped: AtomicU64,
    max_slots: AtomicU64,
    max_burst: AtomicU64,
}
#[repr(align(64))]
#[derive(Default)]
struct OutputCounters {
    requested: AtomicU64,
    consumed: AtomicU64,
    zero_filled: AtomicU64,
    callbacks: AtomicU64,
    underflows: AtomicU64,
    startup_zero_filled: AtomicU64,
    startup_underflows: AtomicU64,
    recovery_discarded: AtomicU64,
    recoveries: AtomicU64,
    recovery_status: AtomicU64,
    recovery_target: AtomicU64,
    recovery_high: AtomicU64,
}

pub struct QueueDiagnostics {
    epoch: String,
    input_rate: u32,
    output_rate: u32,
    input_channels: u16,
    output_channels: u16,
    queue_channels: u16,
    capacity_slots: usize,
    input: InputCounters,
    output: OutputCounters,
}

impl QueueDiagnostics {
    pub fn new(
        epoch: String,
        input_rate: u32,
        output_rate: u32,
        input_channels: u16,
        output_channels: u16,
        capacity_slots: usize,
    ) -> Self {
        Self {
            epoch,
            input_rate,
            output_rate,
            input_channels,
            output_channels,
            queue_channels: output_channels,
            capacity_slots,
            input: InputCounters::default(),
            output: OutputCounters::default(),
        }
    }

    pub fn new_input_queue(
        epoch: String,
        input_rate: u32,
        output_rate: u32,
        input_channels: u16,
        output_channels: u16,
        capacity_slots: usize,
    ) -> Self {
        let mut result = Self::new(
            epoch,
            input_rate,
            output_rate,
            input_channels,
            output_channels,
            capacity_slots,
        );
        result.queue_channels = input_channels;
        result
    }

    /// 1入力callback分をまとめて記録する。音声queueの受入判断には使わない。
    pub fn record_input(
        &self,
        received: usize,
        generated: usize,
        offered: usize,
        accepted: usize,
        max_observed_slots: usize,
    ) {
        self.input
            .max_burst
            .fetch_max(generated as u64, Ordering::Relaxed);
        self.input
            .received
            .fetch_add(received as u64, Ordering::Relaxed);
        self.input
            .generated
            .fetch_add(generated as u64, Ordering::Relaxed);
        self.input
            .offered
            .fetch_add(offered as u64, Ordering::Relaxed);
        self.input
            .accepted
            .fetch_add(accepted as u64, Ordering::Relaxed);
        self.input
            .dropped
            .fetch_add(offered.saturating_sub(accepted) as u64, Ordering::Relaxed);
        self.input.max_slots.fetch_max(
            max_observed_slots.min(self.capacity_slots) as u64,
            Ordering::Relaxed,
        );
    }

    pub fn max_burst(&self) -> usize {
        self.input.max_burst.load(Ordering::Relaxed) as usize
    }
    pub fn record_recovery(&self, discarded: usize, status: u64, target: usize, high: usize) {
        self.output
            .recovery_discarded
            .fetch_add(discarded as u64, Ordering::Relaxed);
        if discarded > 0 {
            self.output.recoveries.fetch_add(1, Ordering::Relaxed);
        }
        self.output.recovery_status.store(status, Ordering::Relaxed);
        self.output
            .recovery_target
            .store(target as u64, Ordering::Relaxed);
        self.output
            .recovery_high
            .store(high as u64, Ordering::Relaxed);
    }
    /// queue読出しを行ったcallbackだけを数える。故障時の早期無音化やmuteとは別。
    pub fn record_output(&self, requested: usize, consumed: usize) {
        let consumed = consumed.min(requested);
        self.output
            .requested
            .fetch_add(requested as u64, Ordering::Relaxed);
        let previously_consumed = self
            .output
            .consumed
            .fetch_add(consumed as u64, Ordering::Relaxed);
        self.output
            .zero_filled
            .fetch_add((requested - consumed) as u64, Ordering::Relaxed);
        self.output.callbacks.fetch_add(1, Ordering::Relaxed);
        if consumed < requested {
            self.output.underflows.fetch_add(1, Ordering::Relaxed);
            // 単一consumerの消費実績で区切る。待機や先読み、音声の遅延は加えない。
            // 最初の部分読出しで不足した分も開始区間に含め、以降は稼働後の不足とする。
            if previously_consumed == 0 {
                self.output
                    .startup_zero_filled
                    .fetch_add((requested - consumed) as u64, Ordering::Relaxed);
                self.output
                    .startup_underflows
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// 制御側だけでsnapshotを作る。稼働中の各counterは同一瞬間の原子的な組ではない。
    pub fn snapshot(
        &self,
        state: QueueState,
        current_slots: Option<usize>,
        queued_slots_at_stop: Option<usize>,
    ) -> QueueSnapshot {
        let ch = u64::from(self.queue_channels).max(1);
        let capacity_slots = self.capacity_slots as u64;
        let valid_slots = |slots: Option<usize>| {
            slots
                .filter(|n| *n <= self.capacity_slots)
                .map(|n| n as u64)
        };
        let current_slots = if state == QueueState::Running {
            valid_slots(current_slots)
        } else {
            None
        };
        let queued_slots_at_stop = valid_slots(queued_slots_at_stop);
        let max_observed_slots = self.input.max_slots.load(Ordering::Relaxed);
        let max_observed_frames = max_observed_slots / ch;
        let audio_ms = |frames: u64| {
            (self.output_rate > 0).then(|| frames as f64 * 1000.0 / f64::from(self.output_rate))
        };
        QueueSnapshot {
            recovery_discarded_frames: Some(self.output.recovery_discarded.load(Ordering::Relaxed)),
            recovery_count: Some(self.output.recoveries.load(Ordering::Relaxed)),
            recovery_status: Some(self.output.recovery_status.load(Ordering::Relaxed)),
            recovery_target_frames: Some(self.output.recovery_target.load(Ordering::Relaxed)),
            recovery_high_frames: Some(self.output.recovery_high.load(Ordering::Relaxed)),
            epoch: self.epoch.clone(),
            state,
            input_rate_hz: self.input_rate,
            output_rate_hz: self.output_rate,
            input_channels: self.input_channels,
            output_channels: self.output_channels,
            queue_channels: Some(self.queue_channels),
            capacity_slots,
            capacity_frames: capacity_slots / ch,
            capacity_remainder_slots: capacity_slots % ch,
            current_slots,
            current_frames: current_slots.map(|n| n / ch),
            current_partial_slots: current_slots.map(|n| n % ch),
            current_audio_ms: current_slots.and_then(|n| audio_ms(n / ch)),
            max_observed_slots,
            max_observed_frames,
            max_observed_audio_ms: audio_ms(max_observed_frames),
            queued_slots_at_stop,
            queued_frames_at_stop: queued_slots_at_stop.map(|n| n / ch),
            received_input_frames: self.input.received.load(Ordering::Relaxed),
            generated_output_frames: self.input.generated.load(Ordering::Relaxed),
            offered_output_frames: self.input.offered.load(Ordering::Relaxed),
            accepted_output_frames: self.input.accepted.load(Ordering::Relaxed),
            dropped_output_frames: self.input.dropped.load(Ordering::Relaxed),
            requested_output_frames: self.output.requested.load(Ordering::Relaxed),
            consumed_output_frames: self.output.consumed.load(Ordering::Relaxed),
            zero_filled_output_frames: self.output.zero_filled.load(Ordering::Relaxed),
            queue_read_callbacks: self.output.callbacks.load(Ordering::Relaxed),
            underflow_callbacks: self.output.underflows.load(Ordering::Relaxed),
            startup_zero_filled_output_frames: Some(
                self.output.startup_zero_filled.load(Ordering::Relaxed),
            ),
            startup_underflow_callbacks: Some(
                self.output.startup_underflows.load(Ordering::Relaxed),
            ),
        }
    }
}

/// ASIO insertの有効な同番号出力を維持し、届かないペアは主出力へ写す。
/// WASAPIの入力番号やmonoの複製は、物理出力の番号に流用しない。
pub(crate) fn output_pair(asio: bool, input_pair: [usize; 2], channels: usize) -> [usize; 2] {
    if asio && input_pair.iter().all(|&channel| channel < channels) {
        input_pair
    } else {
        [0, usize::from(channels > 1)]
    }
}

/// 検証済みの構成を callback 内で割り当てずに出力へ写す。
pub(crate) fn routed_output_pair(
    routing: crate::ipc::OutputRouting,
    asio: bool,
    input_pair: [usize; 2],
    channels: usize,
) -> [usize; 2] {
    match routing {
        crate::ipc::OutputRouting::Independent { channels: pair } if asio => pair,
        _ => output_pair(asio, input_pair, channels),
    }
}

pub(crate) fn route_stereo_monitor(data: &mut [f32], pair: [usize; 2]) {
    for frame in data.as_chunks_mut::<2>().0 {
        let samples = [frame[0], frame[1]];
        frame.fill(0.0);
        write_output_frame(frame, pair, samples);
    }
}

/// 通常音声・録音再生・テストトーンで共用する最終出力と、その実送出レベル。
pub(crate) fn write_output_frame(
    frame: &mut [f32],
    pair: [usize; 2],
    samples: [f32; 2],
) -> [f32; 2] {
    if let Some(left) = frame.get_mut(pair[0]) {
        *left = samples[0];
    }
    // monoの同一端子を右側で上書きしない。
    if pair[1] != pair[0] {
        if let Some(right) = frame.get_mut(pair[1]) {
            *right = samples[1];
        }
    }
    super::core::dsp::sent_sample_levels(frame, pair)
}

/// 同一フレームの選択値を取り出す。加工前録音と処理入力の共通点。
pub(crate) fn selected_pair(frame: &[f32], channels: [usize; 2], gain: f32) -> [f32; 2] {
    channels.map(|ch| frame.get(ch).copied().unwrap_or(0.0) * gain)
}

/// 選択された2chを先頭へ配置し、余剰出力には入力を流さない。
pub(crate) fn route_input_frame(
    frame: &[f32],
    selected: [usize; 2],
    gain: f32,
    planar: &mut [Vec<f32>],
    index: usize,
    output_channels: usize,
) -> [f32; 2] {
    let pair = selected_pair(frame, selected, gain);
    for channel in planar.iter_mut().take(output_channels).skip(2) {
        channel[index] = 0.0;
    }
    planar[0][index] = pair[0];
    if output_channels >= 2 {
        planar[1][index] = pair[1];
    }
    pair
}

/// f32ごとに公開されるqueueから、完全なoutput frameだけを読む。
/// 単独consumerなので、観測した完全frameはpopまで減らない。部分frameは次回へ残す。
pub(crate) fn read_complete_frames(
    consumer: &mut impl Consumer<Item = f32>,
    output: &mut [f32],
    channels: usize,
) -> usize {
    read_complete_frames_observed(consumer, output, channels, || ()).0
}

/// 時計などの観測はpop直後、既存の不足分ゼロ埋めより前に1回だけ呼ぶ。
pub(crate) fn read_complete_frames_observed<T>(
    consumer: &mut impl Consumer<Item = f32>,
    output: &mut [f32],
    channels: usize,
    after_pop: impl FnOnce() -> T,
) -> (usize, T) {
    if channels == 0 {
        output.fill(0.0);
        return (0, after_pop());
    }
    let readable_frames = (consumer.occupied_len() / channels).min(output.len() / channels);
    let read_slots = consumer.pop_slice(&mut output[..readable_frames * channels]);
    let observation = after_pop();
    output[read_slots..].fill(0.0);
    (read_slots / channels, observation)
}

#[derive(Default)]
pub(crate) struct PushResult {
    pub offered: usize,
    pub accepted: usize,
    pub observed_slots: usize,
}

/// 既存の全frame単位の受入予算とch mappingを維持し、受入実績だけを返す。
pub(crate) fn push_mapped_frames(
    producer: &mut impl Producer<Item = f32>,
    samples: &[f32],
    input_channels: usize,
    output_channels: usize,
    remaining_frames: &mut Option<usize>,
) -> PushResult {
    if input_channels == 0 || output_channels == 0 {
        return PushResult::default();
    }
    let frames = samples.len() / input_channels;
    let remaining = remaining_frames.get_or_insert_with(|| producer.vacant_len() / output_channels);
    let frames_to_push = frames.min(*remaining);
    *remaining -= frames_to_push;
    let mut accepted = 0;
    'frames: for frame in 0..frames_to_push {
        if producer.vacant_len() < output_channels {
            break;
        }
        for ch in 0..output_channels {
            let source_ch = if input_channels == 1 {
                0
            } else {
                ch.min(input_channels - 1)
            };
            if producer
                .try_push(samples[frame * input_channels + source_ch])
                .is_err()
            {
                break 'frames;
            }
        }
        accepted += 1;
    }
    PushResult {
        offered: frames,
        accepted,
        observed_slots: producer.occupied_len(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn startup_shortages_are_included_in_totals_and_end_after_first_consumption() {
        use super::{QueueDiagnostics, QueueState};
        let q = QueueDiagnostics::new("startup".into(), 48_000, 48_000, 1, 2, 4096);
        assert_eq!(
            crate::dsp_verification_allocator::allocation_counts(|| {
                q.record_output(100, 0);
                q.record_output(100, 40);
                q.record_output(100, 100);
                q.record_output(100, 0);
            }),
            (0, 0)
        );
        let s = q.snapshot(QueueState::Running, Some(0), None);
        assert_eq!(s.startup_zero_filled_output_frames, Some(160));
        assert_eq!(s.startup_underflow_callbacks, Some(2));
        assert_eq!(s.zero_filled_output_frames, 260);
        assert_eq!(s.underflow_callbacks, 3);
        let next = QueueDiagnostics::new("next".into(), 48_000, 48_000, 1, 2, 4096).snapshot(
            QueueState::Running,
            Some(0),
            None,
        );
        assert_eq!(next.startup_zero_filled_output_frames, Some(0));
        let mut legacy = serde_json::to_value(&s).expect("snapshot JSON");
        legacy
            .as_object_mut()
            .expect("object")
            .remove("startupZeroFilledOutputFrames");
        legacy
            .as_object_mut()
            .expect("object")
            .remove("startupUnderflowCallbacks");
        let old: super::QueueSnapshot = serde_json::from_value(legacy).expect("legacy snapshot");
        assert!(old.startup_zero_filled_output_frames.is_none());
    }

    #[test]
    fn selected_input_reaches_actual_output_and_meter_without_rt_allocations() {
        for (asio, input, output, pair, targets) in [
            (true, 8, 2, [2, 3], [0, 1]),
            (true, 2, 8, [0, 1], [0, 1]),
            (true, 22, 22, [6, 7], [6, 7]),
            (false, 1, 2, [0, 0], [0, 1]),
            (true, 3, 3, [2, 2], [2, 2]),
            (true, 3, 2, [2, 2], [0, 1]),
            (false, 2, 1, [0, 1], [0, 0]),
        ] {
            let frame: Vec<_> = (1..=input).map(|n| n as f32).collect();
            let mut planar = vec![vec![0.0]; output.max(2)];
            let mut device = vec![0.0; output];
            assert_eq!(
                crate::dsp_verification_allocator::allocation_counts(|| {
                    let raw = super::route_input_frame(&frame, pair, 0.5, &mut planar, 0, output);
                    let actual_targets = super::output_pair(asio, pair, output);
                    assert_eq!(actual_targets, targets);
                    let sent = super::write_output_frame(&mut device, actual_targets, raw);
                    assert_eq!(device[targets[0]], raw[0]);
                    assert_eq!(sent[0], raw[0].abs());
                    if targets[0] != targets[1] {
                        assert_eq!(device[targets[1]], raw[1]);
                        assert_eq!(sent[1], raw[1].abs());
                    } else {
                        assert_eq!(sent[1], 0.0);
                    }
                    for (index, value) in device.iter().enumerate() {
                        if !targets.contains(&index) {
                            assert_eq!(*value, 0.0);
                        }
                    }
                }),
                (0, 0)
            );
        }
    }

    #[test]
    fn independent_and_insert_route_first_frame_without_old_input_or_allocations() {
        use crate::ipc::OutputRouting;
        for (routing, expected) in [
            (
                OutputRouting::Independent { channels: [0, 1] },
                [3.0, 4.0, 0.0, 0.0],
            ),
            (OutputRouting::Insert, [0.0, 0.0, 3.0, 4.0]),
        ] {
            let input = [90.0, 80.0, 3.0, 4.0];
            let mut planar = vec![vec![0.0]; 4];
            let mut output = [0.0; 4];
            assert_eq!(
                crate::dsp_verification_allocator::allocation_counts(|| {
                    let samples = super::route_input_frame(&input, [2, 3], 1.0, &mut planar, 0, 4);
                    let pair = super::routed_output_pair(routing, true, [2, 3], 4);
                    super::write_output_frame(&mut output, pair, samples);
                }),
                (0, 0)
            );
            assert_eq!(output, expected);
        }
    }

    #[test]
    fn split_monitor_keeps_logical_stereo_and_routes_physical_output() {
        use crate::ipc::OutputRouting;
        let physical_input = [2, 3];
        let pair = super::routed_output_pair(
            OutputRouting::Independent { channels: [1, 0] },
            true,
            physical_input,
            2,
        );
        let mut monitor = [0.25, 0.75];
        assert_eq!(
            crate::dsp_verification_allocator::allocation_counts(|| super::route_stereo_monitor(
                &mut monitor,
                pair
            )),
            (0, 0)
        );
        assert_eq!(monitor, [0.75, 0.25]);
        assert_eq!(
            super::routed_output_pair(
                OutputRouting::Independent { channels: [1, 0] },
                true,
                [0, 1],
                2
            ),
            pair
        );
    }

    #[test]
    fn mono_device_keeps_processed_left_instead_of_overwriting_with_right() {
        let mut frame = [0.0];
        assert_eq!(
            super::write_output_frame(&mut frame, [0, 0], [0.25, 0.75]),
            [0.25, 0.0]
        );
        assert_eq!(frame, [0.25]);
    }

    #[test]
    fn normal_route_and_raw_pair_match_for_physical_and_output_shapes() {
        for (input, output) in [(8, 2), (8, 8), (2, 8), (1, 2), (3, 2), (3, 1)] {
            let frame: Vec<_> = (0..input).map(|i| (i + 1) as f32).collect();
            let mut planar = vec![vec![0.0; 1]; output];
            for left in 0..input {
                for right in 0..input {
                    assert_eq!(
                        crate::dsp_verification_allocator::allocation_counts(|| {
                            let raw = super::route_input_frame(
                                &frame,
                                [left, right],
                                0.5,
                                &mut planar,
                                0,
                                output,
                            );
                            assert_eq!(raw, [frame[left] * 0.5, frame[right] * 0.5]);
                            assert_eq!(planar[0][0], raw[0]);
                            if output >= 2 {
                                assert_eq!(planar[1][0], raw[1]);
                            }
                            assert!(planar.iter().skip(2).all(|channel| channel[0] == 0.0));
                        }),
                        (0, 0)
                    );
                }
            }
        }
    }

    #[test]
    fn unselected_physical_signal_never_reaches_extra_outputs() {
        for (input, output, selected) in [
            (8, 8, [6, 7]),
            (8, 2, [0, 0]),
            (2, 8, [0, 0]),
            (3, 8, [2, 2]),
            (3, 1, [0, 0]),
        ] {
            for active in 0..input {
                if selected.contains(&active) {
                    continue;
                }
                let mut frame = vec![0.0; input];
                frame[active] = 1.0;
                let mut planar = vec![vec![7.0]; output];
                let raw = super::route_input_frame(&frame, selected, 1.0, &mut planar, 0, output);
                assert_eq!(raw, [0.0, 0.0]);
                assert!(planar.iter().all(|channel| channel[0] == 0.0));
            }
        }
    }

    #[test]
    fn physical_queue_routes_all_pairs_across_wrap_and_full_without_allocating() {
        use ringbuf::{traits::*, HeapRb};
        for channels in [1, 2, 3, 8] {
            let (mut tx, mut rx) = HeapRb::new(channels * 2).split();
            let samples: Vec<f32> = (0..channels * 3).map(|i| (i + 1) as f32).collect();
            let mut output = vec![0.0; channels * 2];
            let counts = crate::dsp_verification_allocator::allocation_counts(|| {
                for _ in 0..3 {
                    let mut budget = None;
                    let pushed = super::push_mapped_frames(
                        &mut tx,
                        &samples,
                        channels,
                        channels,
                        &mut budget,
                    );
                    assert_eq!((pushed.offered, pushed.accepted), (3, 2));
                    assert_eq!(
                        super::read_complete_frames(&mut rx, &mut output, channels),
                        2
                    );
                    for frame in 0..2 {
                        let values = &output[frame * channels..(frame + 1) * channels];
                        for left in 0..channels {
                            for right in 0..channels {
                                let pair = super::selected_pair(values, [left, right], 0.5);
                                assert_eq!(
                                    pair,
                                    [
                                        samples[frame * channels + left] * 0.5,
                                        samples[frame * channels + right] * 0.5
                                    ]
                                );
                            }
                        }
                    }
                }
            });
            assert_eq!(counts, (0, 0));
            let d = super::QueueDiagnostics::new_input_queue(
                "input".into(),
                48000,
                48000,
                channels as u16,
                2,
                channels * 2,
            );
            let snap = d.snapshot(super::QueueState::Running, Some(channels), None);
            assert_eq!(snap.queue_channels, Some(channels as u16));
            assert_eq!((snap.capacity_frames, snap.current_frames), (2, Some(1)));
        }
    }

    #[test]
    fn legacy_runtime_stats_with_queue_object_keeps_missing_recovery_unknown() {
        use serde_json::json;
        let q = super::QueueDiagnostics::new("old".into(), 48000, 48000, 2, 2, 48000);
        let mut queue =
            serde_json::to_value(q.snapshot(super::QueueState::Stopped, None, Some(0))).unwrap();
        for field in [
            "recoveryDiscardedFrames",
            "recoveryCount",
            "recoveryStatus",
            "recoveryTargetFrames",
            "recoveryHighFrames",
        ] {
            queue.as_object_mut().unwrap().remove(field);
        }
        let mut payload = json!({"queue_diagnostics": queue});
        for key in [
            "active_plugin_count",
            "enabled_plugin_count",
            "pending_unload_count",
            "burned_library_count",
            "max_jitter_us",
            "glitch_count",
            "total_plugin_latency_samples",
            "total_plugin_latency_ms",
            "noise_reduction_latency_samples",
            "noise_reduction_latency_ms",
            "total_chain_latency_samples",
            "total_chain_latency_ms",
            "noise_learning_progress",
            "noise_profile_rms",
            "recommended_noise_mix",
            "noise_control_strength",
            "built_in_effects_amount",
        ] {
            payload[key] = json!(0);
        }
        for key in [
            "global_bypass",
            "noise_reduction_enabled",
            "noise_reduction_active",
            "noise_profile_available",
            "speech_detected",
            "noise_voice_guard",
            "built_in_effects_enabled",
        ] {
            payload[key] = json!(false);
        }
        for key in [
            "noise_reduction_mode",
            "noise_learning_state",
            "built_in_effects_preset",
        ] {
            payload[key] = json!("");
        }
        let response: crate::ipc::Response =
            serde_json::from_value(json!({"type":"RuntimeStats", "payload":payload})).unwrap();
        let crate::ipc::Response::RuntimeStats {
            queue_diagnostics: Some(queue),
            ..
        } = response
        else {
            panic!("旧RuntimeStatsのqueue objectを維持する");
        };
        assert_eq!(queue.epoch, "old");
        assert_eq!(queue.recovery_count, None);
        assert_eq!(queue.recovery_status, None);
        assert_eq!(queue.recovery_discarded_frames, None);
        assert_eq!(queue.recovery_target_frames, None);
        assert_eq!(queue.recovery_high_frames, None);
    }

    #[test]
    fn recovery_discard_is_separate_from_overflow_and_read_count() {
        let q = super::QueueDiagnostics::new("q".into(), 48000, 48000, 2, 22, 48000);
        q.record_input(1000, 1000, 1000, 900, 19800);
        q.record_recovery(300, 2, 512, 1536);
        q.record_output(650, 600);
        let s = q.snapshot(super::QueueState::Stopped, None, Some(0));
        assert_eq!(
            s.accepted_output_frames,
            s.consumed_output_frames + s.recovery_discarded_frames.unwrap()
        );
        assert_eq!(s.dropped_output_frames, 100);
        assert_eq!(s.zero_filled_output_frames, 50);
        assert_eq!((s.recovery_count, s.recovery_status), (Some(1), Some(2)));
        assert_eq!(q.max_burst(), 1000);
    }

    use super::*;
    use ringbuf::{traits::*, HeapRb};

    #[test]
    fn concurrent_partial_publication_is_not_popped_before_the_other_channel() {
        use std::sync::{Arc, Barrier};
        let (mut prod, mut cons) = HeapRb::new(5).split();
        let partial = Arc::new(Barrier::new(2));
        let inspected = Arc::new(Barrier::new(2));
        let complete = Arc::new(Barrier::new(2));
        let producer = {
            let (partial, inspected, complete) =
                (partial.clone(), inspected.clone(), complete.clone());
            std::thread::spawn(move || {
                prod.try_push(0.25).unwrap();
                partial.wait();
                inspected.wait();
                prod.try_push(-0.5).unwrap();
                complete.wait();
            })
        };
        partial.wait();
        let mut output = [7.0; 2];
        assert_eq!(read_complete_frames(&mut cons, &mut output, 2), 0);
        assert_eq!(output, [0.0; 2]);
        assert_eq!(cons.occupied_len(), 1);
        inspected.wait();
        complete.wait();
        assert_eq!(read_complete_frames(&mut cons, &mut output, 2), 1);
        assert_eq!(output, [0.25, -0.5]);
        producer.join().unwrap();
    }

    #[test]
    fn mapped_full_frames_preserve_mono_stereo_and_multichannel_policy() {
        for input_channels in [1, 2, 4, 22] {
            for output_channels in [1, 2, 22] {
                let samples: Vec<_> = (0..input_channels * 3 + input_channels - 1)
                    .map(|slot| slot as f32 + 1.0)
                    .collect();
                let (mut prod, mut cons) = HeapRb::new(output_channels * 3 + 1).split();
                let mut output = vec![9.0; output_channels * 4];
                let mut budget = None;
                let counts = crate::dsp_verification_allocator::allocation_counts(|| {
                    let pushed = push_mapped_frames(
                        &mut prod,
                        &samples,
                        input_channels,
                        output_channels,
                        &mut budget,
                    );
                    assert_eq!((pushed.offered, pushed.accepted), (3, 3));
                    assert_eq!(
                        read_complete_frames(&mut cons, &mut output, output_channels),
                        3
                    );
                });
                assert_eq!(counts, (0, 0));
                for frame in 0..3 {
                    for ch in 0..output_channels {
                        assert_eq!(
                            output[frame * output_channels + ch],
                            samples[frame * input_channels + ch.min(input_channels - 1)]
                        );
                    }
                }
                assert!(output[output_channels * 3..]
                    .iter()
                    .all(|sample| *sample == 0.0));
            }
        }
    }

    #[test]
    fn incomplete_frames_wait_without_rotating_channels_across_wrap_and_non_multiple_capacity() {
        for channels in [1, 2, 22] {
            let (mut prod, mut cons) = HeapRb::new(channels * 2 + 1).split();
            let mut output = vec![9.0; channels * 3];
            for turn in 0..8 {
                let partial = channels - 1;
                for ch in 0..partial {
                    prod.try_push((turn * channels + ch + 1) as f32).unwrap();
                }
                assert_eq!(read_complete_frames(&mut cons, &mut output, channels), 0);
                assert!(output.iter().all(|sample| *sample == 0.0));
                assert_eq!(cons.occupied_len(), partial);
                prod.try_push(((turn + 1) * channels) as f32).unwrap();
                assert_eq!(read_complete_frames(&mut cons, &mut output, channels), 1);
                for (ch, sample) in output.iter().take(channels).enumerate() {
                    assert_eq!(*sample, (turn * channels + ch + 1) as f32);
                }
                assert!(output[channels..].iter().all(|sample| *sample == 0.0));
                assert_eq!(cons.occupied_len(), 0);
            }
        }
    }

    #[test]
    fn burst_budget_mapping_drop_and_zero_fill_are_counted_without_allocations() {
        let (mut prod, mut cons) = HeapRb::new(9).split();
        let diagnostics = QueueDiagnostics::new("attempt-1".into(), 44_100, 48_000, 1, 2, 9);
        let mut output = [0.0; 6];
        let counts = crate::dsp_verification_allocator::allocation_counts(|| {
            let mut budget = None;
            let first = push_mapped_frames(&mut prod, &[1.0, 2.0, 3.0], 1, 2, &mut budget);
            assert_eq!((first.offered, first.accepted), (3, 3));
            let read = read_complete_frames(&mut cons, &mut output, 2);
            diagnostics.record_output(3, read);
            assert_eq!(output, [1.0, 1.0, 2.0, 2.0, 3.0, 3.0]);
            // 同じinput callback中にconsumerが空けても、従来の最初の予算を超えない。
            let second = push_mapped_frames(&mut prod, &[4.0, 5.0, 6.0], 1, 2, &mut budget);
            assert_eq!((second.offered, second.accepted), (3, 1));
            diagnostics.record_input(
                5,
                6,
                6,
                first.accepted + second.accepted,
                first.observed_slots.max(second.observed_slots),
            );
            diagnostics.record_output(3, read_complete_frames(&mut cons, &mut output, 2));
            assert_eq!(output, [4.0, 4.0, 0.0, 0.0, 0.0, 0.0]);
        });
        assert_eq!(counts, (0, 0));
        let snapshot = diagnostics.snapshot(QueueState::Running, Some(1), None);
        assert_eq!(
            (
                snapshot.received_input_frames,
                snapshot.generated_output_frames
            ),
            (5, 6)
        );
        assert_eq!(
            (
                snapshot.offered_output_frames,
                snapshot.accepted_output_frames,
                snapshot.dropped_output_frames
            ),
            (6, 4, 2)
        );
        assert_eq!(
            (
                snapshot.requested_output_frames,
                snapshot.consumed_output_frames,
                snapshot.zero_filled_output_frames
            ),
            (6, 4, 2)
        );
        assert_eq!(
            (snapshot.queue_read_callbacks, snapshot.underflow_callbacks),
            (2, 1)
        );
        assert_eq!(
            (snapshot.capacity_frames, snapshot.capacity_remainder_slots),
            (4, 1)
        );
        assert_eq!(
            (snapshot.current_frames, snapshot.current_partial_slots),
            (Some(0), Some(1))
        );
        assert_eq!(snapshot.max_observed_frames, 3);
        assert_eq!(snapshot.max_observed_audio_ms, Some(0.0625));
    }

    #[test]
    fn stopped_unknown_and_new_epoch_do_not_claim_current_queue_or_sum_attempts() {
        let old = QueueDiagnostics::new("old".into(), 48_000, 96_000, 2, 2, 100);
        old.record_input(48, 96, 96, 50, 100);
        let running = old.snapshot(QueueState::Running, Some(96), None);
        assert_eq!(running.current_audio_ms, Some(0.5));
        assert!(old
            .snapshot(QueueState::Running, Some(101), None)
            .current_frames
            .is_none());
        for state in [
            QueueState::Stopped,
            QueueState::Failed,
            QueueState::Preparing,
        ] {
            let stopped = old.snapshot(state, Some(96), Some(96));
            assert!(stopped.current_frames.is_none() && stopped.current_audio_ms.is_none());
            assert_eq!(stopped.queued_frames_at_stop, Some(48));
            assert_eq!(stopped.dropped_output_frames, 46);
        }
        let next = QueueDiagnostics::new("new".into(), 48_000, 48_000, 2, 2, 100).snapshot(
            QueueState::Running,
            Some(0),
            None,
        );
        assert_ne!(next.epoch, running.epoch);
        assert_eq!(next.received_input_frames, 0);
        assert_eq!(next.max_observed_frames, 0);
        assert!(std::mem::size_of::<QueueDiagnostics>() <= 256);
        let invalid = QueueDiagnostics::new("unknown-rate".into(), 0, 0, 1, 1, 100).snapshot(
            QueueState::Running,
            Some(50),
            None,
        );
        assert!(invalid.current_audio_ms.is_none() && invalid.max_observed_audio_ms.is_none());
    }
}
