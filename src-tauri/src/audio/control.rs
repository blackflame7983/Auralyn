//! 音声状態への入口。`AudioHost`は1本の実行のスレッドが持ち、入口は`run`（結果を待つ）か
//! `post`（待たない）で閉包を渡す。受付の順序と、実行のスレッドが取り出した順序を記録する。
//!
//! 記録は受付の順序と取り出した順序を残すだけである。操作の並べ替えにも、利用者から見た勝ち負けにも
//! 使わない。仕事は受付の番号の順に1件ずつ実行する（停止の列が先）。
mod actor;
mod class;
#[cfg(test)]
mod lease;
mod queue;
pub(crate) mod request_class;

#[cfg(test)]
pub(crate) use lease::HostLease;
#[cfg(test)]
pub(crate) use queue::ActorPoint;

pub(crate) use class::class_of;
pub use class::JobClass;
#[cfg(test)]
pub(crate) use class::{
    request_class as request_class_of, NAME_CLASSES, NAME_PAIRS, REQUEST_CLASSES, REQUEST_ENTRIES,
    REQUEST_PAIRS,
};

use super::{engine_life, AudioHost};
use queue::{Job, JobKind, JobQueue, Payload, Reply, ReplyTx};
use std::collections::VecDeque;
use std::fmt;
use std::io;
use std::panic::resume_unwind;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::{Duration, Instant};

pub const BUSY_TEXT: &str =
    "音声の操作が混み合っています。しばらくしてから、もう一度操作してください。";
pub const EXPIRED_TEXT: &str = "前の音声の操作が長引いているため、この操作は実行しませんでした。前の操作が終わってから、もう一度操作してください。";
pub const STOPPED_FIRST_TEXT: &str =
    "停止が先に行われたため、この操作は実行しませんでした。必要なら、もう一度操作してください。";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ControlError {
    /// 閉包が panic した後。以後の仕事は実行しない。
    Poisoned,
    /// 列が閉じた、または実行のスレッドが止まった。
    Stopped,
    /// 実行のスレッドの上から`run`を呼んだ。
    Reentrant,
    /// 終わっていない操作が上限に達していて、受け付けなかった。
    Busy,
    /// 受付から期限までに始まらなかった。
    Expired,
    /// 停止が先に行われたため、実行せずに断った。
    StoppedFirst,
}

impl ControlError {
    /// 入口の利用者向けの文言。今の3種は入口ごとの`fallback`、新しい3種は共通の文言。
    pub fn text(self, fallback: &'static str) -> &'static str {
        match self {
            Self::Busy => BUSY_TEXT,
            Self::Expired => EXPIRED_TEXT,
            Self::StoppedFirst => STOPPED_FIRST_TEXT,
            Self::Poisoned | Self::Stopped | Self::Reentrant => fallback,
        }
    }
}

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Poisoned => "audio control is poisoned",
            Self::Stopped => "audio control has stopped",
            Self::Reentrant => "audio control was entered from its own thread",
            Self::Busy => BUSY_TEXT,
            Self::Expired => EXPIRED_TEXT,
            Self::StoppedFirst => STOPPED_FIRST_TEXT,
        })
    }
}

impl std::error::Error for ControlError {}

/// `run_async`の失敗。閉包の panic は、コマンドのタスクを panic させず`Panicked`で返す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunAsyncError {
    Control(ControlError),
    Panicked(String),
}

impl RunAsyncError {
    /// 入口の利用者向けの文言。`ControlError::text`と同じ規則で、panic は panic の文字列を返す。
    pub fn text(self, fallback: &'static str) -> String {
        match self {
            Self::Control(error) => error.text(fallback).to_owned(),
            Self::Panicked(text) => text,
        }
    }
}

