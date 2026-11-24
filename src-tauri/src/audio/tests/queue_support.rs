//! 受付の列の試験（停止の優先・上限・期限・解放）が共有する道具。待ちはすべて門で、時間切れは失敗の上限。
use super::control::{AudioControl, ControlError, Entry, EntryKind, Phase};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub(super) const GATE: Duration = Duration::from_secs(10);
pub(super) const WAIT: Duration = Duration::from_millis(150);
pub(super) const LONG: Duration = Duration::from_secs(3600);
static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

pub(super) fn plain_host() -> AudioHost {
    AudioHost::new(std::env::temp_dir().join(format!(
        "auralyn-stop-priority-{}-{}",
        std::process::id(),
        NEXT_DIR.fetch_add(1, Ordering::SeqCst)
    )))
}

pub(super) fn control() -> AudioControl {
    AudioControl::new(plain_host())
}

/// 上限と期限を縮めた列。警告の長さは長いまま。
pub(super) fn limited(max_counted: usize, wait: Duration) -> AudioControl {
    let control = control();
    control.set_limits(max_counted, wait, LONG);
    control
}

pub(super) fn cmd(name: &'static str) -> Entry {
    Entry::command(name)
}

pub(super) fn normal() -> Entry {
    cmd("get_audio_state")
}

pub(super) fn starting() -> Entry {
    cmd("start_audio")
}

pub(super) fn stop_entry() -> Entry {
    cmd("stop_audio")
}

pub(super) fn mute_entry() -> Entry {
    cmd("set_global_mute")
}

pub(super) fn release_entry() -> Entry {
    cmd("end_live_changes")
}

pub(super) fn tick_entry() -> Entry {
    Entry::new(EntryKind::Scheduler, "poll_mode_vst")
}

pub(super) fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(started.elapsed() < GATE, "時間内に成立しなかった: {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

pub(super) fn wait_len(control: &AudioControl, len: usize) {
    wait_until("the queue length", || control.queue_len() == len);
}

/// 別のスレッドで走らせ、門の時間内に戻らなければ失敗にする。
pub(super) fn within<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(GATE)
        .unwrap_or_else(|_| panic!("時間内に戻らなかった: {what}"))
}

pub(super) fn join<T>(what: &str, handle: std::thread::JoinHandle<T>) -> T {
    wait_until(what, || handle.is_finished());
    handle.join().unwrap()
}

/// 実行のスレッドを、`post`の閉包の中で止める。`release`する（または落とす）と進む。
pub(super) struct Hold {
    release: mpsc::Sender<()>,
}

impl Hold {
    pub(super) fn release(self) {
        let _ = self.release.send(());
    }
}

pub(super) fn hold_with(control: &AudioControl, entry: Entry) -> Hold {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    control
        .post(entry, move |_| {
            let _ = entered_tx.send(());
            let _ = release_rx.recv_timeout(GATE);
        })
        .unwrap();
    entered_rx
        .recv_timeout(GATE)
        .expect("実行のスレッドが止める仕事を取らなかった");
    Hold {
        release: release_tx,
    }
}

/// 数えず、断られない仕事（Release）で止める。
pub(super) fn hold(control: &AudioControl) -> Hold {
    hold_with(control, release_entry())
}

pub(super) type Log = Arc<Mutex<Vec<String>>>;

pub(super) fn log() -> Log {
    Arc::default()
}

pub(super) fn entries(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

/// 受け取った結果を記録する`post`の閉包。
pub(super) fn record_into(
    log: &Log,
    name: &'static str,
) -> impl FnOnce(Result<&mut AudioHost, ControlError>) + Send + 'static {
    let log = log.clone();
    move |host| {
        let text = match host {
            Ok(_) => format!("{name}:ok"),
            Err(error) => format!("{name}:{error:?}"),
        };
        log.lock().unwrap().push(text);
    }
}

pub(super) fn phases(control: &AudioControl, name: &str) -> Vec<Phase> {
    control
        .admission()
        .records()
        .iter()
        .filter(|r| r.entry.name == name)
        .map(|r| r.phase)
        .collect()
}

pub(super) fn spawn_run(
    control: &AudioControl,
    entry: Entry,
) -> std::thread::JoinHandle<Result<(), ControlError>> {
    let control = control.clone();
    std::thread::spawn(move || control.run(entry, |_| ()))
}

/// 呼ばれたことを数える`run`の閉包を持つスレッド。
pub(super) fn spawn_counting_run(
    control: &AudioControl,
    entry: Entry,
    calls: &Arc<AtomicUsize>,
) -> std::thread::JoinHandle<Result<(), ControlError>> {
    let (control, calls) = (control.clone(), calls.clone());
    std::thread::spawn(move || {
        control.run(entry, move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
        })
    })
}

/// 満杯（`limited(2, WAIT)`）の列と、受付から期限が過ぎるまでの待ちの下で、`entry`の`run`を呼ぶ。
/// 期限が過ぎても取り消されず（まだ戻らない）、止めている門を開けると実行されて戻る。
pub(super) fn run_under_pressure<R: Send + 'static>(
    control: &AudioControl,
    entry: Entry,
    f: impl FnOnce(&mut AudioHost) -> R + Send + 'static,
) -> Result<R, ControlError> {
    let hold = hold(control);
    control.post(normal(), |_| ()).unwrap();
    control.post(normal(), |_| ()).unwrap();
    assert_eq!(
        control.run(normal(), |_| ()),
        Err(ControlError::Busy),
        "数える仕事が満杯のとき、通常の入口は断られる"
    );
    let runner = control.clone();
    let waiting = std::thread::spawn(move || runner.run(entry, f));
    wait_len(control, 3);
    std::thread::sleep(WAIT * 3);
    assert!(
        !waiting.is_finished(),
        "{}: 期限が過ぎても、断られず取り消されず待つ",
        entry.name
    );
    hold.release();
    join("the pressured run returns", waiting)
}
