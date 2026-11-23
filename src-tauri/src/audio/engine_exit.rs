//! Hostの直列IPCから、終了直前の操作と機器の開始直後を伝える。
use crate::ipc::{Command, Response};
use serde::Serialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const DEVICE_OPEN_SETTLING: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExitPayload {
    cause: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    op: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<&'static str>,
}

struct InFlight {
    details: ExitPayload,
    started_at: Instant,
    /// writer が書き込みを始めたか。書き込んでいない操作は、終了の原因にしない。
    sent: bool,
}

/// 接続の操作の記録。`LinkCell` のロックの下でだけ読み書きする。
#[derive(Default)]
pub(super) struct OperationLog {
    in_flight: Option<InFlight>,
    awaiting: Option<ExitPayload>,
    settling: Option<InFlight>,
    plugins: HashMap<String, ExitPayload>,
    /// 登録した操作が `Stop` で、まだ書き込みを始めていない。
    stop_registered: bool,
}

impl OperationLog {
    pub(super) fn begin_untracked(&mut self) {
        self.stop_registered = false;
    }

    pub(super) fn begin(&mut self, command: &Command, now: Instant) {
        let state = self;
        state.stop_registered = matches!(command, Command::Stop);
        if let Command::Start {
            host,
            input,
            output,
            ..
        } = command
        {
            let details = ExitPayload {
                cause: "device_open",
                host: Some(host.clone()),
                input: input.clone(),
                output: output.clone(),
                phase: Some("opening"),
                ..Default::default()
            };
            state.awaiting = Some(details.clone());
            state.in_flight = Some(InFlight {
                details,
                started_at: now,
                sent: false,
            });
            return;
        }
        let (op, id, path, class_id) = match command {
            Command::LoadPlugin { path, class_id } => {
                ("load", None, Some(path.clone()), class_id.clone())
            }
            Command::RestorePlugin { request, .. }
            | Command::RestoreSessionPlugin { request, .. } => (
                "restore",
                None,
                Some(request.path.clone()),
                request.class_id.clone(),
            ),
            Command::GetPluginState { id } => ("get_state", Some(id), None, None),
            Command::SetPluginState { id, .. } => ("set_state", Some(id), None, None),
            Command::OpenEditor { id } => ("open_editor", Some(id), None, None),
            Command::UnloadPlugin { id } => ("remove", Some(id), None, None),
            Command::ResumePlugin { id } => ("resume", Some(id), None, None),
            // 複数VSTを扱う要求では、特定の1件を原因と推測しない。
            Command::CaptureBundleState | Command::CaptureMixingBundleState
                if !state.plugins.is_empty() =>
            {
                ("get_state", None, None, None)
            }
            Command::PostMixStart { .. } if !state.plugins.is_empty() => {
                ("processing_setup", None, None, None)
            }
            _ => {
                state.in_flight = None;
                state.awaiting = None;
                return;
            }
        };
        let mut details = id
            .and_then(|id| state.plugins.get(id))
            .cloned()
            .unwrap_or_default();
        details.cause = "vst_operation";
        details.op = Some(op);
        if let Some(id) = id {
            details.plugin_id = Some(id.clone());
        }
        if path.is_some() {
            details.path = path;
            details.class_id = class_id;
        }
        state.awaiting = Some(details.clone());
        state.in_flight = Some(InFlight {
            details,
            started_at: now,
            sent: false,
        });
    }

    /// 書き込みを始めた。利用者が止めた後の終了を、開始直後の障害と取り違えない。
    pub(super) fn mark_sent(&mut self) {
        if let Some(pending) = self.in_flight.as_mut() {
            pending.sent = true;
        }
        if std::mem::take(&mut self.stop_registered) {
            self.settling = None;
        }
    }

    /// 応答を待たずに、操作を打ち切る（書き込みの失敗）。
    pub(super) fn abandon(&mut self) {
        self.in_flight = None;
        self.awaiting = None;
        self.stop_registered = false;
    }

