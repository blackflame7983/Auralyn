//! ボイスチェックの録音・試聴・解析コマンド。
use crate::{audio, audio_analysis};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};

struct AnalysisWorkspace(PathBuf, PathBuf);

#[tauri::command]
pub(crate) async fn voice_check_preview(
    state: State<'_, audio::AudioState>,
    request: crate::audio_engine::voice_check::preview::Request,
) -> Result<crate::audio_engine::voice_check::preview::Snapshot, String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.voice_check_preview(request)
            .map_err(|error| error.to_string())
    })
    .await
}

impl AnalysisWorkspace {
    fn new(root: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&root)?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        loop {
            let path = root.join(format!(
                "auralyn_vc_{}_{}_{}",
                std::process::id(),
                stamp,
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            // 既存ディレクトリを共有しない。失敗途中でもこの所有者が作った音声だけを削除する。
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(Self(path, root)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for AnalysisWorkspace {
    fn drop(&mut self) {
        // newで作成した専用領域だけを削除する。一時利用ではapp_cache_dirも隔離される。
        if self.0.parent() == Some(self.1.as_path()) {
            if let Err(error) = std::fs::remove_dir_all(&self.0) {
                log::warn!("ボイスチェックの一時音声を削除できませんでした: {error}");
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn start_voice_check(
    state: State<'_, audio::AudioState>,
    max_ms: Option<u32>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.start_voice_check(max_ms.unwrap_or(10_000))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn stop_voice_check(state: State<'_, audio::AudioState>) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.stop_voice_check().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn play_voice_check(
    state: State<'_, audio::AudioState>,
    source: String,
    loop_playback: Option<bool>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.play_voice_check(source, loop_playback.unwrap_or(true))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn stop_voice_check_playback(
    state: State<'_, audio::AudioState>,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.stop_voice_check_playback().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn export_voice_check_wav(
    state: State<'_, audio::AudioState>,
    source: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_file_name("voice-check.wav")
            .add_filter("WAV", &["wav"])
            .save_file();

        match path {
            Some(p) => {
                let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
                host.export_voice_check(p.to_string_lossy().to_string(), source)
                    .map_err(|e| e.to_string())
            }
            None => Err("cancelled".to_string()),
        }
    })
    .await
}

#[tauri::command]
pub(crate) async fn export_voice_check(
    state: State<'_, audio::AudioState>,
    path: String,
    source: String,
) -> Result<(), String> {
    let state = state.0.clone();
    super::run_blocking(move || {
        let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
        host.export_voice_check(path, source)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub(crate) async fn analyze_voice_check(
    app: AppHandle,
    state: State<'_, audio::AudioState>,
) -> Result<audio_analysis::QualityReport, String> {
    let state = state.0.clone();
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("voice-analysis");
    super::run_blocking(move || {
        let workspace = AnalysisWorkspace::new(root).map_err(|e| e.to_string())?;
        let temp_dir = &workspace.0;
        let raw_path = temp_dir.join("raw.wav");
        let processed_path = temp_dir.join("processed.wav");

        let buffer_size = {
            let mut host = state.lock().map_err(|_| "Failed to lock audio state")?;
            let buffer_size = host.get_state().config.as_ref().and_then(|c| c.buffer_size);
            host.export_voice_check(raw_path.to_string_lossy().to_string(), "raw".to_string())
                .map_err(|e| e.to_string())?;
            host.export_voice_check(
                processed_path.to_string_lossy().to_string(),
                "processed".to_string(),
            )
            .map_err(|e| e.to_string())?;
            buffer_size
        };

        let loaded = audio_analysis::load_wav_interleaved_f32(&raw_path).and_then(|raw| {
            audio_analysis::load_wav_interleaved_f32(&processed_path).map(|proc| (raw, proc))
        });
        let ((raw_samples, sr_raw), (processed_samples, sr_proc)) =
            loaded.map_err(|e| e.to_string())?;

        if sr_raw != sr_proc {
            return Err("Raw/Processed のサンプルレートが一致しません".to_string());
        }

        let ctx = audio_analysis::AnalysisContext { buffer_size };
        Ok(audio_analysis::analyze_voice_check_buffers(
            &raw_samples,
            &processed_samples,
            sr_raw,
            &ctx,
        ))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_export_cleans_only_its_workspace() {
        let first = AnalysisWorkspace::new(std::env::temp_dir()).unwrap();
        let second = AnalysisWorkspace::new(std::env::temp_dir()).unwrap();
        assert_ne!(first.0, second.0);
        let failed_path = first.0.clone();
        let fail = move || -> Result<(), std::io::Error> {
            let workspace = first;
            std::fs::write(workspace.0.join("raw.wav"), b"test")?;
            Err(std::io::Error::other("processed export failed"))
        };
        assert!(fail().is_err());
        assert!(!failed_path.exists());
        assert!(second.0.exists());
    }
}
