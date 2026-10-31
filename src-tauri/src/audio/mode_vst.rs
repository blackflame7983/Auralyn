//! VSTと内蔵モードを、応答待ち中にHostを占有せず一体で切り替える。
use super::*;
use crate::audio_engine::{builtin, live_modes as model, mode_silence, split_monitor};
use crate::vst_host::presets::{self, PresetPlugin};
use sha2::{Digest, Sha256};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

const MAX_JOURNAL_BYTES: u64 = 96 * 1024 * 1024;
const MAX_STATE_BYTES: usize = 64 * 1024 * 1024;
const BUSY: &str = "本番モードのVST切替・復旧中です。完了後に操作してください";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema_version: u32,
    id: String,
    phase: String,
    plugins: Vec<PresetPlugin>,
    builtin: builtin::Config,
    #[serde(default)]
    monitor: Option<split_monitor::State>,
    origin_mode: Option<model::Mode>,
    original_mute: bool,
}
impl Journal {
    fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.schema_version == 1 && !self.id.is_empty() && self.id.len() <= 256,
            "復旧記録の形式が不正です"
        );
        validate_plugins(&self.plugins, true)?;
        self.builtin.clone().normalize().map_err(|e| anyhow!(e))?;
        if let Some(monitor) = &self.monitor {
            monitor.validate()?;
        }
        Ok(())
    }
}

pub(super) struct State {
    path: PathBuf,
    journal: Option<Journal>,
    blocked: bool,
    transaction: Option<Transaction>,
    pub(super) status: Option<model::TransactionSnapshot>,
    cached: Option<model::Snapshot>,
    orphan_disk: Option<DiskJob>,
    #[cfg(test)]
    writer_serialized: Arc<AtomicBool>,
    #[cfg(test)]
    writer_finished: Arc<AtomicBool>,
}
impl State {
    pub(super) fn new(root: &std::path::Path) -> Self {
        let path = root.join("live-mode-vst-journal.json");
        let blocked = path.try_exists().unwrap_or(true);
        let journal = if blocked {
            read_journal(&path).ok()
        } else {
            None
        };
        let status = blocked.then(|| model::TransactionSnapshot {
            id: journal
                .as_ref()
                .map(|j| j.id.clone())
                .unwrap_or_else(|| "unknown".into()),
            phase: "recovery_required".into(),
            target: None,
            error: Some(
                if journal.is_some() {
                    "前回の切替が完了していません。内容を確認して手動復旧してください"
                } else {
                    "復旧記録を読めません。音声を停止したまま記録を保全してください"
                }
                .into(),
            ),
            recovery_available: journal.is_some(),
        });
        Self {
            path,
            journal,
            blocked,
            transaction: None,
            status,
            cached: None,
            orphan_disk: None,
            #[cfg(test)]
            writer_serialized: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            writer_finished: Arc::new(AtomicBool::new(false)),
        }
    }
    pub(super) fn blocked(&self) -> bool {
        self.blocked || self.busy()
    }
    pub(super) fn busy(&self) -> bool {
        self.transaction.is_some()
    }
}

fn read_journal(path: &std::path::Path) -> Result<Journal> {
    anyhow::ensure!(
        std::fs::metadata(path)?.len() <= MAX_JOURNAL_BYTES,
        "復旧記録が大きすぎます"
    );
    let journal: Journal = serde_json::from_slice(&std::fs::read(path)?)?;
    journal.validate()?;
    Ok(journal)
}
fn validate_plugins(plugins: &[PresetPlugin], require_state: bool) -> Result<()> {
    anyhow::ensure!(plugins.len() <= 32, "VSTは32件までです");
    let mut bytes = 0usize;
    for plugin in plugins {
        let request = restore_request(plugin);
        request.validate().map_err(|e| anyhow!(e))?;
        anyhow::ensure!(
            !require_state || plugin.state.is_some(),
            "復旧用VST状態がありません"
        );
        bytes = bytes.saturating_add(plugin.state.as_ref().map_or(0, String::len));
    }
    anyhow::ensure!(bytes <= MAX_STATE_BYTES, "VST状態の合計が大きすぎます");
    Ok(())
}
fn restore_request(plugin: &PresetPlugin) -> crate::ipc::RestorePluginRequest {
    crate::ipc::RestorePluginRequest {
        path: plugin.path.clone(),
        state: plugin.state.clone(),
        bypassed: !plugin.enabled,
        muted: plugin.muted,
        gain: plugin.gain,
    }
}
fn load_binding(root: &std::path::Path, name: &str) -> Result<(Vec<PresetPlugin>, String)> {
    let path = presets::preset_path(root, name).map_err(|e| anyhow!(e))?;
    anyhow::ensure!(
        std::fs::metadata(&path)?.len() <= MAX_JOURNAL_BYTES,
        "プロファイルが大きすぎます"
    );
    let profile: presets::Preset = serde_json::from_slice(&std::fs::read(path)?)?;
    anyhow::ensure!(
        profile.includes_plugin_category(),
        "VSTカテゴリを含むプロファイルを選んでください"
    );
    validate_plugins(&profile.plugins, false)?;
    // 機器・NR・ゲイン・プロファイルの内蔵処理を指紋にも適用にも混ぜない。
    let canonical = serde_json::to_vec(&(true, &profile.plugins))?;
    let revision = format!("{:x}", Sha256::digest(canonical));
    Ok((profile.plugins, revision))
}

#[derive(Clone, Copy, Debug)]
enum Step {
    Configure,
    ReadLive,
    SourceRack,
    SourceState(usize),
    ConfirmSource,
    SourceBuiltin,
    SourceMonitor,
    SilenceBegin,
    SilencePoll,
    ClearRack,
    Unload,
    Restore(usize),
    VerifyRack,
    VerifyState(usize),
    BuiltinCurrent,
    BuiltinApply,
    BuiltinSelect,
    BuiltinWait,
    MonitorRestore,
    MonitorConfigure,
    MonitorWait,
    LiveWait,
    Finish,
    ReleasePoll,
}
type WriteResult = (BufWriter<ChildStdin>, std::io::Result<()>);
struct Pending {
    receiver: Receiver<IpcResponse>,
    writer: Option<Receiver<WriteResult>>,
    sent: Instant,
}
#[derive(Clone, Copy)]
enum DiskKind {
    Prepare,
    Commit,
}
struct DiskJob {
    receiver: Receiver<std::result::Result<Journal, String>>,
    kind: DiskKind,
}
struct Transaction {
    id: String,
    generation: u64,
    mode: Option<model::Mode>,
    source: Journal,
    destination: Vec<PresetPlugin>,
    desired: builtin::Config,
    source_rack: Vec<crate::ipc::RackPlugin>,
    source_revision: u64,
    current_rack: Vec<crate::ipc::RackPlugin>,
    builtin: Option<builtin::Snapshot>,
    monitor_revision: Option<String>,
    step: Step,
    pending: Option<Pending>,
    disk: Option<DiskJob>,
    condition_pending: Option<conditions::Pending>,
    started: Instant,
    journaled: bool,
    silence_ready: bool,
    rollback: bool,
    recovery: bool,
    error: Option<String>,
}

