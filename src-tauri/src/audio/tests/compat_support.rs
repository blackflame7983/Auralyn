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
    /// 孫のプロセス（長く待つだけの試験の実行ファイル）を作り、そのプロセス番号を指定のファイルへ書く。
    SpawnGrandchild(PathBuf),
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
    // 孫は待たない。この子が終わったあとは、Job が回収する。
    let mut grandchildren: Vec<Child> = Vec::new();
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
                Step::SpawnGrandchild(pid_file) => {
                    grandchildren.push(spawn_idle_process());
                    let pid = grandchildren.last().unwrap().id();
                    std::fs::write(pid_file, pid.to_string()).unwrap();
                }
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

const GRANDCHILD_ENV: &str = "AURALYN_IDLE_GRANDCHILD";

/// 長く待つだけの試験の実行ファイル自身を、別のプロセスとして起動する。
pub(crate) fn spawn_idle_process() -> Child {
    let name = format!(
        "{}::idle_grandchild_entry",
        module_path!().split_once("::").unwrap().1
    );
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"])
        .env(GRANDCHILD_ENV, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

/// 孫の側。環境変数がなければ何もしない。Job が終わらせなければ、2分で自分で終わる。
#[test]
fn idle_grandchild_entry() {
    if std::env::var_os(GRANDCHILD_ENV).is_some() {
        std::thread::sleep(std::time::Duration::from_secs(120));
    }
}

/// 作った直後から子を預かる。どこで失敗しても（panic を含む）、Drop で kill して終了を待つ。
/// 停止の状態で作った子を、割り当て・再開・ハンドルの取得の前に、試験の失敗で残さない。
pub(crate) struct ChildGuard(Option<Child>);

impl ChildGuard {
    pub(crate) fn new(child: Child) -> Self {
        Self(Some(child))
    }

    pub(crate) fn id(&self) -> u32 {
        self.0.as_ref().expect("預かっている").id()
    }

    pub(crate) fn child(&self) -> &Child {
        self.0.as_ref().expect("預かっている")
    }

    /// 以後の終了の処理は、受け取った側が持つ。
    pub(crate) fn release(mut self) -> Child {
        self.0.take().expect("預かっている")
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// 試験が持つプロセスのハンドル。親が死んでも、このハンドルで子の生死を確かめて片付けられる。
pub(crate) struct ProcessProbe {
    handle: windows::Win32::Foundation::HANDLE,
}

// SAFETY: ハンドルは所有者だけが閉じ、操作は OS の API に委ねる。
unsafe impl Send for ProcessProbe {}
// SAFETY: 共有の操作は待機・終了・閉じるだけで、OS の API が直列化する。
unsafe impl Sync for ProcessProbe {}

impl ProcessProbe {
    pub(crate) fn open(pid: u32) -> Option<Self> {
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };
        // SAFETY: 取得したハンドルは `ProcessProbe` が所有し、`Drop` で一度だけ閉じる。
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                false,
                pid,
            )
        }
        .ok()?;
        Some(Self { handle })
    }

    /// 終了するまで最大 `millis` ミリ秒待つ。
    pub(crate) fn wait_exit(&self, millis: u32) -> bool {
        use windows::Win32::Foundation::WAIT_OBJECT_0;
        use windows::Win32::System::Threading::WaitForSingleObject;
        // SAFETY: `self.handle` は生存中の有効なハンドル。
        unsafe { WaitForSingleObject(self.handle, millis) == WAIT_OBJECT_0 }
    }

    pub(crate) fn exited(&self) -> bool {
        self.wait_exit(0)
    }

    pub(crate) fn terminate(&self) {
        // SAFETY: `self.handle` は生存中の有効なハンドル。
        let _ = unsafe { windows::Win32::System::Threading::TerminateProcess(self.handle, 1) };
    }
}

impl Drop for ProcessProbe {
    fn drop(&mut self) {
        // SAFETY: このハンドルを所有するのは自分だけで、ここで一度だけ閉じる。
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.handle) };
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
    probes: Arc<Mutex<Vec<Arc<ProcessProbe>>>>,
}

impl Observer {
    /// 起動した子のハンドル（起動した順）。
    pub(crate) fn probe(&self, index: usize) -> Arc<ProcessProbe> {
        self.probes.lock().unwrap()[index].clone()
    }

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
    let probes: Arc<Mutex<Vec<Arc<ProcessProbe>>>> = Arc::default();
    let (counter, fail, seen) = (spawned.clone(), fail_spawn.clone(), probes.clone());
    host.test_engine_launcher = Some(Arc::new(move || {
        // 製品と同じ生成のフラグ。Job への割り当てと再開は起動の手順が行う。
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
        engine_life::apply_creation_flags(&mut command);
        let child = command.spawn()?;
        if let Some(probe) = ProcessProbe::open(child.id()) {
            seen.lock().unwrap().push(Arc::new(probe));
        }
        Ok(child)
    }));
    (
        host,
        Observer {
            recorder,
            dir,
            log,
            spawned,
            fail_spawn,
            probes,
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
