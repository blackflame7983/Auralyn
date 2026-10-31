use anyhow::{anyhow, Result};
use rubato::{FftFixedIn, ResampleResult, Resampler};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

/// rubato公開APIの申告値。callback到着や実信号の通過時間の実測値ではない。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingDescriptor {
    pub input_rate_hz: usize,
    pub output_rate_hz: usize,
    pub input_chunk_frames: usize,
    pub max_output_chunk_frames: usize,
    pub declared_output_delay_frames: usize,
}

/// 同率だけは無変換とし、必須変換の準備失敗を開始側へ返す。
pub(super) fn prepare(
    input_rate: usize,
    output_rate: usize,
    channels: usize,
) -> Result<Option<StreamResampler>> {
    anyhow::ensure!(
        input_rate > 0 && output_rate > 0 && channels > 0,
        "レート変換のレート・チャンネル数が不正です"
    );
    if input_rate == output_rate {
        Ok(None)
    } else {
        StreamResampler::new(input_rate, output_rate, channels).map(Some)
    }
}

/// 私有の固定FFT比較を行った入出力4組だけ、入力batchを512へ縮める。
/// 同じratioの別レートや未検証の組合せへ一般化しない。
fn select_input_chunk_size(input_rate: usize, output_rate: usize) -> usize {
    match (input_rate, output_rate) {
        (44_100, 48_000) | (48_000, 44_100) | (48_000, 96_000) | (96_000, 48_000) => 512,
        _ => 1024,
    }
}

