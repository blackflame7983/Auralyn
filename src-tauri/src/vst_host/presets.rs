use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const BACKUP_PROFILE_NAME: &str = "__backup_previous";

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct PresetPlugin {
    pub path: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub enabled: bool,
    pub muted: bool,
    pub gain: f32,
    pub state: Option<String>, // Base64
}

/// v2 拡張: オーディオデバイス設定
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAudioConfig {
    pub host: String,
    #[serde(rename = "inputDevice")]
    pub input_device: Option<String>,
    #[serde(rename = "outputDevice")]
    pub output_device: Option<String>,
    pub sample_rate: u32,
    pub buffer_size: u32,
    pub input_channels: Vec<usize>,
    pub input_gain_db: f32,
    pub master_gain_db: f32,
}

/// v2 拡張: AI ノイズ抑制設定
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileNoiseControl {
    pub enabled: bool,
    pub mode: String,
    /// プラン上の `mix` と既存 IPC の `strength` の両方を受け付ける
    #[serde(alias = "mix")]
    pub strength: f32,
    pub voice_guard: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub learned_profile: Option<serde_json::Value>,
}

/// v2 拡張: 内蔵ボイス FX
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBuiltinFx {
    pub preset: String,
    pub enabled: bool,
    pub amount: f32,
}

fn default_schema_version() -> u32 {
    1
}

/// プリセット / プロファイル（v1 互換 + v2 拡張）
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub name: String,
    #[serde(default)]
    pub plugins: Vec<PresetPlugin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_config: Option<ProfileAudioConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noise_control: Option<ProfileNoiseControl>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin_fx: Option<ProfileBuiltinFx>,
}

/// 保存時に含めるカテゴリの選択
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSaveCategories {
    #[serde(default)]
    pub include_plugins: bool,
    #[serde(default)]
    pub include_audio_config: bool,
    #[serde(default)]
    pub include_noise_control: bool,
    #[serde(default)]
    pub include_builtin_fx: bool,
}

/// フロントから渡すオーディオ補足（ゲイン・チャンネルは localStorage 管理のため）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAudioExtras {
    pub input_channels: Option<Vec<usize>>,
    pub input_gain_db: Option<f32>,
    pub master_gain_db: Option<f32>,
}

