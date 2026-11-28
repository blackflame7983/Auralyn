use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallbackSnapshot {
    pub count: u64,
    pub min_frames: u64,
    pub max_frames: u64,
    pub total_processing_us: u64,
    pub max_processing_us: u64,
}

pub struct CallbackDiagnostics {
    count: AtomicU64,
    min_frames: AtomicU64,
    max_frames: AtomicU64,
    total_processing_us: AtomicU64,
    max_processing_us: AtomicU64,
}
impl Default for CallbackDiagnostics {
    fn default() -> Self {
        Self {
            count: AtomicU64::new(0),
            min_frames: AtomicU64::new(u64::MAX),
            max_frames: AtomicU64::new(0),
            total_processing_us: AtomicU64::new(0),
            max_processing_us: AtomicU64::new(0),
        }
    }
}
impl CallbackDiagnostics {
    pub fn record(&self, frames: usize, processing_us: u64) {
        self.count.fetch_add(1, Ordering::Relaxed);
        self.min_frames.fetch_min(frames as u64, Ordering::Relaxed);
        self.max_frames.fetch_max(frames as u64, Ordering::Relaxed);
        self.total_processing_us
            .fetch_add(processing_us, Ordering::Relaxed);
        self.max_processing_us
            .fetch_max(processing_us, Ordering::Relaxed);
    }
    pub fn snapshot(&self) -> CallbackSnapshot {
        let count = self.count.load(Ordering::Relaxed);
        CallbackSnapshot {
            count,
            min_frames: if count == 0 {
                0
            } else {
                self.min_frames.load(Ordering::Relaxed)
            },
            max_frames: self.max_frames.load(Ordering::Relaxed),
            total_processing_us: self.total_processing_us.load(Ordering::Relaxed),
            max_processing_us: self.max_processing_us.load(Ordering::Relaxed),
        }
    }
}

// 起動待ちを除外し、要求サイズではなく直前の実コールバックの再生時間と比べる。
pub fn callback_lateness(elapsed: Duration, previous_frames: usize, rate: u32) -> (u64, bool) {
    if previous_frames == 0 || rate == 0 {
        return (0, false);
    }
    let period = previous_frames as u64 * 1_000_000 / rate as u64;
    let late = (elapsed.as_micros() as u64).saturating_sub(period);
    (late, late > period / 2)
}

/// OSから呼ばれた出力callbackだけを観測する。配信workerの追い付き処理は含めない。
pub struct OutputCadence {
    previous: Option<(Instant, usize)>,
    rate: u32,
}
impl OutputCadence {
    pub fn new(rate: u32) -> Self {
        Self {
            previous: None,
            rate,
        }
    }
    pub fn record(&mut self, frames: usize, max_late: &AtomicU64, late_count: &AtomicU64) {
        self.record_at(Instant::now(), frames, max_late, late_count);
    }
    fn record_at(
        &mut self,
        now: Instant,
        frames: usize,
        max_late: &AtomicU64,
        late_count: &AtomicU64,
    ) {
        if let Some((previous, previous_frames)) = self.previous {
            let (late, missed) =
                callback_lateness(now.duration_since(previous), previous_frames, self.rate);
            max_late.fetch_max(late, Ordering::Relaxed);
            if missed {
                late_count.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.previous = Some((now, frames));
    }
}

pub fn normalized_channels(asio: bool, selected: [usize; 2], channels: usize) -> [usize; 2] {
    if asio && selected.iter().all(|c| *c < channels) {
        selected
    } else {
        [0, usize::from(channels > 1)]
    }
}

pub fn valid_input_channels(running: bool, selected: [usize; 2], channels: usize) -> bool {
    !running || selected.iter().all(|&channel| channel < channels)
}

/// WASAPIの従来のステレオ要求は、物理monoでも安全に同じ入力へ写像する。
pub fn requested_channels(
    asio: bool,
    running: bool,
    selected: [usize; 2],
    channels: usize,
) -> Option<[usize; 2]> {
    let selected = if asio {
        selected
    } else {
        normalized_channels(false, selected, channels)
    };
    valid_input_channels(running, selected, channels).then_some(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_cadence_uses_actual_device_blocks_and_excludes_startup() {
        let mut cadence = OutputCadence::new(48000);
        let max = AtomicU64::new(0);
        let count = AtomicU64::new(0);
        let start = Instant::now();
        cadence.record_at(start, 960, &max, &count);
        cadence.record_at(start + Duration::from_millis(20), 480, &max, &count);
        cadence.record_at(start + Duration::from_millis(30), 480, &max, &count);
        assert_eq!(max.load(Ordering::Relaxed), 0);
        assert_eq!(count.load(Ordering::Relaxed), 0);
        cadence.record_at(start + Duration::from_millis(47), 480, &max, &count);
        assert_eq!(max.load(Ordering::Relaxed), 7000);
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }
    #[test]
    fn actual_buffer_sizes_do_not_count_as_late() {
        assert_eq!(
            callback_lateness(Duration::from_millis(20), 960, 48000),
            (0, false)
        );
        assert_eq!(
            callback_lateness(Duration::from_millis(10), 480, 48000),
            (0, false)
        );
        assert_eq!(
            callback_lateness(Duration::from_millis(31), 960, 48000),
            (11000, true)
        );
        assert_eq!(
            callback_lateness(Duration::from_secs(10), 0, 48000),
            (0, false)
        );
    }
    #[test]
    fn channel_switch_and_invalid_saved_pairs_are_safe() {
        assert_eq!(normalized_channels(false, [6, 7], 2), [0, 1]);
        assert_eq!(normalized_channels(false, [6, 7], 1), [0, 0]);
        assert_eq!(normalized_channels(true, [6, 7], 22), [6, 7]);
        assert_eq!(normalized_channels(true, [6, 7], 2), [0, 1]);
    }
    #[test]
    fn explicit_selection_rejects_out_of_range_only_when_running() {
        assert!(valid_input_channels(false, [6, 7], 2));
        assert!(valid_input_channels(true, [6, 7], 8));
        assert!(valid_input_channels(true, [2, 2], 3));
        assert!(valid_input_channels(true, [0, 0], 1));
        assert!(!valid_input_channels(true, [6, 8], 8));
        assert!(!valid_input_channels(true, [1, 0], 1));
        assert_eq!(normalized_channels(true, [6, 7], 2), [0, 1]);
        assert_eq!(normalized_channels(false, [2, 2], 3), [0, 1]);
    }

    #[test]
    fn legacy_wasapi_pair_is_mono_safe_but_asio_never_silently_changes_a_request() {
        assert_eq!(requested_channels(false, true, [0, 1], 1), Some([0, 0]));
        assert_eq!(requested_channels(false, true, [6, 7], 2), Some([0, 1]));
        assert_eq!(requested_channels(true, true, [0, 1], 1), None);
        assert_eq!(requested_channels(true, true, [6, 7], 8), Some([6, 7]));
        assert_eq!(requested_channels(true, false, [6, 7], 2), Some([6, 7]));
    }
    #[test]
    fn diagnostics_report_actual_size_and_processing_without_allocating() {
        let d = CallbackDiagnostics::default();
        let counts = crate::dsp_verification_allocator::allocation_counts(|| {
            d.record(960, 300);
            d.record(480, 100);
        });
        assert_eq!(counts, (0, 0));
        let s = d.snapshot();
        assert_eq!(
            (
                s.count,
                s.min_frames,
                s.max_frames,
                s.total_processing_us,
                s.max_processing_us
            ),
            (2, 480, 960, 400, 300)
        );
    }
}