impl From<ControlError> for RunAsyncError {
    fn from(error: ControlError) -> Self {
        Self::Control(error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Command,
    Bundle,
    Startup,
    Warmup,
    Scheduler,
    Tray,
    Shortcut,
    Update,
    Migration,
    TemporarySession,
    Obs,
    Quit,
}

const KIND_COUNT: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub kind: EntryKind,
    pub name: &'static str,
    class: Option<JobClass>,
}

impl Entry {
    pub const fn new(kind: EntryKind, name: &'static str) -> Self {
        Self {
            kind,
            name,
            class: None,
        }
    }
    pub const fn command(name: &'static str) -> Self {
        Self::new(EntryKind::Command, name)
    }
    pub const fn bundle(name: &'static str) -> Self {
        Self::new(EntryKind::Bundle, name)
    }
    /// 名前では決まらない入口が、要求の中身から決めた種類を渡す。
    pub const fn class(mut self, class: JobClass) -> Self {
        self.class = Some(class);
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Accepted,
    /// 実行のスレッドが取り出した。
    Started,
    /// 閉包が戻った。返事の前。
    Completed,
    /// 実行せずに断った（上限・期限・停止が先）。
    Refused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record {
    pub seq: u64,
    pub entry: Entry,
    pub phase: Phase,
    /// `Completed`だけが持つ、実行にかかった時間。
    pub elapsed: Option<Duration>,
}

const LOG_CAPACITY: usize = 256;

/// 受付の通し番号と入口の種類を記録する。葉のロックだけを持ち、持っている間に別のロックも I/O も行わない。
pub struct Admission {
    next_seq: AtomicU64,
    counts: [AtomicU64; KIND_COUNT],
    slow: AtomicU64,
    log: Mutex<VecDeque<Record>>,
    #[cfg(test)]
    hook: Mutex<Option<TestHook>>,
}

/// 試験用：受付の途中の地点。`lock_held`は、その地点で記録のロックが（呼び出したスレッドを含めて）保たれているか。
#[cfg(test)]
#[derive(Clone, Copy, Debug)]
pub(crate) enum TestPoint {
    Entry(&'static str),
    AfterSeq { seq: u64, lock_held: bool },
}

#[cfg(test)]
type TestHook = Arc<dyn Fn(TestPoint) + Send + Sync>;

impl Admission {
    fn new() -> Self {
        Self {
            next_seq: AtomicU64::new(1),
            counts: std::array::from_fn(|_| AtomicU64::new(0)),
            slow: AtomicU64::new(0),
            log: Mutex::new(VecDeque::new()),
            #[cfg(test)]
            hook: Mutex::new(None),
        }
    }

    /// 採番と受付の追記を同じ短いロック区間で行い、記録の順を受付番号と一致させる。
    /// ホストのロックはここでは取らない。
    fn accept(&self, entry: Entry) -> u64 {
        #[cfg(test)]
        self.run_hook(TestPoint::Entry(entry.name));
        self.counts[entry.kind as usize].fetch_add(1, Ordering::Relaxed);
        // 10msごとの定期の更新で、直近の操作の記録を押し出さない。
        if entry.kind == EntryKind::Scheduler {
            return self.next_seq.fetch_add(1, Ordering::SeqCst);
        }
        let Ok(mut log) = self.log.lock() else {
            return self.next_seq.fetch_add(1, Ordering::SeqCst);
        };
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        #[cfg(test)]
        {
            let lock_held = self.log.try_lock().is_err();
            self.run_hook(TestPoint::AfterSeq { seq, lock_held });
        }
        Self::append(&mut log, seq, entry, Phase::Accepted, None);
        seq
    }

    #[cfg(test)]
    fn run_hook(&self, point: TestPoint) {
        let hook = self.hook.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(point);
        }
    }

    #[cfg(test)]
    pub(crate) fn set_hook(&self, hook: TestHook) {
        *self.hook.lock().unwrap() = Some(hook);
    }

    fn append(
        log: &mut VecDeque<Record>,
        seq: u64,
        entry: Entry,
        phase: Phase,
        elapsed: Option<Duration>,
    ) {
        if log.len() == LOG_CAPACITY {
            log.pop_front();
        }
        log.push_back(Record {
            seq,
            entry,
            phase,
            elapsed,
        });
    }

    /// 受付の後の段階（取り出し・完了・断り）を記録する。定期の更新は記録しない。
    fn record(&self, seq: u64, entry: Entry, phase: Phase, elapsed: Option<Duration>) {
        if entry.kind == EntryKind::Scheduler {
            return;
        }
        if let Ok(mut log) = self.log.lock() {
            Self::append(&mut log, seq, entry, phase, elapsed);
        }
    }

    fn note_slow(&self) {
        self.slow.fetch_add(1, Ordering::Relaxed);
    }

    /// 試験用：実行の時間の警告を出した回数。
    #[cfg(test)]
    pub(crate) fn slow_warnings(&self) -> u64 {
        self.slow.load(Ordering::Relaxed)
    }

    /// 受け付けた件数。
    pub fn accepted(&self) -> u64 {
        self.next_seq.load(Ordering::SeqCst) - 1
    }

    pub fn accepted_of(&self, kind: EntryKind) -> u64 {
        self.counts[kind as usize].load(Ordering::Relaxed)
    }

    /// 直近の記録（定期の更新を除く）。古いものから順に返す。
    pub fn records(&self) -> Vec<Record> {
        self.log
            .lock()
            .map(|log| log.iter().copied().collect())
            .unwrap_or_default()
    }
}

/// 受け付けたが、まだ列へ積んでいない操作。
pub struct Ticket<'a> {
    control: &'a AudioControl,
    seq: u64,
    entry: Entry,
    class: JobClass,
    accepted_at: Instant,
}

struct Shared {
    queue: Arc<JobQueue>,
    admission: Arc<Admission>,
    actor: Mutex<Option<JoinHandle<()>>>,
    actor_id: ThreadId,
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.queue.close();
        let handle = self
            .actor
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(handle) = handle {
            if thread::current().id() != self.actor_id {
                let _ = handle.join();
            }
        }
    }
}

#[derive(Clone)]
pub struct AudioControl {
    shared: Arc<Shared>,
}

pub struct WeakAudioControl {
    shared: Weak<Shared>,
}

impl WeakAudioControl {
    pub fn upgrade(&self) -> Option<AudioControl> {
        Some(AudioControl {
            shared: self.shared.upgrade()?,
        })
    }
}

impl AudioControl {
    /// 実行のスレッドを起動して、ホストを渡す。
    pub fn try_new(host: AudioHost) -> io::Result<Self> {
        let queue = Arc::new(JobQueue::new());
        let admission = Arc::new(Admission::new());
        let handle = actor::spawn(queue.clone(), admission.clone(), host)?;
        Ok(Self {
            shared: Arc::new(Shared {
                queue,
                admission,
                actor_id: handle.thread().id(),
                actor: Mutex::new(Some(handle)),
            }),
        })
    }

