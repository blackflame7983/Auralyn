//! 停止の優先・停止より前の受付の断り・上限・期限（F1b-0b-2b。12章）の試験 Y1〜Y18。
//! 待ちはすべて門（`mpsc`）で、時間切れは失敗の上限。上限と期限は、列ごとの設定を縮めて確かめる。
use super::class_tests::{production_source, src};
use super::control::{
    scheduler_continues, ActorPoint, ControlError, Entry, EntryKind, Phase, RunAsyncError,
};
use super::queue_support::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
// Y1：停止の列は、通常の列に先に積まれた仕事より先に実行される。停止の列の中は積んだ順。走っている仕事は割り込まれない。
#[test]
fn y1_a_stop_runs_before_the_jobs_queued_ahead_of_it() {
    let control = control();
    let order = log();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let running = order.clone();
    control
        .post(release_entry(), move |_| {
            let _ = entered_tx.send(());
            let _ = release_rx.recv_timeout(GATE);
            running.lock().unwrap().push("running".into());
        })
        .unwrap();
    entered_rx
        .recv_timeout(GATE)
        .expect("止める仕事が始まらなかった");
    for name in ["n1", "n2", "n3"] {
        let order = order.clone();
        control
            .post(normal(), move |_| order.lock().unwrap().push(name.into()))
            .unwrap();
    }
    for (entry, name) in [(mute_entry(), "mute"), (stop_entry(), "stop")] {
        let order = order.clone();
        control
            .post(entry, move |_| order.lock().unwrap().push(name.into()))
            .unwrap();
    }
    wait_len(&control, 5);
    assert_eq!(entries(&order), Vec::<String>::new());
    release_tx.send(()).unwrap();
    control.run(normal(), |_| ()).unwrap();
    assert_eq!(
        entries(&order),
        ["running", "mute", "stop", "n1", "n2", "n3"],
        "走っている仕事が先に終わり、停止の列（積んだ順）が通常の列より先に実行される"
    );
}

// Y2：停止より前に受け付けた Starting は、閉包を呼ばずに断られる。`post`の閉包は`Err(StoppedFirst)`で1回だけ呼ばれる。
#[test]
fn y2_a_starting_job_accepted_before_a_stop_is_refused_without_running() {
    let control = control();
    let hold = hold(&control);
    let calls = Arc::new(AtomicUsize::new(0));
    let run = spawn_counting_run(&control, starting(), &calls);
    wait_len(&control, 1);
    let posted = log();
    control
        .post(cmd("restart_audio_engine"), record_into(&posted, "posted"))
        .unwrap();
    wait_len(&control, 2);
    control
        .post(
            Entry::new(EntryKind::Warmup, "warmup"),
            record_into(&posted, "warmup"),
        )
        .unwrap();
    wait_len(&control, 3);
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    control
        .post(stop_entry(), move |_| flag.store(true, Ordering::SeqCst))
        .unwrap();
    hold.release();
    assert_eq!(
        join("the refused run returns", run),
        Err(ControlError::StoppedFirst)
    );
    control.run(normal(), |_| ()).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 0, "断った閉包は呼ばない");
    assert!(stopped.load(Ordering::SeqCst), "停止は実行される");
    assert_eq!(
        entries(&posted),
        ["posted:StoppedFirst", "warmup:StoppedFirst"],
        "post は1回だけ。起動直後の自動開始（warmup）も、停止より前の受付なので断られる"
    );
    assert_eq!(
        phases(&control, "start_audio"),
        [Phase::Accepted, Phase::Refused]
    );
    assert_eq!(
        phases(&control, "restart_audio_engine"),
        [Phase::Accepted, Phase::Refused]
    );
    assert_eq!(control.counted(), 0);
}

