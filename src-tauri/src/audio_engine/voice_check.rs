use anyhow::{anyhow, Result};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::cell::UnsafeCell;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

pub const VOICE_CHECK_MAX_MS: u32 = 30_000;
pub const VOICE_CHECK_CHANNELS: usize = 2;
pub const VOICE_CHECK_ENVELOPE_BUCKETS: usize = 256;

pub const VC_STATE_IDLE: u32 = 0;
pub const VC_STATE_RECORDING: u32 = 1;
pub const VC_STATE_READY: u32 = 2;
pub const VC_STATE_PLAYING: u32 = 3;

pub const VC_SOURCE_RAW: u32 = 0;
pub const VC_SOURCE_PROCESSED: u32 = 1;

/// UI / IPC 向けの共有状態（RT スレッドから lock-free に更新）
pub struct VoiceCheckShared {
    pub state: AtomicU32,
    pub duration_frames: AtomicU64,
    pub max_frames: AtomicU64,
    pub playback_frame: AtomicU64,
    pub playback_source: AtomicU32,
    pub loop_playback: AtomicBool,
    pub sample_rate_hz: AtomicU32,
    /// 録音完了後にエンベロープ再計算が必要
    pub envelope_dirty: AtomicBool,
}

impl VoiceCheckShared {
    pub fn new() -> Self {
        Self {
            state: AtomicU32::new(VC_STATE_IDLE),
            duration_frames: AtomicU64::new(0),
            max_frames: AtomicU64::new(0),
            playback_frame: AtomicU64::new(0),
            playback_source: AtomicU32::new(VC_SOURCE_PROCESSED),
            loop_playback: AtomicBool::new(false),
            sample_rate_hz: AtomicU32::new(48_000),
            envelope_dirty: AtomicBool::new(false),
        }
    }

    pub fn state_label(&self) -> &'static str {
        match self.state.load(Ordering::Relaxed) {
            VC_STATE_RECORDING => "recording",
            VC_STATE_READY => "ready",
            VC_STATE_PLAYING => "playing",
            _ => "idle",
        }
    }

    pub fn position_ms(&self) -> u32 {
        let sr = self.sample_rate_hz.load(Ordering::Relaxed).max(1);
        let state = self.state.load(Ordering::Relaxed);
        let frames = match state {
            VC_STATE_RECORDING => self.duration_frames.load(Ordering::Relaxed),
            VC_STATE_PLAYING => self.playback_frame.load(Ordering::Relaxed),
            _ => 0,
        };
        ((frames as f64 * 1000.0) / sr as f64).round() as u32
    }

    pub fn duration_ms(&self) -> u32 {
        let sr = self.sample_rate_hz.load(Ordering::Relaxed).max(1);
        let frames = self.duration_frames.load(Ordering::Relaxed);
        ((frames as f64 * 1000.0) / sr as f64).round() as u32
    }
}

pub struct VoiceCheckBuffers {
    raw: UnsafeCell<Box<[f32]>>,
    processed: UnsafeCell<Box<[f32]>>,
    pub capacity_frames: usize,
}

// RT スレッドのみが書き込み、録音停止後にイベントループが読み取る
unsafe impl Sync for VoiceCheckBuffers {}

impl VoiceCheckBuffers {
    pub fn raw_slice(&self) -> &[f32] {
        unsafe { &*self.raw.get() }
    }

    pub fn processed_slice(&self) -> &[f32] {
        unsafe { &*self.processed.get() }
    }

    pub fn write_raw(&self, idx: usize, left: f32, right: f32) {
        unsafe {
            let raw = &mut *self.raw.get();
            if idx + 1 < raw.len() {
                raw[idx] = left;
                raw[idx + 1] = right;
            }
        }
    }

    pub fn write_processed(&self, idx: usize, left: f32, right: f32) {
        unsafe {
            let processed = &mut *self.processed.get();
            if idx + 1 < processed.len() {
                processed[idx] = left;
                processed[idx + 1] = right;
            }
        }
    }
}

