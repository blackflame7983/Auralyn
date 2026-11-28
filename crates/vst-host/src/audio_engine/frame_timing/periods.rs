//! 非RT側の固定容量・秒単位集計。完了した直近30秒と起動後3秒を分離する。
use super::{cohort::ArrivalRange, QuantileRange, BUCKETS, BUCKET_NS};
use serde::{Deserialize, Serialize};
const SECOND: u64 = 1_000_000_000;
const SECONDS: usize = 31;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Distribution {
    pub matched_frames: u64,
    pub earliest_arrival_to_end: ArrivalRange,
    pub latest_arrival_to_end: ArrivalRange,
}
struct Histogram {
    earliest: Box<[u64]>,
    latest: Box<[u64]>,
    count: u64,
}
impl Histogram {
    fn new() -> Self {
        Self {
            earliest: vec![0; BUCKETS].into_boxed_slice(),
            latest: vec![0; BUCKETS].into_boxed_slice(),
            count: 0,
        }
    }
    fn clear(&mut self) {
        self.earliest.fill(0);
        self.latest.fill(0);
        self.count = 0;
    }
    fn add(&mut self, earliest: usize, latest: usize, count: u64) {
        self.earliest[earliest] += count;
        self.latest[latest] += count;
        self.count += count;
    }
    fn distribution(&self) -> Distribution {
        Distribution {
            matched_frames: self.count,
            earliest_arrival_to_end: ArrivalRange {
                p50: quantile(&self.earliest, self.count, 50),
                p95: quantile(&self.earliest, self.count, 95),
            },
            latest_arrival_to_end: ArrivalRange {
                p50: quantile(&self.latest, self.count, 50),
                p95: quantile(&self.latest, self.count, 95),
            },
        }
    }
}
fn quantile(hist: &[u64], count: u64, percent: u64) -> Option<QuantileRange> {
    if count == 0 {
        return None;
    }
    let rank = (u128::from(count) * u128::from(percent)).div_ceil(100) as u64;
    let mut total = 0;
    for (i, n) in hist.iter().enumerate() {
        total += n;
        if total >= rank {
            return Some(QuantileRange {
                lower_ms: i as f64 * 0.1,
                upper_ms: (i + 1 < BUCKETS).then_some((i + 1) as f64 * 0.1),
            });
        }
    }
    None
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub window_seconds: u32,
    pub update_interval_ms: u32,
    pub startup_duration_ms: u32,
    pub start_ns: Option<String>,
    pub end_ns: String,
    pub recent: Distribution,
    pub startup: Distribution,
    pub steady: Distribution,
}
pub struct Periods {
    slots: Vec<(Option<u64>, Histogram)>,
    startup: Histogram,
    steady: Histogram,
    start: Option<u64>,
    now: u64,
    published_second: Option<u64>,
    published: Snapshot,
    scratch: Histogram,
}
impl Periods {
    pub fn new() -> Self {
        let empty = Histogram::new().distribution();
        Self {
            slots: (0..SECONDS).map(|_| (None, Histogram::new())).collect(),
            startup: Histogram::new(),
            steady: Histogram::new(),
            start: None,
            now: 0,
            published_second: None,
            published: Snapshot {
                window_seconds: 30,
                update_interval_ms: 1000,
                startup_duration_ms: 3000,
                start_ns: None,
                end_ns: "0".into(),
                recent: empty.clone(),
                startup: empty.clone(),
                steady: empty,
            },
            scratch: Histogram::new(),
        }
    }
    pub fn reset(&mut self, start: u64) {
        for (second, hist) in &mut self.slots {
            *second = None;
            hist.clear();
        }
        self.startup.clear();
        self.steady.clear();
        self.start = Some(start);
        self.published_second = None;
        self.publish(self.now.max(start));
    }
    pub fn record(&mut self, end: u64, earliest: u64, latest: u64, count: u64) {
        let first = self.start.unwrap_or(end);
        self.start = Some(first);
        let e = ((end - earliest) / BUCKET_NS).min((BUCKETS - 1) as u64) as usize;
        let l = ((end - latest) / BUCKET_NS).min((BUCKETS - 1) as u64) as usize;
        if end.saturating_sub(first) < 3 * SECOND {
            self.startup.add(e, l, count);
        } else {
            self.steady.add(e, l, count);
        }
        let second = end / SECOND;
        // 回収が30秒以上遅れたmetadataは累積には残すが直近枠を上書きしない。
        if second + 30 < self.now / SECOND {
            return;
        }
        let (tag, hist) = &mut self.slots[second as usize % SECONDS];
        if *tag != Some(second) {
            *tag = Some(second);
            hist.clear();
        }
        hist.add(e, l, count);
    }
    pub fn publish(&mut self, now: u64) {
        self.now = self.now.max(now);
        let second = self.now / SECOND;
        if self.published_second == Some(second) {
            return;
        }
        self.published_second = Some(second);
        let recent = &mut self.scratch;
        recent.clear();
        for (tag, hist) in &self.slots {
            if tag.is_some_and(|s| s < second && s >= second.saturating_sub(30)) {
                for i in 0..BUCKETS {
                    recent.earliest[i] += hist.earliest[i];
                    recent.latest[i] += hist.latest[i];
                }
                recent.count += hist.count;
            }
        }
        self.published = Snapshot {
            window_seconds: 30,
            update_interval_ms: 1000,
            startup_duration_ms: 3000,
            start_ns: self
                .start
                .filter(|s| *s <= second * SECOND)
                .map(|s| s.max(second.saturating_sub(30) * SECOND).to_string()),
            end_ns: (second * SECOND).to_string(),
            recent: recent.distribution(),
            startup: self.startup.distribution(),
            steady: self.steady.distribution(),
        };
    }
    pub fn snapshot(&self) -> Snapshot {
        self.published.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "任意実行の非RT時間計測。実機・Engine全体の性能保証ではない"]
    fn measure_fixed_period_publication_cost() {
        let mut p = Periods::new();
        p.reset(0);
        let mut elapsed = [0u128; 600];
        for (second, sample) in elapsed.iter_mut().enumerate() {
            let end = second as u64 * SECOND + SECOND / 2;
            p.record(end, end - 10_000_000, end - 5_000_000, 48000);
            let start = std::time::Instant::now();
            p.publish((second as u64 + 1) * SECOND);
            *sample = start.elapsed().as_nanos();
            std::hint::black_box(p.snapshot());
        }
        elapsed.sort_unstable();
        println!(
            "period publication p50={}ns p95={}ns max={}ns histogramPayload={}B",
            elapsed[299],
            elapsed[569],
            elapsed[599],
            (SECONDS + 3) * 2 * BUCKETS * std::mem::size_of::<u64>()
        );
        assert_eq!(p.snapshot().recent.matched_frames, 30 * 48000);
    }
    #[test]
    fn seconds_expire_without_new_audio_and_startup_is_separate() {
        let mut p = Periods::new();
        p.reset(0);
        p.record(SECOND, SECOND - 1_000_000, SECOND - 1_000_000, 100);
        p.record(
            3 * SECOND,
            3 * SECOND - 10_000_000,
            3 * SECOND - 10_000_000,
            1,
        );
        p.publish(4 * SECOND);
        let s = p.snapshot();
        assert_eq!(s.recent.matched_frames, 101);
        assert_eq!(s.startup.matched_frames, 100);
        assert_eq!(s.steady.matched_frames, 1);
        assert_eq!(s.recent.earliest_arrival_to_end.p95.unwrap().lower_ms, 1.0);
        p.publish(32 * SECOND);
        assert_eq!(p.snapshot().recent.matched_frames, 1);
        p.publish(34 * SECOND);
        assert_eq!(p.snapshot().recent.matched_frames, 0);
        assert!(p.snapshot().recent.earliest_arrival_to_end.p50.is_none());
        assert_eq!(p.snapshot().startup.matched_frames, 100);
    }
    #[test]
    fn completed_seconds_update_once_per_second_and_reset_discards_previous_window() {
        let mut p = Periods::new();
        p.reset(0);
        p.record(SECOND / 2, 0, 0, 1);
        p.publish(SECOND - 1);
        assert_eq!(p.snapshot().recent.matched_frames, 0);
        p.publish(SECOND);
        assert_eq!(p.snapshot().recent.matched_frames, 1);
        p.reset(SECOND);
        assert_eq!(p.snapshot().recent.matched_frames, 0);
        assert_eq!(p.snapshot().startup.matched_frames, 0);
        p.record(2 * SECOND, SECOND, SECOND, 1);
        p.publish(3 * SECOND);
        assert_eq!(p.snapshot().startup.matched_frames, 1);
        assert_eq!(
            p.snapshot()
                .recent
                .earliest_arrival_to_end
                .p50
                .unwrap()
                .upper_ms,
            None
        );
    }
}
