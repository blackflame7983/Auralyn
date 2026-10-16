use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::devices::DeviceManager;
use super::test_tone::goertzel_detect;

/// WASAPI 共有モードで一時的に入力デバイスを開き、サンプルを収集する
pub fn capture_input_mono(
    device_name: &str,
    duration_ms: u32,
) -> Result<(Vec<f32>, u32)> {
    let host = cpal::default_host();
    let device = DeviceManager::resolve_input_device(&host, device_name)
        .ok_or_else(|| anyhow!("入力デバイス '{}' が見つかりません", device_name))?;

    let config = device
        .default_input_config()
        .map_err(|e| anyhow!("入力設定取得失敗: {}", e))?;
    let sample_rate = config.sample_rate();
    let channels = config.channels() as usize;

    let samples_needed =
        ((duration_ms as u64 * sample_rate as u64) / 1000).max(256) as usize;
    let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(samples_needed)));
    let buffer_cb = buffer.clone();
    let done = Arc::new(Mutex::new(false));
    let done_cb = done.clone();

    let stream_config: cpal::StreamConfig = config.clone().into();
    let err_fn = |e| log::warn!("ループバックキャプチャエラー: {}", e);

    let stream = device
        .build_input_stream(
            &stream_config,
            move |data: &[f32], _| {
                let mut buf = match buffer_cb.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                if buf.len() >= samples_needed {
                    return;
                }
                for frame in data.chunks(channels.max(1)) {
                    if buf.len() >= samples_needed {
                        break;
                    }
                    let mono = frame.first().copied().unwrap_or(0.0);
                    buf.push(mono);
                }
            },
            err_fn,
            None,
        )
        .map_err(|e| anyhow!("入力ストリームを開けませんでした: {}", e))?;

    stream
        .play()
        .map_err(|e| anyhow!("キャプチャ開始失敗: {}", e))?;

    let wait_ms = duration_ms.saturating_add(100);
    std::thread::sleep(Duration::from_millis(wait_ms as u64));

    stream.pause().ok();
    drop(stream);

    let captured = buffer
        .lock()
        .map_err(|_| anyhow!("キャプチャバッファロック失敗"))?
        .clone();
    *done_cb.lock().unwrap() = true;

    if captured.is_empty() {
        return Err(anyhow!("サンプルを取得できませんでした（デバイスが占有されている可能性があります）"));
    }

    Ok((captured, sample_rate))
}

/// キャプチャしたサンプルから目標周波数を検出
pub fn analyze_loopback(
    samples: &[f32],
    sample_rate_hz: u32,
    freq_hz: f32,
) -> (bool, f32) {
    goertzel_detect(samples, sample_rate_hz, freq_hz, -45.0)
}

#[cfg(test)]
mod tests {
    use super::super::test_tone::{dbfs_to_amplitude, goertzel_detect};

    #[test]
    fn analyze_uses_goertzel_threshold() {
        let sr = 48_000u32;
        let amp = dbfs_to_amplitude(-20.0);
        let n = 9600usize;
        let mut samples = vec![0.0f32; n];
        for (i, sample) in samples.iter_mut().enumerate() {
            *sample = (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / sr as f32).sin() * amp;
        }
        let (detected, _) = goertzel_detect(&samples, sr, 1000.0, -45.0);
        assert!(detected);
    }
}