impl AudioHost {
    pub(super) fn guard_mode_vst(&self) -> Result<()> {
        anyhow::ensure!(!self.mode_vst.blocked(), BUSY);
        Ok(())
    }
    pub(super) fn mode_vst_snapshot(&self) -> model::Snapshot {
        let mut snapshot = self
            .mode_vst
            .cached
            .clone()
            .unwrap_or_else(|| model::Snapshot {
                epoch: self.live_modes.epoch.clone(),
                running: false,
                revision: "0".into(),
                accepted_revision: "0".into(),
                completed_revision: "0".into(),
                target: self.live_modes.target,
                applied: None,
                phase: if self.live_modes.target.is_some() {
                    "stopped"
                } else {
                    "custom"
                }
                .into(),
                armed: self.live_modes.armed,
                natural_tail: false,
                definitions: self.live_modes.definitions.clone(),
                error: self.live_modes.load_error.clone(),
                transaction: None,
            });
        snapshot.epoch = self.live_modes.epoch.clone();
        snapshot.running &= self.reader_active.load(Ordering::Acquire);
        snapshot.definitions = self.live_modes.definitions.clone();
        snapshot.transaction = self.mode_vst.status.clone();
        snapshot
    }
    pub(super) fn cache_mode_snapshot(&mut self, snapshot: &model::Snapshot) {
        self.mode_vst.cached = Some(snapshot.clone());
    }
    pub(super) fn bind_mode_profile(
        &mut self,
        expected: String,
        mode: model::Mode,
        name: Option<String>,
    ) -> Result<model::Snapshot> {
        self.guard_mode_vst()?;
        self.preflight_live_changes()?;
        anyhow::ensure!(
            expected == self.live_modes.definitions.version,
            "本番モード設定が変更されました。再取得してください"
        );
        let binding = name
            .map(|name| {
                let root = self
                    .live_modes
                    .path
                    .parent()
                    .ok_or_else(|| anyhow!("設定保存先がありません"))?;
                let (_, revision) = load_binding(root, &name)?;
                Ok::<_, anyhow::Error>(model::ProfileBinding { name, revision })
            })
            .transpose()?;
        let mut definitions = self.live_modes.definitions.clone();
        if binding.is_some() {
            definitions.config(mode).map_err(|e| anyhow!(e))?;
        }
        match mode {
            model::Mode::Singing => definitions.profiles.singing = binding,
            model::Mode::Talk => definitions.profiles.talk = binding,
        }
        definitions.version = definitions
            .version
            .parse::<u64>()?
            .checked_add(1)
            .ok_or_else(|| anyhow!("保存回数の上限です"))?
            .to_string();
        let definitions = definitions.validate().map_err(|e| anyhow!(e))?;
        crate::migration::write_json(&self.live_modes.path, &definitions)
            .map_err(|e| anyhow!(e))?;
        self.live_modes.definitions = definitions;
        self.live_modes.needs_sync = true;
        Ok(self.mode_vst_snapshot())
    }
    pub(super) fn mode_profile(&self, mode: model::Mode) -> Option<&model::ProfileBinding> {
        match mode {
            model::Mode::Singing => self.live_modes.definitions.profiles.singing.as_ref(),
            model::Mode::Talk => self.live_modes.definitions.profiles.talk.as_ref(),
        }
    }
    pub(super) fn begin_mode_vst(&mut self, mode: model::Mode) -> Result<model::Snapshot> {
        self.guard_mode_vst()?;
        self.preflight_live_changes()?;
        anyhow::ensure!(
            self.session_restore.is_none() && self.bundle_change_generation.is_none(),
            BUSY
        );
        let binding = self
            .mode_profile(mode)
            .ok_or_else(|| anyhow!("プロファイル参照がありません"))?;
        let (destination, revision) = load_binding(
            self.live_modes
                .path
                .parent()
                .ok_or_else(|| anyhow!("保存先がありません"))?,
            &binding.name,
        )?;
        anyhow::ensure!(
            revision == binding.revision,
            "登録後にVSTプロファイルが変更されました。登録し直してください"
        );
        let desired = self
            .live_modes
            .definitions
            .config(mode)
            .map_err(|e| anyhow!(e))?;
        anyhow::ensure!(
            self.reader_active.load(Ordering::Acquire) && self.child.is_some(),
            "音声を開始してからVST付きモードを切り替えてください"
        );
        let id = format!(
            "{}:vst:{}",
            self.live_modes.epoch,
            crate::audio_engine::restoration::unix_ms()
        );
        let source = Journal {
            schema_version: 1,
            id: id.clone(),
            phase: "preparing".into(),
            plugins: Vec::new(),
            builtin: Default::default(),
            monitor: None,
            origin_mode: self.live_modes.target,
            original_mute: self.is_global_muted,
        };
        let tx = Transaction {
            id,
            generation: self.engine_generation,
            mode: Some(mode),
            source,
            destination,
            desired,
            source_rack: Vec::new(),
            source_revision: 0,
            current_rack: Vec::new(),
            builtin: None,
            monitor_revision: None,
            step: Step::Configure,
            pending: None,
            disk: None,
            condition_pending: Some(self.conditions.begin()),
            started: Instant::now(),
            journaled: false,
            silence_ready: false,
            rollback: false,
            recovery: false,
            error: None,
        };
        self.frontend_bootstrap.cancel();
        self.frontend_bootstrap.session_claimed = true;
        self.mode_vst.transaction = Some(tx);
        self.notify_conditions_changed();
        self.emit_mode_rack_event("session-rack-change-started");
        self.update_mode_status("preparing", None, false);
        Ok(self.mode_vst_snapshot())
    }
    pub(super) fn recover_mode_vst(&mut self, epoch: String) -> Result<model::Snapshot> {
        anyhow::ensure!(
            epoch == self.live_modes.epoch
                && !self.mode_vst.busy()
                && self.mode_vst.orphan_disk.is_none(),
            "古い復旧操作または切替中です"
        );
        anyhow::ensure!(self.mode_vst.blocked, "復旧対象がありません");
        let source = read_journal(&self.mode_vst.path)?;
        // 手動復旧は既存streamを再利用しない。停止中のsidecarだけを起動する。
        self.kill_engine();
        self.is_global_muted = true;
        self.require_explicit_start();
        // sidecarの起動準備に限り内部経路を通す。音声Startは発行しない。
        self.mode_vst.blocked = false;
        let launched = self.ensure_engine_running();
        self.mode_vst.blocked = true;
        launched?;
        self.observe_live_generation();
        let tx = Transaction {
            id: source.id.clone(),
            generation: self.engine_generation,
            mode: source.origin_mode,
            destination: source.plugins.clone(),
            desired: source.builtin.clone(),
            source,
            source_rack: Vec::new(),
            source_revision: 0,
            current_rack: Vec::new(),
            builtin: None,
            monitor_revision: None,
            step: Step::ClearRack,
            pending: None,
            disk: None,
            condition_pending: Some(self.conditions.begin()),
            started: Instant::now(),
            journaled: true,
            silence_ready: false,
            rollback: false,
            recovery: true,
            error: None,
        };
        self.mode_vst.transaction = Some(tx);
        self.notify_conditions_changed();
        self.emit_mode_rack_event("session-rack-change-started");
        self.update_mode_status("restoring", None, false);
        Ok(self.mode_vst_snapshot())
    }
    fn update_mode_status(&mut self, phase: &str, error: Option<String>, recovery: bool) {
        let (id, target) = self
            .mode_vst
            .transaction
            .as_ref()
            .map(|t| (t.id.clone(), t.mode))
            .unwrap_or_else(|| {
                (
                    self.mode_vst
                        .journal
                        .as_ref()
                        .map(|j| j.id.clone())
                        .unwrap_or_else(|| "unknown".into()),
                    None,
                )
            });
        if self.mode_vst.status.as_ref().is_some_and(|s| {
            s.id == id
                && s.phase == phase
                && s.target == target
                && s.error == error
                && s.recovery_available == recovery
        }) {
            return;
        }
        self.mode_vst.status = Some(model::TransactionSnapshot {
            id,
            phase: phase.into(),
            target,
            error,
            recovery_available: recovery,
        });
        if let Ok(emitter) = self.emitter.lock() {
            if let Some(handle) = emitter.as_ref() {
                let _ = handle.emit("live-modes-invalidated", ());
            }
        }
    }
    pub(super) fn cancel_mode_vst(&mut self, message: &str) {
        let canceled = self.mode_vst.transaction.is_some();
        if let Some(mut tx) = self.mode_vst.transaction.take() {
            if tx.journaled || tx.disk.is_some() {
                self.mode_vst.journal = Some(tx.source);
                self.mode_vst.blocked = true;
            }
            if let Some(job) = tx.disk.take() {
                self.mode_vst.orphan_disk = Some(job);
            }
        }
        if self.mode_vst.blocked {
            self.is_global_muted = true;
            self.require_explicit_start();
            if let Ok(emitter) = self.emitter.lock() {
                if let Some(handle) = emitter.as_ref() {
                    let _ = handle.emit("global-mute-changed", true);
                }
            }
            self.update_mode_status(
                "recovery_required",
                Some(message.into()),
                self.mode_vst.journal.is_some() && self.mode_vst.orphan_disk.is_none(),
            );
        } else {
            self.update_mode_status("failed", Some(message.into()), false);
        }
        if canceled {
            self.emit_mode_rack_event("session-rack-change-cancelled");
        }
    }
    fn emit_mode_rack_event(&self, event: &str) {
        if let Ok(emitter) = self.emitter.lock() {
            if let Some(handle) = emitter.as_ref() {
                let _ = handle.emit(event, ());
            }
        }
    }
    pub(crate) fn start_mode_vst_scheduler(host: &Arc<Mutex<AudioHost>>) {
        let weak = Arc::downgrade(host);
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(10));
            let Some(host) = weak.upgrade() else { break };
            if let Ok(mut host) = host.lock() {
                host.poll_mode_vst();
            };
        });
    }
    pub(crate) fn poll_mode_vst(&mut self) {
        self.poll_orphan_mode_disk();
        let Some(mut tx) = self.mode_vst.transaction.take() else {
            return;
        };
        if tx.generation != self.engine_generation || !self.reader_active.load(Ordering::Acquire) {
            self.fail_mode_transaction(
                tx,
                "音声エンジンの世代または接続が変わりました".into(),
                true,
            );
            return;
        }
        if tx.started.elapsed() > Duration::from_secs(120) {
            self.fail_mode_transaction(tx, "切替が時間内に完了しませんでした".into(), true);
            return;
        }
        if let Some(mut pending) = tx.pending.take() {
            if let Some(writer) = pending.writer.take() {
                match writer.try_recv() {
                    Ok((stdin, Ok(()))) => self.stdin = Some(stdin),
                    Ok((_, Err(error))) => {
                        self.pending_reply_tx.cancel();
                        self.fail_mode_transaction(tx, error.to_string(), true);
                        return;
                    }
                    Err(TryRecvError::Empty)
                        if pending.sent.elapsed() < Duration::from_secs(10) =>
                    {
                        pending.writer = Some(writer);
                        tx.pending = Some(pending);
                        self.mode_vst.transaction = Some(tx);
                        return;
                    }
                    _ => {
                        self.fail_mode_transaction(tx, "VST切替の送信結果が不明です".into(), true);
                        return;
                    }
                }
            }
            match pending.receiver.try_recv() {
                Ok(response) => {
                    if let Err(error) = self.mode_step_response(&mut tx, response) {
                        self.fail_mode_transaction(tx, error.to_string(), false);
                        return;
                    }
                }
                Err(TryRecvError::Empty) if pending.sent.elapsed() < Duration::from_secs(10) => {
                    tx.pending = Some(pending);
                    self.mode_vst.transaction = Some(tx);
                    return;
                }
                _ => {
                    self.fail_mode_transaction(tx, "VST切替の応答が不明です".into(), true);
                    return;
                }
            }
        }
        match self.poll_mode_disk(&mut tx) {
            Ok(true) => {
                self.mode_vst.transaction = Some(tx);
                return;
            }
            Ok(false) => {}
            Err(error) => {
                self.fail_mode_transaction(tx, error.to_string(), false);
                return;
            }
        }
        // 完了後のjournal消去まで失敗を隠さない。
        if matches!(tx.step, Step::ReleasePoll)
            && tx.pending.is_none()
            && self
                .mode_vst
                .status
                .as_ref()
                .is_some_and(|s| s.phase == "completed")
        {
            self.complete_mode_transaction(tx);
            return;
        }
        let command = match self.mode_step_command(&mut tx) {
            Ok(command) => command,
            Err(error) => {
                self.fail_mode_transaction(tx, error.to_string(), false);
                return;
            }
        };
        let phase = if tx.rollback || tx.recovery {
            "restoring"
        } else {
            match tx.step {
                Step::Configure
                | Step::ReadLive
                | Step::SourceRack
                | Step::SourceState(_)
                | Step::SourceMonitor
                | Step::ConfirmSource
                | Step::SourceBuiltin => "preparing",
                Step::SilenceBegin | Step::SilencePoll => "silencing",
                Step::BuiltinCurrent
                | Step::BuiltinApply
                | Step::BuiltinSelect
                | Step::BuiltinWait
                | Step::LiveWait => "applying",
                Step::Finish | Step::ReleasePoll => "committing",
                _ => "loading",
            }
        };
        match self.send_mode_command(command) {
            Ok(pending) => {
                tx.pending = Some(pending);
                self.mode_vst.transaction = Some(tx);
                self.update_mode_status(phase, None, false);
            }
            Err(error) => self.fail_mode_transaction(tx, error.to_string(), true),
        }
    }
    fn send_mode_command(&mut self, command: IpcCommand) -> Result<Pending> {
        let receiver = self.pending_reply_tx.begin()?;
        let Some(mut stdin) = self.stdin.take() else {
            self.pending_reply_tx.cancel();
            return Err(anyhow!("音声エンジン入力がありません"));
        };
        let (sender, writer) = std::sync::mpsc::channel();
        #[cfg(test)]
        let serialized = self.mode_vst.writer_serialized.clone();
        #[cfg(test)]
        let finished = self.mode_vst.writer_finished.clone();
        // 大きいVST stateのJSON化・pipe書込みもHost mutexの外で行う。
        thread::spawn(move || {
            let result = serde_json::to_string(&command)
                .map_err(std::io::Error::other)
                .and_then(|json| {
                    #[cfg(test)]
                    serialized.store(true, Ordering::Release);
                    writeln!(stdin, "{json}").and_then(|()| stdin.flush())
                });
            #[cfg(test)]
            finished.store(true, Ordering::Release);
            let _ = sender.send((stdin, result));
        });
        Ok(Pending {
            receiver,
            writer: Some(writer),
            sent: Instant::now(),
        })
    }
    fn spawn_mode_disk(&self, tx: &mut Transaction, kind: DiskKind) {
        let path = self.mode_vst.path.clone();
        let mut journal = tx.source.clone();
        if matches!(kind, DiskKind::Commit) {
            journal.phase = "committing".into();
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let result = crate::migration::write_json(&path, &journal).map(|()| journal);
            let _ = sender.send(result);
        });
        tx.disk = Some(DiskJob { receiver, kind });
    }
    // trueの間はIPCも次段階も送らず、短いpollだけでHost mutexを解放する。
    fn poll_mode_disk(&mut self, tx: &mut Transaction) -> Result<bool> {
        let Some(job) = tx.disk.take() else {
            return Ok(false);
        };
        match job.receiver.try_recv() {
            Err(TryRecvError::Empty) => {
                tx.disk = Some(job);
                Ok(true)
            }
            Err(TryRecvError::Disconnected) => {
                tx.disk = Some(job);
                Err(anyhow!("復旧記録の書込み結果が不明です"))
            }
            Ok(Err(error)) => Err(anyhow!(error)),
            Ok(Ok(journal)) => {
                self.mode_vst.journal = Some(journal);
                match job.kind {
                    DiskKind::Prepare => {
                        tx.journaled = true;
                        tx.step = Step::SilenceBegin;
                    }
                    DiskKind::Commit => {
                        if tx.recovery {
                            tx.step = Step::ReleasePoll;
                            self.mode_vst.status = Some(model::TransactionSnapshot {
                                id: tx.id.clone(),
                                phase: "completed".into(),
                                target: tx.mode,
                                error: None,
                                recovery_available: false,
                            });
                        } else {
                            tx.step = Step::Finish;
                        }
                    }
                }
                Ok(false)
            }
        }
    }
    fn poll_orphan_mode_disk(&mut self) {
        let Some(job) = self.mode_vst.orphan_disk.take() else {
            return;
        };
        match job.receiver.try_recv() {
            Err(TryRecvError::Empty) => {
                self.mode_vst.orphan_disk = Some(job);
            }
            Ok(Ok(journal)) => {
                self.mode_vst.journal = Some(journal);
                self.update_mode_status(
                    "recovery_required",
                    Some("中止した切替の復旧記録を保存しました。音声は停止したままです".into()),
                    true,
                );
            }
            Ok(Err(_)) => {
                // Prepare失敗はまだラックを変更していない。Commit失敗は旧journalを維持する。
                if matches!(job.kind, DiskKind::Prepare) {
                    self.mode_vst.blocked = false;
                    self.mode_vst.journal = None;
                }
                self.update_mode_status(
                    if self.mode_vst.blocked {
                        "recovery_required"
                    } else {
                        "failed"
                    },
                    Some(
                        "中止した切替の記録保存が完了しませんでした。音声は停止したままです".into(),
                    ),
                    self.mode_vst.blocked,
                );
            }
            Err(TryRecvError::Disconnected) => {
                self.update_mode_status(
                    "recovery_required",
                    Some(
                        "復旧記録の書込み結果が不明です。音声は停止したまま記録を保全してください"
                            .into(),
                    ),
                    false,
                );
            }
        }
    }
    fn fail_mode_transaction(&mut self, mut tx: Transaction, error: String, ambiguous: bool) {
        if tx.journaled
            && tx.silence_ready
            && !tx.rollback
            && !tx.recovery
            && !ambiguous
            && !matches!(tx.step, Step::Finish | Step::ReleasePoll)
        {
            tx.rollback = true;
            tx.error = Some(error);
            tx.destination = tx.source.plugins.clone();
            tx.desired = tx.source.builtin.clone();
            tx.pending = None;
            tx.step = Step::ClearRack;
            tx.started = Instant::now();
            self.mode_vst.transaction = Some(tx);
            self.update_mode_status("restoring", None, false);
            return;
        }
        let journaled = tx.journaled;
        self.mode_vst.transaction = Some(tx);
        self.cancel_mode_vst(&error);
        if journaled || ambiguous {
            self.kill_engine();
        } else if !self.mode_vst.blocked {
            // 取得・原本保存の確定失敗ではラックは未変更。cancelで消した旧IDを
            // 実ラックから再照合し、稼働中のVSTを画面から操作できる状態へ戻す。
            self.emit_mode_rack_event("session-rack-invalidated");
        }
    }
    fn complete_mode_transaction(&mut self, mut tx: Transaction) {
        if let Err(error) = std::fs::remove_file(&self.mode_vst.path) {
            self.mode_vst.transaction = Some(tx);
            self.cancel_mode_vst(&format!("復旧記録を消去できません: {error}"));
            self.kill_engine();
            return;
        }
        self.mode_vst.blocked = false;
        self.mode_vst.journal = None;
        self.live_modes.target = if tx.rollback || tx.recovery {
            // 元の値は完全復元するが、VST内部編集を含めモード同一性は証明しない。
            None
        } else {
            tx.mode
        };
        self.live_modes.needs_sync = tx.recovery;
        if tx.recovery {
            self.is_global_muted = true;
            self.require_explicit_start();
        }
        if let Some(cached) = self.mode_vst.cached.as_mut() {
            cached.target = self.live_modes.target;
            cached.applied = self.live_modes.target;
            cached.phase = if tx.recovery {
                "stopped"
            } else if tx.rollback {
                "custom"
            } else {
                "settled"
            }
            .into();
        }
        self.mode_vst.status = tx.error.map(|error| model::TransactionSnapshot {
            id: tx.id,
            phase: "failed".into(),
            target: tx.mode,
            error: Some(error),
            recovery_available: false,
        });
        drop(tx.condition_pending.take());
        self.conditions.lifecycle(!tx.recovery);
        self.notify_conditions_changed();
        if let Ok(emitter) = self.emitter.lock() {
            if let Some(handle) = emitter.as_ref() {
                for event in ["live-modes-invalidated", "session-rack-invalidated"] {
                    let _ = handle.emit(event, ());
                }
            }
        }
    }
}

