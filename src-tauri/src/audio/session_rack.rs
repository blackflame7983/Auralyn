//! 再読み込みでも既存ラックを二重ロードしない。予約は各短いHost操作の間だけ保持する。
use super::*;
use crate::ipc::{SessionRackReply as Reply, SessionRackRequest as Request};
use std::time::{Duration, Instant};

pub(super) struct Lease {
    token: String,
    generation: u64,
    ids: Vec<String>,
    revision: u64,
    expires: Instant,
}
impl AudioHost {
    fn session_lease_current(&self, token: &str) -> bool {
        self.session_restore.as_ref().is_some_and(|lease| {
            lease.token == token
                && lease.generation == self.engine_generation
                && Instant::now() < lease.expires
                && self.child.is_some()
                && self.reader_active.load(Ordering::Acquire)
        })
    }
    fn read_session_rack(&mut self) -> Result<Reply> {
        let generation = self.engine_generation;
        if self.child.is_none() {
            return Ok(Reply::Snapshot {
                generation: generation.to_string(),
                revision: "0".into(),
                present: false,
                running: false,
                restore_eligible: !self.frontend_bootstrap.session_claimed
                    && self.session_restore_generation != Some(generation),
                plugins: Vec::new(),
            });
        }
        match self.execute_running_command(IpcCommand::GetPluginRack)? {
            IpcResponse::PluginRack {
                plugins,
                restore_eligible,
                revision,
                running,
            } if generation == self.engine_generation
                && self.reader_active.load(Ordering::Acquire) =>
            {
                if !plugins.is_empty() {
                    self.frontend_bootstrap.session_claimed = true;
                }
                Ok(Reply::Snapshot {
                    generation: generation.to_string(),
                    revision: revision.to_string(),
                    present: true,
                    running,
                    restore_eligible: restore_eligible
                        && !self.frontend_bootstrap.session_claimed
                        && self.session_restore_generation != Some(generation),
                    plugins,
                })
            }
            IpcResponse::RackBusy => Ok(Reply::Busy),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Ok(Reply::Conflict),
        }
    }
    pub fn session_rack(&mut self, request: Request) -> Result<Reply> {
        // 期限切れtokenのFinishは新しい予約を解除しない。
        if self.session_restore.as_ref().is_some_and(|lease| {
            Instant::now() >= lease.expires || lease.generation != self.engine_generation
        }) {
            self.session_restore = None;
        }
        match request {
            Request::Retain {
                generation,
                revision,
                ids,
                input_gain,
            } => {
                if self.session_restore.is_some() {
                    return Ok(Reply::Busy);
                }
                if generation != self.engine_generation.to_string() {
                    return Ok(Reply::Conflict);
                }
                let Reply::Snapshot {
                    plugins,
                    revision: actual_revision,
                    restore_eligible,
                    running,
                    ..
                } = self.read_session_rack()?
                else {
                    return Ok(Reply::Conflict);
                };
                if revision != actual_revision
                    || !plugins.iter().map(|plugin| &plugin.id).eq(ids.iter())
                {
                    return Ok(Reply::Conflict);
                }
                if plugins.is_empty()
                    && restore_eligible
                    && running
                    && self.frontend_bootstrap.input_gain.is_none()
                {
                    if let Some(value) = input_gain {
                        anyhow::ensure!(
                            value.is_finite() && (0.0..=2.0).contains(&value),
                            "保存された入力音量が不正です"
                        );
                        let command = IpcCommand::SetInputGain { value };
                        self.sync_live_modes()?;
                        self.guard_live_command(&command)?;
                        if !matches!(self.execute_running_command(command)?, IpcResponse::Success) {
                            return Ok(Reply::Conflict);
                        }
                        self.frontend_bootstrap.input_gain = Some(value);
                        if generation != self.engine_generation.to_string() {
                            return Ok(Reply::Conflict);
                        }
                    }
                }
                self.session_restore_generation = Some(self.engine_generation);
                self.frontend_bootstrap.session_claimed = true;
                Ok(Reply::Finished)
            }
            Request::Snapshot => {
                if self.session_restore.is_some() {
                    return Ok(Reply::Busy);
                }
                self.read_session_rack()
            }
            Request::Begin {
                generation,
                revision,
                ids,
                input_gain,
                output_gain,
                explicit,
            } => {
                if self.session_restore.is_some() {
                    return Ok(Reply::Busy);
                }
                if generation != self.engine_generation.to_string() || !ids.is_empty() {
                    return Ok(Reply::Conflict);
                }
                anyhow::ensure!(
                    [input_gain, output_gain]
                        .iter()
                        .all(|v| v.is_finite() && (0.0..=2.0).contains(v)),
                    "保存された音量が不正です"
                );
                if !matches!(self.read_session_rack()?, Reply::Snapshot { plugins, restore_eligible, revision: current, .. } if revision == current && plugins.is_empty() && (explicit || restore_eligible))
                {
                    return Ok(Reply::Conflict);
                }
                // 不在からの起動は明示Beginだけ。以後の設定・追加ではensureを呼ばない。
                if self.child.is_none() {
                    self.ensure_engine_running()?;
                }
                let generation = self.engine_generation;
                let revision = revision
                    .parse::<u64>()
                    .map_err(|_| anyhow!("ラックrevisionが不正です"))?;
                self.session_restore_generation = Some(generation);
                self.frontend_bootstrap.session_claimed = true;
                self.sync_live_modes()?;
                for command in [
                    IpcCommand::SetInputGain { value: input_gain },
                    IpcCommand::SetOutputGain { value: output_gain },
                ] {
                    if !explicit
                        && matches!(&command, IpcCommand::SetInputGain { .. })
                        && self.frontend_bootstrap.input_gain.is_some()
                    {
                        continue;
                    }
                    if !explicit
                        && matches!(&command, IpcCommand::SetOutputGain { .. })
                        && self.frontend_bootstrap.output_gain.is_some()
                    {
                        continue;
                    }
                    if generation != self.engine_generation {
                        return Ok(Reply::Conflict);
                    }
                    self.guard_live_command(&command)?;
                    let input = if let IpcCommand::SetInputGain { value } = &command {
                        Some(*value)
                    } else {
                        None
                    };
                    let output = if let IpcCommand::SetOutputGain { value } = &command {
                        Some(*value)
                    } else {
                        None
                    };
                    match self.execute_running_command(command)? {
                        IpcResponse::Success => {}
                        IpcResponse::Error(error) => return Err(anyhow!(error)),
                        _ => return Ok(Reply::Conflict),
                    }
                    if let Some(value) = input {
                        self.frontend_bootstrap.input_gain = Some(value);
                    }
                    if let Some(value) = output {
                        self.frontend_bootstrap.output_gain = Some(value);
                    }
                }
                if generation != self.engine_generation
                    || !self.reader_active.load(Ordering::Acquire)
                {
                    return Ok(Reply::Conflict);
                }
                self.next_restore_operation = self
                    .next_restore_operation
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("復元操作IDの上限です"))?;
                let token = format!("session-{}-{}", generation, self.next_restore_operation);
                self.session_restore = Some(Lease {
                    token: token.clone(),
                    generation,
                    ids: Vec::new(),
                    revision,
                    expires: Instant::now() + Duration::from_secs(30),
                });
                Ok(Reply::Ready {
                    token,
                    generation: generation.to_string(),
                })
            }
            Request::Add { token, request } => {
                if !self.session_lease_current(&token) {
                    return Ok(Reply::Conflict);
                }
                request.validate().map_err(|error| anyhow!(error))?;
                let ids = self
                    .session_restore
                    .as_ref()
                    .expect("検証済み予約")
                    .ids
                    .clone();
                if ids.len() >= crate::audio_engine::plugins::MAX_PLUGINS {
                    return Ok(Reply::Conflict);
                }
                self.next_restore_operation = self
                    .next_restore_operation
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("復元操作IDの上限です"))?;
                let operation_id = self.next_restore_operation;
                let command = IpcCommand::RestoreSessionPlugin {
                    expected_revision: self
                        .session_restore
                        .as_ref()
                        .expect("検証済み予約")
                        .revision,
                    expected_ids: ids,
                    request,
                    operation_id,
                    expires_at_ms: crate::audio_engine::restoration::unix_ms()
                        .saturating_add(8_000),
                };
                self.sync_live_modes()?;
                self.guard_live_command(&command)?;
                let response = self.execute_running_command(command)?;
                if !self.session_lease_current(&token) {
                    return Ok(Reply::Conflict);
                }
                if matches!(
                    &response,
                    IpcResponse::PluginRestored { .. } | IpcResponse::Error(_)
                ) {
                    let lease = self.session_restore.as_mut().expect("検証済み予約");
                    lease.revision = lease
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| anyhow!("ラックrevisionの上限です"))?;
                }
                match response {
                    IpcResponse::PluginRestored {
                        operation_id: returned,
                        plugin,
                    } if returned == operation_id => {
                        let lease = self.session_restore.as_mut().expect("検証済み予約");
                        lease.ids.push(plugin.id.clone());
                        lease.expires = Instant::now() + Duration::from_secs(30);
                        Ok(Reply::Restored { plugin })
                    }
                    IpcResponse::Error(message) => Ok(Reply::Failed { message }),
                    _ => Ok(Reply::Conflict),
                }
            }
            Request::Finish { token } => {
                if !self.session_lease_current(&token) {
                    return Ok(Reply::Conflict);
                }
                let ids = self
                    .session_restore
                    .as_ref()
                    .expect("検証済み予約")
                    .ids
                    .clone();
                let expected_revision = self
                    .session_restore
                    .as_ref()
                    .expect("検証済み予約")
                    .revision;
                let unchanged = matches!(self.read_session_rack()?, Reply::Snapshot { plugins, revision, .. }
                    if revision == expected_revision.to_string() && plugins.iter().map(|plugin| &plugin.id).eq(ids.iter()));
                self.session_restore = None;
                Ok(if unchanged {
                    Reply::Finished
                } else {
                    Reply::Conflict
                })
            }
        }
    }
}

