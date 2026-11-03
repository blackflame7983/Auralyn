//! 一時利用はプロセス開始時に全app_*とWebViewを分離する。原本へのコピー戻しは行わない。
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Mode {
    pub temporary: bool,
    pub review_only: bool,
    pub directory: Option<PathBuf>,
    pub cleanup_pending: Option<PathBuf>,
    #[serde(skip)]
    discard: Option<PathBuf>,
}

impl Mode {
    pub(crate) fn bind_config_root(&mut self, root: &Path) {
        // 未完了・読み取り不能も自動再開へ読み替えない。値の復帰は別の明示操作。
        self.review_only |= crate::bundle::recovery_exists(root).unwrap_or(true);
    }
}

fn parse(args: &[String]) -> Result<(Mode, Option<u32>), String> {
    let mut mode = Mode::default();
    let mut parent = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--auralyn-temporary" => {
                index += 1;
                let id = args.get(index).ok_or("一時利用IDがありません")?;
                if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return Err("一時利用IDが不正です".into());
                }
                mode.temporary = true;
                mode.review_only = true;
                mode.directory = Some(std::env::temp_dir().join(format!("Auralyn-temporary-{id}")));
            }
            "--auralyn-discard" => {
                index += 1;
                let id = args.get(index).ok_or("削除する一時利用IDがありません")?;
                if id.len() != 32 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
                    return Err("一時利用IDが不正です".into());
                }
                mode.discard = Some(std::env::temp_dir().join(format!("Auralyn-temporary-{id}")));
            }
            "--auralyn-review" => mode.review_only = true,
            "--auralyn-wait-parent" => {
                index += 1;
                parent = Some(
                    args.get(index)
                        .ok_or("起動元がありません")?
                        .parse::<u32>()
                        .map_err(|_| "起動元が不正です")?,
                );
            }
            _ => {}
        }
        index += 1;
    }
    if mode.temporary && mode.discard.is_some() {
        return Err("開始と破棄を同時には要求できません".into());
    }
    if parent == Some(0) || parent == Some(std::process::id()) {
        return Err("起動元が不正です".into());
    }
    Ok((mode, parent))
}

pub(crate) fn initialize(config: &mut tauri::Config) -> Result<Mode, String> {
    let (mut mode, parent) = parse(&std::env::args().skip(1).collect::<Vec<_>>())?;
    if let Some(pid) = parent {
        use windows::Win32::{
            Foundation::{CloseHandle, WAIT_OBJECT_0},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };
        // 旧Hostが停止するまでsingle-instance pluginや音声を初期化しない。
        // 既に終了しているPIDはERROR_INVALID_PARAMETERになる。それ以外は起動を止める。
        unsafe {
            match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                Ok(handle) => {
                    let completed = WaitForSingleObject(handle, 30_000) == WAIT_OBJECT_0;
                    let _ = CloseHandle(handle);
                    if !completed {
                        return Err("起動元の終了を確認できませんでした".into());
                    }
                }
                Err(error) if error.code().0 as u32 == 0x80070057 => {}
                Err(_) => return Err("起動元の終了を確認できませんでした".into()),
            }
        }
    }
    if let Some(root) = &mode.discard {
        if discard(root).is_err() {
            mode.cleanup_pending = Some(root.clone());
        }
    }
    if marker()
        .try_exists()
        .map_err(|_| "一時利用の確認待ち情報を確認できません。音声を開始していません")?
    {
        mode.review_only = true;
        let mut id = String::new();
        use std::io::Read;
        if std::fs::File::open(marker())
            .and_then(|file| file.take(65).read_to_string(&mut id))
            .is_ok()
            && id.len() == 32
            && id.bytes().all(|c| c.is_ascii_hexdigit())
        {
            let root = std::env::temp_dir().join(format!("Auralyn-temporary-{id}"));
            if !mode.temporary && root.try_exists().unwrap_or(true) {
                mode.cleanup_pending = Some(root);
            }
        }
    }
    if let Some(root) = &mode.directory {
        // 既存の一時領域はクラッシュ後も再開しない。新しいIDだけを受け入れる。
        std::fs::create_dir(root).map_err(|_| "新しい一時利用領域を作成できませんでした")?;
        configure(config, root)?;
    }
    Ok(mode)
}

