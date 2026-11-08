//! Hostの直列IPCから、終了直前の操作と機器の開始直後を伝える。
use crate::ipc::{Command, Response};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
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
}

#[derive(Default)]
struct State {
    in_flight: Option<InFlight>,
    awaiting: Option<ExitPayload>,
    settling: Option<InFlight>,
    plugins: HashMap<String, ExitPayload>,
}

#[derive(Default)]
pub(super) struct Operations(Mutex<State>);

impl State {
    fn begin(&mut self, command: &Command, now: Instant) {
        let state = self;
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
            });
            return;
        }
        if matches!(command, Command::Stop) {
            // 利用者が止めた後の終了を、開始直後の障害と取り違えない。
            state.settling = None;
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
        });
    }

    fn response(&mut self, response: &Response, now: Instant) {
        let state = self;
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

    fn exit(&mut self, now: Instant) -> ExitPayload {
        // 開始後の監視中でも、現在待っているVST操作を優先する。
        let pending = self.in_flight.take().or_else(|| {
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

impl Operations {
    pub(super) fn begin(&self, command: &Command) {
        if let Ok(mut state) = self.0.lock() {
            state.begin(command, Instant::now());
        }
    }

    pub(super) fn response(&self, response: &Response) {
        if let Ok(mut state) = self.0.lock() {
            state.response(response, Instant::now());
        }
    }

    pub(super) fn timeout(&self) {
        if let Ok(mut state) = self.0.lock() {
            // Hostの待機期限を過ぎても、応答まではドライバーが機器を開いている。
            if state
                .in_flight
                .as_ref()
                .is_some_and(|pending| pending.details.cause == "device_open")
            {
                return;
            }
            // 遅いload応答のIDは回収するが、待機終了後のクラッシュには結び付けない。
            state.in_flight = None;
        }
    }

    pub(super) fn unexpected_exit(&self, active: &AtomicBool) -> Option<ExitPayload> {
        if !active.swap(false, Ordering::AcqRel) {
            return None;
        }
        Some(
            self.0
                .lock()
                .ok()
                .map(|mut state| state.exit(Instant::now()))
                .unwrap_or_else(|| ExitPayload {
                    cause: "unknown",
                    ..Default::default()
                }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{ChannelLayout, RestorePluginRequest, RestoredPlugin};
    use std::sync::Arc;
    use std::time::Duration;

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
        operations.unexpected_exit(&AtomicBool::new(true)).unwrap()
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
        }
    }

    #[test]
    fn start_in_flight_reports_device_opening_without_vst_identity() {
        let now = Instant::now();
        let mut state = State::default();
        state.begin(&start(), now);
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
            let mut state = State::default();
            state.begin(&start(), now);
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
        let mut state = State::default();
        state.begin(&start(), now);
        state.response(&started(), now);
        state.begin(&load(), now);
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
                let mut state = State::default();
                state.begin(&start(), now);
                state.response(&started(), now);
                state.begin(&command, now + Duration::from_secs(1));
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
        let mut state = State::default();
        state.begin(&start(), now);
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
                host.vst_operations.begin(&start());
                if settling {
                    host.vst_operations.response(&started());
                }
                let active = host.reader_active.clone();
                let operations = host.vst_operations.clone();
                if dropping {
                    drop(host);
                } else {
                    host.kill_engine();
                }
                assert!(operations.unexpected_exit(&active).is_none());
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
            host.vst_operations.begin(&load());
            let active = host.reader_active.clone();
            let operations = host.vst_operations.clone();
            if dropping {
                drop(host);
            } else {
                host.kill_engine();
            }
            assert!(operations.unexpected_exit(&active).is_none());
        }
    }

    #[test]
    fn respawn_replaces_map_and_record_and_retires_the_old_reader() {
        let mut host =
            super::super::AudioHost::new(std::env::temp_dir().join("auralyn-respawn-unit"));
        host.reset_engine_reader();
        host.vst_operations.begin(&load());
        host.vst_operations.response(&loaded());
        host.vst_operations
            .begin(&Command::OpenEditor { id: "id-a".into() });
        let old_active = host.reader_active.clone();
        let old_operations = host.vst_operations.clone();
        host.reset_engine_reader();
        assert!(!Arc::ptr_eq(&old_operations, &host.vst_operations));
        assert!(old_operations.unexpected_exit(&old_active).is_none());
        assert!(host.vst_operations.0.lock().unwrap().plugins.is_empty());
        assert_eq!(exit(&host.vst_operations).cause, "unknown");
    }

    #[test]
    fn unexpected_exit_is_reported_only_once() {
        let operations = Operations::default();
        let active = AtomicBool::new(true);
        assert_eq!(
            operations.unexpected_exit(&active).unwrap().cause,
            "unknown"
        );
        assert!(operations.unexpected_exit(&active).is_none());
    }

    #[test]
    fn send_failure_clears_the_operation_and_retires_the_connection() {
        let mut host =
            super::super::AudioHost::new(std::env::temp_dir().join("auralyn-send-failure-unit"));
        host.reset_engine_reader();
        let operations = host.vst_operations.clone();
        let active = host.reader_active.clone();
        assert!(host.execute_running_command_inner(load()).is_err());
        assert!(operations.0.lock().unwrap().in_flight.is_none());
        assert!(operations.0.lock().unwrap().awaiting.is_none());
        assert!(operations.unexpected_exit(&active).is_none());
    }
}