#[cfg(test)]
pub(in crate::audio) mod tests {
    use super::*;
    fn plugin(id: &str) -> crate::ipc::RackPlugin {
        crate::ipc::RackPlugin {
            id: id.into(),
            path: "same.vst3".into(),
            name: id.into(),
            enabled: true,
            muted: false,
            gain: 1.0,
        }
    }
    #[cfg(windows)]
    pub(in crate::audio) fn with_host(
        mut reply: impl FnMut(IpcCommand) -> IpcResponse + Send + 'static,
        body: impl FnOnce(&mut AudioHost, &Arc<Mutex<Vec<IpcCommand>>>),
    ) {
        use std::os::windows::process::CommandExt;
        let mut host = AudioHost::new(std::env::temp_dir());
        let mut child = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command",
            "while($null -ne ($line=[Console]::In.ReadLine())) { [Console]::Out.WriteLine($line) }"])
            .creation_flags(0x0800_0000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
        let stdout = child.stdout.take().unwrap();
        host.child = Some(child);
        host.reader_active.store(true, Ordering::Release);
        host.live_modes.needs_sync = false;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let slot = host.pending_reply_tx.clone();
        let worker = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                let command: IpcCommand = serde_json::from_str(&line).unwrap();
                observed.lock().unwrap().push(command.clone());
                slot.deliver(reply(command));
            }
        });
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&mut host, &calls)));
        host.kill_engine();
        worker.join().unwrap();
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }
    #[test]
    fn session_rack_cold_reads_and_stale_tokens_never_spawn_and_empty_retain_survives_reload() {
        let mut host = AudioHost::new(std::env::temp_dir());
        assert!(matches!(
            host.session_rack(Request::Snapshot).unwrap(),
            Reply::Snapshot {
                present: false,
                restore_eligible: true,
                running: false,
                ..
            }
        ));
        assert!(matches!(
            host.session_rack(Request::Retain {
                input_gain: None,
                generation: "0".into(),
                revision: "0".into(),
                ids: vec![]
            })
            .unwrap(),
            Reply::Finished
        ));
        assert!(matches!(
            host.session_rack(Request::Snapshot).unwrap(),
            Reply::Snapshot {
                restore_eligible: false,
                running: false,
                ..
            }
        ));
        assert!(matches!(
            host.session_rack(Request::Begin {
                generation: "stale".into(),
                revision: "0".into(),
                ids: vec![],
                input_gain: 1.,
                output_gain: 1.,
                explicit: false
            })
            .unwrap(),
            Reply::Conflict
        ));
        assert!(matches!(
            host.session_rack(Request::Finish {
                token: "old".into()
            })
            .unwrap(),
            Reply::Conflict
        ));
        assert!(host.child.is_none());
        assert_eq!(host.engine_generation, 0);
    }
    #[cfg(windows)]
    #[test]
    fn session_rack_existing_metadata_is_read_only_and_nonempty_cas_rejects_before_gain_or_add() {
        with_host(
            |command| match command {
                IpcCommand::GetPluginRack => IpcResponse::PluginRack {
                    plugins: vec![plugin("a"), plugin("b")],
                    restore_eligible: false,
                    revision: 0,
                    running: false,
                },
                _ => panic!("read以外は禁止"),
            },
            |host, calls| {
                host.conditions.lifecycle(true);
                let witness = host.conditions.snapshot().unwrap();
                let Reply::Snapshot {
                    plugins,
                    generation,
                    ..
                } = host.session_rack(Request::Snapshot).unwrap()
                else {
                    panic!("snapshot")
                };
                assert_eq!(
                    plugins.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
                    ["a", "b"]
                );
                assert_eq!(plugins[0].path, plugins[1].path);
                assert!(witness.validate().is_ok());
                assert!(matches!(
                    host.session_rack(Request::Begin {
                        generation,
                        revision: "0".into(),
                        ids: vec![],
                        input_gain: 0.,
                        output_gain: 0.,
                        explicit: false
                    })
                    .unwrap(),
                    Reply::Conflict
                ));
                assert_eq!(calls.lock().unwrap().len(), 2);
                assert!(calls
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|c| matches!(c, IpcCommand::GetPluginRack)));
            },
        );
    }
    #[cfg(windows)]
    #[test]
    fn session_rack_two_pages_and_stale_finish_cannot_release_new_lease_or_respawn_after_generation_change(
    ) {
        with_host(
            |command| match command {
                IpcCommand::GetPluginRack => IpcResponse::PluginRack {
                    plugins: vec![],
                    restore_eligible: true,
                    revision: 0,
                    running: false,
                },
                IpcCommand::SetInputGain { .. } | IpcCommand::SetOutputGain { .. } => {
                    IpcResponse::Success
                }
                _ => panic!("世代失効後に追加IPCを送信しました"),
            },
            |host, calls| {
                let begin = || Request::Begin {
                    generation: "0".into(),
                    revision: "0".into(),
                    ids: vec![],
                    input_gain: 0.3,
                    output_gain: 0.,
                    explicit: true,
                };
                let Reply::Ready { token, .. } = host.session_rack(begin()).unwrap() else {
                    panic!("ready")
                };
                assert!(matches!(host.session_rack(begin()).unwrap(), Reply::Busy));
                assert!(matches!(
                    host.session_rack(Request::Finish {
                        token: "other".into()
                    })
                    .unwrap(),
                    Reply::Conflict
                ));
                assert!(host.session_lease_current(&token));
                assert!(matches!(
                    host.session_rack(Request::Finish {
                        token: token.clone()
                    })
                    .unwrap(),
                    Reply::Finished
                ));
                let Reply::Ready { token: next, .. } = host.session_rack(begin()).unwrap() else {
                    panic!("new ready")
                };
                assert!(matches!(
                    host.session_rack(Request::Finish { token }).unwrap(),
                    Reply::Conflict
                ));
                assert!(host.session_lease_current(&next));
                let before = calls.lock().unwrap().len();
                host.engine_generation += 1;
                assert!(matches!(
                    host.session_rack(Request::Add {
                        token: next,
                        request: crate::ipc::RestorePluginRequest {
                            path: "never.vst3".into(),
                            state: None,
                            bypassed: false,
                            muted: false,
                            gain: 1.
                        }
                    })
                    .unwrap(),
                    Reply::Conflict
                ));
                assert_eq!(calls.lock().unwrap().len(), before);
            },
        );
    }
    #[cfg(windows)]
    #[test]
    fn session_rack_reader_failure_is_not_an_empty_rack_and_never_restarts_child() {
        with_host(
            |_| panic!("停止readerには送信禁止"),
            |host, calls| {
                let pid = host.child.as_ref().unwrap().id();
                host.reader_active.store(false, Ordering::Release);
                assert!(host.session_rack(Request::Snapshot).is_err());
                assert_eq!(host.child.as_ref().unwrap().id(), pid);
                assert!(calls.lock().unwrap().is_empty());
            },
        );
    }
}