fn configure(config: &mut tauri::Config, root: &Path) -> Result<(), String> {
    use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides};
    if !root.is_absolute() {
        return Err("一時領域が絶対パスではありません".into());
    }
    config.app.app_directories_override =
        Some(AppDirectoriesOverride::Directories(AppDirectoryOverrides {
            config: Some(root.join("config")),
            data: Some(root.join("data")),
            local_data: Some(root.join("WebView2")),
            cache: Some(root.join("cache")),
            log: Some(root.join("logs")),
        }));
    for window in &mut config.app.windows {
        window.data_directory = None;
    }
    Ok(())
}

fn discard(root: &Path) -> Result<(), String> {
    // 終了直後のWebViewが短くファイルを保持する場合だけ、同じ対象で有限に待つ。
    for delay_ms in [0, 100, 200, 400, 800, 1600] {
        if delay_ms != 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        if !checked_discard_target(root)? {
            return Ok(());
        }
        match std::fs::remove_dir_all(root) {
            Ok(()) => return Ok(()),
            Err(error) if matches!(error.raw_os_error(), Some(2 | 3 | 5 | 32 | 33 | 145)) => {}
            Err(_) => return Err("一時保存先を削除できません".into()),
        }
    }
    Err("一時保存先を削除できません".into())
}
fn checked_discard_target(root: &Path) -> Result<bool, String> {
    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix("Auralyn-temporary-"))
        .ok_or("一時保存先が不正です")?;
    if name.len() != 32 || !name.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("一時保存先が不正です".into());
    }
    let parent = root
        .parent()
        .ok_or("一時保存先が不正です")?
        .canonicalize()
        .map_err(|_| "一時保存先を確認できません")?;
    if parent
        != std::env::temp_dir()
            .canonicalize()
            .map_err(|_| "一時保存先を確認できません")?
    {
        return Err("一時保存先が範囲外です".into());
    }
    if !root
        .try_exists()
        .map_err(|_| "一時保存先の有無を確認できません")?
    {
        return Ok(false);
    }
    use std::os::windows::fs::MetadataExt;
    let metadata = std::fs::symlink_metadata(root).map_err(|_| "一時保存先を確認できません")?;
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
        return Err("参照先が変わった一時保存先は削除しません".into());
    }
    Ok(true)
}

fn marker() -> PathBuf {
    std::env::temp_dir().join("Auralyn-temporary-review-required")
}

#[tauri::command]
pub(crate) async fn acknowledge_session_review(
    mode: State<'_, Mode>,
    state: State<'_, crate::audio::AudioState>,
) -> Result<(), String> {
    let mode = mode.inner().clone();
    let host = state.0.clone();
    crate::commands::run_blocking(move || {
        let observation = host
            .lock()
            .map_err(|_| "音声状態を取得できません")?
            .auto_gain(crate::audio_engine::auto_gain::Request::Status)
            .map_err(|e| e.to_string())?;
        if !observation.running || observation.stream_failed {
            return Err("明示開始後の音声処理を確認できません".into());
        }
        acknowledge(&mode)
    })
    .await
}
fn acknowledge(mode: &Mode) -> Result<(), String> {
    if mode.temporary {
        return Ok(());
    }
    if mode
        .cleanup_pending
        .as_ref()
        .is_some_and(|p| p.try_exists().unwrap_or(true))
    {
        return Ok(());
    }
    match std::fs::remove_file(marker()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("一時利用後の確認待ちを解除できません".into()),
    }
}

