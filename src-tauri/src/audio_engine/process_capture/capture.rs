use super::{
    activation,
    support::{wait, Event, Process},
};
use anyhow::Result;
use serde::Serialize;
use std::time::{Duration, Instant};
use windows::Win32::Media::Audio::{
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};

pub const RATE: u32 = 48_000;
pub const MAX_PACKET_FRAMES: u32 = RATE;

#[derive(Default, Serialize)]
pub struct Stats {
    pub frames: u64,
    pub nonzero_frames: u64,
    pub silent_frames: u64,
    pub nonfinite_samples: u64,
    pub discontinuities: u64,
    pub timestamp_errors: u64,
    pub max_packet_frames: u32,
    pub peak: f32,
    pub elapsed_ms: u64,
    pub ended: &'static str,
}

pub struct Capture {
    capture: IAudioCaptureClient,
    client: IAudioClient,
    ready: Event,
    process: Process,
}
impl Capture {
    pub fn open(process: Process, cancel: &Event) -> Result<Self> {
        let client = activation::activate(&process, Duration::from_secs(5), cancel)?;
        let format = WAVEFORMATEX {
            wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT。問い合わせAPIに依存せず明示する。
            nChannels: 2,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * 8,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        let ready = Event::new(false)?;
        // SAFETY: 同じMTAスレッドで取得したclientへ、有効な固定フォーマットと所有イベントを渡し、Captureが双方を保持する。
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                200_000,
                0,
                &format,
                None,
            )?;
            client.SetEventHandle(ready.raw())?;
        }
        // SAFETY: Initializeに成功したclientから対応するcaptureインターフェイスを取得し、所有参照として保持する。
        let capture = unsafe { client.GetService()? };
        Ok(Self {
            capture,
            client,
            ready,
            process,
        })
    }

    pub fn run_until_stopped(
        &self,
        cancel: &Event,
        consume: impl FnMut([f32; 2]),
        observe: impl FnMut(&Stats),
    ) -> Result<Stats> {
        self.run_internal(None, cancel, consume, observe)
    }

    fn run_internal(
        &self,
        duration: Option<Duration>,
        cancel: &Event,
        mut consume: impl FnMut([f32; 2]),
        mut observe: impl FnMut(&Stats),
    ) -> Result<Stats> {
        self.process.verify(self.process.created)?;
        // SAFETY: 初期化済みclientを所有するこの取得スレッドで開始し、終了時にStopする。
        unsafe { self.client.Start()? };
        let started = Instant::now();
        let mut stats = Stats::default();
        let result = (|| -> Result<()> {
            while duration.is_none_or(|duration| started.elapsed() < duration) {
                let remaining = duration
                    .unwrap_or(Duration::MAX)
                    .saturating_sub(started.elapsed())
                    .min(Duration::from_millis(100));
                match wait(
                    &[cancel.raw(), self.process.handle.0, self.ready.raw()],
                    remaining,
                )? {
                    Some(0) => {
                        stats.ended = "cancelled";
                        break;
                    }
                    Some(1) => {
                        stats.ended = "process_exited";
                        break;
                    }
                    _ => {}
                }
                for _ in 0..64 {
                    if wait(&[cancel.raw()], Duration::ZERO)?.is_some() {
                        stats.ended = "cancelled";
                        break;
                    }
                    // SAFETY: 開始済みclientのcaptureを同じ取得スレッドで使用し、前のpacketは解放済みである。
                    if unsafe { self.capture.GetNextPacketSize()? } == 0 {
                        break;
                    }
                    let mut data = std::ptr::null_mut();
                    let mut frames = 0;
                    let mut flags = 0;
                    // SAFETY: 取得スレッドだけがcaptureを使い、各出力変数は有効な書込み先として呼出し中保持する。
                    unsafe {
                        self.capture
                            .GetBuffer(&mut data, &mut frames, &mut flags, None, None)?
                    };
                    // 成功したGetBufferには、検証・処理の失敗時も必ずReleaseを対応させる。
                    let bytes = if data.is_null()
                        || frames > MAX_PACKET_FRAMES
                        || flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0
                    {
                        None
                    } else {
                        // WASAPIは宣言した8 byte/frameの領域をReleaseまで貸し出す。
                        // SAFETY: GetBufferが返した非null領域は宣言済み8 byte/frame形式で、対応するReleaseBufferまで借用する。
                        Some(unsafe { std::slice::from_raw_parts(data, frames as usize * 8) })
                    };
                    let packet = process_packet(bytes, frames, flags, &mut stats, &mut consume);
                    // SAFETY: 成功したGetBufferごとに一度だけ同じframesで解放し、その後packet領域を参照しない。
                    let release = unsafe { self.capture.ReleaseBuffer(frames) };
                    packet?;
                    release?;
                    observe(&stats);
                    if duration.is_some_and(|duration| started.elapsed() >= duration) {
                        break;
                    }
                }
            }
            Ok(())
        })();
        // SAFETY: このスレッドが開始した所有clientをループ終了後に停止し、COM参照は呼出し中生存する。
        let stop = unsafe { self.client.Stop() };
        stats.elapsed_ms = started.elapsed().as_millis() as u64;
        if stats.ended.is_empty() {
            stats.ended = "duration";
        }
        result?;
        stop?;
        Ok(stats)
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        // SAFETY: Captureが所有するclientを破棄前に停止する。先に停止済みの場合のエラーは無視し、参照はDrop完了まで有効である。
        let _ = unsafe { self.client.Stop() };
    }
}

