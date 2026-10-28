//! 定常ノイズ学習とブロックの音量判定。音声サンプル自体は共有しない。
use ringbuf::traits::Observer;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    Arc,
};

const NOISE_LEARNING_IDLE: u32 = 0;
const NOISE_LEARNING_CAPTURING: u32 = 1;
const NOISE_LEARNING_READY: u32 = 2;
const NOISE_LEARNING_INVALID: u32 = 3;

pub(super) struct NoiseLearningShared {
    pub(super) generation: AtomicU64,
    pub(super) result_generation: AtomicU64,
    pub(super) profile_valid: AtomicBool,
    pub(super) accepted_rms_ppm: AtomicU32,
    pub(super) applied_mix_ppm: AtomicU32,
    pub(super) has_applied_mix: AtomicBool,
    pub(super) quality_flags: AtomicU32,
    pub(super) measured_frames: AtomicU64,
    pub(super) peak_ppm: AtomicU32,
    pub(super) variation_ppm: AtomicU32,
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
            generation: AtomicU64::new(0),
            result_generation: AtomicU64::new(u64::MAX),
            profile_valid: AtomicBool::new(false),
            accepted_rms_ppm: AtomicU32::new(0),
            applied_mix_ppm: AtomicU32::new(600_000),
            has_applied_mix: AtomicBool::new(false),
            quality_flags: AtomicU32::new(0),
            measured_frames: AtomicU64::new(0),
            peak_ppm: AtomicU32::new(0),
            variation_ppm: AtomicU32::new(0),
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
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.profile_valid.store(false, Ordering::Release);
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

    fn approve_generation(&self, generation: u64) -> bool {
        if self.generation.load(Ordering::Acquire) != generation
            || self.result_generation.load(Ordering::Acquire) != generation
            || self.state.load(Ordering::Acquire) != NOISE_LEARNING_READY
            || self.quality_flags.load(Ordering::Relaxed) & (NON_FINITE | SILENT | CLIPPED | SHORT)
                != 0
        {
            return false;
        }
        self.accepted_rms_ppm.store(
            self.profile_rms_ppm.load(Ordering::Relaxed),
            Ordering::Relaxed,
        );
        self.applied_mix_ppm.store(
            self.recommended_mix_ppm.load(Ordering::Relaxed),
            Ordering::Relaxed,
        );
        self.has_applied_mix.store(true, Ordering::Release);
        self.profile_valid.store(true, Ordering::Release);
        true
    }

    pub(super) fn applied_mix(&self) -> f32 {
        self.applied_mix_ppm.load(Ordering::Relaxed) as f32 / 1_000_000.0
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
    capture_generation: u64,
    window_frames: usize,
    window_count: usize,
    window_energy: f64,
    min_energy: f64,
    max_energy: f64,
    peak: f32,
    flags: u32,
}

impl RtNoiseLearning {
    pub(super) fn new(shared: Arc<NoiseLearningShared>) -> Self {
        Self {
            shared,
            total_frames: 0,
            remaining_frames: 0,
            sum_sq: 0.0,
            count: 0,
            capture_generation: 0,
            window_frames: 480,
            window_count: 0,
            window_energy: 0.0,
            min_energy: f64::INFINITY,
            max_energy: 0.0,
            peak: 0.0,
            flags: 0,
        }
    }

    #[cfg(test)]
    pub(super) fn start(&mut self, duration_frames: u64) {
        self.start_with_generation(
            duration_frames,
            self.shared.generation.load(Ordering::Acquire),
            1,
        );
    }
    pub(super) fn start_with_generation(
        &mut self,
        duration_frames: u64,
        generation: u64,
        window_frames: usize,
    ) {
        if generation != self.shared.generation.load(Ordering::Acquire) {
            return;
        }
        self.capture_generation = generation;
        self.window_frames = window_frames.max(1);
        self.window_count = 0;
        self.window_energy = 0.0;
        self.min_energy = f64::INFINITY;
        self.max_energy = 0.0;
        self.peak = 0.0;
        self.flags = 0;
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
        if self.capture_generation == self.shared.generation.load(Ordering::Acquire) {
            self.shared
                .state
                .store(NOISE_LEARNING_IDLE, Ordering::Release);
            self.shared.progress_ppm.store(0, Ordering::Relaxed);
        }
    }

