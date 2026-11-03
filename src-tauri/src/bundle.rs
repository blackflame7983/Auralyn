//! 配信状態のローカル保存。VST component stateは機密扱いし、export/logへ出さない。
use crate::vst_host::presets::{Preset, PresetPlugin, ProfileSaveCategories};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
pub(crate) mod output_configuration;
pub(crate) use output_configuration::OutputConfiguration;
pub(crate) mod live_configuration;
pub(crate) use live_configuration::LiveConfiguration;
pub(crate) mod process_configuration;
pub(crate) use process_configuration::ProcessConfiguration;

const MAX_BUNDLE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapturedPlugin {
    pub id: String,
    pub plugin: PresetPlugin,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapture {
    pub control_revision: String,
    pub running: bool,
    pub fixed_buffer_request_frames: Option<u32>,
    pub plugins: Vec<CapturedPlugin>,
    pub input_channels: Vec<usize>,
    #[serde(default)]
    pub output_routing: crate::ipc::OutputRouting,
    pub input_gain: f32,
    pub output_gain: f32,
    pub global_mute: bool,
    pub global_bypass: bool,
    pub noise: crate::vst_host::presets::ProfileNoiseControl,
    pub builtin: crate::vst_host::presets::ProfileBuiltinFx,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BundleV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) process: Option<ProcessConfiguration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) live: Option<LiveConfiguration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) output: Option<OutputConfiguration>,
    /// 利用者による確認の履歴。現在の信号到達・復元後の合格を意味しない。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<Confirmation>,
    pub schema_version: u32,
    pub revision: String,
    pub name: String,
    pub categories: ProfileSaveCategories,
    pub embedded_auralyn_preset: Preset,
    pub obs: Option<crate::obs_setup::bundle::Saved>,
    /// dB形式では表せない完全な0も、入出力カテゴリだけで保持する。
    pub level_intent: Option<LevelIntent>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Confirmation {
    pub checked_at_unix_ms: u64,
    pub usage: String,
    pub location: String,
    pub preparation: crate::ipc::PreparationSnapshot,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LevelIntent {
    pub input_gain: f32,
    pub output_gain: f32,
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.trim() != name
        || name.is_empty()
        || name.len() > 120
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || name == "."
        || name == ".."
    {
        return Err("配信状態名は120文字以内で入力してください（パス記号は使えません）".into());
    }
    Ok(())
}
pub fn validate(bundle: &BundleV1) -> Result<(), String> {
    validate_name(&bundle.name)?;
    if !matches!(
        (
            bundle.schema_version,
            bundle.output.is_some(),
            bundle.live.is_some(),
            bundle.process.is_some()
        ),
        (1, false, false, false)
            | (2, true, false, false)
            | (3, true, true, false)
            | (4, false, false, true)
    ) || bundle.revision.is_empty()
    {
        return Err("対応していない配信状態です".into());
    }
    if let Some(output) = &bundle.output {
        output.validate()?;
        let c = &bundle.categories;
        if !(c.include_plugins
            && c.include_audio_config
            && c.include_noise_control
            && c.include_builtin_fx)
        {
            return Err("分離出力の保存には全カテゴリが必要です".into());
        }
    }
    if let Some(process) = &bundle.process {
        process.validate()?;
        let c = &bundle.categories;
        let audio = bundle
            .embedded_auralyn_preset
            .audio_config
            .as_ref()
            .ok_or("入出力設定がありません")?;
        if !(c.include_plugins
            && c.include_audio_config
            && c.include_noise_control
            && c.include_builtin_fx)
            || !audio.host.eq_ignore_ascii_case("wasapi")
            || audio.input_device.is_some()
            || audio.output_device.is_none()
        {
            return Err("プロセス入力の保存にはWASAPIの単独出力と全カテゴリが必要です".into());
        }
    }
    if let Some(live) = &bundle.live {
        live.validate(bundle.output.as_ref().ok_or("出力構成がありません")?)?;
        if !bundle
            .embedded_auralyn_preset
            .builtin_fx
            .as_ref()
            .is_some_and(|actual| live.matches_builtin(actual))
        {
            return Err("選択中モードと配信用の内蔵設定が一致しません".into());
        }
    }
    if bundle.embedded_auralyn_preset.plugins.len() > crate::audio_engine::plugins::MAX_PLUGINS {
        return Err("VST数の上限を超えています".into());
    }
    if let Some(receipt) = &bundle.confirmation {
        if receipt.checked_at_unix_ms == 0
            || !["obs", "discord", "other", "listening"].contains(&receipt.usage.as_str())
            || !["home", "venue"].contains(&receipt.location.as_str())
            || receipt.preparation.engine_epoch.is_empty()
            || receipt.preparation.controls_pending
            || receipt.preparation.muted
            || ![
                receipt.preparation.input_gain,
                receipt.preparation.output_gain,
            ]
            .iter()
            .all(|g| g.is_finite() && (0.0..=2.0).contains(g))
        {
            return Err("確認履歴の形式が不正です".into());
        }
    }
    let c = &bundle.categories;
    let preset = &bundle.embedded_auralyn_preset;
    if (!c.include_plugins && !preset.plugins.is_empty())
        || c.include_audio_config != preset.audio_config.is_some()
        || c.include_audio_config != bundle.level_intent.is_some()
        || c.include_noise_control != preset.noise_control.is_some()
        || c.include_builtin_fx != preset.builtin_fx.is_some()
    {
        return Err("保存カテゴリと埋め込み設定の有無が一致しません".into());
    }
    if !matches!(preset.schema_version, 1 | 2) {
        return Err("埋め込みプロファイルの形式に対応していません".into());
    }
    for plugin in &preset.plugins {
        if plugin.path.is_empty()
            || !plugin.gain.is_finite()
            || !(0.0..=2.0).contains(&plugin.gain)
            || plugin.state.is_none()
        {
            return Err("保存されたVST状態が不正または未取得です".into());
        }
    }
    if let Some(audio) = &preset.audio_config {
        if !["ASIO", "WASAPI", "Wasapi"].contains(&audio.host.as_str())
            || audio.sample_rate == 0
            || audio.buffer_size == 0
            || audio.buffer_size > 65_536
            || audio.input_channels.len() != 2
            || !audio.input_gain_db.is_finite()
            || !audio.master_gain_db.is_finite()
        {
            return Err("保存された入出力設定が不正です".into());
        }
    }
    if let Some(noise) = &preset.noise_control {
        if !noise.strength.is_finite()
            || !(0.0..=1.25).contains(&noise.strength)
            || noise.learned_profile.is_some()
            || !["low", "high", "smart", "venue"].contains(&noise.mode.as_str())
        {
            return Err("保存されたノイズ低減設定が不正です".into());
        }
    }
    if let Some(fx) = &preset.builtin_fx {
        let preset = match fx.preset.as_str() {
            "broadcast" => crate::audio_engine::builtin::Preset::Broadcast,
            "warm" => crate::audio_engine::builtin::Preset::Warm,
            "bright" => crate::audio_engine::builtin::Preset::Bright,
            "singing" => crate::audio_engine::builtin::Preset::Singing,
            _ => return Err("内蔵処理の種類が不正です".into()),
        };
        crate::audio_engine::builtin::Config {
            active: fx.enabled,
            preset,
            amount: fx.amount,
            singing: fx.singing,
            reverb: fx.reverb,
        }
        .normalize()?;
    }
    if let Some(level) = &bundle.level_intent {
        if !c.include_audio_config
            || ![level.input_gain, level.output_gain]
                .iter()
                .all(|v| v.is_finite() && (0.0..=2.0).contains(v))
        {
            return Err("保存された入出力音量が不正です".into());
        }
    }
    if !(c.include_plugins
        || c.include_audio_config
        || c.include_noise_control
        || c.include_builtin_fx)
    {
        return Err("Auralynの保存カテゴリを選んでください".into());
    }
    if let Some(obs) = &bundle.obs {
        crate::obs_setup::bundle::validate(obs)?;
    }
    Ok(())
}
fn path(root: &Path, name: &str) -> Result<PathBuf, String> {
    validate_name(name)?;
    Ok(root.join("broadcast-bundles").join(format!("{name}.json")))
}
pub fn revision() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!(
        "{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

// 未完了の配信状態操作だけを追跡する。Undo tokenやOBS接続情報は保存しない。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryReceipt {
    pub version: u8,
    pub backup_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub devices: Option<RecoveryDevices>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeOrigin>,
}
/// 退避元は来歴であり、新しいEngineへの適用権限ではない。state本体は含めない。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeOrigin {
    pub version: u8,
    pub source_epoch: u64,
    pub source_control_revision: String,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryDevices {
    pub input_id: String,
    pub output_id: String,
}
fn recovery_path(root: &Path) -> PathBuf {
    root.join("broadcast-bundle-recovery.json")
}
pub(crate) fn recovery_exists(root: &Path) -> Result<bool, String> {
    recovery_path(root).try_exists().map_err(|e| e.to_string())
}
pub(crate) fn read_recovery(root: &Path) -> Result<Option<RecoveryReceipt>, String> {
    let path = recovery_path(root);
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 4096 {
        return Err("配信状態の復旧情報が不正です".into());
    }
    let receipt: RecoveryReceipt =
        serde_json::from_slice(&bytes).map_err(|_| "配信状態の復旧情報を読み込めません")?;
    if receipt.version != 1 {
        return Err("配信状態の復旧情報の版に対応していません".into());
    }
    validate_name(&receipt.backup_name)?;
    if receipt
        .devices
        .as_ref()
        .is_some_and(|d| d.input_id.is_empty() || d.output_id.is_empty())
    {
        return Err("配信状態の復旧機器IDが不正です".into());
    }
    if let Some(origin) = &receipt.runtime {
        if origin.version != 1
            || origin.source_epoch == 0
            || origin.source_control_revision.is_empty()
            || origin.source_control_revision.len() > 256
            || !origin
                .source_control_revision
                .bytes()
                .all(|c| c.is_ascii_digit() || c == b':')
            || origin.sha256.len() != 64
            || !origin.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || receipt.devices.is_none()
        {
            return Err("未保存状態の退避情報に対応していません".into());
        }
    }
    Ok(Some(receipt))
}
pub(crate) fn reserve_recovery(
    root: &Path,
    backup_name: &str,
    devices: Option<RecoveryDevices>,
) -> Result<(), String> {
    validate_name(backup_name)?;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let receipt = RecoveryReceipt {
        version: 1,
        backup_name: backup_name.to_owned(),
        devices,
        runtime: None,
    };
    reserve_receipt(root, &receipt)
}
fn reserve_receipt(root: &Path, receipt: &RecoveryReceipt) -> Result<(), String> {
    let bytes = serde_json::to_vec(&receipt).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(recovery_path(root))
        .map_err(|_| "未解決の配信状態の原本があります。先に確認してください".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

pub(crate) fn content_digest(bundle: &BundleV1) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(bundle).map_err(|e| e.to_string())?)
    ))
}

