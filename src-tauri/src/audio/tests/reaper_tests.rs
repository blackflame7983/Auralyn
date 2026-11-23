//! 終了を確かめられない子の監視（reaper）と、窓の間の列の中の保留の試験。
//! 設計は docs/plans/audio-session-f1b0b-design.md の13章（Z1〜Z26）。待ちは門と実時間の短い窓で、時間切れは失敗の上限。
use super::class_tests::{production_source, src};
use super::compat_support::{scripted_parts, spawn_idle_process, Observer, ProcessProbe};
use super::control::{
    ActorPoint, AudioControl, ControlError, Entry, EntryKind, Launch, Phase, RunAsyncError,
};
use super::engine_life::{self, seam, EngineUnconfirmed, Mode, Role, Timing};
use super::link::CloseCause;
use super::queue_support::{
    cmd, entries, join, log, normal, phases, record_into, stop_entry, wait_until, Log, GATE, WAIT,
};
use super::reaper_seam;
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Store = engine_life::Store;

fn timing(deadline: Duration) -> Timing {
    Timing {
        deadline,
        retry_kill: Duration::from_secs(3600),
        rescan: Duration::from_millis(50),
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

/// 終わらない子の記録。実の子を記録へ置き、監視の台本は「終わりを観測しない」。
#[derive(Clone)]
struct Stuck {
    id: u64,
    probe: Arc<ProcessProbe>,
    script: Arc<engine_life::Script>,
}

impl Stuck {
    /// 子を終わらせ、監視に実際の子を確かめさせる。
    fn end(&self) {
        self.probe.terminate();
        self.script.set(Mode::Released);
    }

    /// 子を終わらせ、終わったことが確かめられるまで待つ。
    fn kill_now(&self) {
        self.probe.terminate();
        assert!(self.probe.wait_exit(5000), "子が終わらなかった");
    }
}

fn stick(store: &Arc<Store>, role: Role) -> Stuck {
    let child = spawn_idle_process();
    let probe = Arc::new(ProcessProbe::open(child.id()).expect("子のハンドルを開けた"));
    let script = engine_life::Script::new();
    let id = engine_life::adopt(store, role, child, None, Some(script.clone()));
    Stuck { id, probe, script }
}

/// 台本つきのホストを `AudioControl` の下に置き、窓を縮めた試験の台。
struct Rig {
    control: AudioControl,
    store: Arc<Store>,
    observer: Observer,
    kept: Mutex<Vec<Stuck>>,
}

impl Rig {
    fn new(deadline: Duration) -> Self {
        let (host, observer) = scripted_parts([]);
        let store = host.retired.clone();
        store.set_timing(timing(deadline));
        Self {
            control: AudioControl::new(host),
            store,
            observer,
            kept: Mutex::default(),
        }
    }

    fn stick(&self, role: Role) -> Stuck {
        let stuck = stick(&self.store, role);
        self.kept.lock().unwrap().push(stuck.clone());
        stuck
    }

    fn started(&self, name: &str) -> bool {
        phases(&self.control, name).contains(&Phase::Started)
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        for stuck in self.kept.lock().unwrap().iter() {
            stuck.end();
        }
        let _ = std::fs::remove_dir_all(&self.observer.dir);
    }
}

fn unconfirmed(error: &anyhow::Error) -> Option<EngineUnconfirmed> {
    error.downcast_ref::<EngineUnconfirmed>().copied()
}

fn push_into(log: &Log, text: impl Into<String>) {
    log.lock().unwrap().push(text.into());
}

/// 起動を試みる `post` の閉包。結果を記録する。
fn launching(
    log: &Log,
    name: &'static str,
) -> impl FnOnce(Result<&mut AudioHost, ControlError>) + Send + 'static {
    let log = log.clone();
    move |host| match host {
        Ok(host) => push_into(
            &log,
            format!("{name}:{}", host.ensure_engine_running().is_ok()),
        ),
        Err(error) => push_into(&log, format!("{name}:{error:?}")),
    }
}

// Z1：終了を観測した reaper は、記録を消して列を起こす。実の子（OS の待ち）でも同じ。
#[test]
fn z1_the_reaper_removes_the_record_when_the_child_exits_and_rings_the_bell() {
    let store = Arc::new(Store::default());
    store.set_timing(timing(Duration::from_secs(30)));
    let rings = Arc::new(AtomicUsize::new(0));
    let counter = rings.clone();
    store.bell().register(Box::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    let stuck = stick(&store, Role::Primary);
    assert_eq!(store.pending(Role::Primary), 1);
    let before = rings.load(Ordering::SeqCst);
    stuck.end();
    wait_until("the record is removed", || {
        store.pending(Role::Primary) == 0
    });
    assert!(
        rings.load(Ordering::SeqCst) > before,
        "消した後に列を起こす"
    );
    assert!(store.counts(Role::Primary).is_empty());
    assert_eq!(store.held_drops(), 0, "ロックを持ったまま落とさない");
}

// Z1b：台本ではない経路（実の子を確かめる監視）。外から終わらせると、reaper が観測して消す。
#[test]
fn z1b_a_real_child_is_observed_by_the_default_watch() {
    let store = Arc::new(Store::default());
    let child = spawn_idle_process();
    let probe = ProcessProbe::open(child.id()).unwrap();
    engine_life::adopt(&store, Role::Primary, child, None, None);
    assert_eq!(store.pending(Role::Primary), 1);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(store.pending(Role::Primary), 1, "生きている間は消さない");
    probe.terminate();
    wait_until("the watch notices the exit", || {
        store.pending(Role::Primary) == 0
    });
    assert_eq!(store.held_drops(), 0);
}

// Z2：期限の前だけ、一定の間隔で kill をやり直す。期限の後は送らず、待ち続け、解放すると消える。
#[test]
fn z2_the_reaper_retries_the_kill_before_the_deadline_and_not_after() {
    let store = Arc::new(Store::default());
    store.set_timing(Timing {
        deadline: Duration::from_millis(700),
        retry_kill: Duration::from_millis(200),
        rescan: Duration::from_millis(50),
    });
    let stuck = stick(&store, Role::Primary);
    wait_until("the kill is retried", || store.kills() >= 2);
    std::thread::sleep(Duration::from_millis(900));
    let after_deadline = store.kills();
    assert!(
        after_deadline <= 4,
        "期限の前に限って送る: {after_deadline}"
    );
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(store.kills(), after_deadline, "期限の後は送らない");
    assert_eq!(store.pending(Role::Primary), 1, "期限の後も待ち続ける");
    stuck.script.set(Mode::Released);
    wait_until("the record is removed after release", || {
        store.pending(Role::Primary) == 0
    });
}

// Z3：監視は、記録が先に消えるか Store が無くなれば終わる。待機中は Store への強い参照を持たない。join しない。
#[test]
fn z3_a_reaper_ends_when_its_record_is_gone_or_the_store_is_dropped_and_holds_no_strong_reference_while_waiting(
) {
    let store = Arc::new(Store::default());
    store.set_timing(timing(Duration::from_secs(30)));
    let threads = store.reaper_counter();
    let first = stick(&store, Role::Primary);
    let second = stick(&store, Role::PostMix);
    let third = stick(&store, Role::Primary);
    wait_until("three watches run", || threads.load(Ordering::SeqCst) == 3);
    first.kill_now();
    second.kill_now();
    store.ensure_clear(Role::Primary).unwrap_err();
    store.recheck().unwrap_err();
    wait_until("the removed records end their watches", || {
        threads.load(Ordering::SeqCst) == 1
    });
    for (mut child, _) in store.drain() {
        let _ = child.kill();
        let _ = child.wait();
    }
    wait_until("drain ends the last watch", || {
        threads.load(Ordering::SeqCst) == 0
    });
    let _ = third;

    let store = Arc::new(Store::default());
    store.set_timing(timing(Duration::from_secs(30)));
    let threads = store.reaper_counter();
    let kept = [stick(&store, Role::Primary), stick(&store, Role::Primary)];
    wait_until("two watches run", || threads.load(Ordering::SeqCst) == 2);
    let weak = Arc::downgrade(&store);
    let started = Instant::now();
    drop(store);
    assert!(started.elapsed() < Duration::from_secs(1), "join しない");
    wait_until("the store is released while the watches wait", || {
        weak.strong_count() == 0
    });
    wait_until("both watches end", || threads.load(Ordering::SeqCst) == 0);
    for stuck in &kept {
        stuck.probe.terminate();
    }
}

// Z4：終わらない子は記録に残り、誰も止めない。窓の後は保留されず、3回で案内が変わる。ホストの drop も戻る。
#[test]
fn z4_a_child_that_never_exits_keeps_its_record_and_blocks_nobody() {
    let rig = Rig::new(Duration::from_millis(400));
    rig.stick(Role::Primary);
    let threads = rig.store.reaper_counter();
    let started = Instant::now();
    let first = rig
        .control
        .run(cmd("load_plugin"), |host| host.ensure_engine_running())
        .unwrap()
        .unwrap_err();
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "窓の間は保留される"
    );
    assert_eq!(
        unconfirmed(&first),
        Some(EngineUnconfirmed { repeated: false })
    );
    assert_eq!(rig.store.counts(Role::Primary), [1]);
    assert_eq!(rig.observer.spawn_count(), 0);
    let started = Instant::now();
    let second = rig
        .control
        .run(cmd("load_plugin"), |host| host.ensure_engine_running())
        .unwrap()
        .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "窓の後は保留されない"
    );
    assert!(!unconfirmed(&second).unwrap().repeated);
    assert_eq!(rig.store.counts(Role::Primary), [2]);
    let third = rig
        .control
        .run(cmd("load_plugin"), |host| host.ensure_engine_running())
        .unwrap()
        .unwrap_err();
    assert!(unconfirmed(&third).unwrap().repeated, "J-13：3回目の案内");
    let started = Instant::now();
    drop(rig);
    assert!(started.elapsed() < Duration::from_secs(5));
    wait_until("the watch ends", || threads.load(Ordering::SeqCst) == 0);
}

