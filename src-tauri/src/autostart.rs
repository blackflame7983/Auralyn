use anyhow::{bail, Context, Result};
use serde::Serialize;
use winreg::{enums::*, RegKey};

use crate::desktop_integration::Distribution;

const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APP_VALUE_NAME: &str = "VSTHost";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartStatus {
    pub enabled: bool,
    pub method: String,
    pub can_change: bool,
    pub reason: Option<String>,
}

fn require_standalone(distribution: Distribution) -> Result<()> {
    if distribution != Distribution::Standalone {
        bail!("このインストール形式では通常版の自動起動登録を変更できません。");
    }
    Ok(())
}

fn own_command() -> Result<String> {
    Ok(format!(
        "\"{}\" --autostart",
        std::env::current_exe()?.to_string_lossy()
    ))
}

fn read_command(run_key: &RegKey) -> Result<Option<String>> {
    match run_key.get_value(APP_VALUE_NAME) {
        Ok(command) => Ok(Some(command)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("自動起動登録を読み取れませんでした"),
    }
}

fn owns_registration(existing: Option<&str>, own: &str) -> bool {
    existing.is_none_or(|command| command.eq_ignore_ascii_case(own))
}

pub(crate) fn get_autostart_status(distribution: Distribution) -> Result<AutostartStatus> {
    // StartupTaskは後続で対応する。MSIXから通常版のRunキーを参照・変更しない。
    if distribution != Distribution::Standalone {
        return Ok(AutostartStatus {
            enabled: false,
            method: "unavailable".into(),
            can_change: false,
            reason: Some(
                if distribution == Distribution::Msix {
                    "MSIX版の自動起動は準備中です。通常版の登録は変更しません。"
                } else {
                    "インストール形式を確認できないため、自動起動は変更できません。"
                }
                .into(),
            ),
        });
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let command = match hkcu.open_subkey(RUN_KEY_PATH) {
        Ok(key) => read_command(&key)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).context("自動起動登録を開けませんでした"),
    };
    let can_change = owns_registration(command.as_deref(), &own_command()?);
    Ok(AutostartStatus {
        enabled: command.is_some() && can_change,
        method: "registry".into(),
        can_change,
        reason: (!can_change)
            .then(|| "別のAuralynの自動起動登録があります。登録した版で解除してください。".into()),
    })
}

pub(crate) fn set_autostart_enabled(distribution: Distribution, enabled: bool) -> Result<()> {
    require_standalone(distribution)?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run_key, _) = hkcu
        .create_subkey(RUN_KEY_PATH)
        .context("自動起動登録を開けませんでした")?;
    let own = own_command()?;
    if !owns_registration(read_command(&run_key)?.as_deref(), &own) {
        bail!("別のAuralynの自動起動登録は上書き・削除できません。");
    }
    if enabled {
        run_key
            .set_value(APP_VALUE_NAME, &own)
            .context("自動起動を登録できませんでした")
    } else {
        match run_key.delete_value(APP_VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("自動起動登録を解除できませんでした"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn another_installation_is_never_owned() {
        let own = r#""C:\Apps\Auralyn\AuralynHost.exe" --autostart"#;
        assert!(owns_registration(None, own));
        assert!(owns_registration(Some(&own.to_ascii_uppercase()), own));
        assert!(!owns_registration(
            Some(r#""C:\Other\AuralynHost.exe" --autostart"#),
            own
        ));
        assert!(!owns_registration(Some("unexpected command"), own));
    }

    #[test]
    fn msix_and_unknown_never_reach_registry_operations() {
        for distribution in [Distribution::Msix, Distribution::Unknown] {
            let status = get_autostart_status(distribution).unwrap();
            assert!(!status.enabled);
            assert!(!status.can_change);
            assert!(status.reason.is_some());
            assert!(set_autostart_enabled(distribution, true).is_err());
            assert!(set_autostart_enabled(distribution, false).is_err());
        }
    }
}
