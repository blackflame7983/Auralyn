//! 受付の列。葉のロックだけを持ち、持っている間に閉包・通知・I/O・ほかのロックを使わない。
//!
//! 列は2つのレーンを持つ。停止のレーン（Stop・Mute）が先に取り出され、どちらのレーンも受付の番号の順に並ぶ。
use super::class::{JobClass, Lane};
use super::{ControlError, Entry};
use crate::audio::AudioHost;
use std::any::Any;
use std::collections::VecDeque;
use std::sync::mpsc::SyncSender;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

pub(super) type Payload = Box<dyn Any + Send>;
pub(super) type RunFn = Box<dyn FnOnce(&mut AudioHost) -> Payload + Send>;
pub(super) type PostFn = Box<dyn FnOnce(Result<&mut AudioHost, ControlError>) + Send>;

/// `run`の呼び出し側へ返す結果。
pub(super) enum Reply {
    Done(Payload),
    Panicked(Payload),
    Poisoned,
    Refused(ControlError),
}

/// 返事の送信端。`Job`だけが持ち、送るときに待たない。
pub(super) enum ReplyTx {
    Sync(SyncSender<Reply>),
    Async(tokio::sync::oneshot::Sender<Reply>),
}

impl ReplyTx {
    /// 送れなかった返事（受け手が先に捨てられた）は、そのまま返す。
    pub(super) fn send(self, reply: Reply) -> Result<(), Reply> {
        match self {
            Self::Sync(tx) => tx.send(reply).map_err(|error| error.0),
            Self::Async(tx) => tx.send(reply),
        }
    }
}

pub(super) enum JobKind {
    /// 返事の送信端は`Job`だけが持つ。閉包の中へ入れない。
    Run {
        tx: ReplyTx,
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
    pub(super) class: JobClass,
    pub(super) accepted_at: Instant,
    pub(super) kind: JobKind,
}

/// 取り出した仕事を、実行するか断るか。仕事は`slot`にある。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Taken {
    Run,
    Refuse(ControlError),
}

/// 上限と期限。試験は縮めた値に差し替える。
#[derive(Clone, Copy, Debug)]
pub(super) struct Limits {
    /// 終わっていない数える仕事（列にある数＋実行中）の上限。
    pub(super) max_counted: usize,
    /// 受付から始まるまでの期限。
    pub(super) wait: Duration,
    /// この長さを超えた実行は警告を1回出す（打ち切らない）。
    pub(super) slow: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_counted: 256,
            wait: Duration::from_secs(60),
            slow: Duration::from_secs(90),
        }
    }
}

struct QueueState {
    stop_lane: VecDeque<Job>,
    jobs: VecDeque<Job>,
    counted: usize,
    /// 最後に受け付けた停止の番号。単調に増える。
    fence: u64,
    limits: Limits,
    closed: bool,
}

/// 実行のスレッドの途中の地点。試験だけが継ぎ目で止める。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActorPoint {
    /// 列のロックを持ったまま、仕事を取り出す直前。
    QueueLockHeld,
    /// 取り出した仕事を`current`へ置いた直後。
    AfterTake,
    /// 返事を送る・断りを伝える直前（減算と記録の後）。
    BeforeReply,
    /// `run`の返事を送った直後。
    AfterReply,
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
                stop_lane: VecDeque::new(),
                jobs: VecDeque::new(),
                counted: 0,
                fence: 0,
                limits: Limits::default(),
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

    pub(super) fn limits(&self) -> Limits {
        self.lock().limits
    }

    #[cfg(test)]
    pub(super) fn set_limits(&self, limits: Limits) {
        self.lock().limits = limits;
    }

    /// 積む。閉じていれば`Stopped`、数える仕事が上限に達していれば`Busy`で、積まずに返す。
    pub(super) fn push(&self, job: Job) -> Result<(), ControlError> {
        let mut state = self.lock();
        let refusal = if state.closed {
            Some(ControlError::Stopped)
        } else if job.class.bounded() && state.counted >= state.limits.max_counted {
            Some(ControlError::Busy)
        } else {
            None
        };
        if let Some(error) = refusal {
            drop(state);
            drop(job);
            return Err(error);
        }
        if job.class.raises_fence() {
            state.fence = state.fence.max(job.seq);
        }
        if job.class.bounded() {
            state.counted += 1;
        }
        match job.class.lane() {
            Lane::Stop => insert_in_order(&mut state.stop_lane, job),
            Lane::Regular => insert_in_order(&mut state.jobs, job),
        }
        drop(state);
        self.ready.notify_one();
        Ok(())
    }

    /// 次の仕事を`slot`へ置き、実行か断りかを返す。閉じていれば`None`（残件は回収が扱う）。
    /// 取り出す関数はここだけ。停止のレーンを先に、どちらも受付の番号の小さい順に取り出す。
    pub(super) fn take_next(&self, slot: &mut Option<Job>) -> Option<Taken> {
        let mut state = self.lock();
        loop {
            if state.closed {
                return None;
            }
            self.run_seam(ActorPoint::QueueLockHeld);
            let next = state
                .stop_lane
                .pop_front()
                .or_else(|| state.jobs.pop_front());
            if let Some(job) = next {
                let taken = verdict(&job, state.fence, state.limits.wait);
                *slot = Some(job);
                return Some(taken);
            }
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// 期限切れの`run`が、まだ列にある自分の仕事を取り除く。取り出された後なら`None`。
    pub(super) fn cancel_waiting(&self, seq: u64) -> Option<Job> {
        let mut state = self.lock();
        let at = state
            .jobs
            .iter()
            .position(|job| job.seq == seq && job.class.bounded())?;
        let job = state.jobs.remove(at)?;
        state.counted = state.counted.saturating_sub(1);
        Some(job)
    }

    /// 仕事の終わり（実行・断り）で、数える仕事の数を下げる。返事を送る前に呼ぶ。
    pub(super) fn complete(&self, class: JobClass) {
        if class.bounded() {
            let mut state = self.lock();
            state.counted = state.counted.saturating_sub(1);
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
        state.counted = 0;
        let mut jobs: VecDeque<Job> = current.into_iter().collect();
        jobs.extend(std::mem::take(&mut state.stop_lane));
        jobs.extend(std::mem::take(&mut state.jobs));
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
        let state = self.lock();
        state.stop_lane.len() + state.jobs.len()
    }

    #[cfg(test)]
    pub(super) fn counted(&self) -> usize {
        self.lock().counted
    }

    #[cfg(test)]
    pub(super) fn fence(&self) -> u64 {
        self.lock().fence
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

    #[cfg(not(test))]
    pub(super) fn run_seam(&self, _point: ActorPoint) {}
}

/// 受付の番号の順に差し込む（後ろから探す。ほぼ末尾）。
fn insert_in_order(lane: &mut VecDeque<Job>, job: Job) {
    let at = lane
        .iter()
        .rposition(|queued| queued.seq < job.seq)
        .map_or(0, |last| last + 1);
    lane.insert(at, job);
}

/// 通常のレーンの先頭を、停止より前の受付か期限切れなら断る。
fn verdict(job: &Job, fence: u64, wait: Duration) -> Taken {
    if job.class.refused_after_stop() && job.seq < fence {
        return Taken::Refuse(ControlError::StoppedFirst);
    }
    if job.class.bounded() && job.accepted_at.elapsed() >= wait {
        return Taken::Refuse(ControlError::Expired);
    }
    Taken::Run
}