// Z5：窓の間、起動しうる仕事は保留され、Launch::None の入口・Stop・記録・note は実行のスレッドで進む。
#[test]
fn z5_other_entries_proceed_on_the_actor_while_launching_jobs_are_held() {
    let rig = Rig::new(Duration::from_millis(2500));
    let stuck = rig.stick(Role::Primary);
    let control = &rig.control;
    let log = log();
    let held = [
        ("load_plugin", "starting"),
        ("get_round_trip_measurement", "normal"),
        ("stop_test_tone", "release"),
        ("set_global_mute", "mute"),
        ("mute_toggle", "tray"),
    ];
    control
        .post(cmd("load_plugin"), record_into(&log, "starting"))
        .unwrap();
    control
        .post(
            cmd("get_round_trip_measurement"),
            record_into(&log, "normal"),
        )
        .unwrap();
    control
        .post(cmd("stop_test_tone"), record_into(&log, "release"))
        .unwrap();
    control
        .post(cmd("set_global_mute"), record_into(&log, "mute"))
        .unwrap();
    control
        .post(
            Entry::new(EntryKind::Tray, "mute_toggle"),
            record_into(&log, "tray"),
        )
        .unwrap();
    let started = Instant::now();
    assert_eq!(
        control.run(normal(), |_| 7).unwrap(),
        7,
        "Launch::None は進む"
    );
    control.note(cmd("quit_app"));
    assert!(!control.admission().records().is_empty());
    std::thread::sleep(WAIT);
    assert!(entries(&log).is_empty(), "保留中の仕事は実行されない");
    for (name, _) in held {
        assert_eq!(phases(control, name), [Phase::Accepted], "{name}");
    }
    control.run(stop_entry(), |_| ()).unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "Stop は待たされない"
    );
    wait_until("the held start is refused", || {
        entries(&log) == ["starting:StoppedFirst"]
    });
    for name in [
        "get_round_trip_measurement",
        "stop_test_tone",
        "set_global_mute",
        "mute_toggle",
    ] {
        assert_eq!(phases(control, name), [Phase::Accepted], "{name}");
    }
    stuck.end();
    wait_until("the held jobs run after the window", || {
        entries(&log).len() == 5
    });
    let log = entries(&log);
    for expected in ["normal:ok", "release:ok", "mute:ok", "tray:ok"] {
        assert!(log.iter().any(|entry| entry == expected), "{expected}");
    }
}

// Z6：実行のスレッドが待機中で、窓が開いている間に子が終わると、窓の期限より前に保留が解け、子を作れる。
#[test]
fn z6_a_held_job_runs_when_the_child_exits_while_the_window_is_still_open_even_if_the_actor_was_idle(
) {
    let rig = Rig::new(Duration::from_secs(5));
    let stuck = rig.stick(Role::Primary);
    let log = log();
    rig.control
        .post(cmd("load_plugin"), launching(&log, "a"))
        .unwrap();
    rig.control
        .post(cmd("set_bypass"), launching(&log, "b"))
        .unwrap();
    std::thread::sleep(WAIT);
    assert!(entries(&log).is_empty());
    let ended = Instant::now();
    stuck.end();
    wait_until("both held jobs run", || entries(&log).len() == 2);
    assert!(
        ended.elapsed() < Duration::from_secs(2),
        "窓の期限（5秒）より前に進む"
    );
    assert_eq!(entries(&log), ["a:true", "b:true"]);
    assert!(rig.observer.spawn_count() >= 1);
    assert_eq!(rig.store.pending(Role::Primary), 0, "数も消える");
}