pub fn allocate_voice_check_buffers(max_ms: u32, sample_rate_hz: u32) -> VoiceCheckBuffers {
    let max_ms = max_ms.clamp(500, VOICE_CHECK_MAX_MS);
    let sr = sample_rate_hz.max(8_000);
    let capacity_frames =
        ((max_ms as u64 * sr as u64) / 1000).max(1) as usize;
    let sample_count = capacity_frames * VOICE_CHECK_CHANNELS;
    VoiceCheckBuffers {
        raw: UnsafeCell::new(vec![0.0; sample_count].into_boxed_slice()),
        processed: UnsafeCell::new(vec![0.0; sample_count].into_boxed_slice()),
        capacity_frames,
    }
}

pub fn parse_voice_check_source(source: &str) -> u32 {
    if source.eq_ignore_ascii_case("raw") {
        VC_SOURCE_RAW
    } else {
        VC_SOURCE_PROCESSED
    }
}

pub fn compute_peak_envelope(
    buffer: &[f32],
    num_frames: usize,
    buckets: usize,
) -> Vec<f32> {
    if num_frames == 0 || buckets == 0 {
        return vec![0.0; buckets.max(1)];
    }
    let buckets = buckets.max(1);
    let mut peaks = vec![0.0f32; buckets];
    let frames_per_bucket = (num_frames / buckets).max(1);
    for (bucket, peak) in peaks.iter_mut().enumerate() {
        let start = bucket * frames_per_bucket;
        if start >= num_frames {
            break;
        }
        let end = (start + frames_per_bucket).min(num_frames);
        let mut max_peak = 0.0f32;
        for frame in start..end {
            let base = frame * VOICE_CHECK_CHANNELS;
            if base + 1 < buffer.len() {
                let mono = (buffer[base].abs() + buffer[base + 1].abs()) * 0.5;
                if mono > max_peak {
                    max_peak = mono;
                }
            }
        }
        *peak = max_peak;
    }
    peaks
}

pub fn export_voice_check_wav(
    path: &Path,
    buffers: &VoiceCheckBuffers,
    source: &str,
    sample_rate_hz: u32,
    duration_frames: u64,
) -> Result<()> {
    let frames = duration_frames.min(buffers.capacity_frames as u64) as usize;
    if frames == 0 {
        return Err(anyhow!("録音データがありません"));
    }

    let interleaved = if parse_voice_check_source(source) == VC_SOURCE_RAW {
        &buffers.raw_slice()[..frames * VOICE_CHECK_CHANNELS]
    } else {
        &buffers.processed_slice()[..frames * VOICE_CHECK_CHANNELS]
    };

    let spec = WavSpec {
        channels: VOICE_CHECK_CHANNELS as u16,
        sample_rate: sample_rate_hz.max(8_000),
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };

    let mut writer = WavWriter::create(path, spec)?;
    for &sample in interleaved {
        writer.write_sample(sample)?;
    }
    writer.finalize()?;
    Ok(())
}

/// RT コールバック内専用（アロケーション / ロック禁止）
pub struct RtVoiceCheck {
    shared: Arc<VoiceCheckShared>,
    buffers: Option<Arc<VoiceCheckBuffers>>,
    record_frame: u64,
    playback_frame: u64,
    playback_active: bool,
    recording_active: bool,
    playback_source: u32,
    loop_playback: bool,
    playback_gain: f32,
    playback_gain_target: f32,
    fade_samples: usize,
    fade_samples_left: usize,
    pending_source: Option<u32>,
    _sample_rate_hz: u32,
}

impl RtVoiceCheck {
    pub fn new(shared: Arc<VoiceCheckShared>, sample_rate_hz: u32) -> Self {
        let fade_samples = ((sample_rate_hz as f64 * 0.005).round() as usize).max(1);
        Self {
            shared,
            buffers: None,
            record_frame: 0,
            playback_frame: 0,
            playback_active: false,
            recording_active: false,
            playback_source: VC_SOURCE_PROCESSED,
            loop_playback: false,
            playback_gain: 0.0,
            playback_gain_target: 0.0,
            fade_samples,
            fade_samples_left: 0,
            pending_source: None,
            _sample_rate_hz: sample_rate_hz,
        }
    }

