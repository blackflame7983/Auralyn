//! プロセス取得から指定した本人用出力へ返す隔離試験。通常設定は変更しない。
use super::{capture, clock, support};
use anyhow::{ensure, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ringbuf::{
    traits::{Producer, Split},
    HeapRb,
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Default)]
struct Shared {
    stop: AtomicBool,
    output_failed: AtomicBool,
    rendered: AtomicU64,
    underruns: AtomicU64,
    max_queued: AtomicUsize,
}

pub fn run(pid: u32, created: u64, output_id: &str, duration: Duration) -> Result<()> {
    ensure!(
        duration.as_secs() >= 1 && duration.as_secs() <= 3600,
        "返し試験の時間が範囲外です"
    );
    let process = support::Process::open(pid)?;
    process.verify(created)?;
    let host = cpal::host_from_id(cpal::HostId::Wasapi)?;
    let device = host
        .output_devices()?
        .find(|d| d.id().is_ok_and(|id| id.1 == output_id))
        .ok_or_else(|| anyhow::anyhow!("指定した本人用出力がありません"))?;
    let config = device
        .supported_output_configs()?
        .find(|f| {
            f.channels() == 2
                && f.sample_format() == cpal::SampleFormat::F32
                && f.min_sample_rate() <= 48000
                && f.max_sample_rate() >= 48000
        })
        .ok_or_else(|| anyhow::anyhow!("本人用出力が48kHz stereo f32に対応していません"))?
        .with_sample_rate(48000)
        .config();
    let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(clock::CAPACITY).split();
    let mut renderer = clock::Renderer::new(config.sample_rate)?;
    let shared = Arc::new(Shared::default());
    let callback = shared.clone();
    let errors = shared.clone();
    let stream = device.build_output_stream(
        &config,
        move |data: &mut [f32], _| {
            data.fill(0.0);
            if callback.stop.load(Ordering::Acquire) {
                return;
            }
            renderer.render(data, &mut rx);
            callback
                .rendered
                .store(renderer.rendered, Ordering::Relaxed);
            callback
                .underruns
                .store(renderer.underruns, Ordering::Relaxed);
            callback
                .max_queued
                .store(renderer.max_queued, Ordering::Relaxed);
            if renderer.failed {
                callback.output_failed.store(true, Ordering::Release);
            }
        },
        move |_| {
            errors.output_failed.store(true, Ordering::Release);
        },
        None,
    )?;
    let cancel = support::Event::new(true)?;
    let capture = capture::Capture::open(process, &cancel)?;
    stream.play()?;
    let mut dropped = 0u64;
    let result = capture.run(duration, &cancel, |frame| {
        if tx.try_push(frame).is_err() {
            dropped += 1;
        }
        if shared.output_failed.load(Ordering::Acquire) {
            let _ = cancel.signal();
        }
    });
    shared.stop.store(true, Ordering::Release);
    stream.pause()?;
    let stats = result?;
    let failed = shared.output_failed.load(Ordering::Acquire);
    println!(
        "{}",
        serde_json::json!({"capture": stats, "dropped_frames": dropped,
        "rendered_frames": shared.rendered.load(Ordering::Relaxed),
        "underruns": shared.underruns.load(Ordering::Relaxed),
        "max_queued_frames": shared.max_queued.load(Ordering::Relaxed),
        "output_failed": failed, "output_endpoint": output_id})
    );
    ensure!(
        !failed && dropped == 0 && shared.rendered.load(Ordering::Relaxed) > 0,
        "返し経路の欠落または失敗を検出しました"
    );
    Ok(())
}