// Z7：窓の起点は最初の kill。途中で受け付けた仕事は、残りだけ保留される。窓の後の要求は保留されない。
#[test]
fn z7_a_held_job_is_released_at_the_deadline_measured_from_the_first_kill() {
    let rig = Rig::new(Duration::from_millis(1000));
    rig.stick(Role::Primary);
    std::thread::sleep(Duration::from_millis(700));
    let posted = Instant::now();
    let (tx, rx) = std::sync::mpsc::channel();
    let report = tx.clone();
    rig.control
        .post(cmd("load_plugin"), move |host| {
            let result = host.map(|host| host.ensure_engine_running());
            let _ = report.send((posted.elapsed(), result.is_ok()));
        })
        .unwrap();
    let (elapsed, ran) = rx.recv_timeout(GATE).unwrap();
    assert!(ran);
    assert!(
        elapsed >= Duration::from_millis(150),
        "残りは保留される: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_millis(800),
        "窓の7割が過ぎた時点からは数え直さない: {elapsed:?}"
    );
    assert_eq!(rig.store.counts(Role::Primary), [1]);
    let started = Instant::now();
    let error = rig
        .control
        .run(cmd("load_plugin"), |host| host.ensure_engine_running())
        .unwrap()
        .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "窓の後は保留されない"
    );
    assert!(unconfirmed(&error).is_some());
    assert_eq!(rig.store.counts(Role::Primary), [2]);
}

// Z8：保留中に Stop が届くと、Stop が先に実行され、保留中の Starting は StoppedFirst で断られる。Mute は断らない。
#[test]
fn z8_a_stop_during_the_hold_refuses_the_held_start_with_stopped_first_and_runs_first() {
    let rig = Rig::new(Duration::from_millis(2500));
    let stuck = rig.stick(Role::Primary);
    let control = &rig.control;
    let log = log();
    control
        .post(cmd("set_global_mute"), record_into(&log, "mute"))
        .unwrap();
    control
        .post(cmd("load_plugin"), record_into(&log, "before"))
        .unwrap();
    control
        .post(
            cmd("get_round_trip_measurement"),
            record_into(&log, "normal"),
        )
        .unwrap();
    let before_stop = control.counted();
    assert_eq!(before_stop, 2);
    let stop = control.run(stop_entry(), |_| ());
    assert_eq!(stop, Ok(()));
    wait_until("the held start is refused", || {
        entries(&log) == ["before:StoppedFirst"]
    });
    assert_eq!(
        phases(control, "load_plugin"),
        [Phase::Accepted, Phase::Refused]
    );
    assert_eq!(
        control.counted(),
        1,
        "断られるのは Starting だけ。Normal は残る"
    );
    control
        .post(cmd("set_bypass"), record_into(&log, "after"))
        .unwrap();
    std::thread::sleep(WAIT);
    assert_eq!(
        entries(&log),
        ["before:StoppedFirst"],
        "Mute・Normal は断られず、後の Starting は窓まで保留される"
    );
    stuck.end();
    wait_until("the rest run after the window", || entries(&log).len() == 4);
    let log = entries(&log);
    for expected in ["mute:ok", "normal:ok", "after:ok"] {
        assert!(log.contains(&expected.to_owned()), "{expected}");
    }
}

// Z9：列が閉じても、実行のスレッドが異常終了しても、保留中の仕事はすべて窓の期限より前に Stopped で解放される。
#[test]
fn z9_a_closed_queue_or_an_aborted_actor_releases_every_held_job_while_the_window_is_open() {
    for abort in [false, true] {
        let rig = Rig::new(Duration::from_secs(5));
        rig.stick(Role::Primary);
        let control = rig.control.clone();
        let log = log();
        let sync_control = control.clone();
        let sync = std::thread::spawn(move || sync_control.run(cmd("load_plugin"), |_| ()));
        let runtime = runtime();
        let async_control = control.clone();
        let asynchronous =
            runtime.spawn(async move { async_control.run_async(cmd("set_bypass"), |_| ()).await });
        control
            .post(cmd("set_mute"), launching(&log, "post"))
            .unwrap();
        wait_until("three jobs are held", || control.queue_len() == 3);
        let started = Instant::now();
        if abort {
            let armed = Arc::new(AtomicBool::new(false));
            let flag = armed.clone();
            control.set_actor_seam(Arc::new(move |point| {
                if point == ActorPoint::QueueLockHeld && flag.load(Ordering::SeqCst) {
                    panic!("the actor aborts");
                }
            }));
            armed.store(true, Ordering::SeqCst);
            rig.store.ring();
        } else {
            control.close_for_test();
        }
        assert_eq!(join("the sync run", sync), Err(ControlError::Stopped));
        let result = runtime.block_on(asynchronous).unwrap();
        assert_eq!(result, Err(RunAsyncError::Control(ControlError::Stopped)));
        wait_until("the post closure is called once", || {
            entries(&log).len() == 1
        });
        assert_eq!(entries(&log), ["post:Stopped"]);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "窓の期限（5秒）より前に解放される"
        );
    }
}

// Z10：保留中の仕事も数える（256件の上限）。Starting・Normal は受付から60秒で断られ、Release・Mute は断られない。
#[test]
fn z10_held_jobs_count_toward_the_256_and_expire_and_release_never_refuses() {
    let rig = Rig::new(Duration::from_millis(2500));
    let stuck = rig.stick(Role::Primary);
    let control = &rig.control;
    control.set_limits(
        3,
        Duration::from_millis(400),
        Duration::from_secs(3600),
        Duration::from_secs(3600),
    );
    let log = log();
    control
        .post(cmd("load_plugin"), record_into(&log, "s1"))
        .unwrap();
    control
        .post(cmd("get_round_trip_measurement"), record_into(&log, "n1"))
        .unwrap();
    control
        .post(cmd("set_bypass"), record_into(&log, "s2"))
        .unwrap();
    assert_eq!(control.counted(), 3);
    assert_eq!(
        control.post(cmd("set_mute"), record_into(&log, "busy")),
        Err(ControlError::Busy),
        "保留も数える"
    );
    control
        .post(cmd("stop_test_tone"), record_into(&log, "release"))
        .unwrap();
    control
        .post(cmd("set_global_mute"), record_into(&log, "mute"))
        .unwrap();
    wait_until("the held starting and normal expire", || {
        entries(&log)
            .iter()
            .filter(|entry| entry.ends_with("Expired"))
            .count()
            == 3
    });
    assert_eq!(control.counted(), 0);
    let log_now = entries(&log);
    assert!(!log_now
        .iter()
        .any(|entry| entry.starts_with("release") || entry.starts_with("mute")));
    stuck.end();
    wait_until("release and mute run after the window", || {
        entries(&log).len() == 5
    });
    let log = entries(&log);
    assert!(log.contains(&"release:ok".to_owned()) && log.contains(&"mute:ok".to_owned()));
}

