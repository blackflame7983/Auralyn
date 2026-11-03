//! 配信状態の明示復帰だけで本番設定を置換する。本番保護・自動送出は復活させない。
use super::output_bundle::{file_revision, output_file_bytes};
use super::*;
use crate::audio_engine::{
    live_modes::{self as model, Definitions, Mode},
    split_monitor,
};
use crate::bundle::{LiveConfiguration, OutputConfiguration};

impl AudioHost {
    fn read_bundle_mode_status(&mut self) -> Result<model::Snapshot> {
        self.guard_mode_vst()?;
        // Captureは読み取り専用。保存値を同期したり、Engineを起動したりしない。
        match self.execute_running_command(IpcCommand::LiveMode {
            request: model::Request::Snapshot,
        })? {
            IpcResponse::LiveModes(status) => Ok(*status),
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("本番モードの実値を取得できません")),
        }
    }
    fn bundle_mode_status(&mut self) -> Result<model::Snapshot> {
        let mut status = self.read_bundle_mode_status()?;
        anyhow::ensure!(
            status.error.is_none()
                && matches!(status.phase.as_str(), "custom" | "settled" | "stopped"),
            "本番モードの切替完了を待ってください"
        );
        anyhow::ensure!(
            status.target == self.live_modes.target
                && (!status.running || status.applied == status.target),
            "本番モードの選択を確認できません"
        );
        anyhow::ensure!(
            status.definitions == self.live_modes.definitions,
            "実行中とHostの本番設定が異なります"
        );
        status.armed = self.live_modes.armed;
        Ok(status)
    }
    pub(crate) fn capture_bundle_live(
        &mut self,
        output: &OutputConfiguration,
    ) -> Result<(LiveConfiguration, String)> {
        let status = self.bundle_mode_status()?;
        if let Some(error) = &self.live_modes.load_error {
            return Err(anyhow!(error.clone()));
        }
        let path = self.live_modes.path.clone();
        let bytes = output_file_bytes(&path)?;
        let stored = bytes
            .as_ref()
            .map(|b| serde_json::from_slice::<Definitions>(b))
            .transpose()?
            .unwrap_or_default()
            .validate()
            .map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            stored == self.live_modes.definitions,
            "保存済み本番設定が変更されました。内容を確認してください"
        );
        let singing_plugins = self
            .live_modes
            .definitions
            .profiles
            .singing
            .as_ref()
            .map(|b| self.load_bound_plugins(b))
            .transpose()?;
        let talk_plugins = self
            .live_modes
            .definitions
            .profiles
            .talk
            .as_ref()
            .map(|b| self.load_bound_plugins(b))
            .transpose()?;
        let monitor = match self.execute_running_command(IpcCommand::ModeMonitor {
            request: split_monitor::Request::Snapshot,
        })? {
            IpcResponse::ModeMonitor(status) if !status.pending && !status.failed => status.state,
            _ => return Err(anyhow!("自分用処理の反映完了を確認できません")),
        };
        let mut definitions = status.definitions;
        for binding in [
            &mut definitions.profiles.singing,
            &mut definitions.profiles.talk,
        ]
        .into_iter()
        .flatten()
        {
            binding.snapshot = None;
        }
        let value = LiveConfiguration {
            version: 1,
            definitions,
            target: status.target,
            monitor,
            singing_plugins,
            talk_plugins,
        };
        value.validate(output).map_err(anyhow::Error::msg)?;
        Ok((value, file_revision(&bytes)))
    }
    pub(crate) fn with_bundle_live<T>(
        &mut self,
        value: &LiveConfiguration,
        output: &OutputConfiguration,
        expected_revision: &str,
        operation: impl FnOnce(&mut Self) -> std::result::Result<T, String>,
    ) -> std::result::Result<T, String> {
        self.full_snapshot_supported().map_err(|e| e.to_string())?;
        value.validate(output)?;
        if !self.is_global_muted
            || self.bundle_change_generation.is_none()
            || self.bundle_monitor_override.is_some()
        {
            return Err("ミュートして新しい差分を確認してください".into());
        }
        let path = self.live_modes.path.clone();
        let previous = output_file_bytes(&path).map_err(|e| e.to_string())?;
        if file_revision(&previous) != expected_revision {
            return Err("本番設定が変更されました。差分を取り直してください".into());
        }
        let definitions = value.install_profiles(path.parent().ok_or("保存先がありません")?)?;
        self.live_modes.definitions = definitions.clone();
        self.live_modes.target = None;
        self.live_modes.needs_sync = true;
        self.bundle_monitor_override = Some(value.monitor.clone());
        let result = operation(self).and_then(|result| {
            self.validate_bundle_connection()
                .map_err(|e| e.to_string())?;
            if let Some(mode) = value.target {
                let status = self.bundle_mode_status().map_err(|e| e.to_string())?;
                let intent = model::Intent {
                    client_id: "bundle-restore".into(),
                    sequence: 1,
                    expected_epoch: status.epoch,
                };
                let request = match mode {
                    Mode::Singing => model::Request::SingingOn { intent },
                    Mode::Talk => model::Request::TalkOn { intent },
                };
                match self
                    .execute_running_command(IpcCommand::LiveMode { request })
                    .map_err(|e| e.to_string())?
                {
                    IpcResponse::LiveModes(_) => self.live_modes.target = Some(mode),
                    IpcResponse::Error(error) => return Err(error),
                    _ => return Err("本番モードの復帰を要求できません".into()),
                }
            }
            let mut settled = false;
            for _ in 0..100 {
                self.validate_bundle_connection()
                    .map_err(|e| e.to_string())?;
                let status = self.read_bundle_mode_status().map_err(|e| e.to_string())?;
                if status.error.is_some()
                    || status.armed
                    || status.target != value.target
                    || status.definitions != definitions
                    || status.phase == "partial"
                {
                    return Err("本番モードの復帰中に実値が変わりました".into());
                }
                if status.applied == value.target
                    && matches!(status.phase.as_str(), "custom" | "settled")
                {
                    if let IpcResponse::ModeMonitor(status) = self
                        .execute_running_command(IpcCommand::ModeMonitor {
                            request: split_monitor::Request::Snapshot,
                        })
                        .map_err(|e| e.to_string())?
                    {
                        if !status.pending && !status.failed && status.state == value.monitor {
                            settled = true;
                            break;
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if !settled {
                return Err("本番モードと自分用処理の復帰を確認できません".into());
            }
            if output_file_bytes(&path).map_err(|e| e.to_string())? != previous {
                return Err(
                    "適用中に本番設定が変更されました。上書きせず原本を保持しています".into(),
                );
            }
            crate::migration::write_json(&path, &definitions)?;
            let stored: Definitions =
                serde_json::from_slice(&std::fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if stored != definitions {
                return Err("本番設定の読み戻しが一致しません".into());
            }
            Ok(result)
        });
        self.bundle_monitor_override = None;
        if result.is_err() {
            if self.stop().is_err() {
                self.kill_engine();
            }
            // 外部編集は戻さず、停止中のHostも実際の保存内容へ合わせる。
            let reload = output_file_bytes(&path).and_then(|bytes| {
                let definitions = bytes
                    .map(|bytes| serde_json::from_slice::<Definitions>(&bytes))
                    .transpose()?
                    .unwrap_or_default();
                definitions.validate().map_err(anyhow::Error::msg)
            });
            match reload {
                Ok(definitions) => {
                    self.live_modes.definitions = definitions;
                    self.live_modes.load_error = None;
                }
                Err(error) => self.live_modes.load_error = Some(error.to_string()),
            }
            self.live_modes.target = None;
            self.live_modes.needs_sync = true;
        }
        self.notify_conditions_changed();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_intent_invalidates_an_owned_restore_before_waiting_for_the_host_mutex() {
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-mode-interrupt-fixture"));
        host.reader_active.store(true, Ordering::Release);
        let old = host.conditions.control_snapshot().unwrap();
        let conditions = host.conditions.clone();
        let error = host
            .bundle_change_scope(|host| {
                host.validate_bundle_connection().unwrap();
                std::thread::spawn(move || conditions.interrupt_restore())
                    .join()
                    .unwrap();
                host.validate_bundle_connection().map_err(|e| e.to_string())
            })
            .unwrap_err();
        assert!(error.contains("停止・ミュート"));
        assert!(old.validate().is_err());
        assert!(host.bundle_change_generation.is_none());
        assert!(host.bundle_interrupt.is_none());
        assert!(host.child.is_none());
        // 中断は古い操作だけを失効させ、次の明示操作を永久には拒否しない。
        host.bundle_change_scope(|host| {
            host.validate_bundle_connection().map_err(|e| e.to_string())
        })
        .unwrap();
    }
}
