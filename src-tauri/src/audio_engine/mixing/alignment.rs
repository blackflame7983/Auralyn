use anyhow::{ensure, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Delays {
    pub voice: usize,
    pub accompaniment: usize,
    pub known_voice_processing: Option<u32>,
}
impl Delays {
    pub fn new(rate: u32, offset_ms: i32, known_voice_processing: Option<u32>) -> Result<Self> {
        Self::checked(rate, offset_ms, known_voice_processing).ok_or_else(|| {
            anyhow::anyhow!("ミックスのrate・時間差・既知の処理待ちを確認してください")
        })
    }
    pub fn checked(rate: u32, offset_ms: i32, known_voice_processing: Option<u32>) -> Option<Self> {
        if !(8000..=192000).contains(&rate)
            || !(-2000..=2000).contains(&offset_ms)
            || known_voice_processing.is_some_and(|frames| frames > rate * 2)
        {
            return None;
        }
        // 不明な処理待ちは不明のまま返す。ここでは手動分だけを適用する。
        let difference = i64::from(known_voice_processing.unwrap_or(0))
            + i64::from(offset_ms) * i64::from(rate) / 1000;
        Some(Self {
            voice: (-difference).max(0) as usize,
            accompaniment: difference.max(0) as usize,
            known_voice_processing,
        })
    }
}

struct DelayLine {
    samples: Vec<[f32; 2]>,
    cursor: usize,
    written: usize,
}
impl DelayLine {
    fn new(capacity: usize) -> Self {
        Self {
            samples: vec![[0.0; 2]; capacity],
            cursor: 0,
            written: 0,
        }
    }
    fn reset(&mut self) {
        // 大きなbufferをcallbackで消去しない。書込み数で旧世代を無効にする。
        self.cursor = 0;
        self.written = 0;
    }
    fn sample(&mut self, value: [f32; 2], delay: usize) -> [f32; 2] {
        self.samples[self.cursor] = value;
        let result = if self.written >= delay {
            self.samples[(self.cursor + self.samples.len() - delay) % self.samples.len()]
        } else {
            [0.0; 2]
        };
        self.cursor = (self.cursor + 1) % self.samples.len();
        self.written = self.written.saturating_add(1);
        result
    }
}

/// 配信workerだけが所有する。本人用の返しからは呼ばない。
pub struct AlignedMixer {
    voice: DelayLine,
    accompaniment: DelayLine,
    delays: Delays,
    pending: Option<Delays>,
    fade: f32,
    step: f32,
}
impl AlignedMixer {
    pub fn new(rate: u32, delays: Delays) -> Result<Self> {
        ensure!(
            (8000..=192000).contains(&rate),
            "ミックスのrateが範囲外です"
        );
        let capacity = rate as usize * 4 + 1;
        ensure!(
            delays.voice < capacity && delays.accompaniment < capacity,
            "時間合わせの容量を超えています"
        );
        let transition_frames = (rate as usize / 200).max(1);
        Ok(Self {
            voice: DelayLine::new(capacity),
            accompaniment: DelayLine::new(capacity),
            delays,
            pending: None,
            fade: 1.0,
            step: 1.0 / transition_frames as f32,
        })
    }
    pub fn change(&mut self, delays: Delays) -> bool {
        if delays.voice >= self.voice.samples.len()
            || delays.accompaniment >= self.accompaniment.samples.len()
        {
            return false;
        }
        if delays != self.pending.unwrap_or(self.delays) {
            self.pending = Some(delays);
        }
        true
    }
    pub fn reset(&mut self) {
        self.voice.reset();
        self.accompaniment.reset();
        if let Some(delays) = self.pending.take() {
            self.delays = delays;
        }
        self.fade = 0.0;
    }
    pub fn clear_accompaniment(&mut self) {
        self.accompaniment.reset();
    }
    #[cfg(test)]
    pub fn delays(&self) -> Delays {
        self.pending.unwrap_or(self.delays)
    }
    pub fn settled(&self) -> bool {
        self.pending.is_none() && self.fade >= 1.0
    }
    pub fn sample(&mut self, voice: [f32; 2], accompaniment: [f32; 2]) -> [f32; 2] {
        if self.pending.is_some() {
            self.fade = (self.fade - self.step).max(0.0);
            if self.fade <= f32::EPSILON {
                self.reset();
            }
        } else {
            self.fade = (self.fade + self.step).min(1.0);
        }
        let voice = self.voice.sample(voice, self.delays.voice);
        let accompaniment = self
            .accompaniment
            .sample(accompaniment, self.delays.accompaniment);
        std::array::from_fn(|channel| {
            let sum = f64::from(voice[channel]) + f64::from(accompaniment[channel]);
            if sum.is_finite() {
                (sum * f64::from(self.fade)).clamp(-f64::from(f32::MAX), f64::from(f32::MAX)) as f32
            } else {
                0.0
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;
    #[test]
    fn impulse_alignment_preserves_sign_and_applies_known_processing_separately() {
        for offset in [-2000, -1, 0, 1, 2000] {
            let delays = Delays::new(48000, offset, Some(480)).unwrap();
            assert_eq!(
                delays.accompaniment as i64 - delays.voice as i64,
                480 + i64::from(offset) * 48
            );
        }
        let delays = Delays::new(48000, 1, Some(0)).unwrap();
        let mut mixer = AlignedMixer::new(48000, delays).unwrap();
        for frame in 0..100 {
            // 声の入力に48frameの既知遅延を持たせ、同一インパルスの一致を確認する。
            let value = mixer.sample(
                if frame == 48 { [0.25, -0.25] } else { [0.0; 2] },
                if frame == 0 { [0.5, -0.5] } else { [0.0; 2] },
            );
            assert_eq!(value, if frame == 48 { [0.75, -0.75] } else { [0.0; 2] });
        }
        assert_eq!(
            Delays::new(48000, 0, None).unwrap().known_voice_processing,
            None
        );
        assert!(Delays::new(48000, 2001, Some(0)).is_err());
        assert!(Delays::new(48000, 0, Some(96001)).is_err());
    }
    #[test]
    fn changing_delay_fades_resets_old_audio_and_never_allocates() {
        let mut mixer = AlignedMixer::new(48000, Delays::new(48000, 0, Some(0)).unwrap()).unwrap();
        for _ in 0..1000 {
            mixer.sample([0.2; 2], [0.3; 2]);
        }
        assert!(mixer.change(Delays::new(48000, -2, Some(0)).unwrap()));
        let counts = crate::vst_host::instance::allocation_counts(|| {
            for _ in 0..1000 {
                mixer.sample([0.0; 2], [0.0; 2]);
            }
            mixer.reset();
            assert_eq!(mixer.sample([0.0; 2], [0.0; 2]), [0.0; 2]);
        });
        assert_eq!(counts, (0, 0));
        for _ in 0..1000 {
            assert_eq!(mixer.sample([0.0; 2], [0.0; 2]), [0.0; 2]);
        }
        assert!(mixer.settled());
        let _ = mixer.delays();
    }

    #[test]
    fn rapid_delay_changes_drop_the_old_impulse_and_reset_block_does_not_allocate() {
        let rate = 48_000u32;
        let fade = (rate as usize / 200).max(1);
        let mut mixer =
            AlignedMixer::new(rate, Delays::new(rate, 1_000, Some(0)).unwrap()).unwrap();
        for frame in 0..120 {
            let accompaniment = if frame == 80 { [0.25, -0.25] } else { [0.0; 2] };
            assert_eq!(mixer.sample([0.0; 2], accompaniment), [0.0; 2]);
        }
        let final_delays = Delays::new(rate, -20, Some(0)).unwrap();
        assert_eq!((final_delays.voice, final_delays.accompaniment), (960, 0));
        let mut found = None;
        let counts = allocation_counts(|| {
            for step in 0..100 {
                let offset = if step % 2 == 0 { 500 } else { -500 };
                assert!(mixer.change(Delays::new(rate, offset, Some(0)).unwrap()));
                assert!(!mixer.settled());
                assert_eq!(mixer.sample([0.0; 2], [0.0; 2]), [0.0; 2]);
            }
            // フェードの途中で目標を置き換えても、下りきるまで古い遅延線は出さない。
            assert!(mixer.change(final_delays));
            for _ in 0..fade {
                assert_eq!(mixer.sample([0.0; 2], [0.0; 2]), [0.0; 2]);
            }
            for _ in 0..fade {
                assert_eq!(mixer.sample([0.0; 2], [0.0; 2]), [0.0; 2]);
            }
            assert!(mixer.settled());
            assert_eq!(mixer.delays(), final_delays);
            for frame in 0..2_000 {
                let voice = if frame == 0 { [0.5, -0.5] } else { [0.0; 2] };
                let output = mixer.sample(voice, [0.0; 2]);
                if output != [0.0; 2] {
                    assert_eq!(output, [0.5, -0.5], "frame={frame}");
                    assert!(found.is_none(), "frame={frame}");
                    found = Some(frame);
                }
            }
            let foreign = Delays::new(192_000, 2_000, Some(192_000 * 2)).unwrap();
            assert!(!mixer.change(foreign));
            assert_eq!(mixer.delays(), final_delays);
            assert!(mixer.change(Delays::new(rate, 1_000, Some(0)).unwrap()));
            mixer.reset();
            // 伴奏は1000ms遅れなので、reset直後の512frameは新しい入力も古いbufferも出ない。
            for _ in 0..512 {
                assert_eq!(mixer.sample([0.0; 2], [0.25, -0.25]), [0.0; 2]);
            }
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(found, Some(final_delays.voice));

        let mut reopened =
            AlignedMixer::new(44_100, Delays::new(44_100, 0, Some(0)).unwrap()).unwrap();
        let counts = allocation_counts(|| {
            for _ in 0..256 {
                assert_eq!(reopened.sample([0.0; 2], [0.0; 2]), [0.0; 2]);
            }
        });
        assert_eq!(counts, (0, 0));
    }
}