// Z11：トレイ・ショートカットの post も列の中で保留される。待たずに戻り、窓が閉じれば実行される。
#[test]
fn z11_a_post_is_held_in_the_queue_like_any_launching_job_and_runs_after_the_window() {
    let rig = Rig::new(Duration::from_secs(5));
    let stuck = rig.stick(Role::Primary);
    let log = log();
    let started = Instant::now();
    rig.control
        .post(
            Entry::new(EntryKind::Tray, "mute_toggle"),
            launching(&log, "tray"),
        )
        .unwrap();
    rig.control
        .post(
            Entry::new(EntryKind::Shortcut, "global_shortcut"),
            launching(&log, "shortcut"),
        )
        .unwrap();
    rig.control
        .post(normal(), record_into(&log, "state"))
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "post は待たずに戻る"
    );
    wait_until("the unrelated entry runs", || entries(&log) == ["state:ok"]);
    std::thread::sleep(WAIT);
    assert_eq!(entries(&log), ["state:ok"]);
    stuck.end();
    wait_until("the held posts run", || entries(&log).len() == 3);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(&entries(&log)[1..], ["tray:true", "shortcut:true"]);
}

// Z12：「確かめられなかった」の判定は、reaper が記録を消す速さに依らない。
#[test]
fn z12_the_unconfirmed_decision_does_not_depend_on_how_fast_the_reaper_clears() {
    // 応答の期限切れ。記録を置いた直後に、reaper が消し終えるまで呼び出し側を止める。
    let (mut host, observer) = scripted_parts([(
        "GetDevices",
        vec![super::compat_support::Step::WaitGate("never".into())],
    )]);
    host.ensure_engine_running().unwrap();
    super::writer::set_limits_for_test(None, Some(Duration::from_millis(400)));
    reaper_seam::stuck();
    let store = host.retired.clone();
    seam::on_stage(move |stage| {
        if matches!(stage, seam::Stage::Retired(Role::Primary)) {
            reaper_seam::set_mode(Mode::Released);
            wait_until("the reaper clears the record first", || {
                store.pending(Role::Primary) == 0
            });
        }
    });
    let error = host
        .execute_running_command(IpcCommand::GetDevices)
        .unwrap_err();
    super::writer::set_limits_for_test(None, None);
    reaper_seam::real();
    assert_eq!(
        unconfirmed(&error),
        Some(EngineUnconfirmed { repeated: false }),
        "reaper が先に消しても、別の意味に化けない: {error}"
    );
    assert_eq!(error.to_string(), engine_life::UNCONFIRMED_JA);
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);

    // 書き込みの期限切れ。
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    let gate = super::writer::sinks::Gated::default();
    host.replace_writer_for_test(super::writer::Writer::start(
        gate.clone(),
        host.link.clone(),
    ));
    super::writer::set_limits_for_test(Some(Duration::from_millis(200)), None);
    reaper_seam::stuck();
    let store = host.retired.clone();
    seam::on_stage(move |stage| {
        if matches!(stage, seam::Stage::Retired(Role::Primary)) {
            reaper_seam::set_mode(Mode::Released);
            wait_until("the reaper clears the record first", || {
                store.pending(Role::Primary) == 0
            });
        }
    });
    let error = host
        .execute_running_command(IpcCommand::GetDevices)
        .unwrap_err();
    gate.open();
    super::writer::set_limits_for_test(None, None);
    reaper_seam::real();
    assert_eq!(
        unconfirmed(&error),
        Some(EngineUnconfirmed { repeated: false }),
        "{error}"
    );
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// Z13：待っている間もロックは持たれず、4つの消す経路は id で消し、二重に落とさず、ロックの外で落とす。
#[test]
fn z13_no_wait_or_bell_happens_while_the_slots_lock_is_held_and_removals_do_not_double_drop() {
    let store = Arc::new(Store::default());
    store.set_timing(timing(Duration::from_millis(800)));
    let first = stick(&store, Role::Primary);
    let second = stick(&store, Role::Primary);
    store.finish(first.id);
    store.finish(first.id);
    assert_eq!(store.pending(Role::Primary), 1, "別の id の記録は残る");
    assert!(store.has(second.id) && !store.has(first.id));
    first.kill_now();

    // 閉包の中で作った記録を待つ間も、別のスレッドは記録を読み書きできる。
    let waiting = store.clone();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let _scope = waiting.begin_closure();
        let own = stick(&waiting, Role::PostMix);
        entered_tx.send(own.clone()).unwrap();
        let result = waiting.ensure_clear(Role::PostMix);
        (own, result)
    });
    let own = entered_rx.recv_timeout(GATE).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let started = Instant::now();
    assert_eq!(store.pending(Role::PostMix), 1);
    let _ = store.recheck();
    let third = stick(&store, Role::Primary);
    assert!(
        started.elapsed() < Duration::from_millis(300),
        "待ち手が slots を持たない"
    );
    let (_, result) = join("the waiter", waiter);
    assert!(result.is_err(), "窓を超えて終わらない");
    // 4つの経路が、ロックの外で落とす。
    for stuck in [&second, &third, &own] {
        stuck.kill_now();
    }
    store.ensure_clear(Role::Primary).ok();
    store.ensure_clear(Role::PostMix).ok();
    let spare = stick(&store, Role::Primary);
    spare.kill_now();
    store.recheck().ok();
    let unwatched = stick(&store, Role::Primary);
    store.mark_unwatched(unwatched.id);
    unwatched.kill_now();
    store.probe_unwatched();
    assert_eq!(
        store.pending(Role::Primary) + store.pending(Role::PostMix),
        0
    );
    assert_eq!(store.held_drops(), 0, "Child・Job は slots の外で落とす");

    // 消した4つの経路は、消した後に列を起こす。
    let store = Arc::new(Store::default());
    let rings = Arc::new(AtomicUsize::new(0));
    let counter = rings.clone();
    store.bell().register(Box::new(move || {
        counter.fetch_add(1, Ordering::SeqCst);
    }));
    for path in ["ensure_clear", "recheck", "probe_unwatched", "finish"] {
        let stuck = stick(&store, Role::Primary);
        stuck.kill_now();
        let before = rings.load(Ordering::SeqCst);
        match path {
            "ensure_clear" => store.ensure_clear(Role::Primary).unwrap(),
            "recheck" => store.recheck().unwrap(),
            "probe_unwatched" => {
                store.mark_unwatched(stuck.id);
                store.probe_unwatched();
            }
            _ => store.finish(stuck.id),
        }
        assert_eq!(store.pending(Role::Primary), 0, "{path}");
        assert!(
            rings.load(Ordering::SeqCst) > before,
            "{path} は消した後に列を起こす"
        );
    }

    let text = production_source(&src().join("audio/engine_life.rs"));
    for name in ["pub(super) fn finish", "fn take"] {
        let start = text.find(name).unwrap();
        let body = &text[start..start + text[start..].find("\n    }\n").unwrap()];
        for forbidden in ["sleep(", ".wait(", ".recv("] {
            assert!(!body.contains(forbidden), "{name} が {forbidden} を呼ぶ");
        }
    }
}

