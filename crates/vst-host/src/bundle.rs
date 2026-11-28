//! 配信状態のローカル保存。VST component stateは機密扱いし、export/logへ出さない。
use crate::vst_host::presets::{Preset, PresetPlugin, ProfileSaveCategories};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
pub(crate) mod mixing_configuration;
pub(crate) use mixing_configuration::MixingConfiguration;
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
    pub(crate) mixing: Option<MixingConfiguration>,
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
            bundle.process.is_some(),
            bundle.mixing.is_some()
        ),
        (1, false, false, false, false)
            | (2, true, false, false, false)
            | (3, true, true, false, false)
            | (4, false, false, true, false)
            | (5, true, true, false, true)
    ) || bundle.revision.is_empty()
    {
        return Err("対応していない配信状態です".into());
    }
    if let Some(mixing) = &bundle.mixing {
        mixing.validate()?;
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
            deesser: fx.deesser,
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryDevices {
    pub input_id: String,
    pub output_id: String,
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

    fn mixing_sample() -> BundleV1 {
        use super::mixing_configuration::PostMixPreset;
        use crate::audio_engine::mixing::{Config, Levels};
        let mut original = runtime_sample();
        original.schema_version = 5;
        original.output = Some(OutputConfiguration {
            version: 1,
            devices: RecoveryDevices {
                input_id: "input-id".into(),
                output_id: "output-id".into(),
            },
            config: Default::default(),
        });
        original.live = Some(LiveConfiguration {
            version: 1,
            definitions: Default::default(),
            target: None,
            monitor: None,
            singing_plugins: None,
            talk_plugins: None,
        });
        original.mixing = Some(MixingConfiguration {
            version: 1,
            input: Some(Config {
                version: 1,
                source: serde_json::from_value(serde_json::json!({ "kind": "device", "config": { "host": "WASAPI", "inputId": "music-id", "inputChannels": [0, 1] } })).unwrap(),
                levels: Levels::default(),
            }),
            post_mix: PostMixPreset {
                schema_version: 1,
                role: "post_mix".into(),
                enabled: true,
                plugins: vec![],
            },
        });
        original
    }
    fn private_plugin(state: &str) -> PresetPlugin {
        PresetPlugin {
            path: "plugin.vst3".into(),
            name: "test".into(),
            vendor: String::new(),
            version: String::new(),
            enabled: true,
            muted: false,
            gain: 1.0,
            state: Some(state.into()),
            class_id: None,
        }
    }
    #[test]
    fn mixing_schema_round_trip_and_strict_input() {
        let original = mixing_sample();
        assert!(validate(&original).is_ok());
        let json = serde_json::to_value(&original).unwrap();
        let restored: BundleV1 = serde_json::from_value(json.clone()).unwrap();
        assert!(restored.mixing == original.mixing);
        for schema in 1..=4 {
            let mut old = original.clone();
            old.schema_version = schema;
            assert!(validate(&old).is_err());
        }
        let mut none = original.clone();
        none.mixing.as_mut().unwrap().input = None;
        assert!(validate(&none).is_err());
        none.mixing.as_mut().unwrap().post_mix.enabled = false;
        assert!(validate(&none).is_ok());
        for field in ["pid", "target", "instanceId"] {
            let mut forged = json.clone();
            forged["mixing"]["input"][field] = serde_json::json!(123);
            assert!(serde_json::from_value::<BundleV1>(forged).is_err());
        }
        let mut bad = original.clone();
        bad.mixing.as_mut().unwrap().post_mix.role = "voice".into();
        assert!(validate(&bad).is_err());
        bad = original.clone();
        bad.mixing
            .as_mut()
            .unwrap()
            .post_mix
            .plugins
            .push(private_plugin("state"));
        bad.mixing.as_mut().unwrap().post_mix.plugins[0].gain = 2.01;
        assert!(validate(&bad).is_err());
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
                deesser: None,
            });
        value
    }
    fn sample() -> BundleV1 {
        BundleV1 {
            mixing: None,
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
            class_id: None,
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
