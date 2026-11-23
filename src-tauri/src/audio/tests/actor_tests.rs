//! 実行のスレッド（`AudioControl`）の試験。X1〜X14（11.14）。
//! 待ちはすべて門（`mpsc`）で、時間切れは失敗の上限。時間で成否が決まるものは無い
//! （X7 の「増えない」の確認だけ、観測の間に100ms待つ）。
use super::compat_support::{scripted_parts, start_steps, Fixture};
use super::control::{ActorPoint, AudioControl, ControlError, Entry, EntryKind, Phase};
use super::mode_vst::tests::{install_completing_switch, switch_state};
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const GATE: Duration = Duration::from_secs(10);
static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

fn plain_host() -> AudioHost {
    AudioHost::new(std::env::temp_dir().join(format!(
        "auralyn-actor-{}-{}",
        std::process::id(),
        NEXT_DIR.fetch_add(1, Ordering::SeqCst)
    )))
}

fn control() -> AudioControl {
    AudioControl::new(plain_host())
}

fn cmd(name: &'static str) -> Entry {
    Entry::command(name)
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(started.elapsed() < GATE, "時間内に成立しなかった: {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// 別のスレッドで走らせ、門の時間内に戻らなければ失敗にする。
fn within<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(GATE)
        .unwrap_or_else(|_| panic!("時間内に戻らなかった: {what}"))
}

/// 実行のスレッドを、`post`の閉包の中で止める。落とす（または`release`する）と進む。
struct Hold {
    release: mpsc::Sender<()>,
}

impl Hold {
    fn release(self) {
        let _ = self.release.send(());
    }
}

fn hold(control: &AudioControl) -> Hold {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    control
        .post(cmd("hold"), move |_| {
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

/// 落とされた時に処理を走らせる。取り込み値の`Drop`の代わり。
struct OnDrop(Option<Box<dyn FnOnce() + Send>>);

impl OnDrop {
    fn new(f: impl FnOnce() + Send + 'static) -> Self {
        Self(Some(Box::new(f)))
    }
}

impl Drop for OnDrop {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

fn panic_on_drop() -> OnDrop {
    OnDrop::new(|| panic!("a captured value panicked on drop"))
}

/// 門で止まる取り込み値。`entered`へ知らせ、`release`されるまで`Drop`が戻らない。
fn gated_drop() -> (OnDrop, mpsc::Receiver<()>, mpsc::Sender<()>) {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let guard = OnDrop::new(move || {
        let _ = entered_tx.send(());
        let _ = release_rx.recv_timeout(GATE);
    });
    (guard, entered_rx, release_tx)
}

fn arm(control: &AudioControl, point: ActorPoint) -> Arc<AtomicBool> {
    let armed = Arc::new(AtomicBool::new(false));
    let flag = armed.clone();
    control.set_actor_seam(Arc::new(move |at| {
        if at == point && flag.swap(false, Ordering::SeqCst) {
            panic!("the test seam panicked at {at:?}");
        }
    }));
    armed
}

fn wait_len(control: &AudioControl, len: usize) {
    wait_until("the queue length", || control.queue_len() == len);
}

fn granted(control: &AudioControl, name: &str) -> Vec<u64> {
    control
        .admission()
        .records()
        .iter()
        .filter(|r| r.entry.name == name && r.phase == Phase::Started)
        .map(|r| r.seq)
        .collect()
}

fn phases(control: &AudioControl, name: &str) -> Vec<Phase> {
    control
        .admission()
        .records()
        .iter()
        .filter(|r| r.entry.name == name)
        .map(|r| r.phase)
        .collect()
}

/// 受け取った結果を記録する`post`の閉包。
fn record_into(
    log: &Arc<Mutex<Vec<String>>>,
    name: &'static str,
) -> impl FnOnce(Result<&mut AudioHost, ControlError>) + Send + 'static {
    let log = log.clone();
    move |host| {
        let text = match host {
            Ok(_) => format!("{name}:ok"),
            Err(error) => format!("{name}:{error:?}"),
        };
        // 回収は unwind の外で行う。unwind の中なら、記録に印が付く。
        let text = if std::thread::panicking() {
            format!("{text}:unwinding")
        } else {
            text
        };
        log.lock().unwrap().push(text);
    }
}

// X1：積んだ順に実行される。`admit`の順ではなく、積んだ順（K11）。
#[test]
fn x1_jobs_run_in_the_order_they_were_queued() {
    let control = control();
    let order: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let hold = hold(&control);
    let log = order.clone();
    control
        .post(cmd("p1"), move |_| log.lock().unwrap().push("p1"))
        .unwrap();
    wait_len(&control, 1);
    let (runner, log) = (control.clone(), order.clone());
    let r2 = std::thread::spawn(move || {
        runner
            .run(cmd("r2"), move |_| log.lock().unwrap().push("r2"))
            .unwrap();
    });
    wait_len(&control, 2);
    let log = order.clone();
    control
        .post(cmd("p3"), move |_| log.lock().unwrap().push("p3"))
        .unwrap();
    wait_len(&control, 3);
    let (a, b) = (control.admit(cmd("A")), control.admit(cmd("B")));
    assert!(a.seq() < b.seq());
    let log = order.clone();
    b.post(move |_| log.lock().unwrap().push("B")).unwrap();
    let log = order.clone();
    a.post(move |_| log.lock().unwrap().push("A")).unwrap();
    wait_len(&control, 5);
    assert!(
        order.lock().unwrap().is_empty(),
        "止めている間は何も実行しない"
    );
    hold.release();
    control.run(cmd("end"), |_| ()).unwrap();
    r2.join().unwrap();
    assert_eq!(*order.lock().unwrap(), ["p1", "r2", "p3", "B", "A"]);
    let granted: Vec<_> = control
        .admission()
        .records()
        .iter()
        .filter(|r| r.phase == Phase::Started && ["A", "B"].contains(&r.entry.name))
        .map(|r| r.entry.name)
        .collect();
    assert_eq!(granted, ["B", "A"], "実行の順は積んだ順（K11）");
}

// X2：すべての閉包が、呼び出しとは別の1つのスレッドで走る。`run`は、閉包の中の通知が終わるまで戻らない。
#[test]
fn x2_run_returns_after_the_closure_and_its_notices_finish_on_the_one_actor_thread() {
    let (host, observer) = scripted_parts([]);
    let control = AudioControl::new(host);
    let caller = std::thread::current().id();
    let ids: Vec<_> = (0..3)
        .map(|_| {
            control
                .run(cmd("x2"), |_| {
                    let current = std::thread::current();
                    assert_eq!(current.name(), Some("auralyn-audio-control"));
                    current.id()
                })
                .unwrap()
        })
        .collect();
    assert!(ids.iter().all(|id| *id == ids[0] && *id != caller));
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let runner = control.clone();
    let worker = std::thread::spawn(move || {
        runner
            .run(cmd("notices"), move |host| {
                let _ = entered_tx.send(());
                release_rx.recv_timeout(GATE).expect("門が開かなかった");
                host.notice("first", 1);
                host.notice("second", 2);
                42u32
            })
            .unwrap()
    });
    entered_rx.recv_timeout(GATE).expect("閉包が始まらなかった");
    assert!(!worker.is_finished(), "閉包が戻るまで run は戻らない");
    assert!(observer.recorder.names().is_empty());
    release_tx.send(()).unwrap();
    assert_eq!(worker.join().unwrap(), 42);
    assert_eq!(
        observer.recorder.names(),
        ["first", "second"],
        "run が戻った時点で、閉包の中の通知は終わっている"
    );
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// X3：`post`は待たずに戻り、順番が来てから実行される。実行のスレッドが忙しくても、ほかの呼び出しは戻る。
#[test]
fn x3_post_returns_while_the_actor_is_busy_and_runs_later() {
    let f = Fixture::new([]);
    let control = f.control.clone();
    let hold = hold(&control);
    let tray = control.clone();
    within("post(tray_mute_toggle)", move || {
        tray.post(Entry::new(EntryKind::Tray, "mute_toggle"), tray_mute_toggle)
            .unwrap();
    });
    assert_eq!(phases(&control, "mute_toggle"), [Phase::Accepted]);
    assert!(f.recorder.names().is_empty(), "閉包は未実行");
    let other = control.clone();
    within("other callers", move || {
        let _ = other.admission().records();
        other.note(Entry::new(EntryKind::Quit, "quit_app"));
        other.post(cmd("noop"), |_| ()).unwrap();
        other.admission().accepted()
    });
    hold.release();
    assert!(control
        .run(cmd("read"), |host| host.is_global_muted)
        .unwrap());
    assert_eq!(
        f.recorder
            .names()
            .iter()
            .filter(|name| *name == "global-mute-changed")
            .count(),
        1
    );
    assert_eq!(
        phases(&control, "mute_toggle"),
        [Phase::Accepted, Phase::Started, Phase::Completed]
    );
}

// X3（失敗）：本体が`Err`なら、トレイは捨てる。通知は出ない。
#[test]
fn x3_a_failing_tray_toggle_is_dropped_silently() {
    let f = Fixture::new([(
        "SetGlobalMute",
        vec![super::compat_support::error_line("boom")],
    )]);
    f.control
        .post(Entry::new(EntryKind::Tray, "mute_toggle"), tray_mute_toggle)
        .unwrap();
    assert!(!f
        .control
        .run(cmd("read"), |host| host.is_global_muted)
        .unwrap());
    assert!(!f
        .recorder
        .names()
        .iter()
        .any(|name| name == "global-mute-changed"));
}

// X4（実行のスレッド）：閉包の panic は呼び出し側へ投げ直され、以後の`run`は`Poisoned`。実行のスレッドは生きている。
#[test]
fn x4_a_panicking_closure_poisons_and_the_actor_survives() {
    let control = control();
    let result = catch_unwind(AssertUnwindSafe(|| {
        control.run(cmd("boom"), |_| -> () { panic!("boom in the closure") })
    }));
    let payload = result.expect_err("panic は呼び出し側へ投げ直される");
    assert_eq!(payload.downcast_ref::<&str>(), Some(&"boom in the closure"));
    assert_eq!(
        control.run(cmd("after"), |_| 1),
        Err(ControlError::Poisoned)
    );
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    control
        .post(cmd("post"), record_into(&log, "post"))
        .unwrap();
    assert_eq!(control.run(cmd("sync"), |_| 1), Err(ControlError::Poisoned));
    assert_eq!(
        *log.lock().unwrap(),
        ["post:Poisoned"],
        "実行のスレッドは生きていて、1回だけ呼ぶ"
    );
    // `post`の閉包の panic でも poison する。
    let other = self::control();
    other
        .post(cmd("boom"), |_| panic!("boom in the posted closure"))
        .unwrap();
    assert_eq!(other.run(cmd("after"), |_| 1), Err(ControlError::Poisoned));
    // scheduler は poison の後も眠って続ける。
    control.start_mode_vst_scheduler();
    let before = control.admission().accepted_of(EntryKind::Scheduler);
    wait_until("the scheduler keeps ticking", || {
        control.admission().accepted_of(EntryKind::Scheduler) >= before + 3
    });
}

// X5：閉包の中から`run`を呼ぶと、固まらずに`Reentrant`。`control.run`と`control.admit(..).run`の両方。
#[test]
fn x5_run_from_inside_a_closure_fails_at_once() {
    let control = control();
    let inner = control.clone();
    let (direct, ticketed) = within("run inside a closure", move || {
        let again = inner.clone();
        let direct = control
            .run(cmd("outer"), move |_| inner.run(cmd("inner"), |_| 1))
            .unwrap();
        let ticketed = control
            .run(cmd("outer2"), move |_| {
                again.admit(cmd("inner2")).run(|_| 1)
            })
            .unwrap();
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let post_control = control.clone();
        let post_log = log.clone();
        control
            .run(cmd("outer3"), move |_| {
                post_control
                    .post(cmd("inner3"), record_into(&post_log, "inner3"))
                    .unwrap();
            })
            .unwrap();
        control.run(cmd("sync"), |_| ()).unwrap();
        assert_eq!(
            *log.lock().unwrap(),
            ["inner3:ok"],
            "post は戻って、列の末尾で実行される"
        );
        (direct, ticketed)
    });
    assert_eq!(direct, Err(ControlError::Reentrant));
    assert_eq!(ticketed, Err(ControlError::Reentrant));
}

// X5b：入口の持ち物（`AudioControl`・`AudioState`）を、コマンド層の外へ持ち込まない。
#[test]
fn x5b_no_entry_handle_outside_the_command_layer() {
    fn collect(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    for entry in std::fs::read_dir(src.join("audio")).unwrap().flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if path.is_file()
            && name.ends_with(".rs")
            && name != "control.rs"
            && !name.ends_with("_tests.rs")
        {
            files.push(path);
        }
    }
    files.push(src.join("profile.rs"));
    files.push(src.join("bundle.rs"));
    collect(&src.join("obs_setup"), &mut files);
    assert!(files.len() > 10, "検査の対象が少なすぎる");
    for path in files {
        let text = std::fs::read_to_string(&path).unwrap();
        for word in ["AudioControl", "AudioState"] {
            assert!(
                !text.contains(word),
                "{} に {word} が現れた。入口はコマンド層だけが持つ",
                path.display()
            );
        }
    }
}

// X6：最後の`AudioControl`を捨てると、列を閉じ、残りを断り、ホストを`Drop`してから戻る（`join`）。
#[test]
fn x6_dropping_the_last_control_stops_the_actor_and_drops_the_host() {
    let (mut host, observer) = scripted_parts([("Start", start_steps(1))]);
    let (seam_entered_tx, seam_entered_rx) = mpsc::channel();
    let (seam_release_tx, seam_release_rx) = mpsc::channel::<()>();
    let (seam_entered_tx, seam_release_rx) =
        (Mutex::new(seam_entered_tx), Mutex::new(seam_release_rx));
    host.drop_seam = Some(Arc::new(move || {
        let _ = seam_entered_tx.lock().unwrap().send(());
        let _ = seam_release_rx.lock().unwrap().recv_timeout(GATE);
    }));
    let control = AudioControl::new(host);
    control
        .run(cmd("start"), |host| {
            host.start_with_input_source(
                Some("ASIO".into()),
                None,
                None,
                Some(512),
                Some(48000),
                None,
                None,
                None,
                None,
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .unwrap()
        .unwrap();
    let probe = observer.probe(0);
    assert!(!probe.exited());
    let hold = hold(&control);
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    control
        .post(cmd("queued"), record_into(&log, "queued"))
        .unwrap();
    wait_len(&control, 1);
    let closed = control.closed_probe();
    let dropper = std::thread::spawn(move || drop(control));
    wait_until("the last drop closes the queue", closed);
    hold.release();
    seam_entered_rx
        .recv_timeout(GATE)
        .expect("ホストが破棄されなかった");
    assert_eq!(
        *log.lock().unwrap(),
        ["queued:Stopped"],
        "受け付け済みの post は実行されず、回収で Stopped を1回受ける"
    );
    assert!(
        !dropper.is_finished(),
        "ホストの破棄が終わるまで、最後の drop は戻らない"
    );
    assert!(!probe.exited(), "ホストの破棄の途中。子はまだ生きている");
    seam_release_tx.send(()).unwrap();
    wait_until("the last drop returns", || dropper.is_finished());
    dropper.join().unwrap();
    assert!(probe.exited(), "戻った時点で子が終わっている");
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// X6：閉じた後に積む`post`は閉包を呼ばずに`Stopped`。`run`も`Stopped`。
#[test]
fn x6_after_the_queue_is_closed_post_and_run_refuse_without_calling_the_closure() {
    let control = control();
    control.close_for_test();
    let called = Arc::new(AtomicUsize::new(0));
    let counter = called.clone();
    assert_eq!(
        control.post(cmd("late"), move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
        Err(ControlError::Stopped)
    );
    assert_eq!(control.run(cmd("late"), |_| 1), Err(ControlError::Stopped));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        called.load(Ordering::SeqCst),
        0,
        "閉じた後の post は閉包を呼ばない"
    );
}

// X6：閉包が取り込んだ最後の複製をその仕事が捨てるときは、実行のスレッドが自分を`join`せずに終わる。
#[test]
fn x6_the_last_control_dropped_on_the_actor_thread_does_not_join_itself() {
    let mut host = plain_host();
    let (dropped_tx, dropped_rx) = mpsc::channel();
    let dropped_tx = Mutex::new(dropped_tx);
    host.drop_seam = Some(Arc::new(move || {
        let _ = dropped_tx.lock().unwrap().send(());
    }));
    let control = AudioControl::new(host);
    let hold = hold(&control);
    let inner = control.clone();
    control.post(cmd("owner"), move |_| drop(inner)).unwrap();
    drop(control);
    hold.release();
    dropped_rx
        .recv_timeout(GATE)
        .expect("実行のスレッドが自分を待って固まった");
}

// X7：scheduler の tick は実行のスレッドの上で走り、列に溜まらない。
#[test]
fn x7_the_scheduler_ticks_through_the_actor_and_never_piles_up() {
    let control = control();
    control.start_mode_vst_scheduler();
    wait_until("the first ticks", || {
        control.admission().accepted_of(EntryKind::Scheduler) >= 2
    });
    assert!(control
        .admission()
        .records()
        .iter()
        .all(|record| record.entry.kind != EntryKind::Scheduler));
    let hold = hold(&control);
    std::thread::sleep(Duration::from_millis(100));
    let first = control.admission().accepted_of(EntryKind::Scheduler);
    std::thread::sleep(Duration::from_millis(100));
    let second = control.admission().accepted_of(EntryKind::Scheduler);
    assert!(
        second - first <= 1,
        "実行のスレッドを止めている間、tick は高々1件（{first} -> {second}）"
    );
    assert!(control.queue_len() <= 1);
    hold.release();
    let weak = control.downgrade();
    drop(control);
    wait_until("the scheduler stops with the control", || {
        weak.upgrade().is_none()
    });
}

// X8：止めている間は`Accepted`だけ。実行のスレッドが取り出した後に`Started`が付き、閉包はその後に始まる。閉包が戻ると`Completed`が付く。
#[test]
fn x8_the_record_is_accepted_then_granted_when_the_actor_takes_it() {
    let control = control();
    let hold = hold(&control);
    let (seen_tx, seen_rx) = mpsc::channel();
    let probe = control.clone();
    control
        .post(cmd("a"), move |_| {
            let _ = seen_tx.send(granted(&probe, "a"));
        })
        .unwrap();
    assert_eq!(phases(&control, "a"), [Phase::Accepted]);
    hold.release();
    let seen = seen_rx.recv_timeout(GATE).expect("閉包が実行されなかった");
    assert_eq!(seen.len(), 1, "閉包が始まる時点で Started は記録済み");
    control.run(cmd("sync"), |_| ()).unwrap();
    assert_eq!(
        phases(&control, "a"),
        [Phase::Accepted, Phase::Started, Phase::Completed]
    );
}

// X9：待ち手は何も持たない。列のロックは葉で、取り出しの間も回収の間も持たない。
#[test]
fn x9_waiters_hold_no_lock_and_the_queue_lock_is_a_leaf() {
    let control = control();
    let hold = hold(&control);
    let waiters: Vec<_> = (0..3)
        .map(|_| {
            let waiting = control.clone();
            std::thread::spawn(move || waiting.run(cmd("waiter"), |_| ()).unwrap())
        })
        .collect();
    wait_len(&control, 3);
    let other = control.clone();
    within("callers while runs wait", move || {
        let _ = other.admit(cmd("admit"));
        other.note(Entry::new(EntryKind::Quit, "quit_app"));
        other.post(cmd("post"), |_| ()).unwrap();
        let _ = other.admission().records();
    });
    hold.release();
    for waiter in waiters {
        waiter.join().unwrap();
    }
    // 取り出しの間（`Condvar`の待ち）。
    control.run(cmd("idle"), |_| ()).unwrap();
    let idle = control.clone();
    within("callers while the actor waits for a job", move || {
        let _ = idle.admit(cmd("admit"));
        idle.note(Entry::new(EntryKind::Quit, "quit_app"));
        let _ = idle.admission().records();
    });
    // 回収の間：残りの`post`の閉包が止まっていても、受付は戻り、新しい`post`は`Stopped`。
    let (guard, entered, release) = gated_drop();
    let arming = arm(&control, ActorPoint::QueueLockHeld);
    let hold = self::hold(&control);
    control.post(cmd("leftover"), move |_| drop(guard)).unwrap();
    arming.store(true, Ordering::SeqCst);
    hold.release();
    entered
        .recv_timeout(GATE)
        .expect("回収が残りの仕事を呼ばなかった");
    let draining = control.clone();
    let late = within("callers during the drain", move || {
        let _ = draining.admit(cmd("admit"));
        draining.note(Entry::new(EntryKind::Quit, "quit_app"));
        let _ = draining.admission().records();
        draining.post(cmd("late"), |_| ())
    });
    assert_eq!(late, Err(ControlError::Stopped));
    release.send(()).unwrap();
}

// X10：試験専用のリース。貸している間は次の仕事を取り出さず、panic すれば poison して返る。
#[test]
fn x10_the_test_lease_hands_the_host_out_and_poisons_on_panic() {
    let control = control();
    let mut lease = control.lock(cmd("lease")).unwrap();
    lease.is_global_muted = true;
    let ran = Arc::new(AtomicBool::new(false));
    let flag = ran.clone();
    control
        .post(cmd("waiting"), move |_| flag.store(true, Ordering::SeqCst))
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        !ran.load(Ordering::SeqCst),
        "貸している間は次の仕事を取り出さない"
    );
    drop(lease);
    wait_until("the waiting job runs after the lease returns", || {
        ran.load(Ordering::SeqCst)
    });
    assert!(
        control
            .run(cmd("read"), |host| host.is_global_muted)
            .unwrap(),
        "ホストは箱ごと返り、項目の値が変わらない"
    );
    let holder = control.clone();
    let result = std::thread::spawn(move || {
        let _lease = holder.lock(cmd("poison")).unwrap();
        panic!("poison the audio state");
    })
    .join();
    assert!(result.is_err());
    assert_eq!(
        control.run(cmd("after"), |_| 1),
        Err(ControlError::Poisoned)
    );
    assert!(matches!(
        control.lock(cmd("after")),
        Err(ControlError::Poisoned)
    ));
}

// X11：poison の後の`post`は閉包を`Poisoned`で1回だけ呼ぶ。閉じた列への`post`は閉包を呼ばずに`Stopped`。
#[test]
fn x11_post_after_stop_or_poison_hands_the_error_to_the_closure() {
    let control = control();
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    assert!(catch_unwind(AssertUnwindSafe(
        || control.run(cmd("boom"), |_| -> () { panic!("boom") })
    ))
    .is_err());
    control.post(cmd("p"), record_into(&log, "p")).unwrap();
    assert_eq!(
        control.run(cmd("sync"), |_| ()),
        Err(ControlError::Poisoned)
    );
    assert_eq!(*log.lock().unwrap(), ["p:Poisoned"]);
    let closed = self::control();
    closed.close_for_test();
    let called = Arc::new(AtomicUsize::new(0));
    let counter = called.clone();
    let owned = OnDrop::new(move || {
        counter.fetch_add(100, Ordering::SeqCst);
    });
    let counter = called.clone();
    assert_eq!(
        closed.post(cmd("late"), move |_| {
            let _keep = &owned;
            counter.fetch_add(1, Ordering::SeqCst);
        }),
        Err(ControlError::Stopped)
    );
    assert_eq!(
        called.load(Ordering::SeqCst),
        100,
        "呼ばれず、取り込み値は捨てられる"
    );
}

// X12（2.2-A）：reader が`emit`の途中で止まっても、列と、ほかの呼び出しは止まらない。
#[test]
fn x12_a_reader_blocked_in_emit_does_not_stall_the_queue_or_other_callers() {
    let (host, observer) = scripted_parts([]);
    let control = AudioControl::new(host);
    let (emitter, link) = control
        .run(cmd("handles"), |host| {
            (host.emitter.clone(), host.link.clone())
        })
        .unwrap();
    observer.recorder.block_after(0);
    let reader = std::thread::spawn(move || emitter.emit("from-reader", 1));
    wait_until("the reader blocks in emit", || {
        observer.recorder.blocked_emits() == 1
    });
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let stalled = log.clone();
    control
        .post(cmd("needs-order"), move |host| {
            if let Ok(host) = host {
                host.notice("from-closure", 2);
            }
            stalled.lock().unwrap().push("done".into());
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert!(
        log.lock().unwrap().is_empty(),
        "order を取りたい閉包は止まる"
    );
    let other = control.clone();
    within("callers while a reader is stuck", move || {
        let _ = other.admit(cmd("admit"));
        other.note(Entry::new(EntryKind::Quit, "quit_app"));
        other.post(cmd("other"), |_| ()).unwrap();
        let _ = link.is_open();
        other.admission().records()
    });
    observer.recorder.release();
    reader.join().unwrap();
    wait_until("the stalled closure finishes", || {
        !log.lock().unwrap().is_empty()
    });
    assert_eq!(observer.recorder.names(), ["from-reader", "from-closure"]);
    control.run(cmd("sync"), |_| ()).unwrap();
    let _ = std::fs::remove_dir_all(&observer.dir);
}

fn direct_result(stop_first: bool) -> (String, Vec<String>) {
    let (mut host, observer) = scripted_parts([]);
    install_completing_switch(&mut host);
    if stop_first {
        let _ = host.stop();
        host.poll_mode_vst();
    } else {
        host.poll_mode_vst();
        let _ = host.stop();
    }
    let result = (switch_state(&host), observer.recorder.names());
    let _ = std::fs::remove_dir_all(&observer.dir);
    result
}

/// 停止と tick を積む形。本番の分類を通る入口（`stop_audio`・Scheduler の`poll_mode_vst`）を使う。
#[derive(Clone, Copy)]
enum Queued {
    /// 実行のスレッドを止めて`[stop, tick]`を積む。
    StopThenTick,
    /// 実行のスレッドを止めて`[tick, stop]`を積む。停止の列が先なので、停止が先に実行される。
    TickThenStop,
    /// tick を走らせたまま（門で止めて）停止を積む。tick が終わった後に停止が実行される。
    StopWhileTickRuns,
}

fn queued_result(case: Queued) -> (String, Vec<String>) {
    let (mut host, observer) = scripted_parts([]);
    install_completing_switch(&mut host);
    let control = AudioControl::new(host);
    let stop_entry = || Entry::command("stop_audio");
    let tick_entry = || Entry::new(EntryKind::Scheduler, "poll_mode_vst");
    let stop = |host: Result<&mut AudioHost, ControlError>| {
        if let Ok(host) = host {
            let _ = host.stop();
        }
    };
    let tick = |host: Result<&mut AudioHost, ControlError>| {
        if let Ok(host) = host {
            host.poll_mode_vst();
        }
    };
    match case {
        Queued::StopThenTick | Queued::TickThenStop => {
            let hold = hold(&control);
            if matches!(case, Queued::StopThenTick) {
                control.post(stop_entry(), stop).unwrap();
                control.post(tick_entry(), tick).unwrap();
            } else {
                control.post(tick_entry(), tick).unwrap();
                control.post(stop_entry(), stop).unwrap();
            }
            hold.release();
        }
        Queued::StopWhileTickRuns => {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel::<()>();
            control
                .post(tick_entry(), move |host| {
                    let _ = entered_tx.send(());
                    let _ = release_rx.recv_timeout(GATE);
                    tick(host);
                })
                .unwrap();
            entered_rx
                .recv_timeout(GATE)
                .expect("tick が始まらなかった");
            control.post(stop_entry(), stop).unwrap();
            let _ = release_tx.send(());
        }
    }
    let state = control.run(cmd("read"), |host| switch_state(host)).unwrap();
    let result = (state, observer.recorder.names());
    let _ = std::fs::remove_dir_all(&observer.dir);
    result
}

// X13：完了を確定できる tick と停止の順差（11.8）。(i) 停止を先に積むと切替を取り消す。(ii) tick を
// 走らせたまま停止を積むと、tick が先に確定して通常の停止になる（J-18：実行中は割り込まない）。
// (iii) 列の順が`[tick, stop]`でも、停止の列が先なので(i)と同じ結果になる。
#[test]
fn x13_y17_a_stop_cancels_the_switch_unless_the_tick_is_already_running() {
    let stop_first = queued_result(Queued::StopThenTick);
    assert_eq!(stop_first, direct_result(true), "停止が先：取り消し");
    assert!(
        stop_first.0.contains("recovery_required")
            && stop_first.0.contains("利用者が音声を停止しました")
            && stop_first.0.contains("muted=true"),
        "停止が先は、切替を取り消して子を終了する: {}",
        stop_first.0
    );
    let tick_running = queued_result(Queued::StopWhileTickRuns);
    assert_eq!(
        tick_running,
        direct_result(false),
        "走っている tick が先：確定の後に通常の停止"
    );
    assert!(
        tick_running.0.contains("status=None")
            && !tick_running.0.contains("利用者が音声を停止しました"),
        "走っている tick は、切替が確定する: {}",
        tick_running.0
    );
    assert_ne!(stop_first.0, tick_running.0);
    assert_eq!(
        queued_result(Queued::TickThenStop),
        stop_first,
        "列の順が[tick, stop]でも、停止の列が先に実行される"
    );
}

// 異常終了の共通の準備：実行のスレッドを止めておき、`QueueLockHeld`で panic させる準備をする。
struct Abnormal {
    control: AudioControl,
    armed: Arc<AtomicBool>,
    hold: Hold,
}

fn abnormal(control: AudioControl, point: ActorPoint) -> Abnormal {
    let armed = arm(&control, point);
    let hold = hold(&control);
    Abnormal {
        control,
        armed,
        hold,
    }
}

impl Abnormal {
    fn trigger(self) -> AudioControl {
        self.armed.store(true, Ordering::SeqCst);
        self.hold.release();
        self.control
    }
}

fn spawn_run(
    control: &AudioControl,
    name: &'static str,
) -> std::thread::JoinHandle<Result<(), ControlError>> {
    let waiting = control.clone();
    std::thread::spawn(move || waiting.run(cmd(name), |_| ()))
}

fn join_within(
    handle: std::thread::JoinHandle<Result<(), ControlError>>,
) -> Result<(), ControlError> {
    wait_until("the waiting run returns", || handle.is_finished());
    handle.join().unwrap()
}

fn assert_stopped_for_good(control: &AudioControl) {
    assert_eq!(control.run(cmd("late"), |_| ()), Err(ControlError::Stopped));
    assert_eq!(
        control.post(cmd("late"), |_| ()),
        Err(ControlError::Stopped)
    );
}

// X14 (a)：列のロックを持つ間の panic（ロックが poison する）でも、待っていた`run`はすべて`Stopped`で戻る。
#[test]
fn x14a_a_panic_while_the_queue_lock_is_held_releases_every_waiting_run_and_post() {
    let scenario = abnormal(control(), ActorPoint::QueueLockHeld);
    let control = scenario.control.clone();
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let first = spawn_run(&control, "r1");
    wait_len(&control, 1);
    control.post(cmd("p1"), record_into(&log, "p1")).unwrap();
    let second = spawn_run(&control, "r2");
    wait_len(&control, 3);
    let control = scenario.trigger();
    assert_eq!(join_within(first), Err(ControlError::Stopped));
    assert_eq!(join_within(second), Err(ControlError::Stopped));
    wait_until("the post closure is called", || {
        !log.lock().unwrap().is_empty()
    });
    assert_eq!(*log.lock().unwrap(), ["p1:Stopped"]);
    assert_stopped_for_good(&control);
}

// X14 (b)：`post`の失敗の通知を門で止めても、待つ`run`は先に解放される。通知が panic しても、残りの`post`は呼ばれる。
#[test]
fn x14b_a_blocked_or_panicking_post_notice_never_holds_back_a_waiting_run() {
    let scenario = abnormal(control(), ActorPoint::QueueLockHeld);
    let control = scenario.control.clone();
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    control
        .post(cmd("blocked"), move |_| {
            let _ = entered_tx.send(());
            let _ = release_rx.recv_timeout(GATE);
        })
        .unwrap();
    control
        .post(cmd("panics"), |_| panic!("the failure notice panicked"))
        .unwrap();
    control
        .post(cmd("after"), record_into(&log, "after"))
        .unwrap();
    let waiting = spawn_run(&control, "r1");
    wait_len(&control, 4);
    let control = scenario.trigger();
    entered_rx
        .recv_timeout(GATE)
        .expect("失敗の通知が呼ばれなかった");
    assert_eq!(
        join_within(waiting),
        Err(ControlError::Stopped),
        "通知が止まっていても、待つ run は解放される"
    );
    release_tx.send(()).unwrap();
    wait_until("the remaining post is called", || {
        !log.lock().unwrap().is_empty()
    });
    assert_eq!(*log.lock().unwrap(), ["after:Stopped"]);
    assert_stopped_for_good(&control);
}

// X14 (c)：取り込み値の`Drop`が panic しても（`run`・`post`の両方）、残りは解放され、プロセスは abort しない。
#[test]
fn x14c_a_panicking_captured_drop_does_not_stop_the_rest_of_the_drain() {
    let scenario = abnormal(control(), ActorPoint::QueueLockHeld);
    let control = scenario.control.clone();
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let guard = panic_on_drop();
    let run_control = control.clone();
    let run_with_guard =
        std::thread::spawn(move || run_control.run(cmd("r-guard"), move |_| drop(guard)));
    wait_len(&control, 1);
    let guard = panic_on_drop();
    let post_log = log.clone();
    control
        .post(cmd("p-guard"), move |host| {
            let _keep = guard;
            post_log
                .lock()
                .unwrap()
                .push(format!("p-guard:{}", host.is_ok()));
        })
        .unwrap();
    control.post(cmd("p3"), record_into(&log, "p3")).unwrap();
    let last = spawn_run(&control, "r2");
    wait_len(&control, 4);
    let control = scenario.trigger();
    assert_eq!(join_within(run_with_guard), Err(ControlError::Stopped));
    assert_eq!(join_within(last), Err(ControlError::Stopped));
    wait_until("the posts are called", || log.lock().unwrap().len() >= 2);
    assert_eq!(*log.lock().unwrap(), ["p-guard:false", "p3:Stopped"]);
    assert_stopped_for_good(&control);
}

// X14 (d)：`AudioHost::drop`を門で止めても、待つ`run`は先に解放される。`Drop`が panic しても abort しない。
#[test]
fn x14d_the_host_drop_runs_after_the_drain_and_a_panicking_drop_does_not_abort() {
    for panics in [false, true] {
        let mut host = plain_host();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (entered_tx, release_rx) = (Mutex::new(entered_tx), Mutex::new(release_rx));
        host.drop_seam = Some(Arc::new(move || {
            let _ = entered_tx.lock().unwrap().send(());
            let _ = release_rx.lock().unwrap().recv_timeout(GATE);
            if panics {
                panic!("the host drop panicked");
            }
        }));
        let scenario = abnormal(AudioControl::new(host), ActorPoint::QueueLockHeld);
        let control = scenario.control.clone();
        let waiting = spawn_run(&control, "r1");
        wait_len(&control, 1);
        let control = scenario.trigger();
        entered_rx
            .recv_timeout(GATE)
            .expect("ホストの破棄が始まらなかった");
        assert_eq!(
            join_within(waiting),
            Err(ControlError::Stopped),
            "ホストの破棄が止まっていても、待つ run は先に解放される"
        );
        release_tx.send(()).unwrap();
        assert_stopped_for_good(&control);
        drop(control);
    }
}

// X14 (e)：取り込み値の`Drop`を止めても、返事の送信端は先に落ちて`run`が戻る。
#[test]
fn x14e_a_blocked_captured_drop_does_not_hold_back_the_waiting_run() {
    let scenario = abnormal(control(), ActorPoint::QueueLockHeld);
    let control = scenario.control.clone();
    let (guard, entered, release) = gated_drop();
    let run_control = control.clone();
    let waiting = std::thread::spawn(move || run_control.run(cmd("r-guard"), move |_| drop(guard)));
    wait_len(&control, 1);
    let control = scenario.trigger();
    entered
        .recv_timeout(GATE)
        .expect("取り込み値の Drop が呼ばれなかった");
    assert_eq!(
        join_within(waiting),
        Err(ControlError::Stopped),
        "取り込み値の Drop が止まっていても、run は戻る"
    );
    release.send(()).unwrap();
    assert_stopped_for_good(&control);
}

// X14 (f)：取り出し直後（`current`に置いた後）の panic でも、取り出し済みの仕事と列の残りの待ち手が解放される。
#[test]
fn x14f_a_panic_right_after_taking_a_job_releases_the_taken_job_and_the_rest() {
    let scenario = abnormal(control(), ActorPoint::AfterTake);
    let control = scenario.control.clone();
    let (guard, entered, release) = gated_drop();
    let taken_control = control.clone();
    let taken = std::thread::spawn(move || taken_control.run(cmd("taken"), move |_| drop(guard)));
    wait_len(&control, 1);
    let rest = spawn_run(&control, "rest");
    wait_len(&control, 2);
    let control = scenario.trigger();
    entered
        .recv_timeout(GATE)
        .expect("取り出した仕事が回収されなかった");
    assert_eq!(
        join_within(rest),
        Err(ControlError::Stopped),
        "取り込み値の Drop が止まっていても、列に残る待ち手は解放される"
    );
    assert_eq!(join_within(taken), Err(ControlError::Stopped));
    release.send(()).unwrap();
    assert_stopped_for_good(&control);
}
