//! 互換の試験の台本つき子プロセス。台本どおりに応答する実プロセスを、実際の読み取りスレッドとつなぐ。
//!
//! 試験の実行ファイル自身を子として起動する。`scripted_engine_entry`は、環境変数がなければ何もしない。
use super::*;
use crate::ipc::{EngineEvent, OutputMessage};
use std::collections::BTreeMap;
use std::ops::Deref;
use std::sync::atomic::AtomicU64;

const ENV: &str = "AURALYN_SCRIPTED_ENGINE";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Step {
    /// そのまま1行を書く。
    Line(String),
    SleepMs(u64),
    /// 試験側が`Observer::release`で同じ名前の門を開けるまで、次の手順に進まない。
    WaitGate(String),
    /// 標準出力を閉じて、子を終了する。
    Exit,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct Script {
    log: PathBuf,
    /// キーは命令の種類（`Start`）。`Start#2`は2回目の`Start`だけに使う。台本にない命令には`Success`を返す。
    steps: BTreeMap<String, Vec<Step>>,
}

pub(crate) fn raw_line(text: &str) -> Step {
    Step::Line(text.to_owned())
}

pub(crate) fn response_line(response: &IpcResponse) -> Step {
    Step::Line(format!(
        "IPC:{}",
        serde_json::to_string(&OutputMessage::Response(response.clone())).unwrap()
    ))
}

pub(crate) fn event_line(event: &EngineEvent) -> Step {
    Step::Line(format!(
        "IPC:{}",
        serde_json::to_string(&OutputMessage::Event(event.clone())).unwrap()
    ))
}

pub(crate) fn error_line(message: &str) -> Step {
    response_line(&IpcResponse::Error(message.to_owned()))
}

pub(crate) fn started_response(generation: u64) -> IpcResponse {
    IpcResponse::Started {
        sample_rate: 48000,
        buffer_size: 512,
        routing: None,
        input_id: None,
        output_id: None,
        stream_generation: Some(generation),
    }
}

pub(crate) fn started_event(generation: u64) -> EngineEvent {
    EngineEvent::Started {
        sample_rate: 48000,
        buffer_size: 512,
        stream_generation: Some(generation),
    }
}

pub(crate) fn stopped_event(generation: u64) -> EngineEvent {
    EngineEvent::Stopped {
        stream_generation: Some(generation),
        ended_stream_generation: Some(generation),
    }
}

/// 成功する開始。`Started`の通知、続けて`Response::Started`。
pub(crate) fn start_steps(generation: u64) -> Vec<Step> {
    vec![
        event_line(&started_event(generation)),
        response_line(&started_response(generation)),
    ]
}

/// 停止。動いていなくても、`Stopped`の通知、続けて`Success`。
pub(crate) fn stop_steps(generation: u64) -> Vec<Step> {
    vec![
        event_line(&stopped_event(generation)),
        response_line(&IpcResponse::Success),
    ]
}

pub(crate) fn auto_gain_status(running: bool, failed: bool) -> Step {
    response_line(&IpcResponse::AutoGain(
        crate::audio_engine::auto_gain::Snapshot {
            revision: 3,
            gain: 1.0,
            confirmed_gain: 1.0,
            settled: true,
            running,
            stream_failed: failed,
            id: 0,
            phase: "idle".into(),
            progress: 0.,
            proposal: None,
            playing: false,
            error: None,
            devices: Vec::new(),
            history_id: None,
            history_epoch: None,
            history_reason: Some(crate::audio_engine::history::Reason::NotCreated),
            undo_available: false,
            redo_available: false,
        },
    ))
}

fn gate_path(log: &std::path::Path, name: &str) -> PathBuf {
    log.with_file_name(format!("gate-{name}"))
}

/// 子の側。`scripted_engine_entry`から呼ぶ。標準入力が閉じたら終了する。
fn run_scripted_child(script: Script) {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    for line in std::io::BufRead::lines(std::io::stdin().lock()).map_while(Result::ok) {
        if let Ok(mut log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&script.log)
        {
            let _ = writeln!(log, "{line}");
        }
        let name = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|value| value.get("type")?.as_str().map(str::to_owned))
            .unwrap_or_default();
        let count = counts.entry(name.clone()).or_default();
        *count += 1;
        let steps = script
            .steps
            .get(&format!("{name}#{count}"))
            .or_else(|| script.steps.get(&name))
            .cloned()
            .unwrap_or_else(|| vec![response_line(&IpcResponse::Success)]);
        for step in steps {
            match step {
                Step::Line(text) => {
                    let mut out = std::io::stdout().lock();
                    let _ = writeln!(out, "{text}");
                    let _ = out.flush();
                }
                Step::SleepMs(ms) => std::thread::sleep(std::time::Duration::from_millis(ms)),
                Step::WaitGate(name) => {
                    let gate = gate_path(&script.log, &name);
                    while !gate.exists() {
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                }
                Step::Exit => std::process::exit(0),
            }
        }
    }
    std::process::exit(0);
}

#[test]
fn scripted_engine_entry() {
    if let Ok(text) = std::env::var(ENV) {
        run_scripted_child(serde_json::from_str(&text).unwrap());
    }
}

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);

