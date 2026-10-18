use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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

pub fn normalized_channels(asio: bool, selected: [usize; 2], channels: usize) -> [usize; 2] {
    if asio && selected.iter().all(|c| *c < channels) {
        selected
    } else {
        [0, usize::from(channels > 1)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
