//! Tauriコマンド境界。ブロッキングI/OとIPC待機はUI・async executorから分離する。
pub(crate) mod audio;
pub(crate) mod bundles;
pub(crate) mod profiles;
pub(crate) mod voice_check;

/// 音声の列へ閉包を投入して結果を待つ。受付・列の失敗は`fallback`を含む利用者向けの文言に、閉包の失敗は
/// `to_string()`にする。
pub(crate) async fn call<R: Send + 'static, E: std::fmt::Display>(
    control: &crate::audio::AudioControl,
    entry: crate::audio::Entry,
    fallback: &'static str,
    f: impl FnOnce(&mut crate::audio::AudioHost) -> Result<R, E> + Send + 'static,
) -> Result<R, String> {
    control
        .run_async(entry, move |host| f(host).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.text(fallback))?
}

pub(super) async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|e| e.to_string())?
}
