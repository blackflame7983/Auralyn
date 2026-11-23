//! 終了を確かめられない子の記録（待たずに `engine_unconfirmed`）と、受付の順・`run_async` の試験。
//! 設計は docs/plans/audio-session-f1b0b-design.md の13章。保留・reaper・窓は J-28 で取り除いた。待ちは門で、時間切れは失敗の上限。
use super::class_tests::{production_source, src};
use super::compat_support::{scripted_parts, spawn_idle_process, Observer, ProcessProbe};
use super::control::{AudioControl, ControlError, EntryKind, RunAsyncError};
use super::engine_life::{EngineUnconfirmed, Role};
use super::queue_support::{
    cmd, entries, hold, log, normal, record_into, stop_entry, wait_until, Log,
};
use super::reaper_seam;
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

type Store = engine_life::Store;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
}

fn unconfirmed(error: &anyhow::Error) -> Option<EngineUnconfirmed> {
    error.downcast_ref::<EngineUnconfirmed>().copied()
}

/// 起動を試みる `post` の閉包。結果を記録する。
fn launching(
    log: &Log,
    name: &'static str,
) -> impl FnOnce(Result<&mut AudioHost, ControlError>) + Send + 'static {
    let log = log.clone();
    move |host| {
        let text = match host {
            Ok(host) => match host.ensure_engine_running() {
                Ok(_) => format!("{name}:started"),
                Err(error) if unconfirmed(&error).is_some() => format!("{name}:unconfirmed"),
                Err(error) => format!("{name}:failed {error}"),
            },
            Err(error) => format!("{name}:{error:?}"),
        };
        log.lock().unwrap().push(text);
    }
}

/// 終わらない子（試験の実行ファイル自身）を、`kill` も確認もせずに主の記録へ置いた `AudioControl`。
fn control_with_live_record() -> (AudioControl, Arc<ProcessProbe>, Observer) {
    let (host, observer) = scripted_parts([]);
    let child = spawn_idle_process();
    let probe = Arc::new(ProcessProbe::open(child.id()).expect("子のハンドルを開けた"));
    reaper_seam::adopt(&host, Role::Primary, child);
    (AudioControl::new(host), probe, observer)
}

// U1：生きている記録がある間、同じ役割の `ensure_clear` は待たずに失敗する。ほかの役割は通る。
// 失敗のたびに `kill()` をやり直すので、子は終わり、終わりを確かめた次の呼び出しで記録は消える。
#[test]
fn u1_a_live_record_fails_ensure_clear_at_once_and_is_cleared_once_the_child_has_exited() {
    let store = Store::default();
    let child = spawn_idle_process();
    let probe = ProcessProbe::open(child.id()).unwrap();
    store.adopt_for_test(Role::Primary, child);
    let started = Instant::now();
    assert_eq!(
        store.ensure_clear(Role::Primary),
        Err(EngineUnconfirmed { repeated: false })
    );
    assert!(started.elapsed() < Duration::from_secs(1), "待たない");
    assert_eq!(store.ensure_clear(Role::PostMix), Ok(()), "別の役割は通る");
    assert_eq!(store.pending(Role::Primary), 1);
    assert!(probe.wait_exit(5000), "失敗のたびに kill をやり直す");
    wait_until("the exited record is cleared", || {
        store.ensure_clear(Role::Primary).is_ok()
    });
    assert_eq!(store.pending(Role::Primary), 0);
}

// U2：更新の前の確認（`recheck`）は、記録が残れば失敗し、終わりを確かめたら消す。
#[test]
fn u2_recheck_fails_while_a_record_is_alive_and_clears_it_after_exit() {
    let store = Store::default();
    let child = spawn_idle_process();
    let probe = ProcessProbe::open(child.id()).unwrap();
    store.adopt_for_test(Role::PostMix, child);
    assert_eq!(store.recheck(), Err(EngineUnconfirmed { repeated: false }));
    assert!(probe.wait_exit(5000), "kill がやり直される");
    wait_until("the exited record is cleared", || store.recheck().is_ok());
    assert_eq!(store.pending(Role::PostMix), 0);
}

