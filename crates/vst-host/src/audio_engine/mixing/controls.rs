use super::Levels;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, AtomicU8, Ordering};

#[derive(Clone)]
pub struct Settings {
    pub levels: Levels,
    pub revision: u64,
    pub mute_generation: u64,
    pub known_voice_frames: Option<u32>,
}
pub struct Shared {
    revision: AtomicU64,
    voice_gain: AtomicU32,
    accompaniment_gain: AtomicU32,
    flags: AtomicU8,
    offset_ms: AtomicI32,
    voice_frames: AtomicU64,
    mute_generation: AtomicU64,
    pub applied_revision: AtomicU64,
    pub failed: AtomicBool,
    pub voice_peak: [AtomicU32; 2],
    pub accompaniment_peak: [AtomicU32; 2],
    pub mix_peak: [AtomicU32; 2],
    pub primary_queued: AtomicU64,
    pub primary_correction: AtomicI32,
    pub primary_underruns: AtomicU64,
    pub primary_input_rate: AtomicU32,
    pub primary_output_rate: AtomicU32,
    pub primary_adaptive: AtomicBool,
}
impl Shared {
    #[cfg(test)]
    pub fn new(levels: &Levels) -> Self {
        Self::new_at(levels, 0)
    }
    pub fn new_at(levels: &Levels, revision: u64) -> Self {
        Self {
            revision: AtomicU64::new(revision),
            voice_gain: AtomicU32::new(levels.voice.gain.to_bits()),
            accompaniment_gain: AtomicU32::new(levels.accompaniment.gain.to_bits()),
            flags: AtomicU8::new(flags(levels)),
            offset_ms: AtomicI32::new(levels.offset_ms),
            voice_frames: AtomicU64::new(u64::MAX),
            mute_generation: AtomicU64::new(0),
            applied_revision: AtomicU64::new(0),
            failed: AtomicBool::new(false),
            voice_peak: std::array::from_fn(|_| AtomicU32::new(0)),
            accompaniment_peak: std::array::from_fn(|_| AtomicU32::new(0)),
            mix_peak: std::array::from_fn(|_| AtomicU32::new(0)),
            primary_queued: AtomicU64::new(0),
            primary_correction: AtomicI32::new(0),
            primary_underruns: AtomicU64::new(0),
            primary_input_rate: AtomicU32::new(0),
            primary_output_rate: AtomicU32::new(0),
            primary_adaptive: AtomicBool::new(false),
        }
    }
    /// 書込みはEngineの制御スレッドだけ。callback側では待たずに前回値を使う。
    pub fn update(&self, levels: &Levels, known_voice_frames: Option<u32>) -> Result<(), String> {
        levels.validate()?;
        let revision = self.revision.load(Ordering::Acquire);
        let next = revision
            .checked_add(2)
            .ok_or("ミックス設定の世代を更新できません")?;
        self.revision.fetch_add(1, Ordering::AcqRel);
        let next_flags = flags(levels);
        if self.flags.load(Ordering::Relaxed) & 3 != next_flags & 3 {
            self.mute_generation.fetch_add(1, Ordering::Relaxed);
        }
        self.voice_gain
            .store(levels.voice.gain.to_bits(), Ordering::Relaxed);
        self.accompaniment_gain
            .store(levels.accompaniment.gain.to_bits(), Ordering::Relaxed);
        self.flags.store(next_flags, Ordering::Relaxed);
        self.offset_ms.store(levels.offset_ms, Ordering::Relaxed);
        self.voice_frames.store(
            known_voice_frames.map_or(u64::MAX, u64::from),
            Ordering::Relaxed,
        );
        self.revision.store(next, Ordering::Release);
        Ok(())
    }
    pub fn read(&self) -> Option<Settings> {
        let revision = self.revision.load(Ordering::Acquire);
        if revision & 1 != 0 {
            return None;
        }
        let state = self.flags.load(Ordering::Relaxed);
        let frames = self.voice_frames.load(Ordering::Relaxed);
        let settings = Settings {
            levels: Levels {
                voice: super::Track {
                    gain: f32::from_bits(self.voice_gain.load(Ordering::Relaxed)),
                    muted: state & 1 != 0,
                },
                accompaniment: super::Track {
                    gain: f32::from_bits(self.accompaniment_gain.load(Ordering::Relaxed)),
                    muted: state & 2 != 0,
                },
                monitor_accompaniment: state & 4 != 0,
                offset_ms: self.offset_ms.load(Ordering::Relaxed),
                // 確認の記録は制御側だけで保持し、音声callbackへ文字列を持ち込まない。
                offset_context: None,
            },
            revision,
            mute_generation: self.mute_generation.load(Ordering::Relaxed),
            known_voice_frames: u32::try_from(frames).ok(),
        };
        std::sync::atomic::fence(Ordering::Acquire);
        (revision == self.revision.load(Ordering::Relaxed)).then_some(settings)
    }
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }
    pub fn peaks(values: &[AtomicU32; 2]) -> [f32; 2] {
        std::array::from_fn(|channel| f32::from_bits(values[channel].load(Ordering::Relaxed)))
    }
    pub fn meter(values: &[AtomicU32; 2], peak: [f32; 2]) {
        for (value, peak) in values.iter().zip(peak) {
            value.store(peak.to_bits(), Ordering::Relaxed);
        }
    }
}
fn flags(levels: &Levels) -> u8 {
    u8::from(levels.voice.muted)
        | (u8::from(levels.accompaniment.muted) << 1)
        | (u8::from(levels.monitor_accompaniment) << 2)
}

pub struct Gain {
    current: f32,
    step: f32,
}
impl Gain {
    pub fn new(rate: u32) -> Self {
        Self {
            current: 0.0,
            step: 2.0 / (rate as f32 / 200.0).max(1.0),
        }
    }
    pub fn next(&mut self, target: f32) -> f32 {
        self.current += (target - self.current).clamp(-self.step, self.step);
        self.current
    }
    pub fn settled(&self, target: f32) -> bool {
        self.current == target
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_are_coherent_and_mute_round_trip_invalidates_queued_audio() {
        let shared = Shared::new(&Levels::default());
        let first = shared.read().unwrap();
        let mut levels = first.levels.clone();
        levels.accompaniment.muted = true;
        shared.update(&levels, Some(480)).unwrap();
        levels.accompaniment.muted = false;
        shared.update(&levels, Some(480)).unwrap();
        let counts = crate::vst_host::instance::allocation_counts(|| {
            let settings = shared.read().unwrap();
            assert_eq!(settings.mute_generation, first.mute_generation + 2);
            assert_eq!(settings.known_voice_frames, Some(480));
            assert_eq!(settings.revision, 4);
        });
        assert_eq!(counts, (0, 0));
        shared.revision.store(5, Ordering::Release);
        assert!(shared.read().is_none());
    }
}
