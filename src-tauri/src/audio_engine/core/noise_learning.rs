//! 定常ノイズ学習とブロックの音量判定。音声サンプル自体は共有しない。
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc,
};

const NOISE_LEARNING_IDLE: u32 = 0;
const NOISE_LEARNING_CAPTURING: u32 = 1;
const NOISE_LEARNING_READY: u32 = 2;
const NOISE_LEARNING_INVALID: u32 = 3;

impl super::Engine {
    pub(super) fn begin_noise_learning(&mut self, duration_ms: u32) -> anyhow::Result<()> {
        if self.output_stream.is_none() || self.stream_failed.load(Ordering::Acquire) {
            return Err(anyhow::anyhow!(
                "音声が停止しています。設定から開始してから学習してください"
            ));
        }
        let frames = (f64::from(duration_ms.clamp(500, 10_000))
            * self.current_sample_rate.max(8_000.0)
            / 1000.0)
            .round() as u64;
        self.queue_audio_msg(super::AudioThreadMessage::StartNoiseLearning {
            duration_frames: frames,
        });
        Ok(())
    }
}

pub(super) struct NoiseLearningShared {
    pub(super) state: AtomicU32,
    pub(super) progress_ppm: AtomicU32,
    pub(super) profile_rms_ppm: AtomicU32,
    pub(super) recommended_mix_ppm: AtomicU32,
    pub(super) speech_detected: AtomicBool,
    pub(super) profile_available: AtomicBool,
}

impl NoiseLearningShared {
    pub(super) fn new() -> Self {
        Self {
            state: AtomicU32::new(NOISE_LEARNING_IDLE),
            progress_ppm: AtomicU32::new(0),
            profile_rms_ppm: AtomicU32::new(0),
            recommended_mix_ppm: AtomicU32::new(600_000),
            speech_detected: AtomicBool::new(false),
            profile_available: AtomicBool::new(false),
        }
    }

    pub(super) fn state_label(&self) -> &'static str {
        match self.state.load(Ordering::Relaxed) {
            NOISE_LEARNING_CAPTURING => "capturing",
            NOISE_LEARNING_READY => "ready",
            NOISE_LEARNING_INVALID => "invalid",
            _ => "idle",
        }
    }

    pub(super) fn cancel_capture(&self) {
        self.state.store(NOISE_LEARNING_IDLE, Ordering::Release);
        self.progress_ppm.store(0, Ordering::Relaxed);
        self.speech_detected.store(false, Ordering::Relaxed);
    }

    pub(super) fn progress(&self) -> f32 {
        self.progress_ppm.load(Ordering::Relaxed) as f32 / 1_000_000.0
    }

    pub(super) fn profile_rms(&self) -> f32 {
        self.profile_rms_ppm.load(Ordering::Relaxed) as f32 / 1_000_000.0
    }

    pub(super) fn recommended_mix(&self) -> f32 {
        self.recommended_mix_ppm.load(Ordering::Relaxed) as f32 / 1_000_000.0
    }
}

pub(super) struct RtNoiseLearning {
    pub(super) shared: Arc<NoiseLearningShared>,
    total_frames: u64,
    remaining_frames: u64,
    sum_sq: f64,
    count: u64,
}

impl RtNoiseLearning {
    pub(super) fn new(shared: Arc<NoiseLearningShared>) -> Self {
        Self {
            shared,
            total_frames: 0,
            remaining_frames: 0,
            sum_sq: 0.0,
            count: 0,
        }
    }

    pub(super) fn start(&mut self, duration_frames: u64) {
        self.total_frames = duration_frames.max(1);
        self.remaining_frames = self.total_frames;
        self.sum_sq = 0.0;
        self.count = 0;
        self.shared
            .state
            .store(NOISE_LEARNING_CAPTURING, Ordering::Relaxed);
        self.shared.progress_ppm.store(0, Ordering::Relaxed);
        self.shared.speech_detected.store(false, Ordering::Relaxed);
    }

    pub(super) fn cancel(&mut self) {
        self.total_frames = 0;
        self.remaining_frames = 0;
        self.sum_sq = 0.0;
        self.count = 0;
        self.shared.cancel_capture();
    }

