//! 旧の通知（`audio-started` など）の発行口。発行の順序・回数・内容は`AppHandle::emit`と同じ。
//!
//! 環境変数`AURALYN_EMIT_TRACE=1`のときだけ、`emit`を呼んだ順序を通し番号つきでログへ残す。
//! WebView に届いた順序は別に記録し、Rust が呼んだ順序と突き合わせる（W5。手順は docs/TESTING.md）。
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static TRACE_SEQ: AtomicU64 = AtomicU64::new(0);

fn tracing_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var("AURALYN_EMIT_TRACE").is_ok_and(|v| v == "1"))
}

/// `kind`は`emit`（`emit`を呼んだ）か`return`（コマンドの結果を返す直前）。
pub(crate) fn trace_mark(kind: &str, name: &str) {
    if !tracing_enabled() {
        return;
    }
    let seq = TRACE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let unix_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_micros());
    log::info!(
        target: "emit-trace",
        "seq={seq} kind={kind} name={name} unix_us={unix_us} thread={:?}",
        std::thread::current().id()
    );
}

#[derive(Clone)]
enum Sink {
    App(AppHandle),
    #[cfg(test)]
    Recorder(std::sync::Arc<Recorder>),
}

#[derive(Clone)]
pub(crate) struct AudioEmitter(Sink);

impl AudioEmitter {
    pub(crate) fn app(handle: AppHandle) -> Self {
        Self(Sink::App(handle))
    }

    pub(crate) fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> tauri::Result<()> {
        trace_mark("emit", event);
        match &self.0 {
            Sink::App(handle) => handle.emit(event, payload),
            #[cfg(test)]
            Sink::Recorder(recorder) => recorder.push(event, &payload),
        }
    }
}

/// 試験用：`emit`の呼び出しを順に記録する。
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Recorder {
    events: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
}

#[cfg(test)]
impl Recorder {
    pub(crate) fn emitter(self: &std::sync::Arc<Self>) -> AudioEmitter {
        AudioEmitter(Sink::Recorder(self.clone()))
    }

    fn push<S: Serialize>(&self, event: &str, payload: &S) -> tauri::Result<()> {
        let value = serde_json::to_value(payload).map_err(tauri::Error::from)?;
        self.events.lock().unwrap().push((event.to_owned(), value));
        Ok(())
    }

    pub(crate) fn events(&self) -> Vec<(String, serde_json::Value)> {
        self.events.lock().unwrap().clone()
    }

    pub(crate) fn names(&self) -> Vec<String> {
        self.events().into_iter().map(|(name, _)| name).collect()
    }

    pub(crate) fn clear(&self) {
        self.events.lock().unwrap().clear();
    }
}