/// 一覧表示用メタデータ
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMeta {
    pub name: String,
    pub has_plugins: bool,
    pub has_audio_config: bool,
    pub has_noise_control: bool,
    pub has_builtin_fx: bool,
    pub is_backup: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MissingDevice {
    pub role: String,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MissingPlugin {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPluginInstance {
    pub id: String,
    pub path: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub enabled: bool,
    pub muted: bool,
    pub gain: f32,
}

/// プロファイル適用結果サマリ
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProfileSummary {
    pub applied_categories: Vec<String>,
    pub skipped_categories: Vec<String>,
    pub missing_devices: Vec<MissingDevice>,
    pub missing_plugins: Vec<MissingPlugin>,
    pub needs_engine_restart: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_audio_config: Option<ProfileAudioConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_noise_control: Option<ProfileNoiseControl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_builtin_fx: Option<ProfileBuiltinFx>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub applied_plugins: Vec<PresetPlugin>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub loaded_plugin_instances: Vec<LoadedPluginInstance>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSubstitutions {
    pub input_device: Option<String>,
    pub output_device: Option<String>,
}

impl Preset {
    pub fn effective_schema_version(&self) -> u32 {
        if self.schema_version == 0 {
            1
        } else {
            self.schema_version
        }
    }

    pub fn to_meta(&self) -> ProfileMeta {
        ProfileMeta {
            name: self.name.clone(),
            has_plugins: !self.plugins.is_empty(),
            has_audio_config: self.audio_config.is_some(),
            has_noise_control: self.noise_control.is_some(),
            has_builtin_fx: self.builtin_fx.is_some(),
            is_backup: self.name == BACKUP_PROFILE_NAME,
        }
    }

    /// カテゴリ選択に基づき v2 プロファイルを組み立てる
    pub fn build_from_parts(
        name: String,
        categories: &ProfileSaveCategories,
        plugins: Vec<PresetPlugin>,
        audio_config: Option<ProfileAudioConfig>,
        noise_control: Option<ProfileNoiseControl>,
        builtin_fx: Option<ProfileBuiltinFx>,
    ) -> Self {
        let has_v2 = categories.include_audio_config
            || categories.include_noise_control
            || categories.include_builtin_fx;

        Preset {
            schema_version: if has_v2 { 2 } else { 1 },
            name,
            plugins: if categories.include_plugins {
                plugins
            } else {
                Vec::new()
            },
            audio_config: if categories.include_audio_config {
                audio_config
            } else {
                None
            },
            noise_control: if categories.include_noise_control {
                noise_control
            } else {
                None
            },
            builtin_fx: if categories.include_builtin_fx {
                builtin_fx
            } else {
                None
            },
        }
    }
}

/// パーセント (0–100+) を dB に変換（100% = 0 dB）
pub fn pct_to_db(pct: f32) -> f32 {
    let linear = (pct / 100.0).max(1e-6);
    20.0 * linear.log10()
}

/// dB をリニアゲイン (0.0–>1.0) に変換
pub fn db_to_linear(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

pub fn save_preset(config_dir: &Path, name: &str, preset: &Preset) -> Result<(), String> {
    let presets_dir = config_dir.join("presets");
    if !presets_dir.exists() {
        fs::create_dir_all(&presets_dir).map_err(|e| e.to_string())?;
    }

    let file_path = presets_dir.join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(preset).map_err(|e| e.to_string())?;
    fs::write(file_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_presets(config_dir: &Path) -> Result<Vec<String>, String> {
    let presets_dir = config_dir.join("presets");
    if !presets_dir.exists() {
        return Ok(Vec::new());
    }

    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(presets_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "json") {
                if let Some(stem) = path.file_stem() {
                    names.push(stem.to_string_lossy().to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

pub fn list_profile_meta(config_dir: &Path) -> Result<Vec<ProfileMeta>, String> {
    let names = list_presets(config_dir)?;
    let mut metas = Vec::with_capacity(names.len());
    for name in names {
        match load_preset(config_dir, &name) {
            Ok(preset) => metas.push(preset.to_meta()),
            Err(_) => metas.push(ProfileMeta {
                name,
                has_plugins: false,
                has_audio_config: false,
                has_noise_control: false,
                has_builtin_fx: false,
                is_backup: false,
            }),
        }
    }
    Ok(metas)
}

pub fn load_preset(config_dir: &Path, name: &str) -> Result<Preset, String> {
    let file_path = config_dir.join("presets").join(format!("{}.json", name));
    if !file_path.exists() {
        return Err(format!("Preset not found: {}", name));
    }
    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let preset: Preset = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(preset)
}

pub fn delete_preset(config_dir: &Path, name: &str) -> Result<(), String> {
    let file_path = config_dir.join("presets").join(format!("{}.json", name));
    if file_path.exists() {
        fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn has_backup_profile(config_dir: &Path) -> bool {
    config_dir
        .join("presets")
        .join(format!("{}.json", BACKUP_PROFILE_NAME))
        .exists()
}

/// デバイス名が一覧に存在するか
pub fn device_exists(
    name: &str,
    is_input: bool,
    inputs: &[String],
    outputs: &[String],
) -> bool {
    if is_input {
        inputs.iter().any(|n| n == name)
    } else {
        outputs.iter().any(|n| n == name)
    }
}

/// オーディオ設定が現在と異なるか（再起動要否判定）
pub fn audio_config_differs(
    current_host: Option<&str>,
    current_input: Option<&str>,
    current_output: Option<&str>,
    current_buffer: Option<u32>,
    current_rate: Option<u32>,
    target: &ProfileAudioConfig,
) -> bool {
    current_host.map(|h| h != target.host).unwrap_or(true)
        || current_input != target.input_device.as_deref()
        || current_output != target.output_device.as_deref()
        || current_buffer != Some(target.buffer_size)
        || current_rate != Some(target.sample_rate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_config_dir() -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("auralyn_preset_test_{stamp}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_preset_file(dir: &Path, name: &str, json: &str) {
        let presets_dir = dir.join("presets");
        fs::create_dir_all(&presets_dir).unwrap();
        let path = presets_dir.join(format!("{}.json", name));
        fs::write(path, json).unwrap();
    }

    #[test]
    fn v1_preset_loads_unchanged() {
        let json = r#"{
            "name": "v1-test",
            "plugins": [{
                "path": "C:\\plugin.vst3",
                "name": "Test",
                "vendor": "V",
                "version": "1",
                "enabled": true,
                "muted": false,
                "gain": 1.0
            }]
        }"#;
        let preset: Preset = serde_json::from_str(json).unwrap();
        assert_eq!(preset.effective_schema_version(), 1);
        assert_eq!(preset.name, "v1-test");
        assert_eq!(preset.plugins.len(), 1);
        assert!(preset.audio_config.is_none());
        assert!(preset.noise_control.is_none());
        assert!(preset.builtin_fx.is_none());
    }

    #[test]
    fn v2_preset_roundtrip() {
        let preset = Preset {
            schema_version: 2,
            name: "game".to_string(),
            plugins: vec![],
            audio_config: Some(ProfileAudioConfig {
                host: "WASAPI".to_string(),
                input_device: Some("Mic".to_string()),
                output_device: Some("VB-Cable".to_string()),
                sample_rate: 48000,
                buffer_size: 512,
                input_channels: vec![0, 1],
                input_gain_db: 0.0,
                master_gain_db: -3.0,
            }),
            noise_control: Some(ProfileNoiseControl {
                enabled: true,
                mode: "smart".to_string(),
                strength: 0.8,
                voice_guard: true,
                learned_profile: None,
            }),
            builtin_fx: Some(ProfileBuiltinFx {
                preset: "broadcast".to_string(),
                enabled: true,
                amount: 0.7,
            }),
        };
        let json = serde_json::to_string(&preset).unwrap();
        let loaded: Preset = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded, preset);
    }

    #[test]
    fn missing_optional_fields_default_safely() {
        let json = r#"{"name": "minimal", "plugins": []}"#;
        let preset: Preset = serde_json::from_str(json).unwrap();
        assert_eq!(preset.schema_version, 1);
        assert!(preset.audio_config.is_none());
    }

    #[test]
    fn unknown_fields_are_ignored_on_load() {
        let json = r#"{
            "name": "future",
            "plugins": [],
            "futureFeature": {"enabled": true},
            "anotherUnknown": 42
        }"#;
        let preset: Preset = serde_json::from_str(json).unwrap();
        assert_eq!(preset.name, "future");
        assert!(preset.audio_config.is_none());
    }

    #[test]
    fn noise_control_accepts_mix_alias() {
        let json = r#"{
            "name": "n",
            "plugins": [],
            "noiseControl": {
                "enabled": true,
                "mode": "smart",
                "mix": 0.75,
                "voiceGuard": true
            }
        }"#;
        let preset: Preset = serde_json::from_str(json).unwrap();
        let nc = preset.noise_control.unwrap();
        assert!((nc.strength - 0.75).abs() < 1e-6);
    }

    #[test]
    fn list_and_load_from_disk() {
        let dir = temp_config_dir();
        write_preset_file(
            &dir,
            "disk-test",
            r#"{"name":"disk-test","plugins":[]}"#,
        );
        let names = list_presets(&dir).unwrap();
        assert!(names.contains(&"disk-test".to_string()));
        let loaded = load_preset(&dir, "disk-test").unwrap();
        assert_eq!(loaded.name, "disk-test");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_config_differs_detects_changes() {
        let target = ProfileAudioConfig {
            host: "WASAPI".to_string(),
            input_device: Some("Mic".to_string()),
            output_device: None,
            sample_rate: 48000,
            buffer_size: 512,
            input_channels: vec![0, 1],
            input_gain_db: 0.0,
            master_gain_db: 0.0,
        };
        assert!(audio_config_differs(
            Some("ASIO"),
            Some("Mic"),
            None,
            Some(512),
            Some(48000),
            &target
        ));
        assert!(!audio_config_differs(
            Some("WASAPI"),
            Some("Mic"),
            None,
            Some(512),
            Some(48000),
            &target
        ));
    }

    #[test]
    fn pct_db_conversion_roundtrip() {
        let db = pct_to_db(100.0);
        assert!((db - 0.0).abs() < 1e-4);
        let linear = db_to_linear(db);
        assert!((linear - 1.0).abs() < 1e-4);
    }
}