// U3：終わりを確かめられない記録があっても、後から受け付けた操作が先に走らない。
// 開始は待たずに `engine_unconfirmed` で失敗し、続く操作は受付の順に実行される。
#[test]
fn u3_an_unconfirmed_start_fails_at_once_and_does_not_let_a_later_operation_overtake_it() {
    let (control, probe, observer) = control_with_live_record();
    let gate = hold(&control);
    let log = log();
    let start = control.admit(cmd("load_plugin"));
    let gain = control.admit(cmd("set_gain"));
    gain.post(record_into(&log, "gain")).unwrap();
    start.post(launching(&log, "start")).unwrap();
    let released = Instant::now();
    gate.release();
    wait_until("both run", || entries(&log).len() == 2);
    assert_eq!(
        entries(&log),
        ["start:unconfirmed", "gain:ok"],
        "受付の順に実行され、開始は待たずに失敗する"
    );
    assert!(released.elapsed() < Duration::from_secs(2), "待たない");
    assert_eq!(observer.spawn_count(), 0, "新しい子を作らない");
    probe.terminate();
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// U4：C1。終わりを確かめられない記録があっても、停止とミュートは先に実行され、停止より前の開始は断る。
#[test]
fn u4_stop_and_mute_run_first_and_refuse_an_earlier_start_while_a_record_is_unconfirmed() {
    let (control, probe, observer) = control_with_live_record();
    let gate = hold(&control);
    let log = log();
    let start = control.admit(cmd("load_plugin"));
    let mute = control.admit(cmd("set_global_mute"));
    let stop = control.admit(stop_entry());
    start.post(launching(&log, "start")).unwrap();
    mute.post(record_into(&log, "mute")).unwrap();
    stop.post(record_into(&log, "stop")).unwrap();
    let released = Instant::now();
    gate.release();
    wait_until("all three run", || entries(&log).len() == 3);
    assert_eq!(
        entries(&log),
        ["mute:ok", "stop:ok", "start:StoppedFirst"],
        "停止とミュートが先、停止より前の開始は断る"
    );
    assert!(released.elapsed() < Duration::from_secs(2), "待たない");
    probe.terminate();
    let _ = std::fs::remove_dir_all(&observer.dir);
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

// Z29：呼び出し元の future を捨てても、後処理・所有物を持つ入口の本体は最後まで進む（detached）。
#[test]
fn z29_a_detached_entry_finishes_its_aftermath_even_if_the_caller_is_dropped() {
    let (host, observer) = scripted_parts([]);
    let control = AudioControl::new(host);
    let runtime = runtime();
    struct Guard(Arc<AtomicBool>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let guard_dropped = Arc::new(AtomicBool::new(false));
    let guard = Guard(guard_dropped.clone());
    let worker = control.clone();
    let caller = runtime.spawn(async move {
        crate::commands::detached(async move {
            let _guard = guard;
            worker
                .run_async(cmd("prepare_update"), |host| host.prepare_update().is_ok())
                .await
                .map_err(|error| error.text("x"))?;
            tokio::time::sleep(Duration::from_millis(300)).await;
            worker
                .run_async(cmd("finish_update_attempt"), |host| {
                    host.finish_update_attempt()
                })
                .await
                .map_err(|error| error.text("x"))?;
            Ok(())
        })
        .await
    });
    wait_until("the update is prepared", || {
        control.admission().accepted_of(EntryKind::Command) >= 1
    });
    caller.abort();
    let _ = runtime.block_on(caller);
    assert!(
        !guard_dropped.load(Ordering::SeqCst),
        "所有物は処理の完了まで保たれる"
    );
    wait_until("the aftermath runs", || {
        guard_dropped.load(Ordering::SeqCst)
    });
    let maintenance = control.run(normal(), |host| host.maintenance).unwrap();
    assert!(!maintenance, "取り消されても maintenance は解除される");
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// Z30：後処理・所有物を持つ入口は、共通の口（detached）を使う。
#[test]
fn z30_entries_with_aftermath_use_the_detached_door() {
    for (file, function) in [
        ("updates.rs", "pub async fn install_update"),
        (
            "temporary_session.rs",
            "pub(crate) async fn restart_temporary_session",
        ),
        ("migration.rs", "pub async fn apply_settings"),
        (
            "commands/voice_check.rs",
            "pub(crate) async fn analyze_voice_check",
        ),
    ] {
        let text = production_source(&src().join(file));
        let start = text
            .find(function)
            .unwrap_or_else(|| panic!("{file} に {function} が無い"));
        let end = text[start..].find("\n}\n").unwrap() + start;
        assert!(
            text[start..end].contains("detached("),
            "{file} の {function} が detached を使わない"
        );
    }
}