    pub(super) fn analyze_block(&mut self, left: &[f32], right: Option<&[f32]>, frames: usize) {
        if self.capture_generation != self.shared.generation.load(Ordering::Acquire) {
            self.remaining_frames = 0;
        }
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
            self.shared.profile_valid.store(false, Ordering::Release);
            self.flags |= NON_FINITE;
            self.shared
                .quality_flags
                .store(self.flags, Ordering::Relaxed);
            self.shared
                .result_generation
                .store(self.capture_generation, Ordering::Release);
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
        let profile = if self.shared.profile_valid.load(Ordering::Acquire) {
            self.shared.accepted_rms_ppm.load(Ordering::Relaxed) as f32 / 1_000_000.0
        } else {
            0.0
        };
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
            let energy = (f64::from(left[i]).powi(2) + f64::from(r).powi(2)) * 0.5;
            self.sum_sq += energy;
            self.peak = self.peak.max(left[i].abs()).max(r.abs());
            self.window_energy += energy;
            self.window_count += 1;
            if self.window_count == self.window_frames {
                let energy = self.window_energy / self.window_count as f64;
                self.min_energy = self.min_energy.min(energy);
                self.max_energy = self.max_energy.max(energy);
                self.window_energy = 0.0;
                self.window_count = 0;
            }
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
            if self.capture_generation != self.shared.generation.load(Ordering::Acquire) {
                return;
            }
            if rms < 0.00001 {
                self.flags |= SILENT;
            }
            if self.peak >= 0.999 {
                self.flags |= CLIPPED;
            }
            if self.count < (self.window_frames as u64 * 100) {
                self.flags |= SHORT;
            }
            let variation = (self.max_energy / self.min_energy.max(1e-10)).sqrt() as f32;
            if variation > 4.0 {
                self.flags |= VARIABLE;
            }
            if rms > 0.018 {
                self.flags |= LOUD;
            }
            self.shared
                .quality_flags
                .store(self.flags, Ordering::Relaxed);
            self.shared
                .measured_frames
                .store(self.count, Ordering::Relaxed);
            self.shared
                .peak_ppm
                .store((self.peak.min(4.0) * 1_000_000.0) as u32, Ordering::Relaxed);
            self.shared.variation_ppm.store(
                (variation.min(1000.0) * 1_000_000.0) as u32,
                Ordering::Relaxed,
            );
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
            self.shared
                .result_generation
                .store(self.capture_generation, Ordering::Release);
        }
    }
}

