//! 停止の優先・停止より前の受付の断り・上限・期限（F1b-0b-2b。12章）の試験 Y1〜Y18。
//! 待ちはすべて門（`mpsc`）で、時間切れは失敗の上限。上限と期限は、列ごとの設定を縮めて確かめる。
use super::control::{scheduler_continues, ActorPoint, ControlError, Entry, EntryKind, Phase};
use super::queue_support::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
fn y14_a_slow_closure_warns_once_and_is_never_cut_short() {
    let control = control();
    control.set_limits(
        256,
        LONG,
        Duration::from_millis(30),
        Duration::from_secs(3600),
    );
    control.run(normal(), |_| ()).unwrap();
    assert_eq!(control.admission().slow_warnings(), 0);
    let result = control.run(normal(), |_| {
        std::thread::sleep(Duration::from_millis(80));
        5
    });
    assert_eq!(result, Ok(5), "警告するだけで、打ち切らない");
    assert_eq!(control.admission().slow_warnings(), 1);
    control
        .run(starting(), |_| {
            std::thread::sleep(Duration::from_millis(80))
        })
        .unwrap();
    assert_eq!(
        control.admission().slow_warnings(),
        1,
        "開始・再起動は、長い方の長さを使う"
    );
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
