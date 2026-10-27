//! 主出力を待たせない配信sink。音声は完全なstereo frame単位で転送する。
use super::core::lifecycle::{callback_owner, CallbackOwner, ControlOwner};
use anyhow::{anyhow, ensure, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapRb,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub split_processing: bool,
    #[serde(default)]
    pub monitor_singing: Option<super::builtin::Config>,
    #[serde(default)]
    pub monitor_talk: Option<super::builtin::Config>,
    pub device_id: Option<String>,
    pub monitor_trim: f32,
    pub broadcast_trim: f32,
    pub monitor_muted: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            split_processing: false,
            monitor_singing: None,
            monitor_talk: None,
            device_id: None,
            monitor_trim: 1.0,
            broadcast_trim: 1.0,
            monitor_muted: false,
        }
    }
}
impl Config {
    pub fn same_route(&self, other: &Self) -> bool {
        self.device_id == other.device_id
            && self.split_processing == other.split_processing
            && self.monitor_singing == other.monitor_singing
            && self.monitor_talk == other.monitor_talk
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.device_id
                .as_ref()
                .is_none_or(|id| !id.is_empty() && id.len() <= 4096),
            "配信出力の識別情報が不正です"
        );
        ensure!(
            [self.monitor_trim, self.broadcast_trim]
                .iter()
                .all(|n| n.is_finite() && (0.0..=1.0).contains(n)),
            "出力trimは0〜1で指定してください"
        );
        if self.split_processing {
            ensure!(self.device_id.is_some(), "処理分離には配信用出力が必要です");
            for value in [&self.monitor_singing, &self.monitor_talk] {
                value
                    .clone()
                    .ok_or_else(|| anyhow!("自分用の歌・雑談設定を明示してください"))?
                    .normalize()
                    .map_err(|e| anyhow!(e))?;
            }
            ensure!(
                !self
                    .monitor_talk
                    .as_ref()
                    .is_some_and(|c| c.reverb.is_some_and(|r| r.enabled)),
                "自分用の雑談モードは残響をOFFにしてください"
            );
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Shared {
    source_active: AtomicBool,
    active: AtomicBool,
    failed: AtomicBool,
    muted: AtomicBool,
    generation: AtomicU64,
    monitor_trim: AtomicU32,
    broadcast_trim: AtomicU32,
    monitor_muted: AtomicBool,
    offered: AtomicU64,
    consumed: AtomicU64,
    zero: AtomicU64,
    dropped: AtomicU64,
    queued: AtomicU64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub config: Config,
    pub sink: Option<Snapshot>,
    pub error: Option<String>,
    pub broadcast_epoch: Option<String>,
    pub monitor: Option<MonitorSnapshot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub epoch: String,
    pub broadcast_queue_frames: u64,
    pub offered_frames: u64,
    pub dropped_frames: u64,
    pub accepted_revision: String,
    pub completed_revision: String,
    pub broadcast_failed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active: bool,
    pub failed: bool,
    pub queued_frames: u64,
    pub offered_frames: u64,
    pub consumed_frames: u64,
    pub zero_filled_frames: u64,
    pub dropped_frames: u64,
    pub rate_hz: u32,
}
#[derive(Clone, Copy)]
struct Frame {
    sample: [f32; 2],
    generation: u64,
}
type Tx = <HeapRb<Frame> as Split>::Prod;
type Rx = <HeapRb<Frame> as Split>::Cons;
pub struct Sender {
    tx: Tx,
    shared: Arc<Shared>,
    block_generation: u64,
}
impl Sender {
    pub fn begin_block(&mut self) {
        self.block_generation = self.shared.generation.load(Ordering::Acquire);
    }
    pub fn normal(&mut self, active: bool) {
        if self.shared.source_active.swap(active, Ordering::AcqRel) != active {
            self.shared.generation.fetch_add(1, Ordering::AcqRel);
        }
    }
    pub fn send(&mut self, sample: [f32; 2]) {
        if !self.shared.active.load(Ordering::Acquire)
            || self.shared.muted.load(Ordering::Acquire)
            || self.block_generation != self.shared.generation.load(Ordering::Acquire)
        {
            return;
        }
        let sample = sample.map(|v| if v.is_finite() { v } else { 0.0 });
        self.shared.offered.fetch_add(1, Ordering::Relaxed);
        if self
            .tx
            .try_push(Frame {
                sample,
                generation: self.block_generation,
            })
            .is_err()
        {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
            // 最新音への無条件ジャンプで速度差を隠さず、この配信枝を停止する。
            self.shared.failed.store(true, Ordering::Release);
            self.shared.active.store(false, Ordering::Release);
        }
    }
    #[cfg(test)]
    pub fn monitor_gain(&self) -> f32 {
        if self.shared.monitor_muted.load(Ordering::Relaxed) {
            0.0
        } else {
            f32::from_bits(self.shared.monitor_trim.load(Ordering::Relaxed))
        }
    }
}
struct Receiver {
    peak: super::peak_protection::Rt,
    peak_shared: Arc<super::peak_protection::Shared>,
    main_failed: Arc<AtomicBool>,
    rx: Rx,
    shared: Arc<Shared>,
    target: usize,
    primed: bool,
    phase: f64,
    pair: [[f32; 2]; 2],
    generation: u64,
}
impl Receiver {
    fn next(&mut self) -> Option<[f32; 2]> {
        let f = self.rx.try_pop()?;
        if f.generation != self.generation {
            return None;
        }
        self.shared.consumed.fetch_add(1, Ordering::Relaxed);
        Some(f.sample)
    }
    fn render(&mut self, data: &mut [f32]) {
        data.fill(0.0);
        self.peak.sync(&self.peak_shared);
        if self.main_failed.load(Ordering::Acquire) {
            self.shared.active.store(false, Ordering::Release);
        }
        let generation = self.shared.generation.load(Ordering::Acquire);
        if generation != self.generation
            || !self.shared.source_active.load(Ordering::Acquire)
            || self.shared.muted.load(Ordering::Acquire)
            || !self.shared.active.load(Ordering::Acquire)
        {
            // 1callbackあたりの廃棄も固定容量以下に制限。mute解除後は新世代だけを再生する。
            for _ in 0..self.rx.capacity().get() {
                if self.rx.try_pop().is_none() {
                    break;
                }
            }
            self.shared
                .queued
                .store(self.rx.occupied_len() as u64, Ordering::Relaxed);
            self.generation = generation;
            self.primed = false;
            self.phase = 0.0;
            return;
        }
        let occupied = self.rx.occupied_len();
        self.shared.queued.store(occupied as u64, Ordering::Relaxed);
        if !self.primed {
            if occupied < self.target.max(2) {
                self.shared
                    .zero
                    .fetch_add((data.len() / 2) as u64, Ordering::Relaxed);
                return;
            }
            let (Some(a), Some(b)) = (self.next(), self.next()) else {
                return;
            };
            self.pair = [a, b];
            self.primed = true;
        }
        // 同一公称rateの独立clockを±2000ppmの有界線形補間で追従する。
        // それ以上の差・callback停止は不足/満杯として明示し、無期限同期は保証しない。
        let error = (occupied as f64 - self.target as f64) / self.target.max(1) as f64;
        let step = 1.0 + (error * 0.004).clamp(-0.002, 0.002);
        let trim = f32::from_bits(self.shared.broadcast_trim.load(Ordering::Relaxed));
        let total_frames = data.len() / 2;
        for (index, output) in data.chunks_exact_mut(2).enumerate() {
            if self.shared.muted.load(Ordering::Acquire)
                || !self.shared.active.load(Ordering::Acquire)
                || self.shared.generation.load(Ordering::Acquire) != self.generation
            {
                self.primed = false;
                break;
            }
            for (ch, sample) in output.iter_mut().enumerate() {
                let a = f64::from(self.pair[0][ch]);
                let b = f64::from(self.pair[1][ch]);
                *sample = ((a + (b - a) * self.phase) * f64::from(trim))
                    .clamp(-f64::from(f32::MAX), f64::from(f32::MAX))
                    as f32;
            }
            let protected = self.peak.process([output[0], output[1]]);
            output.copy_from_slice(&protected);
            self.phase += step;
            while self.phase >= 1.0 {
                let Some(next) = self.next() else {
                    self.peak.report(&self.peak_shared, 2);
                    self.primed = false;
                    self.phase = 0.0;
                    self.shared
                        .zero
                        .fetch_add((total_frames - index - 1) as u64, Ordering::Relaxed);
                    return;
                };
                self.pair[0] = self.pair[1];
                self.pair[1] = next;
                self.phase -= 1.0;
            }
        }
        self.peak.report(&self.peak_shared, 2);
    }
}
pub struct Sink {
    stream: Option<cpal::Stream>,
    shared: Arc<Shared>,
    sender_owner: ControlOwner<Sender>,
    receiver_owner: ControlOwner<Receiver>,
    rate: u32,
}
impl Sink {
    pub(crate) fn start(
        device: &str,
        rate: u32,
        main_id: Option<&str>,
        config: &Config,
        main_failed: Arc<AtomicBool>,
        peak: (
            super::peak_protection::Config,
            Arc<super::peak_protection::Shared>,
        ),
    ) -> Result<(Self, CallbackOwner<Sender>)> {
        config.validate()?;
        ensure!(
            main_id != Some(device),
            "自分用とは別の配信出力を選んでください"
        );
        let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
        let id = device
            .parse()
            .map_err(|_| anyhow!("配信出力の識別情報が不正です"))?;
        let dev = host
            .device_by_id(&id)
            .ok_or_else(|| anyhow!("配信出力が見つかりません"))?;
        let format = dev
            .supported_output_configs()?
            .find(|c| {
                c.channels() == 2
                    && c.sample_format() == cpal::SampleFormat::F32
                    && c.min_sample_rate() <= rate
                    && rate <= c.max_sample_rate()
            })
            .ok_or_else(|| anyhow!("配信出力は同一rate・stereo F32の構成に対応していません"))?
            .with_sample_rate(rate)
            .config();
        let shared = Arc::new(Shared::default());
        shared.active.store(true, Ordering::Release);
        shared.source_active.store(true, Ordering::Release);
        shared.update(config);
        let (tx, rx) = HeapRb::new((rate as usize / 5).max(2)).split();
        let (sender, sender_owner) = callback_owner(Sender {
            block_generation: 0,
            tx,
            shared: shared.clone(),
        });
        let (mut receiver, receiver_owner) = callback_owner(Receiver {
            peak: super::peak_protection::Rt::new(peak.0, rate),
            peak_shared: peak.1,
            main_failed,
            rx,
            shared: shared.clone(),
            target: (rate as usize * 30 / 1000).max(2),
            primed: false,
            phase: 0.0,
            pair: [[0.0; 2]; 2],
            generation: 0,
        });
        let failed = shared.clone();
        let stream = dev.build_output_stream(
            &format,
            move |data: &mut [f32], _| receiver.get_mut().render(data),
            move |_| {
                failed.failed.store(true, Ordering::Release);
                failed.active.store(false, Ordering::Release);
            },
            None,
        )?;
        stream.play()?;
        Ok((
            Self {
                stream: Some(stream),
                shared,
                sender_owner,
                receiver_owner,
                rate,
            },
            sender,
        ))
    }
    pub fn deactivate(&self) {
        self.shared.active.store(false, Ordering::Release);
    }
    pub fn mute(&self, muted: bool) {
        self.shared.muted.store(muted, Ordering::Release);
        self.shared.generation.fetch_add(1, Ordering::AcqRel);
    }
    pub fn update(&self, config: &Config) {
        self.shared.update(config);
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            active: self.shared.active.load(Ordering::Acquire),
            failed: self.shared.failed.load(Ordering::Acquire),
            queued_frames: self.shared.queued.load(Ordering::Relaxed),
            offered_frames: self.shared.offered.load(Ordering::Relaxed),
            consumed_frames: self.shared.consumed.load(Ordering::Relaxed),
            zero_filled_frames: self.shared.zero.load(Ordering::Relaxed),
            dropped_frames: self.shared.dropped.load(Ordering::Relaxed),
            rate_hz: self.rate,
        }
    }
}
impl Shared {
    fn update(&self, config: &Config) {
        self.monitor_trim
            .store(config.monitor_trim.to_bits(), Ordering::Relaxed);
        self.broadcast_trim
            .store(config.broadcast_trim.to_bits(), Ordering::Relaxed);
        self.monitor_muted
            .store(config.monitor_muted, Ordering::Relaxed);
    }
}
impl Drop for Sink {
    fn drop(&mut self) {
        self.shared.active.store(false, Ordering::Release);
        self.stream = None;
        drop(self.sender_owner.take());
        drop(self.receiver_owner.take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(capacity: usize, target: usize) -> (Sender, Receiver, Arc<Shared>) {
        let shared = Arc::new(Shared::default());
        shared.active.store(true, Ordering::Release);
        shared.source_active.store(true, Ordering::Release);
        shared.update(&Config::default());
        let (tx, rx) = HeapRb::new(capacity).split();
        (
            Sender {
                block_generation: 0,
                tx,
                shared: shared.clone(),
            },
            Receiver {
                peak: crate::audio_engine::peak_protection::Rt::new(Default::default(), 48000),
                peak_shared: Default::default(),
                main_failed: Arc::new(AtomicBool::new(false)),
                rx,
                shared: shared.clone(),
                target,
                primed: false,
                phase: 0.0,
                pair: [[0.0; 2]; 2],
                generation: 0,
            },
            shared,
        )
    }
    #[test]
    fn peak_protection_also_limits_old_queued_audio_after_switching_or_lowering_the_ceiling() {
        let (mut tx, mut rx, _) = fixture(1024, 128);
        for _ in 0..512 {
            tx.send([2.0, -1.0]);
        }
        let config = super::super::peak_protection::Config {
            enabled: true,
            ceiling_db: -6.0,
            release_ms: 100.0,
        };
        rx.peak_shared.publish(config.prepare(48000));
        let mut output = [0.0; 256];
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| rx.render(&mut output)),
            (0, 0)
        );
        assert!(output
            .iter()
            .all(|s| s.abs() <= 10.0f32.powf(-6.0 / 20.0) + 1e-6));
        assert!(output.iter().any(|s| *s != 0.0));
    }
    #[test]
    fn frame_alignment_trim_and_render_are_rt_allocation_free() {
        let (mut tx, mut rx, shared) = fixture(1024, 128);
        shared.update(&Config {
            monitor_trim: 0.25,
            broadcast_trim: 0.5,
            ..Config::default()
        });
        let mut output = [0.0; 256];
        let counts = crate::vst_host::instance::allocation_counts(|| {
            for _ in 0..512 {
                tx.send([0.2, -0.2]);
            }
            rx.render(&mut output);
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(tx.monitor_gain(), 0.25);
        assert!(output.chunks_exact(2).all(|s| s == [0.1, -0.1]));
    }
    #[test]
    fn stalled_consumer_stops_only_broadcast_and_does_not_overwrite_old_audio() {
        let (mut tx, mut rx, shared) = fixture(8, 2);
        for _ in 0..9 {
            tx.send([1.0; 2]);
        }
        assert!(shared.failed.load(Ordering::Acquire));
        assert_eq!(shared.dropped.load(Ordering::Relaxed), 1);
        let mut output = [1.0; 16];
        rx.render(&mut output);
        assert_eq!(output, [0.0; 16]);
        assert_eq!(tx.monitor_gain(), 1.0);
    }
    #[test]
    fn mute_substitution_and_main_failure_never_replay_old_generation() {
        let (mut tx, mut rx, shared) = fixture(32, 2);
        for _ in 0..8 {
            tx.send([1.0; 2]);
        }
        shared.muted.store(true, Ordering::Release);
        shared.generation.fetch_add(1, Ordering::AcqRel);
        shared.muted.store(false, Ordering::Release);
        shared.generation.fetch_add(1, Ordering::AcqRel);
        let mut output = [1.0; 8];
        rx.render(&mut output);
        assert_eq!(output, [0.0; 8]);
        tx.begin_block();
        for _ in 0..8 {
            tx.send([0.25; 2]);
        }
        rx.render(&mut output);
        assert!(output.iter().all(|v| *v == 0.25));
        tx.normal(false);
        rx.render(&mut output);
        assert_eq!(output, [0.0; 8]);
        tx.normal(true);
        rx.render(&mut output);
        assert_eq!(output, [0.0; 8]);
        tx.begin_block();
        for _ in 0..8 {
            tx.send([0.5; 2]);
        }
        rx.main_failed.store(true, Ordering::Release);
        rx.render(&mut output);
        assert_eq!(output, [0.0; 8]);
        assert!(!shared.active.load(Ordering::Acquire));
    }
    #[test]
    fn explicit_disabled_configuration_keeps_unity_and_invalid_values_are_rejected() {
        let config = Config::default();
        assert!(config.validate().is_ok());
        assert_eq!(config.monitor_trim, 1.0);
        assert!(config.device_id.is_none());
        for value in [f32::NAN, f32::INFINITY, -1.0, 1.1] {
            assert!(Config {
                monitor_trim: value,
                ..Config::default()
            }
            .validate()
            .is_err());
        }
        let previous: Config = serde_json::from_str(
            r#"{"deviceId":null,"monitorTrim":1,"broadcastTrim":1,"monitorMuted":false}"#,
        )
        .unwrap();
        assert!(!previous.split_processing);
        assert!(previous.monitor_singing.is_none());
        assert!(previous.same_route(&Config {
            monitor_trim: 0.25,
            monitor_muted: true,
            ..Default::default()
        }));
        assert!(!previous.same_route(&Config {
            device_id: Some("other".into()),
            ..Default::default()
        }));
    }
    #[test]
    fn controlled_independent_clock_offsets_keep_a_bounded_queue() {
        for ppm in [-1500.0, -500.0, 0.0, 500.0, 1500.0] {
            let (mut tx, mut rx, shared) = fixture(8192, 1024);
            for _ in 0..1024 {
                tx.send([0.1, -0.1]);
            }
            let mut output = [0.0; 256];
            let mut fraction = 0.0;
            for _ in 0..20000 {
                fraction += 128.0 * (1.0 + ppm / 1_000_000.0);
                let frames = fraction as usize;
                fraction -= frames as f64;
                for _ in 0..frames {
                    tx.send([0.1, -0.1]);
                }
                rx.render(&mut output);
            }
            assert!(!shared.failed.load(Ordering::Acquire), "ppm={ppm}");
            assert_eq!(shared.zero.load(Ordering::Relaxed), 0, "ppm={ppm}");
            assert!(rx.rx.occupied_len() < 8192);
            assert!(output.chunks_exact(2).all(|s| s == [0.1, -0.1]));
        }
    }
    #[test]
    fn nonfinite_and_opposite_large_samples_do_not_escape_to_the_driver() {
        let (mut tx, mut rx, _) = fixture(1024, 128);
        for i in 0..512 {
            tx.send(if i % 3 == 0 {
                [f32::NAN, f32::INFINITY]
            } else if i % 3 == 1 {
                [f32::MAX, -f32::MAX]
            } else {
                [-f32::MAX, f32::MAX]
            });
        }
        let mut output = [0.0; 256];
        rx.render(&mut output);
        assert!(output.iter().all(|sample| sample.is_finite()));
    }
}
