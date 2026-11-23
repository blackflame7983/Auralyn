//! 音声状態への入口。`AudioHost`は1本の実行のスレッドが持ち、入口は`run`（結果を待つ）か
//! `post`（待たない）で閉包を渡す。受付の順序と、実行のスレッドが取り出した順序を記録する。
//!
//! 記録は受付の順序と取り出した順序を残すだけである。操作の並べ替えにも、利用者から見た勝ち負けにも
//! 使わない。仕事は積んだ順（FIFO）に1件ずつ実行する。
mod actor;
#[cfg(test)]
mod lease;
mod queue;

#[cfg(test)]
pub(crate) use lease::HostLease;
#[cfg(test)]
pub(crate) use queue::ActorPoint;

use super::{engine_life, AudioHost};
use queue::{Job, JobKind, JobQueue, Payload, Reply};
use std::collections::VecDeque;
use std::fmt;
use std::io;
use std::panic::resume_unwind;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ControlError {
    /// 閉包が panic した後。以後の仕事は実行しない。
    Poisoned,
    /// 列が閉じた、または実行のスレッドが止まった。
    Stopped,
    /// 実行のスレッドの上から`run`を呼んだ。
    Reentrant,
}

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Poisoned => "audio control is poisoned",
            Self::Stopped => "audio control has stopped",
            Self::Reentrant => "audio control was entered from its own thread",
        })
    }
}

impl std::error::Error for ControlError {}

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
}

impl Entry {
    pub const fn new(kind: EntryKind, name: &'static str) -> Self {
        Self { kind, name }
    }
    pub const fn command(name: &'static str) -> Self {
        Self::new(EntryKind::Command, name)
    }
    pub const fn bundle(name: &'static str) -> Self {
        Self::new(EntryKind::Bundle, name)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Accepted,
    LockGranted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Record {
    pub seq: u64,
    pub entry: Entry,
    pub phase: Phase,
}

const LOG_CAPACITY: usize = 256;

/// 受付の通し番号と入口の種類を記録する。葉のロックだけを持ち、持っている間に別のロックも I/O も行わない。
pub struct Admission {
    next_seq: AtomicU64,
    counts: [AtomicU64; KIND_COUNT],
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
        Self::append(&mut log, seq, entry, Phase::Accepted);
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

    fn append(log: &mut VecDeque<Record>, seq: u64, entry: Entry, phase: Phase) {
        if log.len() == LOG_CAPACITY {
            log.pop_front();
        }
        log.push_back(Record { seq, entry, phase });
    }

    fn push_granted(&self, seq: u64, entry: Entry) {
        if entry.kind == EntryKind::Scheduler {
            return;
        }
        if let Ok(mut log) = self.log.lock() {
            Self::append(&mut log, seq, entry, Phase::LockGranted);
        }
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
        Ticket {
            control: self,
            seq: self.shared.admission.accept(entry),
            entry,
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
            match control.run(Entry::new(EntryKind::Scheduler, "poll_mode_vst"), |host| {
                host.poll_mode_vst()
            }) {
                Ok(()) | Err(ControlError::Poisoned) => {}
                Err(ControlError::Stopped | ControlError::Reentrant) => break,
            }
        });
    }
}

impl<'a> Ticket<'a> {
    pub fn seq(&self) -> u64 {
        self.seq
    }

    fn job(self, kind: JobKind) -> Job {
        Job {
            seq: self.seq,
            entry: self.entry,
            kind,
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
        let queue = &self.control.shared.queue;
        let run = Box::new(move |host: &mut AudioHost| Box::new(f(host)) as Payload);
        queue.push(self.job(JobKind::Run { tx, f: run }))?;
        match rx.recv() {
            Ok(Reply::Done(output)) => output
                .downcast::<R>()
                .map(|output| *output)
                .map_err(|_| ControlError::Stopped),
            Ok(Reply::Panicked(payload)) => resume_unwind(payload),
            Ok(Reply::Poisoned) => Err(ControlError::Poisoned),
            Err(_) => Err(ControlError::Stopped),
        }
    }

    pub fn post(
        self,
        f: impl FnOnce(Result<&mut AudioHost, ControlError>) + Send + 'static,
    ) -> Result<(), ControlError> {
        let queue = self.control.shared.queue.clone();
        queue.push(self.job(JobKind::Post { f: Box::new(f) }))
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
        self.control
            .shared
            .queue
            .push(self.job(JobKind::Lease(lease)))?;
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
