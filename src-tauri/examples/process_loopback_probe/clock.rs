//! 独立クロックの検証用SRC。通常の速度差追従と、欠落・満杯の失敗を分ける。
use anyhow::{ensure, Result};
use ringbuf::traits::Consumer;
use rubato::{
    Resampler, SincFixedOut, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

const BLOCK: usize = 256;
pub const TARGET: usize = 2048;
pub const CAPACITY: usize = 16_384;
const LIMIT: f64 = 0.002;

fn correction(queued: usize) -> f64 {
    let error = (queued as f64 - TARGET as f64) / TARGET as f64;
    -(error * 0.004).clamp(-LIMIT, LIMIT)
}

pub struct Renderer {
    resampler: SincFixedOut<f32>,
    input: Vec<Vec<f32>>,
    output: Vec<Vec<f32>>,
    cursor: usize,
    primed: bool,
    pub failed: bool,
    pub underruns: u64,
    pub rendered: u64,
    pub waiting: u64,
    pub max_queued: usize,
    pub correction_ppm: f64,
}

impl Renderer {
    pub fn new(output_rate: u32) -> Result<Self> {
        ensure!(
            (8000..=192000).contains(&output_rate),
            "返しのrateが範囲外です"
        );
        let resampler = SincFixedOut::<f32>::new(
            f64::from(output_rate) / 48000.0,
            1.01,
            SincInterpolationParameters {
                sinc_len: 128,
                f_cutoff: 0.94,
                interpolation: SincInterpolationType::Cubic,
                oversampling_factor: 128,
                window: WindowFunction::BlackmanHarris2,
            },
            BLOCK,
            2,
        )?;
        // 固定版rubatoのinput_frames_maxは低い出力rateで過小になるため、
        // 比率の逆数とFIR履歴を含む保守的な容量を開始時に確保する。
        let max_input = ((BLOCK as f64 * 48000.0 / f64::from(output_rate) / (1.0 - LIMIT)).ceil()
            as usize
            + 260)
            .max(resampler.input_frames_max());
        let input = vec![vec![0.0; max_input]; 2];
        let output = resampler.output_buffer_allocate(true);
        Ok(Self {
            resampler,
            input,
            output,
            cursor: BLOCK,
            primed: false,
            failed: false,
            underruns: 0,
            rendered: 0,
            waiting: 0,
            max_queued: 0,
            correction_ppm: 0.0,
        })
    }

    pub fn render(&mut self, samples: &mut [f32], rx: &mut impl Consumer<Item = [f32; 2]>) {
        samples.fill(0.0);
        if self.failed {
            return;
        }
        self.max_queued = self.max_queued.max(rx.occupied_len());
        if rx.occupied_len() >= CAPACITY - BLOCK {
            self.failed = true;
            return;
        }
        for frame in samples.as_chunks_mut::<2>().0 {
            if self.cursor == BLOCK {
                if !self.primed {
                    if rx.occupied_len() < TARGET {
                        self.waiting += 1;
                        continue;
                    }
                    self.primed = true;
                }
                let ratio = 1.0 + correction(rx.occupied_len());
                self.correction_ppm = (ratio - 1.0) * 1_000_000.0;
                if self
                    .resampler
                    .set_resample_ratio_relative(ratio, true)
                    .is_err()
                {
                    self.failed = true;
                    return;
                }
                let needed = self.resampler.input_frames_next();
                if needed > self.input[0].len() || rx.occupied_len() < needed {
                    // 無期限の旧音再生や、破棄を繰り返して速度差を隠す回復はしない。
                    self.underruns += 1;
                    self.failed = true;
                    return;
                }
                for index in 0..needed {
                    let Some(input) = rx.try_pop() else {
                        self.failed = true;
                        return;
                    };
                    self.input[0][index] = input[0];
                    self.input[1][index] = input[1];
                }
                if self
                    .resampler
                    .process_into_buffer(&self.input, &mut self.output, None)
                    .is_err()
                {
                    self.failed = true;
                    return;
                }
                self.cursor = 0;
            }
            frame[0] = self.output[0][self.cursor];
            frame[1] = self.output[1][self.cursor];
            if !frame[0].is_finite() || !frame[1].is_finite() {
                frame.fill(0.0);
                self.failed = true;
                return;
            }
            self.cursor += 1;
            self.rendered += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ringbuf::{
        traits::{Observer, Producer, Split},
        HeapRb,
    };

    #[test]
    fn signed_clock_offsets_stay_bounded_and_limits_are_explicit() {
        for ppm in [-1500.0, -500.0, 0.0, 500.0, 1500.0] {
            let mut queued = TARGET as f64;
            for _ in 0..360_000 {
                queued +=
                    480.0 * (1.0 + ppm / 1_000_000.0) - 480.0 / (1.0 + correction(queued as usize));
                assert!(
                    (1024.0..4096.0).contains(&queued),
                    "ppm={ppm}, queued={queued}"
                );
            }
        }
        assert_eq!(correction(0), LIMIT);
        assert_eq!(correction(CAPACITY), -LIMIT);
    }

    #[test]
    fn actual_src_consumption_tracks_both_clock_directions_without_frame_drops() {
        for rate in [44100, 48000, 96000] {
            for ppm in [-1500.0, 1500.0] {
                let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
                let mut renderer = Renderer::new(rate).unwrap();
                let mut output = [0.0; BLOCK * 2];
                for _ in 0..TARGET {
                    tx.try_push([0.1, -0.1]).unwrap();
                }
                let mut fraction = 0.0;
                for _ in 0..6000 {
                    fraction +=
                        BLOCK as f64 * 48000.0 / f64::from(rate) * (1.0 + ppm / 1_000_000.0);
                    let incoming = fraction as usize;
                    fraction -= incoming as f64;
                    for _ in 0..incoming {
                        tx.try_push([0.1, -0.1]).unwrap();
                    }
                    renderer.render(&mut output, &mut rx);
                    assert!(!renderer.failed, "rate={rate}, ppm={ppm}");
                    assert!(rx.occupied_len() < 4096);
                    assert!(output.iter().all(|s| s.is_finite() && s.abs() < 0.12));
                }
                assert_eq!(renderer.underruns, 0);
            }
        }
    }

    #[test]
    fn variable_ratio_src_and_failure_are_allocation_free_and_keep_stereo_order() {
        for rate in [44100, 48000, 96000] {
            let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(CAPACITY).split();
            let mut renderer = Renderer::new(rate).unwrap();
            let mut output = [0.0; 512];
            for _ in 0..TARGET + 512 {
                tx.try_push([0.25, -0.25]).unwrap();
            }
            let counts = crate::allocation_tests::measure(|| renderer.render(&mut output, &mut rx));
            assert_eq!(counts, (0, 0));
            assert!(!renderer.failed);
            assert!(output
                .as_chunks::<2>()
                .0
                .iter()
                .all(|f| (f[0] + f[1]).abs() < 1e-5));
            assert!(output.iter().any(|x| x.abs() > 0.2));
            while rx.try_pop().is_some() {}
            let counts = crate::allocation_tests::measure(|| renderer.render(&mut output, &mut rx));
            assert_eq!(counts, (0, 0));
            assert!(renderer.failed);
            renderer.render(&mut output, &mut rx);
            assert_eq!(output, [0.0; 512]);
        }
    }
}
