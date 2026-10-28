//! 音声・プラグイン操作と診断のコマンド。
use crate::{audio, audio_engine, desktop_integration, routing_diag, vst_host};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub(crate) async fn peak_protection(
    state: State<'_, audio::AudioState>,
    config: Option<audio_engine::peak_protection::Config>,
) -> Result<audio_engine::peak_protection::Snapshot, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        state
            .lock()
            .map_err(|_| "音声状態を取得できません")?
            .peak_protection(config)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn live_output(
    state: State<'_, audio::AudioState>,
    config: Option<audio_engine::live_output::Config>,
) -> Result<audio_engine::live_output::Status, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        state
            .lock()
            .map_err(|_| "音声状態を取得できません")?
            .live_output(config)
            .map_err(|e| e.to_string())
    })
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
    state: std::sync::Arc<std::sync::Mutex<audio::AudioHost>>,
    force_refresh: bool,
) -> Result<audio::AudioDeviceList, String> {
    let begin_state = state.clone();
    let start = super::run_blocking(move || {
        let mut host = begin_state
            .lock()
            .map_err(|_| "Failed to lock audio state")?;
        host.begin_device_scan(force_refresh)
            .map_err(|error| error.to_string())
    })
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
            let _ = super::run_blocking(move || {
                let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
                host.cancel_device_scan(&ticket)
                    .map_err(|error| error.to_string())
            })
            .await;
            return Err("デバイス検出が時間切れになりました。再試行してください。".into());
        }
        let poll_state = state.clone();
        let poll_ticket = ticket.clone();
        let polled = super::run_blocking(move || {
            let mut host = poll_state
                .lock()
                .map_err(|_| "Failed to lock audio state")?;
            host.poll_device_scan(&poll_ticket)
                .map_err(|error| error.to_string())
        })
        .await;
        match polled {
            Ok(Some(devices)) => return Ok(devices),
            Ok(None) => {}
            Err(error) => {
                let _ = super::run_blocking(move || {
                    let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
                    host.cancel_device_scan(&ticket)
                        .map_err(|error| error.to_string())
                })
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
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.output_gain_observation()
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn audio_frontend_bootstrap(
    state: State<'_, audio::AudioState>,
    request: audio::frontend_bootstrap::Request,
) -> Result<audio::frontend_bootstrap::Reply, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.frontend_bootstrap(request)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_audio_state(
    state: State<'_, audio::AudioState>,
) -> Result<audio::AudioStateInfo, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let host = state.lock().map_err(|_| "Failed to lock audio state")?;
        Ok(host.get_state())
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_engine_tuning_config(
    state: State<'_, audio::AudioState>,
) -> Result<audio::EngineTuningConfig, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let host = state.lock().map_err(|_| "Failed to lock audio state")?;
        Ok(host.get_engine_tuning_config())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_engine_tuning_config(
    state: State<'_, audio::AudioState>,
    config: audio::EngineTuningConfig,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_engine_tuning_config(config);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_engine_runtime_stats(
    state: State<'_, audio::AudioState>,
) -> Result<audio::EngineRuntimeStats, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.get_engine_runtime_stats().map_err(|e| e.to_string())
    })
    .await
}