// 品質フラグは話者識別ではない。固定サイズの10ms窓をRTで集計する。
const NON_FINITE: u32 = 1;
const SILENT: u32 = 2;
const CLIPPED: u32 = 4;
const SHORT: u32 = 8;
const VARIABLE: u32 = 16;
const LOUD: u32 = 32;
const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conditions {
    pub engine_epoch: String,
    pub stream_attempt: String,
    pub input_revision: String,
    pub host: String,
    pub input: String,
    pub input_id: String,
    pub channels: [usize; 2],
    pub input_gain: f32,
    pub analysis_rate: u32,
    pub backend: String,
    pub model: String,
    pub analysis_version: u32,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Snapshot,
    Start {
        epoch: String,
        generation: String,
    },
    Cancel {
        epoch: String,
        generation: String,
    },
    Invalidate,
    Approve {
        epoch: String,
        generation: String,
        #[serde(rename = "acknowledgedQuiet")]
        acknowledged_quiet: bool,
    },
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Accepted {
    pub generation: String,
    pub conditions: Conditions,
    pub captured_at_unix_ms: Option<u64>,
    pub rms: f32,
    pub applied_mix: f32,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub epoch: String,
    pub generation: String,
    pub state: String,
    pub usable: bool,
    pub reason: Option<String>,
    pub conditions: Option<Conditions>,
    pub captured_at_unix_ms: Option<u64>,
    pub progress: f32,
    pub measured_frames: u64,
    pub rms: f32,
    pub peak: f32,
    pub variation_ratio: f32,
    pub quality: Vec<String>,
    pub recommended_mix: f32,
    pub applied_mix: f32,
    pub previous_available: bool,
    pub previous: Option<Accepted>,
}
#[derive(Default)]
pub(super) struct Controller {
    reference_valid: bool,
    previous: Option<Accepted>,
    conditions: Option<Conditions>,
    captured_at: Option<u64>,
    started: Option<std::time::Instant>,
    reason: Option<String>,
    observed: Option<u64>,
}
impl super::Engine {
    pub(super) fn invalidate_noise_measurement(&mut self, reason: &str) {
        let history_valid = reason == "expired" && self.noise_history_valid_before_expiry();
        self.noise_learning.cancel_capture();
        self.noise_measurement.reference_valid = false;
        // 明示された環境変更は、未学習時の録音候補も古くする。値のABAで復活させない。
        self.voice_revision = self.voice_revision.saturating_add(1);
        self.voice_preview.invalidate_candidate();
        if self.voice_check.state.load(Ordering::Acquire) == super::VC_STATE_RECORDING {
            if let Some(metadata) = &mut self.voice_metadata {
                metadata.changed_during_recording = true;
            }
        }
        self.noise_measurement.reason = Some(reason.into());
        self.rebind_noise_history_after_expiry(history_valid);
    }
    pub(super) fn begin_noise_learning(&mut self, duration_ms: u32) -> anyhow::Result<()> {
        if self.output_stream.is_none() || self.stream_failed.load(Ordering::Acquire) {
            anyhow::bail!("音声が停止しています。設定から開始してから測定してください");
        }
        super::dsp::NoiseGeometry::guard(self.current_sample_rate as u32, true)
            .map_err(anyhow::Error::msg)?;
        let input = self
            .device_manager
            .active_input
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("入力機器を確認できません"))?;
        let identity = self
            .noise_input_identity
            .clone()
            .ok_or_else(|| anyhow::anyhow!("入力機器の識別情報を確認できません"))?;
        if !self.voice_input_gain.is_finite() {
            anyhow::bail!("入力ゲインが不正です");
        }
        if self.voice_preview.active()
            || self.gain_preview.is_some()
            || self.gain_shared.active.load(Ordering::Acquire) != 0
            || self.gain_shared.requested.load(Ordering::Acquire) != 0
            || matches!(
                self.voice_check.state.load(Ordering::Acquire),
                super::VC_STATE_RECORDING | crate::audio_engine::voice_check::VC_STATE_PLAYING
            )
        {
            anyhow::bail!("試聴・音量測定を停止してから周囲の音を測定してください");
        }
        let conditions = Conditions {
            engine_epoch: self.builtin.snapshot(false).epoch,
            stream_attempt: self.queue_attempt.to_string(),
            input_revision: self.noise_input_revision.to_string(),
            host: input.host.clone(),
            input: input.name.clone(),
            input_id: identity,
            channels: [self.input_channel_l, self.input_channel_r],
            input_gain: self.voice_input_gain,
            analysis_rate: self.current_sample_rate as u32,
            backend: "nnnoiseless-0.5.2".into(),
            model: "bundled-e6de5fbfadf7ec91".into(),
            analysis_version: 1,
        };
        self.invalidate_noise_measurement("newMeasurement");
        self.noise_measurement = Controller {
            previous: self.noise_measurement.previous.clone(),
            conditions: Some(conditions),
            started: Some(std::time::Instant::now()),
            ..Controller::default()
        };
        let frames = (f64::from(duration_ms.clamp(500, 10_000)) * self.current_sample_rate / 1000.0)
            .round() as u64;
        self.queue_audio_msg(super::AudioThreadMessage::StartNoiseLearning {
            duration_frames: frames,
            generation: self.noise_learning.generation.load(Ordering::Acquire),
            window_frames: (self.current_sample_rate as usize / 100).max(1),
        });
        Ok(())
    }
    pub(super) fn poll_noise_measurement(&mut self) {
        if self.noise_measurement.reference_valid
            && !self.noise_learning.profile_valid.load(Ordering::Acquire)
        {
            self.invalidate_noise_measurement("invalidInput");
            return;
        }

        if self.noise_measurement.reason.is_none()
            && self.noise_measurement.conditions.as_ref().is_some_and(|c| {
                self.output_stream.is_none()
                    || self.stream_failed.load(Ordering::Acquire)
                    || c.input_revision != self.noise_input_revision.to_string()
                    || c.stream_attempt != self.queue_attempt.to_string()
                    || c.analysis_rate != self.current_sample_rate as u32
                    || c.input_gain != self.voice_input_gain
                    || c.channels != [self.input_channel_l, self.input_channel_r]
                    || self.noise_input_identity.as_deref() != Some(c.input_id.as_str())
            })
        {
            self.invalidate_noise_measurement("inputChangedOrStopped");
            return;
        }

        let shared = &self.noise_learning;
        let generation = shared.generation.load(Ordering::Acquire);
        if self
            .noise_measurement
            .started
            .is_some_and(|time| time.elapsed() > MAX_AGE)
            && self.noise_measurement.reason.is_none()
        {
            self.invalidate_noise_measurement("expired");
            return;
        }
        let result = shared.result_generation.load(Ordering::Acquire);
        if result == generation
            && self.noise_measurement.observed != Some(result)
            && self.noise_measurement.conditions.is_some()
        {
            self.noise_measurement.observed = Some(result);
            self.noise_measurement.captured_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64);
        }
    }
    pub(super) fn noise_measurement_snapshot(&mut self) -> Snapshot {
        self.poll_noise_measurement();
        let s = &self.noise_learning;
        let generation = s.generation.load(Ordering::Acquire);
        let current = s.result_generation.load(Ordering::Acquire) == generation;
        let mut quality = Vec::new();
        let flags = s.quality_flags.load(Ordering::Relaxed);
        if current {
            for (mask, code) in [
                (NON_FINITE, "nonFinite"),
                (SILENT, "silent"),
                (CLIPPED, "clipped"),
                (SHORT, "short"),
                (VARIABLE, "variable"),
                (LOUD, "uncertain"),
            ] {
                if flags & mask != 0 {
                    quality.push(code.into());
                }
            }
        }
        let state = if self.noise_measurement.reason.is_some() {
            "stale"
        } else if (!current && self.noise_measurement.started.is_some())
            || s.state_label() == "capturing"
        {
            "capturing"
        } else if current && flags & (NON_FINITE | SILENT | CLIPPED | SHORT) != 0 {
            "invalid"
        } else if current && s.profile_valid.load(Ordering::Acquire) {
            "approved"
        } else if current {
            "review"
        } else {
            "idle"
        };
        Snapshot {
            epoch: self.builtin.snapshot(false).epoch,
            generation: generation.to_string(),
            state: state.into(),
            usable: current && s.profile_valid.load(Ordering::Acquire),
            reason: self.noise_measurement.reason.clone(),
            conditions: self.noise_measurement.conditions.clone(),
            captured_at_unix_ms: self.noise_measurement.captured_at,
            progress: s.progress(),
            measured_frames: s.measured_frames.load(Ordering::Relaxed),
            rms: s.profile_rms(),
            peak: s.peak_ppm.load(Ordering::Relaxed) as f32 / 1_000_000.0,
            variation_ratio: s.variation_ppm.load(Ordering::Relaxed) as f32 / 1_000_000.0,
            quality,
            recommended_mix: s.recommended_mix(),
            applied_mix: s.applied_mix(),
            previous_available: self.noise_measurement.previous.is_some(),
            previous: self.noise_measurement.previous.clone(),
        }
    }
    pub(super) fn noise_measurement_request(
        &mut self,
        request: Request,
    ) -> Result<Snapshot, String> {
        self.poll_noise_measurement();
        let expected_epoch = match &request {
            Request::Start { epoch, .. }
            | Request::Cancel { epoch, .. }
            | Request::Approve { epoch, .. } => Some(epoch),
            _ => None,
        };
        if expected_epoch.is_some_and(|epoch| *epoch != self.builtin.snapshot(false).epoch) {
            return Err("音声エンジンが変わりました。測定状態を取り直してください".into());
        }

        let expected = match &request {
            Request::Start { generation, .. }
            | Request::Cancel { generation, .. }
            | Request::Approve { generation, .. } => Some(generation),
            _ => None,
        };
        if expected.is_some_and(|v| {
            *v != self
                .noise_learning
                .generation
                .load(Ordering::Acquire)
                .to_string()
        }) {
            return Err("測定条件が変わりました。状態を取り直してください".into());
        }
        match request {
            Request::Snapshot => {}
            Request::Start { .. } => self.begin_noise_learning(3000).map_err(|e| e.to_string())?,
            Request::Cancel { .. } | Request::Invalidate => {
                self.invalidate_noise_measurement("cancelledOrEnvironmentChanged")
            }
            Request::Approve {
                acknowledged_quiet, ..
            } => {
                let snapshot = self.noise_measurement_snapshot();
                if snapshot.conditions.is_none()
                    || !acknowledged_quiet
                    || snapshot.state != "review"
                    || self.output_stream.is_none()
                    || self.stream_failed.load(Ordering::Acquire)
                    || !self.pending_audio_msgs.is_empty()
                    || self.command_tx.as_ref().is_some_and(|q| !q.is_empty())
                {
                    return Err(
                        "現在の条件で測り直し、話さずに測定したことを確認してください".into(),
                    );
                }
                if self.live_modes.armed {
                    return Err("本番保護を解除してから測定値を適用してください".into());
                }
                let generation = self.noise_learning.generation.load(Ordering::Acquire);
                if !self.noise_learning.approve_generation(generation) {
                    return Err("測定結果が変わりました。測り直してください".into());
                }
                self.noise_measurement.reference_valid = true;
                self.noise_measurement.previous = snapshot.conditions.map(|conditions| Accepted {
                    generation: snapshot.generation,
                    conditions,
                    captured_at_unix_ms: snapshot.captured_at_unix_ms,
                    rms: snapshot.rms,
                    applied_mix: snapshot.recommended_mix,
                });
                self.voice_revision = self.voice_revision.saturating_add(1);
            }
        }
        Ok(self.noise_measurement_snapshot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    fn measure(shared: &Arc<NoiseLearningShared>, rate: usize, value: f32) {
        let mut learning = RtNoiseLearning::new(shared.clone());
        let generation = shared.generation.load(Ordering::Acquire);
        let samples = [value; 480];
        assert_eq!(
            allocation_counts(|| {
                learning.start_with_generation((rate * 3) as u64, generation, rate / 100);
                let mut remaining = rate * 3;
                while remaining > 0 {
                    let frames = remaining.min(samples.len());
                    learning.analyze_block(&samples, None, frames);
                    remaining -= frames;
                }
            }),
            (0, 0)
        );
    }

    #[test]
    fn measurement_is_a_candidate_until_explicit_acceptance_and_invalidation_holds_applied_mix() {
        for rate in [8_000, 44_100, 48_000, 96_000, 192_000, 384_000] {
            let shared = Arc::new(NoiseLearningShared::new());
            measure(&shared, rate, 0.01);
            assert_eq!(shared.quality_flags.load(Ordering::Acquire), 0);
            assert!(!shared.profile_valid.load(Ordering::Acquire));
            assert_eq!(shared.applied_mix(), 0.6);
            assert!(shared.approve_generation(0));
            assert_eq!(shared.applied_mix(), 0.68);
            shared.cancel_capture();
            assert!(!shared.profile_valid.load(Ordering::Acquire));
            assert!(!shared.approve_generation(0));
            assert_eq!(shared.applied_mix(), 0.68);
            assert!(shared.profile_available.load(Ordering::Acquire));
        }
    }

    #[test]
    fn silence_clip_non_finite_and_short_audio_cannot_be_accepted() {
        for value in [0.0, 1.0, f32::NAN, f32::INFINITY] {
            let shared = Arc::new(NoiseLearningShared::new());
            measure(&shared, 48_000, value);
            assert!(
                !shared.approve_generation(0),
                "accepted invalid value {value}"
            );
            assert!(!shared.profile_valid.load(Ordering::Acquire));
            assert_eq!(shared.applied_mix(), 0.6);
        }
        let shared = Arc::new(NoiseLearningShared::new());
        let mut learning = RtNoiseLearning::new(shared.clone());
        learning.start_with_generation(480, 0, 480);
        learning.analyze_block(&[0.01; 480], None, 480);
        assert_ne!(shared.quality_flags.load(Ordering::Acquire) & SHORT, 0);
        assert!(!shared.approve_generation(0));
    }

    #[test]
    fn variable_or_loud_audio_reports_uncertainty_without_claiming_speech_identity() {
        let shared = Arc::new(NoiseLearningShared::new());
        let mut learning = RtNoiseLearning::new(shared.clone());
        learning.start_with_generation(48_000 * 3, 0, 480);
        for n in 0..300 {
            let samples = [if n % 2 == 0 { 0.002 } else { 0.04 }; 480];
            learning.analyze_block(&samples, None, 480);
        }
        let flags = shared.quality_flags.load(Ordering::Acquire);
        assert_ne!(flags & VARIABLE, 0);
        assert_ne!(flags & LOUD, 0);
        // 不確かな候補は残すが、確認なしでは参照値にしない。
        assert!(!shared.profile_valid.load(Ordering::Acquire));
    }

    #[test]
    fn cancelled_generation_and_late_start_cannot_publish_into_a_new_measurement() {
        let shared = Arc::new(NoiseLearningShared::new());
        let mut learning = RtNoiseLearning::new(shared.clone());
        learning.start_with_generation(960, 0, 480);
        learning.analyze_block(&[0.01; 480], None, 480);
        shared.cancel_capture();
        learning.analyze_block(&[0.1; 480], None, 480);
        learning.start_with_generation(960, 0, 480);
        learning.analyze_block(&[0.1; 480], None, 480);
        assert_ne!(shared.result_generation.load(Ordering::Acquire), 1);
        assert!(!shared.profile_valid.load(Ordering::Acquire));
        measure(&shared, 48_000, 0.002);
        assert_eq!(shared.result_generation.load(Ordering::Acquire), 1);
        assert!(shared.approve_generation(1));
        assert_eq!(shared.applied_mix(), 0.55);
    }

    #[test]
    fn requests_reject_stale_generation_and_expiry_without_changing_nr_controls() {
        let mut engine = super::super::Engine::new();
        engine.noise_reduction_enabled = true;
        engine.noise_control_strength = 0.8;
        let before = engine.noise_learning.generation.load(Ordering::Acquire);
        assert!(engine
            .noise_measurement_request(Request::Cancel {
                epoch: "old-engine".into(),
                generation: before.to_string()
            })
            .is_err());
        assert_eq!(
            engine.noise_learning.generation.load(Ordering::Acquire),
            before
        );
        engine.invalidate_noise_measurement("manualEnvironmentChange");
        assert!(engine
            .noise_measurement_request(Request::Cancel {
                epoch: engine.builtin.snapshot(false).epoch,
                generation: before.to_string()
            })
            .is_err());
        engine.noise_measurement.started =
            Some(std::time::Instant::now() - MAX_AGE - std::time::Duration::from_secs(1));
        engine.noise_measurement.reason = None;
        let result = engine.noise_measurement_request(Request::Snapshot).unwrap();
        assert_eq!(result.state, "stale");
        assert_eq!(result.reason.as_deref(), Some("expired"));
        assert!(!result.usable);
        assert!(engine.noise_reduction_enabled);
        assert_eq!(engine.noise_control_strength, 0.8);
    }

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
