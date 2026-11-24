//! 音声・プラグイン操作と診断のコマンド。
use crate::{audio, audio_engine, desktop_integration, routing_diag, vst_host};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub(crate) async fn post_mix(
    state: State<'_, audio::AudioState>,
    request: audio::post_mix::Request,
) -> Result<audio::post_mix::Snapshot, String> {
    let host = state.0.clone();
    let entry =
        audio::Entry::command("post_mix").class(audio::control::request_class::post_mix(&request));
    super::call(
        &host,
        entry,
        "配信VSTの設定を取得できません",
        move |host| host.post_mix(request),
    )
    .await
}

// 読み込みやスキャンを行わず、明確な不在だけを返す。クラスIDの有無は実ロード時に判明する。
fn missing_vst_path(path: &str) -> Result<bool, String> {
    let path = std::path::Path::new(path);
    if !path.is_absolute()
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("vst3"))
    {
        return Err("VSTのパスが不正です".into());
    }
    classify_vst_metadata(std::fs::metadata(path))
}

fn classify_vst_metadata(result: std::io::Result<std::fs::Metadata>) -> Result<bool, String> {
    match result {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err("VSTの存在を確認できません".into()),
    }
}

#[tauri::command]
pub(crate) async fn missing_vst_paths(paths: Vec<String>) -> Result<Vec<bool>, String> {
    if paths.len() > 32 {
        return Err("VSTの件数が不正です".into());
    }
    super::run_blocking(move || paths.iter().map(|path| missing_vst_path(path)).collect()).await
}

#[cfg(test)]
mod missing_vst_tests {
    use super::{classify_vst_metadata, missing_vst_path};
    #[test]
    fn missing_vst_distinguishes_absence_and_access_errors() {
        assert_eq!(
            classify_vst_metadata(Err(std::io::ErrorKind::NotFound.into())),
            Ok(true)
        );
        assert!(classify_vst_metadata(Err(std::io::ErrorKind::PermissionDenied.into())).is_err());
        assert!(missing_vst_path("relative.vst3").is_err());
        assert!(missing_vst_path("relative.dll").is_err());
        let missing = std::env::temp_dir()
            .join("auralyn-nonexistent-test-vst")
            .join("missing.vst3");
        assert_eq!(missing_vst_path(missing.to_str().unwrap()), Ok(true));
    }
}

// 復旧用プロファイルは既存ファイルを決して上書きしない。
#[tauri::command]
pub(crate) async fn save_vst_recovery_profile(
    app: AppHandle,
    name: String,
    plugins: Vec<vst_host::presets::PresetPlugin>,
) -> Result<(), String> {
    super::run_blocking(move || {
        use std::io::Write;
        let suffix = name
            .strip_prefix("VST-recovery-")
            .ok_or("復旧名が不正です")?;
        if suffix.len() != 36
            || !suffix.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
            || plugins.len() > 32
        {
            return Err("復旧名または件数が不正です".into());
        }
        let preset = vst_host::presets::Preset {
            plugins_included: Some(true),
            schema_version: 1,
            name: name.clone(),
            plugins,
            audio_config: None,
            noise_control: None,
            builtin_fx: None,
        };
        let json = serde_json::to_vec_pretty(&preset).map_err(|e| e.to_string())?;
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join("presets");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(format!("{name}.json")))
            .map_err(|e| e.to_string())?;
        file.write_all(&json)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn peak_protection(
    state: State<'_, audio::AudioState>,
    config: Option<audio_engine::peak_protection::Config>,
) -> Result<audio_engine::peak_protection::Snapshot, String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("peak_protection")
        .class(audio::control::request_class::peak_protection(&config));
    super::call(
        &state,
        entry,
        "音声状態を取得できません",
        move |host| host.peak_protection(config),
    )
    .await
}

#[tauri::command]
pub(crate) async fn broadcast_true_peak(
    state: State<'_, audio::AudioState>,
    config: Option<audio_engine::true_peak_limiter::Config>,
) -> Result<audio_engine::true_peak_limiter::Snapshot, String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("broadcast_true_peak")
        .class(audio::control::request_class::broadcast_true_peak(&config));
    super::call(
        &state,
        entry,
        "音声状態を取得できません",
        move |host| host.broadcast_true_peak(config),
    )
    .await
}