pub(crate) fn load_recovery_backup(
    root: &Path,
    receipt: &RecoveryReceipt,
) -> Result<BundleV1, String> {
    let original = load(&root.join("broadcast-bundle-backups"), &receipt.backup_name)?;
    if let Some(origin) = &receipt.runtime {
        validate_runtime_original(&original)?;
        if content_digest(&original)? != origin.sha256 {
            return Err("退避した未保存設定が変更されています。原本を確認してください".into());
        }
    }
    Ok(original)
}

fn validate_runtime_original(original: &BundleV1) -> Result<(), String> {
    validate(original)?;
    let categories = &original.categories;
    if !(categories.include_plugins
        && categories.include_audio_config
        && categories.include_noise_control
        && categories.include_builtin_fx)
        || original.output.is_some()
        || original.live.is_some()
        || original.process.is_some()
        || original.obs.is_some()
        || original.confirmation.is_some()
        || original
            .embedded_auralyn_preset
            .audio_config
            .as_ref()
            .is_none_or(|audio| {
                audio
                    .input_device
                    .as_ref()
                    .is_none_or(|name| name.is_empty())
                    || audio
                        .output_device
                        .as_ref()
                        .is_none_or(|name| name.is_empty())
            })
    {
        return Err("未保存設定の退避範囲に対応していません".into());
    }
    Ok(())
}

