//! 通知（`audio-started` など）の発行口。中核の `EventSink` を通して出す。
//!
//! 環境変数`AURALYN_EMIT_TRACE=1`のときだけ、`emit`を呼んだ順序を通し番号つきでログへ残す。
use auralyn_core::event::{EmitError, Event, EventSink};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

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
    Core(Arc<dyn EventSink>),
    #[cfg(test)]
    Recorder(std::sync::Arc<Recorder>),
}

#[derive(Clone)]
pub(crate) struct AudioEmitter(Sink);

impl AudioEmitter {
    pub(crate) fn sink(sink: Arc<dyn EventSink>) -> Self {
        Self(Sink::Core(sink))
    }

    pub(crate) fn emit<S: Serialize + Clone>(
        &self,
        event: &str,
        payload: S,
    ) -> Result<(), EmitError> {
        trace_mark("emit", event);
        match &self.0 {
            Sink::Core(sink) => sink.send(Event::new(event, &payload)?),
            #[cfg(test)]
            Sink::Recorder(recorder) => recorder.push(event, &payload),
        }
    }
}

impl super::AudioHost {
    /// 通知の出口を、画面の層の `EventSink` にまるごと置き換える。
    /// sink は reader などのスレッドから同期で呼ばれるので、待たずに戻る実装にする。
    pub fn set_event_sink(&mut self, sink: Arc<dyn EventSink>) {
        self.emitter.set(AudioEmitter::sink(sink));
    }
}

/// 通知の発行口を持つ。`AudioHost` と、その子の reader が共有する。
///
/// - `emitter` のロックは `AudioEmitter` を複製する間だけ。`emit` はロックの外で行う。
/// - 同じ出来事の通知の列は、`order` を列の全体で持って出す（間に別のスレッドの通知が入らない）。
///   `order` を持つ間に取ってよいのは `emitter` だけ。ほかのロックを取らず、IPC・応答の待ちをせず、
///   通知の関数へ再び入らない。
#[derive(Default)]
pub(crate) struct Notifier {
    emitter: std::sync::Mutex<Option<AudioEmitter>>,
    order: std::sync::Mutex<()>,
    /// 試験用：chain_if が順序のロックを取る直前に着いた回数。
    #[cfg(test)]
    arrivals: std::sync::atomic::AtomicUsize,
}

/// 列の途中で通知を出す手。`Notifier::chain` の中でだけ得られる。
pub(crate) struct Chain<'a>(&'a Notifier);

impl Chain<'_> {
    pub(crate) fn emit<S: Serialize + Clone>(
        &self,
        event: &str,
        payload: S,
    ) -> Result<(), EmitError> {
        match self.0.current() {
            Some(emitter) => emitter.emit(event, payload),
            None => Ok(()),
        }
    }
}

impl Notifier {
    pub(crate) fn set(&self, emitter: AudioEmitter) {
        *self
            .emitter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(emitter);
    }

