use std::sync::{Arc, Mutex};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

pub mod audio;
pub mod audio_analysis;
pub mod audio_engine;
pub mod autostart;
pub mod bundle;
mod child_process;
pub mod coexistence;
mod commands;
mod desktop_integration;
mod display_locale;
#[cfg(any(test, feature = "dsp-verification"))]
mod dsp_verification_allocator;
pub mod ipc;
mod migration;
pub mod obs;
pub mod obs_setup;
#[cfg(windows)]
mod process_job;
pub mod profile;
pub mod routing_diag;
mod shortcuts;
mod storage;
mod temporary_session;
mod updates;
pub mod vst_host;
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
    temporary_session::require_regular(&app)?;
    let distribution = *distribution;
    if distribution == desktop_integration::Distribution::Msix {
        return autostart::set_package_enabled(app, enabled)
            .await
            .map_err(|e| e.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        autostart::set_autostart_enabled(distribution, enabled)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
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
async fn disconnect_obs(app: AppHandle, state: State<'_, obs::ObsState>) -> Result<(), String> {
    obs::disconnect_obs(app, state).await
}

#[tauri::command]
async fn obs_preview_setup(
    state: State<'_, obs::ObsState>,
    mute_source: Option<String>,
) -> Result<obs_setup::Plan, String> {
    obs_setup::preview(&state, mute_source).await
}

#[tauri::command]
async fn obs_timing_targets(
    state: State<'_, obs::ObsState>,
    audio_conditions: State<'_, audio::conditions::ConditionState>,
) -> Result<obs_setup::TimingTargets, String> {
    obs_setup::timing_targets(&state, &audio_conditions.0).await
}

#[tauri::command]
async fn obs_preview_timing(
    state: State<'_, obs::ObsState>,
    request: obs_setup::TimingPreviewRequest,
) -> Result<obs_setup::Plan, String> {
    obs_setup::preview_timing(&state, request).await
}

#[tauri::command]
fn obs_live_scene_status(state: State<'_, obs::ObsState>) -> obs::LiveSceneStatus {
    obs::live_scene_status(&state)
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
async fn obs_audio_reach_current(
    obs_state: State<'_, obs::ObsState>,
    operation_id: String,
) -> Result<bool, String> {
    Ok(obs::audio_reach_current(&obs_state, &operation_id).await)
}

#[tauri::command]
async fn obs_check_audio_reach(
    obs_state: State<'_, obs::ObsState>,
    audio_state: State<'_, audio::AudioState>,
    duration_ms: Option<u32>,
) -> Result<obs::ObsAudioReachResult, String> {
    obs::check_audio_reach(&obs_state, &audio_state, duration_ms.unwrap_or(1500)).await
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
            .set_description(format!(
                "設定保存先を確認できませんでした。既存の設定は変更していません。\n{error:#}"
            ))
            .set_level(rfd::MessageLevel::Error)
            .show();
        return;
    }

    let mode = match temporary_session::initialize(context.config_mut()) {
        Ok(mode) => mode,
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("Auralyn")
                .set_description(error)
                .set_level(rfd::MessageLevel::Error)
                .show();
            return;
        }
    };

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
        .manage(mode)
        .manage(distribution)
        .manage(migration::Preview::default())
        .manage(shortcuts::Shortcuts::default())
        .manage(updates::Updates::default())
        .manage(obs_state)
        .manage(commands::bundles::BundleState::default())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                if let Some(state) = webview.try_state::<display_locale::DisplayLocaleState>() {
                    state.retire_page();
                }
            }
        })
        .setup(|app| {
            // app_config_dirはMSIXではpackage専用、通常版では従来のRoaming AppData。
            let config_dir = app.path().app_config_dir()?;
            let locale_path = config_dir.join("display-locale.json");
            let read_path = locale_path.clone();
            let locale = tauri::async_runtime::block_on(commands::run_blocking(move || {
                Ok(display_locale::load(&read_path))
            }))?;
            let labels = locale.labels();
            let mut audio_host = audio::AudioHost::new(config_dir);
            if app.state::<temporary_session::Mode>().review_only {
                audio_host.require_explicit_start();
            }
            app.manage(audio::conditions::ConditionState(audio_host.conditions()));
            app.manage(audio::AudioState(Arc::new(Mutex::new(audio_host))));
            let state = app.state::<audio::AudioState>();

            // Explicitly set window icon (Fix for taskbar icon issue)
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_icon(
                    tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
                        .expect("Failed to load icon"),
                );
            }

            // --- System Tray ---
            let show_item = MenuItemBuilder::with_id("show", labels[0]).build(app)?;
            let mute_item = MenuItemBuilder::with_id("mute_toggle", labels[1]).build(app)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", labels[2]).build(app)?;
            app.manage(display_locale::DisplayLocaleState::new(
                locale_path,
                [show_item.clone(), mute_item.clone(), quit_item.clone()],
            ));

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
            commands::audio::peak_protection,
            temporary_session::temporary_session_status,
            temporary_session::acknowledge_session_review,
            temporary_session::restart_temporary_session,
            migration::export_settings,
            display_locale::begin_display_locale_session,
            display_locale::set_display_locale,
            migration::preview_settings,
            migration::apply_settings,
            migration::migration_bootstrap,
            migration::migration_complete_review,
            shortcuts::begin_shortcut_capture,
            shortcuts::end_shortcut_capture,
            shortcuts::get_shortcuts,
            shortcuts::save_shortcuts,
            updates::check_update,
            updates::download_update,
            updates::install_update,
            desktop_integration::get_distribution,
            desktop_integration::open_desktop_settings,
            commands::audio::get_audio_devices,
            commands::audio::live_output,
            commands::audio::get_audio_state,
            commands::audio::get_engine_tuning_config,
            commands::audio::set_engine_tuning_config,
            commands::audio::get_engine_runtime_stats,
            commands::audio::scan_plugins,
            commands::audio::clear_blacklist,
            commands::audio::start_audio,
            commands::audio::stop_audio,
            commands::audio::load_plugin,
            commands::audio::restore_plugin,
            commands::audio::session_rack,
            commands::audio::audio_frontend_bootstrap,
            commands::audio::get_output_gain_observation,
            commands::audio::remove_plugin,
            commands::audio::reorder_plugins,
            commands::audio::set_bypass,
            commands::audio::set_mute,
            commands::audio::set_gain,
            commands::audio::open_editor,
            commands::audio::restart_audio_engine,
            commands::profiles::list_presets,
            commands::bundles::broadcast_bundle,
            commands::profiles::list_profiles,
            commands::profiles::save_preset,
            commands::profiles::save_profile,
            commands::profiles::load_preset,
            commands::profiles::apply_profile,
            commands::profiles::has_backup_profile,
            commands::profiles::restore_backup_profile,
            commands::profiles::delete_preset,
            commands::profiles::export_preset,
            commands::profiles::export_profile,
            commands::profiles::import_preset,
            commands::profiles::import_profile,
            commands::audio::get_plugin_state,
            commands::audio::set_plugin_state,
            commands::audio::toggle_global_mute,
            commands::audio::set_global_mute,
            commands::audio::set_input_gain,
            commands::audio::set_noise_reduction,
            commands::audio::noise_measurement,
            commands::audio::start_noise_learning,
            commands::audio::cancel_noise_learning,
            commands::audio::set_noise_control_config,
            commands::audio::set_built_in_effects,
            commands::audio::builtin_effects,
            commands::audio::live_modes,
            commands::audio::preflight_live_changes,
            commands::audio::begin_live_changes,
            commands::audio::end_live_changes,
            commands::audio::set_output_gain,
            commands::audio::auto_gain,
            commands::audio::set_loudness_measurement,
            commands::audio::set_global_bypass,
            open_url,
            connect_obs,
            disconnect_obs,
            obs_preview_setup,
            obs_timing_targets,
            obs_preview_timing,
            obs_connection_status,
            obs_live_scene_status,
            obs_apply_setup,
            obs_setup_history,
            obs_restore_setup,
            obs_forget_setup_history,
            obs_check_audio_reach,
            obs_audio_reach_current,
            get_autostart_status,
            set_autostart_enabled,
            commands::audio::set_input_channels,
            commands::audio::set_channel_scan,
            commands::voice_check::start_voice_check,
            commands::voice_check::voice_check_preview,
            commands::voice_check::stop_voice_check,
            commands::voice_check::play_voice_check,
            commands::voice_check::stop_voice_check_playback,
            commands::voice_check::export_voice_check,
            commands::voice_check::export_voice_check_wav,
            commands::voice_check::analyze_voice_check,
            commands::audio::play_test_tone,
            commands::audio::stop_test_tone,
            commands::audio::probe_loopback,
            commands::audio::get_routing_diagnostics,
        ])
        .run(context)
        .expect("error while running tauri application");
}