pub(crate) fn require_regular(app: &AppHandle) -> Result<(), String> {
    if app.state::<Mode>().temporary {
        return Err("一時利用中は自動起動・更新・設定移行を変更できません".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn temporary_session_status(mode: State<'_, Mode>) -> Mode {
    mode.inner().clone()
}

#[tauri::command]
pub(crate) async fn restart_temporary_session(
    app: AppHandle,
    mode: State<'_, Mode>,
    temporary: bool,
    preserve_runtime: Option<bool>,
) -> Result<(), String> {
    if mode.temporary == temporary {
        return Err("利用状態が変更されています".into());
    }
    let preserve_runtime = preserve_runtime.unwrap_or(false);
    if preserve_runtime && (!temporary || mode.temporary) {
        return Err("未保存設定の退避は通常設定から一時利用を始めるときだけ指定できます".into());
    }
    if temporary
        && mode
            .cleanup_pending
            .as_ref()
            .is_some_and(|path| path.try_exists().unwrap_or(true))
    {
        return Err("前回の一時ファイルが残っています。表示された専用領域を確認・削除してから、新しい一時利用を始めてください".into());
    }
    let previous_directory = mode.directory.clone();
    let snapshot_root = if preserve_runtime {
        Some(app.path().app_config_dir().map_err(|e| e.to_string())?)
    } else {
        None
    };
    let state = app.state::<crate::audio::AudioState>().0.clone();
    crate::commands::run_blocking(move || {
        let mut audio = state.lock().map_err(|_| "音声状態を取得できません")?;
        audio.preflight_live_changes().map_err(|e| e.to_string())?;
        if let Some(root) = snapshot_root {
            crate::commands::bundles::preserve_temporary_runtime(&root, &mut audio)?;
        }
        // 旧エンジンを終了してから再起動する。再生・録音の継続は引き継がない。
        audio.prepare_update().map_err(|e| e.to_string())?;
        let started = (|| -> Result<(), String> {
            let mut cleanup_id = previous_directory
                .as_ref()
                .and_then(|root| root.file_name())
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("Auralyn-temporary-"))
                .map(str::to_owned);
            let mut command =
                std::process::Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
            if temporary {
                let id = format!(
                    "{:032x}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|_| "時刻を取得できません")?
                        .as_nanos()
                );
                command.args(["--auralyn-temporary", &id]);
                cleanup_id = Some(id);
            } else {
                command.arg("--auralyn-review");
                if let Some(root) = previous_directory {
                    if let Some(id) = root
                        .file_name()
                        .and_then(|n| n.to_str())
                        .and_then(|n| n.strip_prefix("Auralyn-temporary-"))
                    {
                        command.args(["--auralyn-discard", id]);
                    }
                }
            }
            command.args(["--auralyn-wait-parent", &std::process::id().to_string()]);
            std::fs::write(
                marker(),
                cleanup_id.as_deref().unwrap_or("review-before-start-v1"),
            )
            .map_err(|_| "確認待ち情報を保存できません")?;
            command.spawn().map_err(|error| {
                format!("再起動できませんでした。音声は停止しています: {error}")
            })?;
            Ok(())
        })();
        if let Err(error) = started {
            audio.finish_update_attempt();
            return Err(error);
        }
        drop(audio);
        app.exit(0);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn temporary_discard_retries_a_short_lived_file_lock_without_touching_a_sibling() {
        use sha2::{Digest, Sha256};
        use std::os::windows::fs::OpenOptionsExt;
        let id = format!("{:x}", Sha256::digest(crate::bundle::revision().as_bytes()));
        let id = &id[..32];
        let root = std::env::temp_dir().join(format!("Auralyn-temporary-{id}"));
        let sibling = std::env::temp_dir().join(format!("auralyn-kept-{id}"));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&sibling).unwrap();
        let locked = root.join("webview-cache");
        let sentinel = sibling.join("original");
        std::fs::write(&locked, b"temporary").unwrap();
        std::fs::write(&sentinel, b"keep original").unwrap();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&locked)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            drop(file);
        });
        let result = discard(&root);
        release.join().unwrap();
        assert_eq!(std::fs::read(&sentinel).unwrap(), b"keep original");
        // 修正前の赤い試験でも、所有する既知のfixtureだけを個別に片付ける。
        if locked.exists() {
            std::fs::remove_file(&locked).unwrap();
        }
        if root.exists() {
            std::fs::remove_dir(&root).unwrap();
        }
        std::fs::remove_file(sentinel).unwrap();
        std::fs::remove_dir(sibling).unwrap();
        assert!(
            result.is_ok(),
            "短いロックの解放後も削除を再試行しませんでした"
        );
    }
    #[test]
    fn temporary_discard_retains_a_persistently_locked_directory_and_reports_failure() {
        use sha2::{Digest, Sha256};
        use std::os::windows::fs::OpenOptionsExt;
        let id = format!("{:x}", Sha256::digest(crate::bundle::revision().as_bytes()));
        let root = std::env::temp_dir().join(format!("Auralyn-temporary-{}", &id[..32]));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("locked");
        std::fs::write(&path, b"keep locked").unwrap();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let result = discard(&root);
        drop(file);
        assert_eq!(std::fs::read(&path).unwrap(), b"keep locked");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
        assert!(result.is_err());
    }
    #[test]
    fn unfinished_or_corrupt_recovery_forces_review_without_loading_or_deleting_it() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-runtime-review-{}",
            crate::bundle::revision()
        ));
        std::fs::create_dir(&root).unwrap();
        let mut mode = Mode::default();
        mode.bind_config_root(&root);
        assert!(!mode.review_only);
        let receipt = root.join("broadcast-bundle-recovery.json");
        std::fs::write(&receipt, b"interrupted capture").unwrap();
        mode.bind_config_root(&root);
        assert!(mode.review_only && !mode.temporary);
        assert_eq!(std::fs::read(&receipt).unwrap(), b"interrupted capture");
        std::fs::remove_file(receipt).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn temporary_overrides_every_native_and_webview_root_without_changing_identity() {
        let base = std::env::temp_dir().join("auralyn-isolation-test");
        let mut config = tauri::Config {
            identifier: "auralyn-test".into(),
            ..Default::default()
        };
        config.app.windows.push(tauri::utils::config::WindowConfig {
            data_directory: Some(base.join("old")),
            ..Default::default()
        });
        configure(&mut config, &base).unwrap();
        let Some(tauri::utils::config::AppDirectoriesOverride::Directories(dirs)) =
            config.app.app_directories_override
        else {
            panic!()
        };
        for path in [
            dirs.config,
            dirs.data,
            dirs.local_data,
            dirs.cache,
            dirs.log,
        ] {
            assert!(path.unwrap().starts_with(&base));
        }
        assert!(config.app.windows[0].data_directory.is_none());
        assert_eq!(config.identifier, "auralyn-test");
    }
    #[test]
    fn scratch_writes_and_discard_preserve_sibling_original_and_reject_outside_paths() {
        let id = format!(
            "{:032x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(format!("Auralyn-temporary-{id}"));
        let original = std::env::temp_dir().join(format!("Auralyn-original-{id}"));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&original).unwrap();
        std::fs::write(
            original.join("last_audio_config.json"),
            b"original-device-settings",
        )
        .unwrap();
        std::fs::write(
            root.join("last_audio_config.json"),
            b"session-device-settings",
        )
        .unwrap();
        assert!(discard(&original).is_err());
        assert!(discard(&original.join(format!("Auralyn-temporary-{id}"))).is_err());
        discard(&root).unwrap();
        assert!(!root.exists());
        assert_eq!(
            std::fs::read(original.join("last_audio_config.json")).unwrap(),
            b"original-device-settings"
        );
        std::fs::remove_file(original.join("last_audio_config.json")).unwrap();
        std::fs::remove_dir(original).unwrap();
    }
    #[test]
    fn temporary_ids_cannot_redirect_to_existing_or_external_settings() {
        for id in ["../original", "C:\\settings", "", "abcd"] {
            assert!(parse(&["--auralyn-temporary".into(), id.into()]).is_err());
        }
        let (mode, _) = parse(&["--auralyn-temporary".into(), "a".repeat(32)]).unwrap();
        assert!(mode.temporary && mode.review_only);
        assert!(mode.directory.unwrap().starts_with(std::env::temp_dir()));
        assert!(parse(&["--auralyn-wait-parent".into(), "0".into()]).is_err());
    }
}
