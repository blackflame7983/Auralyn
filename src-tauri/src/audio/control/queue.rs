//! 受付の列。葉のロックだけを持ち、持っている間に閉包・通知・I/O・ほかのロックを使わない。
use super::{ControlError, Entry};
use crate::audio::AudioHost;
use std::any::Any;
use std::collections::VecDeque;
use std::sync::mpsc::SyncSender;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};

pub(super) type Payload = Box<dyn Any + Send>;
pub(super) type RunFn = Box<dyn FnOnce(&mut AudioHost) -> Payload + Send>;
pub(super) type PostFn = Box<dyn FnOnce(Result<&mut AudioHost, ControlError>) + Send>;

/// `run`の呼び出し側へ返す結果。
pub(super) enum Reply {
    Done(Payload),
    Panicked(Payload),
    Poisoned,
}

pub(super) enum JobKind {
    /// 返事の送信端は`Job`だけが持つ。閉包の中へ入れない。
    Run {
        tx: SyncSender<Reply>,
        f: RunFn,
    },
    Post {
        f: PostFn,
    },
    #[cfg(test)]
    Lease(super::lease::LeaseGrant),
}

pub(super) struct Job {
    pub(super) seq: u64,
    pub(super) entry: Entry,
    pub(super) kind: JobKind,
}

struct QueueState {
    jobs: VecDeque<Job>,
    closed: bool,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActorPoint {
    /// 列のロックを持ったまま、仕事を取り出す直前。
    QueueLockHeld,
    /// 取り出した仕事を`current`へ置いた直後。
    AfterTake,
}

#[cfg(test)]
type Seam = std::sync::Arc<dyn Fn(ActorPoint) + Send + Sync>;

pub(super) struct JobQueue {
    state: Mutex<QueueState>,
    ready: Condvar,
    #[cfg(test)]
    seam: Mutex<Option<Seam>>,
}

impl JobQueue {
    pub(super) fn new() -> Self {
        Self {
            state: Mutex::new(QueueState {
                jobs: VecDeque::new(),
                closed: false,
            }),
            ready: Condvar::new(),
            #[cfg(test)]
            seam: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, QueueState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 積んだ順に積む。閉じていれば積まずに返す（呼び出し側が`Stopped`にする）。
    pub(super) fn push(&self, job: Job) -> Result<(), ControlError> {
        let mut state = self.lock();
        if state.closed {
            drop(state);
            drop(job);
            return Err(ControlError::Stopped);
        }
        state.jobs.push_back(job);
        drop(state);
        self.ready.notify_one();
        Ok(())
    }

    /// 次の仕事を`slot`へ置く。閉じていれば`false`（残件は回収が扱う）。取り出す関数はここだけ。
    pub(super) fn take_next(&self, slot: &mut Option<Job>) -> bool {
        let mut state = self.lock();
        loop {
            if state.closed {
                return false;
            }
            #[cfg(test)]
            self.run_seam(ActorPoint::QueueLockHeld);
            if let Some(job) = state.jobs.pop_front() {
                *slot = Some(job);
                return true;
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    pub(super) fn close(&self) {
        self.lock().closed = true;
        self.ready.notify_all();
    }

    /// 列を閉じ、残りの仕事（と、取り出し済みで残った仕事）を全件取り出す。列のロックは返す前に放す。
    pub(super) fn close_and_take(&self, current: Option<Job>) -> VecDeque<Job> {
        let mut state = self.lock();
        state.closed = true;
        let mut jobs = std::mem::take(&mut state.jobs);
        if let Some(job) = current {
            jobs.push_front(job);
        }
        drop(state);
        self.ready.notify_all();
        jobs
    }

    #[cfg(test)]
    pub(super) fn is_closed(&self) -> bool {
        self.lock().closed
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.lock().jobs.len()
    }

    #[cfg(test)]
    pub(super) fn set_seam(&self, seam: Seam) {
        *self.seam.lock().unwrap_or_else(PoisonError::into_inner) = Some(seam);
    }

    #[cfg(test)]
    pub(super) fn run_seam(&self, point: ActorPoint) {
        let seam = self
            .seam
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(seam) = seam {
            seam(point);
        }
    }
}