// Y3：停止の後に受け付けた Starting は実行される。Stop より前でも Normal・Release は断られない。Mute は fence を上げない。
#[test]
fn y3_a_starting_job_accepted_after_the_stop_runs() {
    let control = control();
    let hold = hold(&control);
    let order = log();
    control
        .post(normal(), record_into(&order, "normal"))
        .unwrap();
    control
        .post(
            cmd("end_live_changes_bundle"),
            record_into(&order, "release"),
        )
        .unwrap();
    control
        .post(starting(), record_into(&order, "before_mute"))
        .unwrap();
    control
        .post(mute_entry(), record_into(&order, "mute"))
        .unwrap();
    assert_eq!(control.fence(), 0, "Mute は fence を上げない");
    control
        .post(cmd("load_plugin"), record_into(&order, "before_stop"))
        .unwrap();
    let stop = control.admit(stop_entry());
    let stop_seq = stop.seq();
    stop.post(record_into(&order, "stop")).unwrap();
    assert_eq!(control.fence(), stop_seq);
    hold.release();
    control.run(normal(), |_| ()).unwrap();
    control
        .post(cmd("load_plugin"), record_into(&order, "after_stop"))
        .unwrap();
    control.run(normal(), |_| ()).unwrap();
    assert_eq!(
        entries(&order),
        [
            "mute:ok",
            "stop:ok",
            "normal:ok",
            "release:ok",
            "before_mute:StoppedFirst",
            "before_stop:StoppedFirst",
            "after_stop:ok",
        ],
        "Mute より前の Starting も、Stop の前の Normal・Release も断られない（Stop より前の Starting だけが断られる）"
    );
}

// Y4：断りは受付の番号で決まり、積む順では決まらない。
#[test]
fn y4_the_decision_follows_the_acceptance_number_not_the_push_order() {
    let control = control();
    let hold = hold(&control);
    let order = log();
    let early = control.admit(starting());
    let stop = control.admit(stop_entry());
    let late = control.admit(cmd("load_plugin"));
    assert!(early.seq() < stop.seq() && stop.seq() < late.seq());
    late.post(record_into(&order, "late")).unwrap();
    stop.post(record_into(&order, "stop")).unwrap();
    early.post(record_into(&order, "early")).unwrap();
    hold.release();
    control.run(normal(), |_| ()).unwrap();
    assert_eq!(
        entries(&order),
        ["stop:ok", "early:StoppedFirst", "late:ok"],
        "停止の後に積まれても、停止より前に受け付けた Starting は断られ、後に受け付けたものは実行される"
    );
}

// Y5：Stop・Mute・Tick・Release は、上限にも、受付からの期限にも、fence にも断られない。
#[test]
fn y5_stop_mute_tick_and_release_are_never_refused_expired_or_counted() {
    let control = limited(3, WAIT);
    let hold = hold_with(&control, tick_entry());
    let expired = log();
    for name in ["a", "b", "c"] {
        let _ = name;
        control.post(normal(), record_into(&expired, "n")).unwrap();
    }
    assert_eq!(control.counted(), 3);
    assert_eq!(
        control.post(normal(), |_| ()),
        Err(ControlError::Busy),
        "数える仕事は 3 件で満杯"
    );
    let waiters = [
        spawn_run(&control, stop_entry()),
        spawn_run(&control, mute_entry()),
        spawn_run(&control, tick_entry()),
        spawn_run(&control, release_entry()),
    ];
    wait_len(&control, 3 + 4);
    std::thread::sleep(WAIT * 3);
    assert!(
        waiters.iter().all(|waiter| !waiter.is_finished()),
        "期限を過ぎても、取り消されず無期限に待つ"
    );
    hold.release();
    for waiter in waiters {
        assert_eq!(join("a waiter returns", waiter), Ok(()));
    }
    control.run(release_entry(), |_| ()).unwrap();
    assert_eq!(
        entries(&expired),
        ["n:Expired", "n:Expired", "n:Expired"],
        "数える仕事の期限は取り出す時に断られる"
    );
    for name in ["stop_audio", "set_global_mute", "end_live_changes"] {
        assert!(
            !phases(&control, name).contains(&Phase::Refused),
            "{name} は断られない"
        );
    }
    assert_eq!(control.counted(), 0);
}