    fn begin_fade_to(&mut self, target: f32) {
        self.playback_gain_target = target.clamp(0.0, 1.0);
        self.fade_samples_left = self.fade_samples;
    }

    fn update_fade(&mut self) -> f32 {
        if self.fade_samples_left > 0 {
            let step =
                (self.playback_gain_target - self.playback_gain) / self.fade_samples_left as f32;
            self.playback_gain += step;
            self.fade_samples_left -= 1;
        } else {
            self.playback_gain = self.playback_gain_target;
            if self.playback_gain <= 0.0001
                && self.playback_gain_target <= 0.0001
                && self.pending_source.is_some()
            {
                self.playback_source = self.pending_source.take().unwrap_or(self.playback_source);
                self.shared
                    .playback_source
                    .store(self.playback_source, Ordering::Relaxed);
                self.begin_fade_to(1.0);
            }
        }
        self.playback_gain.clamp(0.0, 1.0)
    }

    pub fn start_recording(&mut self, buffers: Arc<VoiceCheckBuffers>, max_frames: u64) {
        self.stop_playback();
        self.buffers = Some(buffers);
        self.record_frame = 0;
        self.recording_active = true;
        self.shared
            .duration_frames
            .store(0, Ordering::Relaxed);
        self.shared
            .max_frames
            .store(max_frames, Ordering::Relaxed);
        self.shared
            .state
            .store(VC_STATE_RECORDING, Ordering::Relaxed);
        self.shared
            .envelope_dirty
            .store(false, Ordering::Relaxed);
    }

    pub fn stop_recording(&mut self) {
        if !self.recording_active {
            return;
        }
        self.recording_active = false;
        self.shared
            .duration_frames
            .store(self.record_frame, Ordering::Relaxed);
        if self.record_frame > 0 {
            self.shared
                .state
                .store(VC_STATE_READY, Ordering::Relaxed);
            self.shared.envelope_dirty.store(true, Ordering::Relaxed);
        } else {
            self.shared.state.store(VC_STATE_IDLE, Ordering::Relaxed);
        }
    }

    pub fn start_playback(&mut self, source: u32, loop_playback: bool) {
        let duration = self.shared.duration_frames.load(Ordering::Relaxed);
        if duration == 0 {
            return;
        }
        self.recording_active = false;
        self.playback_source = source;
        self.loop_playback = loop_playback;
        self.playback_frame = 0;
        self.playback_active = true;
        self.pending_source = None;
        self.playback_gain = 0.0;
        self.begin_fade_to(1.0);
        self.shared
            .playback_source
            .store(source, Ordering::Relaxed);
        self.shared
            .loop_playback
            .store(loop_playback, Ordering::Relaxed);
        self.shared
            .playback_frame
            .store(0, Ordering::Relaxed);
        self.shared
            .state
            .store(VC_STATE_PLAYING, Ordering::Relaxed);
    }

    pub fn stop_playback(&mut self) {
        if !self.playback_active {
            return;
        }
        self.begin_fade_to(0.0);
    }

    pub fn finalize_playback_stop(&mut self) {
        if self.playback_active && self.playback_gain_target <= 0.0001 && self.playback_gain <= 0.0001
        {
            self.playback_active = false;
            let duration = self.shared.duration_frames.load(Ordering::Relaxed);
            if duration > 0 {
                self.shared
                    .state
                    .store(VC_STATE_READY, Ordering::Relaxed);
            } else {
                self.shared.state.store(VC_STATE_IDLE, Ordering::Relaxed);
            }
        }
    }

    pub fn set_playback_source(&mut self, source: u32) {
        if !self.playback_active || source == self.playback_source {
            return;
        }
        self.pending_source = Some(source);
        self.begin_fade_to(0.0);
    }

    pub fn is_playback_active(&self) -> bool {
        self.playback_active
    }

    pub fn is_recording_active(&self) -> bool {
        self.recording_active
    }

    pub fn attach_buffers(&mut self, buffers: Arc<VoiceCheckBuffers>) {
        self.buffers = Some(buffers);
    }

