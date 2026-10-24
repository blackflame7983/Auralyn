//! 明示操作による設定移行。OS設定・資格情報・クラッシュ印は扱わない。
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
const PENDING: &str = "migration-pending.json";
const BACKUP: &str = "migration-backup.json";
pub const UI_KEYS: &[&str] = &[
    "vst_host_theme",
    "vst_host_locale",
    "vst_host_beginner_mode",
    "vst_host_simple_mode",
    "vst_host_audio_config",
    "vst_host_audio_presets",
    "vst_host_input_gain",
    "vst_host_output_gain",
    "vst_host_plugin_favorites",
    "vst_host_plugin_recent",
    "vst_host_session_plugins",
    "vst_host_setup_goal",
    "vst_host_wizard_done",
    "vst_host_tutorial_completed",
    "vst_host_settings_advanced",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle {
    format: String,
    version: u32,
    app_version: String,
    ui: BTreeMap<String, String>,
    files: BTreeMap<String, serde_json::Value>,
}

#[derive(Default)]
pub struct Preview {
    bundle: Mutex<Option<Bundle>>,
    applying: Arc<AtomicBool>,
}

struct Applying(Arc<AtomicBool>);
impl Drop for Applying {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    app_version: String,
    settings: Vec<String>,
    files: Vec<String>,
    audio: Option<serde_json::Value>,
    plugins: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub review_required: bool,
    pub ui: Option<BTreeMap<String, String>>,
    #[serde(default)]
    files_applied: bool,
}

pub fn review_required(root: &Path) -> bool {
    // 壊れたマーカーも自動開始を許可しない。
    root.join(PENDING).exists()
}

pub fn complete_review(root: &Path) -> anyhow::Result<()> {
    if root.join(PENDING).exists() {
        fs::remove_file(root.join(PENDING))?;
    }
    Ok(())
}

fn plain_path(root: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    let allowed = ["vst_blacklist.json", "shortcuts.json"].contains(&name)
        || name.strip_prefix("presets/").is_some_and(|n| {
            n.ends_with(".json")
                && n.len() > 5
                && !n.contains(['/', '\\', ':'])
                && !n.starts_with('.')
                && !n.ends_with(" .json")
        });
    if !allowed {
        return Err("移行できないファイル名です。".into());
    }
    let target = root.join(name);
    for path in [root.to_path_buf(), root.join("presets"), target.clone()] {
        if let Ok(meta) = fs::symlink_metadata(&path) {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("リンクされた保存先へは移行できません。".into());
            }
        }
    }
    Ok(target)
}

fn validate(bundle: &Bundle) -> Result<(), String> {
    if bundle.format != "auralyn-settings"
        || bundle.version != 1
        || bundle.files.len() > 512
        || bundle.app_version.len() > 64
    {
        return Err("対応していない移行ファイルです。".into());
    }
    for (key, value) in &bundle.ui {
        if !UI_KEYS.contains(&key.as_str()) || value.len() > 32 * 1024 * 1024 {
            return Err("対象外の設定が含まれています。".into());
        }
        let parsed: serde_json::Value = serde_json::from_str(value)
            .unwrap_or_else(|_| serde_json::Value::String(value.clone()));
        let valid = match key.as_str() {
            "vst_host_theme" => ["light", "dark", "gaming"].contains(&value.as_str()),
            "vst_host_locale" => ["ja", "en"].contains(&value.as_str()),
            "vst_host_input_gain" | "vst_host_output_gain" => value
                .parse::<f64>()
                .is_ok_and(|n| n.is_finite() && (0.0..=200.0).contains(&n)),
            "vst_host_audio_config" => valid_audio(&parsed),
            "vst_host_audio_presets" => parsed.as_object().is_some_and(|items| {
                items.len() <= 512
                    && items
                        .iter()
                        .all(|(name, item)| name.len() <= 256 && valid_audio(item))
            }),
            "vst_host_session_plugins" => parsed
                .as_array()
                .is_some_and(|items| items.len() <= 128 && items.iter().all(valid_plugin)),
            "vst_host_plugin_favorites" | "vst_host_plugin_recent" => {
                parsed.as_array().is_some_and(|items| {
                    items.len() <= 4096
                        && items
                            .iter()
                            .all(|v| v.as_str().is_some_and(|s| s.len() <= 32768))
                })
            }
            "vst_host_setup_goal" => ["obs", "discord", "local"].contains(&value.as_str()),
            _ => ["true", "false"].contains(&value.as_str()),
        };
        if !valid {
            return Err(format!("設定の形式が正しくありません: {key}"));
        }
    }
    for (name, value) in &bundle.files {
        plain_path(Path::new("C:/auralyn-validation"), name)?;
        if name == "vst_blacklist.json" {
            serde_json::from_value::<crate::vst_host::blacklist::Blacklist>(value.clone())
                .map_err(|_| "除外リストの形式が正しくありません")?;
        } else if name == "shortcuts.json" {
            let bindings: Vec<crate::shortcuts::Binding> =
                serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            crate::shortcuts::validate(&bindings)?;
        } else {
            let preset: crate::vst_host::presets::Preset = serde_json::from_value(value.clone())
                .map_err(|_| "プロファイルの形式が正しくありません")?;
            if preset.effective_schema_version() > 2 {
                return Err("未対応のプロファイル形式です。".into());
            }
        }
    }
    if serde_json::to_vec(bundle).map_err(|e| e.to_string())?.len() as u64 > MAX_BYTES {
        return Err("移行データは64MiB以下にしてください。".into());
    }
    Ok(())
}

