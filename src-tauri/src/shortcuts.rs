//! Stream Deckの標準Hotkeyからも使える、同じ音声操作への入口。
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::Path,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
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
    errors: Vec<String>,
}
#[derive(Default)]
pub struct Shortcuts(pub Mutex<Status>, AtomicBool);

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

pub(crate) fn validate(bindings: &[Binding]) -> Result<Vec<Shortcut>, String> {
    if bindings.len() > 8 {
        return Err("ショートカットは8操作までです。".into());
    }
    let mut keys = HashSet::new();
    let mut actions = HashSet::new();
    bindings
        .iter()
        .map(|b| {
            let key = Shortcut::from_str(&b.shortcut)
                .map_err(|_| format!("キーの形式を確認してください: {}", b.shortcut))?;
            if b.shortcut.len() > 80 || !b.shortcut.contains('+') {
                return Err("Alt・Ctrl・Shiftなどと組み合わせて指定してください。".into());
            }
            if !keys.insert(key.id()) || !actions.insert(format!("{:?}", b.action)) {
                return Err("同じキー・操作を重複して登録できません。".into());
            }
            Ok(key)
        })
        .collect()
}

pub(crate) fn read_bindings(root: &Path) -> Result<Vec<Binding>, String> {
    let path = root.join("shortcuts.json");
    if path.exists() {
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    } else {
        Ok(defaults())
    }
}

pub fn initialize(app: &AppHandle) {
    // UIのacknowledgeや再読み込みから再度呼ばれても、同じプロセスで二重登録しない。
    if app.state::<Shortcuts>().1.swap(true, Ordering::AcqRel) {
        return;
    }
    let result = (|| -> Result<(), String> {
        let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let bindings = read_bindings(&root)?;
        let keys = validate(&bindings)?;
        let state = app.state::<Shortcuts>();
        let mut state = state.0.lock().map_err(|_| "キー設定を取得できません")?;
        for (b, key) in bindings.iter().zip(keys) {
            if let Err(error) = app.global_shortcut().register(key) {
                state
                    .errors
                    .push(format!("{} を登録できませんでした: {error}", b.shortcut));
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
pub fn get_shortcuts(app: AppHandle) -> Result<Status, String> {
    Ok(app
        .state::<Shortcuts>()
        .0
        .lock()
        .map_err(|_| "キー設定を取得できません")?
        .clone())
}

#[tauri::command]
pub async fn save_shortcuts(app: AppHandle, bindings: Vec<Binding>) -> Result<Status, String> {
    let keys = validate(&bindings)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Shortcuts>();
        let mut state = state.0.lock().map_err(|_| "キー設定を取得できません")?;
        let old_keys = validate(&state.bindings)?;
        let mut added = Vec::new();
        for key in &keys {
            if !app.global_shortcut().is_registered(*key) {
                if let Err(error) = app.global_shortcut().register(*key) {
                    for registered in added {
                        let _ = app.global_shortcut().unregister(registered);
                    }
                    return Err(format!(
                        "キーがほかのアプリと競合しています。変更前の設定を保持しました: {error}"
                    ));
                }
                added.push(*key);
            }
        }
        let path = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("shortcuts.json");
        let persist = crate::migration::write_json(&path, &bindings);
        if let Err(error) = persist {
            for key in added {
                let _ = app.global_shortcut().unregister(key);
            }
            return Err(format!("キー設定を保存できませんでした: {error}"));
        }
        state.errors.clear();
        for key in old_keys
            .iter()
            .filter(|old| !keys.iter().any(|new| new.id() == old.id()))
        {
            if let Err(error) = app.global_shortcut().unregister(*key) {
                state
                    .errors
                    .push(format!("以前のキーを解除できませんでした: {error}"));
            }
        }
        state.bindings = bindings;
        Ok(state.clone())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn dispatch(app: AppHandle, id: u32) {
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> anyhow::Result<()> {
            let action = app
                .state::<Shortcuts>()
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("キー設定を取得できません"))?
                .bindings
                .iter()
                .find(|b| Shortcut::from_str(&b.shortcut).is_ok_and(|k| k.id() == id))
                .map(|b| b.action.clone());
            let Some(action) = action else { return Ok(()) };
            let audio = app.state::<crate::audio::AudioState>();
            let mut host = audio
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("音声状態を取得できません"))?;
            match action {
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
                Action::GainUp | Action::GainDown => {
                    let status = host.auto_gain(crate::audio_engine::auto_gain::Request::Status)?;
                    if status.stream_failed || (status.running && !status.settled) {
                        anyhow::bail!("音量の反映を確認中です。もう一度操作してください。");
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
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            let _ = app.emit("shortcut-error", error.to_string());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
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
