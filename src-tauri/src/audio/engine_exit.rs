//! Hostの直列IPCから、終了直前に待っていたVST操作だけを伝える。
use crate::ipc::{Command, Response};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

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
}

struct InFlight {
    details: ExitPayload,
    started_at: Instant,
}

#[derive(Default)]
struct State {
    in_flight: Option<InFlight>,
    awaiting: Option<ExitPayload>,
    plugins: HashMap<String, ExitPayload>,
}

#[derive(Default)]
pub(super) struct Operations(Mutex<State>);

impl Operations {
    pub(super) fn begin(&self, command: &Command) {
        let Ok(mut state) = self.0.lock() else { return };
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
            started_at: Instant::now(),
        });
    }

    pub(super) fn response(&self, response: &Response) {
        let Ok(mut state) = self.0.lock() else { return };
        state.in_flight = None;
        let Some(mut details) = state.awaiting.take() else {
            return;
        };
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

    pub(super) fn timeout(&self) {
        if let Ok(mut state) = self.0.lock() {
            // 遅いload応答のIDは回収するが、待機終了後のクラッシュには結び付けない。
            state.in_flight = None;
        }
    }

    pub(super) fn unexpected_exit(&self, active: &AtomicBool) -> Option<ExitPayload> {
        if !active.swap(false, Ordering::AcqRel) {
            return None;
        }
        let pending = self
            .0
            .lock()
            .ok()
            .and_then(|mut state| state.in_flight.take());
        let mut payload = ExitPayload {
            cause: "unknown",
            ..Default::default()
        };
        if let Some(pending) = pending {
            payload = pending.details;
            payload.elapsed_ms = Some(
                pending
                    .started_at
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
        }
        Some(payload)
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