// Z14：保留を決めるのは、仕事が起動する役割の窓だけ。別の役割の窓では足止めされない。
#[test]
fn z14_a_job_is_held_only_by_the_window_of_the_role_it_launches() {
    let rig = Rig::new(Duration::from_millis(2500));
    let stuck = rig.stick(Role::PostMix);
    let log = log();
    rig.control
        .post(
            cmd("post_mix").launch(Launch::PostMix),
            launching(&log, "post_mix"),
        )
        .unwrap();
    rig.control
        .post(cmd("load_plugin"), launching(&log, "primary"))
        .unwrap();
    rig.control
        .post(cmd("start_audio"), launching(&log, "both"))
        .unwrap();
    wait_until("the primary-only job runs", || {
        entries(&log).contains(&"primary:true".to_owned())
    });
    std::thread::sleep(WAIT);
    assert_eq!(
        entries(&log),
        ["primary:true"],
        "配信ミックスの窓は、主だけを起動する仕事を止めない"
    );
    stuck.end();
    wait_until("the others run after the window", || {
        entries(&log).len() == 3
    });
    assert_eq!(&entries(&log)[1..], ["post_mix:true", "both:true"]);
}

// Z15：reaper が死んでも、失敗し続けても、生成できなくても、誰も固まらず、監視されない記録も保留の対象のまま。
#[test]
fn z15_a_dead_or_failing_reaper_never_hangs_a_held_job_or_the_actor_and_an_unwatched_record_is_still_held(
) {
    for how in ["panics", "fails", "no_thread"] {
        let rig = Rig::new(Duration::from_secs(4));
        if how == "no_thread" {
            seam::set_spawn_fails(true);
        }
        let stuck = rig.stick(Role::Primary);
        seam::set_spawn_fails(false);
        let log = log();
        rig.control
            .post(cmd("load_plugin"), launching(&log, "held"))
            .unwrap();
        std::thread::sleep(WAIT);
        match how {
            "panics" => stuck.script.set(Mode::Panics),
            "fails" => stuck.script.set(Mode::Failing),
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(400));
        assert!(
            entries(&log).is_empty(),
            "{how}: 子が終わるまで保留は解けない"
        );
        assert!(!rig.started("load_plugin"), "{how}");
        let ended = Instant::now();
        stuck.probe.terminate();
        wait_until("the held job runs after the child ends", || {
            entries(&log) == ["held:true"]
        });
        assert!(
            ended.elapsed() < Duration::from_secs(2),
            "{how}: 監視されない記録を実行のスレッドが確かめ、窓の期限（4秒）より前に進む"
        );
    }
}

// Z16：どの順に積まれても、両方の列で受付の番号の順に実行する。
#[test]
fn z16_queued_jobs_run_in_acceptance_order_in_both_lanes_whatever_order_things_arrive_in() {
    let control = super::queue_support::control();
    let hold = super::queue_support::hold(&control);
    let log = log();
    let (a, b, c) = (
        control.admit(cmd("load_plugin")),
        control.admit(cmd("set_bypass")),
        control.admit(cmd("set_mute")),
    );
    let (m1, m2) = (
        control.admit(cmd("set_global_mute")),
        control.admit(cmd("toggle_global_mute")),
    );
    c.post(record_into(&log, "c")).unwrap();
    a.post(record_into(&log, "a")).unwrap();
    b.post(record_into(&log, "b")).unwrap();
    m2.post(record_into(&log, "m2")).unwrap();
    m1.post(record_into(&log, "m1")).unwrap();
    hold.release();
    wait_until("all five run", || entries(&log).len() == 5);
    assert_eq!(
        entries(&log),
        ["m1:ok", "m2:ok", "a:ok", "b:ok", "c:ok"],
        "停止の列が先で、どちらも受付の番号の順"
    );

    // Stop が Mute より後に受け付けられたら、Mute の後（受付の順）。
    let control = super::queue_support::control();
    let hold = super::queue_support::hold(&control);
    let stop_log = super::queue_support::log();
    let (first, stop, second) = (
        control.admit(cmd("set_global_mute")),
        control.admit(stop_entry()),
        control.admit(cmd("toggle_global_mute")),
    );
    second.post(record_into(&stop_log, "m2")).unwrap();
    stop.post(record_into(&stop_log, "stop")).unwrap();
    first.post(record_into(&stop_log, "m1")).unwrap();
    hold.release();
    wait_until("all three run", || entries(&stop_log).len() == 3);
    assert_eq!(entries(&stop_log), ["m1:ok", "stop:ok", "m2:ok"]);
}

