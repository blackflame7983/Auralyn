// 専用の一時試験: CABLEへ−40dBFSの信号を送り、AUXのループバックから997Hz成分だけ集計。
// 実音声サンプルは保持・出力しない。親が一時設定の経路と音量を確認した後だけ実行する。
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::io::Write;
use std::sync::{
    atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

const RATE: usize = 48_000;
const WINDOW: usize = RATE / 50;
const DURATION: usize = RATE * 15;
const MAX_WINDOWS: usize = 1_000;
struct Measurement {
    ms: AtomicU64,
    rms: AtomicU32,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
    let mut cable = Vec::new();
    let mut aux = Vec::new();
    for device in host.output_devices()? {
        match device.description()?.name() {
            "CABLE Input" => cable.push(device),
            "Voicemeeter AUX Input" => aux.push(device),
            _ => {}
        }
    }
    if cable.len() != 1 || aux.len() != 1 {
        return Err("required endpoints missing or ambiguous".into());
    }
    let cable = cable.pop().ok_or("CABLE Input missing")?;
    let aux = aux.pop().ok_or("AUX Input missing")?;
    let input_config = cable.default_output_config()?;
    let output_config = aux.default_output_config()?;
    for config in [&input_config, &output_config] {
        if config.channels() != 2
            || config.sample_rate() != RATE as u32
            || config.sample_format() != cpal::SampleFormat::F32
        {
            return Err(format!("unexpected endpoint format: {:?}", config).into());
        }
    }
    let observations = Arc::new(
        (0..MAX_WINDOWS)
            .map(|_| Measurement {
                ms: AtomicU64::new(0),
                rms: AtomicU32::new(0),
            })
            .collect::<Vec<_>>(),
    );
    let count = Arc::new(AtomicUsize::new(0));
    let failed = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let origin = Instant::now();
    let (captured, captured_count, capture_failed) =
        (observations.clone(), count.clone(), failed.clone());
    let (mut n, mut cos_sum, mut sin_sum) = (0usize, 0.0f64, 0.0f64);
    let capture = aux.build_input_stream(
        &output_config.config(),
        move |data: &[f32], _| {
            for frame in data.chunks_exact(2) {
                let x = (frame[0] as f64 + frame[1] as f64) / 2.0;
                let phase = std::f64::consts::TAU * 997.0 * n as f64 / RATE as f64;
                cos_sum += x * phase.cos();
                sin_sum += x * phase.sin();
                n += 1;
                if n == WINDOW {
                    let slot = captured_count.load(Ordering::Relaxed);
                    if let Some(result) = captured.get(slot) {
                        let rms =
                            ((cos_sum * cos_sum + sin_sum * sin_sum) * 2.0).sqrt() / WINDOW as f64;
                        result.rms.store((rms as f32).to_bits(), Ordering::Relaxed);
                        result
                            .ms
                            .store(origin.elapsed().as_millis() as u64 + 1, Ordering::Release);
                        captured_count.store(slot + 1, Ordering::Release);
                    }
                    n = 0;
                    cos_sum = 0.0;
                    sin_sum = 0.0;
                }
            }
        },
        move |_| {
            capture_failed.store(true, Ordering::Release);
        },
        None,
    )?;
    let (sender_finished, sender_failed) = (finished.clone(), failed.clone());
    let mut position = 0usize;
    let sender = cable.build_output_stream(
        &input_config.config(),
        move |data: &mut [f32], _| {
            for frame in data.chunks_mut(2) {
                let sample = if position < DURATION {
                    let fade = (position as f32 / 2_400.0).min(1.0)
                        * ((DURATION - position) as f32 / 2_400.0).min(1.0);
                    let phase = std::f32::consts::TAU * 997.0 * position as f32 / RATE as f32;
                    position += 1;
                    0.01 * fade * phase.sin()
                } else {
                    sender_finished.store(true, Ordering::Release);
                    0.0
                };
                frame.fill(sample);
            }
        },
        move |_| {
            sender_failed.store(true, Ordering::Release);
        },
        None,
    )?;
    capture.play()?;
    sender.play()?;
    println!("READY: elapsed_ms={} tone=997Hz level=-40dBFS duration=15s; CABLE Input -> Auralyn -> Voicemeeter AUX Input", origin.elapsed().as_millis());
    std::io::stdout().flush()?;
    let deadline = Instant::now() + Duration::from_secs(20);
    while !finished.load(Ordering::Acquire)
        && !failed.load(Ordering::Acquire)
        && Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(sender);
    drop(capture);
    if failed.load(Ordering::Acquire) {
        return Err("WASAPI stream failed".into());
    }
    if !finished.load(Ordering::Acquire) {
        return Err("WASAPI output timed out".into());
    }
    println!("elapsed_ms,tone_rms");
    for result in observations.iter().take(count.load(Ordering::Acquire)) {
        let ms = result.ms.load(Ordering::Acquire);
        if ms > 0 {
            println!(
                "{},{}",
                ms - 1,
                f32::from_bits(result.rms.load(Ordering::Relaxed))
            );
        }
    }
    Ok(())
}