    pub(super) fn response(&mut self, response: &Response, now: Instant) {
        let state = self;
        state.stop_registered = false;
        state.in_flight = None;
        let Some(mut details) = state.awaiting.take() else {
            return;
        };
        if details.cause == "device_open" {
            if matches!(response, Response::Started { .. }) {
                details.phase = Some("settling");
                state.settling = Some(InFlight {
                    details,
                    started_at: now,
                    sent: true,
                });
            }
            return;
        }
        let loaded = match response {
            Response::PluginLoaded {
                id, name, class_id, ..
            } => Some((id, name, class_id)),
            Response::PluginRestored { plugin, .. } => {
                Some((&plugin.id, &plugin.name, &plugin.class_id))
            }
            _ => None,
        };
        if let Some((id, name, class_id)) = loaded {
            details.plugin_id = Some(id.clone());
            details.name = Some(name.clone());
            details.class_id = class_id.clone().or(details.class_id);
            state.plugins.insert(id.clone(), details);
        } else if details.op == Some("remove") && matches!(response, Response::Success) {
            if let Some(id) = details.plugin_id {
                state.plugins.remove(&id);
            }
        }
    }

    /// Hostの待機期限を過ぎても、応答まではドライバーが機器を開いている。
    pub(super) fn timeout(&mut self) {
        if self
            .in_flight
            .as_ref()
            .is_some_and(|pending| pending.details.cause == "device_open")
        {
            return;
        }
        // 遅いload応答のIDは回収するが、待機終了後のクラッシュには結び付けない。
        self.in_flight = None;
    }

    /// EOF の原因を採る。呼べるのは、接続を EOF で閉じる競りに勝った側だけ。
    pub(super) fn exit(&mut self, now: Instant) -> ExitPayload {
        // 開始後の監視中でも、書き込みを始めた現在のVST操作を優先する。
        let pending = self
            .in_flight
            .take()
            .filter(|pending| pending.sent)
            .or_else(|| {
                self.settling.take().filter(|pending| {
                    now.saturating_duration_since(pending.started_at) < DEVICE_OPEN_SETTLING
                })
            });
        let Some(pending) = pending else {
            return ExitPayload {
                cause: "unknown",
                ..Default::default()
            };
        };
        let mut payload = pending.details;
        payload.elapsed_ms = Some(
            now.saturating_duration_since(pending.started_at)
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        );
        payload
    }
}

/// 停止中のホームからの操作用。engine が居るときだけ送り、居なければ起動せず失敗にする。
/// 終了済みの engine も起こし直さない。状態の読取りが先に空を返して、画面は「状態を読み取れません」へ戻る。
/// 確認と送信のあいだに終了しても、送信側が読取りの終了を見て失敗にするだけで、起動は通らない。
impl super::AudioHost {
    fn require_live_engine(&mut self) -> anyhow::Result<()> {
        self.guard_mode_vst()?;
        let link_open = !self.connection_lost();
        let alive = match self.child.as_mut() {
            Some(child) => child.try_wait()?.is_none(),
            None => false,
        };
        anyhow::ensure!(
            link_open && alive,
            "音声エンジンが動いていないため、変更できません。"
        );
        anyhow::ensure!(
            !self.maintenance,
            "更新を適用中のため音声操作はできません。"
        );
        Ok(())
    }

    fn execute_command_if_running(&mut self, cmd: Command) -> anyhow::Result<Response> {
        self.require_live_engine()?;
        if super::conditions::command_changes(&cmd) {
            self.frontend_bootstrap.cancel();
        }
        if self.bundle_change_generation.is_some() {
            self.validate_bundle_connection()?;
        }
        self.sync_live_modes()?;
        self.guard_live_command(&cmd)?;
        let replaces_builtin = matches!(
            &cmd,
            Command::SetBuiltInEffects { .. }
                | Command::BuiltinEffects {
                    request: crate::audio_engine::builtin::Request::Apply { .. }
                }
        );
        let response = self.execute_running_command(cmd)?;
        if replaces_builtin && !matches!(response, Response::Error(_)) {
            self.live_modes.target = None;
        }
        Ok(response)
    }

    /// `require_running` が偽のときは従来どおり（居なければ起動する）、真のときは起動せず失敗にする。
    pub fn set_noise_control_config_routed(
        &mut self,
        require_running: bool,
        active: bool,
        mode: String,
        strength: f32,
        voice_guard: bool,
    ) -> anyhow::Result<()> {
        if !require_running {
            return self.set_noise_control_config(active, mode, strength, voice_guard);
        }
        anyhow::ensure!(strength.is_finite(), "ノイズ低減の抑制強度が不正です");
        match self.execute_command_if_running(Command::SetNoiseControlConfig {
            active,
            mode,
            strength,
            voice_guard,
        })? {
            Response::Success => Ok(()),
            Response::Error(error) => Err(anyhow::anyhow!(error)),
            _ => Err(anyhow::anyhow!("Unexpected response type")),
        }
    }