// Z17：本番の時間・網羅の match・表の一致・reaper が Child・Job を持たないこと。
#[test]
fn z17_the_production_timing_and_the_structure_are_fixed() {
    assert_eq!(Timing::default().deadline, Duration::from_secs(10));
    assert_eq!(Timing::default().retry_kill, Duration::from_secs(2));
    assert_eq!(engine_life::REPEAT_AT, 3);
    assert_eq!(engine_life::CONFIRM, Duration::from_secs(2));

    let class = production_source(&src().join("audio/control/class.rs"));
    let start = class.find("impl Launch {").unwrap();
    let end = class[start..].find("\n}\n").unwrap() + start;
    let methods = &class[start..end];
    assert_eq!(methods.matches("match self").count(), 1);
    assert!(
        !methods.contains("_ =>"),
        "網羅の match に `_ =>` を使わない"
    );
    for file in ["audio/control/queue.rs", "audio/control/actor.rs"] {
        let text = production_source(&src().join(file));
        assert!(
            !text.contains("Launch::"),
            "{file} が起動しうる役割を直接見ている。判定は Launch::roles だけで行う"
        );
    }

    let names: std::collections::BTreeSet<_> = super::control::NAME_LAUNCH
        .iter()
        .map(|(name, _)| *name)
        .collect();
    assert_eq!(
        names.len(),
        super::control::NAME_LAUNCH.len(),
        "名前が2回ある"
    );
    let classes: std::collections::BTreeSet<_> = super::control::NAME_CLASSES
        .iter()
        .map(|(name, _)| *name)
        .collect();
    assert_eq!(
        names, classes,
        "NAME_LAUNCH と NAME_CLASSES が同じ名前の集合"
    );
    for entry in super::control::REQUEST_ENTRIES {
        assert!(
            super::control::REQUEST_LAUNCH_DEFAULT
                .iter()
                .any(|(name, _)| name == entry),
            "{entry} の既定が REQUEST_LAUNCH_DEFAULT に無い"
        );
    }
    for (entry, variant, _) in super::control::REQUEST_LAUNCH {
        assert!(
            super::control::REQUEST_CLASSES
                .iter()
                .any(|row| row.entry == *entry && row.variant == *variant),
            "REQUEST_LAUNCH の {entry}({variant}) が要求の表に無い（古い）"
        );
    }
    assert_eq!(
        super::control::launch_of(Entry::command("a_name_nobody_registered")),
        Launch::Both
    );
    assert_eq!(
        super::control::launch_of(Entry::new(EntryKind::Scheduler, "anything")),
        Launch::None
    );
    for name in [
        "start_audio",
        "restart_audio_engine",
        "load_plugin",
        "set_bypass",
        "set_global_mute",
        "toggle_global_mute",
        "mute_toggle",
        "enumerate_devices_async",
        "probe_loopback",
        "auto_gain",
        "set_output_gain",
        "start_voice_check",
        "apply_profile",
        "apply_owned",
        "warmup",
        "global_shortcut",
        "play_test_tone",
        "get_round_trip_measurement",
    ] {
        assert_ne!(
            super::control::launch_of(Entry::command(name)),
            Launch::None,
            "{name} は子を起動しうる（ensure_engine_running・execute_command を通る）"
        );
    }
    for name in [
        "stop_audio",
        "get_audio_state",
        "prepare_update",
        "get_saved_audio_config",
    ] {
        assert_eq!(
            super::control::launch_of(Entry::command(name)),
            Launch::None,
            "{name}"
        );
    }

    let reaper = production_source(&src().join("audio/engine_life/reaper.rs"));
    let code: String = reaper
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["Child", "JobHandle", "process_job"] {
        assert!(!code.contains(forbidden), "reaper が {forbidden} を持つ");
    }
    let rig = Rig::new(Duration::from_secs(5));
    rig.stick(Role::Primary);
    let started = Instant::now();
    let lease = rig
        .control
        .lock(cmd("fixture_lease"))
        .expect("貸し出しは窓で待たない");
    drop(lease);
    assert!(started.elapsed() < Duration::from_secs(2));
}

