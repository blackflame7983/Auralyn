use anyhow::{anyhow, Result};
use rubato::{FftFixedIn, Resampler};

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

        Ok(Self {
            resampler,
            input_accumulation: vec![vec![0.0; input_chunk_size]; channels],
            input_frames_collected: 0,

            input_chunk_size,
            channels,
        })
    }

    /// Process input frames and return any available output frames.
    ///
    /// Note: This function allocates a new Vec for output every time or copies data.
    /// For a real-time thread, we should ideally use a ring buffer or pre-allocated buffers.
    /// However, Vector resizing is amortized, so it might be "okay" for MVP validation.
    /// To be safe, we will try to minimize allocation by reusing the output structure.
    pub fn process(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        // Input is interleaved [L, R, L, R...]
        // We need to de-interleave into `input_accumulation`

        // Safety: Assume input is consistent with self.channels
        let frames_in = input.len() / self.channels;
        let mut processed_output_interleaved = Vec::new();

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
                let waves_out = self
                    .resampler
                    .process(&self.input_accumulation, None)
                    .map_err(|e| anyhow!("Resampling error: {}", e))?;

                // Append to output?
                // Rubato returns `Vec<Vec<f32>>`.
                // We should interleave it immediately and push to result.

                let frames_out = waves_out[0].len();
                if frames_out > 0 {
                    // Reserve space
                    processed_output_interleaved.reserve(frames_out * self.channels);

                    for i in 0..frames_out {
                        for ch in 0..self.channels {
                            processed_output_interleaved.push(waves_out[ch][i]);
                        }
                    }
                }

                // Reset accumulation
                self.input_frames_collected = 0;
            }
        }

        Ok(processed_output_interleaved)
    }
}
