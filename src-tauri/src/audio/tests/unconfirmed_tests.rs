//! 終了を確かめられない子の記録（待たずに `engine_unconfirmed`）の試験。
//! 設計は docs/plans/audio-session-f1b0b-design.md の13章。保留・reaper・窓は J-28 で取り除いた。待ちは門で、時間切れは失敗の上限。
use super::compat_support::{scripted_parts, spawn_idle_process, Observer, ProcessProbe};
use super::control::{AudioControl, ControlError};
use super::engine_life::{EngineUnconfirmed, Role};
use super::queue_support::{cmd, entries, hold, log, record_into, stop_entry, wait_until, Log};
use super::reaper_seam;
use super::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

type Store = engine_life::Store;

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

// U5：案内を再起動に変えるかは、確かめた役割の記録だけで決める。別の役割にある終了済みの古い記録は数えない。
#[test]
fn u5_a_stale_exited_record_of_another_role_does_not_change_the_message() {
    let store = Store::default();
    let stale = spawn_idle_process();
    let stale_probe = ProcessProbe::open(stale.id()).unwrap();
    store.adopt_for_test(Role::PostMix, stale);
    reaper_seam::pass_deadline();
    stale_probe.terminate();
    assert!(stale_probe.wait_exit(5000));
    let fresh = spawn_idle_process();
    let fresh_probe = ProcessProbe::open(fresh.id()).unwrap();
    store.adopt_for_test(Role::Primary, fresh);
    assert_eq!(
        store.ensure_clear(Role::Primary),
        Err(EngineUnconfirmed { repeated: false }),
        "主の記録は新しい"
    );
    assert_eq!(
        store.unconfirmed_error(Role::Primary),
        EngineUnconfirmed { repeated: false }
    );
    fresh_probe.terminate();
}