    #[cfg(test)]
    pub fn new(host: AudioHost) -> Self {
        Self::try_new(host).expect("the audio control thread starts")
    }

    pub fn admission(&self) -> &Admission {
        &self.shared.admission
    }

    pub fn downgrade(&self) -> WeakAudioControl {
        WeakAudioControl {
            shared: Arc::downgrade(&self.shared),
        }
    }

    /// 受付だけを行う。列へ積む操作は、返された`Ticket`の`run`・`post`で行う。
    pub fn admit(&self, entry: Entry) -> Ticket<'_> {
        let class = class_of(entry);
        let accepted_at = Instant::now();
        let seq = self.shared.admission.accept(entry);
        Ticket {
            control: self,
            seq,
            entry,
            class,
            accepted_at,
        }
    }

    /// 受付を記録し、列へ積んで、結果を待つ。待つ間はブロッキングのスレッドを使わない（実行のスレッドの上から
    /// 呼ぶと`Reentrant`）。閉包が panic したら、`Panicked`で返す。
    pub async fn run_async<R: Send + 'static>(
        &self,
        entry: Entry,
        f: impl FnOnce(&mut AudioHost) -> R + Send + 'static,
    ) -> Result<R, RunAsyncError> {
        let ticket = self.admit(entry);
        ticket.guard_reentrancy()?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let run = Box::new(move |host: &mut AudioHost| Box::new(f(host)) as Payload);
        ticket.push(JobKind::Run {
            tx: ReplyTx::Async(tx),
            f: run,
        })?;
        match ticket.wait_reply_async(rx).await? {
            Reply::Done(output) => output
                .downcast::<R>()
                .map(|output| *output)
                .map_err(|_| RunAsyncError::Control(ControlError::Stopped)),
            Reply::Panicked(payload) => Err(RunAsyncError::Panicked(actor::payload_text(
                payload.as_ref(),
            ))),
            Reply::Poisoned => Err(RunAsyncError::Control(ControlError::Poisoned)),
            Reply::Refused(error) => Err(RunAsyncError::Control(error)),
        }
    }

    /// 受付を記録し、実行のスレッドで閉包が終わるまで待って結果を返す。
    pub fn run<R: Send + 'static>(
        &self,
        entry: Entry,
        f: impl FnOnce(&mut AudioHost) -> R + Send + 'static,
    ) -> Result<R, ControlError> {
        self.admit(entry).run(f)
    }

    /// 受付を記録し、列へ積んで待たずに戻る。積めなければ閉包を呼ばずに`Err(Stopped)`を返す。
    pub fn post(
        &self,
        entry: Entry,
        f: impl FnOnce(Result<&mut AudioHost, ControlError>) + Send + 'static,
    ) -> Result<(), ControlError> {
        self.admit(entry).post(f)
    }

    /// 試験専用：実行のスレッドからホストを箱ごと借りる。
    #[cfg(test)]
    pub(crate) fn lock(&self, entry: Entry) -> Result<HostLease<'_>, ControlError> {
        self.admit(entry).lock()
    }

    /// ロックを取らない入口（アプリの終了の要求など）を記録する。
    pub fn note(&self, entry: Entry) {
        self.shared.admission.accept(entry);
    }

    #[cfg(test)]
    pub(crate) fn close_for_test(&self) {
        self.shared.queue.close();
    }

    /// 試験専用：列が閉じたかを、AudioControlを持たずに見る。
    #[cfg(test)]
    pub(crate) fn closed_probe(&self) -> impl Fn() -> bool + Send + 'static {
        let queue = self.shared.queue.clone();
        move || queue.is_closed()
    }

    #[cfg(test)]
    pub(crate) fn queue_len(&self) -> usize {
        self.shared.queue.len()
    }

    /// 試験用：終わっていない数える仕事の数。
    #[cfg(test)]
    pub(crate) fn counted(&self) -> usize {
        self.shared.queue.counted()
    }

    /// 試験用：最後に受け付けた停止の番号。
    #[cfg(test)]
    pub(crate) fn fence(&self) -> u64 {
        self.shared.queue.fence()
    }

    /// 試験用：上限・期限・警告の長さを縮める。
    #[cfg(test)]
    pub(crate) fn set_limits(
        &self,
        max_counted: usize,
        wait: Duration,
        slow: Duration,
        slow_start: Duration,
    ) {
        self.shared.queue.set_limits(queue::Limits {
            max_counted,
            wait,
            slow,
            slow_start,
        });
    }

    #[cfg(test)]
    pub(crate) fn set_actor_seam(&self, seam: Arc<dyn Fn(ActorPoint) + Send + Sync>) {
        self.shared.queue.set_seam(seam);
    }

    /// モード VST の10msごとの更新。`Weak`で持ち、アプリの状態が破棄されたら止まる。
    pub(crate) fn start_mode_vst_scheduler(&self) {
        let weak = self.downgrade();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(10));
            let Some(control) = weak.upgrade() else { break };
            let tick = control.run(Entry::new(EntryKind::Scheduler, "poll_mode_vst"), |host| {
                host.poll_mode_vst()
            });
            if !scheduler_continues(tick) {
                break;
            }
        });
    }
}

