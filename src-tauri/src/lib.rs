use std::sync::{mpsc, Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
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
        host, input, buffer_size, sample_rate
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
        host, input, buffer_size, sample_rate
    );
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
async fn export_preset(app: AppHandle, name: String) -> Result<(), String> {
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let preset = presets::load_preset(&config_dir, &name)?;
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
fn set_output_gain(state: State<'_, audio::AudioState>, value: f32) -> Result<(), String> {
    let mut host = state.0.lock().map_err(|_| "Failed to lock audio state")?;
    host.set_output_gain(value).map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
                    log::trace!("Global Shortcut Event: {:?} {:?}", shortcut, event.state);
                    if event.state == ShortcutState::Pressed {
                        if shortcut.matches(Modifiers::ALT, Code::KeyM) {
                            log::info!("Global Mute Hotkey Pressed");
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

            // --- System Tray ---
            let show_item = MenuItemBuilder::with_id("show", "Auralyn を表示").build(app)?;
            let mute_item = MenuItemBuilder::with_id("mute_toggle", "ミュート切替 (Alt+M)").build(app)?;
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
            save_preset,
            load_preset,
            delete_preset,
            export_preset,
            import_preset,
            toggle_global_mute,
            set_global_mute,
            set_input_gain,
            set_noise_reduction,
            set_output_gain,
            set_global_bypass,
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
