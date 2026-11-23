//! 受付の列。葉のロックだけを持ち、持っている間に閉包・通知・I/O・ほかのロックを使わない。
//!
//! 列は2つのレーンを持つ。停止のレーン（Stop・Mute）が先に取り出され、どちらのレーンも受付の番号の順に並ぶ。
//! 子を起動しうる仕事は、受付の時点で見えていた記録の窓が開いている間、列の中で保留する（飛ばす）。
use super::class::{JobClass, Lane, Launch};
use super::{ControlError, Entry};
use crate::audio::engine_life::{OpenWindow, Store, PROBE_INTERVAL};
use crate::audio::AudioHost;
use std::any::Any;
use std::collections::VecDeque;
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
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
    pub(super) launch: Launch,
    /// 受付の時点で記録に見えていた最後の通し番号。保留はこの番号以下の記録の窓だけで決める。
    pub(super) known: u64,
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
    /// 開始・再起動の警告の長さ。
    pub(super) slow_start: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_counted: 256,
            wait: Duration::from_secs(60),
            slow: Duration::from_secs(90),
            slow_start: Duration::from_secs(120),
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
    /// 列のロックの中で、記録の窓を読んだ直後。待機に入る前。
    AfterWindowRead,
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
    store: Arc<Store>,
    #[cfg(test)]
    seam: Mutex<Option<Seam>>,
}

impl JobQueue {
    pub(super) fn new(store: Arc<Store>) -> Self {
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
            store,
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
        } else if job.class.counted() && state.counted >= state.limits.max_counted {
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
        if job.class.counted() {
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

    /// 記録の変化を知らせる。列のロックを取ってから起こすので、窓を読んで待つまでの間の鳴らしを取りこぼさない。
    pub(super) fn wake(&self) {
        let _state = self.lock();
        self.ready.notify_all();
    }

    pub(super) fn store(&self) -> &Arc<Store> {
        &self.store
    }

    /// 次の仕事を`slot`へ置き、実行か断りかを返す。閉じていれば`None`（残件は回収が扱う）。
    /// 取り出す関数はここだけ。停止のレーンを先に、どちらも受付の番号の小さい順に見る。
    /// 断る仕事は保留中でも断り、窓が開いている仕事は飛ばす。窓は列のロックの中で1回だけ読む。
    pub(super) fn take_next(&self, slot: &mut Option<Job>) -> Option<Taken> {
        let mut state = self.lock();
        let mut probed = false;
        loop {
            if state.closed {
                return None;
            }
            self.run_seam(ActorPoint::QueueLockHeld);
            let now = Instant::now();
            let windows = self.store.open_windows(now);
            self.run_seam(ActorPoint::AfterWindowRead);
            let scan = scan_lanes(&state, &windows, now);
            if let Some((lane, at, taken)) = scan.picked {
                let queue = match lane {
                    Lane::Stop => &mut state.stop_lane,
                    Lane::Regular => &mut state.jobs,
                };
                *slot = queue.remove(at);
                return Some(taken);
            }
            if scan.unwatched && !probed {
                drop(state);
                self.store.probe_unwatched();
                probed = true;
                state = self.lock();
                continue;
            }
            probed = false;
            let timeout = match (scan.next_wake, scan.unwatched) {
                (Some(wake), true) => Some(wake.min(PROBE_INTERVAL)),
                (Some(wake), false) => Some(wake),
                (None, true) => Some(PROBE_INTERVAL),
                (None, false) => None,
            };
            state = match timeout {
                Some(timeout) => {
                    self.ready
                        .wait_timeout(state, timeout.max(Duration::from_millis(1)))
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
                None => self
                    .ready
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner),
            };
        }
    }

    /// 期限切れの`run`が、まだ列にある自分の仕事を取り除く。取り出された後なら`None`。
    pub(super) fn cancel_waiting(&self, seq: u64) -> Option<Job> {
        let mut state = self.lock();
        let at = state
            .jobs
            .iter()
            .position(|job| job.seq == seq && job.class.waits_with_deadline())?;
        let job = state.jobs.remove(at)?;
        state.counted = state.counted.saturating_sub(1);
        Some(job)
    }

    /// 仕事の終わり（実行・断り）で、数える仕事の数を下げる。返事を送る前に呼ぶ。
    pub(super) fn complete(&self, class: JobClass) {
        if class.counted() {
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

struct Scan {
    picked: Option<(Lane, usize, Taken)>,
    /// 保留中の仕事の、次の窓の終わり・受付からの期限までの短い方。
    next_wake: Option<Duration>,
    /// 保留の理由に、監視されていない記録がある。
    unwatched: bool,
}

/// 仕事が起動しうる役割の、受付の時点で見えていた記録の窓。
fn held_by(job: &Job, windows: &[OpenWindow]) -> Vec<OpenWindow> {
    let roles = job.launch.roles();
    windows
        .iter()
        .copied()
        .filter(|window| window.id <= job.known && roles.contains(&window.role))
        .collect()
}

/// 取り出せる仕事を、停止のレーン→通常のレーンの順に、番号の小さい順に探す。
fn scan_lanes(state: &QueueState, windows: &[OpenWindow], now: Instant) -> Scan {
    let mut scan = Scan {
        picked: None,
        next_wake: None,
        unwatched: false,
    };
    for (lane, queue) in [(Lane::Stop, &state.stop_lane), (Lane::Regular, &state.jobs)] {
        for (at, job) in queue.iter().enumerate() {
            let taken = verdict(job, state.fence, state.limits.wait);
            let held = held_by(job, windows);
            if taken != Taken::Run || held.is_empty() {
                scan.picked = Some((lane, at, taken));
                return scan;
            }
            for window in held {
                let remaining = window.until.saturating_duration_since(now);
                scan.next_wake = Some(scan.next_wake.map_or(remaining, |wake| wake.min(remaining)));
                scan.unwatched |= !window.watched;
            }
            if job.class.waits_with_deadline() {
                let remaining =
                    (job.accepted_at + state.limits.wait).saturating_duration_since(now);
                scan.next_wake = Some(scan.next_wake.map_or(remaining, |wake| wake.min(remaining)));
            }
        }
    }
    scan
}

/// 通常のレーンの先頭を、停止より前の受付か期限切れなら断る。
fn verdict(job: &Job, fence: u64, wait: Duration) -> Taken {
    if job.class.refused_after_stop() && job.seq < fence {
        return Taken::Refuse(ControlError::StoppedFirst);
    }
    if job.class.waits_with_deadline() && job.accepted_at.elapsed() >= wait {
        return Taken::Refuse(ControlError::Expired);
    }
    Taken::Run
}