/// 試験側から見える記録。子へ送った行、`emit`の呼び出し、起動の回数。
pub(crate) struct Observer {
    pub(crate) recorder: Arc<emit::Recorder>,
    pub(crate) dir: PathBuf,
    log: PathBuf,
    spawned: Arc<AtomicU64>,
    fail_spawn: Arc<AtomicBool>,
}

impl Observer {
    /// 子へ送った行から、命令の種類を送った順に返す。
    pub(crate) fn sent(&self) -> Vec<String> {
        self.sent_json()
            .iter()
            .map(|value| value["type"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    pub(crate) fn sent_json(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// 台本の`WaitGate(name)`で待っている子を進める。
    pub(crate) fn release(&self, name: &str) {
        std::fs::write(gate_path(&self.log, name), b"").unwrap();
    }

    pub(crate) fn spawn_count(&self) -> u64 {
        self.spawned.load(Ordering::SeqCst)
    }

    pub(crate) fn fail_spawns(&self) {
        self.fail_spawn.store(true, Ordering::SeqCst);
    }

    pub(crate) fn last_config_path(&self) -> PathBuf {
        self.dir.join("last_audio_config.json")
    }
}

/// 試験から本番保護を有効にする。`reader_active`が真のあいだだけ保たれる（偽だと次の検査で解除される）。
pub(crate) fn arm_live_protection(host: &mut AudioHost) {
    host.live_modes.armed = true;
}

pub(crate) fn scripted_parts(
    overrides: impl IntoIterator<Item = (&'static str, Vec<Step>)>,
) -> (AudioHost, Observer) {
    let dir = std::env::temp_dir().join(format!(
        "auralyn-compat-{}-{}",
        std::process::id(),
        NEXT_DIR.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("engine-input.log");
    let mut host = AudioHost::new(dir.clone());
    let live_modes = IpcResponse::LiveModes(Box::new(crate::audio_engine::live_modes::Snapshot {
        epoch: "scripted".into(),
        running: false,
        revision: "0".into(),
        accepted_revision: "0".into(),
        completed_revision: "0".into(),
        target: None,
        applied: None,
        phase: "idle".into(),
        armed: false,
        natural_tail: false,
        definitions: host.live_modes.definitions.clone(),
        error: None,
        transaction: None,
    }));
    let mut steps: BTreeMap<String, Vec<Step>> = BTreeMap::from([(
        "ConfigureLiveModes".to_owned(),
        vec![response_line(&live_modes)],
    )]);
    steps.extend(
        overrides
            .into_iter()
            .map(|(name, steps)| (name.to_owned(), steps)),
    );
    let script = Script {
        log: log.clone(),
        steps,
    };
    let recorder = Arc::new(emit::Recorder::default());
    let spawned = Arc::new(AtomicU64::new(0));
    let fail_spawn = Arc::new(AtomicBool::new(false));
    *host.emitter.lock().unwrap() = Some(recorder.emitter());
    let (counter, fail) = (spawned.clone(), fail_spawn.clone());
    host.test_engine_launcher = Some(Arc::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        anyhow::ensure!(!fail.load(Ordering::SeqCst), "fixture spawn failure");
        let name = format!(
            "{}::scripted_engine_entry",
            module_path!().split_once("::").unwrap().1
        );
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", &name, "--nocapture"])
            .env(ENV, serde_json::to_string(&script).unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        Ok(command.spawn()?)
    }));
    (
        host,
        Observer {
            recorder,
            dir,
            log,
            spawned,
            fail_spawn,
        },
    )
}

/// `AudioControl`の下に置いた台本つきの`AudioHost`。コマンド経由の試験に使う。
pub(crate) struct Fixture {
    pub(crate) control: control::AudioControl,
    observer: Observer,
}

impl Fixture {
    pub(crate) fn new(overrides: impl IntoIterator<Item = (&'static str, Vec<Step>)>) -> Self {
        let (host, observer) = scripted_parts(overrides);
        Self {
            control: control::AudioControl::new(host),
            observer,
        }
    }
}

impl Deref for Fixture {
    type Target = Observer;
    fn deref(&self) -> &Observer {
        &self.observer
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Ok(mut host) = self.control.lock(control::Entry::command("fixture_drop")) {
            host.kill_engine();
        }
        let _ = std::fs::remove_dir_all(&self.observer.dir);
    }
}