/// 更新の結果から、次の周期へ進むか。断りは次の周期へ、止まった・再入は終わる。
pub(super) fn scheduler_continues(result: Result<(), ControlError>) -> bool {
    match result {
        Ok(())
        | Err(
            ControlError::Poisoned
            | ControlError::Busy
            | ControlError::Expired
            | ControlError::StoppedFirst,
        ) => true,
        Err(ControlError::Stopped | ControlError::Reentrant) => false,
    }
}

impl<'a> Ticket<'a> {
    pub fn seq(&self) -> u64 {
        self.seq
    }

    fn job(&self, kind: JobKind) -> Job {
        Job {
            seq: self.seq,
            entry: self.entry,
            class: self.class,
            accepted_at: self.accepted_at,
            kind,
        }
    }

    /// 列へ積む。混雑で断られたら`Refused`を記録する（閉じていた`Stopped`は記録しない）。
    fn push(&self, kind: JobKind) -> Result<(), ControlError> {
        let result = self.control.shared.queue.push(self.job(kind));
        if result == Err(ControlError::Busy) {
            self.record_refused();
        }
        result
    }

    fn record_refused(&self) {
        self.control
            .shared
            .admission
            .record(self.seq, self.entry, Phase::Refused, None);
    }

    /// 期限付きの待ち（Starting・Normal）は、受付から期限までに始まらなければ、列のロックの中で
    /// まだ列にある自分の仕事を取り除いて`Expired`にする。取り出された後なら、返事が来るまで待つ。
    /// Stop・Mute・Tick・Release は無期限に待つ。
    fn wait_reply(&self, rx: &Receiver<Reply>) -> Result<Reply, ControlError> {
        if !self.class.waits_with_deadline() {
            return rx.recv().map_err(|_| ControlError::Stopped);
        }
        let queue = &self.control.shared.queue;
        let remaining =
            (self.accepted_at + queue.limits().wait).saturating_duration_since(Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(reply) => Ok(reply),
            Err(RecvTimeoutError::Disconnected) => Err(ControlError::Stopped),
            Err(RecvTimeoutError::Timeout) => match queue.cancel_waiting(self.seq) {
                Some(job) => {
                    drop(job);
                    self.record_refused();
                    Err(ControlError::Expired)
                }
                None => rx.recv().map_err(|_| ControlError::Stopped),
            },
        }
    }

