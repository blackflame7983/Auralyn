//! 段階0の隔離probe。製品UI・設定・既定デバイスは変更しない。
#[path = "process_loopback_probe/activation.rs"]
mod activation;
#[cfg(test)]
#[path = "process_loopback_probe/allocation_tests.rs"]
mod allocation_tests;
#[path = "process_loopback_probe/capture.rs"]
mod capture;
#[path = "process_loopback_probe/clock.rs"]
mod clock;
#[path = "process_loopback_probe/endpoints.rs"]
mod endpoints;
#[path = "process_loopback_probe/fixture.rs"]
mod fixture;
#[path = "process_loopback_probe/monitor.rs"]
mod monitor;
#[path = "process_loopback_probe/sessions.rs"]
mod sessions;
#[path = "process_loopback_probe/support.rs"]
mod support;

use anyhow::{bail, ensure, Context, Result};
use ringbuf::{
    traits::{Consumer, Producer, Split},
    HeapRb,
};
use std::{
    fs::OpenOptions,
    io::BufWriter,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

fn record(
    pid: u32,
    created: u64,
    duration: Duration,
    path: &Path,
    cancel_after: Option<Duration>,
) -> Result<()> {
    ensure!(
        duration >= Duration::from_millis(100) && duration <= Duration::from_secs(3600),
        "取得時間が範囲外です"
    );
    ensure!(
        cancel_after.is_none_or(|value| value <= duration),
        "取消時刻が取得時間を超えています"
    );
    let process = support::Process::open(pid)?;
    process.verify(created)?;
    let cancel = Arc::new(support::Event::new(true)?);
    if cancel_after == Some(Duration::ZERO) {
        cancel.signal()?;
    }
    let capture = capture::Capture::open(process, &cancel)?;
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    let writer = hound::WavWriter::new(
        BufWriter::with_capacity(64 * 1024, file),
        hound::WavSpec {
            channels: 2,
            sample_rate: capture::RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )?;
    let (mut tx, mut rx) = HeapRb::<[f32; 2]>::new(capture::RATE as usize * 2).split();
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    let sink = std::thread::spawn(move || -> Result<u64> {
        let mut writer = writer;
        let mut frames = 0;
        loop {
            // doneを先に観測し、その後キューを排出して最後のframeも保持する。
            let ending = finished.load(Ordering::Acquire);
            let mut consumed = false;
            while let Some(frame) = rx.try_pop() {
                for sample in frame {
                    writer.write_sample(sample)?;
                }
                frames += 1;
                consumed = true;
            }
            if ending {
                break;
            }
            if !consumed {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        writer.finalize()?;
        Ok(frames)
    });
    let mut dropped = 0u64;
    let timer = cancel_after.filter(|delay| !delay.is_zero()).map(|delay| {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            // 対象終了で先に終わった場合も、別の完了eventでtimerを待たせず回収する。
            if support::wait(&[cancel.raw()], delay)
                .ok()
                .flatten()
                .is_none()
            {
                let _ = cancel.signal();
            }
        })
    });
    let result = capture.run(duration, &cancel, |frame| {
        if tx.try_push(frame).is_err() {
            dropped += 1;
        }
    });
    done.store(true, Ordering::Release);
    cancel.signal()?;
    if let Some(timer) = timer {
        timer
            .join()
            .map_err(|_| anyhow::anyhow!("取消workerが停止しました"))?;
    }
    let written = sink
        .join()
        .map_err(|_| anyhow::anyhow!("録音workerが停止しました"))??;
    let stats = result?;
    println!(
        "{}",
        serde_json::json!({ "capture": stats, "recorded_frames": written, "dropped_frames": dropped })
    );
    ensure!(
        dropped == 0 && written == stats.frames,
        "録音キューで音声が欠落しました"
    );
    Ok(())
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let _apartment = support::Apartment::new()?;
    match args.first().map(String::as_str) {
        Some("list") if args.len() == 1 => {
            println!("{}", serde_json::to_string_pretty(&sessions::list()?)?);
        }
        Some("endpoints") if args.len() == 1 => {
            println!("{}", serde_json::to_string_pretty(&endpoints::list()?)?);
        }
        Some("capture-endpoints") if args.len() == 1 => {
            println!("{}", serde_json::to_string_pretty(&endpoints::list_capture()?)?);
        }
        Some("hold-endpoint-muted") if args.len() == 4 => {
            ensure!(Path::new(&args[3]).is_absolute(), "readyの保存先は絶対パスで指定してください");
            endpoints::hold_muted(&args[1], Duration::from_secs(args[2].parse()?), Path::new(&args[3]))?;
        }
        Some("restore-endpoint") if args.len() == 2 => {
            endpoints::restore(Path::new(&args[1]))?;
        }
        Some("monitor") if args.len() == 5 => {
            monitor::run(args[1].parse()?, args[2].parse()?, &args[3], Duration::from_secs(args[4].parse()?))?;
        }
        Some("capture") if args.len() == 5 || args.len() == 6 => {
            let pid = args[1].parse().context("PIDが不正です")?;
            let created = args[2].parse().context("生成時刻が不正です")?;
            let duration = Duration::from_secs(args[3].parse().context("時間が不正です")?);
            ensure!(Path::new(&args[4]).is_absolute(), "録音先は絶対パスで指定してください");
            let cancel_after = args.get(5).map(|value| value.parse::<u64>().map(Duration::from_millis)).transpose().context("取消時刻が不正です")?;
            record(pid, created, duration, Path::new(&args[4]), cancel_after)?;
        }
        Some(mode @ ("source-muted" | "source-volume-zero" | "source-low-volume")) if (3..=5).contains(&args.len()) => {
            let duration = Duration::from_secs(args[1].parse().context("時間が不正です")?);
            ensure!(Path::new(&args[2]).is_absolute(), "readyの保存先は絶対パスで指定してください");
            fixture::run(duration, Path::new(&args[2]), mode == "source-muted", if mode == "source-volume-zero" { 0.0 } else { 1.0 }, args.get(3).map(String::as_str), args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(997))?;
        }
        _ => bail!("使い方: list | endpoints | hold-endpoint-muted <endpoint-id> <seconds> <new.ready.json> | restore-endpoint <snapshot.json> | monitor <pid> <created> <output-endpoint-id> <seconds> | capture <pid> <created> <seconds> <new.wav> [cancel-ms] | source-muted/source-volume-zero/source-low-volume <seconds> <new.ready.json> [endpoint-id] [frequency-hz]"),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("process loopback probe: {error:#}");
        std::process::exit(1);
    }
}
