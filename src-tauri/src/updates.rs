//! 通常インストール版だけを対象に、確認・取得・明示適用を分離する。
use crate::desktop_integration::Distribution;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::AppHandleExt;

#[derive(Default)]
struct Candidate {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}
#[derive(Default)]
pub struct Updates(tokio::sync::Mutex<Candidate>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    body: Option<String>,
    can_install: bool,
}

fn require_standalone(distribution: Distribution) -> Result<(), String> {
    if distribution != Distribution::Standalone {
        return Err("この版はStoreまたは元の配布元から更新してください。".into());
    }
    Ok(())
}

fn matching_location(exe: &std::path::Path, location: &str) -> bool {
    !location.is_empty()
        && exe.parent().is_some_and(|parent| {
            match (
                parent.canonicalize(),
                std::path::Path::new(location).canonicalize(),
            ) {
                (Ok(a), Ok(b)) => a
                    .as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy()),
                _ => false,
            }
        })
}

fn eligible_install(
    exe: &std::path::Path,
    display: &str,
    location: &str,
    windows_installer: u32,
) -> bool {
    // MSIからNSISへの置き換えは自動適用せず、配布元での手動更新に任せる。
    windows_installer == 0 && display == "Auralyn" && matching_location(exe, location)
}

fn can_install() -> bool {
    use winreg::{enums::*, RegKey};
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let Ok(uninstall) = RegKey::predef(root).open_subkey_with_flags(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                KEY_READ | view,
            ) else {
                continue;
            };
            for name in uninstall.enum_keys().flatten() {
                let Ok(key) = uninstall.open_subkey(&name) else {
                    continue;
                };
                let display: String = key.get_value("DisplayName").unwrap_or_default();
                let location: String = key.get_value("InstallLocation").unwrap_or_default();
                let windows_installer: u32 = key.get_value("WindowsInstaller").unwrap_or_default();
                if eligible_install(&exe, &display, &location, windows_installer) {
                    return true;
                }
            }
        }
    }
    false
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    distribution: State<'_, Distribution>,
    updates: State<'_, Updates>,
) -> Result<Option<Available>, String> {
    crate::temporary_session::require_regular(&app)?;
    require_standalone(*distribution)?;
    let mut candidate = updates.0.lock().await;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let available = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        body: u.body.clone(),
        can_install: can_install(),
    });
    candidate.update = update;
    candidate.bytes = None;
    Ok(available)
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    distribution: State<'_, Distribution>,
    updates: State<'_, Updates>,
    version: String,
) -> Result<(), String> {
    crate::temporary_session::require_regular(&app)?;
    require_standalone(*distribution)?;
    if !can_install() {
        return Err(
            "Portable版またはインストール先が不明です。配布ページから更新してください。".into(),
        );
    }
    let mut candidate = updates.0.lock().await;
    let update = candidate
        .update
        .as_ref()
        .filter(|u| u.version == version)
        .ok_or("更新内容が変わりました。再確認してください。")?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    candidate.bytes = Some(bytes);
    Ok(())
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    distribution: State<'_, Distribution>,
    updates: State<'_, Updates>,
    version: String,
) -> Result<(), String> {
    crate::temporary_session::require_regular(&app)?;
    require_standalone(*distribution)?;
    if !can_install() {
        return Err("インストール先を確認できないため自動適用しません。".into());
    }
    let mut candidate = updates.0.lock().await;
    let update = candidate
        .update
        .as_ref()
        .filter(|u| u.version == version)
        .ok_or("更新内容が変わりました。再確認してください。")?
        .clone();
    let bytes = candidate
        .bytes
        .take()
        .ok_or("先に更新をダウンロードしてください。")?;
    let audio = app.state::<crate::audio::AudioState>().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.save_window_state(tauri_plugin_window_state::StateFlags::all())
            .map_err(|e| e.to_string())?;
        audio
            .lock()
            .map_err(|_| "音声状態を取得できません")?
            .prepare_update()
            .map_err(|e| e.to_string())?;
        // Windowsではインストーラー起動後にプロセス終了する。Dropに後片付けを任せない。
        let result = update.install(bytes).map_err(|e| {
            format!("更新できませんでした。音声は停止しています。音声設定から再開してください: {e}")
        });
        if let Ok(mut host) = audio.lock() {
            host.finish_update_attempt();
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_msi_is_not_replaced_with_nsis() {
        let exe = std::env::current_exe().unwrap();
        let location = exe.parent().unwrap().to_string_lossy();
        assert!(eligible_install(&exe, "Auralyn", &location, 0));
        assert!(!eligible_install(&exe, "Auralyn", &location, 1));
        assert!(!eligible_install(&exe, "Other", &location, 0));
    }

    #[test]
    fn packaged_and_unknown_distributions_never_enter_updater() {
        assert!(require_standalone(Distribution::Standalone).is_ok());
        assert!(require_standalone(Distribution::Msix).is_err());
        assert!(require_standalone(Distribution::Unknown).is_err());
        assert!(!matching_location(
            std::path::Path::new("C:/missing/Auralyn.exe"),
            ""
        ));
        let exe = std::env::current_exe().unwrap();
        assert!(matching_location(
            &exe,
            &exe.parent().unwrap().to_string_lossy()
        ));
        assert!(!matching_location(
            &exe,
            &std::env::temp_dir().to_string_lossy()
        ));
    }
}
