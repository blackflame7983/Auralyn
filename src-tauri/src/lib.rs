use std::sync::{mpsc, Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

pub mod audio;
pub mod audio_analysis;
pub mod audio_engine;
mod desktop_integration;
mod storage;
mod migration;
mod shortcuts;
mod updates;
pub mod coexistence;
#[cfg(any(test, feature = "dsp-verification"))]
mod dsp_verification_allocator;
pub mod autostart;
pub mod ipc;
pub mod obs;
pub mod obs_setup;
pub mod profile;
pub mod routing_diag;
pub mod vst_host;
use crate::vst_host::presets::{
    self, ApplyProfileSummary, DeviceSubstitutions, Preset, PresetPlugin, ProfileAudioExtras,
    ProfileBuiltinFx, ProfileMeta, ProfileNoiseControl, ProfileSaveCategories,
};

#[tauri::command]
async fn get_autostart_status(
    distribution: State<'_, desktop_integration::Distribution>,
) -> Result<autostart::AutostartStatus, String> {
    let distribution = *distribution;
    tauri::async_runtime::spawn_blocking(move || autostart::get_autostart_status(distribution))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_autostart_enabled(
    app: AppHandle,
    distribution: State<'_, desktop_integration::Distribution>,
    enabled: bool,
) -> Result<(), String> {
    let distribution = *distribution;
    if distribution == desktop_integration::Distribution::Msix {
        return autostart::set_package_enabled(app, enabled)
            .await
            .map_err(|e| e.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || autostart::set_autostart_enabled(distribution, enabled))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_audio_devices(
    _app: AppHandle,
    state: State<'_, audio::AudioState>,
    force_refresh: bool,
) -> Result<audio::AudioDeviceList, String> {
    let host_arc = state.0.clone();
    let (tx, rx) = mpsc::channel();

    // Run on a dedicated background thread to ensure clean COM state (STA/MTA) independent of Tauri UI
    std::thread::spawn(move || {
        let res = (|| {
            let mut host = host_arc.lock().map_err(|_| "Failed to lock audio state")?;
            host.enumerate_devices(force_refresh)
                .map_err(|e| e.to_string())
        })();
        let _ = tx.send(res);
    });

    rx.recv().map_err(|_| "Failed to receive response")?
}

#[tauri::command]
fn get_audio_state(state: State<'_, audio::AudioState>) -> Result<audio::AudioStateInfo, String> {
    let host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    Ok(host.get_state())
}

#[tauri::command]
fn get_engine_tuning_config(
    state: State<'_, audio::AudioState>,
) -> Result<audio::EngineTuningConfig, String> {
    let host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    Ok(host.get_engine_tuning_config())
}

#[tauri::command]
fn set_engine_tuning_config(
    state: State<'_, audio::AudioState>,
    config: audio::EngineTuningConfig,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_engine_tuning_config(config);
    Ok(())
}

#[tauri::command]
fn get_engine_runtime_stats(
    state: State<'_, audio::AudioState>,
) -> Result<audio::EngineRuntimeStats, String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.get_engine_runtime_stats().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_audio(
    state: State<'_, audio::AudioState>,
    input: Option<String>,
    output: Option<String>,
    host: Option<String>,
    buffer_size: Option<u32>,
    sample_rate: Option<u32>,
) -> Result<audio::AudioConfig, String> {
    log::debug!(
        "start_audio IPC Args: host={:?}, input={:?}, buffer={:?}, rate={:?}",
        host,
        input,
        buffer_size,
        sample_rate
    );
    let mut host_instance = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host_instance
        .start(host, input, output, buffer_size, sample_rate)
        .map_err(|e| audio::localize_audio_error(e.to_string()))
}

#[tauri::command]
fn stop_audio(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.stop();
    Ok(())
}

#[tauri::command]
fn load_plugin(state: State<'_, audio::AudioState>, path: String) -> Result<String, String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.load_plugin(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_plugin(state: State<'_, audio::AudioState>, id: String) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.remove_plugin(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn reorder_plugins(state: State<'_, audio::AudioState>, order: Vec<String>) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.reorder_plugins(order).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_bypass(state: State<'_, audio::AudioState>, id: String, active: bool) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_bypass(&id, active).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_mute(state: State<'_, audio::AudioState>, id: String, active: bool) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_mute(&id, active).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_gain(state: State<'_, audio::AudioState>, id: String, value: f32) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_gain(&id, value).map_err(|e| e.to_string())
}

#[tauri::command]
fn restart_audio_engine(
    state: State<'_, audio::AudioState>,
    input: Option<String>,
    output: Option<String>,
    host: Option<String>,
    buffer_size: Option<u32>,
    sample_rate: Option<u32>,
) -> Result<audio::AudioConfig, String> {
    log::debug!(
        "restart_audio_engine IPC Args: host={:?}, input={:?}, buffer={:?}, rate={:?}",
        host,
        input,
        buffer_size,
        sample_rate
    );
    // 未許可・確認不能なら、既存の音声とサイドカー上のVSTを保持する。
    desktop_integration::check_microphone_access(host.as_deref())
        .map_err(audio::localize_audio_error)?;
    let mut audio_host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    audio_host.kill_engine();
    // Short delay to ensure process is dead? Usually synchronous kill is fine on Windows.
    // Re-start
    audio_host
        .start(host, input, output, buffer_size, sample_rate)
        .map_err(|e| audio::localize_audio_error(e.to_string()))
}

#[tauri::command]
async fn scan_plugins(app: tauri::AppHandle) -> Result<Vec<vst_host::VstPlugin>, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    if !config_dir.exists() {
        std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    }
    Ok(vst_host::scan_system_vst3(&config_dir))
}

#[tauri::command]
async fn clear_blacklist(app: AppHandle) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut blacklist = vst_host::blacklist::Blacklist::new(&config_dir);
    blacklist.clear();
    Ok(())
}

#[tauri::command]
fn open_editor(state: State<'_, audio::AudioState>, id: String) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.open_editor(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_presets(app: AppHandle) -> Result<Vec<String>, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    presets::list_presets(&config_dir)
}

#[tauri::command]
async fn list_profiles(app: AppHandle) -> Result<Vec<ProfileMeta>, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    presets::list_profile_meta(&config_dir)
}

#[tauri::command]
async fn save_preset(
    app: AppHandle,
    name: String,
    plugins: Vec<PresetPlugin>,
) -> Result<(), String> {
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
}

/// フルプロファイル保存（カテゴリ選択付き）
#[tauri::command]
async fn save_profile(
    app: AppHandle,
    state: State<'_, audio::AudioState>,
    name: String,
    categories: ProfileSaveCategories,
    plugins: Vec<PresetPlugin>,
    audio_extras: Option<ProfileAudioExtras>,
    builtin_fx_amount: Option<f32>,
) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;

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
        let stats = host
            .get_engine_runtime_stats()
            .map_err(|e| e.to_string())?;
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
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "既存invokeの名前付きpayloadとTauri注入引数の契約を維持する"
)]
async fn apply_profile(
    app: AppHandle,
    state: State<'_, audio::AudioState>,
    name: String,
    device_substitutions: Option<DeviceSubstitutions>,
    current_plugin_ids: Vec<String>,
    backup_plugins: Vec<PresetPlugin>,
    backup_audio_extras: Option<ProfileAudioExtras>,
    skip_backup: Option<bool>,
) -> Result<ApplyProfileSummary, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let profile = presets::load_preset(&config_dir, &name)?;
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
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
}

