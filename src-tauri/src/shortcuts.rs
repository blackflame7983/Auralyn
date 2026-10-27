//! Stream Deckの標準Hotkeyからも使える、同じ音声操作への入口。
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::Path,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    MuteToggle,
    MuteOn,
    MuteOff,
    BypassToggle,
    BypassOn,
    BypassOff,
    GainUp,
    GainDown,
    SingingOn,
    TalkOn,
    NoiseToggle,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    action: Action,
    shortcut: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    bindings: Vec<Binding>,
    errors: Vec<ShortcutError>,
}

// 表示文をIPCへ固定せず、画面で現在の言語へ解決する。外部の詳細は別フィールドで保持する。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ShortcutError {
    TooManyBindings,
    InvalidShortcut { shortcut: String },
    ModifierRequired,
    DuplicateBinding,
    StateUnavailable,
    LoadFailed { detail: String },
    RegisterFailed { shortcut: String, detail: String },
    RegistrationConflict { detail: String },
    SaveFailed { detail: String },
    UnregisterFailed { detail: String },
    OperationFailed { detail: String },
    AudioStateUnavailable,
    GainPending,
    ActionFailed { detail: String },
}

impl std::fmt::Display for ShortcutError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Shortcut error: {self:?}")
    }
}
impl std::error::Error for ShortcutError {}
#[derive(Default)]
pub struct Shortcuts(pub Mutex<Status>, AtomicBool, AtomicU64);

fn defaults() -> Vec<Binding> {
    vec![
        Binding {
            action: Action::MuteToggle,
            shortcut: "Alt+KeyM".into(),
        },
        Binding {
            action: Action::BypassToggle,
            shortcut: "Alt+KeyP".into(),
        },
    ]
}

/// 画面の音づくりへ伝える、切替後のノイズ低減設定。
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoiseToggle {
    enabled: bool,
    mode: String,
    strength: f32,
    voice_guard: bool,
}

// ON/OFFだけを反転し、モード・強度・声を守るは現在値を引き継ぐ（未設定の強度は画面と同じ既定値）。
pub(crate) fn noise_toggle(stats: &crate::audio::EngineRuntimeStats) -> NoiseToggle {
    NoiseToggle {
        enabled: !stats.noise_reduction_enabled,
        mode: if stats.noise_reduction_mode.is_empty() {
            "low".into()
        } else {
            stats.noise_reduction_mode.to_lowercase()
        },
        strength: if stats.noise_control_strength.is_finite() && stats.noise_control_strength > 0.0
        {
            stats.noise_control_strength
        } else {
            0.8
        },
        voice_guard: stats.noise_voice_guard,
    }
}

pub(crate) fn validate(bindings: &[Binding]) -> Result<Vec<Shortcut>, ShortcutError> {
    if bindings.len() > 8 {
        return Err(ShortcutError::TooManyBindings);
    }
    let mut keys = HashSet::new();
    let mut actions = HashSet::new();
    bindings
        .iter()
        .map(|b| {
            let key =
                Shortcut::from_str(&b.shortcut).map_err(|_| ShortcutError::InvalidShortcut {
                    shortcut: b.shortcut.clone(),
                })?;
            if b.shortcut.len() > 80 || !b.shortcut.contains('+') {
                return Err(ShortcutError::ModifierRequired);
            }
            if !keys.insert(key.id()) || !actions.insert(format!("{:?}", b.action)) {
                return Err(ShortcutError::DuplicateBinding);
            }
            Ok(key)
        })
        .collect()
}

pub(crate) fn read_bindings(root: &Path) -> Result<Vec<Binding>, ShortcutError> {
    let path = root.join("shortcuts.json");
    if path.exists() {
        let bytes = std::fs::read(path).map_err(|e| ShortcutError::LoadFailed {
            detail: e.to_string(),
        })?;
        serde_json::from_slice(&bytes).map_err(|e| ShortcutError::LoadFailed {
            detail: e.to_string(),
        })
    } else {
        Ok(defaults())
    }
}

