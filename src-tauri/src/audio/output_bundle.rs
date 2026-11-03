//! bundleの再起動中だけ出力指定を保持する。通常の出力変更の予約制限は緩めない。
use super::*;
use crate::audio_engine::live_output::Config;
use sha2::{Digest, Sha256};

pub(super) fn output_file_bytes(path: &std::path::Path) -> Result<Option<Vec<u8>>> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(65_537).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 65_536,
        "出力構成ファイルのサイズ上限を超えています"
    );
    Ok(Some(bytes))
}
pub(super) fn file_revision(bytes: &Option<Vec<u8>>) -> String {
    bytes.as_ref().map_or_else(
        || "absent".into(),
        |bytes| format!("{:x}", Sha256::digest(bytes)),
    )
}
fn persist_output_unchanged(
    path: &std::path::Path,
    before: &Option<Vec<u8>>,
    config: &Config,
) -> std::result::Result<(), String> {
    if output_file_bytes(path).map_err(|e| e.to_string())? != *before {
        return Err(
            "適用中に保存済み出力構成が変更されました。上書きせず原本を保持しています".into(),
        );
    }
    crate::migration::write_json(path, config)?;
    let stored: Config = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if stored != *config {
        return Err("出力構成の読み戻しが一致しません".into());
    }
    Ok(())
}

impl AudioHost {
    pub(crate) fn capture_bundle_output(&mut self, running: bool) -> Result<(Config, String)> {
        let status = match self.execute_running_command(IpcCommand::LiveOutput { config: None })? {
            IpcResponse::LiveOutput(status) => status,
            IpcResponse::Error(error) => return Err(anyhow!(error)),
            _ => return Err(anyhow!("実行中の出力構成を取得できません")),
        };
        status.config.validate()?;
        anyhow::ensure!(
            status.error.is_none() && !status.sink.as_ref().is_some_and(|s| s.failed),
            "配信用出力に異常があります。音声を停止して出力を確認してください"
        );
        anyhow::ensure!(
            !running
                || status.config.device_id.is_none()
                || status.sink.as_ref().is_some_and(|s| s.active),
            "配信用出力の動作を確認できません"
        );
        let path = self.last_config_path.with_file_name("live_output.json");
        let bytes = output_file_bytes(&path)?;
        let stored = bytes
            .as_ref()
            .map(|bytes| serde_json::from_slice::<Config>(bytes))
            .transpose()?
            .unwrap_or_default();
        anyhow::ensure!(
            stored == status.config,
            "実行中と保存済みの出力構成が異なります。設定を確認してください"
        );
        let revision = file_revision(&bytes);
        Ok((status.config, revision))
    }

