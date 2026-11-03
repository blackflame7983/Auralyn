use tauri::{Emitter, Runtime, Window};

#[tauri::command]
pub fn get_window_activity(window: Window) -> Result<bool, String> {
    activity(&window).map_err(|error| error.to_string())
}

fn activity<R: Runtime>(window: &Window<R>) -> tauri::Result<bool> {
    Ok(window.is_visible()? && !window.is_minimized()?)
}

pub fn publish<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    window.emit("app://window-activity", activity(window)?)
}
