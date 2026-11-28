mod common;
use common::{Current, Dsp, Frame, Registry, FRAME_SIZE, KINDS};
use serde::{Deserialize, Serialize};
use std::{hint::black_box, process::Command, time::Instant};

#[derive(Serialize, Deserialize)]
struct Sample {
    ns: u64,
    hash: u64,
}

#[derive(Debug, Serialize)]
struct Summary {
    count: usize,
    min_ns: u64,
    p50_ns: u64,
    p95_ns: u64,
    p99_ns: u64,
    max_ns: u64,
    mean_ns: f64,
}

fn summarize(samples: &[u64]) -> Summary {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let percentile = |p: usize| sorted[(sorted.len() * p).div_ceil(100) - 1];
    Summary {
        count: sorted.len(),
        min_ns: sorted[0],
        p50_ns: percentile(50),
        p95_ns: percentile(95),
        p99_ns: percentile(99),
        max_ns: *sorted.last().unwrap(),
        mean_ns: sorted.iter().map(|&n| n as f64).sum::<f64>() / sorted.len() as f64,
    }
}

#[derive(Serialize)]
struct Row {
    kind: &'static str,
    phase: &'static str,
    implementation: &'static str,
    summary: Summary,
    trial_p50_ns: Vec<u64>,
    samples_ns: Vec<u64>,
}

fn cold<C: Dsp>(kind: usize) -> Sample {
    // 状態・入力は呼出側で用意し、新規スレッドの最初の処理だけを測る。
    let mut state = C::new();
    let input = common::input(kind, 0);
    std::thread::spawn(move || {
        let mut output = [0.0; FRAME_SIZE];
        let start = Instant::now();
        let vad = state.process(black_box(&mut output), black_box(&input));
        let ns = start.elapsed().as_nanos() as u64;
        black_box((&output, vad));
        Sample {
            ns,
            hash: common::hash(vad, &output),
        }
    })
    .join()
    .unwrap()
}

fn warm<C: Dsp>(kind: usize, frames: usize, resetting: bool) -> (Vec<u64>, u64) {
    let mut state = C::new();
    let inputs: Vec<Frame> = (0..64 + frames).map(|i| common::input(kind, i)).collect();
    std::thread::spawn(move || {
        let mut output = [0.0; FRAME_SIZE];
        for input in &inputs[..64] {
            black_box(state.process(&mut output, input));
        }
        let mut times = Vec::with_capacity(frames);
        let mut vad = 0.0;
        for i in 0..frames {
            if resetting {
                // 履歴を汚す処理とreset後の出力確認は時間区間外。
                for input in &inputs[..4] {
                    black_box(state.process(&mut output, input));
                }
                let start = Instant::now();
                black_box(&mut state).reset();
                black_box(&state);
                times.push(start.elapsed().as_nanos() as u64);
                vad = state.process(&mut output, &inputs[0]);
            } else {
                let input = &inputs[64 + i];
                let start = Instant::now();
                vad = state.process(black_box(&mut output), black_box(input));
                let ns = start.elapsed().as_nanos() as u64;
                times.push(ns);
            }
            black_box((&output, vad));
        }
        (times, common::hash(vad, &output))
    })
    .join()
    .unwrap()
}

fn child(implementation: &str, kind: usize) -> Result<Sample, Box<dyn std::error::Error>> {
    let output = Command::new(std::env::current_exe()?)
        .args(["--cold", implementation, &kind.to_string()])
        .output()?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned().into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

fn row(
    kind: usize,
    phase: &'static str,
    implementation: &'static str,
    samples: Vec<u64>,
    trials: Vec<u64>,
) -> Row {
    Row {
        kind: KINDS[kind],
        phase,
        implementation,
        summary: summarize(&samples),
        trial_p50_ns: trials,
        samples_ns: samples,
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    common::configuration()?;
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--cold") {
        if args.len() != 3 {
            return Err("--cold <current|registry> <kind>".into());
        }
        let kind: usize = args[2].parse()?;
        if kind >= KINDS.len() {
            return Err("kindの範囲が不正です".into());
        }
        let sample = match args[1].as_str() {
            "current" => cold::<Current>(kind),
            "registry" => cold::<Registry>(kind),
            _ => return Err("実装名が不正です".into()),
        };
        println!("{}", serde_json::to_string(&sample)?);
        return Ok(());
    }
    let quick = args == ["--quick"];
    if !args.is_empty() && !quick {
        return Err("引数なし、または--quickを指定してください".into());
    }
    let (cold_samples, trials, steady_frames, resets) = if quick {
        (5, 2, 128, 8)
    } else {
        (31, 7, 2048, 128)
    };
    // 測定外の全フレーム比較。coldの子プロセスにはこの初期化は引き継がれない。
    common::validate();
    let mut rows = Vec::new();
    for kind in 0..KINDS.len() {
        let (mut current, mut registry) = (Vec::new(), Vec::new());
        for i in 0..cold_samples {
            let (a, b) = if i % 2 == 0 {
                (child("current", kind)?, child("registry", kind)?)
            } else {
                let b = child("registry", kind)?;
                (child("current", kind)?, b)
            };
            assert_eq!(a.hash, b.hash);
            current.push(a.ns);
            registry.push(b.ns);
        }
        rows.push(row(kind, "cold", "current", current, Vec::new()));
        rows.push(row(kind, "cold", "registry", registry, Vec::new()));
        for (phase, frames, resetting) in
            [("steady", steady_frames, false), ("reset", resets, true)]
        {
            let (mut current, mut registry, mut ca, mut cb) =
                (Vec::new(), Vec::new(), Vec::new(), Vec::new());
            for i in 0..trials {
                let (a, b) = if i % 2 == 0 {
                    (
                        warm::<Current>(kind, frames, resetting),
                        warm::<Registry>(kind, frames, resetting),
                    )
                } else {
                    let b = warm::<Registry>(kind, frames, resetting);
                    (warm::<Current>(kind, frames, resetting), b)
                };
                assert_eq!(a.1, b.1);
                ca.push(summarize(&a.0).p50_ns);
                cb.push(summarize(&b.0).p50_ns);
                current.extend(a.0);
                registry.extend(b.0);
            }
            rows.push(row(kind, phase, "current", current, ca));
            rows.push(row(kind, phase, "registry", registry, cb));
        }
    }
    let mut clock = Vec::with_capacity(1024);
    for _ in 0..1024 {
        let start = Instant::now();
        clock.push(start.elapsed().as_nanos() as u64);
    }
    println!(
        "{}",
        serde_json::to_string(
            &serde_json::json!({"cold_samples":cold_samples,"trials":trials,
        "steady_frames_per_trial":steady_frames,"resets_per_trial":resets,"warmup_frames":64,
        "clock_pair":summarize(&clock),"output_equal":true,"allocator_instrumentation":false,
        "state_layout_bytes":{"current":Current::state_size(),"registry":Registry::state_size()},"rows":rows})
        )?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn statistics_keep_outliers_and_use_nearest_rank() {
        let s = summarize(&[1000, 3, 1, 2]);
        assert_eq!(
            (s.count, s.min_ns, s.p50_ns, s.p95_ns, s.p99_ns, s.max_ns),
            (4, 1, 2, 1000, 1000, 1000)
        );
        assert_eq!(s.mean_ns, 251.5);
    }
}
