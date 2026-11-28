//! 音声機器を開かず、専用Engineと共有PCMでミックス後VSTを検証する。
#[allow(dead_code, unused_imports)]
#[path = "../src/audio_engine/post_mix/mod.rs"]
mod post_mix;

use anyhow::{anyhow, bail, ensure, Context, Result};
use post_mix::{ClientRenderer, Mapping, BLOCK_FRAMES, TRANSPORT_LATENCY_FRAMES};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    os::windows::{io::AsRawHandle, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, TryRecvError},
    thread,
    time::{Duration, Instant},
};

const RATE: u32 = 48_000;
const BLOCK_TIME: Duration = Duration::from_nanos(512 * 1_000_000_000 / 48_000);
const TIMEOUT: Duration = Duration::from_secs(5);

struct Engine {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    rx: Receiver<Result<Value, String>>,
}
impl Engine {
    fn spawn(binary: &Path, root: &Path, suffix: &str) -> Result<Self> {
        let appdata = root.join(format!("appdata-{suffix}"));
        let local = root.join(format!("localappdata-{suffix}"));
        fs::create_dir(&appdata)?;
        fs::create_dir(&local)?;
        let stderr = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join(format!("engine-{suffix}.stderr")))?;
        let mut child = Command::new(binary)
            .arg("--post-mix-worker")
            .env("APPDATA", appdata)
            .env("LOCALAPPDATA", local)
            .env("AURALYN_DISABLE_PERF_TWEAKS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr))
            .creation_flags(0x08000000)
            .spawn()
            .context("専用Engineを開始できません")?;
        let stdin = BufWriter::new(
            child
                .stdin
                .take()
                .ok_or_else(|| anyhow!("stdinがありません"))?,
        );
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("stdoutがありません"))?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if let Some(payload) = line.strip_prefix("IPC:") {
                            let value =
                                serde_json::from_str::<Value>(payload).map_err(|e| e.to_string());
                            if tx.send(value).is_err() {
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = tx.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });
        Ok(Self { child, stdin, rx })
    }
    fn request(&mut self, command: Value) -> Result<Value> {
        serde_json::to_writer(&mut self.stdin, &command)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| anyhow!("Engine応答がタイムアウトしました"))?;
            let message = self
                .rx
                .recv_timeout(left)
                .map_err(|e| anyhow!("Engine応答を受信できません: {e}"))?
                .map_err(|e| anyhow!("IPC JSONが不正です: {e}"))?;
            if message["kind"] == "Response" {
                return Ok(message["data"].clone());
            }
        }
    }
    fn success(&mut self, command: Value) -> Result<Value> {
        let response = self.request(command)?;
        ensure!(
            response["type"] != "Error",
            "Engineが操作を拒否しました: {}",
            response["payload"]
        );
        Ok(response)
    }
    fn kill(&mut self) -> Result<()> {
        self.child.kill()?;
        self.child.wait()?;
        Ok(())
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Capture {
    raw: Vec<[f32; 2]>,
    output: Vec<[f32; 2]>,
}
fn signal(frame: usize) -> [f32; 2] {
    let t = frame as f64 / f64::from(RATE);
    // 二音と、相関の曖昧さを避ける決定的な広帯域成分を加える。
    let seed = (frame as u64)
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    let noise = ((seed >> 40) as f64 / 16_777_216.0 - 0.5) * 0.008;
    let voice = 0.04 * (std::f64::consts::TAU * 375.0 * t).sin();
    let music = 0.03 * (std::f64::consts::TAU * 750.0 * t).sin();
    [
        (voice + music + noise) as f32,
        (voice - music + noise) as f32,
    ]
}
fn render(
    renderer: &mut ClientRenderer,
    blocks: usize,
    generation: u64,
    bypass: bool,
) -> Result<Capture> {
    let mut raw = Vec::with_capacity(blocks * BLOCK_FRAMES);
    let mut output = Vec::with_capacity(blocks * BLOCK_FRAMES);
    let mut audio = vec![vec![0.0; BLOCK_FRAMES]; 2];
    let mut deadline = Instant::now();
    for block in 0..blocks {
        if let Some(wait) = deadline.checked_duration_since(Instant::now()) {
            thread::sleep(wait);
        }
        let (left, right) = audio.split_at_mut(1);
        for (index, (left, right)) in left[0].iter_mut().zip(&mut right[0]).enumerate() {
            let value = signal(block * BLOCK_FRAMES + index);
            raw.push(value);
            *left = value[0];
            *right = value[1];
        }
        ensure!(
            renderer.process(&mut audio, BLOCK_FRAMES, false, generation, bypass),
            "転送が失敗し出力をミュートしました"
        );
        output.extend((0..BLOCK_FRAMES).map(|i| [audio[0][i], audio[1][i]]));
        deadline += BLOCK_TIME;
    }
    Ok(Capture { raw, output })
}
fn start(engine: &mut Engine) -> Result<(Mapping, ClientRenderer)> {
    let mut mapping = Mapping::create(RATE)?;
    let renderer = ClientRenderer::new(mapping.client()?);
    let response = engine
        .success(json!({"type":"PostMixStart", "payload":{"descriptor":mapping.descriptor()}}))?;
    ensure!(response["type"] == "Success", "配信VSTの開始応答が不正です");
    let deadline = Instant::now() + TIMEOUT;
    while !mapping.ready() {
        ensure!(
            !mapping.failed() && Instant::now() < deadline,
            "配信VSTが準備できません"
        );
        thread::sleep(Duration::from_millis(2));
    }
    Ok((mapping, renderer))
}
fn stop(engine: &mut Engine, mapping: &Mapping) -> Result<()> {
    mapping.set_failed();
    ensure!(
        engine.success(json!({"type":"Stop"}))?["type"] == "Success",
        "停止に失敗しました"
    );
    let status = engine.success(json!({"type":"ProcessingState"}))?;
    ensure!(
        status["payload"]["present"] == false,
        "専用処理が停止していません"
    );
    Ok(())
}
fn rms_peak(samples: &[[f32; 2]], from: usize) -> (f64, f64) {
    let values = samples[from.min(samples.len())..].iter().flatten();
    let (sum, peak, n) = values.fold((0.0f64, 0.0f64, 0usize), |(sum, peak, n), &v| {
        (
            sum + f64::from(v).powi(2),
            peak.max(f64::from(v).abs()),
            n + 1,
        )
    });
    ((sum / n.max(1) as f64).sqrt(), peak)
}
fn lag(raw: &[[f32; 2]], output: &[[f32; 2]], max: usize) -> Option<usize> {
    let start = max + 1024;
    let end = output.len().min(start + 8192);
    if end <= start || output[start..end].iter().all(|frame| frame[0] == 0.0) {
        return None;
    }
    (0..=max).max_by(|&a, &b| {
        let score = |offset: usize| {
            let (dot, power) = (start..end).fold((0.0f64, 0.0f64), |(dot, power), i| {
                let x = f64::from(raw[i - offset][0]);
                (dot + x * f64::from(output[i][0]), power + x * x)
            });
            dot / power.sqrt().max(f64::MIN_POSITIVE)
        };
        score(a).total_cmp(&score(b))
    })
}
fn wav(root: &Path, name: &str, samples: &[[f32; 2]]) -> Result<Value> {
    let path = root.join(name);
    ensure!(!path.exists(), "証跡を上書きできません");
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: RATE,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut output = hound::WavWriter::create(&path, spec)?;
    for frame in samples {
        for value in frame {
            output.write_sample(*value)?;
        }
    }
    output.finalize()?;
    let (rms, peak) = rms_peak(samples, 0);
    Ok(
        json!({"file":name,"sha256":format!("{:x}", Sha256::digest(fs::read(path)?)),"frames":samples.len(),"rms":rms,"peak":peak}),
    )
}
fn save_case(root: &Path, name: &str, capture: &Capture) -> Result<Value> {
    Ok(
        json!({"raw":wav(root, &format!("{name}-raw.wav"), &capture.raw)?, "output":wav(root, &format!("{name}-output.wav"), &capture.output)?, "lagFrames":lag(&capture.raw, &capture.output, 4096)}),
    )
}
fn expected_error(engine: &mut Engine, command: Value) -> Result<()> {
    let response = engine.request(command)?;
    ensure!(
        response["type"] == "Error",
        "未対応の操作を拒否しませんでした: {response}"
    );
    Ok(())
}
fn run(
    engine_path: &Path,
    root: &Path,
    vst: &Path,
    summary: &mut Value,
    soak_seconds: Option<u64>,
) -> Result<()> {
    let began = Instant::now();
    let mut engine = Engine::spawn(engine_path, root, "first")?;
    let first_pid = engine.child.id();
    expected_error(&mut engine, json!({"type":"GetDevices"}))?;
    expected_error(&mut engine, json!({"type":"BeginDeviceScan"}))?;
    expected_error(
        &mut engine,
        json!({"type":"Start","payload":{"host":"WASAPI","input":null,"output":null,"buffer_size":512,"sample_rate":48000}}),
    )?;
    summary["deviceOperationsRejected"] = json!(true);
    let (identity_map, mut identity_renderer) = start(&mut engine)?;
    let identity = render(&mut identity_renderer, 48, 1, false)?;
    let offset = TRANSPORT_LATENCY_FRAMES as usize;
    let identity_result = save_case(root, "identity", &identity)?;
    summary["emptyRack"] = identity_result.clone();
    ensure!(
        identity
            .output
            .iter()
            .take(offset)
            .flatten()
            .all(|v| *v == 0.0),
        "輸送待ち中が無音ではありません"
    );
    ensure!(
        (offset..identity.output.len()).all(|i| identity.output[i] == identity.raw[i - offset]),
        "空ラックの入出力が一致しません"
    );
    ensure!(
        identity_result["lagFrames"] == TRANSPORT_LATENCY_FRAMES,
        "輸送待ちの相関が一致しません"
    );
    summary["emptyRack"] = identity_result;
    summary["transportLatencyFrames"] = json!(TRANSPORT_LATENCY_FRAMES);
    let old_descriptor = identity_map.descriptor();
    stop(&mut engine, &identity_map)?;
    let load = engine.success(json!({"type":"LoadPlugin","payload":{"path":vst}}))?;
    ensure!(load["type"] == "PluginLoaded", "VSTをロードできません");
    let id = load["payload"]["id"]
        .as_str()
        .ok_or_else(|| anyhow!("VST IDがありません"))?
        .to_string();
    let rack = engine.success(json!({"type":"GetPluginRack"}))?;
    ensure!(
        rack["payload"]["plugins"]
            .as_array()
            .is_some_and(|plugins| plugins.len() == 1 && plugins[0]["id"] == id),
        "専用ラックが一致しません"
    );
    summary["vst"] =
        json!({"name":load["payload"]["name"],"vendor":load["payload"]["vendor"],"rackCount":1});
    let (mapping, mut renderer) = start(&mut engine)?;
    summary["declaredPluginLatencyFrames"] = json!(mapping.plugin_latency_frames());
    let unity = render(&mut renderer, 64, 2, false)?;
    engine.success(json!({"type":"SetGain","payload":{"id":id,"value":0.5}}))?;
    let half = render(&mut renderer, 64, 2, false)?;
    let unity_rms = rms_peak(&unity.output, 16 * BLOCK_FRAMES).0;
    let half_rms = rms_peak(&half.output, 16 * BLOCK_FRAMES).0;
    summary["gain"] = json!({"unity":save_case(root, "gain-unity", &unity)?, "half":save_case(root, "gain-half", &half)?, "steadyRmsRatio":if unity_rms > 0.0 { Some(half_rms/unity_rms) } else { None }});
    ensure!(
        unity_rms > 0.0001 && (0.45..0.55).contains(&(half_rms / unity_rms)),
        "VSTゲインの変化を確認できません"
    );
    engine.success(json!({"type":"SetMute","payload":{"id":id,"active":true}}))?;
    let muted = render(&mut renderer, 32, 2, false)?;
    summary["mute"] = save_case(root, "muted", &muted)?;
    ensure!(
        rms_peak(&muted.output, 12 * BLOCK_FRAMES).1 == 0.0,
        "VSTミュートが無音になりません"
    );
    engine.success(json!({"type":"SetMute","payload":{"id":id,"active":false}}))?;
    engine.success(json!({"type":"SetBypass","payload":{"id":id,"active":true}}))?;
    let bypass = render(&mut renderer, 48, 2, false)?;
    summary["pluginBypass"] = save_case(root, "plugin-bypass", &bypass)?;
    ensure!(
        (12 * BLOCK_FRAMES..bypass.output.len())
            .all(|i| bypass.output[i] == bypass.raw[i - offset]),
        "個別バイパスが原音と一致しません"
    );
    engine.success(json!({"type":"SetBypass","payload":{"id":id,"active":false}}))?;
    let global = render(&mut renderer, 48, 3, true)?;
    summary["packetBypass"] = save_case(root, "packet-bypass", &global)?;
    ensure!(
        (offset..global.output.len()).all(|i| global.output[i] == global.raw[i - offset]),
        "全体バイパスが原音と一致しません"
    );
    let mut pause = vec![vec![9.0; BLOCK_FRAMES]; 2];
    ensure!(
        renderer.process(&mut pause, BLOCK_FRAMES, true, 3, true)
            && pause.iter().flatten().all(|v| *v == 0.0),
        "停止中が無音ではありません"
    );
    let resumed = render(&mut renderer, 24, 4, true)?;
    summary["pauseGeneration"] = save_case(root, "resumed", &resumed)?;
    ensure!(
        resumed
            .output
            .iter()
            .take(offset)
            .flatten()
            .all(|v| *v == 0.0),
        "再開時に古い音が残りました"
    );
    ensure!(
        (offset..resumed.output.len()).all(|i| resumed.output[i] == resumed.raw[i - offset]),
        "再開時の入力と出力が一致しません"
    );
    phase_kill(&mut engine, &mut renderer)?;
    summary["killedWorkerFailsSilent"] = json!(true);
    let killed_descriptor = mapping.descriptor();
    drop(engine);
    let mut restarted = Engine::spawn(engine_path, root, "second")?;
    ensure!(
        restarted.child.id() != first_pid,
        "別Engineを開始できません"
    );
    let empty = restarted.success(json!({"type":"GetPluginRack"}))?;
    ensure!(
        empty["payload"]["plugins"]
            .as_array()
            .is_some_and(Vec::is_empty),
        "VSTが暗黙に復元されました"
    );
    expected_error(
        &mut restarted,
        json!({"type":"PostMixStart","payload":{"descriptor":old_descriptor}}),
    )?;
    expected_error(
        &mut restarted,
        json!({"type":"PostMixStart","payload":{"descriptor":killed_descriptor}}),
    )?;
    ensure!(
        restarted.success(json!({"type":"LoadPlugin","payload":{"path":vst}}))?["type"]
            == "PluginLoaded",
        "明示的なVST再ロードが失敗しました"
    );
    let (next, mut next_renderer) = start(&mut restarted)?;
    let restarted_capture = render(&mut next_renderer, 20, 5, false)?;
    summary["explicitReload"] = save_case(root, "reloaded", &restarted_capture)?;
    stop(&mut restarted, &next)?;
    if let Some(seconds) = soak_seconds {
        run_soak(&mut restarted, root, seconds, summary)?;
    }
    summary["separateProcessAndStaleDescriptorRejected"] = json!(true);
    summary["elapsedSeconds"] = json!(began.elapsed().as_secs_f64());
    Ok(())
}
// 実時間driverだけでCPU時間を取得する。音声機器や他プロセスは観測しない。
fn process_cpu(child: &Child) -> Result<(f64, f64)> {
    use windows::Win32::Foundation::{FILETIME, HANDLE};
    use windows::Win32::System::Threading::GetProcessTimes;
    let (mut created, mut exited, mut kernel, mut user) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe {
        GetProcessTimes(
            HANDLE(child.as_raw_handle()),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )?;
    }
    let seconds = |v: FILETIME| {
        (((v.dwHighDateTime as u64) << 32) | u64::from(v.dwLowDateTime)) as f64 / 10_000_000.0
    };
    Ok((seconds(user), seconds(kernel)))
}

struct SoakWindow {
    name: &'static str,
    start: usize,
    end: usize,
    raw: Vec<[f32; 2]>,
    output: Vec<[f32; 2]>,
}
fn run_soak(engine: &mut Engine, root: &Path, seconds: u64, summary: &mut Value) -> Result<()> {
    let blocks = (seconds * u64::from(RATE)).div_ceil(BLOCK_FRAMES as u64) as usize;
    let total = blocks * BLOCK_FRAMES;
    let window_frames = (10 * RATE as usize).min(total);
    let middle = (total / 2).saturating_sub(window_frames / 2);
    let ranges = [
        ("start", 0),
        ("middle", middle),
        ("end", total - window_frames),
    ];
    let mut windows = ranges.map(|(name, start)| SoakWindow {
        name,
        start,
        end: start + window_frames,
        raw: Vec::with_capacity(window_frames),
        output: Vec::with_capacity(window_frames),
    });
    let sample_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("soak-samples.jsonl"))?;
    let progress_path = root.join("soak-progress.json");
    let (sender, receiver) = mpsc::sync_channel::<Value>(8);
    let logger = thread::spawn(move || -> Result<()> {
        let mut file = BufWriter::new(sample_file);
        for sample in receiver {
            serde_json::to_writer(&mut file, &sample)?;
            file.write_all(b"\n")?;
            file.flush()?;
            // 進捗の更新はprocessing driverと別のスレッドで行う。
            fs::write(&progress_path, serde_json::to_vec_pretty(&sample)?)?;
        }
        file.get_ref().sync_all()?;
        Ok(())
    });
    summary["soak"] = json!({"requestedSeconds":seconds,"passed":false,"sampleFile":"soak-samples.jsonl","progressFile":"soak-progress.json","pid":engine.child.id()});
    let mut result: Result<()> = Ok(());
    let mut rendered = 0usize;
    let mut processing_elapsed = 0.0f64;
    let soak_started = Instant::now();
    let initial_progress =
        json!({"elapsedSeconds":0,"inputFrames":0,"outputFrames":0,"status":"starting"});
    sender
        .try_send(initial_progress)
        .map_err(|e| anyhow!("計測ログを開始できません: {e}"))?;
    let mut initial_latency = None;
    let mut last_latency = None;
    let mut capture_failure = None;
    let mut last_sample: Option<Value> = None;
    let measured = (|| -> Result<()> {
        let (mapping, mut renderer) = start(engine)?;
        initial_latency = mapping.plugin_latency_frames();
        last_latency = initial_latency;
        let started = Instant::now();
        let mut deadline = started;
        let (mut previous_user, mut previous_kernel) = process_cpu(&engine.child)?;
        let mut previous_sample = started;
        let mut audio = vec![vec![0.0; BLOCK_FRAMES]; 2];
        let mut block_raw = [[0.0f32; 2]; BLOCK_FRAMES];
        let mut raw_energy = 0.0f64;
        let mut output_energy = 0.0f64;
        let mut raw_peak = 0.0f64;
        let mut output_peak = 0.0f64;
        let mut sample_values = 0u64;
        for block in 0..blocks {
            if let Some(wait) = deadline.checked_duration_since(Instant::now()) {
                thread::sleep(wait);
            }
            ensure!(
                engine.child.try_wait()?.is_none(),
                "連続計測中にEngineが終了しました"
            );
            loop {
                match engine.rx.try_recv() {
                    Ok(Ok(message)) => {
                        ensure!(
                            message["kind"] != "Response",
                            "予期しないEngine応答があります"
                        );
                        if message["kind"] == "Event" && message["data"]["type"] == "Error" {
                            bail!("連続計測中にEngineエラーを受信しました");
                        }
                    }
                    Ok(Err(error)) => bail!("Engine IPCを読めません: {error}"),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => bail!("Engine IPCが閉じました"),
                }
            }
            ensure!(
                !mapping.failed() && mapping.ready(),
                "配信VSTの転送が停止しました"
            );
            last_latency = mapping.plugin_latency_frames();
            ensure!(
                last_latency == initial_latency,
                "VST申告遅延が連続計測中に変化しました"
            );
            let first = block * BLOCK_FRAMES;
            for (i, value) in block_raw.iter_mut().enumerate() {
                *value = signal(first + i);
                audio[0][i] = value[0];
                audio[1][i] = value[1];
            }
            ensure!(
                renderer.process(&mut audio, BLOCK_FRAMES, false, 77, false),
                "配信VSTの連続転送に失敗しました"
            );
            ensure!(
                audio.iter().flatten().all(|v| v.is_finite()),
                "配信VSTが非有限の値を出力しました"
            );
            if first >= RATE as usize {
                ensure!(
                    audio.iter().flatten().any(|v| *v != 0.0),
                    "連続処理中に無音ブロックを検出しました"
                );
            }
            for (i, raw) in block_raw.iter().enumerate() {
                let out = [audio[0][i], audio[1][i]];
                let absolute = first + i;
                for window in &mut windows {
                    if (window.start..window.end).contains(&absolute) {
                        window.raw.push(*raw);
                        window.output.push(out);
                    }
                }
                for c in 0..2 {
                    let x = f64::from(raw[c]);
                    let y = f64::from(out[c]);
                    raw_energy += x * x;
                    output_energy += y * y;
                    raw_peak = raw_peak.max(x.abs());
                    output_peak = output_peak.max(y.abs());
                    sample_values += 1;
                }
            }
            rendered += BLOCK_FRAMES;
            deadline += BLOCK_TIME;
            let now = Instant::now();
            processing_elapsed = now.duration_since(started).as_secs_f64();
            if now.duration_since(previous_sample) >= Duration::from_secs(25) || block + 1 == blocks
            {
                let (user, kernel) = process_cpu(&engine.child)?;
                let period = now.duration_since(previous_sample).as_secs_f64();
                let sample = json!({"elapsedSeconds":now.duration_since(started).as_secs_f64(),"inputFrames":rendered,"outputFrames":rendered,"transportLatencyFrames":TRANSPORT_LATENCY_FRAMES,"declaredPluginLatencyFrames":last_latency,"engineUserSeconds":user,"engineKernelSeconds":kernel,"engineCpuPercentOneCore":((user-previous_user)+(kernel-previous_kernel))/period.max(f64::MIN_POSITIVE)*100.0,"rawRms":(raw_energy / sample_values.max(1) as f64).sqrt(),"outputRms":(output_energy / sample_values.max(1) as f64).sqrt(),"rawPeak":raw_peak,"outputPeak":output_peak});
                sender
                    .try_send(sample.clone())
                    .map_err(|e| anyhow!("計測ログを記録できません: {e}"))?;
                last_sample = Some(sample);
                previous_sample = now;
                previous_user = user;
                previous_kernel = kernel;
                raw_energy = 0.0;
                output_energy = 0.0;
                raw_peak = 0.0;
                output_peak = 0.0;
                sample_values = 0;
            }
        }
        // 最終ブロックの時間幅まで待ち、指定時間を実時間で通す。
        if let Some(wait) = deadline.checked_duration_since(Instant::now()) {
            thread::sleep(wait);
        }
        processing_elapsed = started.elapsed().as_secs_f64();
        ensure!(
            !mapping.failed()
                && mapping.ready()
                && mapping.plugin_latency_frames() == initial_latency
                && engine.child.try_wait()?.is_none(),
            "終了直前に配信VSTの状態が変わりました"
        );
        stop(engine, &mapping)?;
        Ok(())
    })();
    if let Err(error) = measured {
        capture_failure = Some(format!("{error:#}"));
        let _ = sender.try_send(json!({"status":"failed","elapsedSeconds":processing_elapsed,"inputFrames":rendered,"outputFrames":rendered,"error":capture_failure}));
        let _ = engine.kill();
        result = Err(error);
    }
    drop(sender);
    match logger.join() {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            if result.is_ok() {
                result = Err(error);
            }
        }
        Err(_) => {
            if result.is_ok() {
                result = Err(anyhow!("計測ログの記録が停止しました"));
            }
        }
    }
    let mut saved = Vec::new();
    for window in &windows {
        if !window.raw.is_empty() {
            let saved_window = (|| -> Result<Value> {
                Ok(
                    json!({"window":window.name,"startFrame":window.start,"raw":wav(root, &format!("soak-{}-raw.wav",window.name), &window.raw)?,"output":wav(root, &format!("soak-{}-output.wav",window.name), &window.output)?}),
                )
            })();
            match saved_window {
                Ok(value) => saved.push(value),
                Err(error) => {
                    if result.is_ok() {
                        result = Err(error);
                    }
                }
            }
        }
    }
    let elapsed = soak_started.elapsed().as_secs_f64();
    if capture_failure.is_none() {
        capture_failure = result.as_ref().err().map(|error| format!("{error:#}"));
    }
    summary["soak"] = json!({"requestedSeconds":seconds,"elapsedSeconds":processing_elapsed,"wallElapsedSeconds":elapsed,"passed":result.is_ok(),"sampleFile":"soak-samples.jsonl","progressFile":"soak-progress.json","pid":engine.child.id(),"inputFrames":rendered,"outputFrames":rendered,"declaredPluginLatencyFramesInitial":initial_latency,"declaredPluginLatencyFramesFinal":last_latency,"lastSample":last_sample,"windows":saved,"error":capture_failure});
    result
}
fn phase_kill(engine: &mut Engine, renderer: &mut ClientRenderer) -> Result<()> {
    engine.kill()?;
    for index in 0..12 {
        thread::sleep(BLOCK_TIME);
        let mut audio = vec![vec![0.25; BLOCK_FRAMES]; 2];
        if !renderer.process(&mut audio, BLOCK_FRAMES, false, 3, true) {
            ensure!(
                audio.iter().flatten().all(|v| *v == 0.0),
                "Engine終了後に旧音が残りました"
            );
            ensure!(index < 12, "Engine停止を検出できません");
            return Ok(());
        }
    }
    bail!("Engine停止後に転送停止を検出できませんでした")
}
fn args() -> Result<(PathBuf, PathBuf, PathBuf, Option<u64>)> {
    let mut engine = None;
    let mut output = None;
    let mut vst = None;
    let mut soak_seconds = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(key) = args.next() {
        let value = args.next().ok_or_else(|| anyhow!("引数値がありません"))?;
        match key.to_str() {
            Some("--engine") => engine = Some(PathBuf::from(value)),
            Some("--output-dir") => output = Some(PathBuf::from(value)),
            Some("--vst") => vst = Some(PathBuf::from(value)),
            Some("--soak-seconds") => {
                let seconds: u64 = value
                    .to_str()
                    .ok_or_else(|| anyhow!("計測秒数が不正です"))?
                    .parse()?;
                ensure!((1..=7200).contains(&seconds), "連続計測は1〜7200秒です");
                soak_seconds = Some(seconds);
            }
            _ => bail!("不明な引数です"),
        }
    }
    let engine = engine.ok_or_else(|| anyhow!("--engine が必要です"))?;
    let output = output.ok_or_else(|| anyhow!("--output-dir が必要です"))?;
    let vst = vst.ok_or_else(|| anyhow!("--vst が必要です"))?;
    ensure!(
        engine.is_absolute()
            && output.is_absolute()
            && vst.is_absolute()
            && engine.is_file()
            && vst.exists(),
        "絶対パスと実在するEngine/VSTを指定してください"
    );
    Ok((engine, output, vst, soak_seconds))
}
fn main() -> Result<()> {
    let (engine, root, vst, soak_seconds) = args()?;
    fs::create_dir(&root).context("新規の証跡フォルダーを作成できません")?;
    let mut summary = json!({"passed":false,"source":{"kind":"deterministic digital voice and music tones with noise","sampleRate":RATE,"physicalMicrophone":false},"physicalDeviceOpened":false,"obsTested":false,"sharedMcpUsed":false,"engineSha256":format!("{:x}", Sha256::digest(fs::read(&engine)?)),"transportLatencyFrames":TRANSPORT_LATENCY_FRAMES,"declaredPluginLatencyFrames":null});
    let started = Instant::now();
    let result = run(&engine, &root, &vst, &mut summary, soak_seconds);
    summary["elapsedSeconds"] = json!(started.elapsed().as_secs_f64());
    if let Err(error) = &result {
        summary["error"] = json!(format!("{error:#}"));
    } else {
        summary["passed"] = json!(true);
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("summary.json"))?;
    serde_json::to_writer_pretty(&mut file, &summary)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    result
}
