//! 終了を確かめられない子の記録（待たずに `engine_unconfirmed`）の試験。
//! 設計は docs/plans/audio-session-f1b0b-design.md の13章。保留・reaper・窓は J-28 で取り除いた。待ちは門で、時間切れは失敗の上限。
use super::compat_support::{spawn_idle_process, ProcessProbe};
use super::engine_life::{EngineUnconfirmed, Role};
use super::reaper_seam;
use super::*;
use std::time::{Duration, Instant};

type Store = engine_life::Store;

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "時間内に成立しなかった: {what}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
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
