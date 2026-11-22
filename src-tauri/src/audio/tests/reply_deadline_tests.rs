//! F1b-0a-2：応答の期限での切り離し（C3）の試験（T1・T3・T4・T9・T12・T13）。
//! 設計は docs/plans/audio-session-f1b0a2-design.md の5章。命令の分類（T5・T6）は `deadline.rs`、
//! モード VST（T7）は `mode_vst.rs`、配信ミックスの子（T2・T8）は `post_mix_life_tests.rs` にある。
use super::compat_support::*;
use super::engine_life::{seam, EngineUnconfirmed, Role};
use super::link::CloseCause;
use super::reader::Pause;
use super::writer::{self, WriteDone, WriteResult};
use super::*;
use std::sync::mpsc;
use std::time::Duration;

const EXITED: &str = "Engine Crashed/Exited";
const SHORT: Duration = Duration::from_millis(400);

fn done_with(result: WriteResult, flushed_at: Instant) -> mpsc::Receiver<WriteDone> {
    let (sender, receiver) = mpsc::channel();
    sender.send(WriteDone { result, flushed_at }).unwrap();
    receiver
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "待っても起きない: {what}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn lock_host(f: &Fixture) -> std::sync::MutexGuard<'_, AudioHost> {
    f.control
        .lock(control::Entry::command("reply_deadline_test"))
        .unwrap()
}

fn count(observer: &Observer, name: &str) -> usize {
    observer
        .recorder
        .names()
        .iter()
        .filter(|seen| *seen == name)
        .count()
}

/// 応答しない子（門が開かない）に、`GetDevices` を送る。
fn silent_host() -> (AudioHost, Observer) {
    let (mut host, observer) =
        scripted_parts([("GetDevices", vec![Step::WaitGate("never".into())])]);
    host.ensure_engine_running().unwrap();
    (host, observer)
}

fn paused_eof_reader(host: &AudioHost) -> (Pause, std::thread::JoinHandle<()>) {
    let pause = Pause::closed();
    let reader = reader::Reader {
        link: host.link.clone(),
        operations: host.vst_operations.clone(),
        replies: host.pending_reply_tx.clone(),
        voice_activity: host.voice_activity.clone(),
        notifier: host.emitter.clone(),
        conditions: host.conditions.clone(),
        epoch: 0,
        engine_generation: 1,
        pause: Some(pause.clone()),
    };
    (pause, std::thread::spawn(move || reader.finish()))
}