// Z18：窓の後の J-13 の流れを `run_async` で通す。待っている間も、ほかの入口は止まらない。
#[test]
fn z18_a_gated_start_that_waited_behaves_like_the_old_in_lock_wait_end_to_end() {
    let rig = Rig::new(Duration::from_millis(500));
    rig.stick(Role::Primary);
    let runtime = runtime();
    let control = rig.control.clone();
    let result = runtime.block_on(async {
        let start = {
            let control = control.clone();
            tokio::spawn(async move {
                control
                    .run_async(cmd("load_plugin"), |host| {
                        host.ensure_engine_running()
                            .map_err(|error| error.to_string())
                    })
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!start.is_finished(), "窓の間は待っている");
        let read = control.run_async(normal(), |_| 1).await;
        assert_eq!(read, Ok(1), "ほかの入口は止まらない");
        let first = start.await.unwrap().unwrap().unwrap_err();
        let update = control
            .run_async(Entry::new(EntryKind::Update, "prepare_update"), |host| {
                host.prepare_update().map_err(|error| error.to_string())
            })
            .await
            .unwrap()
            .unwrap_err();
        let third = control
            .run_async(cmd("load_plugin"), |host| {
                host.ensure_engine_running()
                    .map_err(|error| error.to_string())
            })
            .await
            .unwrap()
            .unwrap_err();
        (first, update, third)
    });
    assert_eq!(result.0, engine_life::UNCONFIRMED_JA);
    assert_eq!(
        result.1,
        engine_life::UNCONFIRMED_JA,
        "更新の経路は生の文字列"
    );
    assert_eq!(result.2, engine_life::REPEATED_JA);
    assert_eq!(rig.observer.spawn_count(), 0);
}

// Z19：ブロッキングのプールが埋まっていても、Stop は列へ届く。保留・投入・結果の待ちがプールを使わない。
#[test]
fn z19_a_stop_reaches_the_queue_and_raises_the_fence_even_when_the_blocking_pool_is_saturated() {
    let rig = Rig::new(Duration::from_millis(1500));
    let stuck = rig.stick(Role::Primary);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let release = Arc::new(AtomicBool::new(false));
    for _ in 0..2 {
        let flag = release.clone();
        runtime.spawn_blocking(move || {
            while !flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        });
    }
    let control = rig.control.clone();
    runtime.block_on(async {
        let held = {
            let control = control.clone();
            tokio::spawn(async move { control.run_async(cmd("load_plugin"), |_| ()).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        let stop_seq_before = control.fence();
        let stopped = tokio::time::timeout(
            Duration::from_secs(2),
            control.run_async(stop_entry(), |_| ()),
        )
        .await
        .expect("Stop がプールの空きに依らず届く");
        assert_eq!(stopped, Ok(()));
        assert!(control.fence() > stop_seq_before);
        assert_eq!(
            held.await.unwrap(),
            Err(RunAsyncError::Control(ControlError::StoppedFirst))
        );
        // 窓が閉じた直後に、プールより多い数が一斉に取り出される。
        let tasks: Vec<_> = [
            "stop_test_tone",
            "set_global_mute",
            "set_bypass",
            "set_mute",
            "set_gain",
            "open_editor",
        ]
        .into_iter()
        .map(|name| {
            let control = control.clone();
            tokio::spawn(async move { control.run_async(cmd(name), |_| ()).await })
        })
        .collect();
        tokio::time::sleep(Duration::from_millis(100)).await;
        stuck.end();
        for task in tasks {
            let result = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .expect("プールが埋まっていても、取り出された仕事は終わる")
                .unwrap();
            assert_eq!(result, Ok(()));
        }
        let (stop_again, fence) = (
            control.run_async(stop_entry(), |_| ()).await,
            control.fence(),
        );
        assert_eq!(stop_again, Ok(()));
        assert!(fence > stop_seq_before);
    });
    release.store(true, Ordering::SeqCst);
}

// Z20：更新の前の確認は、窓の中では数えず、窓の後だけ数を進める。
#[test]
fn z20_recheck_counts_only_after_the_window_and_the_update_retry_does_not_escalate() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    reaper_seam::stuck();
    host.kill_engine();
    assert_eq!(reaper_seam::pending(&host, Role::Primary), 1);
    for _ in 0..3 {
        let error = host.prepare_update().unwrap_err();
        assert_eq!(error.to_string(), engine_life::UNCONFIRMED_JA);
    }
    assert_eq!(
        reaper_seam::counts(&host, Role::Primary),
        [0],
        "窓の中は数えない"
    );
    reaper_seam::pass_window(&host);
    let error = host.prepare_update().unwrap_err();
    assert_eq!(error.to_string(), engine_life::UNCONFIRMED_JA);
    assert_eq!(
        reaper_seam::counts(&host, Role::Primary),
        [1],
        "窓の後は進む"
    );
    reaper_seam::real();
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// Z21：future を捨てても積んだ仕事は実行される。送れなかった返事の Drop が panic しても実行のスレッドは止まらない。
#[test]
fn z21_cancel_safety_and_panic_conversion_of_run_async() {
    struct Boom;
    impl Drop for Boom {
        fn drop(&mut self) {
            panic!("a reply that cannot be delivered panics when dropped");
        }
    }
    let rig = Rig::new(Duration::from_millis(500));
    let stuck = rig.stick(Role::Primary);
    let runtime = runtime();
    let ran = Arc::new(AtomicUsize::new(0));
    let (counter, other) = (ran.clone(), ran.clone());
    let control = rig.control.clone();
    let task = runtime.spawn({
        let control = control.clone();
        async move {
            let _ = control
                .run_async(cmd("load_plugin"), move |_| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Boom
                })
                .await;
        }
    });
    wait_until("the job is queued", || control.queue_len() == 1);
    task.abort();
    let _ = runtime.block_on(task);
    let _ = other;
    assert_eq!(control.counted(), 1, "捨てても積んだ仕事は残る");
    wait_until("the abandoned job runs after the window", || {
        ran.load(Ordering::SeqCst) == 1 && control.counted() == 0
    });
    assert_eq!(
        control.run(normal(), |_| 5).unwrap(),
        5,
        "実行のスレッドは止まらない"
    );
    stuck.end();
    // 閉包の panic は、タスクを panic させず Panicked で返る。
    let panicked =
        runtime.block_on(control.run_async(normal(), |_| -> u8 { panic!("closure failed") }));
    assert!(
        matches!(&panicked, Err(RunAsyncError::Panicked(text)) if text.contains("closure failed")),
        "{panicked:?}"
    );
}

// Z22：入口の呼び出し元の一覧。閉包の外のブロッキング処理だけが spawn_blocking に残り、run_async は
// spawn_blocking も MutexGuard の .await またぎも使わない。
#[test]
fn z22_callers_are_inventoried_and_the_pool_threads_never_hold_the_queue() {
    fn blocking_calls_with_run(text: &str) -> Vec<String> {
        let mut found = Vec::new();
        for marker in ["run_blocking(", "spawn_blocking("] {
            let mut at = 0;
            while let Some(position) = text[at..].find(marker) {
                let open = at + position + marker.len() - 1;
                let mut depth = 0_i64;
                let mut close = open;
                for (offset, character) in text[open..].char_indices() {
                    match character {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                close = open + offset;
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if text[open..close].contains(".run(") {
                    found.push(
                        text[open..close]
                            .lines()
                            .take(2)
                            .collect::<Vec<_>>()
                            .join(" "),
                    );
                }
                at = open + 1;
            }
        }
        found
    }
    for file in [
        "commands/audio.rs",
        "commands/bundles.rs",
        "commands/profiles.rs",
        "commands/voice_check.rs",
        "obs.rs",
        "updates.rs",
        "migration.rs",
        "temporary_session.rs",
    ] {
        let text = production_source(&src().join(file));
        let bad = blocking_calls_with_run(&text);
        assert!(
            bad.is_empty(),
            "{file} が run_blocking・spawn_blocking の中で .run( を呼ぶ: {bad:?}"
        );
    }
    let control = production_source(&src().join("audio/control.rs"));
    let start = control.find("pub async fn run_async").unwrap();
    let end = control[start..].find("\n    /// ").unwrap() + start;
    let body = &control[start..end];
    assert!(!body.contains("spawn_blocking"), "run_async がプールを使う");
    assert!(!body.contains(".lock("), "run_async が Mutex を取る");
    let wait = production_source(&src().join("audio/control.rs"));
    let start = wait.find("async fn wait_reply_async").unwrap();
    let end = wait[start..].find("\n    }\n").unwrap() + start;
    assert!(!wait[start..end].contains("spawn_blocking"));
}

// Z23：同じ窓で保留した Mute は、実行のスレッドが待機中に窓が閉じても、受付の順に実行される。
#[test]
fn z23_mutes_held_on_the_same_window_run_in_acceptance_order_even_when_the_actor_was_idle_at_the_close(
) {
    for push_reversed in [false, true] {
        let rig = Rig::new(Duration::from_secs(5));
        let stuck = rig.stick(Role::Primary);
        let log = log();
        let unmute = rig.control.admit(cmd("set_global_mute"));
        let mute = rig.control.admit(cmd("toggle_global_mute"));
        let later_unmute = rig.control.admit(cmd("global_shortcut_mute"));
        if push_reversed {
            later_unmute.post(record_into(&log, "late")).unwrap();
            mute.post(record_into(&log, "mute")).unwrap();
            unmute.post(record_into(&log, "unmute")).unwrap();
        } else {
            unmute.post(record_into(&log, "unmute")).unwrap();
            mute.post(record_into(&log, "mute")).unwrap();
            later_unmute.post(record_into(&log, "late")).unwrap();
        }
        wait_until("held", || rig.control.queue_len() == 3);
        std::thread::sleep(WAIT);
        let ended = Instant::now();
        stuck.end();
        wait_until("all run", || entries(&log).len() == 3);
        assert!(
            ended.elapsed() < Duration::from_secs(2),
            "窓の期限（5秒）より前に、列が起こされて取り出す"
        );
        let order = entries(&log);
        let position = |name: &str| {
            order
                .iter()
                .position(|entry| entry.starts_with(name))
                .unwrap()
        };
        assert!(
            position("unmute") < position("mute") && position("mute") < position("late"),
            "A→B の順（最後がミュート側）: {order:?}"
        );
    }
}

// Z24：保留中でも、Stop で断られ、受付から60秒（縮めた値）で断られる。期限は次の期限で起きる。
#[test]
fn z24_a_held_job_is_still_refused_by_fence_and_expiry_and_the_condvar_wakes_at_the_next_deadline()
{
    let rig = Rig::new(Duration::from_secs(4));
    rig.stick(Role::Primary);
    rig.control.set_limits(
        10,
        Duration::from_millis(400),
        Duration::from_secs(3600),
        Duration::from_secs(3600),
    );
    let log = log();
    rig.control
        .post(cmd("load_plugin"), record_into(&log, "start"))
        .unwrap();
    rig.control
        .post(
            cmd("get_round_trip_measurement"),
            record_into(&log, "normal"),
        )
        .unwrap();
    let started = Instant::now();
    wait_until("both are expired by the deadline alone", || {
        entries(&log).len() == 2
    });
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "窓（4秒）より前に、受付からの期限で起きる"
    );
    assert_eq!(
        entries(&log),
        ["start:Expired", "normal:Expired"],
        "保留中の閉包は Err(Expired) で1回だけ呼ばれる"
    );
    rig.control.set_limits(
        10,
        Duration::from_secs(3600),
        Duration::from_secs(3600),
        Duration::from_secs(3600),
    );
    rig.control
        .post(cmd("set_bypass"), record_into(&log, "later"))
        .unwrap();
    std::thread::sleep(WAIT);
    let stop = rig.control.run(stop_entry(), |_| ());
    assert_eq!(stop, Ok(()));
    wait_until("the stop refuses the held start", || {
        entries(&log).len() == 3
    });
    assert_eq!(entries(&log)[2], "later:StoppedFirst");
    assert!(!rig.started("set_bypass"));
}

// Z25：保留は、受付の時点で見えていた記録の窓で必ず終わる。後から増えた記録では保留しない。
#[test]
fn z25_a_hold_ends_at_the_window_known_at_acceptance_even_if_new_records_appear_meanwhile() {
    let rig = Rig::new(Duration::from_millis(3000));
    let first = rig.stick(Role::Primary);
    let log = log();
    rig.control
        .post(cmd("stop_test_tone"), record_into(&log, "release"))
        .unwrap();
    let store = rig.store.clone();
    let made = Arc::new(Mutex::new(Vec::<Stuck>::new()));
    let sink = made.clone();
    rig.control
        .post(cmd("set_global_mute"), move |host| {
            if host.is_ok() {
                sink.lock().unwrap().push(stick(&store, Role::Primary));
            }
        })
        .unwrap();
    std::thread::sleep(WAIT);
    assert!(entries(&log).is_empty());
    let ended = Instant::now();
    first.end();
    wait_until("the release is not held by the newer record", || {
        entries(&log) == ["release:ok"]
    });
    assert!(
        ended.elapsed() < Duration::from_millis(1500),
        "新しい記録の窓（3秒）では保留されない"
    );
    assert_eq!(
        rig.store.pending(Role::Primary),
        1,
        "新しい記録は残っている"
    );
    // 新しい記録の後に受け付けた Mute は、その窓で保留される。先の Release を追い越し続けられない。
    let later = Instant::now();
    rig.control
        .post(cmd("toggle_global_mute"), record_into(&log, "later"))
        .unwrap();
    std::thread::sleep(WAIT);
    assert_eq!(entries(&log), ["release:ok"]);
    assert!(later.elapsed() < Duration::from_millis(1500));
    for stuck in made.lock().unwrap().iter() {
        stuck.probe.terminate();
        stuck.script.set(Mode::Released);
    }
    wait_until("the later mute runs once the newer window closes", || {
        entries(&log).len() == 2
    });
}

// Z26：同じ閉包の中で C5 の旧プロセスを回収した記録だけは、実行のスレッドが窓の終わりまで待つ（main と同じ）。
#[test]
fn z26_a_mute_that_reaps_a_c5_child_in_its_own_closure_waits_in_the_actor_and_succeeds_like_main() {
    // 10秒以内に終われば成功する。
    let rig = Rig::new(Duration::from_millis(1500));
    rig.control
        .run(cmd("load_plugin"), |host| host.ensure_engine_running())
        .unwrap()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let control = rig.control.clone();
    let muting = std::thread::spawn(move || {
        control.run(cmd("set_global_mute"), move |host| {
            host.link.close(CloseCause::Eof);
            reaper_seam::stuck();
            let _ = tx.send(seam::current_script());
            let result = host.ensure_engine_running();
            reaper_seam::real();
            result.is_ok()
        })
    });
    let script = rx.recv_timeout(GATE).unwrap().expect("台本");
    std::thread::sleep(Duration::from_millis(400));
    script.set(Mode::Released);
    assert_eq!(
        join("the mute", muting),
        Ok(true),
        "窓の途中で終われば、同じ操作の中で作り直せる"
    );
    assert_eq!(rig.observer.spawn_count(), 2);
    drop(rig);

    // 窓を超えて終わらなければ engine_unconfirmed。
    let rig = Rig::new(Duration::from_millis(600));
    rig.control
        .run(cmd("load_plugin"), |host| host.ensure_engine_running())
        .unwrap()
        .unwrap();
    let started = Instant::now();
    let error = rig
        .control
        .run(cmd("set_global_mute"), |host| {
            host.link.close(CloseCause::Eof);
            reaper_seam::stuck();
            let result = host.ensure_engine_running();
            reaper_seam::real();
            result
        })
        .unwrap()
        .unwrap_err();
    assert!(unconfirmed(&error).is_some());
    assert!(
        started.elapsed() >= Duration::from_millis(500),
        "窓の終わりまで待つ"
    );
    drop(rig);

    // 受付の時点で作られていた記録は、待たずに失敗する。
    let rig = Rig::new(Duration::from_millis(1500));
    rig.stick(Role::Primary);
    let started = Instant::now();
    let error = rig
        .control
        .run(normal().launch(Launch::None), |host| {
            host.ensure_engine_running()
        })
        .unwrap()
        .unwrap_err();
    assert!(unconfirmed(&error).is_some());
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "ほかの記録は待たない"
    );
    assert_eq!(rig.store.counts(Role::Primary), [0], "窓の中の失敗は数えない");
}
