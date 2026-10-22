use std::cell::UnsafeCell;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use super::{VOICE_CHECK_CHANNELS, VOICE_CHECK_MAX_MS};

const FRESH: u32 = 0;
const WRITING: u32 = 1;
const SEALED: u32 = 2;

// 最後のArcを音声コールバックで解放しない。収集は制御スレッドだけで行う。
#[derive(Default)]
pub(crate) struct VoiceCheckBufferStore {
    current: Option<Arc<VoiceCheckBuffers>>,
    retired: Vec<Arc<VoiceCheckBuffers>>,
}

impl VoiceCheckBufferStore {
    pub(crate) fn replace(&mut self, buffers: Arc<VoiceCheckBuffers>) {
        if let Some(old) = self.current.replace(buffers) {
            self.retired.push(old);
        }
        self.collect();
    }

    pub(crate) fn current(&self) -> Option<&Arc<VoiceCheckBuffers>> {
        self.current.as_ref()
    }

    pub(crate) fn collect(&mut self) {
        self.retired.retain(|buffer| Arc::strong_count(buffer) > 1);
    }
}

pub struct VoiceCheckBuffers {
    raw: UnsafeCell<Box<[f32]>>,
    processed: UnsafeCell<Box<[f32]>>,
    phase: AtomicU32,
    completed_frames: AtomicU64,
    pub capacity_frames: usize,
    sample_rate_hz: u32,
}

// 書き込み権は一度だけclaim_writerで渡す。共有スライスは書き手が封印した後だけ公開し、
// Release/Acquireで両バッファの全書き込みを読取側へ公開する。封印後は再利用しない。
unsafe impl Sync for VoiceCheckBuffers {}

pub struct Recording<'a> {
    pub raw: &'a [f32],
    pub processed: &'a [f32],
    pub frames: usize,
    pub sample_rate_hz: u32,
}

impl VoiceCheckBuffers {
    pub(super) fn claim_writer(self: &Arc<Self>) -> Option<RecordingWriter> {
        self.phase
            .compare_exchange(FRESH, WRITING, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        Some(RecordingWriter {
            buffers: self.clone(),
            sealed: false,
            completed_frames: 0,
        })
    }

    pub fn recording(&self) -> Option<Recording<'_>> {
        if self.phase.load(Ordering::Acquire) != SEALED {
            return None;
        }
        let frames = self.completed_frames.load(Ordering::Relaxed) as usize;
        let length = frames * VOICE_CHECK_CHANNELS;
        // SEALED以降は書き込み権を再発行せず、writerも書き込まない。
        unsafe {
            Some(Recording {
                raw: &(&*self.raw.get())[..length],
                processed: &(&*self.processed.get())[..length],
                frames,
                sample_rate_hz: self.sample_rate_hz,
            })
        }
    }
}

pub(super) struct RecordingWriter {
    buffers: Arc<VoiceCheckBuffers>,
    sealed: bool,
    completed_frames: u64,
}

impl RecordingWriter {
    pub(super) fn commit_frames(&mut self, frames: u64) {
        self.completed_frames = frames.min(self.buffers.capacity_frames as u64);
    }
    fn write(&mut self, processed: bool, frame: u64, left: f32, right: f32) {
        if self.sealed || frame >= self.buffers.capacity_frames as u64 {
            return;
        }
        let index = frame as usize * VOICE_CHECK_CHANNELS;
        let cell = if processed {
            &self.buffers.processed
        } else {
            &self.buffers.raw
        };
        // このtokenだけが書き手であり、共有読取はまだ公開されていない。
        unsafe {
            let samples = &mut *cell.get();
            samples[index] = left;
            samples[index + 1] = right;
        }
    }

    pub(super) fn write_raw(&mut self, frame: u64, left: f32, right: f32) {
        self.write(false, frame, left, right);
    }

    pub(super) fn write_processed(&mut self, frame: u64, left: f32, right: f32) {
        self.write(true, frame, left, right);
    }

