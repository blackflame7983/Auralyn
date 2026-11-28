//! 二入力の分岐後は、本人用と配信用で別のDSP状態を進める。
use super::{
    controls::{Gain, Settings, Shared},
    input, AlignedMixer, Delays,
};
use crate::audio_engine::{process_capture, split_monitor::BroadcastFrame};
use anyhow::{anyhow, Result};
use std::sync::{atomic::Ordering, Arc};

fn scale(frame: [f32; 2], gain: f32) -> [f32; 2] {
    frame.map(|sample| {
        if sample.is_finite() {
            (f64::from(sample) * f64::from(gain)).clamp(-f64::from(f32::MAX), f64::from(f32::MAX))
                as f32
        } else {
            0.0
        }
    })
}
fn peak(current: &mut [f32; 2], frame: [f32; 2]) {
    for (peak, sample) in current.iter_mut().zip(frame) {
        *peak = peak.max(sample.abs());
    }
}

pub struct Monitor {
    source: input::Render,
    shared: Arc<Shared>,
    settings: Settings,
    voice: Gain,
    accompaniment: Gain,
    monitor_accompaniment: Gain,
    peak: [f32; 2],
}
pub struct MonitorFrame {
    pub broadcast: [f32; 2],
    pub monitor: [f32; 2],
    pub voice_gain: f32,
    pub mute_generation: u64,
}
impl Monitor {
    pub fn new(source: input::Render, shared: Arc<Shared>, rate: u32) -> Result<Self> {
        let settings = shared
            .read()
            .ok_or_else(|| anyhow!("ミックス設定を取得できません"))?;
        Ok(Self {
            source,
            shared,
            settings,
            voice: Gain::new(rate),
            accompaniment: Gain::new(rate),
            monitor_accompaniment: Gain::new(rate),
            peak: [0.0; 2],
        })
    }
    pub fn begin_block(&mut self, frames: usize, paused: bool, generation: u64) {
        if let Some(settings) = self.shared.read() {
            self.settings = settings;
        }
        self.peak = [0.0; 2];
        self.source
            .begin_block(frames, paused, (generation, self.settings.mute_generation));
    }
    pub fn frame(&mut self, index: usize) -> MonitorFrame {
        let levels = &self.settings.levels;
        let gain = self.accompaniment.next(if levels.accompaniment.muted {
            0.0
        } else {
            levels.accompaniment.gain
        });
        let broadcast = scale(self.source.frame(index), gain);
        peak(&mut self.peak, broadcast);
        MonitorFrame {
            broadcast,
            monitor: scale(
                broadcast,
                self.monitor_accompaniment
                    .next(if levels.monitor_accompaniment {
                        1.0
                    } else {
                        0.0
                    }),
            ),
            voice_gain: self.voice.next(if levels.voice.muted {
                0.0
            } else {
                levels.voice.gain
            }),
            mute_generation: self.settings.mute_generation,
        }
    }
    pub fn finish_block(&self) {
        Shared::meter(&self.shared.accompaniment_peak, self.peak);
    }
}