    pub fn set_loop_playback(&mut self, loop_playback: bool) {
        self.loop_playback = loop_playback;
        self.shared
            .loop_playback
            .store(loop_playback, Ordering::Relaxed);
    }

    pub fn block_record_start(&self) -> u64 {
        self.record_frame
    }

    pub fn record_raw_at(&mut self, absolute_frame: u64, left: f32, right: f32) {
        let Some(buffers) = &self.buffers else {
            return;
        };
        let max_frames = self.shared.max_frames.load(Ordering::Relaxed);
        if absolute_frame >= max_frames {
            self.stop_recording();
            return;
        }
        let idx = (absolute_frame as usize) * VOICE_CHECK_CHANNELS;
        buffers.write_raw(idx, left, right);
    }

    pub fn record_processed_at(&mut self, absolute_frame: u64, left: f32, right: f32) {
        let Some(buffers) = &self.buffers else {
            return;
        };
        let duration = self.shared.max_frames.load(Ordering::Relaxed);
        if absolute_frame >= duration {
            return;
        }
        let idx = (absolute_frame as usize) * VOICE_CHECK_CHANNELS;
        buffers.write_processed(idx, left, right);
    }

    pub fn advance_recording(&mut self, frames: usize) {
        if !self.recording_active {
            return;
        }
        let max_frames = self.shared.max_frames.load(Ordering::Relaxed);
        self.record_frame = self.record_frame.saturating_add(frames as u64);
        if self.record_frame >= max_frames {
            self.record_frame = max_frames;
            self.stop_recording();
        }
        self.shared
            .duration_frames
            .store(self.record_frame, Ordering::Relaxed);
    }

    pub fn read_playback_sample(&mut self) -> (f32, f32) {
        let gain = self.update_fade();
        if gain <= 0.00001 && self.playback_gain_target <= 0.00001 {
            self.finalize_playback_stop();
            return (0.0, 0.0);
        }

        let Some(buffers) = &self.buffers else {
            return (0.0, 0.0);
        };
        let duration = self.shared.duration_frames.load(Ordering::Relaxed);
        if duration == 0 {
            return (0.0, 0.0);
        }

        if self.playback_frame >= duration {
            if self.loop_playback {
                self.playback_frame = 0;
            } else {
                self.begin_fade_to(0.0);
                return (0.0, 0.0);
            }
        }

        let frame = self.playback_frame;
        let idx = (frame as usize) * VOICE_CHECK_CHANNELS;
        let slice = if self.playback_source == VC_SOURCE_RAW {
            buffers.raw_slice()
        } else {
            buffers.processed_slice()
        };
        let left = if idx < slice.len() {
            slice[idx] * gain
        } else {
            0.0
        };
        let right = if idx + 1 < slice.len() {
            slice[idx + 1] * gain
        } else {
            left
        };

        self.playback_frame += 1;
        self.shared
            .playback_frame
            .store(self.playback_frame.min(duration), Ordering::Relaxed);

        (left, right)
    }

    pub fn end_block(&mut self) {
        if self.recording_active {
            self.shared
                .duration_frames
                .store(self.record_frame, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn peak_envelope_respects_frame_count() {
        let mut buf = vec![0.0; 200];
        for i in 0..100 {
            buf[i * 2] = (i as f32 / 100.0).sin().abs();
            buf[i * 2 + 1] = buf[i * 2];
        }
        let env = compute_peak_envelope(&buf, 100, 10);
        assert_eq!(env.len(), 10);
        assert!(env.iter().any(|&v| v > 0.0));
    }

    #[test]
    fn export_wav_round_trip() {
        let buffers = allocate_voice_check_buffers(1000, 48_000);
        buffers.write_raw(0, 0.5, -0.5);
        buffers.write_processed(0, 0.25, -0.25);

        let path = std::env::temp_dir().join("auralyn_voice_check_test.wav");
        export_voice_check_wav(&path, &buffers, "raw", 48_000, 1).unwrap();
        assert!(path.exists());
        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().channels, 2);
        assert_eq!(reader.spec().sample_rate, 48_000);
        let _ = fs::remove_file(path);
    }
}