#[derive(Debug, PartialEq)]
enum PacketError {
    TooLarge,
    MissingBuffer,
}
impl std::fmt::Display for PacketError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::TooLarge => "取得パケットが上限を超えました",
            Self::MissingBuffer => "取得bufferがありません",
        })
    }
}
impl std::error::Error for PacketError {}

fn process_packet(
    data: Option<&[u8]>,
    frames: u32,
    flags: u32,
    stats: &mut Stats,
    consume: &mut impl FnMut([f32; 2]),
) -> std::result::Result<(), PacketError> {
    if frames > MAX_PACKET_FRAMES {
        return Err(PacketError::TooLarge);
    }
    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
    if !silent && frames != 0 && data.is_none_or(|data| data.len() < frames as usize * 8) {
        return Err(PacketError::MissingBuffer);
    }
    stats.discontinuities +=
        u64::from(flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0);
    stats.timestamp_errors += u64::from(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0);
    stats.max_packet_frames = stats.max_packet_frames.max(frames);
    let data = data.unwrap_or(&[]);
    for index in 0..frames as usize {
        let mut frame = [0.0; 2];
        if !silent {
            // WASAPIが返したf32 stereo bufferを、Releaseより前に有界でコピーする。
            for (channel, sample) in frame.iter_mut().enumerate() {
                let offset = (index * 2 + channel) * 4;
                let value = f32::from_le_bytes([
                    data[offset],
                    data[offset + 1],
                    data[offset + 2],
                    data[offset + 3],
                ]);
                if value.is_finite() {
                    *sample = value;
                } else {
                    stats.nonfinite_samples += 1;
                }
            }
        }
        stats.peak = stats.peak.max(frame[0].abs()).max(frame[1].abs());
        stats.frames += 1;
        stats.silent_frames += u64::from(silent);
        stats.nonzero_frames += u64::from(frame[0] != 0.0 || frame[1] != 0.0);
        consume(frame);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample_bytes(samples: &[f32]) -> &[u8] {
        // 有効なf32の借用を、同じ寿命のbyte表現として読むだけ。
        // SAFETY: f32配列にpaddingはなく、元の連続領域の有効なバイト数だけを同じ借用寿命で読む。
        unsafe {
            std::slice::from_raw_parts(samples.as_ptr().cast(), std::mem::size_of_val(samples))
        }
    }
    #[test]
    fn pcm_processing_including_failure_has_no_rust_allocation_or_deallocation() {
        let data = [0.5f32, -0.5, f32::NAN, f32::INFINITY];
        let mut stats = Stats::default();
        let counts = crate::vst_host::instance::allocation_counts(|| {
            process_packet(Some(sample_bytes(&data)), 2, 0, &mut stats, &mut |_| {}).unwrap();
            process_packet(
                None,
                16,
                AUDCLNT_BUFFERFLAGS_SILENT.0 as u32,
                &mut stats,
                &mut |_| {},
            )
            .unwrap();
            assert_eq!(
                process_packet(None, 1, 0, &mut stats, &mut |_| {}),
                Err(PacketError::MissingBuffer)
            );
            assert_eq!(
                process_packet(None, MAX_PACKET_FRAMES + 1, 0, &mut stats, &mut |_| {}),
                Err(PacketError::TooLarge)
            );
        });
        assert_eq!(counts, (0, 0));
    }
    #[test]
    fn silent_null_buffer_advances_frames_and_invalid_packet_is_rejected() {
        let mut stats = Stats::default();
        let mut count = 0;
        process_packet(
            None,
            32,
            AUDCLNT_BUFFERFLAGS_SILENT.0 as u32,
            &mut stats,
            &mut |frame| {
                assert_eq!(frame, [0.0; 2]);
                count += 1;
            },
        )
        .unwrap();
        assert_eq!((stats.frames, stats.silent_frames, count), (32, 32, 32));
        assert!(process_packet(None, 1, 0, &mut stats, &mut |_| {}).is_err());
        assert!(process_packet(None, MAX_PACKET_FRAMES + 1, 0, &mut stats, &mut |_| {}).is_err());
    }
    #[test]
    fn stereo_order_and_nonfinite_samples_do_not_poison_statistics() {
        let source = [1.0f32, -1.0, f32::NAN, 0.5];
        let mut stats = Stats::default();
        let mut result = Vec::new();
        process_packet(
            Some(sample_bytes(&source)),
            2,
            0,
            &mut stats,
            &mut |frame| result.push(frame),
        )
        .unwrap();
        assert_eq!(result, [[1.0, -1.0], [0.0, 0.5]]);
        assert_eq!(stats.nonfinite_samples, 1);
        assert_eq!(stats.peak, 1.0);
    }

    #[test]
    fn discontinuity_and_timestamp_error_flags_are_counted_without_moving_samples() {
        let source = [0.0f32, 0.0, 0.25, -0.25, 0.0, 0.0];
        let both = AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32
            | AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32;
        let mut stats = Stats::default();
        let mut frames = [[0.0f32; 2]; 8];
        let mut count = 0usize;
        let counts = crate::dsp_verification_allocator::allocation_counts(|| {
            process_packet(
                Some(sample_bytes(&source)),
                3,
                both,
                &mut stats,
                &mut |frame| {
                    frames[count] = frame;
                    count += 1;
                },
            )
            .unwrap();
            process_packet(
                Some(sample_bytes(&source[..2])),
                1,
                0,
                &mut stats,
                &mut |frame| {
                    frames[count] = frame;
                    count += 1;
                },
            )
            .unwrap();
            process_packet(
                None,
                2,
                AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 | both,
                &mut stats,
                &mut |frame| {
                    frames[count] = frame;
                    count += 1;
                },
            )
            .unwrap();
            assert_eq!(
                process_packet(None, MAX_PACKET_FRAMES + 1, both, &mut stats, &mut |_| {}),
                Err(PacketError::TooLarge)
            );
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(stats.discontinuities, 2);
        assert_eq!(stats.timestamp_errors, 2);
        assert_eq!(stats.frames, 6);
        assert_eq!(
            frames[..count],
            [
                [0.0, 0.0],
                [0.25, -0.25],
                [0.0, 0.0],
                [0.0, 0.0],
                [0.0, 0.0],
                [0.0, 0.0],
            ]
        );
    }
}
