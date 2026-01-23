use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub mod audio;
pub mod audio_engine;
pub mod autostart;
pub mod ipc;
pub mod obs;
pub mod vst_host;
use crate::vst_host::presets::{self, Preset, PresetPlugin};

#[tauri::command]
fn get_autostart_status() -> Result<autostart::AutostartStatus, String> {
    autostart::get_autostart_status().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    autostart::set_autostart_enabled(enabled).map_err(|e| e.to_string())
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
fn start_audio(
    state: State<'_, audio::AudioState>,
    input: Option<String>,
    output: Option<String>,
    host: Option<String>,
    buffer_size: Option<u32>,
    sample_rate: Option<u32>,
) -> Result<audio::AudioConfig, String> {
    println!(
        "DEBUG: start_audio IPC Args: host={:?}, input={:?}, buffer={:?}, rate={:?}",
        host, input, buffer_size, sample_rate
    );
    let mut host_instance = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host_instance
        .start(host, input, output, buffer_size, sample_rate)
        .map_err(|e| localize_audio_error(e.to_string()))
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
    println!(
        "DEBUG: restart_audio_engine IPC Args: host={:?}, input={:?}, buffer={:?}, rate={:?}",
        host, input, buffer_size, sample_rate
    );
    let mut audio_host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    audio_host.kill_engine();
    // Short delay to ensure process is dead? Usually synchronous kill is fine on Windows.
    // Re-start
    audio_host
        .start(host, input, output, buffer_size, sample_rate)
        .map_err(|e| localize_audio_error(e.to_string()))
}

fn localize_audio_error(e: String) -> String {
    if e.to_lowercase()
        .contains("sample clock or rate cannot be determined")
    {
        return "オーディオデバイスのエラー: サンプルレートまたはクロックソースが取得できません。\nデバイスが他のアプリケーションによって別のレートでロックされている可能性があります。\n(ヒント: 他の音が出るアプリを閉じるか、デバイスのコントロールパネル設定を確認してください)".to_string();
    }
    if e.to_lowercase().contains("device not found") {
        return format!(
            "デバイスが見つかりません: {}\n再接続して「更新」ボタンを押してください。",
            e
        );
    }
    if e.to_lowercase().contains("access is denied") {
        return "デバイスへのアクセスが拒否されました。\nマイクのプライバシー設定や、排他モード設定を確認してください。".to_string();
    }
    if e.to_lowercase()
        .contains("stream configuration is not supported")
    {
        return "指定された設定（サンプルレートまたはバッファサイズ）はこのデバイスでサポートされていません。\n(ヒント: バッファサイズを大きくするか、デバイスのコントロールパネルで設定を変更してください)".to_string();
    }
    // Default fallback
    format!("オーディオエラー: {}", e)
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
async fn save_preset(
    app: AppHandle,
    name: String,
    plugins: Vec<PresetPlugin>,
) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let preset = Preset {
        name: name.clone(),
        plugins,
    };
    presets::save_preset(&config_dir, &name, &preset)
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

    let audio_state = audio::AudioState(Arc::new(Mutex::new(audio::AudioHost::new())));
    let obs_state = obs::ObsState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app
                .get_webview_window("main")
                .expect("no main window")
                .set_focus();
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    println!("Global Shortcut Event: {:?} {:?}", shortcut, event.state);
                    if event.state == ShortcutState::Pressed {
                        if shortcut.matches(Modifiers::ALT, Code::KeyM) {
                            println!("Global Mute Hotkey Pressed!");
                            if let Some(state) = app.try_state::<audio::AudioState>() {
                                if let Ok(mut host) = state.0.lock() {
                                    let _ = host.toggle_global_mute();
                                }
                            }
                        }
                    }
                })
                .build(),
        )
        .manage(audio_state)
        .manage(obs_state)
        .setup(|app| {
            let state = app.state::<audio::AudioState>();

            // Register Shortcut
            if let Err(e) = app
                .handle()
                .global_shortcut()
                .register(Shortcut::new(Some(Modifiers::ALT), Code::KeyM))
            {
                log::error!("Failed to register global shortcut: {}", e);
            }

            // Explicitly set window icon (Fix for taskbar icon issue)
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(
                    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
                        .expect("Failed to load icon"),
                );
            }
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
        .invoke_handler(tauri::generate_handler![
            get_audio_devices,
            get_audio_state,
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
            save_preset,
            load_preset,
            delete_preset,
            toggle_global_mute,
            set_global_mute,
            set_input_gain,
            open_url,
            connect_obs,
            disconnect_obs,
            get_autostart_status,
            set_autostart_enabled,
            set_input_channels,
            set_channel_scan,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