// 平坦なIPC引数とTauriの型検証を保ち、音声起動の設定だけを一つにまとめる。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioStartOptions {
    input: Option<String>,
    output: Option<String>,
    host: Option<String>,
    buffer_size: Option<u32>,
    sample_rate: Option<u32>,
    input_id: Option<String>,
    output_id: Option<String>,
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
            input: command_field(&command, "input")?,
            output: command_field(&command, "output")?,
            host: command_field(&command, "host")?,
            buffer_size: command_field(&command, "bufferSize")?,
            sample_rate: command_field(&command, "sampleRate")?,
            input_id: command_field(&command, "inputId")?,
            output_id: command_field(&command, "outputId")?,
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
        input,
        output,
        host,
        buffer_size,
        sample_rate,
        input_id,
        output_id,
    } = options;
    let state = state.0.clone();
    super::run_blocking(move || {
        log::debug!(
            "start_audio IPC Args: host={:?}, input={:?}, buffer={:?}, rate={:?}",
            host,
            input,
            buffer_size,
            sample_rate
        );
        let mut host_instance = state.lock().map_err(|_| "Failed to lock audio state")?;
        if let Some(expected) = expected_state {
            validate_expected_start_state(&host_instance.get_state(), &expected)?;
        }
        host_instance
            .start_with_device_ids(
                host,
                input,
                output,
                buffer_size,
                sample_rate,
                input_id,
                output_id,
            )
            .map_err(|e| audio::localize_audio_error(e.to_string()))
    })
    .await
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
pub(crate) async fn stop_audio(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.stop().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn session_rack(
    state: State<'_, audio::AudioState>,
    request: crate::ipc::SessionRackRequest,
) -> Result<crate::ipc::SessionRackReply, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.session_rack(request)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn restore_plugin(
    state: State<'_, audio::AudioState>,
    request: crate::ipc::RestorePluginRequest,
) -> Result<crate::ipc::RestoredPlugin, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.restore_plugin(request)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn load_plugin(
    state: State<'_, audio::AudioState>,
    path: String,
) -> Result<String, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.load_plugin(&path).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn remove_plugin(
    state: State<'_, audio::AudioState>,
    id: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.remove_plugin(&id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn reorder_plugins(
    state: State<'_, audio::AudioState>,
    order: Vec<String>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.reorder_plugins(order).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_bypass(
    state: State<'_, audio::AudioState>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_bypass(&id, active).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_mute(
    state: State<'_, audio::AudioState>,
    id: String,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_mute(&id, active).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_gain(
    state: State<'_, audio::AudioState>,
    id: String,
    value: f32,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_gain(&id, value).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn restart_audio_engine(
    state: State<'_, audio::AudioState>,
    options: AudioStartOptions,
) -> Result<audio::AudioConfig, String> {
    let AudioStartOptions {
        input,
        output,
        host,
        buffer_size,
        sample_rate,
        input_id,
        output_id,
    } = options;
    let state = state.0.clone();
    super::run_blocking(move || {
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
        let mut audio_host = state.lock().map_err(|_| "Failed to lock audio state")?;
        audio_host
            .preflight_live_changes()
            .map_err(|error| error.to_string())?;
        audio_host.preserve_live_changes_for_restart();
        audio_host.kill_engine();
        // Short delay to ensure process is dead? Usually synchronous kill is fine on Windows.
        // Re-start
        audio_host
            .start_with_device_ids(
                host,
                input,
                output,
                buffer_size,
                sample_rate,
                input_id,
                output_id,
            )
            .map_err(|e| audio::localize_audio_error(e.to_string()))
    })
    .await
}

#[tauri::command]
pub(crate) async fn scan_plugins(
    app: tauri::AppHandle,
) -> Result<Vec<vst_host::VstPlugin>, String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        if !config_dir.exists() {
            std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        }
        Ok(vst_host::scan_system_vst3(&config_dir))
    })
    .await
}

#[tauri::command]
pub(crate) async fn clear_blacklist(app: AppHandle) -> Result<(), String> {
    super::run_blocking(move || {
        let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let mut blacklist = vst_host::blacklist::Blacklist::new(&config_dir);
        blacklist.clear();
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn open_editor(
    state: State<'_, audio::AudioState>,
    id: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.open_editor(&id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_plugin_state(
    state: State<'_, audio::AudioState>,
    id: String,
) -> Result<String, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.get_plugin_state(&id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_plugin_state(
    audio: State<'_, audio::AudioState>,
    id: String,
    state: String,
) -> Result<(), String> {
    let audio = audio.0.clone();
    super::run_blocking(move || {
        let mut host = audio.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_plugin_state(&id, &state)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn toggle_global_mute(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.toggle_global_mute().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_global_mute(
    state: State<'_, audio::AudioState>,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_global_mute(active).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_input_gain(
    state: State<'_, audio::AudioState>,
    value: f32,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_input_gain(value).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_noise_reduction(
    state: State<'_, audio::AudioState>,
    active: bool,
    mode: Option<String>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_noise_reduction(active, mode)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn start_noise_learning(
    state: State<'_, audio::AudioState>,
    duration_ms: Option<u32>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.start_noise_learning(duration_ms.unwrap_or(3000))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn cancel_noise_learning(
    state: State<'_, audio::AudioState>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.cancel_noise_learning().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_noise_control_config(
    state: State<'_, audio::AudioState>,
    active: bool,
    mode: String,
    strength: f32,
    voice_guard: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_noise_control_config(active, mode, strength, voice_guard)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_built_in_effects(
    state: State<'_, audio::AudioState>,
    active: bool,
    preset: Option<String>,
    amount: f32,
    singing: Option<crate::audio_engine::singing::SingingParams>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_built_in_effects_full(active, preset, amount, singing)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn builtin_effects(
    state: State<'_, audio::AudioState>,
    request: crate::audio_engine::builtin::Request,
) -> Result<crate::audio_engine::builtin::Snapshot, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.builtin_effects(request)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_loudness_measurement(
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
pub(crate) async fn set_output_gain(
    state: State<'_, audio::AudioState>,
    value: f32,
) -> Result<(), String> {
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
pub(crate) async fn auto_gain(
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
pub(crate) async fn set_global_bypass(
    state: State<'_, audio::AudioState>,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_global_bypass(active).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_input_channels(
    state: State<'_, audio::AudioState>,
    left: usize,
    right: usize,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_input_channels(left, right)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_channel_scan(
    state: State<'_, audio::AudioState>,
    active: bool,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.set_channel_scan(active).map_err(|e| e.to_string())
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
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.play_test_tone(
            freq_hz.unwrap_or(1000.0),
            duration_ms.unwrap_or(1500),
            level_db.unwrap_or(-20.0),
        )
        .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn stop_test_tone(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.stop_test_tone().map_err(|e| e.to_string())
    })
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
    tauri::async_runtime::spawn_blocking(move || {
        let mut host = state
            .lock()
            .map_err(|_| "Failed to lock audio state".to_string())?;
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
pub(crate) async fn get_routing_diagnostics(
    state: State<'_, audio::AudioState>,
) -> Result<routing_diag::RoutingDiagnosticsReport, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let host = state.lock().map_err(|_| "Failed to lock audio state")?;
        let engine_rate = host.get_state().config.as_ref().and_then(|c| c.sample_rate);
        Ok(routing_diag::collect_routing_diagnostics(engine_rate))
    })
    .await
}

#[tauri::command]
pub(crate) async fn live_modes(
    state: State<'_, audio::AudioState>,
    request: crate::audio_engine::live_modes::Request,
) -> Result<crate::audio_engine::live_modes::Snapshot, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        state
            .lock()
            .map_err(|_| "音声状態を取得できません")?
            .live_modes(request)
            .map_err(|error| error.to_string())
    })
    .await
}
#[tauri::command]
pub(crate) async fn preflight_live_changes(
    state: State<'_, audio::AudioState>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        state
            .lock()
            .map_err(|_| "音声状態を取得できません")?
            .preflight_live_changes()
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn begin_live_changes(
    state: State<'_, audio::AudioState>,
) -> Result<String, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        state
            .lock()
            .map_err(|_| "音声状態を取得できません")?
            .begin_live_changes()
            .map_err(|error| error.to_string())
    })
    .await
}
#[tauri::command]
pub(crate) async fn end_live_changes(
    state: State<'_, audio::AudioState>,
    token: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        state
            .lock()
            .map_err(|_| "音声状態を取得できません")?
            .end_live_changes(token)
            .map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn noise_measurement(
    state: State<'_, audio::AudioState>,
    request: crate::audio_engine::core::noise_learning::Request,
) -> Result<crate::audio_engine::core::noise_learning::Snapshot, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        state
            .lock()
            .map_err(|_| "音声の状態を取得できません")?
            .noise_measurement(request)
            .map_err(|e| e.to_string())
    })
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
