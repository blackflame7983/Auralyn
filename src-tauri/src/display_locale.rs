//! JSで明示された表示言語のtray起動用projection。音声状態・設定へは触れない。
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{menu::MenuItem, State};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    #[default]
    Ja,
    En,
}
impl Locale {
    pub fn labels(self) -> [&'static str; 3] {
        match self {
            Self::Ja => ["Auralyn を表示", "ミュート切替 (Alt+M)", "終了"],
            Self::En => ["Show Auralyn", "Toggle mute (Alt+M)", "Quit"],
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Projection {
    schema_version: u8,
    source: String,
    locale: Locale,
}
pub fn load(path: &Path) -> Locale {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Projection>(&bytes).ok())
        .filter(|p| p.schema_version == 1 && p.source == "webview-explicit-language")
        .map_or(Locale::Ja, |p| p.locale)
}
fn persist(path: &Path, locale: Locale) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("表示言語の保存先が不正です")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&Projection {
        schema_version: 1,
        source: "webview-explicit-language".into(),
        locale,
    })
    .map_err(|e| e.to_string())?;
    let result = (|| {
        let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
fn update_projection(path: &Path, locale: Locale, save: bool, clear: bool) -> Result<(), String> {
    if clear && (save || locale != Locale::Ja) {
        return Err("表示言語projectionの操作が不正です".into());
    }
    if save {
        persist(path, locale)?;
    } else if clear {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}
#[derive(Default)]
struct Clock {
    epoch: u64,
    sequence: u64,
}
impl Clock {
    fn accept(&mut self, epoch: u64, sequence: u64, current_page: u64) -> bool {
        if epoch == 0 || epoch != current_page {
            return false;
        }
        if self.epoch != epoch {
            self.epoch = epoch;
            self.sequence = 0;
        }
        if sequence <= self.sequence {
            return false;
        }
        self.sequence = sequence;
        true
    }
}
struct PageGeneration(AtomicU64);
impl Default for PageGeneration {
    fn default() -> Self {
        Self(AtomicU64::new(1))
    }
}
impl PageGeneration {
    fn current(&self) -> Result<u64, String> {
        match self.0.load(Ordering::Acquire) {
            0 => Err("表示言語session上限です".into()),
            epoch => Ok(epoch),
        }
    }
    fn advance(&self) {
        // page通知ではatomicだけを更新し、UI threadでI/Oやmenu gateを待たない。
        if self
            .0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                if value == 0 {
                    None
                } else {
                    value.checked_add(1)
                }
            })
            .is_err()
        {
            self.0.store(0, Ordering::Release);
        }
    }
}
struct Inner {
    clock: Clock,
    items: [MenuItem<tauri::Wry>; 3],
}
pub struct DisplayLocaleState {
    inner: Arc<Mutex<Inner>>,
    path: PathBuf,
    page: Arc<PageGeneration>,
}
impl DisplayLocaleState {
    pub fn new(path: PathBuf, items: [MenuItem<tauri::Wry>; 3]) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                clock: Clock::default(),
                items,
            })),
            path,
            page: Arc::new(PageGeneration::default()),
        }
    }
    pub fn retire_page(&self) {
        self.page.advance();
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    epoch: u64,
    sequence: u64,
    locale: Locale,
    persist: bool,
    #[serde(default)]
    clear_projection: bool,
}
#[tauri::command]
pub fn begin_display_locale_session(state: State<'_, DisplayLocaleState>) -> Result<u64, String> {
    // session取得は読取だけ。遅い旧frontendの要求で現pageを失効させない。
    state.page.current()
}
#[tauri::command]
pub async fn set_display_locale(
    state: State<'_, DisplayLocaleState>,
    request: Request,
) -> Result<bool, String> {
    let inner = state.inner.clone();
    let path = state.path.clone();
    let page = state.page.clone();
    crate::commands::run_blocking(move || {
        let mut inner = inner.lock().map_err(|_| "表示言語の状態を取得できません")?;
        if !inner
            .clock
            .accept(request.epoch, request.sequence, page.current()?)
        {
            return Ok(false);
        }
        // 同じgateで順序を固定。保存失敗をtrayだけ変更した成功へ置き換えない。
        update_projection(
            &path,
            request.locale,
            request.persist,
            request.clear_projection,
        )?;
        for (item, label) in inner.items.iter().zip(request.locale.labels()) {
            item.set_text(label).map_err(|e| e.to_string())?;
        }
        Ok(true)
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_request_and_retired_frontend_cannot_roll_back_locale_new_reload_is_accepted() {
        let page = PageGeneration::default();
        let mut clock = Clock::default();
        let old = page.current().unwrap();
        assert!(clock.accept(old, 2, old));
        assert!(!clock.accept(old, 1, old));
        page.advance();
        let current = page.current().unwrap();
        assert!(!clock.accept(old, 99, current));
        assert!(clock.accept(current, 1, current));
    }
    #[test]
    fn delayed_old_begin_reply_cannot_retire_new_page_or_block_its_next_change() {
        let page = PageGeneration::default();
        let mut clock = Clock::default();
        let (release, held) = std::sync::mpsc::channel();
        let old = page.current().unwrap();
        let old_reply = std::thread::spawn(move || {
            held.recv().unwrap();
            old
        });
        page.advance();
        let current = page.current().unwrap();
        assert_eq!(page.current().unwrap(), current); // 同一pageのbeginは冪等。
        assert!(clock.accept(current, 1, page.current().unwrap()));
        release.send(()).unwrap();
        let retired = old_reply.join().unwrap();
        assert!(!clock.accept(retired, 99, page.current().unwrap()));
        assert!(clock.accept(current, 2, page.current().unwrap()));
    }
    #[test]
    fn page_counter_exhaustion_never_reuses_a_retired_epoch() {
        let page = PageGeneration(AtomicU64::new(u64::MAX));
        page.advance();
        assert!(page.current().is_err());
        page.advance();
        assert!(page.current().is_err());
    }
    #[test]
    fn projection_is_explicit_only_validated_and_save_failure_is_not_success() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-locale-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = root.join("display-locale.json");
        assert_eq!(load(&path), Locale::Ja);
        assert!(!root.exists());
        persist(&path, Locale::En).unwrap();
        assert_eq!(load(&path), Locale::En);
        update_projection(&path, Locale::Ja, false, false).unwrap();
        assert_eq!(load(&path), Locale::En); // 読取不能/保存不能時のruntime表示は原本を変えない。
        assert!(update_projection(&path, Locale::En, true, true).is_err());
        update_projection(&path, Locale::Ja, false, true).unwrap();
        assert!(!path.exists());
        update_projection(&path, Locale::Ja, false, true).unwrap();
        assert!(!path.exists()); // 未設定の既定jaでfileを新規作成しない。
        std::fs::write(&path, br#"{"schemaVersion":1,"source":"os","locale":"en"}"#).unwrap();
        assert_eq!(load(&path), Locale::Ja);
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"source":"webview-explicit-language","locale":"invalid"}"#,
        )
        .unwrap();
        assert_eq!(load(&path), Locale::Ja);
        assert!(persist(&root, Locale::En).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
