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

/// MSIXの未許可入力をサイドカーで開くと、OSの応答待ちでIPCまで滞る。
/// 設定は変更せず、開始・再試行・前回設定の自動開始で毎回読み直す。
pub fn check_microphone_access(host: Option<&str>) -> Result<(), String> {
    if !matches!(host, Some(name) if name.eq_ignore_ascii_case("wasapi"))
        || detect_distribution() != Distribution::Msix
    {
        return Ok(());
    }
    use windows::Security::Authorization::AppCapabilityAccess::AppCapability;
    let status = AppCapability::Create(&windows::core::HSTRING::from("microphone"))
        .and_then(|capability| capability.CheckAccess())
        .map_err(|error| format!("マイクのアクセス許可を確認できませんでした。Windowsのマイク設定を確認して再試行してください。詳細: {error}"))?;
    validate_microphone_access(status)
}

fn validate_microphone_access(
    status: windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus,
) -> Result<(), String> {
    use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus as Access;
    match status {
        Access::Allowed => Ok(()),
        Access::UserPromptRequired | Access::DeniedByUser | Access::DeniedBySystem => Err(
            "マイクのアクセスが許可されていません。(0x80070005) Windowsのマイク設定でアプリの許可をONにして、もう一度開始してください。".into(),
        ),
        _ => Err("マイクのアクセス許可を確認できませんでした。Windowsのマイク設定を確認して再試行してください。".into()),
    }
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
    fn microphone_requires_explicit_allow_including_first_launch() {
        use windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus as A;
        assert!(validate_microphone_access(A::Allowed).is_ok());
        for status in [A::UserPromptRequired, A::DeniedByUser, A::DeniedBySystem] {
            let error = validate_microphone_access(status).unwrap_err();
            assert!(error.contains("0x80070005"));
            assert!(!error.contains("Timeout"));
        }
        assert!(validate_microphone_access(A::NotDeclaredByApp).is_err());
        assert!(validate_microphone_access(A(99)).is_err());
    }

    #[test]
    fn asio_and_unpacked_hosts_do_not_require_package_microphone_capability() {
        assert!(check_microphone_access(Some("ASIO")).is_ok());
        assert!(check_microphone_access(None).is_ok());
        if detect_distribution() == Distribution::Standalone {
            assert!(check_microphone_access(Some("Wasapi")).is_ok());
        }
    }

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
