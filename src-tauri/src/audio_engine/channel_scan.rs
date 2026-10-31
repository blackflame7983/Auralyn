use ringbuf::traits::Producer;

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

/// 制御側から入力callbackへ有効状態・世代・ゲインを渡す。
pub(super) struct Control {
    ticket: AtomicU64,
    gain: AtomicU32,
}
impl Control {
    pub(super) fn new(enabled: bool, generation: u64, gain: f32) -> Self {
        Self {
            ticket: AtomicU64::new((generation << 1) | u64::from(enabled)),
            gain: AtomicU32::new(gain.to_bits()),
        }
    }
    pub(super) fn set_enabled(&self, enabled: bool, generation: u64) {
        self.ticket
            .store((generation << 1) | u64::from(enabled), Ordering::Release);
    }
    pub(super) fn set_gain(&self, gain: f32) {
        self.gain.store(gain.to_bits(), Ordering::Release);
    }
    pub(super) fn sync(&self, scan: &mut ChannelScan) -> f32 {
        let ticket = self.ticket.load(Ordering::Acquire);
        scan.set_enabled(ticket & 1 != 0, ticket >> 1);
        f32::from_bits(self.gain.load(Ordering::Acquire))
    }
}

const CHANNELS: usize = 32;

#[derive(Clone, Copy)]
pub(super) struct Snapshot {
    pub(super) generation: u64,
    pub(super) peaks: [f32; CHANNELS],
}

pub(super) fn merge(
    current: &mut Option<[f32; CHANNELS]>,
    snapshot: Snapshot,
    generation: u64,
    enabled: bool,
) {
    if !enabled || snapshot.generation != generation {
        return;
    }
    let peaks = current.get_or_insert([0.0; CHANNELS]);
    for (peak, value) in peaks.iter_mut().zip(snapshot.peaks) {
        *peak = peak.max(value);
    }
}

/// 入力ゲイン適用後のピークを通知成功まで保持する。
pub(super) struct ChannelScan {
    peaks: [f32; CHANNELS],
    elapsed: usize,
    interval: usize,
    enabled: bool,
    generation: u64,
}

impl ChannelScan {
    pub(super) fn new(sample_rate: u32, enabled: bool, generation: u64) -> Self {
        Self {
            peaks: [0.0; CHANNELS],
            elapsed: 0,
            interval: (sample_rate as usize / 10).max(1),
            enabled,
            generation,
        }
    }

    pub(super) fn set_enabled(&mut self, enabled: bool, generation: u64) {
        if !enabled || generation != self.generation {
            self.peaks = [0.0; CHANNELS];
            self.elapsed = 0;
        }
        self.enabled = enabled;
        self.generation = generation;
    }

    #[inline]
    pub(super) fn observe(&mut self, channel: usize, sample: f32) {
        if self.enabled && channel < CHANNELS {
            self.peaks[channel] = self.peaks[channel].max(sample.abs());
        }
    }

    pub(super) fn finish_block(
        &mut self,
        frames: usize,
        queue: &mut impl Producer<Item = Snapshot>,
    ) {
        if !self.enabled {
            return;
        }
        self.elapsed = self.elapsed.saturating_add(frames);
        if self.elapsed >= self.interval
            && queue
                .try_push(Snapshot {
                    generation: self.generation,
                    peaks: self.peaks,
                })
                .is_ok()
        {
            self.peaks = [0.0; CHANNELS];
            self.elapsed %= self.interval;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;
    use ringbuf::{
        traits::{Consumer, Split},
        HeapRb,
    };

    #[test]
    fn control_observes_physical_channels_with_gain_and_latest_generation() {
        let control = Control::new(false, 0, 1.0);
        let mut scan = ChannelScan::new(100, false, 0);
        let (mut tx, mut rx) = HeapRb::new(2).split();
        control.set_enabled(true, 1);
        control.set_gain(0.5);
        assert_eq!(
            allocation_counts(|| {
                let gain = control.sync(&mut scan);
                scan.observe(7, -0.8 * gain);
                scan.finish_block(10, &mut tx);
            }),
            (0, 0)
        );
        let snapshot = rx.try_pop().unwrap();
        assert_eq!(snapshot.generation, 1);
        assert_eq!(snapshot.peaks[7], 0.4);
        control.set_enabled(false, 2);
        control.sync(&mut scan);
        scan.observe(7, 1.0);
        scan.finish_block(10, &mut tx);
        assert!(rx.try_pop().is_none());
    }

    #[test]
    fn retains_early_signal_until_rate_dependent_interval() {
        for rate in [44_100, 48_000, 96_000] {
            let (mut tx, mut rx) = HeapRb::new(2).split();
            let mut scan = ChannelScan::new(rate, true, 0);
            scan.observe(0, -0.75);
            scan.finish_block(1, &mut tx);
            scan.finish_block(rate as usize / 10 - 2, &mut tx);
            assert!(rx.try_pop().is_none());
            scan.finish_block(1, &mut tx);
            assert_eq!(rx.try_pop().unwrap().peaks[0], 0.75);
        }
    }

    #[test]
    fn full_queue_retries_peak_and_disable_discards_pending() {
        let (mut tx, mut rx) = HeapRb::new(1).split();
        let mut scan = ChannelScan::new(100, true, 0);
        scan.observe(0, 0.2);
        scan.finish_block(10, &mut tx);
        scan.observe(1, 0.8);
        scan.finish_block(10, &mut tx);
        assert_eq!(rx.try_pop().unwrap().peaks[0], 0.2);
        scan.finish_block(1, &mut tx);
        assert_eq!(rx.try_pop().unwrap().peaks[1], 0.8);
        scan.observe(2, 0.9);
        scan.set_enabled(false, 1);
        scan.set_enabled(true, 2);
        scan.finish_block(10, &mut tx);
        assert_eq!(rx.try_pop().unwrap().peaks[2], 0.0);
    }

    #[test]
    fn bounds_and_full_queue_path_do_not_allocate() {
        let (mut tx, mut rx) = HeapRb::new(1).split();
        let mut scan = ChannelScan::new(100, true, 0);
        assert_eq!(
            allocation_counts(|| {
                scan.observe(31, -0.6);
                scan.observe(32, 1.0);
                scan.finish_block(10, &mut tx);
                scan.observe(0, 0.7);
                scan.finish_block(10, &mut tx);
                let first = rx.try_pop().unwrap();
                assert_eq!(first.peaks[31], 0.6);
                scan.finish_block(1, &mut tx);
                assert_eq!(rx.try_pop().unwrap().peaks[0], 0.7);
                scan.set_enabled(false, 1);
            }),
            (0, 0)
        );
    }
    #[test]
    fn merge_keeps_short_peaks_and_rejects_old_or_disabled_snapshots() {
        let mut result = None;
        let mut old = [0.0; CHANNELS];
        old[0] = 0.9;
        merge(
            &mut result,
            Snapshot {
                generation: 1,
                peaks: old,
            },
            2,
            true,
        );
        merge(
            &mut result,
            Snapshot {
                generation: 2,
                peaks: old,
            },
            2,
            false,
        );
        assert!(result.is_none());
        let mut first = [0.0; CHANNELS];
        first[1] = 0.8;
        merge(
            &mut result,
            Snapshot {
                generation: 2,
                peaks: first,
            },
            2,
            true,
        );
        merge(
            &mut result,
            Snapshot {
                generation: 2,
                peaks: [0.0; CHANNELS],
            },
            2,
            true,
        );
        assert_eq!(result.unwrap()[1], 0.8);
    }
}