    pub(super) fn seal(&mut self, frames: u64) {
        if !self.sealed {
            self.buffers.completed_frames.store(
                frames.min(self.buffers.capacity_frames as u64),
                Ordering::Relaxed,
            );
            self.sealed = true;
            self.buffers.phase.store(SEALED, Ordering::Release);
        }
    }
}

impl Drop for RecordingWriter {
    fn drop(&mut self) {
        // コールバック破棄時も、加工前後が揃った最後のブロックまでを公開する。
        self.seal(self.completed_frames);
    }
}

pub fn allocate_voice_check_buffers(max_ms: u32, sample_rate_hz: u32) -> VoiceCheckBuffers {
    let max_ms = max_ms.clamp(500, VOICE_CHECK_MAX_MS);
    let sample_rate_hz = sample_rate_hz.clamp(8_000, 192_000);
    let capacity_frames = ((max_ms as u64 * sample_rate_hz as u64) / 1000).max(1) as usize;
    let sample_count = capacity_frames * VOICE_CHECK_CHANNELS;
    VoiceCheckBuffers {
        raw: UnsafeCell::new(vec![0.0; sample_count].into_boxed_slice()),
        processed: UnsafeCell::new(vec![0.0; sample_count].into_boxed_slice()),
        phase: AtomicU32::new(FRESH),
        completed_frames: AtomicU64::new(0),
        capacity_frames,
        sample_rate_hz,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_writer_is_issued_and_sealed_data_cannot_be_changed() {
        let buffers = Arc::new(allocate_voice_check_buffers(500, 8_000));
        assert!(buffers.recording().is_none());
        let mut writer = buffers.claim_writer().unwrap();
        assert!(buffers.claim_writer().is_none());
        writer.write_raw(0, 0.5, -0.5);
        assert!(buffers.recording().is_none());
        writer.write_processed(0, 0.25, -0.25);
        writer.seal(1);
        let recording = buffers.recording().unwrap();
        writer.write_raw(0, 99.0, 99.0);
        writer.write_processed(0, 99.0, 99.0);
        assert_eq!(recording.raw, [0.5, -0.5]);
        assert_eq!(recording.processed, [0.25, -0.25]);
        assert!(buffers.claim_writer().is_none());
    }

    #[test]
    fn completed_recording_is_published_across_threads_after_both_sides_are_written() {
        let buffers = Arc::new(allocate_voice_check_buffers(500, 8_000));
        let writer_buffers = buffers.clone();
        let (prepared_tx, prepared_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let mut writer = writer_buffers.claim_writer().unwrap();
            for frame in 0..4_000 {
                writer.write_raw(frame, frame as f32, -(frame as f32));
            }
            prepared_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
            for frame in 0..4_000 {
                writer.write_processed(frame, frame as f32 * 0.5, -(frame as f32) * 0.5);
            }
            writer.seal(4_000);
        });
        prepared_rx.recv().unwrap();
        assert!(buffers.recording().is_none());
        finish_tx.send(()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let recording = loop {
            if let Some(recording) = buffers.recording() {
                break recording;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::yield_now();
        };
        // joinより先に読む。公開自体のAcquireで全サンプルが見える必要がある。
        assert_eq!(recording.frames, 4_000);
        for frame in 0..4_000 {
            assert_eq!(recording.raw[frame * 2], frame as f32);
            assert_eq!(recording.processed[frame * 2 + 1], -(frame as f32) * 0.5);
        }
        handle.join().unwrap();
    }

    #[test]
    fn abandoned_writer_publishes_no_partial_samples() {
        let buffers = Arc::new(allocate_voice_check_buffers(500, 8_000));
        let mut writer = buffers.claim_writer().unwrap();
        writer.write_raw(0, 1.0, 1.0);
        drop(writer);
        assert_eq!(buffers.recording().unwrap().frames, 0);
    }
}
