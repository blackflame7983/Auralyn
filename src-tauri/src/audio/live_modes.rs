//! Hostごとの保存・保護状態。app再起動で保護はOFF、engine交代でも解除する。
use super::*;
use crate::audio_engine::live_modes::{
    self as model, Definitions, Mode, Request, Snapshot, StartSpec,
};
struct Reservation {
    token: String,
    planned_restart: bool,
    canceled: bool,
}
pub(super) struct HostModes {
    path: PathBuf,
    definitions: Definitions,
    load_error: Option<String>,
    generation: u64,
    intents: model::Intents,
    epoch: String,
    engine_epoch: String,
    retired: bool,
    reservation: Option<Reservation>,
    next_reservation: u64,
    pub(super) needs_sync: bool,
    armed: bool,
    bound: Option<StartSpec>,
    pub(super) target: Option<Mode>,
}
impl HostModes {
    pub(super) fn new(root: &std::path::Path) -> Self {
        let path = root.join("live_modes.json");
        let read = if path.exists() {
            std::fs::read(&path)
                .map_err(|_| "本番モード設定を読めません".into())
                .and_then(|bytes| {
                    serde_json::from_slice::<Definitions>(&bytes)
                        .map_err(|_| "本番モード保存形式を確認してください".into())
                })
                .and_then(Definitions::validate)
        } else {
            Ok(Definitions::default())
        };
        let (definitions, load_error) = match read {
            Ok(definitions) => (definitions, None),
            Err(error) => (Definitions::default(), Some(error)),
        };
        Self {
            path,
            definitions,
            load_error,
            generation: 0,
            epoch: format!(
                "host-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
            engine_epoch: String::new(),
            retired: false,
            reservation: None,
            next_reservation: 0,
            intents: model::Intents::default(),
            needs_sync: true,
            armed: false,
            bound: None,
            target: None,
        }
    }
}
impl AudioHost {
    fn observe_live_generation(&mut self) {
        if self.live_modes.generation != self.engine_generation {
            if self.live_modes.generation != 0 {
                self.invalidate_live_protection();
            }
            self.live_modes.generation = self.engine_generation;
            self.live_modes.needs_sync = true;
            self.live_modes.retired = false;
            if let Some(reservation) = &mut self.live_modes.reservation {
                reservation.planned_restart = false;
            }
        }
    }
    pub(super) fn sync_live_modes(&mut self) -> Result<()> {
        self.observe_live_generation();
        if !self.live_modes.needs_sync {
            return Ok(());
        }
        match self.execute_running_command(IpcCommand::ConfigureLiveModes {
            definitions: self.live_modes.definitions.clone(),
            armed: self.live_modes.armed,
        })? {
            IpcResponse::LiveModes(snapshot) => {
                self.live_modes.engine_epoch = snapshot.epoch;
            }
            IpcResponse::Error(error) => return Err(anyhow!(error)),
            _ => return Err(anyhow!("本番設定応答が不正です")),
        }
        if let Some(mode) = self.live_modes.target {
            let intent = model::Intent {
                client_id: "host-restore".into(),
                sequence: self.engine_generation,
                expected_epoch: self.live_modes.engine_epoch.clone(),
            };
            let request = match mode {
                Mode::Singing => Request::SingingOn { intent },
                Mode::Talk => Request::TalkOn { intent },
            };
            match self.execute_running_command(IpcCommand::LiveMode { request })? {
                IpcResponse::LiveModes(_) => {}
                IpcResponse::Error(error) => return Err(anyhow!(error)),
                _ => return Err(anyhow!("本番復元応答が不正です")),
            }
        }
        self.live_modes.needs_sync = false;
        Ok(())
    }
    pub(super) fn invalidate_live_protection(&mut self) {
        if self.live_modes.generation != 0 && !self.live_modes.retired {
            self.live_modes.epoch = format!(
                "host-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            self.live_modes.retired = true;
            if let Some(reservation) = &mut self.live_modes.reservation {
                if !reservation.planned_restart {
                    reservation.canceled = true;
                }
            }
            self.live_modes.intents = model::Intents::default();
            if let Some(handle) = self.emitter.lock().unwrap().as_ref() {
                let _ = handle.emit("live-modes-invalidated", ());
            }
        }
        let was_armed = self.live_modes.armed;
        self.live_modes.armed = false;
        self.live_modes.bound = None;
        if was_armed {
            if let Some(handle) = self.emitter.lock().unwrap().as_ref() {
                let _ = handle.emit("live-modes-invalidated", ());
            }
        }
    }
    pub(super) fn guard_live_command(&self, command: &IpcCommand) -> Result<()> {
        model::guard(
            self.live_modes.armed,
            self.live_modes.bound.as_ref(),
            command,
        )
        .map_err(|error| anyhow!(error))
    }
    pub fn preflight_live_changes(&mut self) -> Result<()> {
        if !self.reader_active.load(Ordering::Acquire) {
            self.invalidate_live_protection();
        }
        anyhow::ensure!(!self.live_modes.armed, model::PROTECTED);
        Ok(())
    }
    pub(super) fn preflight_proposal_apply(&self) -> Result<()> {
        anyhow::ensure!(
            self.live_modes.reservation.is_none(),
            "配信状態の復元中です。完了後に提案を作成し直してください"
        );
        Ok(())
    }
    fn bind_live_protection(&mut self) -> Result<()> {
        let active = self
            .active_config
            .as_ref()
            .ok_or_else(|| anyhow!("音声を明示設定で開始してから本番保護を有効にしてください"))?;
        let bound = StartSpec {
            host: active.host.clone(),
            input: active.input.clone(),
            output: active.output.clone(),
            input_id: active.input_id.clone(),
            output_id: active.output_id.clone(),
            rate: active.sample_rate,
            buffer: active.buffer_size,
        };
        anyhow::ensure!(
            bound.concrete(),
            "入出力・レート・バッファを明示選択してから本番保護を有効にしてください"
        );
        self.live_modes.bound = Some(bound);
        Ok(())
    }
    fn guard_live_reservation(&self, request: &Request) -> Result<()> {
        if let Some(reservation) = &self.live_modes.reservation {
            if !matches!(request, Request::Snapshot | Request::Disarm { .. }) {
                anyhow::bail!(if reservation.canceled {
                    "音声世代が変わった前の復元処理の終了待ちです。終了を待つか、終了できない場合はアプリを再起動してください"
                } else {
                    "プリセット／プロファイルの復元中です。完了してから本番モード操作・保護の有効化・定義保存を行ってください"
                });
            }
        }
        Ok(())
    }
    fn preflight_live_intent(&mut self, request: &Request) -> Result<Option<String>> {
        let expected = request.intent().map(|intent| intent.expected_epoch.clone());
        if let Some(intent) = request.intent() {
            anyhow::ensure!(
                intent.expected_epoch == self.live_modes.epoch,
                "古い音声世代の本番操作を拒否しました。現在値を取得してください"
            );
            self.live_modes
                .intents
                .accept(intent)
                .map_err(|error| anyhow!(error))?;
        }
        Ok(expected)
    }
    fn rebase_live_request(&self, request: &mut Request, expected: Option<&str>) -> Result<()> {
        if let Some(expected) = expected {
            anyhow::ensure!(
                expected == self.live_modes.epoch,
                "音声世代が変わったため本番操作を中止しました。現在値を取得してください"
            );
        }
        match request {
            Request::SingingOn { intent }
            | Request::TalkOn { intent }
            | Request::Arm { intent }
            | Request::Disarm { intent } => {
                intent.expected_epoch = self.live_modes.engine_epoch.clone()
            }
            _ => {}
        }
        Ok(())
    }
    pub fn begin_live_changes(&mut self) -> Result<String> {
        self.frontend_bootstrap.cancel();
        self.preflight_live_changes()?;
        anyhow::ensure!(
            self.live_modes.reservation.is_none(),
            "別のプリセット／プロファイル復元が進行中です。完了を待ってください"
        );
        self.live_modes.next_reservation = self
            .live_modes
            .next_reservation
            .checked_add(1)
            .ok_or_else(|| anyhow!("復元予約の上限です"))?;
        let token = format!(
            "{}:batch:{}",
            self.live_modes.epoch, self.live_modes.next_reservation
        );
        self.live_modes.reservation = Some(Reservation {
            token: token.clone(),
            planned_restart: false,
            canceled: false,
        });
        Ok(token)
    }
    pub fn end_live_changes(&mut self, token: String) -> Result<()> {
        if !self.reader_active.load(Ordering::Acquire) {
            self.invalidate_live_protection();
        }
        anyhow::ensure!(
            !token.is_empty()
                && token.len() <= 256
                && self
                    .live_modes
                    .reservation
                    .as_ref()
                    .is_some_and(|reservation| reservation.token == token),
            "復元予約の識別情報が古いか不正です。現在の復元予約は解除していません"
        );
        self.live_modes.reservation = None;
        Ok(())
    }
    // 明示restartは同じ復元batchの一部。fatal/IPC障害のkillでは呼ばない。
    pub(crate) fn preserve_live_changes_for_restart(&mut self) {
        if let Some(reservation) = &mut self.live_modes.reservation {
            reservation.planned_restart = true;
        }
    }
    pub fn live_modes(&mut self, mut request: Request) -> Result<Snapshot> {
        if !self.reader_active.load(Ordering::Acquire) {
            self.invalidate_live_protection();
        }
        self.guard_live_reservation(&request)?;
        let expected = self.preflight_live_intent(&request)?;
        // 初回idle Armはengineを起動する前に明示設定を検証する。
        if matches!(request, Request::Arm { .. }) {
            self.bind_live_protection()?;
        }
        if matches!(request, Request::Disarm { .. }) && !self.reader_active.load(Ordering::Acquire)
        {
            return self.live_modes(Request::Snapshot);
        }
        if matches!(request, Request::Snapshot) && !self.reader_active.load(Ordering::Acquire) {
            return Ok(Snapshot {
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
                armed: false,
                natural_tail: false,
                definitions: self.live_modes.definitions.clone(),
                error: self.live_modes.load_error.clone(),
            });
        }
        if let Some(error) = &self.live_modes.load_error {
            return Err(anyhow!(error.clone()));
        }
        self.ensure_engine_running()?;
        self.sync_live_modes()?;
        self.rebase_live_request(&mut request, expected.as_deref())?;
        if let Request::Save {
            expected_version,
            singing,
            talk,
        } = request
        {
            anyhow::ensure!(
                expected_version == self.live_modes.definitions.version,
                "本番モード設定が変更されました。再取得してください"
            );
            let status = self.live_modes(Request::Snapshot)?;
            anyhow::ensure!(
                !matches!(status.phase.as_str(), "queued" | "transitioning"),
                "切替完了後に保存してください"
            );
            let definitions = Definitions {
                schema_version: 1,
                version: self
                    .live_modes
                    .definitions
                    .version
                    .parse::<u64>()?
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("本番モード保存上限です"))?
                    .to_string(),
                singing,
                talk,
            }
            .validate()
            .map_err(|error| anyhow!(error))?;
            crate::migration::write_json(&self.live_modes.path, &definitions)
                .map_err(|error| anyhow!(error))?;
            self.live_modes.definitions = definitions;
            self.live_modes.target = None;
            self.live_modes.needs_sync = true;
            self.sync_live_modes()?;
            return self.live_modes(Request::Snapshot);
        }
        let selected = match &request {
            Request::SingingOn { .. } => Some(Mode::Singing),
            Request::TalkOn { .. } => Some(Mode::Talk),
            _ => None,
        };
        if let Some(mode) = selected {
            let snapshot = self.live_modes(Request::Snapshot)?;
            if snapshot.target == Some(mode) {
                return Ok(snapshot);
            }
        }
        let response = self.execute_command(IpcCommand::LiveMode { request })?;
        match response {
            IpcResponse::LiveModes(mut snapshot) => {
                self.live_modes.armed = snapshot.armed;
                self.live_modes.target = snapshot.target;
                snapshot.epoch = self.live_modes.epoch.clone();
                Ok(*snapshot)
            }
            IpcResponse::Error(error) => Err(anyhow!(error)),
            _ => Err(anyhow!("本番モード応答が不正です")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn intent(host: &AudioHost, sequence: u64) -> model::Intent {
        model::Intent {
            client_id: "ui-protection".into(),
            sequence,
            expected_epoch: host.live_modes.epoch.clone(),
        }
    }
    #[test]
    fn live_modes_arm_disarm_require_current_epoch_order_and_idle_arm_never_spawns() {
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-live-arm-intent-test"));
        let initial_epoch = host.live_modes(Request::Snapshot).unwrap().epoch;
        let arm = Request::Arm {
            intent: intent(&host, 1),
        };
        let error = host.live_modes(arm).unwrap_err();
        assert!(error.to_string().contains("明示設定"));
        assert!(host.child.is_none());
        assert_eq!(host.live_modes.epoch, initial_epoch);
        let disarm = Request::Disarm {
            intent: intent(&host, 2),
        };
        assert!(!host.live_modes(disarm).unwrap().armed);
        assert!(host.child.is_none());
        let old_sequence = Request::Arm {
            intent: intent(&host, 1),
        };
        assert!(host.live_modes(old_sequence).is_err());
        assert!(host.child.is_none());
        let mut pending = Request::Arm {
            intent: intent(&host, 3),
        };
        let expected = host.preflight_live_intent(&pending).unwrap();
        // 初回ensure: 同じHost epochのまま新Engine epochへ置換する。
        host.engine_generation = 1;
        host.observe_live_generation();
        host.live_modes.engine_epoch = "engine-1".into();
        host.rebase_live_request(&mut pending, expected.as_deref())
            .unwrap();
        assert_eq!(pending.intent().unwrap().expected_epoch, "engine-1");
        let mut pending = Request::Disarm {
            intent: intent(&host, 4),
        };
        let expected = host.preflight_live_intent(&pending).unwrap();
        host.invalidate_live_protection();
        assert!(host
            .rebase_live_request(&mut pending, expected.as_deref())
            .is_err());
        for action in ["arm", "disarm"] {
            assert!(
                serde_json::from_str::<Request>(&format!(r#"{{"action":"{action}"}}"#)).is_err()
            );
            let stale = model::Intent {
                client_id: "late".into(),
                sequence: 99,
                expected_epoch: initial_epoch.clone(),
            };
            let request = if action == "arm" {
                Request::Arm { intent: stale }
            } else {
                Request::Disarm { intent: stale }
            };
            assert!(host.live_modes(request).is_err());
            assert!(host.child.is_none());
        }
    }
    #[test]
    fn remove_plugin_keeps_live_protection_guard_without_sending_or_spawning() {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.live_modes.needs_sync = false;
        host.live_modes.armed = true;
        host.conditions.lifecycle(true);
        let witness = host.conditions.snapshot().unwrap();
        assert!(host.remove_plugin("protected-id").is_err());
        assert!(host.child.is_none());
        assert!(witness.validate().is_ok());
        assert!(host.live_modes.armed);
    }

    #[test]
    fn live_modes_reservation_blocks_interruptions_and_only_exact_token_releases() {
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-live-reservation-test"));
        let token = host.begin_live_changes().unwrap();
        assert!(host.child.is_none());
        assert!(host.begin_live_changes().is_err());
        host.preflight_live_changes().unwrap(); // 自分のprofile preflightはbusyを拒否しない。
        for request in [
            Request::Arm {
                intent: intent(&host, 1),
            },
            Request::SingingOn {
                intent: intent(&host, 2),
            },
            Request::TalkOn {
                intent: intent(&host, 3),
            },
            Request::Save {
                expected_version: "1".into(),
                singing: None,
                talk: None,
            },
        ] {
            assert!(host
                .live_modes(request)
                .unwrap_err()
                .to_string()
                .contains("復元中"));
        }
        host.live_modes(Request::Snapshot).unwrap();
        let disarm = Request::Disarm {
            intent: intent(&host, 4),
        };
        host.live_modes(disarm).unwrap();
        assert!(host.end_live_changes(String::new()).is_err());
        assert!(host.end_live_changes("wrong".into()).is_err());
        assert!(host.live_modes.reservation.is_some());
        assert!(host.child.is_none());
        for command in [IpcCommand::Stop, IpcCommand::SetGlobalMute { active: true }] {
            host.guard_live_command(&command).unwrap();
        }
        host.end_live_changes(token.clone()).unwrap();
        let next = host.begin_live_changes().unwrap();
        assert_ne!(token, next);
        assert!(host.end_live_changes(token).is_err());
        assert!(host.live_modes.reservation.is_some());
        host.end_live_changes(next).unwrap();
    }
    #[test]
    fn live_modes_reservation_survives_initial_ensure_restart_and_fatal_holds_canceled_until_end() {
        let mut host =
            AudioHost::new(std::env::temp_dir().join("auralyn-live-reservation-epoch-test"));
        let token = host.begin_live_changes().unwrap();
        host.engine_generation = 1;
        host.observe_live_generation();
        assert_eq!(host.live_modes.reservation.as_ref().unwrap().token, token);
        host.preserve_live_changes_for_restart();
        host.invalidate_live_protection();
        assert_eq!(host.live_modes.reservation.as_ref().unwrap().token, token);
        host.engine_generation = 2;
        host.observe_live_generation();
        assert_eq!(host.live_modes.reservation.as_ref().unwrap().token, token);
        assert!(
            !host
                .live_modes
                .reservation
                .as_ref()
                .unwrap()
                .planned_restart
        );
        host.invalidate_live_protection();
        assert!(host.live_modes.reservation.as_ref().unwrap().canceled);
        assert!(host.begin_live_changes().is_err());
        assert!(host
            .guard_live_reservation(&Request::Save {
                expected_version: "1".into(),
                singing: None,
                talk: None
            })
            .is_err());
        let arm = Request::Arm {
            intent: intent(&host, 1),
        };
        assert!(host.live_modes(arm).is_err());
        host.end_live_changes(token.clone()).unwrap();
        let next = host.begin_live_changes().unwrap();
        assert!(host.end_live_changes(token).is_err());
        host.end_live_changes(next).unwrap();
        host.reader_active.store(true, Ordering::Release);
        host.live_modes.armed = true;
        assert!(host.begin_live_changes().is_err());
    }
    #[test]
    fn live_modes_idle_snapshot_does_not_spawn_and_fatal_epoch_rejects_old_intent_and_releases_protection(
    ) {
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-live-readonly-test"));
        let first = host.live_modes(Request::Snapshot).unwrap();
        assert!(host.child.is_none());
        assert!(!first.running);
        assert_eq!(
            host.live_modes(Request::Snapshot).unwrap().epoch,
            first.epoch
        );
        host.live_modes.generation = 1;
        host.engine_generation = 1;
        host.live_modes.armed = true;
        host.live_modes.target = Some(Mode::Singing);
        let retired = host.live_modes(Request::Snapshot).unwrap();
        assert_ne!(retired.epoch, first.epoch);
        assert!(!retired.armed);
        assert_eq!(retired.target, Some(Mode::Singing));
        assert_eq!(
            host.live_modes(Request::Snapshot).unwrap().epoch,
            retired.epoch
        );
        assert!(host
            .live_modes(Request::TalkOn {
                intent: model::Intent {
                    client_id: "ui".into(),
                    sequence: 99,
                    expected_epoch: first.epoch
                }
            })
            .is_err());
        assert!(host.child.is_none());
        host.preflight_live_changes().unwrap();
    }
    #[test]
    fn live_modes_protected_profile_preflight_happens_before_backup_or_any_ipc() {
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-live-readonly-preflight"));
        host.reader_active.store(true, Ordering::Release);
        host.live_modes.armed = true;
        let profile: crate::vst_host::presets::Preset =
            serde_json::from_str(r#"{"name":"profile","plugins":[]}"#).unwrap();
        let root = std::env::temp_dir().join("auralyn-live-no-write-should-be-created");
        let error = crate::profile::apply_profile(
            &root,
            &mut host,
            &profile,
            None,
            false,
            vec![],
            None,
            &[],
        )
        .unwrap_err();
        assert!(error.contains("本番保護"));
        assert!(host.child.is_none());
        assert!(!root.exists());
    }
    #[test]
    fn proposal_apply_is_existing_only_reservation_guarded_and_retains_fatal_cleanup() {
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-proposal-host-test"));
        let make = || crate::audio_engine::builtin::Request::ApplyProposal {
            epoch: "old".into(),
            expected_revision: "1".into(),
            proposal_id: "candidate-1-1".into(),
            recording_id: 1,
        };
        assert!(host.builtin_effects(make()).is_err());
        assert!(host.child.is_none());
        let token = host.begin_live_changes().unwrap();
        assert!(host.preflight_proposal_apply().is_err());
        assert!(host.builtin_effects(make()).is_err());
        assert!(host.child.is_none());
        host.end_live_changes(token).unwrap();
        host.live_modes.armed = true;
        assert!(host.preflight_proposal_apply().is_ok());
        assert!(host.live_modes.armed); // 提案のpreflight自体は保護を解除しない。
        assert!(host.builtin_effects(make()).is_err());
        assert!(host.child.is_none());
        assert!(!host.live_modes.armed); // 既存engine不在の確実終了回収は従来どおり失効する。
    }
}