impl AudioHost {
    fn mode_step_command(&mut self, tx: &mut Transaction) -> Result<IpcCommand> {
        Ok(match tx.step {
            Step::Configure => IpcCommand::ConfigureLiveModes {
                definitions: self.live_modes.definitions.clone(),
                armed: false,
            },
            Step::ReadLive => IpcCommand::LiveMode {
                request: model::Request::Snapshot,
            },
            Step::SourceRack | Step::ConfirmSource | Step::ClearRack | Step::VerifyRack => {
                IpcCommand::GetPluginRack
            }
            Step::SourceState(index) => IpcCommand::GetPluginState {
                id: tx.source_rack[index].id.clone(),
            },
            Step::SourceBuiltin | Step::BuiltinCurrent | Step::BuiltinWait => {
                IpcCommand::BuiltinEffects {
                    request: builtin::Request::Snapshot,
                }
            }
            Step::SilenceBegin => IpcCommand::ModeSilence {
                request: mode_silence::Request::Begin { id: tx.id.clone() },
            },
            Step::SilencePoll | Step::ReleasePoll => IpcCommand::ModeSilence {
                request: mode_silence::Request::Snapshot { id: tx.id.clone() },
            },
            Step::Unload => IpcCommand::UnloadPlugin {
                id: tx
                    .current_rack
                    .first()
                    .ok_or_else(|| anyhow!("削除対象がありません"))?
                    .id
                    .clone(),
            },
            Step::Restore(index) => {
                self.next_restore_operation = self
                    .next_restore_operation
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("復元操作IDの上限です"))?;
                IpcCommand::RestorePlugin {
                    request: restore_request(&tx.destination[index]),
                    operation_id: self.next_restore_operation,
                    expires_at_ms: crate::audio_engine::restoration::unix_ms()
                        .saturating_add(8_000),
                }
            }
            Step::VerifyState(index) => IpcCommand::GetPluginState {
                id: tx.current_rack[index].id.clone(),
            },
            Step::BuiltinSelect => {
                let intent = model::Intent {
                    client_id: "host-vst".into(),
                    sequence: self
                        .next_restore_operation
                        .saturating_add(crate::audio_engine::restoration::unix_ms())
                        .min(9_007_199_254_740_991),
                    expected_epoch: self.live_modes.engine_epoch.clone(),
                };
                IpcCommand::LiveMode {
                    request: match tx.mode {
                        Some(model::Mode::Singing) => model::Request::SingingOn { intent },
                        _ => model::Request::TalkOn { intent },
                    },
                }
            }
            Step::LiveWait => IpcCommand::LiveMode {
                request: model::Request::Snapshot,
            },
            Step::SourceMonitor | Step::MonitorWait => IpcCommand::ModeMonitor {
                request: split_monitor::Request::Snapshot,
            },
            Step::MonitorRestore => IpcCommand::ModeMonitor {
                request: split_monitor::Request::Restore {
                    state: tx.source.monitor.clone(),
                },
            },
            Step::MonitorConfigure => {
                // 停止復旧したsidecarにも通常の出力構成を先に同期する。
                // 復旧後の初回Startの再送と、利用者による明示編集を区別できる。
                let path = self.last_config_path.with_file_name("live_output.json");
                let config: crate::audio_engine::live_output::Config = if path.try_exists()? {
                    serde_json::from_slice(&std::fs::read(path)?)?
                } else {
                    Default::default()
                };
                config.validate()?;
                anyhow::ensure!(
                    config.split_processing == tx.source.monitor.is_some(),
                    "復旧原本と保存済みの自分用出力構成が一致しません"
                );
                IpcCommand::LiveOutput {
                    config: Some(config),
                }
            }
            Step::BuiltinApply => {
                let snapshot = tx
                    .builtin
                    .as_ref()
                    .ok_or_else(|| anyhow!("内蔵設定の現在値がありません"))?;
                IpcCommand::BuiltinEffects {
                    request: builtin::Request::Apply {
                        epoch: snapshot.epoch.clone(),
                        expected_revision: snapshot.revision.clone(),
                        config: tx.desired.clone(),
                    },
                }
            }
            Step::Finish => IpcCommand::ModeSilence {
                request: mode_silence::Request::Finish { id: tx.id.clone() },
            },
        })
    }
    fn mode_step_response(&mut self, tx: &mut Transaction, response: IpcResponse) -> Result<()> {
        if let IpcResponse::Error(error) = &response {
            anyhow::bail!(error.clone());
        }
        match (tx.step, response) {
            (Step::Configure, IpcResponse::LiveModes(snapshot)) => {
                anyhow::ensure!(snapshot.error.is_none(), "本番モード定義を同期できません");
                self.live_modes.engine_epoch = snapshot.epoch.clone();
                self.live_modes.needs_sync = false;
                tx.step = Step::ReadLive;
            }
            (Step::ReadLive, IpcResponse::LiveModes(snapshot)) => {
                anyhow::ensure!(
                    snapshot.epoch == self.live_modes.engine_epoch
                        && snapshot.running
                        && snapshot.error.is_none()
                        && !matches!(
                            snapshot.phase.as_str(),
                            "queued" | "transitioning" | "partial"
                        ),
                    "現在の本番モードの切替完了を待ってください"
                );
                tx.source.origin_mode = snapshot.target;
                self.cache_mode_snapshot(&snapshot);
                tx.step = Step::SourceRack;
            }
            (
                Step::SourceRack,
                IpcResponse::PluginRack {
                    plugins,
                    revision,
                    running,
                    ..
                },
            ) => {
                anyhow::ensure!(
                    running,
                    "音声を開始してからVST付きモードを切り替えてください"
                );
                anyhow::ensure!(plugins.len() <= 32, "元ラックが32件を超えています");
                tx.source_rack = plugins;
                tx.source_revision = revision;
                tx.step = if tx.source_rack.is_empty() {
                    Step::ConfirmSource
                } else {
                    Step::SourceState(0)
                };
            }
            (Step::SourceState(index), IpcResponse::PluginState { id, state }) => {
                let plugin = &tx.source_rack[index];
                anyhow::ensure!(id == plugin.id, "元ラック状態のIDが一致しません");
                tx.source.plugins.push(PresetPlugin {
                    path: plugin.path.clone(),
                    name: plugin.name.clone(),
                    vendor: String::new(),
                    version: String::new(),
                    enabled: plugin.enabled,
                    muted: plugin.muted,
                    gain: plugin.gain,
                    state: Some(state),
                });
                validate_plugins(&tx.source.plugins, true)?;
                tx.step = if index + 1 == tx.source_rack.len() {
                    Step::ConfirmSource
                } else {
                    Step::SourceState(index + 1)
                };
            }
            (
                Step::ConfirmSource,
                IpcResponse::PluginRack {
                    plugins, revision, ..
                },
            ) => {
                anyhow::ensure!(
                    revision == tx.source_revision && racks_equal(&plugins, &tx.source_rack),
                    "取得中に元ラックが変更されました"
                );
                tx.step = Step::SourceBuiltin;
            }
            (Step::SourceBuiltin, IpcResponse::BuiltinEffects(snapshot)) => {
                anyhow::ensure!(
                    !snapshot.pending && snapshot.error.is_none(),
                    "内蔵処理の切替完了を待ってください"
                );
                tx.source.builtin = snapshot.config;
                tx.step = Step::SourceMonitor;
            }
            (Step::SourceMonitor, IpcResponse::ModeMonitor(snapshot)) => {
                anyhow::ensure!(
                    snapshot.epoch == self.live_modes.engine_epoch
                        && !snapshot.failed
                        && !snapshot.pending
                        && snapshot.revision == snapshot.completed_revision,
                    "自分用処理の切替完了を待ってください"
                );
                tx.source.monitor = snapshot.state;
                tx.source.validate()?;
                anyhow::ensure!(
                    !self.mode_vst.path.try_exists()?,
                    "未完了の復旧記録があるため上書きを拒否しました"
                );
                self.spawn_mode_disk(tx, DiskKind::Prepare);
            }
            (Step::SilenceBegin | Step::SilencePoll, IpcResponse::ModeSilence(snapshot)) => {
                anyhow::ensure!(
                    snapshot.id == tx.id && snapshot.active && !snapshot.failed && snapshot.running,
                    "無音確認が失敗しました"
                );
                if snapshot.ready {
                    tx.silence_ready = true;
                    tx.step = Step::ClearRack;
                } else {
                    tx.step = Step::SilencePoll;
                }
            }
            (
                Step::ClearRack,
                IpcResponse::PluginRack {
                    plugins, running, ..
                },
            ) => {
                anyhow::ensure!(!tx.recovery || !running, "復旧時に音声が開始されています");
                tx.current_rack = plugins;
                tx.step = if tx.current_rack.is_empty() {
                    if tx.destination.is_empty() {
                        Step::VerifyRack
                    } else {
                        Step::Restore(0)
                    }
                } else {
                    Step::Unload
                };
            }
            (Step::ClearRack, IpcResponse::RackBusy) => {}
            (Step::Unload, IpcResponse::Success) => tx.step = Step::ClearRack,
            (
                Step::Restore(index),
                IpcResponse::PluginRestored {
                    operation_id,
                    plugin,
                },
            ) => {
                anyhow::ensure!(
                    operation_id == self.next_restore_operation && (tx.recovery || plugin.prepared),
                    "VSTの復元完了を確認できません"
                );
                tx.step = if index + 1 == tx.destination.len() {
                    Step::VerifyRack
                } else {
                    Step::Restore(index + 1)
                };
            }
            (
                Step::VerifyRack,
                IpcResponse::PluginRack {
                    plugins, running, ..
                },
            ) => {
                anyhow::ensure!(
                    (!tx.recovery || !running) && rack_matches(&plugins, &tx.destination),
                    "復元後のVST順序・設定が一致しません"
                );
                tx.current_rack = plugins;
                tx.step = if tx.current_rack.is_empty() {
                    Step::BuiltinCurrent
                } else {
                    Step::VerifyState(0)
                };
            }
            (Step::VerifyState(index), IpcResponse::PluginState { id, state }) => {
                anyhow::ensure!(
                    id == tx.current_rack[index].id
                        && tx.destination[index]
                            .state
                            .as_ref()
                            .is_none_or(|expected| expected == &state),
                    "VST状態の復元結果が一致しません"
                );
                tx.step = if index + 1 == tx.current_rack.len() {
                    Step::BuiltinCurrent
                } else {
                    Step::VerifyState(index + 1)
                };
            }
            (Step::BuiltinCurrent, IpcResponse::BuiltinEffects(snapshot)) => {
                anyhow::ensure!(!snapshot.pending, "内蔵処理の反映待ちです");
                tx.builtin = Some(snapshot);
                tx.step = Step::BuiltinApply;
            }
            (Step::BuiltinSelect, IpcResponse::LiveModes(snapshot)) => {
                anyhow::ensure!(
                    snapshot.error.is_none() && snapshot.target == tx.mode,
                    "内蔵モードの選択に失敗しました"
                );
                self.cache_mode_snapshot(&snapshot);
                tx.step = Step::BuiltinWait;
            }
            (Step::BuiltinApply, IpcResponse::BuiltinEffects(snapshot)) => {
                anyhow::ensure!(snapshot.error.is_none(), "内蔵処理を反映できません");
                tx.step = if tx.rollback || tx.recovery {
                    Step::BuiltinWait
                } else {
                    Step::BuiltinSelect
                };
            }
            (Step::BuiltinWait, IpcResponse::BuiltinEffects(snapshot)) => {
                anyhow::ensure!(
                    snapshot.error.is_none() && snapshot.config == tx.desired,
                    "内蔵処理の値が一致しません"
                );
                if !snapshot.pending
                    && (tx.recovery || snapshot.revision == snapshot.applied_revision)
                {
                    if tx.recovery || tx.rollback {
                        tx.step = if tx.recovery {
                            Step::MonitorConfigure
                        } else {
                            Step::MonitorRestore
                        };
                    } else {
                        tx.step = Step::LiveWait;
                    }
                }
            }
            (Step::MonitorConfigure, IpcResponse::LiveOutput(status)) => {
                anyhow::ensure!(
                    status.error.is_none()
                        && status.config.split_processing == tx.source.monitor.is_some(),
                    "復旧前の出力構成の同期を確認できません"
                );
                tx.step = Step::MonitorRestore;
            }
            (Step::MonitorRestore, IpcResponse::ModeMonitor(snapshot)) => {
                anyhow::ensure!(
                    tx.builtin
                        .as_ref()
                        .is_some_and(|builtin| snapshot.epoch == builtin.epoch)
                        && !snapshot.failed
                        && snapshot.state == tx.source.monitor,
                    "自分用処理の復元要求を確認できません"
                );
                tx.monitor_revision = Some(snapshot.revision);
                tx.step = Step::MonitorWait;
            }
            (Step::MonitorWait, IpcResponse::ModeMonitor(snapshot)) => {
                anyhow::ensure!(
                    tx.builtin
                        .as_ref()
                        .is_some_and(|builtin| snapshot.epoch == builtin.epoch)
                        && !snapshot.failed
                        && snapshot.state == tx.source.monitor
                        && Some(&snapshot.revision) == tx.monitor_revision.as_ref(),
                    "自分用処理の復元結果が一致しません"
                );
                if !snapshot.pending && snapshot.revision == snapshot.completed_revision {
                    self.commit_mode_transaction(tx)?;
                }
            }
            (Step::LiveWait, IpcResponse::LiveModes(snapshot)) => {
                anyhow::ensure!(
                    snapshot.epoch == self.live_modes.engine_epoch
                        && snapshot.error.is_none()
                        && snapshot.target == tx.mode
                        && snapshot.running
                        && snapshot.phase != "partial",
                    "本番モードの全送出先への反映を確認できません"
                );
                if snapshot.phase == "settled"
                    && snapshot.applied == tx.mode
                    && snapshot.revision == snapshot.completed_revision
                {
                    self.cache_mode_snapshot(&snapshot);
                    self.commit_mode_transaction(tx)?;
                }
            }
            (Step::Finish | Step::ReleasePoll, IpcResponse::ModeSilence(snapshot)) => {
                anyhow::ensure!(
                    snapshot.id == tx.id && !snapshot.failed && snapshot.running,
                    "無音解除の結果を確認できません"
                );
                tx.step = Step::ReleasePoll;
                if !snapshot.active {
                    self.mode_vst.status = Some(model::TransactionSnapshot {
                        id: tx.id.clone(),
                        phase: "completed".into(),
                        target: tx.mode,
                        error: None,
                        recovery_available: false,
                    });
                }
            }
            _ => anyhow::bail!("本番モード切替の応答形式が不正です"),
        }
        Ok(())
    }
    fn commit_mode_transaction(&mut self, tx: &mut Transaction) -> Result<()> {
        // 無音解除前に、原本を保持したままコミット段階を耐久保存する。
        self.spawn_mode_disk(tx, DiskKind::Commit);
        Ok(())
    }
}
fn racks_equal(a: &[crate::ipc::RackPlugin], b: &[crate::ipc::RackPlugin]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            a.id == b.id
                && a.path == b.path
                && a.enabled == b.enabled
                && a.muted == b.muted
                && a.gain == b.gain
        })
}
fn rack_matches(rack: &[crate::ipc::RackPlugin], plugins: &[PresetPlugin]) -> bool {
    rack.len() == plugins.len()
        && rack.iter().zip(plugins).all(|(a, b)| {
            a.path == b.path && a.enabled == b.enabled && a.muted == b.muted && a.gain == b.gain
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn host() -> AudioHost {
        let root = std::env::temp_dir().join(format!(
            "auralyn-mode-vst-{}-{}-{}",
            std::process::id(),
            crate::audio_engine::restoration::unix_ms(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        AudioHost::new(root)
    }
    fn plugin() -> PresetPlugin {
        PresetPlugin {
            path: "unit-test.vst3".into(),
            name: "unit".into(),
            vendor: "vendor".into(),
            version: "1".into(),
            enabled: true,
            muted: false,
            gain: 1.0,
            state: Some("state".into()),
        }
    }
    fn journal() -> Journal {
        Journal {
            schema_version: 1,
            id: "tx-test".into(),
            phase: "preparing".into(),
            plugins: vec![],
            builtin: Default::default(),
            monitor: None,
            origin_mode: Some(model::Mode::Talk),
            original_mute: false,
        }
    }
    fn tx(step: Step) -> Transaction {
        Transaction {
            id: "tx-test".into(),
            generation: 0,
            mode: Some(model::Mode::Singing),
            source: journal(),
            destination: vec![],
            desired: Default::default(),
            source_rack: vec![],
            source_revision: 0,
            current_rack: vec![],
            builtin: None,
            monitor_revision: None,
            step,
            pending: None,
            disk: None,
            condition_pending: None,
            started: Instant::now(),
            journaled: false,
            silence_ready: false,
            rollback: false,
            recovery: false,
            error: None,
        }
    }
    fn builtin(config: builtin::Config, pending: bool) -> IpcResponse {
        IpcResponse::BuiltinEffects(builtin::Snapshot {
            epoch: "engine".into(),
            revision: "4".into(),
            applied_revision: if pending { "3" } else { "4" }.into(),
            config,
            pending,
            undo_token: None,
            redo_token: None,
            history_reason: None,
            error: None,
        })
    }
    fn monitor(state: Option<split_monitor::State>, pending: bool) -> IpcResponse {
        IpcResponse::ModeMonitor(Box::new(split_monitor::StateSnapshot {
            epoch: "engine".into(),
            state,
            revision: "9".into(),
            completed_revision: if pending { "8" } else { "9" }.into(),
            pending,
            failed: false,
        }))
    }
    fn rack(plugins: Vec<crate::ipc::RackPlugin>, revision: u64) -> IpcResponse {
        IpcResponse::PluginRack {
            plugins,
            restore_eligible: false,
            revision,
            running: true,
        }
    }
    fn silence(active: bool, ready: bool) -> IpcResponse {
        IpcResponse::ModeSilence(mode_silence::Snapshot {
            id: "tx-test".into(),
            active,
            ready,
            running: true,
            failed: false,
        })
    }
    fn await_disk(host: &mut AudioHost, transaction: &mut Transaction) -> Result<()> {
        let started = Instant::now();
        while host.poll_mode_disk(transaction)? {
            assert!(started.elapsed() < Duration::from_secs(5));
            thread::sleep(Duration::from_millis(1));
        }
        Ok(())
    }
    #[test]
    fn binding_fingerprint_pins_only_vst_and_detects_replacement_before_silence() {
        let mut host = host();
        let root = host.live_modes.path.parent().unwrap().to_path_buf();
        let mut profile = presets::Preset {
            schema_version: 2,
            name: "linked".into(),
            plugins: vec![plugin()],
            plugins_included: Some(true),
            audio_config: None,
            noise_control: None,
            builtin_fx: None,
        };
        presets::save_preset(&root, "linked", &profile).unwrap();
        let (_, first) = load_binding(&root, "linked").unwrap();
        profile.name = "metadata only".into();
        presets::save_preset(&root, "linked", &profile).unwrap();
        assert_eq!(first, load_binding(&root, "linked").unwrap().1);
        host.live_modes.definitions.singing = Some(Default::default());
        host.live_modes.definitions.profiles.singing = Some(model::ProfileBinding {
            name: "linked".into(),
            revision: first,
        });
        profile.plugins[0].muted = true;
        presets::save_preset(&root, "linked", &profile).unwrap();
        assert!(host
            .begin_mode_vst(model::Mode::Singing)
            .unwrap_err()
            .to_string()
            .contains("変更"));
        assert!(!host.mode_vst.path.exists());
        assert!(!host.mode_vst.busy());
        assert!(host.child.is_none());
    }
    #[test]
    fn legacy_empty_is_not_bindable_and_explicit_empty_is() {
        let host = host();
        let root = host.live_modes.path.parent().unwrap();
        let mut profile = presets::Preset {
            schema_version: 1,
            name: "empty".into(),
            plugins: vec![],
            plugins_included: None,
            audio_config: None,
            noise_control: None,
            builtin_fx: None,
        };
        presets::save_preset(root, "empty", &profile).unwrap();
        assert!(load_binding(root, "empty").is_err());
        profile.plugins_included = Some(true);
        presets::save_preset(root, "empty", &profile).unwrap();
        assert!(load_binding(root, "empty").unwrap().0.is_empty());
    }
    #[test]
    fn pending_silence_ack_never_unloads_and_wrong_generation_ack_fails() {
        let mut host = host();
        let mut transaction = tx(Step::SilenceBegin);
        host.mode_step_response(&mut transaction, silence(true, false))
            .unwrap();
        assert!(matches!(transaction.step, Step::SilencePoll));
        assert!(!transaction.silence_ready);
        let mut stale = mode_silence::Snapshot {
            id: "old".into(),
            active: true,
            ready: true,
            running: true,
            failed: false,
        };
        assert!(host
            .mode_step_response(&mut transaction, IpcResponse::ModeSilence(stale.clone()))
            .is_err());
        stale.id = "tx-test".into();
        stale.running = false;
        assert!(host
            .mode_step_response(&mut transaction, IpcResponse::ModeSilence(stale))
            .is_err());
        host.mode_step_response(&mut transaction, silence(true, true))
            .unwrap();
        assert!(matches!(transaction.step, Step::ClearRack));
    }
    #[test]
    fn source_revision_change_and_missing_state_are_rejected() {
        let mut host = host();
        let mut transaction = tx(Step::ConfirmSource);
        transaction.source_revision = 10;
        assert!(host
            .mode_step_response(&mut transaction, rack(vec![], 11))
            .is_err());
        let mut source = journal();
        source.plugins = vec![plugin()];
        source.plugins[0].state = None;
        assert!(source.validate().is_err());
        source.plugins = (0..33).map(|_| plugin()).collect();
        assert!(source.validate().is_err());
    }
    #[test]
    fn journal_write_failure_prevents_silence() {
        let mut host = host();
        host.live_modes.engine_epoch = "engine".into();
        // 親が通常ファイルならjournalを作成できない。原本以外の既存ファイルは触らない。
        let root = host.live_modes.path.parent().unwrap();
        std::fs::write(root, b"not a directory").unwrap();
        let mut transaction = tx(Step::SourceBuiltin);
        host.mode_step_response(&mut transaction, builtin(Default::default(), false))
            .unwrap();
        host.mode_step_response(&mut transaction, monitor(None, false))
            .unwrap();
        assert!(await_disk(&mut host, &mut transaction).is_err());
        assert!(!transaction.journaled);
        assert!(matches!(transaction.step, Step::SourceMonitor));
        host.reader_active.store(true, Ordering::Release);
        let generation = host.engine_generation;
        host.fail_mode_transaction(transaction, "journal write failed".into(), false);
        assert_eq!(host.engine_generation, generation);
        assert!(host.reader_active.load(Ordering::Acquire));
        assert!(!host.mode_vst.blocked());
        assert_eq!(host.mode_vst.status.as_ref().unwrap().phase, "failed");
    }
    #[test]
    fn known_source_state_failure_keeps_the_original_engine_available() {
        let mut host = host();
        host.reader_active.store(true, Ordering::Release);
        let generation = host.engine_generation;
        host.fail_mode_transaction(tx(Step::SourceState(0)), "state unavailable".into(), false);
        assert_eq!(host.engine_generation, generation);
        assert!(host.reader_active.load(Ordering::Acquire));
        assert!(!host.mode_vst.blocked());
        assert_eq!(host.mode_vst.status.as_ref().unwrap().phase, "failed");
    }
    #[test]
    fn known_apply_failure_rolls_back_and_second_failure_requires_recovery() {
        let mut host = host();
        let mut transaction = tx(Step::Restore(0));
        transaction.journaled = true;
        transaction.silence_ready = true;
        transaction.source.plugins = vec![plugin()];
        host.fail_mode_transaction(transaction, "load failed".into(), false);
        let rolled = host.mode_vst.transaction.take().unwrap();
        assert!(rolled.rollback && matches!(rolled.step, Step::ClearRack));
        assert_eq!(rolled.destination, rolled.source.plugins);
        assert!(host.guard_mode_vst().is_ok()); // workerは一時take中、外部はHost mutexで排他。
        host.fail_mode_transaction(rolled, "rollback failed".into(), false);
        assert!(host.mode_vst.blocked());
        assert!(host.is_global_muted);
        assert_eq!(
            host.mode_vst.status.as_ref().unwrap().phase,
            "recovery_required"
        );
    }
    #[test]
    fn ambiguous_response_never_rolls_back_or_unmutes() {
        let mut host = host();
        let mut transaction = tx(Step::Restore(0));
        transaction.journaled = true;
        transaction.silence_ready = true;
        host.fail_mode_transaction(transaction, "timeout".into(), true);
        assert!(!host.mode_vst.busy());
        assert!(host.mode_vst.blocked());
        assert!(host.is_global_muted);
        assert!(host.start(None, None, None, None, None).is_err());
        assert!(host.set_global_mute(false).is_err());
        assert!(host.child.is_none());
    }
    #[test]
    fn persisted_and_corrupt_journals_block_start_without_automatic_recovery() {
        for corrupt in [false, true] {
            let host = host();
            let root = host.live_modes.path.parent().unwrap().to_path_buf();
            if corrupt {
                std::fs::create_dir_all(&root).unwrap();
                std::fs::write(&host.mode_vst.path, b"{broken").unwrap();
            } else {
                crate::migration::write_json(&host.mode_vst.path, &journal()).unwrap();
            }
            let mut restarted = AudioHost::new(root);
            restarted.warmup().unwrap();
            assert!(restarted.child.is_none());
            assert!(restarted.is_global_muted);
            assert!(restarted
                .live_modes(model::Request::Snapshot)
                .unwrap()
                .transaction
                .is_some());
            assert!(restarted.start(None, None, None, None, None).is_err());
            assert_eq!(
                restarted
                    .mode_vst
                    .status
                    .as_ref()
                    .unwrap()
                    .recovery_available,
                !corrupt
            );
        }
    }
    #[test]
    fn pending_builtin_and_staged_release_never_clear_journal() {
        let mut host = host();
        host.live_modes.engine_epoch = "engine".into();
        let mut transaction = tx(Step::BuiltinWait);
        transaction.rollback = true;
        if let IpcResponse::BuiltinEffects(snapshot) = builtin(Default::default(), false) {
            transaction.builtin = Some(snapshot);
        }
        crate::migration::write_json(&host.mode_vst.path, &transaction.source).unwrap();
        host.mode_step_response(&mut transaction, builtin(Default::default(), true))
            .unwrap();
        assert!(matches!(transaction.step, Step::BuiltinWait));
        host.mode_step_response(&mut transaction, builtin(Default::default(), false))
            .unwrap();
        assert!(matches!(transaction.step, Step::MonitorRestore));
        host.mode_step_response(&mut transaction, monitor(None, true))
            .unwrap();
        host.mode_step_response(&mut transaction, monitor(None, true))
            .unwrap();
        assert!(matches!(transaction.step, Step::MonitorWait));
        assert!(transaction.disk.is_none());
        host.mode_step_response(&mut transaction, monitor(None, false))
            .unwrap();
        await_disk(&mut host, &mut transaction).unwrap();
        assert!(matches!(transaction.step, Step::Finish));
        host.mode_step_response(&mut transaction, silence(true, false))
            .unwrap();
        assert!(matches!(transaction.step, Step::ReleasePoll));
        assert!(host.mode_vst.path.exists());
        assert_ne!(
            host.mode_vst.status.as_ref().map(|s| s.phase.as_str()),
            Some("completed")
        );
        host.mode_step_response(&mut transaction, silence(false, false))
            .unwrap();
        host.complete_mode_transaction(transaction);
        assert!(!host.mode_vst.path.exists());
    }
    #[test]
    fn monitor_restore_failure_or_stale_ack_never_releases_silence() {
        for failure in ["pending", "failed", "epoch", "revision", "state"] {
            let mut host = host();
            let mut transaction = tx(Step::MonitorWait);
            transaction.rollback = true;
            transaction.journaled = true;
            transaction.silence_ready = true;
            transaction.source.origin_mode = None; // 個別設定中でも自分用の実設定を保持する。
            transaction.source.monitor = Some(split_monitor::State {
                mode: model::Mode::Talk,
                config: Default::default(),
            });
            transaction.monitor_revision = Some("9".into());
            if let IpcResponse::BuiltinEffects(snapshot) = builtin(Default::default(), false) {
                transaction.builtin = Some(snapshot);
            }
            crate::migration::write_json(&host.mode_vst.path, &transaction.source).unwrap();
            assert_eq!(
                read_journal(&host.mode_vst.path).unwrap().monitor,
                transaction.source.monitor
            );
            let IpcResponse::ModeMonitor(mut snapshot) =
                monitor(transaction.source.monitor.clone(), failure == "pending")
            else {
                unreachable!()
            };
            match failure {
                "failed" => snapshot.failed = true,
                "epoch" => snapshot.epoch = "old".into(),
                "revision" => {
                    snapshot.revision = "8".into();
                    snapshot.completed_revision = "8".into();
                }
                "state" => snapshot.state = None,
                _ => {}
            }
            let result =
                host.mode_step_response(&mut transaction, IpcResponse::ModeMonitor(snapshot));
            if failure == "pending" {
                result.unwrap();
                assert!(matches!(transaction.step, Step::MonitorWait));
                assert!(transaction.disk.is_none());
            } else {
                host.fail_mode_transaction(transaction, result.unwrap_err().to_string(), false);
                assert!(host.mode_vst.blocked());
                assert_eq!(
                    host.mode_vst.status.as_ref().unwrap().phase,
                    "recovery_required"
                );
            }
            assert!(host.mode_vst.path.exists());
        }
    }

    #[test]
    fn emergency_mute_and_stop_cancel_pending_receiver_without_waiting() {
        for emergency in [false, true] {
            let mut host = host();
            let mut transaction = tx(Step::Restore(0));
            transaction.journaled = true;
            transaction.pending = Some(Pending {
                receiver: host.pending_reply_tx.begin().unwrap(),
                writer: None,
                sent: Instant::now(),
            });
            host.mode_vst.transaction = Some(transaction);
            let started = Instant::now();
            if emergency {
                host.set_global_mute(true).unwrap();
            } else {
                host.stop().unwrap();
            }
            assert!(started.elapsed() < Duration::from_millis(500));
            assert!(host.is_global_muted && host.mode_vst.blocked());
            assert!(!host.mode_vst.busy());
            assert!(host.child.is_none());
        }
    }
    #[test]
    fn full_fake_ipc_success_empty_rack_and_rollback_restore_every_source_value() {
        for scenario in ["empty", "rack", "rollback", "commit-rollback", "recovery"] {
            let mut host = host();
            host.live_modes.engine_epoch = "engine".into();
            host.is_global_muted = true;
            let mut source_plugin = plugin();
            source_plugin.path = "source.vst3".into();
            source_plugin.state = Some("original-state".into());
            source_plugin.gain = 0.6;
            source_plugin.muted = true;
            source_plugin.enabled = false;
            let source_rack = crate::ipc::RackPlugin {
                id: "source-id".into(),
                path: source_plugin.path.clone(),
                name: source_plugin.name.clone(),
                enabled: source_plugin.enabled,
                muted: source_plugin.muted,
                gain: source_plugin.gain,
            };
            let original = builtin::Config {
                active: true,
                preset: builtin::Preset::Warm,
                ..Default::default()
            };
            let desired = builtin::Config {
                active: true,
                preset: builtin::Preset::Bright,
                ..Default::default()
            };
            let mut transaction = tx(Step::Configure);
            transaction.source.original_mute = true;
            transaction.desired = desired.clone();
            transaction.destination = if scenario == "empty" {
                vec![]
            } else {
                vec![plugin()]
            };
            if scenario == "rollback" {
                let mut second = plugin();
                second.path = "failing.vst3".into();
                transaction.destination.push(second);
            }
            let expected = transaction.destination.clone();
            let mut actual = vec![source_rack.clone()];
            let mut states = std::collections::BTreeMap::from([(
                "source-id".to_string(),
                "original-state".to_string(),
            )]);
            let mut revision = 3u64;
            let mut config = original.clone();
            let mut builtin_revision = 4u64;
            let mut silence_polls = 0;
            let mut release_polls = 0;
            let mut live_polls = 0;
            let mut failed = false;
            let original_monitor = split_monitor::State {
                mode: model::Mode::Talk,
                config: Default::default(),
            };
            let mut monitor_state = Some(original_monitor.clone());
            let journal_path = host.mode_vst.path.clone();
            if scenario == "recovery" {
                crate::migration::write_json(
                    &host.last_config_path.with_file_name("live_output.json"),
                    &crate::audio_engine::live_output::Config {
                        split_processing: true,
                        device_id: Some("fixture".into()),
                        monitor_singing: Some(Default::default()),
                        monitor_talk: Some(Default::default()),
                        ..Default::default()
                    },
                )
                .unwrap();
                transaction.recovery = true;
                transaction.journaled = true;
                transaction.source.plugins = vec![source_plugin.clone()];
                transaction.source.builtin = original.clone();
                transaction.source.monitor = monitor_state.clone();
                transaction.destination = transaction.source.plugins.clone();
                transaction.desired = original.clone();
                transaction.step = Step::ClearRack;
                crate::migration::write_json(&host.mode_vst.path, &transaction.source).unwrap();
                host.mode_vst.blocked = true;
                actual.clear();
                states.clear();
            }
            for tick in 0..100 {
                assert!(tick < 99, "flow failed to finish: {scenario}");
                if let Err(error) = await_disk(&mut host, &mut transaction) {
                    assert!(scenario == "commit-rollback" && !failed);
                    assert_eq!(monitor_state.as_ref().unwrap().mode, model::Mode::Singing);
                    host.mode_vst.path = journal_path.clone();
                    host.fail_mode_transaction(transaction, error.to_string(), false);
                    transaction = host.mode_vst.transaction.take().unwrap();
                    failed = true;
                }
                if matches!(transaction.step, Step::ReleasePoll)
                    && host
                        .mode_vst
                        .status
                        .as_ref()
                        .is_some_and(|s| s.phase == "completed")
                {
                    break;
                }
                let step = transaction.step;
                let response = match host.mode_step_command(&mut transaction).unwrap() {
                    IpcCommand::ConfigureLiveModes { .. } => {
                        let mut snapshot = host.mode_vst_snapshot();
                        snapshot.epoch = "engine".into();
                        snapshot.running = true;
                        snapshot.target = Some(model::Mode::Talk);
                        snapshot.phase = "settled".into();
                        IpcResponse::LiveModes(Box::new(snapshot))
                    }
                    IpcCommand::GetPluginRack => {
                        let mut response = rack(actual.clone(), revision);
                        if let IpcResponse::PluginRack { running, .. } = &mut response {
                            *running = scenario != "recovery";
                        }
                        response
                    }
                    IpcCommand::GetPluginState { id } => IpcResponse::PluginState {
                        state: states[&id].clone(),
                        id,
                    },
                    IpcCommand::ModeSilence { request } => match request {
                        mode_silence::Request::Begin { .. } => {
                            assert!(host.mode_vst.path.exists());
                            assert!(!transaction.silence_ready);
                            silence(true, false)
                        }
                        mode_silence::Request::Snapshot { .. }
                            if matches!(step, Step::SilencePoll) =>
                        {
                            silence_polls += 1;
                            silence(true, silence_polls >= 2)
                        }
                        mode_silence::Request::Finish { .. } => {
                            assert!(transaction.silence_ready);
                            assert_eq!(
                                read_journal(&host.mode_vst.path).unwrap().phase,
                                "committing"
                            );
                            silence(true, false)
                        }
                        _ => {
                            release_polls += 1;
                            silence(release_polls < 2, false)
                        }
                    },
                    IpcCommand::UnloadPlugin { id } => {
                        assert!(transaction.silence_ready || transaction.recovery);
                        actual.retain(|p| p.id != id);
                        states.remove(&id);
                        revision += 1;
                        IpcResponse::Success
                    }
                    IpcCommand::RestorePlugin {
                        request,
                        operation_id,
                        ..
                    } => {
                        assert!(transaction.silence_ready || transaction.recovery);
                        if scenario == "rollback" && !failed && request.path == "failing.vst3" {
                            failed = true;
                            IpcResponse::Error("injected second VST failure".into())
                        } else {
                            let id = format!("restored-{operation_id}");
                            states.insert(id.clone(), request.state.clone().unwrap_or_default());
                            actual.push(crate::ipc::RackPlugin {
                                id: id.clone(),
                                path: request.path,
                                name: "restored".into(),
                                enabled: !request.bypassed,
                                muted: request.muted,
                                gain: request.gain,
                            });
                            revision += 1;
                            IpcResponse::PluginRestored {
                                operation_id,
                                plugin: crate::ipc::RestoredPlugin {
                                    id,
                                    name: "restored".into(),
                                    prepared: scenario != "recovery",
                                },
                            }
                        }
                    }
                    IpcCommand::BuiltinEffects { request } => {
                        if let builtin::Request::Apply { config: next, .. } = request {
                            config = next;
                            builtin_revision += 1;
                        }
                        let mut response = builtin(config.clone(), false);
                        if let IpcResponse::BuiltinEffects(snapshot) = &mut response {
                            snapshot.revision = builtin_revision.to_string();
                            snapshot.applied_revision = builtin_revision.to_string();
                        }
                        response
                    }
                    IpcCommand::ModeMonitor { request } => {
                        if let split_monitor::Request::Restore { state } = request {
                            monitor_state = state;
                        }
                        monitor(monitor_state.clone(), false)
                    }
                    IpcCommand::LiveOutput {
                        config: Some(config),
                    } => IpcResponse::LiveOutput(Box::new(
                        crate::audio_engine::live_output::Status {
                            config,
                            sink: None,
                            error: None,
                            broadcast_epoch: None,
                            monitor: None,
                        },
                    )),
                    IpcCommand::LiveMode { request } => {
                        let mut snapshot = host.mode_vst_snapshot();
                        snapshot.epoch = "engine".into();
                        snapshot.running = true;
                        snapshot.target = transaction.mode;
                        snapshot.revision = "7".into();
                        snapshot.completed_revision = "6".into();
                        snapshot.phase = "transitioning".into();
                        if matches!(step, Step::BuiltinSelect) {
                            monitor_state = Some(split_monitor::State {
                                mode: model::Mode::Singing,
                                config: desired.clone(),
                            });
                        }
                        if matches!(step, Step::ReadLive) {
                            snapshot.phase = "settled".into();
                            snapshot.target = Some(model::Mode::Talk);
                        } else if matches!(request, model::Request::Snapshot) {
                            live_polls += 1;
                            if live_polls >= 2 {
                                snapshot.completed_revision = "7".into();
                                snapshot.applied = transaction.mode;
                                snapshot.phase = "settled".into();
                                if scenario == "commit-rollback" && !failed {
                                    // 元journalは保持し、通常ファイルを親にしてcommit保存だけ失敗させる。
                                    host.mode_vst.path = journal_path.join("unwritable");
                                }
                            }
                        }
                        IpcResponse::LiveModes(Box::new(snapshot))
                    }
                    _ => panic!("unexpected flow command"),
                };
                if let Err(error) = host.mode_step_response(&mut transaction, response) {
                    assert!(scenario == "rollback" && failed, "{scenario}: {error}");
                    host.fail_mode_transaction(transaction, error.to_string(), false);
                    transaction = host.mode_vst.transaction.take().unwrap();
                }
            }
            let restored_source = matches!(scenario, "rollback" | "commit-rollback" | "recovery");
            if restored_source {
                assert_eq!(monitor_state, Some(original_monitor));
            }
            assert!(rack_matches(
                &actual,
                if restored_source {
                    std::slice::from_ref(&source_plugin)
                } else {
                    &expected
                }
            ));
            assert_eq!(config, if restored_source { original } else { desired });
            if restored_source {
                assert_eq!(states.values().next().unwrap(), "original-state");
            } else {
                assert!(live_polls >= 2);
            }
            host.complete_mode_transaction(transaction);
            assert!(!host.mode_vst.path.exists());
            assert!(!host.mode_vst.blocked());
            assert!(host.is_global_muted);
            assert_eq!(
                host.live_modes.target,
                if restored_source {
                    None
                } else {
                    Some(model::Mode::Singing)
                }
            );
            if scenario == "rollback" {
                assert_eq!(host.mode_vst.status.as_ref().unwrap().phase, "failed");
            }
        }
    }
    #[test]
    fn delayed_durable_write_does_not_hold_host_or_resume_canceled_transaction() {
        let mut host = host();
        let mut transaction = tx(Step::SourceBuiltin);
        let (sender, receiver) = std::sync::mpsc::channel();
        transaction.disk = Some(DiskJob {
            receiver,
            kind: DiskKind::Prepare,
        });
        host.mode_vst.transaction = Some(transaction);
        let started = Instant::now();
        host.stop().unwrap();
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(host.mode_vst.blocked());
        assert!(host.mode_vst.orphan_disk.is_some());
        sender.send(Ok(journal())).unwrap();
        host.poll_orphan_mode_disk();
        assert!(!host.mode_vst.busy());
        assert!(host.mode_vst.blocked());
        assert!(host.is_global_muted);
        assert_eq!(
            host.mode_vst.status.as_ref().unwrap().phase,
            "recovery_required"
        );
        assert!(host.child.is_none());
    }
    #[test]
    fn blocked_writer_keeps_early_reply_pending_and_stop_remains_immediate() {
        for emergency in [false, true] {
            let mut host = host();
            host.reader_active.store(true, Ordering::Release);
            host.conditions.lifecycle(true);
            let witness = host.conditions.snapshot().unwrap();
            let mut transaction = tx(Step::Restore(0));
            transaction.journaled = true;
            transaction.condition_pending = Some(host.conditions.begin());
            let (_writer_sender, writer) = std::sync::mpsc::channel();
            transaction.pending = Some(Pending {
                receiver: host.pending_reply_tx.begin().unwrap(),
                writer: Some(writer),
                sent: Instant::now(),
            });
            host.mode_vst.transaction = Some(transaction);
            host.pending_reply_tx.deliver(IpcResponse::Success);
            host.poll_mode_vst();
            assert!(host
                .mode_vst
                .transaction
                .as_ref()
                .unwrap()
                .pending
                .as_ref()
                .unwrap()
                .writer
                .is_some());
            assert!(witness.validate().is_err());
            let started = Instant::now();
            if emergency {
                host.set_global_mute(true).unwrap();
            } else {
                host.stop().unwrap();
            }
            assert!(started.elapsed() < Duration::from_millis(500));
            assert!(host.mode_vst.blocked() && host.is_global_muted);
            assert!(!host.mode_vst.busy() && host.stdin.is_none());
            assert!(host.child.is_none());
        }
    }
    #[cfg(windows)]
    #[test]
    fn actual_full_child_pipe_does_not_block_stop_or_emergency_mute() {
        use std::os::windows::process::CommandExt;
        for emergency in [false, true] {
            let mut host = host();
            // この試験が起動したstdin非読取り子だけを使用し、音声機器・通常設定を開かない。
            let mut child = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ])
                .creation_flags(0x0800_0000)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("create isolated nonreading child");
            host.stdin = Some(BufWriter::new(child.stdin.take().expect("child stdin")));
            host.child = Some(child);
            host.reader_active.store(true, Ordering::Release);
            let mut transaction = tx(Step::Restore(0));
            transaction.journaled = true;
            transaction.pending = Some(
                host.send_mode_command(IpcCommand::RestorePlugin {
                    request: crate::ipc::RestorePluginRequest {
                        path: "non-audio-test.vst3".into(),
                        state: Some("A".repeat(4 * 1024 * 1024)),
                        bypassed: true,
                        muted: true,
                        gain: 1.0,
                    },
                    operation_id: 1,
                    expires_at_ms: u64::MAX,
                })
                .unwrap(),
            );
            host.mode_vst.transaction = Some(transaction);
            let started = Instant::now();
            while !host.mode_vst.writer_serialized.load(Ordering::Acquire) {
                assert!(started.elapsed() < Duration::from_secs(5));
                thread::sleep(Duration::from_millis(1));
            }
            thread::sleep(Duration::from_millis(50));
            assert!(
                !host.mode_vst.writer_finished.load(Ordering::Acquire),
                "payload must exceed the unread anonymous pipe capacity"
            );
            host.poll_mode_vst();
            assert!(host.mode_vst.busy());
            let started = Instant::now();
            if emergency {
                host.set_global_mute(true).unwrap();
            } else {
                host.stop().unwrap();
            }
            assert!(started.elapsed() < Duration::from_secs(2));
            assert!(host.child.is_none() && host.stdin.is_none());
            assert!(host.mode_vst.blocked() && host.is_global_muted);
            let started = Instant::now();
            while !host.mode_vst.writer_finished.load(Ordering::Acquire) {
                assert!(started.elapsed() < Duration::from_secs(2));
                thread::sleep(Duration::from_millis(1));
            }
            assert!(!host.mode_vst.busy());
        }
    }
}