    pub fn set_built_in_effects_routed(
        &mut self,
        require_running: bool,
        active: bool,
        preset: Option<String>,
        amount: f32,
        singing: Option<crate::audio_engine::singing::SingingParams>,
    ) -> anyhow::Result<()> {
        if !require_running {
            return self.set_built_in_effects_full(active, preset, amount, singing);
        }
        match self.execute_command_if_running(Command::SetBuiltInEffects {
            active,
            preset,
            amount,
            singing,
            reverb: None,
            deesser: None,
            replace_deesser: false,
        })? {
            Response::Success => Ok(()),
            Response::Error(error) => Err(anyhow::anyhow!(error)),
            _ => Err(anyhow::anyhow!("Unexpected response type")),
        }
    }

    pub fn builtin_effects_routed(
        &mut self,
        require_running: bool,
        request: crate::audio_engine::builtin::Request,
    ) -> anyhow::Result<crate::audio_engine::builtin::Snapshot> {
        use crate::audio_engine::builtin::Request;
        if !require_running {
            return self.builtin_effects(request);
        }
        if matches!(
            &request,
            Request::Snapshot
                | Request::ApplyProposal { .. }
                | Request::Undo { .. }
                | Request::Redo { .. }
        ) {
            // 読取り・提案・取消・やり直しは、読取りが無ければ送らない従来の経路をそのまま使う。
            self.require_live_engine()?;
            return self.builtin_effects(request);
        }
        match self.execute_command_if_running(Command::BuiltinEffects { request })? {
            Response::BuiltinEffects(snapshot) => Ok(snapshot),
            Response::Error(error) => Err(anyhow::anyhow!(error)),
            _ => Err(anyhow::anyhow!("Unexpected builtin response")),
        }
    }
}
impl OperationLog {
    #[cfg(test)]
    pub(super) fn in_flight_for_test(&self) -> bool {
        self.in_flight.is_some()
    }

    #[cfg(test)]
    pub(super) fn awaiting_for_test(&self) -> bool {
        self.awaiting.is_some()
    }

    #[cfg(test)]
    pub(super) fn plugin_count_for_test(&self) -> usize {
        self.plugins.len()
    }
}

#[cfg(test)]
mod tests {
    use super::super::link_seam;
    use super::*;
    use crate::ipc::{ChannelLayout, RestorePluginRequest, RestoredPlugin};
    use std::sync::Arc;
    use std::time::Duration;

    /// 書き込みを始めた操作だけを記録する、試験用の包み。
    #[derive(Default)]
    struct Operations(std::sync::Mutex<OperationLog>);

    impl Operations {
        fn begin(&self, command: &Command) {
            let mut log = self.0.lock().unwrap();
            log.begin(command, Instant::now());
            log.mark_sent();
        }

        fn response(&self, response: &Response) {
            self.0.lock().unwrap().response(response, Instant::now());
        }

        fn timeout(&self) {
            self.0.lock().unwrap().timeout();
        }

        fn take_exit(&self) -> ExitPayload {
            self.0.lock().unwrap().exit(Instant::now())
        }
    }

    fn begin_sent(log: &mut OperationLog, command: &Command, now: Instant) {
        log.begin(command, now);
        log.mark_sent();
    }
    fn load() -> Command {
        Command::LoadPlugin {
            path: "C:/VST/Echo.vst3".into(),
            class_id: Some("class-a".into()),
        }
    }

    fn loaded() -> Response {
        Response::PluginLoaded {
            id: "id-a".into(),
            name: "Echo".into(),
            vendor: "Maker".into(),
            class_id: Some("class-a".into()),
            legacy_class_ambiguous: false,
            channel_layout: ChannelLayout::Stereo,
        }
    }

    fn request() -> RestorePluginRequest {
        RestorePluginRequest {
            path: "Echo.vst3".into(),
            class_id: Some("class-a".into()),
            state: Some("state".into()),
            bypassed: false,
            muted: false,
            gain: 1.0,
        }
    }

    fn exit(operations: &Operations) -> ExitPayload {
        operations.take_exit()
    }