    fn current(&self) -> Option<AudioEmitter> {
        self.emitter
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// 通知の列を、間に別の通知を入れずに出す。
    pub(crate) fn chain<R>(&self, f: impl FnOnce(&Chain<'_>) -> R) -> R {
        let _order = self
            .order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        f(&Chain(self))
    }

    /// 列の直前に接続を確かめる。閉じていれば、列の全体を出さない。
    pub(crate) fn chain_if(&self, open: impl Fn() -> bool, f: impl FnOnce(&Chain<'_>)) -> bool {
        #[cfg(test)]
        self.arrivals
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _order = self
            .order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !open() {
            return false;
        }
        f(&Chain(self));
        true
    }

    /// 試験用：chain_if が順序のロックを取る直前に着いた回数。
    #[cfg(test)]
    pub(crate) fn arrivals_for_test(&self) -> usize {
        self.arrivals.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 1件だけの通知。
    pub(crate) fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        self.chain(|chain| {
            let _ = chain.emit(event, payload);
        });
    }
}

/// 試験用：`emit`の呼び出しを順に記録する。
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Recorder {
    events: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
    gate: Gate,
}

/// 試験用：閉じている間、`emit` が戻らない。`(閉じている, 先に通す回数)`。
#[cfg(test)]
#[derive(Default)]
struct Gate {
    held: std::sync::Mutex<(bool, usize)>,
    changed: std::sync::Condvar,
    waiting: std::sync::atomic::AtomicUsize,
}

#[cfg(test)]
impl Recorder {
    pub(crate) fn emitter(self: &std::sync::Arc<Self>) -> AudioEmitter {
        AudioEmitter(Sink::Recorder(self.clone()))
    }

    fn push<S: Serialize>(&self, event: &str, payload: &S) -> Result<(), EmitError> {
        let value = serde_json::to_value(payload).map_err(EmitError::Serialize)?;
        {
            let mut held = self.gate.held.lock().unwrap();
            if held.0 {
                if held.1 > 0 {
                    held.1 -= 1;
                } else {
                    self.gate
                        .waiting
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    while held.0 {
                        held = self.gate.changed.wait(held).unwrap();
                    }
                    self.gate
                        .waiting
                        .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }
        self.events.lock().unwrap().push((event.to_owned(), value));
        Ok(())
    }

    /// `pass` 回の `emit` を通した後、`release` まで `emit` を止める（`emit` の途中で止まった通知を作る）。
    pub(crate) fn block_after(&self, pass: usize) {
        *self.gate.held.lock().unwrap() = (true, pass);
    }

    pub(crate) fn release(&self) {
        *self.gate.held.lock().unwrap() = (false, 0);
        self.gate.changed.notify_all();
    }

    /// 止まっている `emit` の数。
    pub(crate) fn blocked_emits(&self) -> usize {
        self.gate.waiting.load(std::sync::atomic::Ordering::SeqCst)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    // T12：ロックが poison されても、後続の通知は panic せず、内容と順は変わらない。
    #[test]
    fn a_poisoned_lock_does_not_break_later_notices() {
        let notifier = Arc::new(Notifier::default());
        let recorder = Arc::new(Recorder::default());
        notifier.set(recorder.emitter());
        let poisoner = notifier.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.emitter.lock().unwrap();
            panic!("poison the emitter lock");
        })
        .join();
        assert!(notifier.emitter.is_poisoned());
        notifier.emit("a", 1);
        let poisoner = notifier.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.order.lock().unwrap();
            panic!("poison the order lock");
        })
        .join();
        assert!(notifier.order.is_poisoned());
        notifier.chain(|chain| {
            let _ = chain.emit("b", 2);
            let _ = chain.emit("c", 3);
        });
        notifier.set(recorder.emitter());
        let events = recorder.events();
        let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c"]);
        assert_eq!(events[2].1, serde_json::json!(3));
    }

    // 画面の層の口へは、Tauri の emit と同じ名前・本文（serde_json::to_string）・順で届く。
    #[test]
    fn a_core_sink_receives_the_same_names_bodies_and_order() {
        #[derive(Serialize, Clone)]
        struct Level {
            input: [f32; 2],
        }
        let notifier = Notifier::default();
        let (sink, receiver) = auralyn_core::event::channel();
        notifier.set(AudioEmitter::sink(Arc::new(sink)));
        notifier.emit("audio-started", ());
        notifier.chain(|chain| {
            let _ = chain.emit("audio-level", Level { input: [0.1, 0.5] });
            let _ = chain.emit("audio-stopped", "user");
        });
        let received: Vec<(String, String)> = receiver.try_iter().map(Event::into_parts).collect();
        let expected = [
            ("audio-started", serde_json::to_string(&()).unwrap()),
            (
                "audio-level",
                serde_json::to_string(&Level { input: [0.1, 0.5] }).unwrap(),
            ),
            ("audio-stopped", serde_json::to_string("user").unwrap()),
        ]
        .map(|(name, json)| (name.to_owned(), json));
        assert_eq!(received, expected);
        assert_eq!(received[1].1, r#"{"input":[0.1,0.5]}"#);
    }

    #[test]
    fn a_chain_without_an_emitter_is_silent_and_a_closed_chain_is_not_run() {
        let notifier = Notifier::default();
        notifier.emit("nobody", ());
        let mut ran = false;
        assert!(!notifier.chain_if(
            || false,
            |_| {
                ran = true;
            }
        ));
        assert!(!ran);
        assert!(notifier.chain_if(
            || true,
            |chain| {
                let _ = chain.emit("x", ());
            }
        ));
    }
}
