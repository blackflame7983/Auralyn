//! プリセット・プロファイルの保存、適用、入出力。
use crate::vst_host::presets::{
    self, ApplyProfileSummary, DeviceSubstitutions, Preset, PresetPlugin, ProfileAudioExtras,
    ProfileBuiltinFx, ProfileMeta, ProfileNoiseControl, ProfileSaveCategories,
};
use crate::{audio, profile};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub(crate) async fn list_presets(app: AppHandle) -> Result<Vec<String>, String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        presets::list_presets(&config_dir)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_profiles(app: AppHandle) -> Result<Vec<ProfileMeta>, String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        presets::list_profile_meta(&config_dir)
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_preset(
    app: AppHandle,
    name: String,
    plugins: Vec<PresetPlugin>,
) -> Result<(), String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let preset = Preset {
            schema_version: 1,
            name: name.clone(),
            plugins,
            audio_config: None,
            noise_control: None,
            builtin_fx: None,
        };
        presets::save_preset(&config_dir, &name, &preset)
    })
    .await
}

/// フルプロファイル保存（カテゴリ選択付き）
#[tauri::command]
pub(crate) async fn save_profile(
    app: AppHandle,
    state: State<'_, audio::AudioState>,
    name: String,
    categories: ProfileSaveCategories,
    plugins: Vec<PresetPlugin>,
    audio_extras: Option<ProfileAudioExtras>,
    builtin_fx_amount: Option<f32>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;

        let mut audio_config = None;
        let mut noise_control = None;
        let mut builtin_fx = None;

        if categories.include_audio_config {
            let captured = profile::capture_current_profile(
                &mut host,
                name.clone(),
                plugins.clone(),
                audio_extras.clone(),
            )?;
            audio_config = captured.audio_config;
        }

        if categories.include_noise_control || categories.include_builtin_fx {
            let stats = host.get_engine_runtime_stats().map_err(|e| e.to_string())?;
            if categories.include_noise_control {
                noise_control = Some(ProfileNoiseControl {
                    enabled: stats.noise_reduction_enabled,
                    mode: stats.noise_reduction_mode.clone(),
                    strength: stats.noise_control_strength,
                    voice_guard: stats.noise_voice_guard,
                    learned_profile: None,
                });
            }
            if categories.include_builtin_fx {
                builtin_fx = Some(ProfileBuiltinFx {
                    preset: stats.built_in_effects_preset.clone(),
                    enabled: stats.built_in_effects_enabled,
                    amount: builtin_fx_amount.unwrap_or(stats.built_in_effects_amount),
                    singing: stats.built_in_singing,
                    reverb: stats.built_in_reverb,
                });
            }
        }

        let preset = Preset::build_from_parts(
            name.clone(),
            &categories,
            plugins,
            audio_config,
            noise_control,
            builtin_fx,
        );
        presets::save_preset(&config_dir, &name, &preset)
    })
    .await
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "既存invokeの名前付きpayloadとTauri注入引数の契約を維持する"
)]
pub(crate) async fn apply_profile(
    app: AppHandle,
    state: State<'_, audio::AudioState>,
    name: String,
    device_substitutions: Option<DeviceSubstitutions>,
    current_plugin_ids: Vec<String>,
    backup_plugins: Vec<PresetPlugin>,
    backup_audio_extras: Option<ProfileAudioExtras>,
    skip_backup: Option<bool>,
    sound_only: Option<bool>,
) -> Result<ApplyProfileSummary, String> {
    let state = state.0.clone();
    let (config_dir, profile) = super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let mut profile = presets::load_preset(&config_dir, &name)?;
        if sound_only.unwrap_or(false) {
            profile.audio_config = None;
        }
        Ok((config_dir, profile))
    })
    .await?;
    if profile.audio_config.is_some() {
        super::audio::enumerate_devices_async(state.clone(), false).await?;
    }
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        profile::apply_profile(
            &config_dir,
            &mut host,
            &profile,
            device_substitutions,
            skip_backup.unwrap_or(false),
            backup_plugins,
            backup_audio_extras,
            &current_plugin_ids,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn has_backup_profile(app: AppHandle) -> Result<bool, String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        Ok(presets::has_backup_profile(&config_dir))
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_backup_profile(
    app: AppHandle,
    state: State<'_, audio::AudioState>,
    current_plugin_ids: Vec<String>,
    backup_plugins: Vec<PresetPlugin>,
    backup_audio_extras: Option<ProfileAudioExtras>,
) -> Result<ApplyProfileSummary, String> {
    let state = state.0.clone();
    let (config_dir, profile) = super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let profile = presets::load_preset(&config_dir, presets::BACKUP_PROFILE_NAME)?;
        Ok((config_dir, profile))
    })
    .await?;
    super::audio::enumerate_devices_async(state.clone(), false).await?;
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        profile::apply_profile(
            &config_dir,
            &mut host,
            &profile,
            None,
            true, // 復元時は再バックアップしない
            backup_plugins,
            backup_audio_extras,
            &current_plugin_ids,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn load_preset(app: AppHandle, name: String) -> Result<Preset, String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        presets::load_preset(&config_dir, &name)
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_preset(app: AppHandle, name: String) -> Result<(), String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        presets::delete_preset(&config_dir, &name)
    })
    .await
}

#[tauri::command]
pub(crate) async fn export_preset(
    app: AppHandle,
    name: String,
    categories: Option<ProfileSaveCategories>,
) -> Result<(), String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let mut preset = presets::load_preset(&config_dir, &name)?;

        // 共有用エクスポート: デフォルトで audioConfig を除外
        if let Some(cats) = categories {
            if !cats.include_plugins {
                preset.plugins.clear();
            }
            if !cats.include_audio_config {
                preset.audio_config = None;
            }
            if !cats.include_noise_control {
                preset.noise_control = None;
            }
            if !cats.include_builtin_fx {
                preset.builtin_fx = None;
            }
        } else {
            preset.audio_config = None;
        }

        let json = serde_json::to_string_pretty(&preset).map_err(|e| e.to_string())?;
        let default_name = format!("{}.auralyn-preset.json", name);

        let path = rfd::FileDialog::new()
            .set_file_name(&default_name)
            .add_filter("Auralyn Preset", &["json"])
            .save_file();

        match path {
            Some(p) => {
                std::fs::write(&p, json).map_err(|e| e.to_string())?;
                Ok(())
            }
            None => Err("cancelled".to_string()),
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn export_profile(
    app: AppHandle,
    name: String,
    categories: Option<ProfileSaveCategories>,
) -> Result<(), String> {
    let export_cats = categories.unwrap_or(ProfileSaveCategories {
        include_plugins: true,
        include_audio_config: false,
        include_noise_control: true,
        include_builtin_fx: true,
    });
    export_preset(app, name, Some(export_cats)).await
}

#[tauri::command]
pub(crate) async fn import_preset(app: AppHandle) -> Result<String, String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;

        let path = rfd::FileDialog::new()
            .add_filter("Auralyn Preset", &["json"])
            .pick_file();

        match path {
            Some(p) => {
                let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
                let preset: Preset = serde_json::from_str(&content)
                    .map_err(|e| format!("無効なプリセットファイルです: {}", e))?;
                let name = preset.name.clone();
                presets::save_preset(&config_dir, &name, &preset)?;
                Ok(name)
            }
            None => Err("cancelled".to_string()),
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn import_profile(app: AppHandle) -> Result<String, String> {
    import_preset(app).await
}