pub fn initialize(app: &AppHandle) {
    // UIのacknowledgeや再読み込みから再度呼ばれても、同じプロセスで二重登録しない。
    if app.state::<Shortcuts>().1.swap(true, Ordering::AcqRel) {
        return;
    }
    let result = (|| -> Result<(), ShortcutError> {
        let root = app
            .path()
            .app_config_dir()
            .map_err(|e| ShortcutError::LoadFailed {
                detail: e.to_string(),
            })?;
        let bindings = read_bindings(&root)?;
        let keys = validate(&bindings)?;
        let state = app.state::<Shortcuts>();
        let mut state = state
            .0
            .lock()
            .map_err(|_| ShortcutError::StateUnavailable)?;
        for (b, key) in bindings.iter().zip(keys) {
            if let Err(error) = app.global_shortcut().register(key) {
                state.errors.push(ShortcutError::RegisterFailed {
                    shortcut: b.shortcut.clone(),
                    detail: error.to_string(),
                });
            }
        }
        state.bindings = bindings;
        Ok(())
    })();
    if let Err(error) = result {
        if let Ok(mut state) = app.state::<Shortcuts>().0.lock() {
            state.errors.push(error);
        }
    }
}

#[tauri::command]
pub fn get_shortcuts(app: AppHandle) -> Result<Status, ShortcutError> {
    Ok(app
        .state::<Shortcuts>()
        .0
        .lock()
        .map_err(|_| ShortcutError::StateUnavailable)?
        .clone())
}

#[tauri::command]
pub async fn save_shortcuts(
    app: AppHandle,
    bindings: Vec<Binding>,
) -> Result<Status, ShortcutError> {
    let keys = validate(&bindings)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Shortcuts>();
        let mut state = state
            .0
            .lock()
            .map_err(|_| ShortcutError::StateUnavailable)?;
        let old_keys = validate(&state.bindings)?;
        let mut added = Vec::new();
        for key in &keys {
            if !app.global_shortcut().is_registered(*key) {
                if let Err(error) = app.global_shortcut().register(*key) {
                    for registered in added {
                        let _ = app.global_shortcut().unregister(registered);
                    }
                    return Err(ShortcutError::RegistrationConflict {
                        detail: error.to_string(),
                    });
                }
                added.push(*key);
            }
        }
        let path = app
            .path()
            .app_config_dir()
            .map_err(|e| ShortcutError::SaveFailed {
                detail: e.to_string(),
            })?
            .join("shortcuts.json");
        let persist = crate::migration::write_json(&path, &bindings);
        if let Err(error) = persist {
            for key in added {
                let _ = app.global_shortcut().unregister(key);
            }
            return Err(ShortcutError::SaveFailed { detail: error });
        }
        state.errors.clear();
        for key in old_keys
            .iter()
            .filter(|old| !keys.iter().any(|new| new.id() == old.id()))
        {
            if let Err(error) = app.global_shortcut().unregister(*key) {
                state.errors.push(ShortcutError::UnregisterFailed {
                    detail: error.to_string(),
                });
            }
        }
        state.bindings = bindings;
        Ok(state.clone())
    })
    .await
    .map_err(|e| ShortcutError::OperationFailed {
        detail: e.to_string(),
    })?
}