// Y6：257 件目（縮めた上限の次）は待たずに`Busy`。数は実行中の1件も数え、返事の前に下がる。
#[test]
fn y6_the_next_counted_job_is_refused_with_busy_and_the_count_drops_before_the_reply() {
    let control = limited(1, LONG);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    control
        .post(normal(), move |_| {
            let _ = entered_tx.send(());
            let _ = release_rx.recv_timeout(GATE);
        })
        .unwrap();
    entered_rx.recv_timeout(GATE).expect("仕事が始まらなかった");
    assert_eq!(control.counted(), 1, "実行中の1件も数える");
    let called = Arc::new(AtomicUsize::new(0));
    let counter = called.clone();
    assert_eq!(
        within("a refused run", {
            let control = control.clone();
            move || control.run(normal(), |_| ())
        }),
        Err(ControlError::Busy)
    );
    assert_eq!(
        control.post(normal(), move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
        Err(ControlError::Busy)
    );
    assert_eq!(
        called.load(Ordering::SeqCst),
        0,
        "断った post の閉包は呼ばない"
    );
    assert_eq!(
        phases(&control, "get_audio_state"),
        [
            Phase::Accepted,
            Phase::Started,
            Phase::Accepted,
            Phase::Refused,
            Phase::Accepted,
            Phase::Refused
        ]
    );
    release_tx.send(()).unwrap();
    wait_until("the count drops", || control.counted() == 0);
    control.run(normal(), |_| ()).unwrap();
}

#[test]
fn y6_a_run_that_returned_never_sees_the_count_of_its_own_reply() {
    let control = limited(1, LONG);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (entered_tx, release_rx) = (Mutex::new(entered_tx), Mutex::new(release_rx));
    let armed = Arc::new(AtomicBool::new(true));
    control.set_actor_seam(Arc::new(move |at| {
        if at == ActorPoint::AfterReply && armed.swap(false, Ordering::SeqCst) {
            let _ = entered_tx.lock().unwrap().send(());
            let _ = release_rx.lock().unwrap().recv_timeout(GATE);
        }
    }));
    control.run(normal(), |_| ()).unwrap();
    entered_rx
        .recv_timeout(GATE)
        .expect("返事の直後の継ぎ目に着かなかった");
    let second = spawn_run(&control, normal());
    wait_until("the second run is queued or refused", || {
        control.queue_len() == 1 || second.is_finished()
    });
    assert!(
        !second.is_finished(),
        "run が戻った直後の次の操作は、数が下がった後なので Busy にならない"
    );
    release_tx.send(()).unwrap();
    assert_eq!(join("the second run returns", second), Ok(()));
}

// Y7：期限が来た待ちは取り消され、閉包は呼ばれず、数が下がる。始まった仕事は期限を過ぎても結果を返す。
#[test]
fn y7_a_waiting_run_expires_but_a_started_run_does_not() {
    let control = limited(256, WAIT);
    let hold = hold(&control);
    let calls = Arc::new(AtomicUsize::new(0));
    let waiting = spawn_counting_run(&control, normal(), &calls);
    wait_len(&control, 1);
    assert_eq!(
        join("the waiting run expires", waiting),
        Err(ControlError::Expired)
    );
    assert_eq!(control.queue_len(), 0, "取り消された仕事は列にない");
    assert_eq!(control.counted(), 0);
    hold.release();
    control.run(release_entry(), |_| ()).unwrap();
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "取り消した閉包は呼ばれない"
    );
    assert_eq!(
        phases(&control, "get_audio_state"),
        [Phase::Accepted, Phase::Refused]
    );

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let runner = control.clone();
    let started = std::thread::spawn(move || {
        runner.run(normal(), move |_| {
            let _ = entered_tx.send(());
            let _ = release_rx.recv_timeout(GATE);
            7
        })
    });
    entered_rx.recv_timeout(GATE).expect("仕事が始まらなかった");
    std::thread::sleep(WAIT * 3);
    release_tx.send(()).unwrap();
    assert_eq!(
        join("the started run returns", started),
        Ok(7),
        "始まった仕事は、期限を過ぎても結果を捨てない"
    );
}

#[test]
fn y7_a_job_taken_at_the_moment_of_the_deadline_runs_once_and_is_not_cancelled() {
    let control = limited(256, WAIT);
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (entered_tx, release_rx) = (Mutex::new(entered_tx), Mutex::new(release_rx));
    let armed = Arc::new(AtomicBool::new(true));
    control.set_actor_seam(Arc::new(move |at| {
        if at == ActorPoint::AfterTake && armed.swap(false, Ordering::SeqCst) {
            let _ = entered_tx.lock().unwrap().send(());
            let _ = release_rx.lock().unwrap().recv_timeout(GATE);
        }
    }));
    let calls = Arc::new(AtomicUsize::new(0));
    let runner = spawn_counting_run(&control, normal(), &calls);
    entered_rx.recv_timeout(GATE).expect("取り出されなかった");
    std::thread::sleep(WAIT * 3);
    assert!(!runner.is_finished(), "取り出された後は期限が成立しない");
    release_tx.send(()).unwrap();
    assert_eq!(join("the taken run returns", runner), Ok(()));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "二重にも取りこぼしにもならない"
    );
    assert_eq!(
        phases(&control, "get_audio_state"),
        [Phase::Accepted, Phase::Started, Phase::Completed]
    );
}