#[tauri::command]
pub(crate) async fn live_output(
    state: State<'_, audio::AudioState>,
    config: Option<audio_engine::live_output::Config>,
) -> Result<audio_engine::live_output::Status, String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("live_output")
        .class(audio::control::request_class::live_output(&config));
    super::call(
        &state,
        entry,
        "音声状態を取得できません",
        move |host| host.live_output(config),
    )
    .await
}

#[tauri::command]
pub(crate) async fn mixing(
    state: State<'_, audio::AudioState>,
    request: audio::mixing::Request,
) -> Result<audio::mixing::Snapshot, String> {
    let state = state.0.clone();
    let entry =
        audio::Entry::command("mixing").class(audio::control::request_class::mixing(&request));
    super::call(
        &state,
        entry,
        "音声状態を取得できません",
        move |host| host.mixing(request),
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_audio_devices(
    state: State<'_, audio::AudioState>,
    force_refresh: bool,
) -> Result<audio::AudioDeviceList, String> {
    enumerate_devices_async(state.0.clone(), force_refresh).await
}

// 設定画面とプロファイル適用で共有し、一覧待機中にhostのmutexを保持しない。
pub(super) async fn enumerate_devices_async(
    state: audio::AudioControl,
    force_refresh: bool,
) -> Result<audio::AudioDeviceList, String> {
    let begin_state = state.clone();
    let start = super::call(
        &begin_state,
        audio::Entry::command("enumerate_devices_async"),
        "Failed to lock audio state",
        move |host| host.begin_device_scan(force_refresh),
    )
    .await?;
    let ticket = match start {
        audio::DeviceScanStart::Cached(devices) => return Ok(devices),
        audio::DeviceScanStart::Pending(ticket) => ticket,
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(35);
    loop {
        // scanner待機はasync側で行い、停止・設定操作がAudioStateを取得できるようにする。
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if tokio::time::Instant::now() >= deadline {
            let _ = super::call(
                &state,
                audio::Entry::command("cancel_device_scan"),
                "Failed to lock audio state",
                move |host| host.cancel_device_scan(&ticket),
            )
            .await;
            return Err("デバイス検出が時間切れになりました。再試行してください。".into());
        }
        let poll_state = state.clone();
        let poll_ticket = ticket.clone();
        let polled = super::call(
            &poll_state,
            audio::Entry::command("enumerate_devices_async"),
            "Failed to lock audio state",
            move |host| host.poll_device_scan(&poll_ticket),
        )
        .await;
        match polled {
            Ok(Some(devices)) => return Ok(devices),
            Ok(None) => {}
            Err(error) => {
                let _ = super::call(
                    &state,
                    audio::Entry::command("cancel_device_scan"),
                    "Failed to lock audio state",
                    move |host| host.cancel_device_scan(&ticket),
                )
                .await;
                return Err(error);
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn get_output_gain_observation(
    state: State<'_, audio::AudioState>,
) -> Result<audio::frontend_bootstrap::GainObservation, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_output_gain_observation"),
        "Failed to lock audio state",
        move |host| host.output_gain_observation(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn audio_frontend_bootstrap(
    state: State<'_, audio::AudioState>,
    request: audio::frontend_bootstrap::Request,
) -> Result<audio::frontend_bootstrap::Reply, String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("audio_frontend_bootstrap")
        .class(audio::control::request_class::frontend_bootstrap(&request));
    super::call(&state, entry, "Failed to lock audio state", move |host| {
        host.frontend_bootstrap(request)
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_saved_audio_config(
    state: State<'_, audio::AudioState>,
) -> Result<Option<audio::ActiveAudioConfig>, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_saved_audio_config"),
        "音声設定を取得できません",
        move |host| host.read_saved_audio_config(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_audio_state(
    state: State<'_, audio::AudioState>,
) -> Result<audio::AudioStateInfo, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_audio_state"),
        "Failed to lock audio state",
        move |host| -> Result<_, String> { Ok(host.get_state()) },
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_engine_tuning_config(
    state: State<'_, audio::AudioState>,
) -> Result<audio::EngineTuningConfig, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_engine_tuning_config"),
        "Failed to lock audio state",
        move |host| -> Result<_, String> { Ok(host.get_engine_tuning_config()) },
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_engine_tuning_config(
    state: State<'_, audio::AudioState>,
    config: audio::EngineTuningConfig,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_engine_tuning_config"),
        "Failed to lock audio state",
        move |host| -> Result<_, String> {
            host.set_engine_tuning_config(config);
            Ok(())
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_engine_runtime_stats(
    state: State<'_, audio::AudioState>,
) -> Result<audio::EngineRuntimeStats, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_engine_runtime_stats"),
        "Failed to lock audio state",
        move |host| host.get_engine_runtime_stats(),
    )
    .await
}

// 平坦なIPC引数とTauriの型検証を保ち、音声起動の設定だけを一つにまとめる。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioStartOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    input_source: Option<crate::input_source::Request>,
    input: Option<String>,
    output: Option<String>,
    host: Option<String>,
    buffer_size: Option<u32>,
    sample_rate: Option<u32>,
    input_id: Option<String>,
    output_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_routing: Option<crate::ipc::ChannelRouting>,
}

fn command_field<'de, T: serde::Deserialize<'de>, R: tauri::Runtime>(
    command: &tauri::ipc::CommandItem<'de, R>,
    key: &'static str,
) -> Result<T, tauri::ipc::InvokeError> {
    tauri::ipc::CommandArg::from_command(tauri::ipc::CommandItem {
        plugin: command.plugin,
        name: command.name,
        key,
        message: command.message,
        acl: command.acl,
    })
}

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for AudioStartOptions {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        Ok(Self {
            input_source: command_field(&command, "inputSource")?,
            input: command_field(&command, "input")?,
            output: command_field(&command, "output")?,
            host: command_field(&command, "host")?,
            buffer_size: command_field(&command, "bufferSize")?,
            sample_rate: command_field(&command, "sampleRate")?,
            input_id: command_field(&command, "inputId")?,
            output_id: command_field(&command, "outputId")?,
            channel_routing: command_field(&command, "channelRouting")?,
        })
    }
}

#[tauri::command]
pub(crate) async fn start_audio(
    state: State<'_, audio::AudioState>,
    options: AudioStartOptions,
    expected_state: Option<serde_json::Value>,
) -> Result<audio::AudioConfig, String> {
    let AudioStartOptions {
        input_source,
        input,
        output,
        host,
        buffer_size,
        sample_rate,
        input_id,
        output_id,
        channel_routing,
    } = options;
    let state = state.0.clone();
    log::debug!(
        "start_audio IPC Args: host={:?}, input={:?}, buffer={:?}, rate={:?}",
        host,
        input,
        buffer_size,
        sample_rate
    );
    let result = super::call(
        &state,
        audio::Entry::command("start_audio"),
        "Failed to lock audio state",
        move |host_instance| -> Result<_, String> {
            if let Some(expected) = expected_state {
                validate_expected_start_state(&host_instance.get_state(), &expected)?;
            }
            let input_source = host_instance
                .resolve_input_source(input_source)
                .map_err(|e| e.to_string())?;
            host_instance
                .start_with_input_source(
                    host,
                    input,
                    output,
                    buffer_size,
                    sample_rate,
                    input_id,
                    output_id,
                    channel_routing,
                    input_source,
                )
                .map_err(|e| audio::localize_audio_error(e.to_string()))
        },
    )
    .await;
    audio::emit::trace_mark("return", "start_audio");
    result
}

fn validate_expected_start_state(
    current: &audio::AudioStateInfo,
    expected: &serde_json::Value,
) -> Result<(), String> {
    if !current.is_running
        || current.condition_witness.is_none()
        || expected.get("condition_witness").is_none()
        || serde_json::to_value(current).map_err(|e| e.to_string())? != *expected
    {
        return Err(
            "音声の条件が変わりました。現在の設定を確認してから再試行してください。".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod expected_start_tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn stop_and_restart_invalidate_prior_condition_even_with_same_config_and_child() {
        let conditions = Arc::new(audio::conditions::Conditions::default());
        conditions.lifecycle(true);
        let state = |conditions: &Arc<audio::conditions::Conditions>| {
            let witness = conditions
                .snapshot()
                .ok()
                .map(|w| audio::AudioConditionWitness {
                    revision: w.revision().to_string(),
                    epoch: w.engine_epoch().to_string(),
                });
            audio::AudioStateInfo {
                is_running: true,
                config: None,
                condition_witness: witness,
            }
        };
        let before = state(&conditions);
        let expected = serde_json::to_value(&before).unwrap();
        assert!(validate_expected_start_state(&before, &expected).is_ok());
        conditions.lifecycle(false);
        assert!(validate_expected_start_state(&state(&conditions), &expected).is_err());
        conditions.lifecycle(true);
        assert!(validate_expected_start_state(&state(&conditions), &expected).is_err());
        let missing = serde_json::json!({ "is_running": true, "config": null });
        assert!(validate_expected_start_state(&state(&conditions), &missing).is_err());
    }
}

#[tauri::command]
pub(crate) async fn stop_audio(
    state: State<'_, audio::AudioState>,
    conditions: State<'_, audio::conditions::ConditionState>,
) -> Result<(), String> {
    let _interrupt = conditions.0.interrupt_restore();
    let state = state.0.clone();
    let result = super::call(
        &state,
        audio::Entry::command("stop_audio"),
        "Failed to lock audio state",
        move |host| host.stop(),
    )
    .await;
    audio::emit::trace_mark("return", "stop_audio");
    result
}

#[tauri::command]
pub(crate) async fn session_rack(
    state: State<'_, audio::AudioState>,
    request: crate::ipc::SessionRackRequest,
) -> Result<crate::ipc::SessionRackReply, String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("session_rack")
        .class(audio::control::request_class::session_rack(&request));
    super::call(&state, entry, "Failed to lock audio state", move |host| {
        host.session_rack(request)
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_plugin(
    state: State<'_, audio::AudioState>,
    request: crate::ipc::RestorePluginRequest,
) -> Result<crate::ipc::RestoredPlugin, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("restore_plugin"),
        "Failed to lock audio state",
        move |host| host.restore_plugin(request),
    )
    .await
}

/// ブラウザや IPC からの通常追加。エンジンはカタログ対象の CID だけを開く。
/// 保存データの復元は `restore_plugin` が旧ロード規則を使う。
#[tauri::command]
pub(crate) async fn load_plugin(
    state: State<'_, audio::AudioState>,
    path: String,
    class_id: Option<String>,
) -> Result<crate::ipc::LoadedPlugin, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("load_plugin"),
        "Failed to lock audio state",
        move |host| host.load_plugin(&path, class_id.as_deref()),
    )
    .await
}

#[tauri::command]
pub(crate) async fn remove_plugin(
    state: State<'_, audio::AudioState>,
    id: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("remove_plugin"),
        "Failed to lock audio state",
        move |host| host.remove_plugin(&id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn reorder_plugins(
    state: State<'_, audio::AudioState>,
    order: Vec<String>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("reorder_plugins"),
        "Failed to lock audio state",
        move |host| host.reorder_plugins(order),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_bypass(
    state: State<'_, audio::AudioState>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_bypass"),
        "Failed to lock audio state",
        move |host| host.set_bypass(&id, active),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_mute(
    state: State<'_, audio::AudioState>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_mute"),
        "Failed to lock audio state",
        move |host| host.set_mute(&id, active),
    )
    .await
}

#[tauri::command]
pub(crate) async fn resume_plugin(
    state: State<'_, audio::AudioState>,
    id: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("resume_plugin"),
        "Failed to lock audio state",
        move |host| host.resume_plugin(&id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_gain(
    state: State<'_, audio::AudioState>,
    id: String,
    value: f32,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_gain"),
        "Failed to lock audio state",
        move |host| host.set_gain(&id, value),
    )
    .await
}

#[tauri::command]
pub(crate) async fn restart_audio_engine(
    state: State<'_, audio::AudioState>,
    options: AudioStartOptions,
) -> Result<audio::AudioConfig, String> {
    let AudioStartOptions {
        input_source,
        input,
        output,
        host,
        buffer_size,
        sample_rate,
        input_id,
        output_id,
        channel_routing,
    } = options;
    let state = state.0.clone();
    let microphone_host = host.clone();
    let needs_microphone = !input_source
        .as_ref()
        .is_some_and(|s| matches!(s.source, crate::input_source::Config::ProcessLoopback(_)));
    log::debug!(
        "restart_audio_engine IPC Args: host={:?}, input={:?}, buffer={:?}, rate={:?}",
        host,
        input,
        buffer_size,
        sample_rate
    );
    // 未許可・確認不能なら、既存の音声とサイドカー上のVSTを保持する。
    if needs_microphone {
        super::run_blocking(move || {
            desktop_integration::check_microphone_access(microphone_host.as_deref())
                .map_err(audio::localize_audio_error)
        })
        .await?;
    }
    let result = super::call(
        &state,
        audio::Entry::command("restart_audio_engine"),
        "Failed to lock audio state",
        move |audio_host| -> Result<_, String> {
            audio_host
                .preflight_live_changes()
                .map_err(|error| error.to_string())?;
            let input_source = audio_host
                .resolve_input_source(input_source)
                .map_err(|e| e.to_string())?;
            audio_host.preserve_live_changes_for_restart();
            audio_host.kill_engine();
            // Short delay to ensure process is dead? Usually synchronous kill is fine on Windows.
            // Re-start
            audio_host
                .start_with_input_source(
                    host,
                    input,
                    output,
                    buffer_size,
                    sample_rate,
                    input_id,
                    output_id,
                    channel_routing,
                    input_source,
                )
                .map_err(|e| audio::localize_audio_error(e.to_string()))
        },
    )
    .await;
    audio::emit::trace_mark("return", "restart_audio_engine");
    result
}

#[tauri::command]
pub(crate) async fn scan_plugins(
    app: tauri::AppHandle,
    extra_roots: Option<Vec<String>>,
) -> Result<Vec<vst_host::VstPlugin>, String> {
    // 省略時は標準の2フォルダーだけ。追加分は画面が保存したパスを渡す。
    let extra_roots = extra_roots.unwrap_or_default();
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        if !config_dir.exists() {
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        }
        vst_host::scan_system_vst3(&config_dir, &extra_roots)
    })
    .await
}

#[tauri::command]
pub(crate) async fn scan_plugin_catalog(
    app: tauri::AppHandle,
    mode: Option<String>,
    retry_failed: Option<bool>,
    extra_roots: Option<Vec<String>>,
) -> Result<vst_host::PluginCatalogView, String> {
    let mode = match mode.as_deref() {
        None | Some("incremental") => vst_host::catalog::ScanMode::Incremental,
        Some("full") => vst_host::catalog::ScanMode::Full {
            retry_failed: retry_failed.unwrap_or(false),
        },
        Some(_) => return Err("スキャンの種類が不正です".into()),
    };
    let extra_roots = extra_roots.unwrap_or_default();
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        if !config_dir.exists() {
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        }
        vst_host::scan_plugin_catalog(&config_dir, mode, &extra_roots)
    })
    .await
}

#[tauri::command]
pub(crate) async fn retry_plugin_scan(
    app: tauri::AppHandle,
    path: String,
    extra_roots: Option<Vec<String>>,
) -> Result<vst_host::PluginCatalogView, String> {
    let extra_roots = extra_roots.unwrap_or_default();
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        if !config_dir.exists() {
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        }
        vst_host::scanner::retry_plugin_scan(&config_dir, &path, &extra_roots)
    })
    .await
}

#[tauri::command]
pub(crate) async fn clear_blacklist(app: AppHandle) -> Result<(), String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        if !config_dir.exists() {
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        }
        vst_host::scanner::clear_scan_exclusions(&config_dir)
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_editor(
    state: State<'_, audio::AudioState>,
    id: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("open_editor"),
        "Failed to lock audio state",
        move |host| host.open_editor(&id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_plugin_state(
    state: State<'_, audio::AudioState>,
    id: String,
) -> Result<String, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_plugin_state"),
        "Failed to lock audio state",
        move |host| host.get_plugin_state(&id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_plugin_state(
    audio: State<'_, audio::AudioState>,
    id: String,
    state: String,
) -> Result<(), String> {
    let audio = audio.0.clone();
    super::call(
        &audio,
        audio::Entry::command("set_plugin_state"),
        "Failed to lock audio state",
        move |host| host.set_plugin_state(&id, &state),
    )
    .await
}

#[tauri::command]
pub(crate) async fn toggle_global_mute(
    state: State<'_, audio::AudioState>,
    conditions: State<'_, audio::conditions::ConditionState>,
) -> Result<(), String> {
    let _interrupt = conditions.0.interrupt_restore();
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("toggle_global_mute"),
        "Failed to lock audio state",
        move |host| host.toggle_global_mute(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_global_mute(
    state: State<'_, audio::AudioState>,
    conditions: State<'_, audio::conditions::ConditionState>,
    active: bool,
) -> Result<(), String> {
    let _interrupt = conditions.0.interrupt_restore();
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_global_mute"),
        "Failed to lock audio state",
        move |host| host.set_global_mute(active),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_input_gain(
    state: State<'_, audio::AudioState>,
    value: f32,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_input_gain"),
        "Failed to lock audio state",
        move |host| host.set_input_gain(value),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_noise_reduction(
    state: State<'_, audio::AudioState>,
    active: bool,
    mode: Option<String>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_noise_reduction"),
        "Failed to lock audio state",
        move |host| host.set_noise_reduction(active, mode),
    )
    .await
}

#[tauri::command]
pub(crate) async fn start_noise_learning(
    state: State<'_, audio::AudioState>,
    duration_ms: Option<u32>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("start_noise_learning"),
        "Failed to lock audio state",
        move |host| host.start_noise_learning(duration_ms.unwrap_or(3000)),
    )
    .await
}

#[tauri::command]
pub(crate) async fn cancel_noise_learning(
    state: State<'_, audio::AudioState>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("cancel_noise_learning"),
        "Failed to lock audio state",
        move |host| host.cancel_noise_learning(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_noise_control_config(
    state: State<'_, audio::AudioState>,
    active: bool,
    mode: String,
    strength: f32,
    voice_guard: bool,
    require_running: Option<bool>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_noise_control_config"),
        "Failed to lock audio state",
        move |host| {
            host.set_noise_control_config_routed(
                require_running.unwrap_or(false),
                active,
                mode,
                strength,
                voice_guard,
            )
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_built_in_effects(
    state: State<'_, audio::AudioState>,
    active: bool,
    preset: Option<String>,
    amount: f32,
    singing: Option<crate::audio_engine::singing::SingingParams>,
    require_running: Option<bool>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_built_in_effects"),
        "Failed to lock audio state",
        move |host| {
            host.set_built_in_effects_routed(
                require_running.unwrap_or(false),
                active,
                preset,
                amount,
                singing,
            )
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn builtin_effects(
    state: State<'_, audio::AudioState>,
    request: crate::audio_engine::builtin::Request,
    require_running: Option<bool>,
) -> Result<crate::audio_engine::builtin::Snapshot, String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("builtin_effects")
        .class(audio::control::request_class::builtin_effects(&request));
    super::call(&state, entry, "Failed to lock audio state", move |host| {
        host.builtin_effects_routed(require_running.unwrap_or(false), request)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_loudness_measurement(
    state: State<'_, audio::AudioState>,
    id: Option<u64>,
) -> Result<(), String> {
    let host = state.0.clone();
    let entry = audio::Entry::command("set_loudness_measurement")
        .class(audio::control::request_class::set_loudness_measurement(&id));
    super::call(
        &host,
        entry,
        "音声状態を取得できません",
        move |host| host.set_loudness_measurement(id),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_output_gain(
    state: State<'_, audio::AudioState>,
    value: f32,
) -> Result<(), String> {
    let host = state.0.clone();
    super::call(
        &host,
        audio::Entry::command("set_output_gain"),
        "音声状態を取得できません",
        move |host| host.set_output_gain(value),
    )
    .await
}

#[tauri::command]
pub(crate) async fn auto_gain(
    state: State<'_, audio::AudioState>,
    request: audio_engine::auto_gain::Request,
) -> Result<audio_engine::auto_gain::Snapshot, String> {
    let host = state.0.clone();
    let entry = audio::Entry::command("auto_gain")
        .class(audio::control::request_class::auto_gain(&request));
    super::call(
        &host,
        entry,
        "音声状態を取得できません",
        move |host| host.auto_gain(request),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_global_bypass(
    state: State<'_, audio::AudioState>,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_global_bypass"),
        "Failed to lock audio state",
        move |host| host.set_global_bypass(active),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_input_channels(
    state: State<'_, audio::AudioState>,
    left: usize,
    right: usize,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("set_input_channels"),
        "Failed to lock audio state",
        move |host| host.set_input_channels(left, right),
    )
    .await
}

#[tauri::command]
pub(crate) async fn set_channel_scan(
    state: State<'_, audio::AudioState>,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("set_channel_scan")
        .class(audio::control::request_class::set_channel_scan(active));
    super::call(&state, entry, "Failed to lock audio state", move |host| {
        host.set_channel_scan(active)
    })
    .await
}

#[tauri::command]
pub(crate) async fn play_test_tone(
    state: State<'_, audio::AudioState>,
    freq_hz: Option<f32>,
    duration_ms: Option<u32>,
    level_db: Option<f32>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("play_test_tone"),
        "Failed to lock audio state",
        move |host| {
            host.play_test_tone(
                freq_hz.unwrap_or(1000.0),
                duration_ms.unwrap_or(1500),
                level_db.unwrap_or(-20.0),
            )
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn stop_test_tone(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("stop_test_tone"),
        "Failed to lock audio state",
        move |host| host.stop_test_tone(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn measure_round_trip(
    state: State<'_, audio::AudioState>,
    level_db: Option<f32>,
) -> Result<crate::audio_engine::latency_measure::Snapshot, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("measure_round_trip"),
        "Failed to lock audio state",
        move |host| host.measure_round_trip(level_db),
    )
    .await
}

#[tauri::command]
pub(crate) async fn cancel_round_trip_measurement(
    state: State<'_, audio::AudioState>,
) -> Result<crate::audio_engine::latency_measure::Snapshot, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("cancel_round_trip_measurement"),
        "Failed to lock audio state",
        move |host| host.cancel_round_trip_measurement(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_round_trip_measurement(
    state: State<'_, audio::AudioState>,
) -> Result<crate::audio_engine::latency_measure::Snapshot, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_round_trip_measurement"),
        "Failed to lock audio state",
        move |host| host.get_round_trip_measurement(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn probe_loopback(
    state: State<'_, audio::AudioState>,
    input_device: String,
    duration_ms: Option<u32>,
    freq_hz: Option<f32>,
) -> Result<audio::LoopbackProbeResult, String> {
    // プローブは 1.5〜2 秒ブロックするため、メインスレッドを塞がないよう
    // ブロッキングスレッドで実行する（AudioState ロックはその間保持される）
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("probe_loopback"),
        "Failed to lock audio state",
        move |host| {
            host.probe_loopback(
                input_device,
                duration_ms.unwrap_or(1500),
                freq_hz.unwrap_or(1000.0),
            )
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn get_routing_diagnostics(
    state: State<'_, audio::AudioState>,
) -> Result<routing_diag::RoutingDiagnosticsReport, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_routing_diagnostics"),
        "Failed to lock audio state",
        move |host| -> Result<_, String> {
            let engine_rate = host.get_state().config.as_ref().and_then(|c| c.sample_rate);
            Ok(routing_diag::collect_routing_diagnostics(engine_rate))
        },
    )
    .await
}

#[tauri::command]
pub(crate) async fn live_modes(
    state: State<'_, audio::AudioState>,
    request: crate::audio_engine::live_modes::Request,
) -> Result<crate::audio_engine::live_modes::Snapshot, String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("live_modes")
        .class(audio::control::request_class::live_modes(&request));
    super::call(
        &state,
        entry,
        "音声状態を取得できません",
        move |host| host.live_modes(request),
    )
    .await
}
#[tauri::command]
pub(crate) async fn preflight_live_changes(
    state: State<'_, audio::AudioState>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("preflight_live_changes"),
        "音声状態を取得できません",
        move |host| host.preflight_live_changes(),
    )
    .await
}

#[tauri::command]
pub(crate) async fn begin_live_changes(
    state: State<'_, audio::AudioState>,
) -> Result<String, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("begin_live_changes"),
        "音声状態を取得できません",
        move |host| host.begin_live_changes(),
    )
    .await
}
#[tauri::command]
pub(crate) async fn end_live_changes(
    state: State<'_, audio::AudioState>,
    token: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("end_live_changes"),
        "音声状態を取得できません",
        move |host| host.end_live_changes(token),
    )
    .await
}

#[tauri::command]
pub(crate) async fn noise_measurement(
    state: State<'_, audio::AudioState>,
    request: crate::audio_engine::core::noise_learning::Request,
) -> Result<crate::audio_engine::core::noise_learning::Snapshot, String> {
    let state = state.0.clone();
    let entry = audio::Entry::command("noise_measurement")
        .class(audio::control::request_class::noise_measurement(&request));
    super::call(
        &state,
        entry,
        "音声の状態を取得できません",
        move |host| host.noise_measurement(request),
    )
    .await
}

#[cfg(test)]
mod start_options_ipc_tests {
    use super::AudioStartOptions;
    use serde_json::{json, Value};

    #[tauri::command]
    fn inspect_start_options(options: AudioStartOptions, expected_state: Option<Value>) -> Value {
        json!({ "options": options, "expectedState": expected_state })
    }

    #[test]
    fn flat_start_arguments_keep_tauri_validation_and_optional_values() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![inspect_start_options])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "start-options", Default::default())
            .build()
            .unwrap();
        let invoke = |body| {
            tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: "inspect_start_options".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body,
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            )
        };
        let options = json!({
            "input": "microphone", "output": "headphones", "host": "WASAPI",
            "bufferSize": 256, "sampleRate": 48000,
            "inputId": "stable-input", "outputId": "stable-output"
        });
        let expected_state =
            json!({ "is_running": true, "condition_witness": { "revision": "9" } });
        let mut routed = options.clone();
        routed["channelRouting"] = json!({ "inputChannels": [2, 3], "outputRouting": { "mode": "independent", "channels": [0, 1] } });
        assert_eq!(
            invoke(tauri::ipc::InvokeBody::Json(routed.clone()))
                .unwrap()
                .deserialize::<Value>()
                .unwrap(),
            json!({ "options": routed, "expectedState": null })
        );
        let mut payload = options.clone();
        payload["expectedState"] = expected_state.clone();
        assert_eq!(
            invoke(tauri::ipc::InvokeBody::Json(payload))
                .unwrap()
                .deserialize::<Value>()
                .unwrap(),
            json!({ "options": options, "expectedState": expected_state })
        );
        let empty = json!({
            "input": null, "output": null, "host": null,
            "bufferSize": null, "sampleRate": null, "inputId": null, "outputId": null
        });
        for payload in [json!({}), empty.clone()] {
            assert_eq!(
                invoke(tauri::ipc::InvokeBody::Json(payload))
                    .unwrap()
                    .deserialize::<Value>()
                    .unwrap(),
                json!({ "options": empty, "expectedState": null })
            );
        }
        for (key, invalid) in [
            ("input", json!(42)),
            ("output", json!([])),
            ("host", json!(false)),
            ("bufferSize", json!(-1)),
            ("sampleRate", json!("48000")),
            ("inputId", json!({})),
            ("outputId", json!(42)),
        ] {
            let mut payload = options.clone();
            payload[key] = invalid;
            let error = invoke(tauri::ipc::InvokeBody::Json(payload)).unwrap_err();
            assert!(error.as_str().unwrap().contains(key), "{error}");
        }
        assert!(invoke(tauri::ipc::InvokeBody::Raw(vec![1, 2, 3])).is_err());
    }
}

#[tauri::command]
pub(crate) async fn get_process_input_sources(
    state: State<'_, audio::AudioState>,
) -> Result<Vec<audio::process_inputs::Candidate>, String> {
    let state = state.0.clone();
    super::call(
        &state,
        audio::Entry::command("get_process_input_sources"),
        "音声設定を取得できません",
        move |host| host.process_input_sources(),
    )
    .await
}

#[cfg(test)]
#[path = "audio/compat_tests.rs"]
mod compat_tests;