pub(crate) struct RuntimeReservation {
    root: PathBuf,
    file: std::fs::File,
    receipt: RecoveryReceipt,
}

/// 高価なcomponent state取得前に未完了情報だけを確保する。失敗時も削除しない。
pub(crate) fn reserve_runtime_intent(
    root: &Path,
    backup_name: &str,
    devices: RecoveryDevices,
    source_epoch: u64,
) -> Result<RuntimeReservation, String> {
    validate_name(backup_name)?;
    if devices.input_id.is_empty() || devices.output_id.is_empty() || source_epoch == 0 {
        return Err("未保存設定の取得元を確認できません".into());
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let receipt = RecoveryReceipt {
        version: 1,
        backup_name: backup_name.into(),
        devices: Some(devices),
        runtime: Some(RuntimeOrigin {
            version: 1,
            source_epoch,
            source_control_revision: "0".into(),
            sha256: "0".repeat(64),
        }),
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // 取得中に別操作から未完了情報を消したり置き換えたりできないよう保持する。
        options.share_mode(0);
    }
    let mut file = options
        .open(recovery_path(root))
        .map_err(|_| "未解決の復旧原本があります。先に確認してください")?;
    use std::io::Write;
    file.write_all(&serde_json::to_vec(&receipt).map_err(|e| e.to_string())?)
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(RuntimeReservation {
        root: root.to_path_buf(),
        file,
        receipt,
    })
}

pub(crate) fn finish_runtime_recovery(
    root: &Path,
    original: &BundleV1,
    mut reservation: RuntimeReservation,
    source_control_revision: String,
) -> Result<(), String> {
    if root != reservation.root
        || original.name != reservation.receipt.backup_name
        || source_control_revision.is_empty()
        || source_control_revision.len() > 256
        || !source_control_revision
            .bytes()
            .all(|c| c.is_ascii_digit() || c == b':')
    {
        return Err("未保存設定の取得元が変わりました。未完了情報を保持しています".into());
    }
    validate_runtime_original(original)?;
    let backup_root = root.join("broadcast-bundle-backups");
    save_with_overwrite(&backup_root, original, false)?;
    let expected = content_digest(original)?;
    let stored = load(&backup_root, &original.name)?;
    if content_digest(&stored)? != expected {
        return Err("未保存設定の読み戻しを確認できません。音声は変更していません".into());
    }
    let origin = reservation
        .receipt
        .runtime
        .as_mut()
        .ok_or("退避情報がありません")?;
    origin.sha256 = expected;
    origin.source_control_revision = source_control_revision;
    let bytes = serde_json::to_vec(&reservation.receipt).map_err(|e| e.to_string())?;
    use std::io::{Seek, SeekFrom, Write};
    // 公開前の破損や中断は読み取り不能として残す。原本自体は削除しない。
    reservation
        .file
        .seek(SeekFrom::Start(0))
        .and_then(|_| reservation.file.set_len(0))
        .and_then(|()| reservation.file.write_all(&bytes))
        .and_then(|()| reservation.file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(reservation);
    let receipt = read_recovery(root)?.ok_or("退避の完了情報を確認できません")?;
    load_recovery_backup(root, &receipt)?;
    Ok(())
}
pub(crate) fn resolve_recovery(root: &Path, expected: Option<&str>) -> Result<(), String> {
    let path = recovery_path(root);
    let actual = read_recovery(root);
    match (actual, expected) {
        (Ok(Some(receipt)), Some(id)) if receipt.backup_name == id => {}
        (Err(_), None) if recovery_exists(root)? => {}
        _ => return Err("復旧情報が変更されました。読み直してください".into()),
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}
pub fn save(root: &Path, bundle: &BundleV1) -> Result<(), String> {
    save_with_overwrite(root, bundle, true)
}
pub fn ensure_save_allowed(root: &Path, name: &str, overwrite: bool) -> Result<(), String> {
    if path(root, name)?.try_exists().map_err(|e| e.to_string())? && !overwrite {
        return Err("同名の配信状態があります。上書きを明示してから保存してください".into());
    }
    Ok(())
}
pub fn save_with_overwrite(root: &Path, bundle: &BundleV1, overwrite: bool) -> Result<(), String> {
    validate(bundle)?;
    ensure_save_allowed(root, &bundle.name, overwrite)?;
    let bytes = serde_json::to_vec(bundle).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err("配信状態のサイズ上限を超えています".into());
    }
    let path = path(root, &bundle.name)?;
    std::fs::create_dir_all(path.parent().ok_or("保存先が不正です")?).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", revision()));
    use std::io::Write;
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        // Windowsでもrename前に自分の保存handleを閉じる。
        drop(file);
        if overwrite {
            std::fs::rename(&temp, &path).map_err(|e| e.to_string())
        } else {
            // 同じ保存先が取得後に作られても、未確認の原本を置換しない。
            let mut destination = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            let written = destination
                .write_all(&bytes)
                .and_then(|()| destination.sync_all());
            drop(destination);
            if let Err(error) = written {
                let _ = std::fs::remove_file(&path);
                return Err(error.to_string());
            }
            std::fs::remove_file(&temp).map_err(|e| e.to_string())
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
pub fn load(root: &Path, name: &str) -> Result<BundleV1, String> {
    let bytes = std::fs::read(path(root, name)?).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err("配信状態のサイズ上限を超えています".into());
    }
    let bundle =
        serde_json::from_slice(&bytes).map_err(|_| "配信状態を読み込めません".to_string())?;
    validate(&bundle)?;
    if bundle.name != name {
        return Err("ファイル名と配信状態名が一致しません".into());
    }
    Ok(bundle)
}
pub fn list(root: &Path) -> Result<Vec<String>, String> {
    let directory = root.join("broadcast-bundles");
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut names = vec![];
    for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json") {
            if let Some(name) = path.file_stem().and_then(|n| n.to_str()) {
                names.push(name.to_owned());
            }
        }
    }
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_bundle_roundtrips_and_never_accepts_mixed_or_incomplete_schemas() {
        let mut value = runtime_sample();
        assert!(validate(&value).is_ok());
        value.output = Some(OutputConfiguration {
            version: 1,
            devices: RecoveryDevices {
                input_id: "mic-id".into(),
                output_id: "monitor-id".into(),
            },
            config: crate::audio_engine::live_output::Config {
                device_id: Some("broadcast-id".into()),
                monitor_trim: 0.0,
                broadcast_trim: 0.4,
                monitor_muted: true,
                ..Default::default()
            },
        });
        assert!(validate(&value).is_err()); // 旧schemaへ新しい値を混ぜない。
        value.schema_version = 2;
        validate(&value).unwrap();
        let root = std::env::temp_dir().join(format!("auralyn-output-schema-{}", revision()));
        save_with_overwrite(&root, &value, false).unwrap();
        let stored = load(&root, &value.name).unwrap();
        assert_eq!(stored.output, value.output);
        let mut full = value.clone();
        full.live = Some(LiveConfiguration {
            version: 1,
            definitions: Default::default(),
            target: None,
            monitor: None,
            singing_plugins: None,
            talk_plugins: None,
        });
        assert!(validate(&full).is_err());
        full.schema_version = 3;
        validate(&full).unwrap();
        save_with_overwrite(&root, &full, true).unwrap();
        assert_eq!(load(&root, &full.name).unwrap().live, full.live);
        assert!(validate_runtime_original(&full).is_err());
        let mut invalid = value.clone();
        invalid.output = None;
        assert!(validate(&invalid).is_err());
        invalid = value.clone();
        invalid.output.as_mut().unwrap().version = 2;
        assert!(validate(&invalid).is_err());
        invalid = value.clone();
        invalid.categories.include_builtin_fx = false;
        invalid.embedded_auralyn_preset.builtin_fx = None;
        assert!(validate(&invalid).is_err());
        invalid = value.clone();
        invalid.output.as_mut().unwrap().config.device_id = Some("monitor-id".into());
        assert!(validate(&invalid).is_err());
        assert!(validate_runtime_original(&value).is_err()); // 一時退避の旧範囲を広げない。
        std::fs::remove_file(path(&root, &value.name).unwrap()).unwrap();
        std::fs::remove_dir(root.join("broadcast-bundles")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn process_bundle_roundtrip_requires_all_categories_and_never_mixes_device_or_mode_schema() {
        let mut value = runtime_sample();
        value.schema_version = 4;
        value.process = Some(ProcessConfiguration {
            version: 1,
            source: crate::input_source::ProcessConfig {
                app_key: "a".repeat(64),
                app_name: "player.exe".into(),
                raw_endpoint_id: "raw-id".into(),
                purpose: crate::input_source::Purpose::Music,
            },
            output_id: "wasapi:monitor-id".into(),
        });
        let audio = value.embedded_auralyn_preset.audio_config.as_mut().unwrap();
        audio.host = "Wasapi".into();
        audio.input_device = None;
        audio.output_device = Some("Monitor".into());
        validate(&value).unwrap();
        let root = std::env::temp_dir().join(format!("auralyn-process-schema-{}", revision()));
        save(&root, &value).unwrap();
        assert_eq!(load(&root, &value.name).unwrap().process, value.process);
        assert!(validate_runtime_original(&value).is_err());
        let mut invalid = value.clone();
        invalid.schema_version = 1;
        assert!(validate(&invalid).is_err());
        invalid = value.clone();
        invalid.categories.include_plugins = false;
        invalid.embedded_auralyn_preset.plugins.clear();
        assert!(validate(&invalid).is_err());
        invalid = value.clone();
        invalid
            .embedded_auralyn_preset
            .audio_config
            .as_mut()
            .unwrap()
            .input_device = Some("must-not-select-microphone".into());
        assert!(validate(&invalid).is_err());
        std::fs::remove_file(path(&root, &value.name).unwrap()).unwrap();
        std::fs::remove_dir(root.join("broadcast-bundles")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn runtime_capture_intent_survives_interruption_and_blocks_replacement() {
        let root = std::env::temp_dir().join(format!("auralyn-runtime-intent-{}", revision()));
        let reservation = reserve_runtime_intent(
            &root,
            "pending",
            RecoveryDevices {
                input_id: "input-id".into(),
                output_id: "output-id".into(),
            },
            1,
        )
        .unwrap();
        assert!(recovery_exists(&root).unwrap());
        #[cfg(windows)]
        assert!(read_recovery(&root).is_err()); // 取得中の削除・置換も共有モードで拒否する。
        assert!(reserve_recovery(&root, "replacement", None).is_err());
        drop(reservation); // component state取得中に終了しても、確認待ちの情報を残す。
        let receipt = read_recovery(&root).unwrap().unwrap();
        assert!(receipt.runtime.is_some());
        assert!(load_recovery_backup(&root, &receipt).is_err());
        let unchanged = std::fs::read(recovery_path(&root)).unwrap();
        assert!(
            reserve_runtime_intent(&root, "replacement", receipt.devices.clone().unwrap(), 2)
                .is_err()
        );
        assert_eq!(std::fs::read(recovery_path(&root)).unwrap(), unchanged);
        resolve_recovery(&root, Some("pending")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn runtime_original_is_read_back_private_and_checked_before_recovery() {
        let root = std::env::temp_dir().join(format!("auralyn-runtime-original-{}", revision()));
        let mut original = runtime_sample();
        let secret_state = "bG9jYWwtcHJpdmF0ZS1zdGF0ZQ==";
        original.embedded_auralyn_preset.plugins.push(PresetPlugin {
            path: "private-plugin.vst3".into(),
            name: "private".into(),
            vendor: String::new(),
            version: String::new(),
            enabled: true,
            muted: false,
            gain: 0.25,
            state: Some(secret_state.into()),
        });
        let reservation = reserve_runtime_intent(
            &root,
            &original.name,
            RecoveryDevices {
                input_id: "input-id".into(),
                output_id: "output-id".into(),
            },
            7,
        )
        .unwrap();
        finish_runtime_recovery(&root, &original, reservation, "1:2:3:4".into()).unwrap();
        let receipt = read_recovery(&root).unwrap().unwrap();
        assert_eq!(receipt.runtime.as_ref().unwrap().source_epoch, 7);
        let marker = std::fs::read_to_string(recovery_path(&root)).unwrap();
        assert!(!marker.contains(secret_state) && !marker.contains("private-plugin"));
        let restored = load_recovery_backup(&root, &receipt).unwrap();
        assert_eq!(
            restored.embedded_auralyn_preset,
            original.embedded_auralyn_preset
        );
        let backup_root = root.join("broadcast-bundle-backups");
        original.embedded_auralyn_preset.plugins[0].gain = 0.75; // 同じrevisionでも後編集を拒否する。
        save(&backup_root, &original).unwrap();
        assert!(load_recovery_backup(&root, &receipt).is_err());
        assert_eq!(
            std::fs::read_to_string(recovery_path(&root)).unwrap(),
            marker
        );
        resolve_recovery(&root, Some(&original.name)).unwrap();
        assert!(path(&backup_root, &original.name).unwrap().exists()); // 明示採用しても原本は削除しない。
    }

    #[test]
    fn failed_runtime_save_keeps_intent_and_unknown_scope_is_not_accepted_as_legacy() {
        let root = std::env::temp_dir().join(format!("auralyn-runtime-failed-{}", revision()));
        let original = sample();
        let reservation = reserve_runtime_intent(
            &root,
            "different-name",
            RecoveryDevices {
                input_id: "input-id".into(),
                output_id: "output-id".into(),
            },
            1,
        )
        .unwrap();
        assert!(finish_runtime_recovery(&root, &original, reservation, "1".into()).is_err());
        let receipt = read_recovery(&root).unwrap().unwrap();
        assert!(load_recovery_backup(&root, &receipt).is_err());
        let mut unknown = serde_json::to_value(&receipt).unwrap();
        unknown["runtime"]["version"] = serde_json::json!(2);
        std::fs::write(recovery_path(&root), serde_json::to_vec(&unknown).unwrap()).unwrap();
        assert!(read_recovery(&root).is_err());
        assert!(reserve_recovery(&root, "replacement", None).is_err());
        resolve_recovery(&root, None).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn runtime_write_failure_does_not_publish_a_readable_or_replacement_original() {
        let root = std::env::temp_dir().join(format!("auralyn-runtime-io-fail-{}", revision()));
        let original = runtime_sample();
        let blocked = path(&root.join("broadcast-bundle-backups"), &original.name).unwrap();
        std::fs::create_dir_all(&blocked).unwrap(); // 新規ファイルを確保できない実I/O失敗。
        let reservation = reserve_runtime_intent(
            &root,
            &original.name,
            RecoveryDevices {
                input_id: "input-id".into(),
                output_id: "output-id".into(),
            },
            1,
        )
        .unwrap();
        assert!(finish_runtime_recovery(&root, &original, reservation, "1".into()).is_err());
        let receipt = read_recovery(&root).unwrap().unwrap();
        assert!(load_recovery_backup(&root, &receipt).is_err());
        assert!(reserve_recovery(&root, "replacement", None).is_err());
        assert!(blocked.is_dir());
    }
    #[test]
    fn unresolved_receipt_survives_reload_and_cannot_be_replaced_or_implicitly_removed() {
        let root = std::env::temp_dir().join(format!("auralyn-bundle-recovery-{}", revision()));
        reserve_recovery(
            &root,
            "original-a",
            Some(RecoveryDevices {
                input_id: "input-a".into(),
                output_id: "output-a".into(),
            }),
        )
        .unwrap();
        assert_eq!(
            read_recovery(&root).unwrap().unwrap().backup_name,
            "original-a"
        );
        assert_eq!(
            read_recovery(&root)
                .unwrap()
                .unwrap()
                .devices
                .unwrap()
                .input_id,
            "input-a"
        );
        assert!(reserve_recovery(&root, "original-b", None).is_err());
        assert!(resolve_recovery(&root, Some("original-b")).is_err());
        assert_eq!(
            read_recovery(&root).unwrap().unwrap().backup_name,
            "original-a"
        );
        resolve_recovery(&root, Some("original-a")).unwrap();
        assert!(!recovery_exists(&root).unwrap());
    }
    #[test]
    fn corrupt_receipt_still_blocks_replacement_until_explicit_adoption() {
        let root = std::env::temp_dir().join(format!("auralyn-bundle-corrupt-{}", revision()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(recovery_path(&root), b"not-json").unwrap();
        assert!(read_recovery(&root).is_err());
        assert!(reserve_recovery(&root, "replacement", None).is_err());
        assert!(resolve_recovery(&root, Some("replacement")).is_err());
        resolve_recovery(&root, None).unwrap();
        assert!(!recovery_exists(&root).unwrap());
    }

    #[test]
    fn legacy_receipt_is_retained_but_has_no_recoverable_device_identity() {
        let root = std::env::temp_dir().join(format!("auralyn-legacy-receipt-{}", revision()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            recovery_path(&root),
            br#"{"version":1,"backupName":"original"}"#,
        )
        .unwrap();
        let receipt = read_recovery(&root).unwrap().unwrap();
        assert_eq!(receipt.backup_name, "original");
        assert_eq!(receipt.devices, None);
        assert!(reserve_recovery(&root, "new", None).is_err());
        resolve_recovery(&root, Some("original")).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    fn runtime_sample() -> BundleV1 {
        let mut value = sample();
        value.categories = ProfileSaveCategories {
            include_plugins: true,
            include_audio_config: true,
            include_noise_control: true,
            include_builtin_fx: true,
        };
        value.level_intent = Some(LevelIntent {
            input_gain: 0.0,
            output_gain: 0.25,
        });
        value.embedded_auralyn_preset.audio_config =
            Some(crate::vst_host::presets::ProfileAudioConfig {
                host: "WASAPI".into(),
                input_device: Some("Mic".into()),
                output_device: Some("Phones".into()),
                sample_rate: 48000,
                buffer_size: 512,
                input_channels: vec![0, 1],
                output_routing: Default::default(),
                input_gain_db: -120.0,
                master_gain_db: -12.0412,
            });
        value.embedded_auralyn_preset.noise_control =
            Some(crate::vst_host::presets::ProfileNoiseControl {
                enabled: true,
                mode: "low".into(),
                strength: 0.8,
                voice_guard: true,
                learned_profile: None,
            });
        value.embedded_auralyn_preset.builtin_fx =
            Some(crate::vst_host::presets::ProfileBuiltinFx {
                preset: "broadcast".into(),
                enabled: false,
                amount: 0.7,
                singing: None,
                reverb: None,
            });
        value
    }
    fn sample() -> BundleV1 {
        BundleV1 {
            process: None,
            live: None,
            output: None,
            schema_version: 1,
            revision: revision(),
            name: "歌配信".into(),
            categories: ProfileSaveCategories {
                include_plugins: true,
                ..Default::default()
            },
            embedded_auralyn_preset: Preset {
                plugins_included: Some(true),
                schema_version: 2,
                name: "歌配信".into(),
                plugins: vec![],
                audio_config: None,
                noise_control: None,
                builtin_fx: None,
            },
            obs: None,
            confirmation: None,
            level_intent: None,
        }
    }
    #[test]
    fn size_boundary_round_trips_and_oversized_saves_preserve_the_original() {
        let root = std::env::temp_dir().join(format!("auralyn-bundle-size-{}", revision()));
        assert!(root.is_absolute() && root.starts_with(std::env::temp_dir()));
        let mut bundle = sample();
        bundle.embedded_auralyn_preset.plugins.push(PresetPlugin {
            path: "size-boundary.vst3".into(),
            name: "boundary".into(),
            vendor: String::new(),
            version: String::new(),
            enabled: true,
            muted: false,
            gain: 1.,
            state: Some(String::new()),
        });
        let overhead = serde_json::to_vec(&bundle).unwrap().len();
        // 有効なBase64の長さを保ち、JSON全体を上限ちょうどにする。
        let padding = (MAX_BUNDLE_BYTES - overhead) % 4;
        bundle.revision.push_str(&"x".repeat(padding));
        let state_len = MAX_BUNDLE_BYTES - overhead - padding;
        bundle.embedded_auralyn_preset.plugins[0].state = Some("A".repeat(state_len));
        save_with_overwrite(&root, &bundle, false).unwrap();
        let stored_path = path(&root, &bundle.name).unwrap();
        assert_eq!(
            std::fs::metadata(&stored_path).unwrap().len(),
            MAX_BUNDLE_BYTES as u64
        );
        let loaded = load(&root, &bundle.name).unwrap();
        assert!(loaded.embedded_auralyn_preset.plugins == bundle.embedded_auralyn_preset.plugins);
        drop(loaded);
        let original = std::fs::read(&stored_path).unwrap();
        bundle.embedded_auralyn_preset.plugins[0]
            .state
            .as_mut()
            .unwrap()
            .push_str("AAAA");
        assert_eq!(
            save_with_overwrite(&root, &bundle, true).unwrap_err(),
            "配信状態のサイズ上限を超えています"
        );
        assert!(std::fs::read(&stored_path).unwrap() == original);
        bundle.name.push_str("-new");
        assert_eq!(
            save_with_overwrite(&root, &bundle, false).unwrap_err(),
            "配信状態のサイズ上限を超えています"
        );
        assert!(!path(&root, &bundle.name).unwrap().exists());
        assert_eq!(
            std::fs::read_dir(root.join("broadcast-bundles"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unconfirmed_existing_save_never_overwrites_including_windows_case_alias() {
        let root = std::env::temp_dir().join(format!("auralyn-bundle-overwrite-{}", revision()));
        let mut original = sample();
        original.name = "Live".into();
        save_with_overwrite(&root, &original, false).unwrap();
        let original_bytes = std::fs::read(path(&root, "Live").unwrap()).unwrap();
        let mut updated = original.clone();
        updated.revision = revision();
        assert!(save_with_overwrite(&root, &updated, false).is_err());
        assert_eq!(
            std::fs::read(path(&root, "Live").unwrap()).unwrap(),
            original_bytes
        );
        #[cfg(windows)]
        {
            updated.name = "live".into();
            assert!(save_with_overwrite(&root, &updated, false).is_err());
            assert_eq!(
                std::fs::read(path(&root, "Live").unwrap()).unwrap(),
                original_bytes
            );
            updated.name = "Live".into();
        }
        save_with_overwrite(&root, &updated, true).unwrap();
        assert_eq!(load(&root, "Live").unwrap().revision, updated.revision);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn explicit_empty_rack_is_distinct_from_omitted_category_and_capture_failure_keeps_original() {
        let root = std::env::temp_dir().join(format!("auralyn-bundle-{}", revision()));
        let original = sample();
        save(&root, &original).unwrap();
        let stored = std::fs::read(path(&root, &original.name).unwrap()).unwrap();
        let mut invalid = original.clone();
        invalid.schema_version = 2;
        assert!(save(&root, &invalid).is_err());
        assert_eq!(
            std::fs::read(path(&root, &original.name).unwrap()).unwrap(),
            stored
        );
        let restored = load(&root, &original.name).unwrap();
        assert!(restored.categories.include_plugins);
        assert!(restored.embedded_auralyn_preset.plugins.is_empty());
        let mut next = original.clone();
        next.revision = revision();
        save(&root, &next).unwrap();
        assert_eq!(load(&root, &original.name).unwrap().revision, next.revision);
        assert!(validate_name("../other").is_err());
        assert!(root.is_absolute() && root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exact_zero_levels_and_only_allowed_obs_schema_round_trip_without_export() {
        let mut bundle = sample();
        bundle.categories.include_audio_config = true;
        bundle.level_intent = Some(LevelIntent {
            input_gain: 0.,
            output_gain: 0.,
        });
        let json = serde_json::to_value(&bundle).unwrap();
        let parsed: BundleV1 = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.level_intent.unwrap().output_gain, 0.);
        let mut json = serde_json::to_value(sample()).unwrap();
        json["password"] = serde_json::json!("not-allowed");
        assert!(serde_json::from_value::<BundleV1>(json).is_err());
    }
    #[test]
    fn categories_payload_and_filename_must_agree_before_any_apply() {
        let mut value = sample();
        assert!(validate(&value).is_ok());
        value.categories.include_noise_control = true;
        assert!(validate(&value).is_err());
        value.categories.include_noise_control = false;
        value.level_intent = Some(LevelIntent {
            input_gain: 0.,
            output_gain: 0.,
        });
        assert!(validate(&value).is_err());
        value.level_intent = None;
        value.categories.include_audio_config = true;
        assert!(validate(&value).is_err());
        let root = std::env::temp_dir().join(format!("auralyn-bundle-schema-{}", revision()));
        let value = sample();
        save(&root, &value).unwrap();
        let stored = path(&root, &value.name).unwrap();
        let wrong = path(&root, "different").unwrap();
        std::fs::copy(stored, wrong).unwrap();
        assert!(load(&root, "different").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