// Y8：`post`の期限切れは、取り出す時に1回だけ断られる。
#[test]
fn y8_a_posted_job_that_waited_too_long_gets_expired_once() {
    let control = limited(256, WAIT);
    let hold = hold(&control);
    let order = log();
    control.post(normal(), record_into(&order, "late")).unwrap();
    control
        .post(starting(), record_into(&order, "start"))
        .unwrap();
    std::thread::sleep(WAIT * 2);
    hold.release();
    control.run(release_entry(), |_| ()).unwrap();
    assert_eq!(entries(&order), ["late:Expired", "start:Expired"]);
    assert_eq!(
        phases(&control, "get_audio_state"),
        [Phase::Accepted, Phase::Refused]
    );
    assert_eq!(control.counted(), 0);
}

// Y12：実行中の閉包は、停止が届いても途中で止まらず（`StoppedFirst`を出さない）、直後に停止が実行される。
#[test]
fn y12_a_stop_does_not_interrupt_a_running_closure_and_runs_right_after_it() {
    let control = control();
    let order = log();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let steps = order.clone();
    let runner = control.clone();
    let running = std::thread::spawn(move || {
        runner.run(starting(), move |_| {
            steps.lock().unwrap().push("step1".into());
            let _ = entered_tx.send(());
            let _ = release_rx.recv_timeout(GATE);
            steps.lock().unwrap().push("step2".into());
            Ok::<_, ControlError>(())
        })
    });
    entered_rx.recv_timeout(GATE).expect("開始が始まらなかった");
    let after = order.clone();
    control
        .post(stop_entry(), move |_| {
            after.lock().unwrap().push("stop".into())
        })
        .unwrap();
    let other = control.clone();
    within("callers while a closure waits for a reply", move || {
        let _ = other.admit(normal());
        let _ = other.admission().records();
        other.post(normal(), |_| ()).unwrap();
    });
    release_tx.send(()).unwrap();
    assert_eq!(
        join("the running closure returns", running),
        Ok(Ok(())),
        "走っている閉包は最後まで走り、StoppedFirst を出さない"
    );
    control.run(normal(), |_| ()).unwrap();
    assert_eq!(entries(&order), ["step1", "step2", "stop"]);
}

// Y14：記録は`Accepted`→`Started`→`Completed`、断ったときは`Accepted`→`Refused`。定期の更新は記録しない。
#[test]
fn y14_the_phases_are_started_completed_and_refused_in_order() {
    let control = control();
    control
        .run(normal(), |_| std::thread::sleep(Duration::from_millis(20)))
        .unwrap();
    assert_eq!(
        phases(&control, "get_audio_state"),
        [Phase::Accepted, Phase::Started, Phase::Completed],
        "Completed は返事より前に記録される"
    );
    let completed = control
        .admission()
        .records()
        .into_iter()
        .find(|record| record.phase == Phase::Completed)
        .unwrap();
    assert!(completed.elapsed.unwrap() >= Duration::from_millis(20));
    control.run(tick_entry(), |_| ()).unwrap();
    assert!(control
        .admission()
        .records()
        .iter()
        .all(|record| record.entry.kind != EntryKind::Scheduler));
}

#[test]
fn y14_a_slow_closure_is_never_cut_short() {
    let control = control();
    control.set_limits(256, LONG, Duration::from_millis(30));
    let result = control.run(normal(), |_| {
        std::thread::sleep(Duration::from_millis(80));
        5
    });
    assert_eq!(result, Ok(5), "警告するだけで、打ち切らない");
}

