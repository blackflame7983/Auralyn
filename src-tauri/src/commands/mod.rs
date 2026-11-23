//! Tauriコマンド境界。ブロッキングI/OとIPC待機はUI・async executorから分離する。
pub(crate) mod audio;
pub(crate) mod bundles;
pub(crate) mod profiles;
pub(crate) mod voice_check;

/// 音声の操作の後に、後処理・後始末・所有物（排他ガード・作業領域・`maintenance` の解除・`app.exit`）を持つ入口の
/// 本体全体を、呼び出し元の取り消しから独立したタスクで走らせる。呼び出し元はその完了を待つだけで、
/// future を捨てても、投入した仕事と後処理は最後まで進む。
pub(crate) async fn detached<T: Send + 'static>(
    work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn(work)
        .await
        .map_err(|e| e.to_string())?
}

pub(super) async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}
