//! 出力gain後のstereo-linked sample-peak保護。lookahead/AGC/makeupは持たない。
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub ceiling_db: f32,
    pub release_ms: f32,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            ceiling_db: -1.0,
            release_ms: 100.0,
        }
    }
}
impl Config {
    pub fn validate(self) -> Result<Self, String> {
        if !self.ceiling_db.is_finite()
            || !(-12.0..=-0.1).contains(&self.ceiling_db)
            || !self.release_ms.is_finite()
            || !(20.0..=1000.0).contains(&self.release_ms)
        {
            return Err("ピーク保護の天井または復帰時間を確認してください".into());
        }
        Ok(self)
    }
    pub(crate) fn prepare(self, rate: u32) -> Prepared {
        Prepared {
            enabled: self.enabled,
            ceiling: 10.0f32.powf(self.ceiling_db / 20.0),
            release: (-1.0 / (rate.max(1) as f32 * self.release_ms / 1000.0)).exp(),
            ramp: 1.0 / (rate.max(1) as f32 * 0.005).max(1.0),
        }
    }
}
#[derive(Clone, Copy)]
pub(crate) struct Prepared {
    enabled: bool,
    ceiling: f32,
    release: f32,
    ramp: f32,
}
pub(crate) struct Shared {
    revision: AtomicU64,
    enabled: AtomicBool,
    ceiling: AtomicU32,
    release: AtomicU32,
    ramp: AtomicU32,
    pub main_applied: AtomicU64,
    pub monitor_applied: AtomicU64,
    pub sink_applied: AtomicU64,
    minimum_gain: AtomicU32,
}
impl Default for Shared {
    fn default() -> Self {
        let p = Config::default().prepare(48000);
        Self {
            revision: AtomicU64::new(0),
            enabled: AtomicBool::new(p.enabled),
            ceiling: AtomicU32::new(p.ceiling.to_bits()),
            release: AtomicU32::new(p.release.to_bits()),
            ramp: AtomicU32::new(p.ramp.to_bits()),
            main_applied: AtomicU64::new(0),
            monitor_applied: AtomicU64::new(0),
            sink_applied: AtomicU64::new(0),
            minimum_gain: AtomicU32::new(1.0f32.to_bits()),
        }
    }
}
impl Shared {
    // 制御threadだけが書く。RTは一度だけ読み、一貫しなければ前blockの係数を使う。
    pub(crate) fn publish(&self, p: Prepared) -> u64 {
        let revision = self.revision.load(Ordering::SeqCst).saturating_add(2);
        self.revision.store(revision - 1, Ordering::SeqCst);
        self.enabled.store(p.enabled, Ordering::SeqCst);
        self.ceiling.store(p.ceiling.to_bits(), Ordering::SeqCst);
        self.release.store(p.release.to_bits(), Ordering::SeqCst);
        self.ramp.store(p.ramp.to_bits(), Ordering::SeqCst);
        self.revision.store(revision, Ordering::SeqCst);
        revision
    }
    pub(crate) fn sink_pending(&self) -> bool {
        self.sink_applied.load(Ordering::Acquire) != self.revision.load(Ordering::Acquire)
    }
    fn read(&self) -> Option<(u64, Prepared)> {
        let revision = self.revision.load(Ordering::SeqCst);
        if revision & 1 != 0 {
            return None;
        }
        let p = Prepared {
            enabled: self.enabled.load(Ordering::SeqCst),
            ceiling: f32::from_bits(self.ceiling.load(Ordering::SeqCst)),
            release: f32::from_bits(self.release.load(Ordering::SeqCst)),
            ramp: f32::from_bits(self.ramp.load(Ordering::SeqCst)),
        };
        (revision == self.revision.load(Ordering::SeqCst)).then_some((revision, p))
    }
    pub(crate) fn pending(&self, split: bool, sink: bool) -> bool {
        let revision = self.revision.load(Ordering::Acquire);
        self.main_applied.load(Ordering::Acquire) != revision
            || (split && self.monitor_applied.load(Ordering::Acquire) != revision)
            || (sink && self.sink_pending())
    }
    pub(crate) fn status(&self, config: Config, running: bool, split: bool) -> Snapshot {
        let revision = self.revision.load(Ordering::Acquire);
        Snapshot {
            config,
            running,
            pending: running && self.pending(split, false),
            revision: revision.to_string(),
            reduction_db: -20.0
                * f32::from_bits(self.minimum_gain.swap(1.0f32.to_bits(), Ordering::AcqRel))
                    .max(1.0e-12)
                    .log10(),
            added_latency_samples: 0,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub config: Config,
    pub running: bool,
    pub pending: bool,
    pub revision: String,
    pub reduction_db: f32,
    pub added_latency_samples: u32,
}
pub(crate) struct Rt {
    prepared: Prepared,
    revision: u64,
    gain: f32,
    mix: f32,
    ceiling: f32,
    minimum: f32,
}
impl Rt {
    pub(crate) fn new(config: Config, rate: u32) -> Self {
        let p = config.prepare(rate);
        Self {
            prepared: p,
            revision: 0,
            gain: 1.0,
            mix: if p.enabled { 1.0 } else { 0.0 },
            ceiling: p.ceiling,
            minimum: 1.0,
        }
    }
    pub(crate) fn sync(&mut self, shared: &Shared) {
        if let Some((revision, p)) = shared.read() {
            self.prepared = p;
            self.revision = revision;
        }
    }
    pub(crate) fn process(&mut self, samples: [f32; 2]) -> [f32; 2] {
        let p = self.prepared;
        let target = if p.enabled { 1.0 } else { 0.0 };
        self.mix += (target - self.mix).clamp(-p.ramp, p.ramp);
        self.ceiling += (p.ceiling - self.ceiling).clamp(-p.ramp, p.ramp);
        if !p.enabled && self.mix == 0.0 {
            self.gain = 1.0;
            return samples;
        }
        let samples = samples.map(|s| if s.is_finite() { s } else { 0.0 });
        let peak = samples[0].abs().max(samples[1].abs());
        let wanted = (self.ceiling / peak.max(f32::MIN_POSITIVE)).min(1.0);
        self.gain = wanted.min(1.0 - (1.0 - self.gain) * p.release);
        let mut gain = 1.0 + (self.gain - 1.0) * self.mix;
        // 過大ピークのattackは即時。切替ramp中も有効な天井を超えない。
        if p.enabled {
            gain = gain.min((p.ceiling / peak.max(f32::MIN_POSITIVE)).min(1.0));
        }
        self.minimum = self.minimum.min(gain);
        samples.map(|s| s * gain)
    }
    pub(crate) fn report(&mut self, shared: &Shared, path: u8) {
        shared
            .minimum_gain
            .fetch_min(self.minimum.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        self.minimum = 1.0;
        if self.mix == if self.prepared.enabled { 1.0 } else { 0.0 }
            && (self.ceiling - self.prepared.ceiling).abs() < 1.0e-6
        {
            (match path {
                1 => &shared.monitor_applied,
                2 => &shared.sink_applied,
                _ => &shared.main_applied,
            })
            .store(self.revision, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;
    #[test]
    fn off_is_exact_and_protection_never_boosts_normal_or_silent_input() {
        for rate in [8000, 44100, 48000, 96000, 192000, 384000] {
            let mut off = Rt::new(Config::default(), rate);
            assert_eq!(off.process([4.0, -2.0]), [4.0, -2.0]);
            let mut active = Rt::new(
                Config {
                    enabled: true,
                    ..Default::default()
                },
                rate,
            );
            for samples in [[0.0; 2], [0.1, -0.2], [0.3, 0.3]] {
                assert_eq!(active.process(samples), samples);
            }
            assert_eq!(
                allocation_counts(|| {
                    for _ in 0..2000 {
                        active.process([3.0, -0.5]);
                    }
                }),
                (0, 0)
            );
            let out = active.process([3.0, -0.5]);
            assert!(out
                .iter()
                .all(|s| s.abs() <= 10.0f32.powf(-1.0 / 20.0) + 1e-6));
            assert!((out[0] / 3.0 - out[1] / -0.5).abs() < 1e-6);
            assert!(active
                .process([f32::NAN, f32::INFINITY])
                .iter()
                .all(|s| s.is_finite()));
        }
    }
    #[test]
    fn switching_ceiling_and_releasing_are_bounded_and_acknowledged_without_latency() {
        let shared = Shared::default();
        let mut rt = Rt::new(Config::default(), 48000);
        let config = Config {
            enabled: true,
            ceiling_db: -6.0,
            release_ms: 50.0,
        };
        let revision = shared.publish(config.prepare(48000));
        rt.sync(&shared);
        for _ in 0..1000 {
            assert!(rt.process([2.0, -1.0])[0] <= 10.0f32.powf(-6.0 / 20.0) + 1e-6);
        }
        rt.report(&shared, 0);
        assert_eq!(shared.main_applied.load(Ordering::Acquire), revision);
        assert!(!shared.status(config, true, false).pending);
        assert!(shared.status(config, true, true).pending);
        let before = rt.process([0.01; 2])[0];
        for _ in 0..48000 {
            rt.process([0.01; 2]);
        }
        assert!(rt.process([0.01; 2])[0] > before);
        assert_eq!(shared.status(config, true, false).added_latency_samples, 0);
        for bad in [
            Config {
                ceiling_db: f32::NAN,
                ..config
            },
            Config {
                release_ms: 0.0,
                ..config
            },
        ] {
            assert!(bad.validate().is_err());
        }
    }
}
