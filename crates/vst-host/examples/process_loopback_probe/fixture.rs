//! 自分のセッションだけを操作する試験用source。基準音は明示したモードだけで出す。
use super::{capture::RATE, sessions, support::Process};
use anyhow::{ensure, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::{
    fs::OpenOptions,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub fn run(
    duration: Duration,
    ready: &Path,
    mute: bool,
    level: f32,
    endpoint: Option<&str>,
    frequency: u32,
) -> Result<()> {
    ensure!(
        (20..=10000).contains(&frequency),
        "試験音の周波数が範囲外です"
    );
    ensure!(
        duration >= Duration::from_secs(1) && duration <= Duration::from_secs(14_400),
        "試験時間が範囲外です"
    );
    let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
    let device = if let Some(id) = endpoint {
        host.output_devices()?
            .find(|d| d.id().is_ok_and(|candidate| candidate.1 == id))
            .ok_or_else(|| anyhow::anyhow!("指定した試験出力がありません"))?
    } else {
        host.default_output_device()
            .ok_or_else(|| anyhow::anyhow!("既定出力がありません"))?
    };
    let endpoint_id = device.id()?.1;
    let config = device
        .supported_output_configs()?
        .find(|format| {
            format.sample_format() == cpal::SampleFormat::F32
                && format.channels() == 2
                && format.min_sample_rate() <= RATE
                && format.max_sample_rate() >= RATE
        })
        .ok_or_else(|| anyhow::anyhow!("試験用の48kHz stereo f32出力に対応していません"))?
        .with_sample_rate(RATE)
        .config();
    let enabled = Arc::new(AtomicBool::new(false));
    let playing = enabled.clone();
    let failed = Arc::new(AtomicBool::new(false));
    let error = failed.clone();
    let emitted = Arc::new(AtomicU64::new(0));
    let emitted_callback = emitted.clone();
    let mut position = 0u64;
    let stream = device.build_output_stream(
        &config,
        move |output: &mut [f32], _| {
            let active = playing.load(Ordering::Acquire);
            if active {
                emitted_callback.fetch_add((output.len() / 2) as u64, Ordering::Relaxed);
            }
            for frame in output.as_chunks_mut::<2>().0 {
                let sample = if active {
                    // 明示した基準音モードと、万一の経路変更にも小さい振幅に留める。
                    ((position % u64::from(RATE)) as f64
                        * std::f64::consts::TAU
                        * f64::from(frequency)
                        / f64::from(RATE))
                    .sin() as f32
                        * 0.002
                } else {
                    0.0
                };
                frame.fill(sample);
                position += 1;
            }
        },
        move |_| {
            error.store(true, Ordering::Release);
        },
        None,
    )?;
    // セッションがplay後に現れる機器でも、設定確認まではゼロしか出さない。
    stream.play()?;
    let started = Instant::now();
    let endpoints = loop {
        let (count, endpoints) = sessions::configure_own_session(mute, level)?;
        if count > 0 {
            break endpoints;
        }
        ensure!(
            started.elapsed() < Duration::from_secs(2),
            "試験音のセッションを確認できません"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let process = Process::open(std::process::id())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(ready)?;
    serde_json::to_writer(
        &mut file,
        &serde_json::json!({
            "pid": process.pid, "created": process.created, "muted": mute, "session_volume": level,
            "active_render_endpoints": endpoints, "frequency_hz": frequency, "amplitude": 0.002,
            "render_endpoint": endpoint_id,
        }),
    )?;
    file.flush()?;
    enabled.store(true, Ordering::Release);
    let started = Instant::now();
    let mut paused = false;
    while started.elapsed() < duration {
        let requested = ready.with_extension("pause").exists();
        if requested != paused {
            if requested {
                stream.pause()?;
            } else {
                stream.play()?;
            }
            paused = requested;
        }
        ensure!(
            !failed.load(Ordering::Acquire),
            "試験用の出力が停止しました"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    enabled.store(false, Ordering::Release);
    stream.pause()?;
    let result_path = ready.with_extension("result.json");
    let result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(result_path)?;
    serde_json::to_writer(
        result,
        &serde_json::json!({
            "emitted_frames": emitted.load(Ordering::Acquire), "source_failed": failed.load(Ordering::Acquire),
        }),
    )?;
    Ok(())
}