// Y18：scheduler の tick は、満杯・期限・fence の下でも断られず、断りを受けても scheduler は次の周期へ進む。
#[test]
fn y18_the_scheduler_is_never_refused_and_continues_after_any_refusal() {
    let control = limited(1, WAIT);
    let hold = hold(&control);
    control.post(normal(), |_| ()).unwrap();
    let stop = control.admit(stop_entry());
    stop.post(|_| ()).unwrap();
    let tick = spawn_run(&control, tick_entry());
    wait_len(&control, 3);
    std::thread::sleep(WAIT * 2);
    assert!(!tick.is_finished(), "期限を過ぎても tick は取り消されない");
    hold.release();
    assert_eq!(join("the tick returns", tick), Ok(()));
    for (result, expected) in [
        (Ok(()), true),
        (Err(ControlError::Poisoned), true),
        (Err(ControlError::Busy), true),
        (Err(ControlError::Expired), true),
        (Err(ControlError::StoppedFirst), true),
        (Err(ControlError::Stopped), false),
        (Err(ControlError::Reentrant), false),
    ] {
        assert_eq!(scheduler_continues(result), expected, "{result:?}");
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
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

// Z19：ブロッキングのプールが埋まっていても、Stop は列へ届く。投入・結果の待ちがプールを使わない。
#[test]
fn z19_a_stop_reaches_the_queue_and_raises_the_fence_even_when_the_blocking_pool_is_saturated() {
    let control = super::queue_support::control();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(2)
        .enable_all()
        .build()
        .unwrap();
    struct Release(Arc<AtomicBool>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let release = Arc::new(AtomicBool::new(false));
    let _release_on_exit = Release(release.clone());
    for _ in 0..2 {
        let flag = release.clone();
        runtime.spawn_blocking(move || {
            while !flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
        });
    }
    let gate = hold(&control);
    runtime.block_on(async {
        let held = {
            let control = control.clone();
            tokio::spawn(async move { control.run_async(cmd("load_plugin"), |_| ()).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        let stop_seq_before = control.fence();
        let stop = {
            let control = control.clone();
            tokio::spawn(async move { control.run_async(stop_entry(), |_| ()).await })
        };
        let waiting = Instant::now();
        while control.fence() <= stop_seq_before {
            assert!(
                waiting.elapsed() < Duration::from_secs(2),
                "Stop がプールの空きに依らず届く"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        gate.release();
        let stopped = tokio::time::timeout(Duration::from_secs(2), stop)
            .await
            .expect("Stop がプールの空きに依らず終わる")
            .unwrap();
        assert_eq!(stopped, Ok(()));
        assert_eq!(
            held.await.unwrap(),
            Err(RunAsyncError::Control(ControlError::StoppedFirst))
        );
        // プールより多い数が一斉に積まれても、どれも終わる。
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
        for task in tasks {
            let result = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .expect("プールが埋まっていても、積まれた仕事は終わる")
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

// Z21：future を捨てても積んだ仕事は実行される。送れなかった返事の Drop が panic しても実行のスレッドは止まらない。
#[test]
fn z21_cancel_safety_and_panic_conversion_of_run_async() {
    struct Boom;
    impl Drop for Boom {
        fn drop(&mut self) {
            panic!("a reply that cannot be delivered panics when dropped");
        }
    }
    let control = super::queue_support::control();
    let gate = hold(&control);
    let runtime = runtime();
    let ran = Arc::new(AtomicUsize::new(0));
    let counter = ran.clone();
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
    assert_eq!(control.counted(), 1, "捨てても積んだ仕事は残る");
    gate.release();
    wait_until("the abandoned job runs after the gate opens", || {
        ran.load(Ordering::SeqCst) == 1 && control.counted() == 0
    });
    assert_eq!(
        control.run(normal(), |_| 5).unwrap(),
        5,
        "実行のスレッドは止まらない"
    );
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
    // 拒否時の `drop(job)` は、列のロックを放してから行う。
    let queue = production_source(&src().join("audio/control/queue.rs"));
    let start = queue.find("pub(super) fn push").unwrap();
    let body = &queue[start..start + queue[start..].find("\n    }\n").unwrap()];
    assert!(
        body.find("drop(state);").unwrap() < body.find("drop(job);").unwrap(),
        "push は列のロックを放してから job を落とす"
    );
    let wait = production_source(&src().join("audio/control.rs"));
    let start = wait.find("async fn wait_reply_async").unwrap();
    let end = wait[start..].find("\n    }\n").unwrap() + start;
    assert!(!wait[start..end].contains("spawn_blocking"));
}