#[cfg(all(test, windows))]
mod revision_tests {
    use super::tests::with_host;
    use super::*;
    #[test]
    fn session_rack_snapshot_begin_and_finish_reject_empty_aba_without_gain_or_restore() {
        use std::sync::atomic::AtomicU64;
        for phase in ["begin", "add", "finish"] {
            let revision = Arc::new(AtomicU64::new(0));
            let observed = revision.clone();
            with_host(
                move |command| match command {
                    IpcCommand::GetPluginRack => IpcResponse::PluginRack {
                        plugins: vec![],
                        restore_eligible: true,
                        revision: observed.load(Ordering::Acquire),
                        running: false,
                    },
                    IpcCommand::SetInputGain { .. } | IpcCommand::SetOutputGain { .. } => {
                        IpcResponse::Success
                    }
                    IpcCommand::RestoreSessionPlugin {
                        expected_revision, ..
                    } => {
                        assert_ne!(expected_revision, observed.load(Ordering::Acquire));
                        IpcResponse::RackConflict
                    }
                    _ => panic!("unexpected IPC"),
                },
                |host, calls| {
                    let Reply::Snapshot {
                        generation,
                        revision: base,
                        ..
                    } = host.session_rack(Request::Snapshot).unwrap()
                    else {
                        panic!("snapshot")
                    };
                    if phase == "begin" {
                        revision.store(2, Ordering::Release);
                    }
                    let begun = host
                        .session_rack(Request::Begin {
                            generation,
                            revision: base,
                            ids: vec![],
                            input_gain: 0.4,
                            output_gain: 0.,
                            explicit: false,
                        })
                        .unwrap();
                    if phase == "begin" {
                        assert!(matches!(begun, Reply::Conflict));
                        assert!(calls
                            .lock()
                            .unwrap()
                            .iter()
                            .all(|command| matches!(command, IpcCommand::GetPluginRack)));
                        return;
                    }
                    let Reply::Ready { token, .. } = begun else {
                        panic!("ready")
                    };
                    revision.store(2, Ordering::Release); // Load→最後Unloadでordered IDsは再び空。
                    let response = if phase == "add" {
                        host.session_rack(Request::Add {
                            token,
                            request: crate::ipc::RestorePluginRequest {
                                path: "never.vst3".into(),
                                state: None,
                                bypassed: false,
                                muted: false,
                                gain: 1.,
                            },
                        })
                        .unwrap()
                    } else {
                        host.session_rack(Request::Finish { token }).unwrap()
                    };
                    assert!(matches!(response, Reply::Conflict));
                    assert!(!calls.lock().unwrap().iter().any(|command| matches!(
                        command,
                        IpcCommand::RestorePlugin { .. } | IpcCommand::LoadPlugin { .. }
                    )));
                },
            );
        }
    }
    #[test]
    fn session_rack_retain_applies_saved_input_only_to_initial_running_empty_stream() {
        for running in [false, true] {
            with_host(
                move |command| match command {
                    IpcCommand::GetPluginRack => IpcResponse::PluginRack {
                        plugins: vec![],
                        restore_eligible: true,
                        revision: 0,
                        running,
                    },
                    IpcCommand::SetInputGain { value } => {
                        assert!(running);
                        assert_eq!(value, 0.3);
                        IpcResponse::Success
                    }
                    _ => panic!("unexpected mutation or spawn"),
                },
                |host, calls| {
                    let pid = host.child.as_ref().unwrap().id();
                    for _ in 0..2 {
                        assert!(matches!(
                            host.session_rack(Request::Retain {
                                generation: "0".into(),
                                revision: "0".into(),
                                ids: vec![],
                                input_gain: Some(0.3)
                            })
                            .unwrap(),
                            Reply::Finished
                        ));
                    }
                    assert_eq!(
                        calls
                            .lock()
                            .unwrap()
                            .iter()
                            .filter(|command| matches!(command, IpcCommand::SetInputGain { .. }))
                            .count(),
                        usize::from(running)
                    );
                    assert_eq!(host.child.as_ref().unwrap().id(), pid);
                },
            );
        }
    }
}
