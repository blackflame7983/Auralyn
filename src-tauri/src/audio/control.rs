//! 音声状態への入口。`AudioHost`の`Mutex`を取る場所をここへ集め、受付の順序を記録する。
//!
//! 記録は受付の順序と、実際にロックを得た順序を残すだけである。操作の並べ替えにも、
//! 利用者から見た勝ち負けにも使わない。ロックの種類・保持の長さ・実行するスレッドは変えない。
use super::AudioHost;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LockResult, Mutex, MutexGuard, Weak};
use std::thread;
use std::time::Duration;

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
}

impl Admission {
    fn new() -> Self {
        Self {
            next_seq: AtomicU64::new(1),
            counts: std::array::from_fn(|_| AtomicU64::new(0)),
            log: Mutex::new(VecDeque::new()),
        }
    }

    fn accept(&self, entry: Entry) -> u64 {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        self.counts[entry.kind as usize].fetch_add(1, Ordering::Relaxed);
        self.push(seq, entry, Phase::Accepted);
        seq
    }

    fn push(&self, seq: u64, entry: Entry, phase: Phase) {
        // 10msごとの定期の更新で、直近の操作の記録を押し出さない。
        if entry.kind == EntryKind::Scheduler {
            return;
        }
        if let Ok(mut log) = self.log.lock() {
            if log.len() == LOG_CAPACITY {
                log.pop_front();
            }
            log.push_back(Record { seq, entry, phase });
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

/// 受け付けたが、まだロックを取っていない操作。
pub struct Ticket<'a> {
    control: &'a AudioControl,
    seq: u64,
    entry: Entry,
}

#[derive(Clone)]
pub struct AudioControl {
    host: Arc<Mutex<AudioHost>>,
    admission: Arc<Admission>,
}

pub struct WeakAudioControl {
    host: Weak<Mutex<AudioHost>>,
    admission: Arc<Admission>,
}

impl WeakAudioControl {
    pub fn upgrade(&self) -> Option<AudioControl> {
        Some(AudioControl {
            host: self.host.upgrade()?,
            admission: self.admission.clone(),
        })
    }
}

impl AudioControl {
    pub fn new(host: AudioHost) -> Self {
        Self {
            host: Arc::new(Mutex::new(host)),
            admission: Arc::new(Admission::new()),
        }
    }

    pub fn admission(&self) -> &Admission {
        &self.admission
    }

    pub fn downgrade(&self) -> WeakAudioControl {
        WeakAudioControl {
            host: Arc::downgrade(&self.host),
            admission: self.admission.clone(),
        }
    }

    /// 受付だけを行う。ロックを取る操作は、返された`Ticket`の`lock`で行う。
    pub fn admit(&self, entry: Entry) -> Ticket<'_> {
        Ticket {
            control: self,
            seq: self.admission.accept(entry),
            entry,
        }
    }

    /// 受付を記録してからロックを取る。ロックを待つ順序は`Mutex`が決める。
    pub fn lock(&self, entry: Entry) -> LockResult<MutexGuard<'_, AudioHost>> {
        self.admit(entry).lock()
    }

    /// ロックを取らない入口（アプリの終了の要求など）を記録する。
    pub fn note(&self, entry: Entry) {
        self.admission.accept(entry);
    }

    /// モード VST の10msごとの更新。`Weak`で持ち、アプリの状態が破棄されたら止まる。
    pub(crate) fn start_mode_vst_scheduler(&self) {
        let weak = self.downgrade();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(10));
            let Some(control) = weak.upgrade() else { break };
            if let Ok(mut host) = control.lock(Entry::new(EntryKind::Scheduler, "poll_mode_vst")) {
                host.poll_mode_vst();
            };
        });
    }
}

impl<'a> Ticket<'a> {
    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn lock(self) -> LockResult<MutexGuard<'a, AudioHost>> {
        let result = self.control.host.lock();
        self.control
            .admission
            .push(self.seq, self.entry, Phase::LockGranted);
        result
    }
}

/// 配信ミックス用の2つ目の`AudioHost`。独自の`Mutex`は持たず、主の`AudioHost`のロックの内側でだけ使う。
pub(super) fn post_mix_child_host(root: PathBuf) -> AudioHost {
    let mut child = AudioHost::new(root);
    child.post_role = true;
    child
}
