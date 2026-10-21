use serde::{Deserialize, Serialize};
use tauri::State;
use windows::Win32::Foundation::{
    APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, WIN32_ERROR,
};
use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Distribution {
    Standalone,
    Msix,
    Unknown,
}

fn classify_package_result(result: WIN32_ERROR, length: u32) -> Distribution {
    match result {
        APPMODEL_ERROR_NO_PACKAGE => Distribution::Standalone,
        ERROR_INSUFFICIENT_BUFFER if length > 0 => Distribution::Msix,
        _ => Distribution::Unknown,
    }
}

pub fn detect_distribution() -> Distribution {
    let mut length = 0;
    // 名前そのものは取得・公開せず、パッケージIDの有無だけを確認する。
    let result = unsafe { GetCurrentPackageFullName(&mut length, None) };
    classify_package_result(result, length)
}

#[tauri::command]
pub fn get_distribution(distribution: State<'_, Distribution>) -> Distribution {
    *distribution
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopSettingsTarget {
    StoreUpdates,
    MicrophonePrivacy,
}

impl DesktopSettingsTarget {
    fn uri(self) -> &'static str {
        match self {
            Self::StoreUpdates => "ms-windows-store://downloadsandupdates",
            Self::MicrophonePrivacy => "ms-settings:privacy-microphone",
        }
    }
}

#[tauri::command]
pub async fn open_desktop_settings(target: DesktopSettingsTarget) -> Result<(), String> {
    // 任意のURIを受け取らず、OSの画面起動をUIスレッドから分離する。
    tauri::async_runtime::spawn_blocking(move || open::that(target.uri()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SUCCESS};

    #[test]
    fn current_windows_process_has_a_known_distribution() {
        assert_ne!(detect_distribution(), Distribution::Unknown);
    }

    #[test]
    fn only_explicit_no_package_allows_standalone_updates() {
        assert_eq!(
            classify_package_result(APPMODEL_ERROR_NO_PACKAGE, 0),
            Distribution::Standalone
        );
        assert_eq!(
            classify_package_result(ERROR_INSUFFICIENT_BUFFER, 60),
            Distribution::Msix
        );
        for (result, length) in [
            (ERROR_ACCESS_DENIED, 0),
            (ERROR_SUCCESS, 0),
            (ERROR_INSUFFICIENT_BUFFER, 0),
            (WIN32_ERROR(12345), 10),
        ] {
            assert_eq!(
                classify_package_result(result, length),
                Distribution::Unknown
            );
        }
    }

    #[test]
    fn settings_targets_reject_arbitrary_uris() {
        assert!(serde_json::from_str::<DesktopSettingsTarget>(r#""https://example.com""#).is_err());
        assert_eq!(
            serde_json::from_str::<DesktopSettingsTarget>(r#""microphonePrivacy""#)
                .expect("固定のマイク設定ターゲット")
                .uri(),
            "ms-settings:privacy-microphone"
        );
        assert_eq!(
            DesktopSettingsTarget::StoreUpdates.uri(),
            "ms-windows-store://downloadsandupdates"
        );
    }
}