// T1：C3（主）。応答が来ないと、期限で失敗し、`LinkState` は `ReplyTimeout`、子は回収され、`audio-error` が出る。
// 次の命令（停止を含む）は「応答待ち」で断られず、停止は送られない。次の操作で作り直す。
#[test]
fn t1_c3_an_unanswered_command_is_cut_off_at_its_deadline_and_the_next_operation_respawns() {
    let (mut host, observer) = silent_host();
    writer::set_limits_for_test(None, Some(SHORT));
    let started = Instant::now();
    let error = host
        .execute_running_command(IpcCommand::GetDevices)
        .unwrap_err();
    let elapsed = started.elapsed();
    writer::set_limits_for_test(None, None);
    assert_eq!(error.to_string(), REPLY_TIMED_OUT);
    assert!(
        elapsed >= SHORT && elapsed < Duration::from_secs(5),
        "{elapsed:?}"
    );
    assert_eq!(host.link.cause(), Some(CloseCause::ReplyTimeout));
    assert!(host.child.is_none() && host.writer.is_none(), "回収済み");
    assert!(observer.probe(0).wait_exit(5000), "子が終わっている");
    assert_eq!(count(&observer, "audio-error"), 1);

    let stop = host.stop();
    let waiting = "前の音声操作の応答待ちです";
    assert!(
        stop.err()
            .is_none_or(|error| !error.to_string().contains(waiting)),
        "停止が応答待ちで断られない"
    );
    assert!(!observer.sent().iter().any(|name| name == "Stop"));

    let generation = host.engine_generation;
    host.execute_command(IpcCommand::SetInputChannels { left: 0, right: 1 })
        .unwrap();
    assert_eq!(observer.spawn_count(), 2, "次の操作で作り直す");
    assert!(host.engine_generation > generation);
    assert_eq!(
        observer.sent().last().map(String::as_str),
        Some("SetInputChannels")
    );
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T9：文言。子の終了を確かめられたときだけ「終了しました」。確かめられなければ `engine_unconfirmed`
// （J-13 の数え方も、書き込みの期限切れと同じ記録で数える）。
#[test]
fn t9_the_message_depends_on_whether_the_exit_was_confirmed() {
    for confirmed in [true, false] {
        let (mut host, observer) = silent_host();
        writer::set_limits_for_test(None, Some(SHORT));
        if !confirmed {
            seam::set_wait(seam::Wait::Stuck);
        }
        let error = host
            .execute_running_command(IpcCommand::GetDevices)
            .unwrap_err();
        writer::set_limits_for_test(None, None);
        if confirmed {
            assert_eq!(error.to_string(), REPLY_TIMED_OUT);
            assert!(error.downcast_ref::<EngineUnconfirmed>().is_none());
            assert_eq!(host.retired.pending(Role::Primary), 0);
        } else {
            assert_eq!(
                error.downcast_ref::<EngineUnconfirmed>().copied(),
                Some(EngineUnconfirmed { repeated: false })
            );
            assert_eq!(error.to_string(), engine_life::UNCONFIRMED_JA);
            assert_eq!(host.retired.pending(Role::Primary), 1);
            for _ in 0..3 {
                host.ensure_engine_running().unwrap_err();
            }
            assert!(host.retired.unconfirmed_error().repeated);
            seam::set_wait(seam::Wait::Real);
        }
        drop(host);
        let _ = std::fs::remove_dir_all(&observer.dir);
    }
}

// T3：期限の直前に reader が EOF の競りに勝っていた。結果は今の EOF と同じ `Engine Crashed/Exited`。
// Host は `audio-error` を出さず（通知は reader が出す）、子は無条件に回収する。
#[test]
fn t3_when_eof_won_the_race_the_deadline_reports_the_exit_silently_and_still_retires_the_child() {
    let (mut host, observer) = silent_host();
    observer.recorder.clear();
    let (pause, reader_thread) = paused_eof_reader(&host);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    let rx = host.pending_reply_tx.begin().unwrap();
    let response = host
        .await_reply(
            Ok(done_with(
                WriteResult::Ok,
                Instant::now() - Duration::from_secs(12),
            )),
            rx,
            Duration::from_secs(10),
        )
        .unwrap();
    assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
    assert_eq!(
        host.link.cause(),
        Some(CloseCause::Eof),
        "理由は EOF のまま"
    );
    assert!(host.child.is_none(), "子は回収される");
    assert!(observer.probe(0).wait_exit(5000));
    assert_eq!(count(&observer, "audio-error"), 0, "Host は出さない");
    pause.release();
    reader_thread.join().unwrap();
    assert_eq!(count(&observer, "audio-error"), 1, "出すのは reader だけ");
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T13：競りに負けたとき、`vst_operations` を書き換えない。終了の通知の原因は、reader が採る本当の VST。
#[test]
fn t13_a_lost_race_leaves_the_vst_operation_as_the_exit_cause() {
    let (mut host, observer) = silent_host();
    let load = IpcCommand::LoadPlugin {
        path: "C:/vst/crashing.vst3".into(),
        class_id: None,
    };
    host.vst_operations.begin(&load);
    let (pause, reader_thread) = paused_eof_reader(&host);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    let rx = host.pending_reply_tx.begin().unwrap();
    host.await_reply(
        Ok(done_with(
            WriteResult::Ok,
            Instant::now() - Duration::from_secs(40),
        )),
        rx,
        Duration::from_secs(30),
    )
    .unwrap();
    pause.release();
    reader_thread.join().unwrap();
    let exited = observer
        .recorder
        .events()
        .into_iter()
        .find(|(name, _)| name == "audio-engine-exited")
        .expect("終了の通知が出る")
        .1;
    assert_eq!(exited["cause"], "vst_operation");
    assert_eq!(exited["op"], "load");
    assert_eq!(exited["path"], "C:/vst/crashing.vst3");
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T4：期限は届いた時刻（`received_at`）で判定する。期限を過ぎていても受け側を1回読み、期限の内に届いた応答は採る。
// 期限の後に届いた応答は、受け取りが遅れなくても期限切れで、閉じて回収するところまで進む。
#[test]
fn t4_the_deadline_is_judged_by_received_at_even_when_the_receive_is_late() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    let limit = Duration::from_secs(10);
    let flushed_at = Instant::now() - Duration::from_secs(12);

    let rx = host.pending_reply_tx.begin().unwrap();
    assert!(host
        .pending_reply_tx
        .deliver_at(IpcResponse::Success, flushed_at + Duration::from_secs(1)));
    let response = host
        .await_reply(Ok(done_with(WriteResult::Ok, flushed_at)), rx, limit)
        .unwrap();
    assert!(matches!(response, IpcResponse::Success));
    assert!(host.link.is_open() && host.child.is_some());

    let rx = host.pending_reply_tx.begin().unwrap();
    assert!(host
        .pending_reply_tx
        .deliver_at(IpcResponse::Success, flushed_at + Duration::from_secs(11)));
    let error = host
        .await_reply(Ok(done_with(WriteResult::Ok, flushed_at)), rx, limit)
        .unwrap_err();
    assert_eq!(error.to_string(), REPLY_TIMED_OUT);
    assert_eq!(host.link.cause(), Some(CloseCause::ReplyTimeout));
    assert_eq!(
        host.pending_reply_tx.begin().unwrap_err().to_string(),
        replies::CLOSED,
        "待ちが閉じる"
    );
    assert!(host.child.is_none());
    assert!(observer.probe(0).wait_exit(5000), "子が回収される");
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T12：I3。reader が `emit` の途中で止まったままでも、C3 の競りの勝ち・負けのどちらでも、子の回収が終わる。
// 保持した通知は、回収の後に出る。
#[test]
fn t12_the_retire_finishes_while_the_reader_is_stuck_in_emit_whether_c3_wins_or_loses() {
    for eof_wins in [false, true] {
        let f = Arc::new(Fixture::new([
            (
                "GetDevices",
                vec![
                    response_line(&IpcResponse::Devices(Vec::new())),
                    event_line(&started_event(1)),
                ],
            ),
            ("GetPluginState", vec![Step::WaitGate("never".into())]),
        ]));
        let link = {
            let mut host = lock_host(&f);
            host.ensure_engine_running().unwrap();
            f.recorder.clear();
            f.recorder.block_after(1);
            host.execute_running_command(IpcCommand::GetDevices)
                .unwrap();
            host.link.clone()
        };
        wait_until("reader が列の途中で止まる", || {
            f.recorder.blocked_emits() == 1
        });
        let cutter = {
            let f = f.clone();
            std::thread::spawn(move || {
                writer::set_limits_for_test(None, Some(Duration::from_millis(800)));
                let mut host = lock_host(&f);
                let outcome = host
                    .execute_running_command(IpcCommand::GetPluginState { id: "x".into() })
                    .map_err(|error| error.to_string());
                (outcome, host.retired.pending(Role::Primary))
            })
        };
        if eof_wins {
            wait_until("命令が子へ届く", || {
                f.sent().iter().any(|name| name == "GetPluginState")
            });
            assert!(link.close(CloseCause::Eof), "reader の競りの勝ちを再現する");
        }
        assert!(
            f.probe(0).wait_exit(5000),
            "通知が止まったままでも、子が回収される（eof_wins={eof_wins}）"
        );
        assert!(!cutter.is_finished(), "保持した通知は、回収の後に出す");
        f.recorder.release();
        let (outcome, pending) = cutter.join().unwrap();
        if eof_wins {
            assert!(matches!(outcome, Ok(IpcResponse::Error(text)) if text == EXITED));
        } else {
            assert_eq!(outcome.unwrap_err(), REPLY_TIMED_OUT);
        }
        assert_eq!(pending, 0, "終了を確かめて回収済み");
        assert_eq!(
            count(&f, "audio-error"),
            usize::from(!eof_wins),
            "勝ったときだけ Host が出す"
        );
    }
}