fn valid_audio(value: &serde_json::Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    map.get("host")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.len() <= 128)
        && ["input", "output", "inputId", "outputId"].iter().all(|k| {
            map.get(*k)
                .is_none_or(|v| v.as_str().is_some_and(|s| s.len() <= 32768))
        })
        && [("sampleRate", 8000, 768000), ("bufferSize", 1, 65536)]
            .iter()
            .all(|(k, min, max)| {
                map.get(*k)
                    .is_none_or(|v| v.as_u64().is_some_and(|n| (*min..=*max).contains(&n)))
            })
        && map.get("inputChannels").is_none_or(|v| {
            v.as_array().is_some_and(|a| {
                a.len() == 2 && a.iter().all(|n| n.as_u64().is_some_and(|n| n < 1024))
            })
        })
}

fn valid_plugin(value: &serde_json::Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    ["name", "path", "vendor", "version"].iter().all(|k| {
        map.get(*k)
            .and_then(|v| v.as_str())
            .is_some_and(|s| s.len() <= 32768)
    }) && ["enabled", "muted"]
        .iter()
        .all(|k| map.get(*k).is_some_and(|v| v.is_boolean()))
        && map
            .get("gain")
            .and_then(|v| v.as_f64())
            .is_some_and(|n| n.is_finite() && (0.0..=2.0).contains(&n))
        && map
            .get("state")
            .is_none_or(|v| v.as_str().is_some_and(|s| s.len() <= 32 * 1024 * 1024))
}

