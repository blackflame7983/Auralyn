//! ASIO native 形式と DSP の f32 を、事前確保した領域で変換する。
use cpal::traits::DeviceTrait;
use cpal::{
    BuildStreamError, Device, InputCallbackInfo, OutputCallbackInfo, SampleFormat, Stream,
    StreamConfig, StreamError, I24,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(super) fn supported_format(format: SampleFormat) -> bool {
    matches!(
        format,
        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I24 | SampleFormat::I32
    )
}

trait Native: cpal::SizedSample + Copy {
    fn to_float(self) -> f32;
    fn from_float(value: f32) -> Self;
}

fn normalized(value: f32) -> f64 {
    if value.is_finite() {
        (value as f64).clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

impl Native for i16 {
    fn to_float(self) -> f32 {
        self as f32 / 32768.0
    }
    fn from_float(value: f32) -> Self {
        (normalized(value) * 32768.0).clamp(-32768.0, 32767.0) as i16
    }
}
impl Native for I24 {
    fn to_float(self) -> f32 {
        self.inner() as f32 / 8388608.0
    }
    fn from_float(value: f32) -> Self {
        I24::new_unchecked((normalized(value) * 8388608.0).clamp(-8388608.0, 8388607.0) as i32)
    }
}
impl Native for i32 {
    fn to_float(self) -> f32 {
        (self as f64 / 2147483648.0) as f32
    }
    fn from_float(value: f32) -> Self {
        (normalized(value) * 2147483648.0).clamp(-2147483648.0, 2147483647.0) as i32
    }
}

fn capacity(config: &StreamConfig, max_frames: usize) -> Result<usize, BuildStreamError> {
    max_frames
        .checked_mul(config.channels as usize)
        .filter(|&n| n > 0)
        .ok_or(BuildStreamError::StreamConfigNotSupported)
}

fn input_samples<T: Native>(
    data: &[T],
    scratch: &mut [f32],
    failed: &AtomicBool,
    mut callback: impl FnMut(&[f32]),
) {
    if data.len() > scratch.len() {
        failed.store(true, Ordering::Release);
        return;
    }
    let target = &mut scratch[..data.len()];
    for (dst, src) in target.iter_mut().zip(data) {
        *dst = src.to_float();
    }
    callback(target);
}

fn output_samples<T: Native>(
    data: &mut [T],
    scratch: &mut [f32],
    failed: &AtomicBool,
    mut callback: impl FnMut(&mut [f32]),
) {
    if data.len() > scratch.len() {
        data.fill(T::from_float(0.0));
        failed.store(true, Ordering::Release);
        return;
    }
    let target = &mut scratch[..data.len()];
    target.fill(0.0);
    callback(target);
    for (dst, src) in data.iter_mut().zip(target.iter()) {
        *dst = T::from_float(*src);
    }
}

fn build_input_native<T: Native>(
    device: &Device,
    config: &StreamConfig,
    max_frames: usize,
    failed: Arc<AtomicBool>,
    mut callback: impl FnMut(&[f32], &InputCallbackInfo) + Send + 'static,
    error: impl FnMut(StreamError) + Send + 'static,
) -> Result<Stream, BuildStreamError> {
    let mut scratch = vec![0.0; capacity(config, max_frames)?];
    device.build_input_stream(
        config,
        move |data: &[T], info| {
            input_samples(data, &mut scratch, &failed, |data| callback(data, info))
        },
        error,
        None,
    )
}
fn build_output_native<T: Native>(
    device: &Device,
    config: &StreamConfig,
    max_frames: usize,
    failed: Arc<AtomicBool>,
    mut callback: impl FnMut(&mut [f32], &OutputCallbackInfo) + Send + 'static,
    error: impl FnMut(StreamError) + Send + 'static,
) -> Result<Stream, BuildStreamError> {
    let mut scratch = vec![0.0; capacity(config, max_frames)?];
    device.build_output_stream(
        config,
        move |data: &mut [T], info| {
            output_samples(data, &mut scratch, &failed, |data| callback(data, info))
        },
        error,
        None,
    )
}

pub(super) fn build_input(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    max_frames: usize,
    failed: Arc<AtomicBool>,
    callback: impl FnMut(&[f32], &InputCallbackInfo) + Send + 'static,
    error: impl FnMut(StreamError) + Send + 'static,
) -> Result<Stream, BuildStreamError> {
    match format {
        SampleFormat::F32 => device.build_input_stream(config, callback, error, None),
        SampleFormat::I16 => {
            build_input_native::<i16>(device, config, max_frames, failed, callback, error)
        }
        SampleFormat::I24 => {
            build_input_native::<I24>(device, config, max_frames, failed, callback, error)
        }
        SampleFormat::I32 => {
            build_input_native::<i32>(device, config, max_frames, failed, callback, error)
        }
        _ => Err(BuildStreamError::StreamConfigNotSupported),
    }
}
pub(super) fn build_output(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    max_frames: usize,
    failed: Arc<AtomicBool>,
    callback: impl FnMut(&mut [f32], &OutputCallbackInfo) + Send + 'static,
    error: impl FnMut(StreamError) + Send + 'static,
) -> Result<Stream, BuildStreamError> {
    match format {
        SampleFormat::F32 => device.build_output_stream(config, callback, error, None),
        SampleFormat::I16 => {
            build_output_native::<i16>(device, config, max_frames, failed, callback, error)
        }
        SampleFormat::I24 => {
            build_output_native::<I24>(device, config, max_frames, failed, callback, error)
        }
        SampleFormat::I32 => {
            build_output_native::<i32>(device, config, max_frames, failed, callback, error)
        }
        _ => Err(BuildStreamError::StreamConfigNotSupported),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp_verification_allocator::allocation_counts;

    #[test]
    fn integer_endpoints_and_nonfinite_are_safe() {
        assert_eq!(i16::MIN.to_float(), -1.0);
        assert_eq!(I24::new_unchecked(-8388608).to_float(), -1.0);
        assert_eq!(
            I24::new_unchecked(8388607).to_float(),
            8388607.0 / 8388608.0
        );
        assert_eq!(i32::MIN.to_float(), -1.0);
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(i16::from_float(value), 0);
            assert_eq!(I24::from_float(value).inner(), 0);
            assert_eq!(i32::from_float(value), 0);
        }
        assert_eq!(i16::from_float(2.0), i16::MAX);
        assert_eq!(I24::from_float(1.0).inner(), 8388607);
        assert_eq!(I24::from_float(-2.0).inner(), -8388608);
        assert_eq!(i32::from_float(1.0), i32::MAX);
        assert_eq!(i32::from_float(-1.0), i32::MIN);
        assert!(!supported_format(SampleFormat::F64));
    }

    #[test]
    fn capacity_uses_each_streams_channel_count() {
        let mut config = StreamConfig {
            channels: 1,
            sample_rate: 48_000,
            buffer_size: cpal::BufferSize::Default,
        };
        assert_eq!(capacity(&config, 4).unwrap(), 4);
        config.channels = 6;
        assert_eq!(capacity(&config, 4).unwrap(), 24);
        assert!(capacity(&config, usize::MAX).is_err());
        config.channels = 0;
        assert!(capacity(&config, 4).is_err());
    }

    #[test]
    fn callback_sizes_overflow_and_realtime_allocations() {
        let failed = AtomicBool::new(false);
        let mut scratch = [0.0; 6];
        let input = [i16::MIN, 0, i16::MAX];
        let mut output = [1_i16; 6];
        let counts = allocation_counts(|| {
            input_samples(&input, &mut scratch, &failed, |data| {
                assert_eq!(data.len(), 3)
            });
            output_samples(&mut output, &mut scratch, &failed, |data| data.fill(0.5));
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(output, [16384; 6]);
        let mut oversized = [1_i16; 7];
        let counts = allocation_counts(|| {
            input_samples(&oversized, &mut scratch, &failed, |_| {
                panic!("overflow input callback")
            });
            output_samples(&mut oversized, &mut scratch, &failed, |_| {
                panic!("overflow output callback")
            });
        });
        assert_eq!(counts, (0, 0));
        assert_eq!(oversized, [0; 7]);
        assert!(failed.load(Ordering::Acquire));
    }
}
