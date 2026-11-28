mod buffers;
#[path = "builtin_candidate.rs"]
pub(crate) mod candidate;
#[path = "voice_check_preview.rs"]
pub mod preview;
use anyhow::{anyhow, Result};
use buffers::RecordingWriter;
pub(crate) use buffers::VoiceCheckBufferStore;
pub use buffers::{allocate_voice_check_buffers, VoiceCheckBuffers};
use hound::{SampleFormat, WavSpec, WavWriter};
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
    // 制御側の予約と、callbackが適用した最後のtransport操作を分ける。
    transport_requested: AtomicU64,
    transport_applied: AtomicU64,
    /// 録音完了後にエンベロープ再計算が必要
    pub envelope_dirty: AtomicBool,
}

impl Default for VoiceCheckShared {
    fn default() -> Self {
        Self::new()
    }
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
            transport_requested: AtomicU64::new(0),
            transport_applied: AtomicU64::new(0),
            envelope_dirty: AtomicBool::new(false),
        }
    }

    pub(crate) fn reserve_transport(&self) -> u64 {
        self.transport_requested
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1)
    }

    pub(crate) fn acknowledge_transport(&self, revision: u64) {
        // state更新後のReleaseを受けてから、制御側がstateを読む。
        self.transport_applied.store(revision, Ordering::Release);
    }

    pub(crate) fn transport_busy(&self) -> bool {
        let applied = self.transport_applied.load(Ordering::Acquire);
        applied != self.transport_requested.load(Ordering::Acquire)
            || matches!(
                self.state.load(Ordering::Acquire),
                VC_STATE_RECORDING | VC_STATE_PLAYING
            )
    }

    pub(crate) fn reset_transport_after_stream_drop(&self) {
        self.transport_requested.store(0, Ordering::Release);
        self.transport_applied.store(0, Ordering::Release);
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

pub fn parse_voice_check_source(source: &str) -> u32 {
    if source.eq_ignore_ascii_case("raw") {
        VC_SOURCE_RAW
    } else {
        VC_SOURCE_PROCESSED
    }
}

pub fn compute_peak_envelope(buffer: &[f32], num_frames: usize, buckets: usize) -> Vec<f32> {
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
) -> Result<()> {
    let recording = buffers
        .recording()
        .ok_or_else(|| anyhow!("録音の停止がまだ完了していません"))?;
    let frames = recording.frames;
    if frames == 0 {
        return Err(anyhow!("録音データがありません"));
    }

    let interleaved = if parse_voice_check_source(source) == VC_SOURCE_RAW {
        recording.raw
    } else {
        recording.processed
    };

    let spec = WavSpec {
        channels: VOICE_CHECK_CHANNELS as u16,
        sample_rate: recording.sample_rate_hz,
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
    writer: Option<RecordingWriter>,
    record_max_frames: u64,
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
    pub(crate) fn acknowledge_transport(&self, revision: u64) {
        self.shared.acknowledge_transport(revision);
    }

    pub fn new(shared: Arc<VoiceCheckShared>, sample_rate_hz: u32) -> Self {
        let fade_samples = ((sample_rate_hz as f64 * 0.005).round() as usize).max(1);
        Self {
            shared,
            buffers: None,
            writer: None,
            record_max_frames: 0,
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
        self.stop_recording();
        self.playback_active = false;
        self.playback_gain = 0.0;
        self.playback_gain_target = 0.0;
        let Some(writer) = buffers.claim_writer() else {
            return;
        };
        self.record_max_frames = max_frames.min(buffers.capacity_frames as u64);
        self.writer = Some(writer);
        self.buffers = Some(buffers);
        self.record_frame = 0;
        self.recording_active = true;
        self.shared.duration_frames.store(0, Ordering::Relaxed);
        self.shared
            .max_frames
            .store(self.record_max_frames, Ordering::Relaxed);
        self.shared
            .state
            .store(VC_STATE_RECORDING, Ordering::Relaxed);
        self.shared.envelope_dirty.store(false, Ordering::Relaxed);
    }

    pub fn stop_recording(&mut self) {
        if !self.recording_active {
            return;
        }
        self.recording_active = false;
        if let Some(writer) = &mut self.writer {
            writer.seal(self.record_frame);
        }
        self.shared
            .duration_frames
            .store(self.record_frame, Ordering::Relaxed);
        if self.record_frame > 0 {
            self.shared.state.store(VC_STATE_READY, Ordering::Relaxed);
            self.shared.envelope_dirty.store(true, Ordering::Relaxed);
        } else {
            self.shared.state.store(VC_STATE_IDLE, Ordering::Relaxed);
        }
    }

    pub fn start_playback(&mut self, source: u32, loop_playback: bool) {
        self.stop_recording();
        let duration = self
            .buffers
            .as_ref()
            .and_then(|b| b.recording())
            .map_or(0, |r| r.frames as u64);
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
        self.shared.playback_source.store(source, Ordering::Relaxed);
        self.shared
            .loop_playback
            .store(loop_playback, Ordering::Relaxed);
        self.shared.playback_frame.store(0, Ordering::Relaxed);
        self.shared.state.store(VC_STATE_PLAYING, Ordering::Relaxed);
    }

    pub fn stop_playback(&mut self) {
        if !self.playback_active {
            return;
        }
        self.begin_fade_to(0.0);
    }

    pub fn finalize_playback_stop(&mut self) {
        if self.playback_active
            && self.playback_gain_target <= 0.0001
            && self.playback_gain <= 0.0001
        {
            self.playback_active = false;
            let duration = self.shared.duration_frames.load(Ordering::Relaxed);
            if duration > 0 {
                self.shared.state.store(VC_STATE_READY, Ordering::Relaxed);
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
        if self.recording_active && absolute_frame < self.record_max_frames {
            if let Some(writer) = &mut self.writer {
                writer.write_raw(absolute_frame, left, right);
            }
        }
    }

    pub fn record_processed_at(&mut self, absolute_frame: u64, left: f32, right: f32) {
        if self.recording_active && absolute_frame < self.record_max_frames {
            if let Some(writer) = &mut self.writer {
                writer.write_processed(absolute_frame, left, right);
            }
        }
    }

    pub fn advance_recording(&mut self, frames: usize) {
        if !self.recording_active {
            return;
        }
        let max_frames = self.record_max_frames;
        self.record_frame = self.record_frame.saturating_add(frames as u64);
        if let Some(writer) = &mut self.writer {
            writer.commit_frames(self.record_frame.min(max_frames));
        }
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
        let Some(recording) = buffers.recording() else {
            return (0.0, 0.0);
        };
        let duration = recording.frames as u64;
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
            recording.raw
        } else {
            recording.processed
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
    fn legacy_transport_remains_busy_until_ack_and_playback_fade_finish() {
        use crate::vst_host::instance::allocation_counts;
        let shared = Arc::new(VoiceCheckShared::new());
        let buffers = Arc::new(allocate_voice_check_buffers(500, 8_000));
        let mut writer = buffers.claim_writer().unwrap();
        writer.write_raw(0, 0.25, 0.25);
        writer.write_processed(0, 0.5, 0.5);
        writer.seal(1);
        let mut rt = RtVoiceCheck::new(shared.clone(), 8_000);
        rt.attach_buffers(buffers.clone());
        let play = shared.reserve_transport();
        assert!(shared.transport_busy());
        rt.start_playback(VC_SOURCE_RAW, true);
        rt.acknowledge_transport(play);
        for _ in 0..100 {
            rt.read_playback_sample();
        }
        let stop = shared.reserve_transport();
        assert!(shared.transport_busy());
        assert_eq!(
            allocation_counts(|| {
                rt.stop_playback();
                rt.acknowledge_transport(stop);
            }),
            (0, 0)
        );
        assert!(shared.transport_busy());
        assert_eq!(
            allocation_counts(|| {
                for _ in 0..100 {
                    rt.read_playback_sample();
                    rt.finalize_playback_stop();
                }
            }),
            (0, 0)
        );
        assert!(!shared.transport_busy());
        // 新録音はack後も録音中、停止要求は適用されるまで予約中。
        let recording = Arc::new(allocate_voice_check_buffers(500, 8_000));
        let start = shared.reserve_transport();
        rt.start_recording(recording.clone(), 100);
        rt.acknowledge_transport(start);
        assert!(shared.transport_busy());
        let stop = shared.reserve_transport();
        rt.stop_recording();
        assert!(shared.transport_busy());
        rt.acknowledge_transport(stop);
        assert!(!shared.transport_busy());
    }

    #[test]
    fn final_block_keeps_processed_samples_and_uses_its_own_frame_limit() {
        let shared = Arc::new(VoiceCheckShared::new());
        let buffers = Arc::new(allocate_voice_check_buffers(500, 8_000));
        let mut rt = RtVoiceCheck::new(shared.clone(), 8_000);
        rt.start_recording(buffers.clone(), 2);
        // 制御側が次の録音用の表示値を先に更新しても、現在の書き手の上限は変わらない。
        shared.max_frames.store(99_999, Ordering::Relaxed);
        for frame in 0..4 {
            rt.record_raw_at(frame, 1.0, -1.0);
        }
        assert!(rt.is_recording_active());
        assert!(buffers.recording().is_none());
        for frame in 0..4 {
            rt.record_processed_at(frame, 0.25, -0.25);
        }
        rt.advance_recording(4);
        let recording = buffers.recording().unwrap();
        assert_eq!(recording.frames, 2);
        assert_eq!(recording.processed, [0.25, -0.25, 0.25, -0.25]);
        assert!(!rt.is_recording_active());
    }

    #[test]
    fn recording_switch_playback_and_stop_do_not_allocate_or_release_on_callback() {
        use crate::vst_host::instance::allocation_counts;
        let mut store = VoiceCheckBufferStore::default();
        let first = Arc::new(allocate_voice_check_buffers(500, 8_000));
        let first_weak = Arc::downgrade(&first);
        let second = Arc::new(allocate_voice_check_buffers(500, 8_000));
        store.replace(first.clone());
        let mut rt = RtVoiceCheck::new(Arc::new(VoiceCheckShared::new()), 8_000);
        assert_eq!(allocation_counts(|| rt.start_recording(first, 1)), (0, 0));
        store.replace(second.clone());
        assert_eq!(
            allocation_counts(|| {
                rt.record_raw_at(0, 1.0, 1.0);
                rt.record_processed_at(0, 0.5, 0.5);
                rt.advance_recording(1);
                rt.start_playback(VC_SOURCE_PROCESSED, true);
                let _ = rt.read_playback_sample();
                rt.start_recording(second, 1);
                rt.stop_recording();
            }),
            (0, 0)
        );
        assert!(first_weak.upgrade().is_some());
        store.collect();
        assert!(first_weak.upgrade().is_none());
    }

    #[test]
    fn wav_export_rejects_unfinished_recording_without_creating_file() {
        let buffers = Arc::new(allocate_voice_check_buffers(500, 8_000));
        let _writer = buffers.claim_writer().unwrap();
        let path =
            std::env::temp_dir().join(format!("auralyn-unfinished-{}.wav", std::process::id()));
        assert!(export_voice_check_wav(&path, &buffers, "raw").is_err());
        assert!(!path.exists());
    }

    #[test]
    fn callback_retirement_keeps_only_fully_committed_blocks() {
        let buffers = Arc::new(allocate_voice_check_buffers(500, 8_000));
        let mut rt = RtVoiceCheck::new(Arc::new(VoiceCheckShared::new()), 8_000);
        rt.start_recording(buffers.clone(), 4_000);
        rt.record_raw_at(0, 1.0, -1.0);
        rt.record_processed_at(0, 0.5, -0.5);
        rt.advance_recording(1);
        // 次ブロックは加工前だけがあるため、callback破棄後にも公開しない。
        rt.record_raw_at(1, 2.0, -2.0);
        drop(rt);
        let recording = buffers.recording().unwrap();
        assert_eq!(recording.frames, 1);
        assert_eq!(recording.raw, [1.0, -1.0]);
        assert_eq!(recording.processed, [0.5, -0.5]);
    }

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
        let buffers = Arc::new(allocate_voice_check_buffers(1000, 48_000));
        let mut writer = buffers.claim_writer().unwrap();
        writer.write_raw(0, 0.5, -0.5);
        writer.write_processed(0, 0.25, -0.25);
        writer.seal(1);

        let path = std::env::temp_dir().join("auralyn_voice_check_test.wav");
        export_voice_check_wav(&path, &buffers, "raw").unwrap();
        assert!(path.exists());
        let mut reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().channels, 2);
        assert_eq!(reader.spec().sample_rate, 48_000);
        assert_eq!(
            reader
                .samples::<f32>()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap(),
            [0.5, -0.5]
        );
        let _ = fs::remove_file(path);
    }
}
