use anyhow::{anyhow, Result};
use rubato::{FftFixedIn, ResampleResult, Resampler};

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
}

impl StreamResampler {
    pub fn new(input_rate: usize, output_rate: usize, channels: usize) -> Result<Self> {
        // Calculate minimal chunk size required by rubato
        // FftFixedIn requires input size to be a power of 2 (usually).
        // Let's pick a reasonable chunk size. 1024 is standard.
        // The resampler will tell us exactly what it needs.
        let target_chunk_size = 1024;

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

        Ok(Self {
            resampler,
            input_accumulation: vec![vec![0.0; input_chunk_size]; channels],
            input_frames_collected: 0,

            input_chunk_size,
            channels,
            output_planar,
            output_interleaved,
        })
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
                let (_, frames_out) = self.resampler.process_into_buffer(
                    &self.input_accumulation,
                    &mut self.output_planar,
                    None,
                )?;
                if frames_out > 0 {
                    for i in 0..frames_out {
                        for (ch, channel) in self.output_planar.iter().enumerate() {
                            self.output_interleaved[i * self.channels + ch] = channel[i];
                        }
                    }
                    emit(&self.output_interleaved[..frames_out * self.channels]);
                }

                // Reset accumulation
                self.input_frames_collected = 0;
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::StreamResampler;
    use crate::vst_host::instance::allocation_counts;
    use rubato::{FftFixedIn, Resampler};

    #[test]
    fn realtime_chunks_match_original_rubato_path_without_allocating() {
        for (input_rate, output_rate) in [
            (48_000, 44_100),
            (44_100, 48_000),
            (48_000, 96_000),
            (192_000, 8_000),
            (8_000, 192_000),
        ] {
            for channels in [1, 2, 4] {
                let mut actual_resampler =
                    StreamResampler::new(input_rate, output_rate, channels).unwrap();
                let mut reference =
                    FftFixedIn::<f32>::new(input_rate, output_rate, 1024, 2, channels).unwrap();
                let chunk_size = reference.input_frames_max();
                let mut accumulated = vec![Vec::new(); channels];
                for frames in [0, 1, 47, 127, 1024, 9413, 1024] {
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
