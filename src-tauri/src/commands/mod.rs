//! Tauriコマンド境界。ブロッキングI/OとIPC待機はUI・async executorから分離する。
pub(crate) mod audio;
pub(crate) mod bundles;
pub(crate) mod profiles;
pub(crate) mod voice_check;

pub(super) async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}