    /// `wait_reply`の非同期版。待つ間にブロッキングのスレッドを使わない。
    async fn wait_reply_async(
        &self,
        mut rx: tokio::sync::oneshot::Receiver<Reply>,
    ) -> Result<Reply, ControlError> {
        if !self.class.waits_with_deadline() {
            return rx.await.map_err(|_| ControlError::Stopped);
        }
        let queue = &self.control.shared.queue;
        let deadline = tokio::time::Instant::from_std(self.accepted_at + queue.limits().wait);
        match tokio::time::timeout_at(deadline, &mut rx).await {
            Ok(reply) => reply.map_err(|_| ControlError::Stopped),
            Err(_elapsed) => match queue.cancel_waiting(self.seq) {
                Some(job) => {
                    drop(job);
                    self.record_refused();
                    Err(ControlError::Expired)
                }
                None => rx.await.map_err(|_| ControlError::Stopped),
            },
        }
    }

    /// 実行のスレッドの上からの待ちは、列へ積まずに`Err(Reentrant)`で戻る。
    fn guard_reentrancy(&self) -> Result<(), ControlError> {
        if actor::on_actor() {
            log::error!(
                "audio entry {} was entered from the audio control thread",
                self.entry.name
            );
            return Err(ControlError::Reentrant);
        }
        Ok(())
    }

    pub fn run<R: Send + 'static>(
        self,
        f: impl FnOnce(&mut AudioHost) -> R + Send + 'static,
    ) -> Result<R, ControlError> {
        self.guard_reentrancy()?;
        let (tx, rx) = sync_channel(1);
        let run = Box::new(move |host: &mut AudioHost| Box::new(f(host)) as Payload);
        self.push(JobKind::Run {
            tx: ReplyTx::Sync(tx),
            f: run,
        })?;
        match self.wait_reply(&rx)? {
            Reply::Done(output) => output
                .downcast::<R>()
                .map(|output| *output)
                .map_err(|_| ControlError::Stopped),
            Reply::Panicked(payload) => resume_unwind(payload),
            Reply::Poisoned => Err(ControlError::Poisoned),
            Reply::Refused(error) => Err(error),
        }
    }

    pub fn post(
        self,
        f: impl FnOnce(Result<&mut AudioHost, ControlError>) + Send + 'static,
    ) -> Result<(), ControlError> {
        self.push(JobKind::Post { f: Box::new(f) })
    }

    #[cfg(test)]
    pub(crate) fn lock(self) -> Result<HostLease<'a>, ControlError> {
        self.guard_reentrancy()?;
        let (grant_tx, grant_rx) = sync_channel(1);
        let (back_tx, back_rx) = sync_channel(1);
        let lease = lease::LeaseGrant {
            grant: grant_tx,
            back: back_rx,
        };
        self.push(JobKind::Lease(lease))?;
        match grant_rx.recv() {
            Ok(Ok(host)) => Ok(HostLease::new(host, back_tx)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(ControlError::Stopped),
        }
    }
}

/// 配信ミックス用の2つ目の`AudioHost`。独自の`Mutex`は持たず、主の`AudioHost`のロックの内側でだけ使う。
pub(super) fn post_mix_child_host(root: PathBuf, retired: Arc<engine_life::Store>) -> AudioHost {
    let mut child = AudioHost::with_retired(root, retired);
    child.post_role = true;
    child
}