    pub(crate) fn with_bundle_output<T>(
        &mut self,
        config: &Config,
        expected_revision: &str,
        include_modes: bool,
        operation: impl FnOnce(&mut Self) -> std::result::Result<T, String>,
    ) -> std::result::Result<T, String> {
        config.validate().map_err(|e| e.to_string())?;
        if include_modes {
            self.full_snapshot_supported()
        } else {
            self.output_snapshot_supported()
        }
        .map_err(|e| e.to_string())?;
        let path = self.last_config_path.with_file_name("live_output.json");
        let previous = output_file_bytes(&path).map_err(|e| e.to_string())?;
        if file_revision(&previous) != expected_revision {
            return Err("出力構成が変更されました。差分を取り直してください".into());
        }
        if !self.is_global_muted
            || self.bundle_output_override.is_some()
            || self.bundle_change_generation.is_none()
            || !self.reader_active.load(Ordering::Acquire)
        {
            return Err("分離出力の復帰前に全体ミュートし、差分を取り直してください".into());
        }
        self.bundle_output_override = Some(config.clone());
        let result = operation(self).and_then(|value| {
            // 旧ファイルで実値を上書きするlive_output(None)は使わない。
            let actual = match self
                .execute_running_command(IpcCommand::LiveOutput { config: None })
                .map_err(|e| e.to_string())?
            {
                IpcResponse::LiveOutput(status) => status,
                _ => return Err("復帰後の実出力を取得できません".into()),
            };
            if actual.config != *config
                || actual.error.is_some()
                || actual.sink.as_ref().is_some_and(|s| s.failed)
                || (config.device_id.is_some() && !actual.sink.as_ref().is_some_and(|s| s.active))
            {
                return Err("配信用出力の復帰を確認できません。原本を保持しています".into());
            }
            persist_output_unchanged(&path, &previous, config)?;
            Ok(value)
        });
        self.bundle_output_override = None;
        if result.is_err() {
            // 片枝だけ動作した結果を送出し続けない。自動で旧経路へ代替しない。
            if self.stop().is_err() {
                self.kill_engine();
            }
        }
        self.notify_conditions_changed();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_persistence_keeps_an_external_edit_even_when_the_json_values_match() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-output-external-{}",
            crate::bundle::revision()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("live_output.json");
        let config = Config::default();
        let before = output_file_bytes(&path).unwrap();
        let edited = serde_json::to_string_pretty(&config).unwrap() + "\n";
        std::fs::write(&path, &edited).unwrap();
        assert!(persist_output_unchanged(&path, &before, &config).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
        let latest = output_file_bytes(&path).unwrap();
        let changed = Config {
            monitor_trim: 0.25,
            ..Default::default()
        };
        persist_output_unchanged(&path, &latest, &changed).unwrap();
        let actual: Config = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(actual, changed);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn delayed_gain_initialize_reads_current_value_without_invalidating_an_owned_restore() {
        use crate::audio_engine::auto_gain::{Request, Snapshot};
        use std::os::windows::process::CommandExt;
        let mut host =
            AudioHost::new(std::env::temp_dir().join("auralyn-output-initialize-fixture"));
        let mut child = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "while($null -ne ($line=[Console]::In.ReadLine())){[Console]::Out.WriteLine($line)}"])
            .creation_flags(0x0800_0000).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap();
        host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
        let stdout = child.stdout.take().unwrap();
        host.child = Some(child);
        host.reader_active.store(true, Ordering::Release);
        let slot = host.pending_reply_tx.clone();
        let worker = std::thread::spawn(move || {
            let mut commands = Vec::new();
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                commands.push(serde_json::from_str::<IpcCommand>(&line).unwrap());
                slot.deliver(IpcResponse::AutoGain(Snapshot {
                    revision: 7,
                    gain: 0.25,
                    confirmed_gain: 0.25,
                    settled: true,
                    running: true,
                    stream_failed: false,
                    id: 0,
                    phase: "idle".into(),
                    progress: 0.,
                    proposal: None,
                    playing: false,
                    error: None,
                    devices: vec![],
                    history_id: None,
                    history_epoch: None,
                    history_reason: None,
                    undo_available: false,
                    redo_available: false,
                }));
            }
            commands
        });
        let before = host.conditions.control_snapshot().unwrap();
        host.auto_gain(Request::Initialize { value: 0.25 }).unwrap();
        assert!(before.validate().is_err()); // 初回の実変更は失効する。
        let owned = host.conditions.control_snapshot().unwrap();
        assert_eq!(
            host.auto_gain(Request::Initialize { value: 1. })
                .unwrap()
                .gain,
            0.25
        );
        owned.validate().unwrap(); // 遅い既存値の再送は実値と制御世代を変えない。
        host.kill_engine();
        assert!(!host.output_gain_initialized);
        let commands = worker.join().unwrap();
        assert!(matches!(
            &commands[..],
            [
                IpcCommand::AutoGain {
                    request: Request::Initialize { .. }
                },
                IpcCommand::AutoGain {
                    request: Request::Status
                }
            ]
        ));
    }
    #[test]
    fn failed_output_restore_kills_only_its_connection_when_stop_cannot_be_confirmed() {
        use std::os::windows::process::CommandExt;
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-output-stop-fixture"));
        let mut child = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", "while($null -ne ($line=[Console]::In.ReadLine())){[Console]::Out.WriteLine($line)}"])
            .creation_flags(0x0800_0000).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().unwrap();
        host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
        let stdout = child.stdout.take().unwrap();
        host.child = Some(child);
        host.reader_active.store(true, Ordering::Release);
        host.is_global_muted = true;
        host.bundle_change_generation = Some(host.engine_generation);
        host.bundle_interrupt = Some(host.conditions.restore_interrupt());
        let slot = host.pending_reply_tx.clone();
        let worker = std::thread::spawn(move || {
            let mut stopped = false;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                match serde_json::from_str::<IpcCommand>(&line).unwrap() {
                    IpcCommand::LiveOutput { config: None } => {
                        slot.deliver(IpcResponse::LiveOutput(Box::new(
                            crate::audio_engine::live_output::Status {
                                config: Config::default(),
                                sink: None,
                                error: None,
                                broadcast_epoch: None,
                                monitor: None,
                            },
                        )));
                    }
                    IpcCommand::Stop => {
                        stopped = true;
                        slot.deliver(IpcResponse::Error("owned fixture refuses Stop".into()));
                    }
                    _ => panic!("unexpected fixture command"),
                }
            }
            stopped
        });
        let result: std::result::Result<(), String> =
            host.with_bundle_output(&Config::default(), "absent", false, |_| {
                Err("owned restore failure".into())
            });
        assert_eq!(result.unwrap_err(), "owned restore failure");
        assert!(host.child.is_none());
        assert!(!host.reader_active.load(Ordering::Acquire));
        assert!(host.bundle_output_override.is_none());
        assert!(worker.join().unwrap());
    }
}