/// 固定rubato 0.14.1の処理単位。FIRの信号点対応ではない。
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CohortGeometry {
    pub input_unit_frames: u64,
    pub output_unit_frames: u64,
}
impl CohortGeometry {
    pub fn from_descriptor(d: &TimingDescriptor) -> Option<Self> {
        fn gcd(mut a: usize, mut b: usize) -> usize {
            while b != 0 {
                (a, b) = (b, a % b);
            }
            a
        }
        if d.input_rate_hz == 0 || d.output_rate_hz == 0 || d.input_chunk_frames == 0 {
            return None;
        }
        let divisor = gcd(d.input_rate_hz, d.output_rate_hz);
        // vendor constructorのf32 ceilをそのまま用いる。整数ceilへ置換しない。
        let chunks = ((d.input_chunk_frames / 2) as f32 / (d.input_rate_hz / divisor) as f32).ceil()
            as usize;
        let input = chunks.checked_mul(d.input_rate_hz / divisor)?;
        let output = chunks.checked_mul(d.output_rate_hz / divisor)?;
        if input == 0 || output == 0 {
            return None;
        }
        let max = (input.checked_sub(1)?.checked_add(d.input_chunk_frames)? / input)
            .checked_mul(output)?;
        if max != d.max_output_chunk_frames || output / 2 != d.declared_output_delay_frames {
            return None;
        }
        Some(Self {
            input_unit_frames: input as u64,
            output_unit_frames: output as u64,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CohortEmission {
    pub input_start: u64,
    pub input_count: u64,
    pub output_start: u64,
    pub output_count: u64,
}

/// A simpler stream-compatible resampler.
/// It maintains an internal buffer. You feed it data, and it returns any available resampled data.
pub struct StreamResampler {
    resampler: FftFixedIn<f32>,
    /// Buffers for accumulating input until we have a full chunk
    input_accumulation: Vec<Vec<f32>>,
    /// Number of frames currently in `input_accumulation`
    input_frames_collected: usize,

    input_chunk_size: usize,
    channels: usize,
    output_planar: Vec<Vec<f32>>,
    output_interleaved: Vec<f32>,
    timing: TimingDescriptor,
    cohort_geometry: Option<CohortGeometry>,
    cohort_submitted: u64,
    cohort_consumed: u64,
    cohort_generated: u64,
}

impl StreamResampler {
    pub fn new(input_rate: usize, output_rate: usize, channels: usize) -> Result<Self> {
        anyhow::ensure!(
            input_rate > 0 && output_rate > 0 && channels > 0,
            "レート変換のレート・チャンネル数が不正です"
        );
        // FftFixedInの内部単位・carry・出力上限はrate/gcdにも依存する。
        // 公開APIの実chunk数を用い、全rateで待ちや申告delayが半減するとは仮定しない。
        let target_chunk_size = select_input_chunk_size(input_rate, output_rate);

        let resampler = FftFixedIn::<f32>::new(
            input_rate,
            output_rate,
            target_chunk_size,
            2, // sub-chunks (internal implementation detail, 2 is standard)
            channels,
        )
        .map_err(|e| anyhow!("Failed to create resampler: {}", e))?;

        let input_chunk_size = resampler.input_frames_max();
        // 最大出力1チャンク分を非RT側で確保し、コールバックでは再利用する。
        let output_planar = resampler.output_buffer_allocate(true);
        let output_interleaved = vec![0.0; resampler.output_frames_max() * channels];
        let timing = TimingDescriptor {
            input_rate_hz: input_rate,
            output_rate_hz: output_rate,
            input_chunk_frames: input_chunk_size,
            max_output_chunk_frames: resampler.output_frames_max(),
            declared_output_delay_frames: resampler.output_delay(),
        };

        Ok(Self {
            resampler,
            input_accumulation: vec![vec![0.0; input_chunk_size]; channels],
            input_frames_collected: 0,

            input_chunk_size,
            channels,
            output_planar,
            output_interleaved,
            cohort_geometry: CohortGeometry::from_descriptor(&timing),
            cohort_submitted: 0,
            cohort_consumed: 0,
            cohort_generated: 0,
            timing,
        })
    }

    /// 切替の入力停止ACKより前に、旧入力のcarryとフィルター状態を固定領域で破棄する。
    pub(crate) fn discard_history(&mut self) {
        self.resampler.reset();
        self.input_frames_collected = 0;
        for channel in &mut self.input_accumulation {
            channel.fill(0.0);
        }
        for channel in &mut self.output_planar {
            channel.fill(0.0);
        }
        self.output_interleaved.fill(0.0);
        // frame対応を破棄した区間を旧ordinalの有効な観測としてつながない。
        self.cohort_geometry = None;
    }

    /// 開始準備中の制御側だけで利用する。DSP状態・carryを変更しない。
    pub fn timing_descriptor(&self) -> TimingDescriptor {
        self.timing.clone()
    }

    /// 非RT向けの互換API。RT側は割当のないprocess_intoを使用する。
    pub fn process(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        let mut output = Vec::new();
        self.process_into(input, |chunk| output.extend_from_slice(chunk))
            .map_err(|e| anyhow!("Resampling error: {}", e))?;
        Ok(output)
    }

    /// 出力を1チャンクずつ借用して渡す。入力長による再確保・出力VecのDropはない。
    /// emitも割当・待機しない処理を渡すこと。端数フレームの扱いは従来と同じ。
    pub fn process_into(
        &mut self,
        input: &[f32],
        mut emit: impl FnMut(&[f32]),
    ) -> ResampleResult<()> {
        self.process_into_observed(input, |samples, _| emit(samples))
    }

    /// 音声と独立した固定ordinalを添える。観測不整合はNoneで、DSPは継続する。
    pub fn process_into_observed(
        &mut self,
        input: &[f32],
        mut emit: impl FnMut(&[f32], Option<CohortEmission>),
    ) -> ResampleResult<()> {
        let frames_in = input.len() / self.channels;

        let mut input_cursor = 0;

        while input_cursor < frames_in {
            // How many frames can we append to accumulation?
            let space_left = self.input_chunk_size - self.input_frames_collected;
            let to_read = space_left.min(frames_in - input_cursor);

            // Copy de-interleaved
            for i in 0..to_read {
                for ch in 0..self.channels {
                    let sample = input[(input_cursor + i) * self.channels + ch];
                    self.input_accumulation[ch][self.input_frames_collected + i] = sample;
                }
            }

            self.input_frames_collected += to_read;
            input_cursor += to_read;

            // If full, process
            if self.input_frames_collected == self.input_chunk_size {
                let (frames_used, frames_out) = self.resampler.process_into_buffer(
                    &self.input_accumulation,
                    &mut self.output_planar,
                    None,
                )?;
                let cohort = self.next_cohort(frames_used, frames_out);
                if frames_out > 0 {
                    for i in 0..frames_out {
                        for (ch, channel) in self.output_planar.iter().enumerate() {
                            self.output_interleaved[i * self.channels + ch] = channel[i];
                        }
                    }
                    emit(
                        &self.output_interleaved[..frames_out * self.channels],
                        cohort,
                    );
                }

                // Reset accumulation
                self.input_frames_collected = 0;
            }
        }

        Ok(())
    }

    fn next_cohort(&mut self, used: usize, output: usize) -> Option<CohortEmission> {
        let geometry = self.cohort_geometry?;
        let result = (|| {
            if used != self.input_chunk_size {
                return None;
            }
            let submitted = self.cohort_submitted.checked_add(used as u64)?;
            let available = submitted.checked_sub(self.cohort_consumed)?;
            // vendor process_into_bufferのsaved_frames式もf32 floorである。
            let ready = (available as f32 / geometry.input_unit_frames as f32).floor() as u64;
            let input_count = ready.checked_mul(geometry.input_unit_frames)?;
            if input_count > available {
                return None;
            }
            if ready.checked_mul(geometry.output_unit_frames)? != output as u64 {
                return None;
            }
            let emission = CohortEmission {
                input_start: self.cohort_consumed,
                input_count,
                output_start: self.cohort_generated,
                output_count: output as u64,
            };
            self.cohort_submitted = submitted;
            self.cohort_consumed = self.cohort_consumed.checked_add(input_count)?;
            self.cohort_generated = self.cohort_generated.checked_add(output as u64)?;
            Some(emission)
        })();
        if result.is_none() {
            self.cohort_geometry = None;
        }
        result
    }

    pub(super) fn process_realtime_observed(
        &mut self,
        input: &[f32],
        emit: impl FnMut(&[f32], Option<CohortEmission>),
        stream_failed: &AtomicBool,
        notification: &AtomicBool,
    ) {
        if stream_failed.load(Ordering::Acquire) {
            return;
        }
        if self.process_into_observed(input, emit).is_err() {
            stream_failed.store(true, Ordering::Release);
            notification.store(true, Ordering::Release);
        }
    }

    /// 変換異常後は新しい入力を送らず、出力callbackの無音化と制御側の停止へ繋ぐ。
    pub fn process_realtime(
        &mut self,
        input: &[f32],
        emit: impl FnMut(&[f32]),
        stream_failed: &AtomicBool,
        notification: &AtomicBool,
    ) {
        if stream_failed.load(Ordering::Acquire) {
            return;
        }
        if self.process_into(input, emit).is_err() {
            stream_failed.store(true, Ordering::Release);
            notification.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StreamResampler;
    use crate::vst_host::instance::allocation_counts;
    use rubato::{FftFixedIn, Resampler};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn mode_silence_resampler_discards_old_carry_without_rt_allocation() {
        let mut stream = StreamResampler::new(44100, 48000, 2).unwrap();
        let data = vec![0.7; stream.input_chunk_size * 3];
        stream.process_into(&data, |_| {}).unwrap();
        assert!(stream.input_frames_collected > 0);
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| stream.discard_history()),
            (0, 0)
        );
        let zeros = vec![0.0; stream.input_chunk_size * 4];
        let mut nonzero = false;
        stream
            .process_into(&zeros, |chunk| {
                nonzero |= chunk.iter().any(|sample| *sample != 0.0);
            })
            .unwrap();
        assert!(!nonzero);
        assert!(stream.cohort_geometry.is_none());
    }
    #[test]
    fn cohort_geometry_and_ordinals_preserve_audio_across_zero_multi_emit_and_carry() {
        for (ir, or) in [
            (44100, 48000),
            (48000, 44100),
            (48000, 96000),
            (96000, 48000),
            (192000, 44100),
            (192000, 8000),
            (8000, 192000),
        ] {
            let mut observed = StreamResampler::new(ir, or, 2).unwrap();
            let mut compatible = StreamResampler::new(ir, or, 2).unwrap();
            let descriptor = observed.timing_descriptor();
            let geometry = super::CohortGeometry::from_descriptor(&descriptor).unwrap();
            assert_eq!(
                descriptor.declared_output_delay_frames as u64,
                geometry.output_unit_frames / 2
            );
            let mut bad = descriptor.clone();
            bad.declared_output_delay_frames += 1;
            assert!(super::CohortGeometry::from_descriptor(&bad).is_none());
            let mut input_end = 0;
            let mut output_end = 0;
            let mut total = 0;
            let mut multi = false;
            let mut zero = false;
            for frames in [1, 127, 128, 255, 512, 1024, 4097, 79, 1024] {
                let data: Vec<f32> = (0..frames * 2)
                    .map(|n| {
                        if n == 0 {
                            1.0
                        } else {
                            ((n as f32) * 0.013).sin() * 0.1
                        }
                    })
                    .collect();
                let expected = compatible.process(&data).unwrap();
                let mut actual = Vec::with_capacity(expected.len());
                let mut emissions = 0;
                assert_eq!(
                    allocation_counts(|| observed
                        .process_into_observed(&data, |samples, cohort| {
                            let c = cohort.unwrap();
                            assert_eq!(c.input_start, input_end);
                            assert_eq!(c.output_start, output_end);
                            assert_eq!(c.input_count % geometry.input_unit_frames, 0);
                            assert_eq!(
                                c.output_count / geometry.output_unit_frames,
                                c.input_count / geometry.input_unit_frames
                            );
                            input_end += c.input_count;
                            output_end += c.output_count;
                            emissions += 1;
                            actual.extend_from_slice(samples);
                        })
                        .unwrap()),
                    (0, 0)
                );
                assert_eq!(actual, expected);
                total += frames as u64;
                assert!(input_end <= total);
                zero |= emissions == 0;
                multi |= emissions > 1;
            }
            assert!(zero && multi);
            assert!(observed.cohort_submitted - input_end < geometry.input_unit_frames);
        }
    }

    #[test]
    fn batch_timing_descriptor_is_public_declaration_and_does_not_mutate_carry() {
        for (input_rate, output_rate, expected_chunk) in [
            (44_100, 48_000, 512),
            (48_000, 44_100, 512),
            (48_000, 96_000, 512),
            (96_000, 48_000, 512),
            (192_000, 44_100, 1024),
            (192_000, 8_000, 1024),
            (8_000, 192_000, 1024),
            (44_100, 96_000, 1024),
            (96_000, 44_100, 1024),
        ] {
            let mut stream = StreamResampler::new(input_rate, output_rate, 2).unwrap();
            assert_eq!(stream.input_chunk_size, expected_chunk);
            let reference =
                FftFixedIn::<f32>::new(input_rate, output_rate, expected_chunk, 2, 2).unwrap();
            let before = serde_json::to_value(stream.timing_descriptor()).unwrap();
            assert_eq!(before["inputRateHz"], input_rate);
            assert_eq!(before["outputRateHz"], output_rate);
            assert_eq!(before["inputChunkFrames"], reference.input_frames_max());
            assert_eq!(
                before["maxOutputChunkFrames"],
                reference.output_frames_max()
            );
            assert_eq!(
                before["declaredOutputDelayFrames"],
                reference.output_delay()
            );
            stream
                .process_into(&[0.0; 256], |_| panic!("128frameではemitしない"))
                .unwrap();
            let carry = stream.input_frames_collected;
            assert_eq!(carry, 128);
            assert_eq!(
                before,
                serde_json::to_value(stream.timing_descriptor()).unwrap()
            );
            assert_eq!(stream.input_frames_collected, carry);
        }
    }

    #[test]
    fn required_conversion_cannot_silently_fall_back_to_passthrough() {
        for rate in [44_100, 48_000, 96_000, 192_000] {
            assert!(super::prepare(rate, rate, 2).unwrap().is_none());
        }
        assert!(super::prepare(44_100, 48_000, 2).unwrap().is_some());
        for (input, output, channels) in [(0, 48_000, 2), (48_000, 0, 2), (44_100, 48_000, 0)] {
            assert!(super::prepare(input, output, channels).is_err());
        }
    }

    #[test]
    fn processing_failure_latches_silence_and_one_control_notification_without_allocating() {
        let mut resampler = StreamResampler::new(44_100, 48_000, 2).unwrap();
        let input = vec![0.25; resampler.input_chunk_size * 2];
        // 実際のrubatoエラー経路を、デバイスなしで注入する。
        resampler.output_planar[0].clear();
        let failed = AtomicBool::new(false);
        let notification = AtomicBool::new(false);
        let mut emitted = false;
        assert_eq!(
            allocation_counts(|| resampler.process_realtime(
                &input,
                |_| emitted = true,
                &failed,
                &notification
            )),
            (0, 0)
        );
        assert!(failed.load(Ordering::Acquire));
        assert!(notification.swap(false, Ordering::AcqRel));
        assert!(!emitted);
        assert_eq!(
            allocation_counts(|| resampler.process_realtime(
                &input,
                |_| emitted = true,
                &failed,
                &notification
            )),
            (0, 0)
        );
        assert!(!notification.load(Ordering::Acquire));
        assert!(!emitted);
    }

    #[test]
    fn realtime_chunks_match_selected_rubato_path_without_allocating() {
        for (input_rate, output_rate, expected_chunk) in [
            (48_000, 44_100, 512),
            (44_100, 48_000, 512),
            (48_000, 96_000, 512),
            (96_000, 48_000, 512),
            (192_000, 44_100, 1024),
            (192_000, 8_000, 1024),
            (8_000, 192_000, 1024),
        ] {
            let channel_counts: &[usize] = if expected_chunk == 512 {
                &[1, 2, 4, 22]
            } else {
                &[1, 2, 4]
            };
            for &channels in channel_counts {
                let mut actual_resampler =
                    StreamResampler::new(input_rate, output_rate, channels).unwrap();
                let mut reference =
                    FftFixedIn::<f32>::new(input_rate, output_rate, expected_chunk, 2, channels)
                        .unwrap();
                let chunk_size = reference.input_frames_max();
                let mut accumulated = vec![Vec::new(); channels];
                assert_eq!(actual_resampler.input_chunk_size, expected_chunk);
                for frames in [
                    0,
                    1,
                    47,
                    127,
                    chunk_size - 1,
                    chunk_size,
                    chunk_size + 1,
                    9413,
                ] {
                    // monoのframes=0も空入力とし、多chでは不完全な端数だけを追加する。
                    let input: Vec<f32> = (0..frames * channels + channels - 1)
                        .map(|i| ((i * 13 % 107) as f32 - 53.0) * 0.001)
                        .collect();
                    let mut expected = Vec::new();
                    // 旧APIのprocessを使い、同じ入力チャンクで参照出力を作る。
                    for frame in input.chunks_exact(channels) {
                        for (channel, &sample) in accumulated.iter_mut().zip(frame) {
                            channel.push(sample);
                        }
                        if accumulated[0].len() == chunk_size {
                            let output = reference.process(&accumulated, None).unwrap();
                            for i in 0..output[0].len() {
                                for channel in &output {
                                    expected.push(channel[i].to_bits());
                                }
                            }
                            for channel in &mut accumulated {
                                channel.clear();
                            }
                        }
                    }
                    let mut actual = Vec::with_capacity(expected.len());
                    let planar_ptrs: Vec<_> = actual_resampler
                        .output_planar
                        .iter()
                        .map(|channel| (channel.as_ptr(), channel.len(), channel.capacity()))
                        .collect();
                    let interleaved_buffer = (
                        actual_resampler.output_interleaved.as_ptr(),
                        actual_resampler.output_interleaved.len(),
                        actual_resampler.output_interleaved.capacity(),
                    );
                    assert_eq!(
                        allocation_counts(|| {
                            actual_resampler
                                .process_into(&input, |chunk| {
                                    actual.extend(chunk.iter().map(|s| s.to_bits()));
                                })
                                .unwrap();
                        }),
                        (0, 0)
                    );
                    assert_eq!(actual, expected);
                    assert!(actual.iter().all(|&bits| f32::from_bits(bits).is_finite()));
                    assert_eq!(
                        actual_resampler.input_frames_collected,
                        accumulated[0].len()
                    );
                    for (channel, original) in
                        actual_resampler.output_planar.iter().zip(planar_ptrs)
                    {
                        assert_eq!(
                            (channel.as_ptr(), channel.len(), channel.capacity()),
                            original
                        );
                    }
                    assert_eq!(
                        (
                            actual_resampler.output_interleaved.as_ptr(),
                            actual_resampler.output_interleaved.len(),
                            actual_resampler.output_interleaved.capacity(),
                        ),
                        interleaved_buffer
                    );
                }
            }
        }
    }

    #[test]
    fn multichannel_output_matches_independent_mono_and_chunk_boundaries() {
        for (input_rate, output_rate) in [(48_000, 44_100), (44_100, 48_000)] {
            for channels in [1, 2, 4] {
                let planar: Vec<Vec<f32>> = (0..channels)
                    .map(|ch| {
                        (0..4096)
                            .map(|i| ((i * (ch + 1) % 101) as f32 - 50.0) * 0.001)
                            .collect()
                    })
                    .collect();
                let input: Vec<f32> = (0..4096)
                    .flat_map(|i| planar.iter().map(move |channel| channel[i]))
                    .collect();
                let mono: Vec<Vec<f32>> = planar
                    .iter()
                    .map(|channel| {
                        StreamResampler::new(input_rate, output_rate, 1)
                            .unwrap()
                            .process(channel)
                            .unwrap()
                    })
                    .collect();
                let expected: Vec<u32> = (0..mono[0].len())
                    .flat_map(|i| mono.iter().map(move |channel| channel[i].to_bits()))
                    .collect();
                let all = StreamResampler::new(input_rate, output_rate, channels)
                    .unwrap()
                    .process(&input)
                    .unwrap();
                assert_eq!(
                    all.iter().map(|s| s.to_bits()).collect::<Vec<_>>(),
                    expected
                );
                let mut streamed = StreamResampler::new(input_rate, output_rate, channels).unwrap();
                let mut actual = Vec::new();
                for chunk in input.chunks(127 * channels) {
                    actual.extend(streamed.process(chunk).unwrap());
                }
                assert_eq!(
                    actual.iter().map(|s| s.to_bits()).collect::<Vec<_>>(),
                    expected
                );
            }
        }
    }
}