    fn start() -> Command {
        Command::Start {
            host: "ASIO".into(),
            input: Some("Driver".into()),
            output: Some("Driver".into()),
            input_source: None,
            input_id: None,
            output_id: None,
            buffer_size: None,
            sample_rate: None,
            initial_controls: None,
            channel_routing: None,
        }
    }

    fn started() -> Response {
        Response::Started {
            sample_rate: 48000,
            buffer_size: 512,
            routing: None,
            input_id: None,
            output_id: None,
            stream_generation: Some(1),
        }
    }

    #[test]
    fn start_in_flight_reports_device_opening_without_vst_identity() {
        let now = Instant::now();
        let mut state = OperationLog::default();
        begin_sent(&mut state, &start(), now);
        let payload = state.exit(now + Duration::from_millis(25));
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({
                "cause": "device_open", "host": "ASIO", "input": "Driver",
                "output": "Driver", "phase": "opening", "elapsedMs": 25
            })
        );
    }

    #[test]
    fn successful_start_settles_for_two_seconds_from_response() {
        let now = Instant::now();
        for (delay_ms, expected) in [
            (0, "device_open"),
            (1999, "device_open"),
            (2000, "unknown"),
            (2001, "unknown"),
        ] {
            let mut state = OperationLog::default();
            begin_sent(&mut state, &start(), now);
            let responded = now + Duration::from_secs(5);
            state.response(&started(), responded);
            assert!(state.in_flight.is_none());
            let payload = state.exit(responded + Duration::from_millis(delay_ms));
            assert_eq!(payload.cause, expected);
            if expected == "device_open" {
                assert_eq!(payload.phase, Some("settling"));
                assert_eq!(payload.elapsed_ms, Some(delay_ms));
                assert_eq!(payload.host.as_deref(), Some("ASIO"));
            }
        }
    }

    #[test]
    fn vst_in_flight_takes_priority_over_settling() {
        let now = Instant::now();
        let mut state = OperationLog::default();
        begin_sent(&mut state, &start(), now);
        state.response(&started(), now);
        begin_sent(&mut state, &load(), now);
        let payload = state.exit(now);
        assert_eq!(payload.cause, "vst_operation");
        assert_eq!(payload.op, Some("load"));
        assert!(payload.host.is_none() && payload.phase.is_none());
    }

    #[test]
    fn only_stop_clears_settling_and_other_responses_do_not_extend_it() {
        let now = Instant::now();
        for command in [Command::GetDevices, load(), Command::Stop, start()] {
            for completed in [false, true] {
                let mut state = OperationLog::default();
                begin_sent(&mut state, &start(), now);
                state.response(&started(), now);
                begin_sent(&mut state, &command, now + Duration::from_secs(1));
                if completed {
                    state.response(
                        &Response::Error("rejected".into()),
                        now + Duration::from_secs(1),
                    );
                }
                assert_eq!(state.settling.is_none(), matches!(command, Command::Stop));
                if completed {
                    assert_eq!(state.exit(now + DEVICE_OPEN_SETTLING).cause, "unknown");
                }
            }
        }
    }

    #[test]
    fn failed_start_does_not_settle_and_timed_out_start_remains_opening_until_response() {
        let now = Instant::now();
        let mut state = OperationLog::default();
        begin_sent(&mut state, &start(), now);
        state.response(&Response::Error("rejected".into()), now);
        assert_eq!(state.exit(now).cause, "unknown");

        let operations = Operations::default();
        operations.begin(&start());
        operations.timeout();
        assert_eq!(exit(&operations).phase, Some("opening"));
        operations.response(&started());
        assert_eq!(exit(&operations).phase, Some("settling"));
    }

    #[test]
    fn intentional_exit_suppresses_opening_and_settling() {
        for settling in [false, true] {
            for dropping in [false, true] {
                let mut host = super::super::AudioHost::new(
                    std::env::temp_dir().join("auralyn-device-exit-unit"),
                );
                host.reset_engine_reader();
                link_seam::register_sent_operation(&host, &start());
                if settling {
                    link_seam::operation_response(&host, started());
                }
                let link = host.link.clone();
                if dropping {
                    drop(host);
                } else {
                    host.kill_engine();
                }
                assert!(!link.close(super::super::link::CloseCause::Eof));
            }
        }
    }

    #[test]
    fn send_records_context_and_serializes_camel_case_elapsed_time() {
        let operations = Operations::default();
        operations.begin(&load());
        operations
            .0
            .lock()
            .unwrap()
            .in_flight
            .as_mut()
            .unwrap()
            .started_at = Instant::now() - Duration::from_millis(25);
        let payload = exit(&operations);
        assert_eq!(payload.cause, "vst_operation");
        assert_eq!(payload.op, Some("load"));
        assert_eq!(payload.path.as_deref(), Some("C:/VST/Echo.vst3"));
        assert!(payload.elapsed_ms.unwrap() >= 25);
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["classId"], "class-a");
        assert!(json.get("elapsedMs").is_some());
        assert!(json.get("pluginId").is_none());
    }

    #[test]
    fn success_error_and_timeout_clear_the_in_flight_record() {
        for terminal in ["success", "error", "timeout"] {
            let operations = Operations::default();
            operations.begin(&load());
            match terminal {
                "success" => operations.response(&loaded()),
                "error" => operations.response(&Response::Error("rejected".into())),
                _ => operations.timeout(),
            }
            assert!(operations.0.lock().unwrap().in_flight.is_none());
            assert_eq!(
                serde_json::to_value(exit(&operations)).unwrap(),
                serde_json::json!({"cause": "unknown"})
            );
        }
    }

    #[test]
    fn id_operations_resolve_loaded_identity() {
        for (command, op) in [
            (Command::GetPluginState { id: "id-a".into() }, "get_state"),
            (
                Command::SetPluginState {
                    id: "id-a".into(),
                    state: "secret-state".into(),
                },
                "set_state",
            ),
            (Command::OpenEditor { id: "id-a".into() }, "open_editor"),
            (Command::UnloadPlugin { id: "id-a".into() }, "remove"),
            (Command::ResumePlugin { id: "id-a".into() }, "resume"),
        ] {
            let operations = Operations::default();
            operations.begin(&load());
            operations.response(&loaded());
            operations.begin(&command);
            let payload = exit(&operations);
            assert_eq!(payload.op, Some(op));
            assert_eq!(payload.plugin_id.as_deref(), Some("id-a"));
            assert_eq!(payload.path.as_deref(), Some("C:/VST/Echo.vst3"));
            assert_eq!(payload.class_id.as_deref(), Some("class-a"));
            assert_eq!(payload.name.as_deref(), Some("Echo"));
            assert!(!serde_json::to_string(&payload)
                .unwrap()
                .contains("secret-state"));
        }
    }

    #[test]
    fn both_restore_commands_record_and_maintain_identity() {
        for command in [
            Command::RestorePlugin {
                request: request(),
                operation_id: 7,
                expires_at_ms: 0,
            },
            Command::RestoreSessionPlugin {
                request: request(),
                operation_id: 7,
                expires_at_ms: 0,
                expected_ids: vec![],
                expected_revision: 0,
            },
        ] {
            let operations = Operations::default();
            operations.begin(&command);
            assert_eq!(
                operations
                    .0
                    .lock()
                    .unwrap()
                    .in_flight
                    .as_ref()
                    .unwrap()
                    .details
                    .op,
                Some("restore")
            );
            operations.response(&Response::PluginRestored {
                operation_id: 7,
                plugin: RestoredPlugin {
                    id: "id-a".into(),
                    name: "Restored Echo".into(),
                    class_id: Some("class-b".into()),
                    prepared: false,
                    legacy_class_ambiguous: false,
                    channel_layout: ChannelLayout::Stereo,
                },
            });
            operations.begin(&Command::OpenEditor { id: "id-a".into() });
            let payload = exit(&operations);
            assert_eq!(payload.path.as_deref(), Some("Echo.vst3"));
            assert_eq!(payload.name.as_deref(), Some("Restored Echo"));
            assert_eq!(payload.class_id.as_deref(), Some("class-b"));
        }
    }

    #[test]
    fn failed_load_and_failed_removal_do_not_corrupt_identity_map() {
        let operations = Operations::default();
        operations.begin(&load());
        operations.response(&Response::Error("load failed".into()));
        assert!(operations.0.lock().unwrap().plugins.is_empty());
        operations.begin(&load());
        operations.response(&loaded());
        operations.begin(&Command::UnloadPlugin { id: "id-a".into() });
        operations.response(&Response::Error("remove failed".into()));
        assert_eq!(operations.0.lock().unwrap().plugins.len(), 1);
        operations.begin(&Command::UnloadPlugin { id: "id-a".into() });
        operations.response(&Response::Success);
        assert!(operations.0.lock().unwrap().plugins.is_empty());
        operations.begin(&Command::OpenEditor { id: "id-a".into() });
        let payload = exit(&operations);
        assert_eq!(payload.plugin_id.as_deref(), Some("id-a"));
        assert!(payload.path.is_none() && payload.name.is_none());
    }

    #[test]
    fn late_load_response_updates_identity_without_reactivating_the_record() {
        let operations = Operations::default();
        operations.begin(&load());
        operations.timeout();
        operations.response(&loaded());
        assert!(operations.0.lock().unwrap().in_flight.is_none());
        operations.begin(&Command::OpenEditor { id: "id-a".into() });
        assert_eq!(exit(&operations).name.as_deref(), Some("Echo"));
    }

    #[test]
    fn aggregate_operations_do_not_name_an_individual_plugin() {
        for command in [
            Command::CaptureBundleState,
            Command::CaptureMixingBundleState,
            Command::PostMixStart {
                descriptor: crate::audio_engine::post_mix::Descriptor {
                    name: "test".into(),
                    sample_rate: 48000,
                    protocol: 1,
                },
            },
        ] {
            let operations = Operations::default();
            operations.begin(&load());
            operations.response(&loaded());
            operations.begin(&command);
            let payload = exit(&operations);
            assert_eq!(payload.cause, "vst_operation");
            assert!(
                payload.plugin_id.is_none() && payload.path.is_none() && payload.name.is_none()
            );
        }
    }

    #[test]
    fn normal_stop_and_non_vst_requests_leave_no_plugin_attribution() {
        for command in [
            Command::Stop,
            Command::GetDevices,
            Command::CaptureBundleState,
        ] {
            let operations = Operations::default();
            operations.begin(&command);
            operations.response(&Response::Success);
            assert_eq!(exit(&operations).cause, "unknown");
        }
    }

    #[test]
    fn kill_and_app_drop_suppress_exit_even_with_a_pending_vst() {
        for dropping in [false, true] {
            let mut host =
                super::super::AudioHost::new(std::env::temp_dir().join("auralyn-exit-unit"));
            host.reset_engine_reader();
            link_seam::register_sent_operation(&host, &load());
            let link = host.link.clone();
            if dropping {
                drop(host);
            } else {
                host.kill_engine();
            }
            assert!(!link.close(super::super::link::CloseCause::Eof));
        }
    }

    #[test]
    fn respawn_replaces_map_and_record_and_retires_the_old_reader() {
        let mut host =
            super::super::AudioHost::new(std::env::temp_dir().join("auralyn-respawn-unit"));
        host.reset_engine_reader();
        link_seam::register_sent_operation(&host, &load());
        link_seam::operation_response(&host, loaded());
        link_seam::register_sent_operation(&host, &Command::OpenEditor { id: "id-a".into() });
        assert_eq!(link_seam::plugin_records(&host), 1);
        let old_link = host.link.clone();
        let old_record = link_seam::operation_record(&host);
        host.reset_engine_reader();
        assert!(!Arc::ptr_eq(&old_link, &host.link));
        assert!(!old_link.close(super::super::link::CloseCause::Eof));
        assert!(!old_record.is_same_record(&link_seam::operation_record(&host)));
        assert_eq!(
            old_record.plugin_count(),
            1,
            "旧い接続の記録は、作り直しで消えない"
        );
        assert_eq!(link_seam::plugin_records(&host), 0);
        assert_eq!(link_seam::exit_record(&host)["cause"], "unknown");
    }

    #[test]
    fn only_the_winner_of_the_eof_close_takes_the_exit_record() {
        let link = super::super::link::LinkCell::open();
        let win = link.close_eof().expect("最初の EOF が勝つ");
        assert_eq!(win.exit.cause, "unknown");
        assert!(link.close_eof().is_none());
        assert!(!link.close(super::super::link::CloseCause::Eof));
    }

    #[test]
    fn send_failure_clears_the_operation_and_retires_the_connection() {
        let mut host =
            super::super::AudioHost::new(std::env::temp_dir().join("auralyn-send-failure-unit"));
        host.reset_engine_reader();
        let link = host.link.clone();
        assert!(host.execute_running_command_inner(load()).is_err());
        assert!(!link_seam::operation_in_flight(&host));
        assert!(!link_seam::operation_awaiting(&host));
        assert!(!link.close(super::super::link::CloseCause::Eof));
    }
}
