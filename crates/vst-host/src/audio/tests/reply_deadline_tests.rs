//! F1b-0a-2：応答の期限での切り離し（C3）の試験（T1・T3・T4・T9・T12・T13）。
//! 設計は docs/plans/audio-session-f1b0a2-design.md の5章。命令の分類（T5・T6）は `deadline.rs`、
//! モード VST（T7）は `mode_vst.rs`、配信ミックスの子（T2・T8）は `post_mix_life_tests.rs` にある。
use super::compat_support::*;
use super::engine_life::{seam, EngineUnconfirmed, Role};
use super::link::CloseCause;
use super::link_seam;
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

fn lock_host(f: &Fixture) -> super::control::HostLease<'_> {
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
    let mut reader = link_seam::reader_for(host, 0);
    reader.pause = Some(pause.clone());
    (pause, link_seam::finish_eof(reader))
}

/// このスレッドの子の回収（C3）が終わった時点で、止めた reader を解放する。
fn release_when_retired(pause: &Pause) {
    let pause = pause.clone();
    seam::on_stage(move |stage| {
        if matches!(stage, seam::Stage::Retired(_)) {
            pause.release();
        }
    });
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
// （J-13：期限を過ぎても残れば再起動の案内に変わるのも、書き込みの期限切れと同じ記録で見る）。
#[test]
fn t9_the_message_depends_on_whether_the_exit_was_confirmed() {
    for confirmed in [true, false] {
        let (mut host, observer) = silent_host();
        writer::set_limits_for_test(None, Some(SHORT));
        if !confirmed {
            reaper_seam::stuck();
        }
        let error = host
            .execute_running_command(IpcCommand::GetDevices)
            .unwrap_err();
        writer::set_limits_for_test(None, None);
        if confirmed {
            assert_eq!(error.to_string(), REPLY_TIMED_OUT);
            assert!(error.downcast_ref::<EngineUnconfirmed>().is_none());
            assert_eq!(reaper_seam::pending(&host, Role::Primary), 0);
        } else {
            assert_eq!(
                error.downcast_ref::<EngineUnconfirmed>().copied(),
                Some(EngineUnconfirmed { repeated: false })
            );
            assert_eq!(error.to_string(), engine_life::UNCONFIRMED_JA);
            assert_eq!(reaper_seam::pending(&host, Role::Primary), 1);
            assert!(!reaper_seam::unconfirmed(&host, Role::Primary).repeated);
            reaper_seam::pass_deadline();
            assert!(reaper_seam::unconfirmed(&host, Role::Primary).repeated);
            reaper_seam::real();
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
    let rx = host.link.begin(None).unwrap();
    let (pause, reader_thread) = paused_eof_reader(&host);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    release_when_retired(&pause);
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
    reader_thread.join().unwrap();
    assert_eq!(
        count(&observer, "audio-error"),
        1,
        "出すのは reader だけ（Host は出さない）"
    );
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// S3（F1b-0b-1 で反転済み。設計 9.8・T6）：期限の直前に reader が EOF の競りに勝っていると、負けた `reply_timed_out` は、
// 子を回収した後、reader が通知を出し終えるまで戻らない。解放後、通知3件が出てから `Engine Crashed/Exited` で戻る。
#[test]
fn the_c3_loser_waits_for_the_eof_notices() {
    let (mut host, observer) = silent_host();
    observer.recorder.clear();
    let rx = host.link.begin(None).unwrap();
    let (pause, reader_thread) = paused_eof_reader(&host);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    let link = host.link.clone();
    let caller = std::thread::spawn(move || {
        let response = host.await_reply(
            Ok(done_with(
                WriteResult::Ok,
                Instant::now() - Duration::from_secs(12),
            )),
            rx,
            Duration::from_secs(10),
        );
        (host, response)
    });
    wait_until("呼び出し側が通知済みの待ちに入る", || {
        link.waits_entered_for_test() == 1
    });
    assert!(observer.probe(0).wait_exit(5000), "子は回収されている");
    assert!(!caller.is_finished(), "reader を止めている間は戻らない");
    assert_eq!(count(&observer, "audio-engine-exited"), 0);
    pause.release();
    let (host, response) = caller.join().unwrap();
    assert!(matches!(response.unwrap(), IpcResponse::Error(text) if text == EXITED));
    let names = observer.recorder.names();
    assert_eq!(
        names[names.len() - 3..],
        [
            "audio-conditions-changed",
            "audio-engine-exited",
            "audio-error"
        ],
        "戻った時点で、EOF の通知3件が出ている"
    );
    assert!(host.child.is_none(), "子の回収は済んでいる");
    reader_thread.join().unwrap();
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
    let rx = link_seam::register_sent_operation(&host, &load);
    let (pause, reader_thread) = paused_eof_reader(&host);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    release_when_retired(&pause);
    host.await_reply(
        Ok(done_with(
            WriteResult::Ok,
            Instant::now() - Duration::from_secs(40),
        )),
        rx,
        Duration::from_secs(30),
    )
    .unwrap();
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

/// 期限切れで切り離し、そのとき出た通知の名前と、終了の通知の中身を返す。
fn cut_off_after_sending(command: IpcCommand) -> (Vec<String>, Option<serde_json::Value>) {
    let (mut host, observer) = silent_host();
    observer.recorder.clear();
    let rx = link_seam::register_sent_operation(&host, &command);
    host.await_reply(
        Ok(done_with(
            WriteResult::Ok,
            Instant::now() - Duration::from_secs(40),
        )),
        rx,
        Duration::from_secs(30),
    )
    .unwrap_err();
    assert_eq!(host.link.cause(), Some(CloseCause::ReplyTimeout));
    let names: Vec<String> = observer
        .recorder
        .names()
        .into_iter()
        .filter(|name| name.starts_with("audio-e"))
        .collect();
    let exited = observer
        .recorder
        .events()
        .into_iter()
        .find(|(name, _)| name == "audio-engine-exited")
        .map(|(_, payload)| payload);
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
    (names, exited)
}

// T16：固まった VST の操作が期限で切り離されると、reader の EOF と同じ通知（終了→旧の文字列の audio-error）が出る。
// 復旧画面が除外の候補を出せる。VST の操作でない命令は、今のまま「通信が切れました」だけ。
#[test]
fn t16_a_cut_off_vst_operation_is_reported_as_the_exit_cause() {
    let (names, exited) = cut_off_after_sending(IpcCommand::OpenEditor {
        id: "plugin-1".into(),
    });
    assert_eq!(
        names,
        ["audio-engine-exited", "audio-error"],
        "終了の通知、旧の audio-error の順に1回ずつ"
    );
    let exited = exited.unwrap();
    assert_eq!(exited["cause"], "vst_operation");
    assert_eq!(exited["op"], "open_editor");
    assert_eq!(exited["pluginId"], "plugin-1");
}

#[test]
fn t16_a_cut_off_command_that_is_not_a_vst_operation_keeps_the_plain_notice() {
    let (names, exited) = cut_off_after_sending(IpcCommand::GetDevices);
    assert_eq!(names, ["audio-error"]);
    assert!(exited.is_none());
}

// S7（F1b-0a-2 設計 9章の1点目）：B の命令 `Start` も、期限で切り離される。子は回収され、`Stop` は送られず、
// `audio-error` は1回。`Start` の `device_open` の記録は、作り直した接続へ持ち越されない。
// 10秒の互換の試験（`commands/audio/compat_tests.rs`）は、A の `SetChannelScan` のまま。
#[test]
fn s7_start_is_cut_off_at_its_deadline_retired_and_no_stop_is_sent() {
    for respawn in [false, true] {
        s7_attempt(respawn);
    }
}

/// `respawn` が偽なら、期限切れの直後の記録を確かめる。真なら、作り直しの後の記録だけを確かめる（記録は使い切らない）。
fn s7_attempt(respawn: bool) {
    let (mut host, observer) = scripted_parts([("Start", vec![Step::WaitGate("never".into())])]);
    host.ensure_engine_running().unwrap();
    let start = IpcCommand::Start {
        input_source: None,
        host: "WASAPI".into(),
        input: None,
        output: None,
        input_id: None,
        output_id: None,
        buffer_size: None,
        sample_rate: None,
        initial_controls: None,
        channel_routing: None,
    };
    assert_eq!(writer::reply_limit(&start), deadline::B);
    writer::set_limits_for_test(None, Some(SHORT));
    let started = Instant::now();
    let error = host.execute_command(start).unwrap_err();
    let elapsed = started.elapsed();
    writer::set_limits_for_test(None, None);
    assert_eq!(error.to_string(), REPLY_TIMED_OUT);
    assert!(
        elapsed >= SHORT && elapsed < Duration::from_secs(5),
        "{elapsed:?}"
    );
    assert_eq!(host.link.cause(), Some(CloseCause::ReplyTimeout));
    assert!(host.child.is_none() && host.writer.is_none(), "回収済み");
    assert!(!host.confirming_start);
    assert!(observer.probe(0).wait_exit(5000), "子が終わっている");
    assert!(!observer.sent().iter().any(|name| name == "Stop"));
    assert_eq!(count(&observer, "audio-error"), 1);
    if respawn {
        host.ensure_engine_running().unwrap();
        assert_eq!(observer.spawn_count(), 2, "次の操作で作り直す");
        assert_eq!(
            serde_json::to_value(host.link.exit_for_test()).unwrap()["cause"],
            "unknown",
            "作り直した接続へ、機器を開く記録を持ち越さない"
        );
    } else {
        assert_eq!(
            serde_json::to_value(host.link.exit_for_test()).unwrap()["cause"],
            "device_open",
            "期限切れの `Start` は、応答までの間、機器を開く記録を残す"
        );
    }
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

    let rx = host.link.begin(None).unwrap();
    assert!(host
        .link
        .deliver_at(IpcResponse::Success, flushed_at + Duration::from_secs(1)));
    let response = host
        .await_reply(Ok(done_with(WriteResult::Ok, flushed_at)), rx, limit)
        .unwrap();
    assert!(matches!(response, IpcResponse::Success));
    assert!(host.link.is_open() && host.child.is_some());

    let rx = host.link.begin(None).unwrap();
    assert!(host
        .link
        .deliver_at(IpcResponse::Success, flushed_at + Duration::from_secs(11)));
    let error = host
        .await_reply(Ok(done_with(WriteResult::Ok, flushed_at)), rx, limit)
        .unwrap_err();
    assert_eq!(error.to_string(), REPLY_TIMED_OUT);
    assert_eq!(host.link.cause(), Some(CloseCause::ReplyTimeout));
    assert_eq!(
        host.link.begin(None).unwrap_err().to_string(),
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
        let eof_reader = {
            let mut host = lock_host(&f);
            host.ensure_engine_running().unwrap();
            f.recorder.clear();
            f.recorder.block_after(1);
            host.execute_running_command(IpcCommand::GetDevices)
                .unwrap();
            link_seam::reader_for(&host, 0)
        };
        wait_until("reader が列の途中で止まる", || {
            f.recorder.blocked_emits() == 1
        });
        let retired = Arc::new(AtomicBool::new(false));
        let cutter = {
            let f = f.clone();
            let retired = retired.clone();
            std::thread::spawn(move || {
                seam::on_stage(move |stage| {
                    if matches!(stage, seam::Stage::Retired(Role::Primary)) {
                        retired.store(true, Ordering::SeqCst);
                    }
                });
                writer::set_limits_for_test(None, Some(Duration::from_millis(800)));
                let mut host = lock_host(&f);
                let outcome = host
                    .execute_running_command(IpcCommand::GetPluginState { id: "x".into() })
                    .map_err(|error| error.to_string());
                (outcome, reaper_seam::pending(&host, Role::Primary))
            })
        };
        let eof_finish = eof_wins.then(|| {
            wait_until("命令が子へ届く", || {
                f.sent().iter().any(|name| name == "GetPluginState")
            });
            link_seam::finish_eof(eof_reader)
        });
        assert!(
            f.probe(0).wait_exit(5000),
            "通知が止まったままでも、子が回収される（eof_wins={eof_wins}）"
        );
        wait_until("回収が終わる", || retired.load(Ordering::SeqCst));
        assert!(!cutter.is_finished(), "保持した通知は、回収の後に出す");
        assert_eq!(count(&f, "audio-engine-exited"), 0, "通知は止まっている");
        f.recorder.release();
        let (outcome, pending) = cutter.join().unwrap();
        if let Some(finish) = eof_finish {
            finish.join().unwrap();
        }
        if eof_wins {
            assert!(matches!(outcome, Ok(IpcResponse::Error(text)) if text == EXITED));
        } else {
            assert_eq!(outcome.unwrap_err(), REPLY_TIMED_OUT);
        }
        assert_eq!(pending, 0, "終了を確かめて回収済み");
        assert_eq!(
            count(&f, "audio-engine-exited"),
            1,
            "VST の操作の終了は、勝った側（EOF の reader か C3 の Host）が解放の後に1回出す"
        );
        if eof_wins {
            let names = f.recorder.names();
            assert!(
                names.windows(3).any(|chain| chain
                    == [
                        "audio-conditions-changed",
                        "audio-engine-exited",
                        "audio-error"
                    ]),
                "EOF の通知3件（audio-conditions-changed を含む）が続けて出る: {names:?}"
            );
        }
        assert_eq!(
            count(&f, "audio-error"),
            1,
            "出すのは1回。勝った側（C3 の Host か EOF の reader）だけ"
        );
    }
}
