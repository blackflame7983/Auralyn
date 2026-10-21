//! 保存先を分けても、同じログインセッションで起動するホストは一つにする。
use tauri::{Emitter, Manager, Runtime};

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = app.emit("second-instance", ());
    })
}