fn snapshot(root: &Path, ui: BTreeMap<String, String>) -> Result<Bundle, String> {
    let mut files = BTreeMap::new();
    let mut names = vec!["vst_blacklist.json".to_owned(), "shortcuts.json".to_owned()];
    if root.join("presets").is_dir() {
        for entry in fs::read_dir(root.join("presets")).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().extension().is_some_and(|e| e == "json") {
                names.push(format!("presets/{}", entry.file_name().to_string_lossy()));
            }
        }
    }
    if names.len() > 514 {
        return Err("移行ファイルが多すぎます。".into());
    }
    let mut total = 0;
    for name in names {
        let path = plain_path(root, &name)?;
        if path.exists() {
            total += fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if total > MAX_BYTES {
                return Err("設定ファイルが大きすぎます。".into());
            }
            files.insert(
                name,
                serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
    }
    let bundle = Bundle {
        format: "auralyn-settings".into(),
        version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        ui,
        files,
    };
    validate(&bundle)?;
    Ok(bundle)
}

pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("保存先がありません")?).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = path.with_file_name(format!(".auralyn-migration-{stamp}.tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| e.to_string())
}

fn apply_files(root: &Path, bundle: &Bundle, previous: &Bundle) -> Result<(), String> {
    for name in bundle.files.keys().chain(previous.files.keys()) {
        plain_path(root, name)?;
    }
    // 途中で終了しても、未確認の移行データで音声を自動開始しない。
    write_json(
        &root.join(PENDING),
        &Pending {
            review_required: true,
            ui: Some(bundle.ui.clone()),
            files_applied: false,
        },
    )?;
    for (name, value) in &bundle.files {
        write_json(&plain_path(root, name)?, value)?;
    }
    for name in previous
        .files
        .keys()
        .filter(|name| !bundle.files.contains_key(*name))
    {
        match fs::remove_file(plain_path(root, name)?) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    write_json(
        &root.join(PENDING),
        &Pending {
            review_required: true,
            ui: Some(bundle.ui.clone()),
            files_applied: true,
        },
    )?;
    Ok(())
}

#[tauri::command]
pub async fn export_settings(
    app: AppHandle,
    preview: State<'_, Preview>,
    ui: BTreeMap<String, String>,
) -> Result<bool, String> {
    if preview.applying.swap(true, Ordering::AcqRel) {
        return Err("設定の操作中です。完了後に再試行してください。".into());
    }
    let guard = Applying(preview.applying.clone());
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let bundle = snapshot(&root, ui)?;
        let Some(path) = rfd::FileDialog::new()
            .set_file_name("Auralyn-settings.json")
            .save_file()
        else {
            return Ok(false);
        };
        write_json(&path, &bundle)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn preview_settings(preview: State<'_, Preview>) -> Result<Option<Summary>, String> {
    if preview.applying.load(Ordering::Acquire) {
        return Err("設定を移行中です。完了後に再試行してください。".into());
    }
    let bundle = tauri::async_runtime::spawn_blocking(|| -> Result<Option<Bundle>, String> {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("Auralyn settings", &["json"])
            .pick_file()
        else {
            return Ok(None);
        };
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_BYTES {
            return Err("移行ファイルは64MiB以下にしてください。".into());
        }
        let bundle: Bundle = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        validate(&bundle)?;
        Ok(Some(bundle))
    })
    .await
    .map_err(|e| e.to_string())??;
    let summary = bundle.as_ref().map(|b| Summary {
        app_version: b.app_version.clone(),
        settings: b.ui.keys().cloned().collect(),
        files: b.files.keys().cloned().collect(),
        audio: b
            .ui
            .get("vst_host_audio_config")
            .and_then(|s| serde_json::from_str(s).ok()),
        plugins: b
            .ui
            .get("vst_host_session_plugins")
            .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(s).ok())
            .unwrap_or_default()
            .iter()
            .map(|p| {
                format!(
                    "{} — {}",
                    p["name"].as_str().unwrap_or_default(),
                    p["path"].as_str().unwrap_or_default()
                )
            })
            .collect(),
    });
    *preview
        .bundle
        .lock()
        .map_err(|_| "移行内容を取得できません")? = bundle;
    Ok(summary)
}

#[tauri::command]
pub async fn apply_settings(
    app: AppHandle,
    preview: State<'_, Preview>,
    ui: BTreeMap<String, String>,
    restore: bool,
) -> Result<(), String> {
    if preview.applying.swap(true, Ordering::AcqRel) {
        return Err("設定を移行中です。".into());
    }
    let guard = Applying(preview.applying.clone());
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut bundle = if restore {
        serde_json::from_slice(&fs::read(root.join(BACKUP)).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        preview
            .bundle
            .lock()
            .map_err(|_| "移行内容を取得できません")?
            .clone()
            .ok_or("先に移行ファイルを確認してください")?
    };
    validate(&bundle)?;
    let audio = app.state::<crate::audio::AudioState>().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let mut host = audio.lock().map_err(|_| "音声状態を取得できません")?;
        host.check_can_interrupt().map_err(|e| e.to_string())?;
        let previous = snapshot(&root, ui)?;
        if !restore {
            let incoming = std::mem::take(&mut bundle.files);
            bundle.files = previous.files.clone();
            bundle.files.extend(incoming);
        }
        validate(&bundle)?;
        // バックアップ成功後にだけ停止・書き込みへ進む。通常版の領域は参照しない。
        if !restore {
            write_json(&root.join(BACKUP), &previous)?;
        }
        host.prepare_update().map_err(|e| e.to_string())?;
        if let Err(error) = apply_files(&root, &bundle, &previous) {
            let rollback = apply_files(&root, &previous, &bundle);
            host.finish_update_attempt();
            rollback.map_err(|rollback| format!("{error}; 復旧にも失敗しました: {rollback}"))?;
            return Err(format!("移行に失敗し、移行前の設定へ戻しました: {error}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// 音声開始・チャンネル適用・利用者確認の完了後にだけ呼ぶ。
// Start単体では消さず、途中終了後も次の起動で確認を求める。
#[tauri::command]
pub async fn migration_complete_review(app: AppHandle) -> Result<(), String> {
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || complete_review(&root).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn migration_bootstrap(app: AppHandle, acknowledge: bool) -> Result<Pending, String> {
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let pending = bootstrap(&root, acknowledge)?;
        // 中断した移行を復旧してから設定依存のOS登録を行う。UIはこの完了後に起動する。
        crate::shortcuts::initialize(&app);
        Ok(pending)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn bootstrap(root: &Path, acknowledge: bool) -> Result<Pending, String> {
    if !root.join(PENDING).exists() {
        return Ok(Pending {
            review_required: false,
            ui: None,
            files_applied: true,
        });
    }
    let mut pending: Pending =
        serde_json::from_slice(&fs::read(root.join(PENDING)).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if !pending.files_applied {
        // 中断した取り込みを完了扱いにせず、保存済みの移行前へ戻してからUIへ渡す。
        let backup: Bundle =
            serde_json::from_slice(&fs::read(root.join(BACKUP)).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        validate(&backup)?;
        let current = snapshot(root, BTreeMap::new())?;
        apply_files(root, &backup, &current)?;
        pending = serde_json::from_slice(&fs::read(root.join(PENDING)).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    if acknowledge {
        pending.ui = None;
        write_json(&root.join(PENDING), &pending)?;
    }
    Ok(pending)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confirmation_survives_repeated_bootstrap_until_explicit_completion() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-confirmation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        write_json(
            &root.join(PENDING),
            &Pending {
                review_required: true,
                ui: None,
                files_applied: true,
            },
        )
        .unwrap();
        // Start成功後でも、チャンネル適用や完了IPCより前の終了は未確認のまま。
        for acknowledge in [false, true, false] {
            assert!(bootstrap(&root, acknowledge).unwrap().review_required);
            assert!(review_required(&root));
        }
        complete_review(&root).unwrap();
        assert!(!bootstrap(&root, false).unwrap().review_required);
        complete_review(&root).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completion_failure_keeps_the_durable_marker() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-confirmation-error-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // 消去に失敗するマーカーを使い、エラーが呼び出し元へ返ることを確認。
        fs::create_dir_all(root.join(PENDING)).unwrap();
        assert!(complete_review(&root).is_err());
        assert!(review_required(&root));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_migration_restores_shortcuts_before_registration_reads_them() {
        for had_shortcuts in [false, true] {
            let root = std::env::temp_dir().join(format!(
                "auralyn-shortcut-recovery-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            if had_shortcuts {
                write_json(
                    &root.join("shortcuts.json"),
                    &serde_json::json!([
                        { "action": "muteOn", "shortcut": "Control+Alt+KeyQ" }
                    ]),
                )
                .unwrap();
            }
            let expected =
                serde_json::to_value(crate::shortcuts::read_bindings(&root).unwrap()).unwrap();
            let original = snapshot(&root, BTreeMap::new()).unwrap();
            write_json(&root.join(BACKUP), &original).unwrap();
            let mut incoming = original.clone();
            incoming.files.insert(
                "shortcuts.json".into(),
                serde_json::json!([
                    { "action": "bypassOn", "shortcut": "Control+Alt+KeyW" }
                ]),
            );
            apply_files(&root, &incoming, &original).unwrap();
            write_json(
                &root.join(PENDING),
                &Pending {
                    review_required: true,
                    ui: Some(incoming.ui.clone()),
                    files_applied: false,
                },
            )
            .unwrap();
            assert_ne!(
                serde_json::to_value(crate::shortcuts::read_bindings(&root).unwrap()).unwrap(),
                expected
            );
            // migration_bootstrapと同じ順序で復旧後に登録用の設定を読む。
            bootstrap(&root, false).unwrap();
            assert_eq!(
                serde_json::to_value(crate::shortcuts::read_bindings(&root).unwrap()).unwrap(),
                expected
            );
            assert_eq!(root.join("shortcuts.json").exists(), had_shortcuts);
            assert!(bootstrap(&root, true).unwrap().ui.is_none());
            fs::remove_dir_all(&root).unwrap();
        }
    }

    #[test]
    fn rejects_unknown_versions_credentials_and_path_escape() {
        let mut b = Bundle {
            format: "auralyn-settings".into(),
            version: 1,
            app_version: "1".into(),
            ui: BTreeMap::new(),
            files: BTreeMap::new(),
        };
        assert!(validate(&b).is_ok());
        for locale in ["ja", "en"] {
            b.ui.insert("vst_host_locale".into(), locale.into());
            assert!(validate(&b).is_ok());
        }
        for locale in ["EN", "fr", "\"en\"", ""] {
            b.ui.insert("vst_host_locale".into(), locale.into());
            assert!(validate(&b).is_err());
        }
        b.ui.clear();
        b.ui.insert("vst_host_obs_config".into(), "{}".into());
        assert!(validate(&b).is_err());
        b.ui.clear();
        for name in [
            "../x.json",
            "presets/../../x.json",
            "presets/C:x.json",
            "last_audio_config.json",
        ] {
            b.files.insert(name.into(), serde_json::json!({}));
            assert!(validate(&b).is_err());
            b.files.clear();
        }
        b.version = 2;
        assert!(validate(&b).is_err());
    }
    #[test]
    fn invalid_gain_and_json_are_rejected() {
        let mut b = Bundle {
            format: "auralyn-settings".into(),
            version: 1,
            app_version: "1".into(),
            ui: BTreeMap::new(),
            files: BTreeMap::new(),
        };
        for value in ["NaN", "-1", "201"] {
            b.ui.insert("vst_host_output_gain".into(), value.into());
            assert!(validate(&b).is_err());
        }
        b.ui.clear();
        b.ui.insert("vst_host_audio_config".into(), "broken".into());
        assert!(validate(&b).is_err());
    }

    #[test]
    fn validates_nested_device_and_vst_data_before_any_write() {
        let mut b = snapshot(
            &std::env::temp_dir().join("auralyn-unused-validation"),
            BTreeMap::new(),
        )
        .unwrap();
        for value in [
            serde_json::json!({"host": 1}),
            serde_json::json!({"host": "Asio", "sampleRate": -1}),
            serde_json::json!({"host": "Asio", "inputChannels": [0, "1"]}),
        ] {
            b.ui.insert("vst_host_audio_config".into(), value.to_string());
            assert!(validate(&b).is_err());
        }
        b.ui.clear();
        b.ui.insert("vst_host_session_plugins".into(), "[null]".into());
        assert!(validate(&b).is_err());
        b.ui.clear();
        b.ui.insert("vst_host_plugin_favorites".into(), "[{}]".into());
        assert!(validate(&b).is_err());
    }

    #[test]
    fn atomic_replace_restore_and_partial_failure_cleanup_keep_unrelated_data() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-migration-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        {
            fs::write(root.join("unrelated.bin"), b"keep").unwrap();
            let original = snapshot(
                &root,
                BTreeMap::from([("vst_host_theme".into(), "dark".into())]),
            )
            .unwrap();
            write_json(&root.join(BACKUP), &original).unwrap();
            let mut incoming = original.clone();
            incoming.ui.insert("vst_host_theme".into(), "light".into());
            incoming
                .files
                .insert("shortcuts.json".into(), serde_json::json!([]));
            apply_files(&root, &incoming, &original).unwrap();
            assert!(review_required(&root));
            assert!(root.join("shortcuts.json").exists());
            write_json(
                &root.join(PENDING),
                &Pending {
                    review_required: true,
                    ui: Some(incoming.ui.clone()),
                    files_applied: false,
                },
            )
            .unwrap();
            let recovered = bootstrap(&root, false).unwrap();
            assert_eq!(recovered.ui.unwrap()["vst_host_theme"], "dark");
            assert!(!root.join("shortcuts.json").exists());
            apply_files(&root, &incoming, &original).unwrap();
            // 同じファイルへの置換と、途中失敗で存在しない新規ファイルの削除を再現する。
            write_json(&root.join("shortcuts.json"), &serde_json::json!([])).unwrap();
            fs::remove_file(root.join("shortcuts.json")).unwrap();
            apply_files(&root, &original, &incoming).unwrap();
            let pending: Pending =
                serde_json::from_slice(&fs::read(root.join(PENDING)).unwrap()).unwrap();
            assert_eq!(pending.ui.unwrap()["vst_host_theme"], "dark");
            assert_eq!(fs::read(root.join("unrelated.bin")).unwrap(), b"keep");
            complete_review(&root).unwrap();
            assert!(!review_required(&root));
        }
        fs::remove_dir_all(&root).unwrap();
    }
}