#[tauri::command]
async fn has_backup_profile(app: AppHandle) -> Result<bool, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(presets::has_backup_profile(&config_dir))
}

#[tauri::command]
async fn restore_backup_profile(
    app: AppHandle,
    state: State<'_, audio::AudioState>,
    current_plugin_ids: Vec<String>,
    backup_plugins: Vec<PresetPlugin>,
    backup_audio_extras: Option<ProfileAudioExtras>,
) -> Result<ApplyProfileSummary, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let profile = presets::load_preset(&config_dir, presets::BACKUP_PROFILE_NAME)?;
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
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
}

#[tauri::command]
async fn load_preset(app: AppHandle, name: String) -> Result<Preset, String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    presets::load_preset(&config_dir, &name)
}

#[tauri::command]
async fn delete_preset(app: AppHandle, name: String) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    presets::delete_preset(&config_dir, &name)
}

#[tauri::command]
async fn export_preset(
    app: AppHandle,
    name: String,
    categories: Option<ProfileSaveCategories>,
) -> Result<(), String> {
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
}

#[tauri::command]
async fn export_profile(
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
async fn import_preset(app: AppHandle) -> Result<String, String> {
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
}

#[tauri::command]
async fn import_profile(app: AppHandle) -> Result<String, String> {
    import_preset(app).await
}

#[tauri::command]
fn get_plugin_state(state: State<'_, audio::AudioState>, id: String) -> Result<String, String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.get_plugin_state(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_plugin_state(
    audio: State<'_, audio::AudioState>,
    id: String,
    state: String,
) -> Result<(), String> {
    let mut host = audio.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_plugin_state(&id, &state)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_global_mute(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.toggle_global_mute().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_global_mute(state: State<'_, audio::AudioState>, active: bool) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_global_mute(active).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_input_gain(state: State<'_, audio::AudioState>, value: f32) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_input_gain(value).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_noise_reduction(
    state: State<'_, audio::AudioState>,
    active: bool,
    mode: Option<String>,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_noise_reduction(active, mode)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn start_noise_learning(
    state: State<'_, audio::AudioState>,
    duration_ms: Option<u32>,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.start_noise_learning(duration_ms.unwrap_or(3000))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_noise_learning(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.cancel_noise_learning().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_noise_control_config(
    state: State<'_, audio::AudioState>,
    active: bool,
    mode: String,
    strength: f32,
    voice_guard: bool,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_noise_control_config(active, mode, strength, voice_guard)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_built_in_effects(
    state: State<'_, audio::AudioState>,
    active: bool,
    preset: Option<String>,
    amount: f32,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_built_in_effects(active, preset, amount)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_loudness_measurement(
    state: State<'_, audio::AudioState>,
    id: Option<u64>,
) -> Result<(), String> {
    let host = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "音声状態を取得できません")?
            .set_loudness_measurement(id)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_output_gain(state: State<'_, audio::AudioState>, value: f32) -> Result<(), String> {
    let host = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "音声状態を取得できません")?
            .set_output_gain(value)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn auto_gain(
    state: State<'_, audio::AudioState>,
    request: audio_engine::auto_gain::Request,
) -> Result<audio_engine::auto_gain::Snapshot, String> {
    let host = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.lock()
            .map_err(|_| "音声状態を取得できません")?
            .auto_gain(request)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_global_bypass(state: State<'_, audio::AudioState>, active: bool) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_global_bypass(active).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_input_channels(
    state: State<'_, audio::AudioState>,
    left: usize,
    right: usize,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_input_channels(left, right)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_channel_scan(state: State<'_, audio::AudioState>, active: bool) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_channel_scan(active).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_voice_check(
    state: State<'_, audio::AudioState>,
    max_ms: Option<u32>,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.start_voice_check(max_ms.unwrap_or(10_000))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_voice_check(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.stop_voice_check().map_err(|e| e.to_string())
}

#[tauri::command]
fn play_voice_check(
    state: State<'_, audio::AudioState>,
    source: String,
    loop_playback: Option<bool>,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.play_voice_check(source, loop_playback.unwrap_or(true))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_voice_check_playback(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.stop_voice_check_playback()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_voice_check_wav(
    state: State<'_, audio::AudioState>,
    source: String,
) -> Result<(), String> {
    let path = rfd::FileDialog::new()
        .set_file_name("voice-check.wav")
        .add_filter("WAV", &["wav"])
        .save_file();

    match path {
        Some(p) => {
            let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
            host.export_voice_check(p.to_string_lossy().to_string(), source)
                .map_err(|e| e.to_string())
        }
        None => Err("cancelled".to_string()),
    }
}

#[tauri::command]
fn export_voice_check(
    state: State<'_, audio::AudioState>,
    path: String,
    source: String,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.export_voice_check(path, source)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn play_test_tone(
    state: State<'_, audio::AudioState>,
    freq_hz: Option<f32>,
    duration_ms: Option<u32>,
    level_db: Option<f32>,
) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.play_test_tone(
        freq_hz.unwrap_or(1000.0),
        duration_ms.unwrap_or(1500),
        level_db.unwrap_or(-20.0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_test_tone(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.stop_test_tone().map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_loopback(
    state: State<'_, audio::AudioState>,
    input_device: String,
    duration_ms: Option<u32>,
    freq_hz: Option<f32>,
) -> Result<audio::LoopbackProbeResult, String> {
    // プローブは 1.5〜2 秒ブロックするため、メインスレッドを塞がないよう
    // ブロッキングスレッドで実行する（AudioState ロックはその間保持される）
    let state = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state".to_string())?;
        host.probe_loopback(
            input_device,
            duration_ms.unwrap_or(1500),
            freq_hz.unwrap_or(1000.0),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_routing_diagnostics(
    state: State<'_, audio::AudioState>,
) -> Result<routing_diag::RoutingDiagnosticsReport, String> {
    let host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    let engine_rate = host
        .get_state()
        .config
        .as_ref()
        .and_then(|c| c.sample_rate);
    Ok(routing_diag::collect_routing_diagnostics(engine_rate))
}

#[tauri::command]
async fn analyze_voice_check(
    state: State<'_, audio::AudioState>,
) -> Result<audio_analysis::QualityReport, String> {
    let temp_dir = std::env::temp_dir().join(format!(
        "auralyn_vc_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let raw_path = temp_dir.join("raw.wav");
    let processed_path = temp_dir.join("processed.wav");

    let buffer_size = {
        let host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
        host.get_state()
            .config
            .as_ref()
            .and_then(|c| c.buffer_size)
    };

    {
        let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
        host.export_voice_check(
            raw_path.to_string_lossy().to_string(),
            "raw".to_string(),
        )
        .map_err(|e| e.to_string())?;
        host.export_voice_check(
            processed_path.to_string_lossy().to_string(),
            "processed".to_string(),
        )
        .map_err(|e| e.to_string())?;
    }

    let loaded = audio_analysis::load_wav_interleaved_f32(&raw_path)
        .and_then(|raw| {
            audio_analysis::load_wav_interleaved_f32(&processed_path).map(|proc| (raw, proc))
        });
    let _ = std::fs::remove_dir_all(&temp_dir);
    let ((raw_samples, sr_raw), (processed_samples, sr_proc)) =
        loaded.map_err(|e| e.to_string())?;

    if sr_raw != sr_proc {
        return Err("Raw/Processed のサンプルレートが一致しません".to_string());
    }

    let ctx = audio_analysis::AnalysisContext { buffer_size };
    Ok(audio_analysis::analyze_voice_check_buffers(
        &raw_samples,
        &processed_samples,
        sr_raw,
        &ctx,
    ))
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_obs(
    app: AppHandle,
    state: State<'_, obs::ObsState>,
    host: String,
    port: u16,
    password: Option<String>,
) -> Result<(), String> {
    obs::connect_obs(app, state, host, port, password).await
}

#[tauri::command]
async fn disconnect_obs(state: State<'_, obs::ObsState>) -> Result<(), String> {
    obs::disconnect_obs(state).await
}

#[tauri::command]
async fn obs_preview_setup(
    state: State<'_, obs::ObsState>,
    mute_source: Option<String>,
) -> Result<obs_setup::Plan, String> {
    obs_setup::preview(&state, mute_source).await
}

#[tauri::command]
async fn obs_connection_status(state: State<'_, obs::ObsState>) -> Result<bool, String> {
    Ok(obs::connection_status(&state).await)
}

#[tauri::command]
async fn obs_apply_setup(
    state: State<'_, obs::ObsState>,
    id: u64,
) -> Result<obs_setup::History, String> {
    obs_setup::apply(&state, id).await
}

#[tauri::command]
async fn obs_setup_history(
    state: State<'_, obs::ObsState>,
) -> Result<Vec<obs_setup::History>, String> {
    Ok(obs_setup::history(&state).await)
}

#[tauri::command]
async fn obs_restore_setup(
    state: State<'_, obs::ObsState>,
    id: u64,
) -> Result<obs_setup::History, String> {
    obs_setup::restore(&state, id).await
}

#[tauri::command]
async fn obs_forget_setup_history(state: State<'_, obs::ObsState>, id: u64) -> Result<(), String> {
    obs_setup::forget_history(&state, id).await
}

#[tauri::command]
async fn obs_check_audio_reach(
    obs_state: State<'_, obs::ObsState>,
    audio_state: State<'_, audio::AudioState>,
    duration_ms: Option<u32>,
) -> Result<obs::ObsAudioReachResult, String> {
    obs::check_audio_reach(
        &obs_state,
        &audio_state,
        duration_ms.unwrap_or(1500),
    )
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Force aggressive logging to capture CPAL traces
    let _ = env_logger::Builder::new()
        .filter(Some("cpal"), log::LevelFilter::Trace)
        .filter(Some("vst_host"), log::LevelFilter::Debug)
        .filter(None, log::LevelFilter::Info)
        .try_init();

    // Debug: Print environment context to check for DLL loading issues
    if let Ok(cwd) = std::env::current_dir() {
        log::info!("App CWD: {:?}", cwd);
    }

    let obs_state = obs::ObsState::new();
    let distribution = desktop_integration::detect_distribution();
    let mut context = tauri::generate_context!();
    if let Err(error) = storage::configure(context.config_mut(), distribution) {
        log::error!("設定保存先の初期化に失敗しました: {error:#}");
        rfd::MessageDialog::new()
            .set_title("Auralynを起動できませんでした")
            .set_description(format!("設定保存先を確認できませんでした。既存の設定は変更していません。\n{error:#}"))
            .set_level(rfd::MessageLevel::Error)
            .show();
        return;
    }

    let builder = tauri::Builder::default()
        // 他のプラグイン・ウィンドウ・音声エンジンより先に共通IDで二重起動を防ぐ。
        .plugin(coexistence::plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        shortcuts::dispatch(app.clone(), shortcut.id());
                    }
                })
                .build(),
        );

    // MSIXはStore等の配布元が更新する。判定失敗時も外部インストーラーを起動しない。
    let builder = if distribution == desktop_integration::Distribution::Standalone {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };

    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    builder
        .manage(distribution)
        .manage(migration::Preview::default())
        .manage(shortcuts::Shortcuts::default())
        .manage(updates::Updates::default())
        .manage(obs_state)
        .setup(|app| {
            // app_config_dirはMSIXではpackage専用、通常版では従来のRoaming AppData。
            let config_dir = app.path().app_config_dir()?;
            app.manage(audio::AudioState(Arc::new(Mutex::new(
                audio::AudioHost::new(config_dir),
            ))));
            let state = app.state::<audio::AudioState>();

            // Explicitly set window icon (Fix for taskbar icon issue)
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(
                    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
                        .expect("Failed to load icon"),
                );
            }

            // --- System Tray ---
            let show_item = MenuItemBuilder::with_id("show", "Auralyn を表示").build(app)?;
            let mute_item =
                MenuItemBuilder::with_id("mute_toggle", "ミュート切替 (Alt+M)").build(app)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "終了").build(app)?;

            let tray_menu = MenuBuilder::new(app)
                .items(&[&show_item, &mute_item, &separator, &quit_item])
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .tooltip("Auralyn - VST Host")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "mute_toggle" => {
                        if let Some(audio_state) = app.try_state::<audio::AudioState>() {
                            if let Ok(mut host) = audio_state.0.lock() {
                                let _ = host.toggle_global_mute();
                            }
                        }
                    }
                    "quit" => {
                        // Actually quit the application
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click on tray icon: show/focus window
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Clone the handle to pass to the thread
            let handle = app.handle().clone();

            // Lock and set the emitter
            if let Ok(mut host) = state.0.lock() {
                host.set_event_emitter(handle);
            }

            // Warmup Audio Engine (Spawn Sidecar in Background)
            let host_clone = state.0.clone();
            std::thread::spawn(move || {
                if let Ok(mut host) = host_clone.lock() {
                    log::info!("Warming up Audio Engine...");
                    if let Err(e) = host.warmup() {
                        log::error!("Failed to warmup audio engine: {}", e);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // × button: hide to system tray instead of quitting
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                // Notify user (only once per session) that app is still running in tray
                let _ = window.emit("minimized-to-tray", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            migration::export_settings,
            migration::preview_settings,
            migration::apply_settings,
            migration::migration_bootstrap,
            shortcuts::get_shortcuts,
            shortcuts::save_shortcuts,
            updates::check_update,
            updates::download_update,
            updates::install_update,
            desktop_integration::get_distribution,
            desktop_integration::open_desktop_settings,
            get_audio_devices,
            get_audio_state,
            get_engine_tuning_config,
            set_engine_tuning_config,
            get_engine_runtime_stats,
            scan_plugins,
            clear_blacklist,
            start_audio,
            stop_audio,
            load_plugin,
            remove_plugin,
            reorder_plugins,
            set_bypass,
            set_mute,
            set_gain,
            open_editor,
            restart_audio_engine,
            list_presets,
            list_profiles,
            save_preset,
            save_profile,
            load_preset,
            apply_profile,
            has_backup_profile,
            restore_backup_profile,
            delete_preset,
            export_preset,
            export_profile,
            import_preset,
            import_profile,
            get_plugin_state,
            set_plugin_state,
            toggle_global_mute,
            set_global_mute,
            set_input_gain,
            set_noise_reduction,
            start_noise_learning,
            cancel_noise_learning,
            set_noise_control_config,
            set_built_in_effects,
            set_output_gain,
            auto_gain,
            set_loudness_measurement,
            set_global_bypass,
            open_url,
            connect_obs,
            disconnect_obs,
            obs_preview_setup,
            obs_connection_status,
            obs_apply_setup,
            obs_setup_history,
            obs_restore_setup,
            obs_forget_setup_history,
            obs_check_audio_reach,
            get_autostart_status,
            set_autostart_enabled,
            set_input_channels,
            set_channel_scan,
            start_voice_check,
            stop_voice_check,
            play_voice_check,
            stop_voice_check_playback,
            export_voice_check,
            export_voice_check_wav,
            analyze_voice_check,
            play_test_tone,
            stop_test_tone,
            probe_loopback,
            get_routing_diagnostics,
        ])
        .run(context)
        .expect("error while running tauri application");
}
