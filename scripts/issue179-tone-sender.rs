// Voicemeeter AUXへ共有WASAPIで短い試験音を送る。設定・既定デバイスは変更しない。
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
    let mut matches = Vec::new();
    for device in host.output_devices()? {
        if device.description()?.name() == "Voicemeeter AUX Input" {
            matches.push(device);
        }
    }
    if matches.len() != 1 {
        return Err("AUX endpoint is missing or ambiguous".into());
    }
    let device = matches.pop().ok_or("AUX endpoint missing")?;
    let default = device.default_output_config()?;
    if default.channels() != 2
        || default.sample_rate() != 48_000
        || default.sample_format() != cpal::SampleFormat::F32
    {
        return Err(format!("unexpected endpoint format: {:?}", default).into());
    }
    let config = default.config();
    let sample_rate = config.sample_rate as usize;
    let total_frames = sample_rate * 3 / 2; // 1.5秒、-40dBFSの997Hz
    let fade_frames = sample_rate / 20;
    let finished = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let frames_written = Arc::new(AtomicUsize::new(0));
    let (callback_finished, callback_failed, callback_frames) =
        (finished.clone(), failed.clone(), frames_written.clone());
    let mut frame_index = 0usize;
    let stream = device.build_output_stream(
        &config,
        move |data: &mut [f32], _| {
            for frame in data.chunks_mut(2) {
                let sample = if frame_index < total_frames {
                    let fade_in = (frame_index as f32 / fade_frames as f32).min(1.0);
                    let fade_out =
                        ((total_frames - frame_index) as f32 / fade_frames as f32).min(1.0);
                    let phase = 2.0 * std::f32::consts::PI * 997.0 * frame_index as f32
                        / sample_rate as f32;
                    frame_index += 1;
                    0.01 * fade_in * fade_out * phase.sin()
                } else {
                    callback_finished.store(true, Ordering::Release);
                    0.0
                };
                frame.fill(sample);
            }
            callback_frames.store(frame_index, Ordering::Relaxed);
        },
        move |_| {
            callback_failed.store(true, Ordering::Release);
        },
        None,
    )?;
    stream.play()?;
    let deadline = Instant::now() + Duration::from_secs(6);
    while !finished.load(Ordering::Acquire)
        && !failed.load(Ordering::Acquire)
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stream);
    if failed.load(Ordering::Acquire) {
        return Err("output stream failed".into());
    }
    if !finished.load(Ordering::Acquire) {
        return Err("output stream did not finish in time".into());
    }
    println!(
        "endpoint=Voicemeeter AUX Input frequency_hz=997 level_dbfs=-40 frames={} rate=48000",
        frames_written.load(Ordering::Relaxed)
    );
    Ok(())
}
