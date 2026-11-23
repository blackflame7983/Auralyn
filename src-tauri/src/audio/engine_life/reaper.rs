//! 終了を確かめられない子の記録ごとに1本のスレッド。子の終了を観測したら記録を消して列を起こし、
//! 期限の前は `kill()` をやり直す。`Child`・`Job`・ホスト・列は持たず、待機中は `Store` への強い参照も持たない。
use super::Store;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

/// 終了を観測する確認の間隔。
const STEP: Duration = Duration::from_millis(50);
/// 観測の失敗が続いたとき、監視を諦めるまでの回数。
const FAILURES: u32 = 3;

/// 終わりを待つ相手。待っている間は `Store` に触れない。
pub(super) enum Source {
    /// 一定の間隔のあとで、記録の子を確かめる。
    Poll,
    #[cfg(test)]
    Scripted(Arc<Script>),
}

struct WaitFailed;

impl Source {
    fn wait(&self, slice: Duration) -> Result<bool, WaitFailed> {
        match self {
            Self::Poll => {
                std::thread::sleep(slice);
                Ok(true)
            }
            #[cfg(test)]
            Self::Scripted(script) => script.wait(slice),
        }
    }
}

/// 試験が、記録の子の終わりの観測を操作する。
#[cfg(test)]
pub(crate) struct Script {
    mode: std::sync::Mutex<Mode>,
    changed: std::sync::Condvar,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    /// 終わりを観測しない。
    Held,
    /// 実際の子を確かめる。
    Released,
    /// `wait` が panic する。
    Panics,
    /// `wait` が失敗し続ける。
    Failing,
}

#[cfg(test)]
impl Script {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            mode: std::sync::Mutex::new(Mode::Held),
            changed: std::sync::Condvar::new(),
        })
    }

    pub(crate) fn set(&self, mode: Mode) {
        *self
            .mode
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = mode;
        self.changed.notify_all();
    }

    fn wait(&self, slice: Duration) -> Result<bool, WaitFailed> {
        let guard = self
            .mode
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match *guard {
            Mode::Panics => {
                drop(guard);
                panic!("reaper script: wait panicked");
            }
            Mode::Failing => {
                drop(guard);
                std::thread::sleep(slice.min(Duration::from_millis(5)));
                Err(WaitFailed)
            }
            Mode::Released => {
                drop(guard);
                std::thread::sleep(slice.min(STEP));
                Ok(true)
            }
            Mode::Held => {
                let (guard, _) = self
                    .changed
                    .wait_timeout(guard, slice)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if *guard == Mode::Released {
                    Ok(true)
                } else {
                    Ok(false)
                }
            }
        }
    }
}

/// 記録 `id` の監視を1本起こす。起こせなければ `false`（記録は監視されない扱いになる）。
pub(super) fn spawn(store: &Arc<Store>, id: u64, source: Source, killed_at: Instant) -> bool {
    #[cfg(test)]
    if super::seam::spawn_fails() {
        return false;
    }
    let weak = Arc::downgrade(store);
    #[cfg(test)]
    let count = store.reaper_guard();
    let started = std::thread::Builder::new()
        .name("auralyn-reaper".to_owned())
        .spawn(move || {
            #[cfg(test)]
            let _count = count;
            guarded(&weak, id, &source, killed_at);
        });
    match started {
        Ok(_) => true,
        Err(error) => {
            log::warn!("終了の監視のスレッドを起こせません: {error}");
            false
        }
    }
}

fn guarded(weak: &Weak<Store>, id: u64, source: &Source, killed_at: Instant) {
    let ended = catch_unwind(AssertUnwindSafe(|| run(weak, id, source, killed_at)));
    if ended.is_err() {
        log::error!("終了の監視のスレッドが異常終了しました。記録は監視されない扱いにします");
        abandon(weak, id);
    }
}

fn abandon(weak: &Weak<Store>, id: u64) {
    if let Some(store) = weak.upgrade() {
        store.mark_unwatched(id);
        store.ring();
    }
}

fn run(weak: &Weak<Store>, id: u64, source: &Source, killed_at: Instant) {
    let mut last_kill = killed_at;
    let mut failures = 0;
    loop {
        let Some(timing) = weak.upgrade().map(|store| store.timing()) else {
            return;
        };
        let now = Instant::now();
        let slice = if now < killed_at + timing.deadline {
            (last_kill + timing.retry_kill)
                .saturating_duration_since(now)
                .min(timing.rescan)
                .min(STEP)
        } else {
            timing.rescan
        };
        let observed = match source.wait(slice) {
            Ok(observed) => {
                failures = 0;
                observed
            }
            Err(WaitFailed) => {
                failures += 1;
                if failures >= FAILURES {
                    abandon(weak, id);
                    return;
                }
                continue;
            }
        };
        let Some(store) = weak.upgrade() else { return };
        if observed && store.probe(id) {
            store.finish(id);
            return;
        }
        if !store.has(id) {
            return;
        }
        let now = Instant::now();
        if now < killed_at + timing.deadline
            && now.saturating_duration_since(last_kill) >= timing.retry_kill
        {
            store.kill(id);
            last_kill = now;
        }
    }
}
