//! 自動ゲインの解析・録音受け渡し。解析と試聴ストリームの生成はRT外で行う。
use super::loudness::LoudnessMeter;
use anyhow::{anyhow, Result};
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapRb,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc,
};

pub fn capture_channels(left: f32, right: f32, same_physical_channel: bool) -> [f32; 2] {
    // 通常出力はRを後に書くため、同じ出力番号ではRの値が実サンプルになる。
    if same_physical_channel {
        [right, 0.0]
    } else {
        [left, right]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Request {
    Status,
    Initialize {
        value: f32,
    },
    Devices,
    Begin {
        target: f64,
        revision: u64,
    },
    Cancel,
    Preview {
        id: u64,
        after: bool,
        device: String,
    },
    StopPreview,
    Apply {
        id: u64,
        revision: u64,
    },
    Restore {
        id: u64,
        revision: u64,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub before: f32,
    pub after: f32,
    pub measured: f64,
    pub predicted: f64,
    pub peak: f64,
    pub limited: bool,
}

pub fn analyze(samples: &[[f32; 2]], rate: u32, before: f32, target: f64) -> Result<Proposal> {
    if ![-26.0, -23.0, -20.0, -17.0, -14.0].contains(&target)
        || !before.is_finite()
        || before <= 0.0
        || before > 2.0
        || !(44_100..=192_000).contains(&rate)
    {
        return Err(anyhow!(
            "目標・出力ゲイン・サンプルレートを確認してください"
        ));
    }
    let mut meter = LoudnessMeter::new(rate);
    meter.reset(Some(1));
    let mut windows = Vec::new();
    let mut peak = f64::NEG_INFINITY;
    let mut active_frames = 0;
    for frame in samples {
        if frame.iter().any(|s| !s.is_finite()) {
            return Err(anyhow!("録音に不正な値が含まれています"));
        }
        let output = [frame[0] * before, frame[1] * before];
        if output.iter().any(|s| !s.is_finite()) {
            return Err(anyhow!(
                "出力音量が大きすぎます。手動で下げてから録り直してください"
            ));
        }
        if output.iter().any(|x| x.abs() > 0.001) {
            active_frames += 1;
        }
        if let Some(r) = meter.sample(output) {
            if let Some(p) = r.true_peak_dbtp {
                peak = peak.max(p);
            }
            if r.ready && !r.silent {
                if let Some(l) = r.short_term_lufs {
                    windows.push(l);
                }
            }
        }
    }
    // 末尾の短い過大音も解析対象に含める（音声自体は延長しない）。
    for _ in 0..(rate / 10 + 16) {
        if let Some(r) = meter.sample([0.0, 0.0]) {
            if let Some(p) = r.true_peak_dbtp {
                peak = peak.max(p);
            }
        }
    }
    if active_frames < rate as usize * 3 || windows.len() < 3 || !peak.is_finite() {
        return Err(anyhow!(
            "声を十分に確認できませんでした。普段の声で3秒以上話して録り直してください"
        ));
    }
    windows.sort_by(f64::total_cmp);
    let measured = windows[windows.len() / 2];
    let wanted = target - measured;
    let delta = wanted
        .min(-2.0 - peak)
        .min(6.0)
        .min(20.0 * (2.0 / before as f64).log10());
    let after = (before as f64 * 10.0_f64.powf(delta / 20.0)) as f32;
    Ok(Proposal {
        before,
        after,
        measured,
        predicted: measured + delta,
        peak: peak + delta,
        limited: delta < wanted - 0.05,
    })
}

#[derive(Clone, Copy)]
pub struct Frame {
    pub id: u64,
    pub samples: [f32; 2],
}
pub type CaptureConsumer = <HeapRb<Frame> as Split>::Cons;
pub type CaptureProducer = <HeapRb<Frame> as Split>::Prod;

#[derive(Default)]
pub struct Shared {
    pub requested: AtomicU64,
    pub active: AtomicU64,
    pub done: AtomicU64,
    pub failed: AtomicBool,
    pub confirmed_gain: AtomicU32,
    pub settled: AtomicBool,
    pub applied_revision: AtomicU64,
}

pub fn capture_queue() -> (CaptureProducer, CaptureConsumer) {
    HeapRb::<Frame>::new(32768).split()
}

pub struct RtCapture {
    pub shared: Arc<Shared>,
    producer: CaptureProducer,
    id: u64,
    frames: usize,
    max_frames: usize,
}
impl RtCapture {
    pub fn start(&self, id: u64) {
        if self.shared.requested.load(Ordering::Acquire) == id {
            self.shared.active.store(id, Ordering::Release);
            if self.shared.requested.load(Ordering::Acquire) != id {
                let _ =
                    self.shared
                        .active
                        .compare_exchange(id, 0, Ordering::AcqRel, Ordering::Acquire);
            }
        }
    }
    pub fn is_active(&self) -> bool {
        let id = self.shared.active.load(Ordering::Acquire);
        id != 0 && self.shared.requested.load(Ordering::Acquire) == id
    }
    pub fn new(shared: Arc<Shared>, producer: CaptureProducer, rate: u32) -> Self {
        Self {
            shared,
            producer,
            id: 0,
            frames: 0,
            max_frames: rate as usize * 10,
        }
    }
    pub fn sample(&mut self, samples: [f32; 2], invalid_input: bool) {
        let id = self.shared.active.load(Ordering::Acquire);
        if id == 0 || self.shared.requested.load(Ordering::Acquire) != id {
            return;
        }
        if id != self.id {
            self.id = id;
            self.frames = 0;
        }
        if invalid_input || self.producer.try_push(Frame { id, samples }).is_err() {
            self.shared.failed.store(true, Ordering::Release);
            self.shared.active.store(0, Ordering::Release);
            self.shared.done.store(id, Ordering::Release);
            return;
        }
        self.frames += 1;
        if self.frames >= self.max_frames {
            self.shared.active.store(0, Ordering::Release);
            self.shared.done.store(id, Ordering::Release);
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PreviewDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub gain: f32,
    pub confirmed_gain: f32,
    pub settled: bool,
    pub running: bool,
    pub stream_failed: bool,
    pub id: u64,
    pub phase: String,
    pub progress: f32,
    pub proposal: Option<Proposal>,
    pub playing: bool,
    pub error: Option<String>,
    pub devices: Vec<PreviewDevice>,
}

pub struct Session {
    pub id: u64,
    pub revision: u64,
    pub phase: String,
    pub target: f64,
    pub before: f32,
    pub rate: u32,
    pub samples: Vec<[f32; 2]>,
    pub proposal: Option<Proposal>,
    pub error: Option<String>,
    pub started: std::time::Instant,
}
impl Session {
    pub fn accepts(&self, id: u64, revision: u64, current_revision: u64, restore: bool) -> bool {
        self.id == id
            && revision == current_revision
            && self.revision == current_revision
            && self.phase == if restore { "applied" } else { "ready" }
    }
    pub fn drain(&mut self, consumer: &mut CaptureConsumer) {
        while let Some(frame) = consumer.try_pop() {
            if frame.id == self.id
                && self.phase == "recording"
                && self.samples.len() < self.rate as usize * 10
            {
                self.samples.push(frame.samples);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_output_uses_last_written_channel_once() {
        assert_eq!(capture_channels(0.1, 0.2, true), [0.2, 0.0]);
        assert_eq!(capture_channels(0.1, 0.2, false), [0.1, 0.2]);
    }
    #[test]
    fn delayed_start_does_not_survive_cancel() {
        let shared = Arc::new(Shared::default());
        let (prod, _) = capture_queue();
        let rt = RtCapture::new(shared.clone(), prod, 48000);
        shared.requested.store(7, Ordering::Release);
        shared.requested.store(0, Ordering::Release);
        rt.start(7);
        assert_eq!(shared.active.load(Ordering::Acquire), 0);
        shared.requested.store(8, Ordering::Release);
        rt.start(8);
        assert_eq!(shared.active.load(Ordering::Acquire), 8);
    }
    fn tone(amplitude: f32) -> Vec<[f32; 2]> {
        (0..48000 * 10)
            .map(|i| {
                let x = amplitude * (i as f32 * std::f32::consts::TAU * 440.0 / 48000.0).sin();
                [x, x]
            })
            .collect()
    }
    #[test]
    fn gain_matches_target_without_double_gain() {
        let s = tone(0.1);
        let p = analyze(&s, 48000, 0.8, -20.0).unwrap();
        let after = analyze(&s, 48000, p.after, -20.0).unwrap();
        assert!((after.measured - p.predicted).abs() < 0.02);
        assert!((after.measured + 20.0).abs() < 0.1);
    }
    #[test]
    fn silence_short_nonfinite_and_zero_gain_are_rejected() {
        assert!(analyze(&vec![[0.0; 2]; 48000 * 10], 48000, 1.0, -20.0).is_err());
        assert!(analyze(&tone(0.1)[..48000], 48000, 1.0, -20.0).is_err());
        assert!(analyze(&[[f32::NAN, 0.0]], 48000, 1.0, -20.0).is_err());
        assert!(analyze(&tone(0.1), 48000, 0.0, -20.0).is_err());
    }
    #[test]
    fn limits_peak_boost_and_absolute_gain() {
        let mut s = tone(0.02);
        s[479999] = [0.99; 2];
        let p = analyze(&s, 48000, 1.0, -14.0).unwrap();
        assert!(p.peak <= -1.999 && p.after <= 2.0 && p.limited);
        let p = analyze(&tone(0.01), 48000, 1.0, -14.0).unwrap();
        assert!(20.0 * p.after.log10() <= 6.001);
    }
    #[test]
    fn capture_is_bounded_and_overflow_invalidates() {
        let shared = Arc::new(Shared::default());
        let (prod, mut cons) = capture_queue();
        let mut rt = RtCapture::new(shared.clone(), prod, 1);
        shared.active.store(7, Ordering::Release);
        shared.requested.store(7, Ordering::Release);
        for _ in 0..20 {
            rt.sample([0.1; 2], false);
        }
        assert_eq!(shared.done.load(Ordering::Acquire), 7);
        assert_eq!((0..20).filter_map(|_| cons.try_pop()).count(), 10);
        let (prod, _) = capture_queue();
        let mut rt = RtCapture::new(shared.clone(), prod, 48000);
        shared.active.store(8, Ordering::Release);
        shared.requested.store(8, Ordering::Release);
        for _ in 0..32769 {
            rt.sample([0.1; 2], false);
        }
        assert!(shared.failed.load(Ordering::Acquire));
    }
    #[test]
    fn stale_proposals_and_restore_after_manual_changes_are_refused() {
        let mut s = Session {
            id: 11,
            revision: 12,
            phase: "applied".into(),
            target: -20.0,
            before: 1.0,
            rate: 48000,
            samples: Vec::new(),
            proposal: None,
            error: None,
            started: std::time::Instant::now(),
        };
        assert!(s.accepts(11, 12, 12, true));
        assert!(!s.accepts(11, 12, 13, true));
        assert!(!s.accepts(10, 12, 12, true));
        assert!(!s.accepts(11, 12, 12, false));
        s.phase = "ready".into();
        assert!(s.accepts(11, 12, 12, false));
        s.phase = "invalid".into();
        assert!(!s.accepts(11, 12, 12, false));
    }
    #[test]
    fn realtime_capture_does_not_allocate_or_free_and_ignores_canceled_ids() {
        let shared = Arc::new(Shared::default());
        let (prod, mut cons) = capture_queue();
        let mut rt = RtCapture::new(shared.clone(), prod, 48000);
        shared.active.store(4, Ordering::Release);
        shared.requested.store(4, Ordering::Release);
        let counts = crate::dsp_verification_allocator::allocation_counts(|| {
            for _ in 0..1000 {
                rt.sample([0.1; 2], false);
            }
            shared.active.store(0, Ordering::Release);
            rt.sample([0.1; 2], false);
        });
        assert_eq!(counts, (0, 0));
        assert_eq!((0..1100).filter_map(|_| cons.try_pop()).count(), 1000);
    }
}
