//! オケの選択はHostの寿命だけ保持する。保存した名前やPIDで再接続しない。
use super::*;
use crate::audio_engine::mixing::{self as model, Config, Source, Start};

pub(super) struct State {
    path: PathBuf,
    raw: Option<Vec<u8>>,
    saved: Option<Config>,
    pub(super) selected: Option<Start>,
    epoch: String,
    revision: u64,
    error: Option<String>,
}
impl State {
    pub(super) fn new(root: &std::path::Path) -> Self {
        let path = root.join("mixing.json");
        let (raw, saved, error) = match read(&path) {
            Ok((raw, saved)) => (raw, saved, None),
            Err(error) => (None, None, Some(error.to_string())),
        };
        Self {
            path,
            raw,
            saved,
            selected: None,
            epoch: crate::bundle::revision(),
            revision: 0,
            error,
        }
    }
    fn unchanged(&self) -> Result<()> {
        anyhow::ensure!(
            self.error.is_none(),
            "ミックスの保存内容を読み直してから、オケを明示選択してください"
        );
        let raw = read_raw(&self.path)?;
        anyhow::ensure!(
            raw == self.raw,
            "ミックスの保存内容が変更されました。停止して読み直してください"
        );
        Ok(())
    }
    fn persist(&mut self, config: Option<&Config>) -> Result<()> {
        self.unchanged()?;
        let bytes = serde_json::to_vec_pretty(&config)?;
        let directory = self
            .path
            .parent()
            .ok_or_else(|| anyhow!("保存先がありません"))?;
        std::fs::create_dir_all(directory)?;
        let temporary = self
            .path
            .with_extension(format!("{}.pending", crate::bundle::revision()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        self.unchanged()?;
        std::fs::rename(&temporary, &self.path)?;
        anyhow::ensure!(
            std::fs::read(&self.path)? == bytes,
            "保存後にミックス設定が変わりました"
        );
        self.raw = Some(bytes);
        self.saved = config.cloned();
        Ok(())
    }
}
fn read(path: &std::path::Path) -> Result<(Option<Vec<u8>>, Option<Config>)> {
    let Some(bytes) = read_raw(path)? else {
        return Ok((None, None));
    };
    let config: Option<Config> = serde_json::from_slice(&bytes)?;
    if let Some(config) = &config {
        config.validate().map_err(anyhow::Error::msg)?;
    }
    Ok((Some(bytes), config))
}
fn read_raw(path: &std::path::Path) -> Result<Option<Vec<u8>>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(65_537).read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= 65_536, "ミックス設定の容量を超えています");
    Ok(Some(bytes))
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Snapshot,
    Configure {
        expected_epoch: String,
        expected_revision: String,
        config: Option<Config>,
        candidate_id: Option<String>,
    },
    Levels {
        expected_epoch: String,
        expected_revision: String,
        levels: model::Levels,
    },
    Reload {
        expected_epoch: String,
        expected_revision: String,
    },
    Reset {
        expected_epoch: String,
        expected_revision: String,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    #[serde(flatten)]
    engine: model::Snapshot,
    saved_config: Option<Config>,
    error: Option<String>,
}

impl AudioHost {
    fn engine_mixing_snapshot(&mut self) -> Result<model::Snapshot> {
        match self.execute_running_command(IpcCommand::Mixing {
            request: model::Request::Snapshot,
        })? {
            IpcResponse::Mixing(snapshot) => Ok(*snapshot),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("ミックスに対応するEngineを起動し直してください")),
        }
    }
    pub(crate) fn mixing(&mut self, request: Request) -> Result<Snapshot> {
        let expected = match &request {
            Request::Snapshot => None,
            Request::Configure {
                expected_epoch,
                expected_revision,
                ..
            }
            | Request::Levels {
                expected_epoch,
                expected_revision,
                ..
            }
            | Request::Reload {
                expected_epoch,
                expected_revision,
            }
            | Request::Reset {
                expected_epoch,
                expected_revision,
            } => Some((expected_epoch, expected_revision)),
        };
        if let Some((epoch, revision)) = expected {
            anyhow::ensure!(
                *epoch == self.mixing.epoch && *revision == self.mixing.revision.to_string(),
                "ミックスの条件が変わりました。現在の設定を読み直してください"
            );
            self.guard_mode_vst()?;
        }
        match request {
            Request::Snapshot => {}
            Request::Reset { .. } => {
                self.preflight_live_changes()?;
                if self.reader_active.load(Ordering::Acquire) {
                    anyhow::ensure!(
                        !self.engine_mixing_snapshot()?.running,
                        "音声を停止してから保存状態を復旧してください"
                    );
                } else if self.child.is_some() {
                    self.kill_engine();
                }
                self.mixing.selected = None;
                self.mixing.error = Some("保存状態の保管を完了できませんでした。停止したまま保存内容を読み直すか、復旧操作をやり直してください".into());
                let raw = read_raw(&self.mixing.path)?;
                let directory = self
                    .mixing
                    .path
                    .parent()
                    .ok_or_else(|| anyhow!("保存先がありません"))?
                    .join("mixing-backups");
                std::fs::create_dir_all(&directory)?;
                let name = format!("reset-{}", crate::bundle::revision());
                if let Some(bytes) = &raw {
                    let original_path = directory.join(format!("{name}.original.json"));
                    let mut original = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&original_path)?;
                    original.write_all(bytes)?;
                    original.sync_all()?;
                    drop(original);
                    anyhow::ensure!(
                        std::fs::read(original_path)? == *bytes,
                        "元のミックス設定を保管できません"
                    );
                }
                let mut marker = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(directory.join(format!("{name}.state.json")))?;
                marker.write_all(&serde_json::to_vec(&serde_json::json!({"version":1,"existed":raw.is_some(),"original":raw.as_ref().map(|_| format!("{name}.original.json"))}))?)?;
                marker.sync_all()?;
                drop(marker);
                if self.reader_active.load(Ordering::Acquire) {
                    self.apply_engine_mixing(None)?;
                }
                let mut reset = State {
                    path: self.mixing.path.clone(),
                    raw,
                    saved: None,
                    selected: None,
                    epoch: self.mixing.epoch.clone(),
                    revision: self
                        .mixing
                        .revision
                        .checked_add(1)
                        .ok_or_else(|| anyhow!("ミックス設定の世代を更新できません"))?,
                    error: None,
                };
                reset.persist(None)?;
                self.mixing = reset;
            }
            Request::Reload { .. } => {
                if self.reader_active.load(Ordering::Acquire) {
                    let snapshot = self.engine_mixing_snapshot()?;
                    anyhow::ensure!(
                        !snapshot.running,
                        "音声を停止してから保存内容を読み直してください"
                    );
                    self.apply_engine_mixing(None)?;
                }
                let (raw, saved) = read(&self.mixing.path)?;
                self.mixing.raw = raw;
                self.mixing.saved = saved;
                self.mixing.error = None;
                self.mixing.selected = None;
                self.mixing.revision = self
                    .mixing
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("ミックス設定の世代を更新できません"))?;
            }
            Request::Configure {
                config,
                candidate_id,
                ..
            } => {
                self.preflight_live_changes()?;
                self.mixing.unchanged()?;
                let next = match config {
                    Some(config) => {
                        config.validate().map_err(anyhow::Error::msg)?;
                        let target = match &config.source {
                            Source::Device(_) => {
                                anyhow::ensure!(
                                    candidate_id.is_none(),
                                    "機器入力にアプリの選択情報は使えません"
                                );
                                None
                            }
                            Source::ProcessLoopback(source) => {
                                let request = crate::input_source::Request {
                                    source: crate::input_source::Config::ProcessLoopback(
                                        source.clone(),
                                    ),
                                    candidate_id,
                                };
                                anyhow::ensure!(
                                    request.candidate_id.is_some(),
                                    "起動中のオケのアプリを明示選択してください"
                                );
                                self.resolve_input_source(Some(request))?
                                    .and_then(|selected| selected.target)
                            }
                        };
                        Some(Start { config, target })
                    }
                    None => {
                        anyhow::ensure!(
                            candidate_id.is_none(),
                            "オケを無効にする場合はアプリの選択情報を外してください"
                        );
                        None
                    }
                };
                self.ensure_engine_running()?;
                self.apply_engine_mixing(next.clone())?;
                if let Err(error) = self
                    .mixing
                    .persist(next.as_ref().map(|start| &start.config))
                {
                    self.mixing.selected = None;
                    self.mixing.error = Some(
                        "ミックス設定を保存できませんでした。保存内容を読み直してください".into(),
                    );
                    return Err(error);
                }
                self.mixing.selected = next;
                self.mixing.revision = self
                    .mixing
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("ミックス設定の世代を更新できません"))?;
            }
            Request::Levels { levels, .. } => {
                levels.validate().map_err(anyhow::Error::msg)?;
                self.mixing.unchanged()?;
                let mut next = self
                    .mixing
                    .selected
                    .clone()
                    .ok_or_else(|| anyhow!("オケの入力元を先に明示選択してください"))?;
                let engine = self.engine_mixing_snapshot()?;
                let response = self.execute_running_command(IpcCommand::Mixing {
                    request: model::Request::Levels {
                        expected_epoch: engine.epoch,
                        expected_revision: engine.revision,
                        levels: levels.clone(),
                    },
                })?;
                match response {
                    IpcResponse::Mixing(_) => {}
                    IpcResponse::Error(error) => return Err(anyhow!(error)),
                    _ => return Err(anyhow!("ミックスの調整結果を確認できません")),
                }
                next.config.levels = levels;
                if let Err(error) = self.mixing.persist(Some(&next.config)) {
                    if self.stop().is_err() {
                        self.kill_engine();
                    }
                    self.mixing.selected = None;
                    self.mixing.error = Some(
                        "ミックス設定を保存できないため停止しました。保存内容を読み直してください"
                            .into(),
                    );
                    return Err(error);
                }
                self.mixing.selected = Some(next);
                self.mixing.revision = self
                    .mixing
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("ミックス設定の世代を更新できません"))?;
            }
        }
        let mut engine = if self.reader_active.load(Ordering::Acquire) {
            self.engine_mixing_snapshot()?
        } else {
            model::Snapshot {
                epoch: String::new(),
                revision: String::new(),
                config: None,
                running: false,
                accompaniment: None,
                voice_peak: [0.0; 2],
                accompaniment_peak: [0.0; 2],
                mix_peak: [0.0; 2],
                known_voice_processing_frames: None,
                pending: false,
                failed: false,
                primary_clock: None,
            }
        };
        engine.epoch = self.mixing.epoch.clone();
        engine.revision = self.mixing.revision.to_string();
        let error = self
            .mixing
            .error
            .clone()
            .or_else(|| self.mixing.unchanged().err().map(|error| error.to_string()));
        Ok(Snapshot {
            engine,
            saved_config: self.mixing.saved.clone(),
            error,
        })
    }
    fn apply_engine_mixing(&mut self, start: Option<Start>) -> Result<()> {
        let current = self.engine_mixing_snapshot()?;
        anyhow::ensure!(
            !current.running,
            "音声を停止してからオケの入力元を変更してください"
        );
        match self.execute_running_command(IpcCommand::Mixing {
            request: model::Request::Configure {
                expected_epoch: current.epoch,
                expected_revision: current.revision,
                start,
            },
        })? {
            IpcResponse::Mixing(_) => Ok(()),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("オケの入力元を反映できません")),
        }
    }
    pub(super) fn validate_mixing_selection(
        &self,
        primary: Option<&crate::input_source::Start>,
    ) -> Result<()> {
        self.mixing.unchanged()?;
        if self.mixing.saved.is_none() {
            return Ok(());
        }
        anyhow::ensure!(
            primary.is_none_or(|primary| primary.source == crate::input_source::Config::default()),
            "二入力の主入力は声用途のマイク機器を選んでください"
        );
        let selected = self
            .mixing
            .selected
            .as_ref()
            .ok_or_else(|| anyhow!("オケの入力元を音声設定で選び直してから開始してください"))?;
        anyhow::ensure!(
            Some(&selected.config) == self.mixing.saved.as_ref(),
            "ミックス設定の保存を完了してください"
        );
        selected.validate().map_err(anyhow::Error::msg)?;
        if let Source::ProcessLoopback(source) = &selected.config.source {
            crate::audio_engine::process_capture::config_validation(
                source,
                selected
                    .target
                    .as_ref()
                    .ok_or_else(|| anyhow!("オケのアプリを選び直してください"))?,
            )?;
        }
        Ok(())
    }
    pub(super) fn prepare_mixing_start(&mut self) -> Result<()> {
        if self.mixing.saved.is_some() {
            let selected = self
                .mixing
                .selected
                .clone()
                .ok_or_else(|| anyhow!("オケの入力元を選び直してください"))?;
            let current = self.engine_mixing_snapshot()?;
            if current.config.as_ref() != Some(&selected.config) {
                self.apply_engine_mixing(Some(selected))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        serde_json::from_value(serde_json::json!({
            "version":1,"source":{"kind":"device","config":{"host":"WASAPI","inputId":"wasapi:fixture","inputChannels":[0,1]}},
            "levels":{"voice":{"gain":0.0,"muted":true},"accompaniment":{"gain":1.0,"muted":false},"monitorAccompaniment":true,"offsetMs":-2000}
        })).unwrap()
    }
    #[test]
    fn saved_mixing_never_starts_from_a_name_and_external_edits_require_explicit_reload() {
        let root =
            std::env::temp_dir().join(format!("auralyn-mix-host-{}", crate::bundle::revision()));
        std::fs::create_dir(&root).unwrap();
        let mut state = State::new(&root);
        state.persist(Some(&config())).unwrap();
        let bytes = std::fs::read(root.join("mixing.json")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("target"));
        let mut host = AudioHost::new(root.clone());
        assert!(host.child.is_none());
        let snapshot = host.mixing(Request::Snapshot).unwrap();
        assert_eq!(snapshot.saved_config.unwrap(), config());
        assert!(snapshot.engine.config.is_none() && !snapshot.engine.running);
        assert!(host.child.is_none());
        assert!(host.validate_mixing_selection(None).is_err());
        std::fs::write(root.join("mixing.json"), b"null").unwrap();
        assert!(host.validate_mixing_selection(None).is_err());
        let epoch = host.mixing.epoch.clone();
        assert!(host
            .mixing(Request::Reload {
                expected_epoch: epoch.clone(),
                expected_revision: "9".into()
            })
            .is_err());
        host.mixing(Request::Reload {
            expected_epoch: epoch,
            expected_revision: "0".into(),
        })
        .unwrap();
        assert!(host.child.is_none());
        host.validate_mixing_selection(None).unwrap();
        std::fs::remove_file(root.join("mixing.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn corrupt_or_pid_bearing_config_is_retained_and_blocks_start_without_spawning() {
        let root =
            std::env::temp_dir().join(format!("auralyn-mix-corrupt-{}", crate::bundle::revision()));
        std::fs::create_dir(&root).unwrap();
        let mut value = serde_json::to_value(config()).unwrap();
        value["target"] = serde_json::json!({"pid":1,"created":1});
        let bytes = serde_json::to_vec(&value).unwrap();
        std::fs::write(root.join("mixing.json"), &bytes).unwrap();
        let mut host = AudioHost::new(root.clone());
        assert!(host.mixing(Request::Snapshot).unwrap().error.is_some());
        assert!(host.validate_mixing_selection(None).is_err());
        assert!(host.child.is_none());
        assert_eq!(std::fs::read(root.join("mixing.json")).unwrap(), bytes);
        host.mixing(Request::Reset {
            expected_epoch: host.mixing.epoch.clone(),
            expected_revision: "0".into(),
        })
        .unwrap();
        assert!(host.child.is_none());
        host.validate_mixing_selection(None).unwrap();
        let backups: Vec<_> = std::fs::read_dir(root.join("mixing-backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        let original = backups
            .iter()
            .find(|path| path.to_string_lossy().ends_with(".original.json"))
            .unwrap();
        assert_eq!(std::fs::read(original).unwrap(), bytes);
        for backup in backups {
            std::fs::remove_file(backup).unwrap();
        }
        std::fs::remove_dir(root.join("mixing-backups")).unwrap();
        std::fs::remove_file(root.join("mixing.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn resetting_absent_file_records_absence_and_old_request_cannot_repeat_the_reset() {
        let root =
            std::env::temp_dir().join(format!("auralyn-mix-absent-{}", crate::bundle::revision()));
        std::fs::create_dir(&root).unwrap();
        let mut host = AudioHost::new(root.clone());
        let epoch = host.mixing.epoch.clone();
        host.mixing(Request::Reset {
            expected_epoch: epoch.clone(),
            expected_revision: "0".into(),
        })
        .unwrap();
        let backups: Vec<_> = std::fs::read_dir(root.join("mixing-backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(backups.len(), 1);
        let marker: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&backups[0]).unwrap()).unwrap();
        assert_eq!(marker["existed"], false);
        assert!(host
            .mixing(Request::Reset {
                expected_epoch: epoch,
                expected_revision: "0".into()
            })
            .is_err());
        assert!(host.child.is_none());
        assert_eq!(std::fs::read(root.join("mixing.json")).unwrap(), b"null");
        std::fs::remove_file(&backups[0]).unwrap();
        std::fs::remove_dir(root.join("mixing-backups")).unwrap();
        std::fs::remove_file(root.join("mixing.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn failed_reset_keeps_original_and_blocks_start_until_explicit_reload() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-mix-reset-fail-{}",
            crate::bundle::revision()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("mixing.json"), b"null").unwrap();
        std::fs::write(root.join("mixing-backups"), b"keep unrelated file").unwrap();
        let mut host = AudioHost::new(root.clone());
        host.validate_mixing_selection(None).unwrap();
        let epoch = host.mixing.epoch.clone();
        assert!(host
            .mixing(Request::Reset {
                expected_epoch: epoch.clone(),
                expected_revision: "0".into()
            })
            .is_err());
        assert!(host.child.is_none());
        assert!(host.validate_mixing_selection(None).is_err());
        assert_eq!(std::fs::read(root.join("mixing.json")).unwrap(), b"null");
        assert_eq!(
            std::fs::read(root.join("mixing-backups")).unwrap(),
            b"keep unrelated file"
        );
        host.mixing(Request::Reload {
            expected_epoch: epoch,
            expected_revision: "0".into(),
        })
        .unwrap();
        host.validate_mixing_selection(None).unwrap();
        std::fs::remove_file(root.join("mixing.json")).unwrap();
        std::fs::remove_file(root.join("mixing-backups")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