pub struct Broadcast {
    rate: u32,
    shared: Arc<Shared>,
    source: Arc<process_capture::Shared>,
    settings: Settings,
    mixer: AlignedMixer,
    voice_gain: Gain,
    accompaniment_gate: Gain,
    source_failed: bool,
}
impl Broadcast {
    pub fn new(
        rate: u32,
        shared: Arc<Shared>,
        source: Arc<process_capture::Shared>,
    ) -> Result<Self> {
        let settings = shared
            .read()
            .ok_or_else(|| anyhow!("ミックス設定を取得できません"))?;
        let mixer = AlignedMixer::new(
            rate,
            Delays::new(rate, settings.levels.offset_ms, settings.known_voice_frames)?,
        )?;
        Ok(Self {
            rate,
            shared,
            source,
            settings,
            mixer,
            voice_gain: Gain::new(rate),
            accompaniment_gate: Gain::new(rate),
            source_failed: false,
        })
    }
    pub fn reset(&mut self) {
        self.mixer.reset();
    }
    pub fn process(&mut self, audio: &mut [Vec<f32>], frames: &[BroadcastFrame]) {
        if let Some(settings) = self.shared.read() {
            if settings.mute_generation != self.settings.mute_generation {
                self.mixer.reset();
            }
            self.settings = settings;
        }
        let delay = Delays::checked(
            self.rate,
            self.settings.levels.offset_ms,
            self.settings.known_voice_frames,
        );
        if !delay.is_some_and(|delay| self.mixer.change(delay)) {
            self.shared.failed.store(true, Ordering::Release);
        }
        if self.shared.failed.load(Ordering::Acquire) {
            for channel in audio.iter_mut().take(2) {
                channel[..frames.len()].fill(0.0);
            }
            return;
        }
        let source_failed = self.source.failed.load(Ordering::Acquire);
        if source_failed != self.source_failed {
            self.mixer.clear_accompaniment();
            self.source_failed = source_failed;
        }
        let voice_target = if self.settings.levels.voice.muted {
            0.0
        } else {
            self.settings.levels.voice.gain
        };
        let music_target = if source_failed || self.settings.levels.accompaniment.muted {
            0.0
        } else {
            1.0
        };
        let mut voice_peak = [0.0; 2];
        let mut mix_peak = [0.0; 2];
        for (index, frame) in frames.iter().enumerate() {
            let voice = scale(
                [audio[0][index], audio[1][index]],
                self.voice_gain.next(voice_target),
            );
            let gain = self.accompaniment_gate.next(music_target);
            let music = if frame.mute_generation == self.settings.mute_generation && !source_failed
            {
                scale(frame.accompaniment, gain)
            } else {
                [0.0; 2]
            };
            let mixed = self.mixer.sample(voice, music);
            peak(&mut voice_peak, voice);
            peak(&mut mix_peak, mixed);
            audio[0][index] = mixed[0];
            audio[1][index] = mixed[1];
        }
        Shared::meter(&self.shared.voice_peak, voice_peak);
        Shared::meter(&self.shared.mix_peak, mix_peak);
        if self.mixer.settled()
            && self.voice_gain.settled(voice_target)
            && self.accompaniment_gate.settled(music_target)
        {
            self.shared
                .applied_revision
                .fetch_max(self.settings.revision, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsp464_voice_peak_precedes_alignment_while_mix_peak_follows_alignment() {
        let levels = super::super::Levels {
            offset_ms: -100,
            ..Default::default()
        };
        let shared = Arc::new(Shared::new(&levels));
        shared.update(&levels, Some(0)).unwrap();
        let source = Arc::new(process_capture::Shared::new(Arc::default()));
        let mut worker = Broadcast::new(48_000, shared.clone(), source).unwrap();
        let frames = [BroadcastFrame::default(); 256];
        let mut audio = vec![vec![0.0; 256]; 2];
        // 無音でgainだけ収束させる。遅延線には有音をまだ入れない。
        worker.process(&mut audio, &frames);
        audio[0][0] = 0.4;
        audio[1][0] = -0.2;
        worker.process(&mut audio, &frames);
        assert_eq!(Shared::peaks(&shared.voice_peak), [0.4, 0.2]);
        assert_eq!(Shared::peaks(&shared.mix_peak), [0.0; 2]);
        assert!(audio.iter().flatten().all(|sample| *sample == 0.0));
        let mut rendered = 0;
        let mut impulse = None;
        for _ in 0..20 {
            audio.iter_mut().for_each(|channel| channel.fill(0.0));
            worker.process(&mut audio, &frames);
            assert_eq!(Shared::peaks(&shared.voice_peak), [0.0; 2]);
            if let Some(index) = audio[0].iter().position(|sample| *sample != 0.0) {
                assert_eq!(Shared::peaks(&shared.mix_peak), [0.4, 0.2]);
                assert_eq!([audio[0][index], audio[1][index]], [0.4, -0.2]);
                impulse = Some(256 + rendered + index);
            }
            rendered += 256;
        }
        assert_eq!(impulse, Some(4800));
        eprintln!("#464 alignment: voice_peak=[0.4,0.2] before delay, mix_peak=[0.4,0.2] at 4800 frames (100 ms)");
    }
    #[test]
    fn invalid_declared_delay_mutes_broadcast_without_allocating_an_error_in_processing() {
        let shared = Arc::new(Shared::new(&super::super::Levels::default()));
        let source = Arc::new(process_capture::Shared::new(Arc::default()));
        let mut worker = Broadcast::new(48000, shared.clone(), source).unwrap();
        shared
            .update(&super::super::Levels::default(), Some(u32::MAX))
            .unwrap();
        let frames = [BroadcastFrame::default(); 64];
        let mut audio = vec![vec![0.5; 64], vec![-0.5; 64]];
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| worker.process(&mut audio, &frames)),
            (0, 0)
        );
        assert!(shared.failed.load(Ordering::Acquire));
        assert!(audio.iter().flatten().all(|sample| *sample == 0.0));
    }
    #[test]
    fn rapid_track_mute_round_trip_does_not_replay_pre_mute_queued_music() {
        let mut levels = super::super::Levels {
            voice: super::super::Track {
                gain: 0.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let shared = Arc::new(Shared::new(&levels));
        shared.update(&levels, Some(0)).unwrap();
        let source = Arc::new(process_capture::Shared::new(Arc::default()));
        let mut worker = Broadcast::new(48000, shared.clone(), source).unwrap();
        let mut frames = [BroadcastFrame {
            accompaniment: [0.7; 2],
            ..Default::default()
        }; 512];
        let mut audio = vec![vec![0.0; 512]; 2];
        worker.process(&mut audio, &frames);
        levels.accompaniment.muted = true;
        shared.update(&levels, Some(0)).unwrap();
        levels.accompaniment.muted = false;
        shared.update(&levels, Some(0)).unwrap();
        audio.iter_mut().for_each(|channel| channel.fill(0.0));
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| worker.process(&mut audio, &frames)),
            (0, 0)
        );
        assert!(audio.iter().flatten().all(|sample| *sample == 0.0));
        for frame in &mut frames {
            frame.mute_generation = 2;
            frame.accompaniment = [0.2; 2];
        }
        audio.iter_mut().for_each(|channel| channel.fill(0.0));
        worker.process(&mut audio, &frames);
        assert_eq!(audio[0][511], 0.2);
    }
    #[test]
    fn broadcast_mixes_once_keeps_headroom_and_retains_voice_after_music_failure() {
        let shared = Arc::new(Shared::new(&super::super::Levels::default()));
        shared
            .update(&super::super::Levels::default(), Some(0))
            .unwrap();
        let source = Arc::new(process_capture::Shared::new(Arc::default()));
        let mut worker = Broadcast::new(48000, shared.clone(), source.clone()).unwrap();
        let frames = vec![
            BroadcastFrame {
                voice: [0.8, -0.8],
                accompaniment: [0.7, -0.7],
                recovery_gain: 1.0,
                mute_generation: 0
            };
            512
        ];
        let mut audio = vec![vec![0.8; 512], vec![-0.8; 512]];
        let counts =
            crate::vst_host::instance::allocation_counts(|| worker.process(&mut audio, &frames));
        assert_eq!(counts, (0, 0));
        assert!((audio[0][511] - 1.5).abs() < 0.00001);
        assert!((audio[1][511] + 1.5).abs() < 0.00001);
        source.failed.store(true, Ordering::Release);
        audio[0].fill(0.8);
        audio[1].fill(-0.8);
        worker.process(&mut audio, &frames);
        assert!((audio[0][511] - 0.8).abs() < 0.00001);
        assert!(!shared.failed.load(Ordering::Acquire));
    }
}
