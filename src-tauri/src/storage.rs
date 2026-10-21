//! 配布方式ごとの保存先。MSIXでは通常版の設定を暗黙に読み書きしない。
use anyhow::{bail, Context, Result};
use std::path::Path;
use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides};

use crate::desktop_integration::Distribution;

pub fn configure(config: &mut tauri::Config, distribution: Distribution) -> Result<()> {
    match distribution {
        Distribution::Standalone => Ok(()),
        Distribution::Unknown => {
            bail!("インストール形式を確認できないため、安全な設定保存先を決定できませんでした。")
        }
        Distribution::Msix => {
            let data = windows::Storage::ApplicationData::Current()
                .context("MSIXのデータ領域を取得できませんでした")?;
            let state = data.LocalFolder()?.Path()?.to_os_string();
            let cache = data.LocalCacheFolder()?.Path()?.to_os_string();
            apply_package_folders(config, Path::new(&state), Path::new(&cache))
        }
    }
}

fn apply_package_folders(config: &mut tauri::Config, state: &Path, cache: &Path) -> Result<()> {
    if !state.is_absolute() || !cache.is_absolute() || state == cache {
        bail!("MSIXの設定保存先を確認できませんでした。");
    }
    let state = state.join("Auralyn");
    let cache = cache.join("Auralyn");
    // ウィンドウ生成・window-stateの読み込みより前に全app_*パスを揃える。
    // identifierは変更せず、通常版と共通のsingle-instance識別を維持する。
    config.app.app_directories_override =
        Some(AppDirectoriesOverride::Directories(AppDirectoryOverrides {
            config: Some(state.clone()),
            data: Some(state),
            local_data: Some(cache.join("WebView2")),
            cache: Some(cache.join("cache")),
            log: Some(cache.join("logs")),
        }));
    for window in &mut config.app.windows {
        // WebView2もoverrideしたapp_local_data_dirを使い、既存版を参照しない。
        window.data_directory = None;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_preserves_existing_directories_and_identity() {
        let mut config = tauri::Config {
            identifier: "com.kuro7983.auralynhost".into(),
            ..Default::default()
        };
        let before = config.clone();
        configure(&mut config, Distribution::Standalone).unwrap();
        assert_eq!(config, before);
    }

    #[test]
    fn package_roots_isolate_all_persistence_without_changing_instance_identity() {
        let base = std::env::temp_dir().join("auralyn-storage-contract");
        let mut config = tauri::Config {
            identifier: "com.kuro7983.auralynhost".into(),
            ..Default::default()
        };
        let window = tauri::utils::config::WindowConfig {
            data_directory: Some(base.join("legacy-webview")),
            ..Default::default()
        };
        config.app.windows.push(window);
        let mut other = config.clone();
        apply_package_folders(
            &mut config,
            &base.join("package-a/LocalState"),
            &base.join("package-a/LocalCache"),
        )
        .unwrap();
        apply_package_folders(
            &mut other,
            &base.join("package-b/LocalState"),
            &base.join("package-b/LocalCache"),
        )
        .unwrap();
        assert_eq!(config.identifier, other.identifier);
        assert_eq!(config.identifier, "com.kuro7983.auralynhost");
        assert!(config.app.windows[0].data_directory.is_none());
        let Some(AppDirectoriesOverride::Directories(dirs)) = config.app.app_directories_override
        else {
            panic!("保存先が未設定")
        };
        let Some(AppDirectoriesOverride::Directories(other_dirs)) =
            other.app.app_directories_override
        else {
            panic!("別パッケージの保存先が未設定")
        };
        assert_eq!(dirs.config, Some(base.join("package-a/LocalState/Auralyn")));
        assert_eq!(dirs.data, dirs.config);
        assert_eq!(
            dirs.local_data,
            Some(base.join("package-a/LocalCache/Auralyn/WebView2"))
        );
        assert_eq!(
            dirs.cache,
            Some(base.join("package-a/LocalCache/Auralyn/cache"))
        );
        assert_eq!(
            dirs.log,
            Some(base.join("package-a/LocalCache/Auralyn/logs"))
        );
        assert_ne!(dirs.config, other_dirs.config);
        assert_ne!(dirs.local_data, other_dirs.local_data);
    }

    #[test]
    fn unresolved_distribution_or_invalid_package_path_never_falls_back_to_legacy() {
        let mut config = tauri::Config::default();
        let before = config.clone();
        assert!(configure(&mut config, Distribution::Unknown).is_err());
        assert_eq!(config, before);
        assert!(apply_package_folders(
            &mut config,
            Path::new("relative"),
            Path::new("relative-cache")
        )
        .is_err());
        assert_eq!(config, before);
    }
}