pub fn dispatch(app: AppHandle, id: u32) {
    let action = app.state::<Shortcuts>().0.lock().ok().and_then(|status| {
        status
            .bindings
            .iter()
            .find(|binding| Shortcut::from_str(&binding.shortcut).is_ok_and(|key| key.id() == id))
            .map(|binding| binding.action.clone())
    });
    let Some(action) = action else {
        return;
    };
    let is_mode = matches!(action, Action::SingingOn | Action::TalkOn);
    let intent_sequence = if is_mode {
        app.state::<Shortcuts>().2.fetch_add(1, Ordering::AcqRel) + 1
    } else {
        0
    };
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> anyhow::Result<()> {
            let audio = app.state::<crate::audio::AudioState>();
            let mut host = audio
                .0
                .lock()
                .map_err(|_| ShortcutError::AudioStateUnavailable)?;
            match action {
                Action::SingingOn | Action::TalkOn => {
                    if intent_sequence != app.state::<Shortcuts>().2.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    use crate::audio_engine::live_modes::{Intent, Request};
                    let epoch = host.live_modes(Request::Snapshot)?.epoch;
                    let intent = Intent {
                        client_id: "shortcuts".into(),
                        sequence: intent_sequence,
                        expected_epoch: epoch,
                    };
                    let request = if action == Action::SingingOn {
                        Request::SingingOn { intent }
                    } else {
                        Request::TalkOn { intent }
                    };
                    host.live_modes(request)?;
                }
                Action::MuteToggle => host.toggle_global_mute()?,
                Action::MuteOn => host.set_global_mute(true)?,
                Action::MuteOff => host.set_global_mute(false)?,
                Action::BypassToggle | Action::BypassOn | Action::BypassOff => {
                    let active = match action {
                        Action::BypassOn => true,
                        Action::BypassOff => false,
                        _ => !host.get_engine_runtime_stats()?.global_bypass,
                    };
                    host.set_global_bypass(active)?;
                }
                Action::NoiseToggle => {
                    let next = noise_toggle(&host.get_engine_runtime_stats()?);
                    host.set_noise_control_config(
                        next.enabled,
                        next.mode.clone(),
                        next.strength,
                        next.voice_guard,
                    )?;
                    app.emit("shortcut-noise-toggled", next)?;
                }
                Action::GainUp | Action::GainDown => {
                    let status = host.auto_gain(crate::audio_engine::auto_gain::Request::Status)?;
                    if status.stream_failed || (status.running && !status.settled) {
                        return Err(ShortcutError::GainPending.into());
                    }
                    let next = (status.gain
                        + if action == Action::GainUp {
                            0.01
                        } else {
                            -0.01
                        })
                    .clamp(0.0, 2.0);
                    host.set_output_gain(next)?;
                    if !status.running {
                        app.emit("shortcut-stopped-gain", next * 100.0)?;
                    } else {
                        let intent = host.shortcut_gain_intent(next)?;
                        app.emit("shortcut-output-gain", intent)?;
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let notice = error
                .downcast_ref::<ShortcutError>()
                .cloned()
                .unwrap_or_else(|| ShortcutError::ActionFailed {
                    detail: error.to_string(),
                });
            let _ = app.emit("shortcut-error", notice);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_errors_keep_reason_codes_instead_of_display_text() {
        let mut bindings = defaults();
        bindings[1].shortcut = "Unknown+KeyP".into();
        assert_eq!(
            validate(&bindings).unwrap_err(),
            ShortcutError::InvalidShortcut {
                shortcut: "Unknown+KeyP".into()
            }
        );
        bindings[1].shortcut = "KeyP".into();
        assert_eq!(
            validate(&bindings).unwrap_err(),
            ShortcutError::ModifierRequired
        );
        bindings[1].shortcut = bindings[0].shortcut.clone();
        assert_eq!(
            validate(&bindings).unwrap_err(),
            ShortcutError::DuplicateBinding
        );
        assert_eq!(
            validate(&vec![bindings[0].clone(); 9]).unwrap_err(),
            ShortcutError::TooManyBindings
        );
    }

    #[test]
    fn ipc_status_and_rejections_keep_codes_keys_and_external_details_separate() {
        let status = Status {
            bindings: defaults(),
            errors: vec![ShortcutError::RegisterFailed {
                shortcut: "Alt+KeyM".into(),
                detail: "OS 1409: 予約済み".into(),
            }],
        };
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(
            json["errors"][0],
            serde_json::json!({"code": "registerFailed", "shortcut": "Alt+KeyM", "detail": "OS 1409: 予約済み"})
        );
        let cases = [
            (ShortcutError::TooManyBindings, "tooManyBindings"),
            (
                ShortcutError::InvalidShortcut {
                    shortcut: "Alt+KeyM".into(),
                },
                "invalidShortcut",
            ),
            (ShortcutError::ModifierRequired, "modifierRequired"),
            (ShortcutError::DuplicateBinding, "duplicateBinding"),
            (ShortcutError::StateUnavailable, "stateUnavailable"),
            (
                ShortcutError::LoadFailed {
                    detail: "raw".into(),
                },
                "loadFailed",
            ),
            (
                ShortcutError::RegistrationConflict {
                    detail: "raw".into(),
                },
                "registrationConflict",
            ),
            (
                ShortcutError::SaveFailed {
                    detail: "raw".into(),
                },
                "saveFailed",
            ),
            (
                ShortcutError::UnregisterFailed {
                    detail: "raw".into(),
                },
                "unregisterFailed",
            ),
            (
                ShortcutError::OperationFailed {
                    detail: "raw".into(),
                },
                "operationFailed",
            ),
            (
                ShortcutError::AudioStateUnavailable,
                "audioStateUnavailable",
            ),
            (ShortcutError::GainPending, "gainPending"),
            (
                ShortcutError::ActionFailed {
                    detail: "raw".into(),
                },
                "actionFailed",
            ),
        ];
        for (error, code) in cases {
            assert_eq!(serde_json::to_value(error).unwrap()["code"], code);
        }
    }

    #[test]
    fn live_modes_hotkeys_are_explicit_not_auto_registered_and_keep_eight_binding_limit() {
        assert!(defaults()
            .iter()
            .all(|binding| !matches!(binding.action, Action::SingingOn | Action::TalkOn)));
        let bindings = vec![
            Binding {
                action: Action::SingingOn,
                shortcut: "Alt+KeyS".into(),
            },
            Binding {
                action: Action::TalkOn,
                shortcut: "Alt+KeyT".into(),
            },
        ];
        assert!(validate(&bindings).is_ok());
        let json = serde_json::to_string(&bindings).unwrap();
        assert!(json.contains("singingOn") && json.contains("talkOn"));
        let old: Vec<Binding> =
            serde_json::from_str(r#"[{"action":"muteToggle","shortcut":"Alt+KeyM"}]"#).unwrap();
        assert!(validate(&old).is_ok());
        assert!(validate(&vec![bindings[0].clone(); 9]).is_err());
    }

    #[test]
    fn noise_toggle_is_explicit_and_only_flips_enabled_keeping_mode_strength_and_voice_guard() {
        assert!(defaults()
            .iter()
            .all(|binding| binding.action != Action::NoiseToggle));
        let old: Vec<Binding> =
            serde_json::from_str(r#"[{"action":"noiseToggle","shortcut":"Alt+KeyN"}]"#).unwrap();
        assert!(validate(&old).is_ok());
        let mut full: Vec<Binding> = [
            Action::MuteToggle,
            Action::BypassToggle,
            Action::GainUp,
            Action::GainDown,
            Action::SingingOn,
            Action::TalkOn,
            Action::MuteOn,
            Action::NoiseToggle,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, action)| Binding {
            action,
            shortcut: format!("Alt+F{}", index + 1),
        })
        .collect();
        assert!(validate(&full).is_ok());
        full.push(Binding {
            action: Action::MuteOff,
            shortcut: "Alt+F9".into(),
        });
        assert_eq!(validate(&full).unwrap_err(), ShortcutError::TooManyBindings);

        let stats = crate::audio::EngineRuntimeStats {
            noise_reduction_enabled: true,
            noise_reduction_mode: "venue".into(),
            noise_control_strength: 1.1,
            noise_voice_guard: false,
            ..Default::default()
        };
        let off = noise_toggle(&stats);
        assert_eq!(
            off,
            NoiseToggle {
                enabled: false,
                mode: "venue".into(),
                strength: 1.1,
                voice_guard: false,
            }
        );
        let on = noise_toggle(&crate::audio::EngineRuntimeStats {
            noise_reduction_enabled: false,
            noise_voice_guard: true,
            ..Default::default()
        });
        assert_eq!(
            serde_json::to_value(on).unwrap(),
            serde_json::json!({"enabled": true, "mode": "low", "strength": 0.8f32, "voiceGuard": true})
        );
    }

    #[test]
    fn duplicates_plain_keys_and_invalid_shortcuts_do_not_register() {
        assert!(validate(&defaults()).is_ok());
        let mut b = defaults();
        b[1].shortcut = b[0].shortcut.clone();
        assert!(validate(&b).is_err());
        b[1].shortcut = "KeyP".into();
        assert!(validate(&b).is_err());
        b[1].shortcut = "Unknown+KeyP".into();
        assert!(validate(&b).is_err());
        b = defaults();
        b[1].action = Action::MuteToggle;
        assert!(validate(&b).is_err());
    }
}