    pub(super) fn analyze_block(&mut self, left: &[f32], right: Option<&[f32]>, frames: usize) {
        let frames = frames
            .min(left.len())
            .min(right.map_or(left.len(), |r| r.len()));
        if frames == 0 {
            return;
        }
        if left[..frames].iter().any(|s| !s.is_finite())
            || right.is_some_and(|r| r[..frames].iter().any(|s| !s.is_finite()))
        {
            let capturing = self.remaining_frames > 0;
            self.cancel();
            if capturing {
                self.shared
                    .state
                    .store(NOISE_LEARNING_INVALID, Ordering::Release);
            }
            self.shared.speech_detected.store(true, Ordering::Relaxed);
            return;
        }
        let mut sum_sq = 0.0f64;
        for i in 0..frames {
            let r = right.map(|ch| ch[i]).unwrap_or(left[i]);
            // 左右を加算してから二乗すると、逆位相の入力が無音として学習される。
            sum_sq += (f64::from(left[i]).powi(2) + f64::from(r).powi(2)) * 0.5;
        }

        let rms = if frames > 0 {
            (sum_sq / frames as f64).sqrt() as f32
        } else {
            0.0
        };
        let profile = self.shared.profile_rms();
        let speech_threshold = (profile * 2.8).max(0.018);
        self.shared
            .speech_detected
            .store(rms > speech_threshold, Ordering::Relaxed);

        if self.remaining_frames == 0 {
            return;
        }

        let take = frames.min(self.remaining_frames as usize);
        for i in 0..take {
            let r = right.map(|ch| ch[i]).unwrap_or(left[i]);
            self.sum_sq += (f64::from(left[i]).powi(2) + f64::from(r).powi(2)) * 0.5;
        }
        self.count += take as u64;
        self.remaining_frames = self.remaining_frames.saturating_sub(take as u64);
        let done = self.total_frames.saturating_sub(self.remaining_frames);
        let progress = ((done as f64 / self.total_frames as f64) * 1_000_000.0) as u32;
        self.shared
            .progress_ppm
            .store(progress.min(1_000_000), Ordering::Relaxed);

        if self.remaining_frames == 0 {
            let rms = if self.count > 0 {
                (self.sum_sq / self.count as f64).sqrt() as f32
            } else {
                0.0
            };
            let recommended = if rms < 0.004 {
                0.55
            } else if rms < 0.012 {
                0.68
            } else if rms < 0.03 {
                0.82
            } else {
                0.92
            };
            self.shared.profile_rms_ppm.store(
                (rms.clamp(0.0, 1.0) * 1_000_000.0) as u32,
                Ordering::Relaxed,
            );
            self.shared
                .recommended_mix_ppm
                .store((recommended * 1_000_000.0) as u32, Ordering::Relaxed);
            self.shared.profile_available.store(true, Ordering::Relaxed);
            self.shared
                .state
                .store(NOISE_LEARNING_READY, Ordering::Relaxed);
            self.shared.progress_ppm.store(1_000_000, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    #[test]
    fn opposite_phase_stereo_has_the_same_learned_energy_as_in_phase_stereo() {
        for inverse in [false, true] {
            let shared = Arc::new(NoiseLearningShared::new());
            let mut learning = RtNoiseLearning::new(shared.clone());
            let right = [if inverse { -0.1 } else { 0.1 }; 4];
            assert_eq!(
                allocation_counts(|| {
                    learning.start(4);
                    learning.analyze_block(&[0.1; 4], Some(&right), 4);
                }),
                (0, 0)
            );
            assert!((shared.profile_rms() - 0.1).abs() < 0.000002);
            assert_eq!(shared.state_label(), "ready");
            assert!(shared.speech_detected.load(Ordering::Relaxed));
        }
    }

    #[test]
    fn invalid_audio_does_not_replace_the_last_valid_profile_and_can_be_retried() {
        let shared = Arc::new(NoiseLearningShared::new());
        let mut learning = RtNoiseLearning::new(shared.clone());
        learning.start(4);
        learning.analyze_block(&[0.01; 4], None, 4);
        let profile = shared.profile_rms();
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            learning.start(4);
            learning.analyze_block(&[invalid; 4], None, 4);
            assert_eq!(shared.state_label(), "invalid");
            assert_eq!(shared.profile_rms(), profile);
            assert!(shared.profile_available.load(Ordering::Relaxed));
        }
        learning.start(4);
        learning.analyze_block(&[0.03; 4], None, 4);
        assert_eq!(shared.state_label(), "ready");
        assert!((shared.profile_rms() - 0.03).abs() < 0.000002);
    }

    #[test]
    fn short_blocks_use_only_available_samples_and_cancel_keeps_the_profile() {
        let shared = Arc::new(NoiseLearningShared::new());
        let mut learning = RtNoiseLearning::new(shared.clone());
        learning.start(4);
        learning.analyze_block(&[0.02; 2], Some(&[0.02]), usize::MAX);
        assert_eq!(shared.progress(), 0.25);
        learning.analyze_block(&[0.02; 3], None, 3);
        assert_eq!(shared.state_label(), "ready");
        let profile = shared.profile_rms();
        learning.start(4);
        learning.cancel();
        assert_eq!(shared.state_label(), "idle");
        assert_eq!(shared.progress(), 0.0);
        assert_eq!(shared.profile_rms(), profile);
    }

    #[test]
    fn stopped_engine_rejects_learning_without_queuing_a_delayed_start() {
        let mut engine = super::super::Engine::new();
        assert!(engine.begin_noise_learning(3000).is_err());
        assert!(engine.pending_audio_msgs.is_empty());
        assert_eq!(engine.noise_learning.state_label(), "idle");
    }
}
