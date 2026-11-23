//! F1b-0a-1：接続の土台の試験（T1〜T9・T13）。設計は docs/plans/audio-session-f1b0a-design.md の5章。
//! 実プロセスの子（試験の実行ファイル自身）と、写した通信路（`WriteDone` の差し替え）を使う。
use super::compat_support::*;
use super::link::CloseCause;
use super::link_seam::{self, reader_for};
use super::writer::{self, sinks, Payload, WriteDone, WriteResult};
use super::*;
use std::sync::atomic::AtomicU64;
use std::sync::mpsc;
use std::time::Duration;

const CC: &str = "audio-conditions-changed";
const EXITED: &str = "Engine Crashed/Exited";

static NEXT: AtomicU64 = AtomicU64::new(0);

/// 子を持たない、接続だけが開いている `AudioHost`。通知は記録する。
fn open_host() -> (AudioHost, Arc<emit::Recorder>) {
    let dir = std::env::temp_dir().join(format!(
        "auralyn-link-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let mut host = AudioHost::new(dir);
    let recorder = Arc::new(emit::Recorder::default());
    host.emitter.set(recorder.emitter());
    host.reset_engine_reader();
    (host, recorder)
}

fn done_with(result: WriteResult, flushed_at: Instant) -> mpsc::Receiver<WriteDone> {
    let (sender, receiver) = mpsc::channel();
    sender.send(WriteDone { result, flushed_at }).unwrap();
    receiver
}

/// A の命令（ProcessingState）の応答の期限。試験の継ぎ目の指定があれば、その値。
fn a_limit() -> Duration {
    writer::reply_limit(&IpcCommand::ProcessingState)
}

fn broken_pipe() -> WriteResult {
    WriteResult::Err(std::io::Error::new(
        std::io::ErrorKind::BrokenPipe,
        "broken pipe",
    ))
}

fn lock_host(f: &Fixture) -> super::control::HostLease<'_> {
    f.control
        .lock(control::Entry::command("link_test"))
        .unwrap()
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

fn names(recorder: &emit::Recorder) -> Vec<String> {
    recorder.names()
}

fn big_state() -> IpcCommand {
    // 状態を変えない命令で、前後の通知（dispatch）を挟まない。
    IpcCommand::GetPluginState {
        id: "A".repeat(4 * 1024 * 1024),
    }
}

// T1：C2。子が stdin を読まなくなる。書き込みが期限（試験では短くする）を過ぎたら、接続を切り離して子を終わらせる。
// 待つ間の別のスレッドの読み取りは、期限と回収の時間で返る。次の操作で作り直す。
#[test]
fn t1_c2_a_stalled_child_is_cut_off_after_the_write_limit_and_the_next_operation_respawns() {
    let f = Arc::new(Fixture::new([(
        "GetDevices",
        vec![
            response_line(&IpcResponse::Devices(Vec::new())),
            Step::StallStdin,
        ],
    )]));
    {
        let mut host = lock_host(&f);
        host.ensure_engine_running().unwrap();
        host.execute_running_command(IpcCommand::GetDevices)
            .unwrap();
    }
    let (locked, locked_signal) = mpsc::channel();
    let writer_thread = {
        let f = f.clone();
        std::thread::spawn(move || {
            writer::set_limits_for_test(Some(Duration::from_millis(300)), None);
            let mut host = lock_host(&f);
            locked.send(()).unwrap();
            let started = Instant::now();
            let result = host.execute_running_command(big_state());
            (
                result.map(|_| ()).map_err(|e| e.to_string()),
                started.elapsed(),
                host.link.cause(),
                host.child.is_none() && host.writer.is_none(),
            )
        })
    };
    locked_signal.recv_timeout(Duration::from_secs(5)).unwrap();
    let reader_thread = {
        let f = f.clone();
        std::thread::spawn(move || {
            let started = Instant::now();
            let state = lock_host(&f).get_state();
            (state.is_running, started.elapsed())
        })
    };
    let (result, elapsed, cause, detached) = writer_thread.join().unwrap();
    assert_eq!(result.unwrap_err(), WRITE_TIMED_OUT);
    assert!(elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(5));
    assert_eq!(cause, Some(CloseCause::WriteTimeout));
    assert!(detached, "子の回収・writer の破棄まで済んでいる");
    let (_, waited) = reader_thread.join().unwrap();
    assert!(
        waited < Duration::from_secs(5),
        "待つ間の読み取りも、期限と回収で返る: {waited:?}"
    );
    assert!(f.probe(0).wait_exit(5000), "子が終わっている");
    assert!(
        names(&f.recorder).iter().any(|name| name == "audio-error"),
        "主の切り離しは audio-error を出す"
    );
    let mut host = lock_host(&f);
    let generation = host.engine_generation;
    host.execute_command(IpcCommand::GetDevices).unwrap();
    assert_eq!(f.spawn_count(), 2, "次の操作で作り直す");
    assert!(host.engine_generation > generation);
}

// T2：書き込みの失敗は、先に届いていた応答より優先する。
#[test]
fn t2_a_write_failure_wins_over_an_early_response() {
    let (mut host, recorder) = open_host();
    let rx = link_seam::begin_request(&host, None).unwrap();
    assert!(link_seam::deliver(&host, IpcResponse::Success));
    let error = host
        .await_reply(Ok(done_with(broken_pipe(), Instant::now())), rx, a_limit())
        .unwrap_err();
    assert!(error.to_string().contains("broken pipe"));
    assert_eq!(host.link.cause(), Some(CloseCause::WriteFailed));
    assert!(names(&recorder).contains(&"audio-error".to_owned()));
}

// T2：EOF が先に競りに勝っていても、結果は書き込みの失敗。ただし通知は競りに勝った reader が出す。
#[test]
fn t2_when_eof_won_the_close_a_write_failure_still_decides_the_result_but_stays_silent() {
    let (mut host, recorder) = open_host();
    let rx = link_seam::begin_request(&host, None).unwrap();
    let _waiter = link_seam::win_eof(&host).expect("待ち手がいる");
    let error = host
        .await_reply(Ok(done_with(broken_pipe(), Instant::now())), rx, a_limit())
        .unwrap_err();
    assert!(error.to_string().contains("broken pipe"));
    assert_eq!(host.link.cause(), Some(CloseCause::Eof));
    assert!(!names(&recorder).contains(&"audio-error".to_owned()));
}

// T2：書き込みの失敗が競りに勝ったら、あとから来た EOF は通知を出さない。
#[test]
fn t2_when_the_write_failure_won_the_close_the_late_eof_emits_nothing() {
    let (mut host, recorder) = open_host();
    let reader = reader_for(&host, 0);
    let rx = link_seam::begin_request(&host, None).unwrap();
    host.await_reply(Ok(done_with(broken_pipe(), Instant::now())), rx, a_limit())
        .unwrap_err();
    recorder.clear();
    reader.finish();
    assert!(names(&recorder).is_empty());
}

// T2：`Aborted`（EOF で閉じていたので書かなかった）は書き込みの失敗にならず、EOF の結果を待つ。
#[test]
fn t2_aborted_is_not_a_write_failure_and_waits_for_the_eof_result() {
    for drop_the_sender in [false, true] {
        let (mut host, recorder) = open_host();
        let rx = link_seam::begin_request(&host, None).unwrap();
        let sender = link_seam::win_eof(&host).expect("待ち手がいる");
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            if drop_the_sender {
                drop(sender);
            } else {
                sender.send(ReplyOutcome::Eof).unwrap();
            }
        });
        let response = host
            .await_reply(
                Ok(done_with(WriteResult::Aborted, Instant::now())),
                rx,
                a_limit(),
            )
            .unwrap();
        release.join().unwrap();
        assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
        assert_eq!(host.engine_generation, 0, "接続を捨て直していない");
        assert!(!names(&recorder).contains(&"audio-error".to_owned()));
    }
}

// T3：応答の期限は `flushed_at` から数える。`WriteDone` の受け取りを遅らせても、期限は延びない。
#[test]
fn t3_the_reply_deadline_counts_from_flushed_at_not_from_when_the_done_is_received() {
    let (mut host, _) = open_host();
    let rx = link_seam::begin_request(&host, None).unwrap();
    let flushed_at = Instant::now() - Duration::from_millis(9_800);
    let started = Instant::now();
    let error = host
        .await_reply(Ok(done_with(WriteResult::Ok, flushed_at)), rx, a_limit())
        .unwrap_err();
    assert_eq!(error.to_string(), REPLY_TIMED_OUT);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "残りは約0.2秒: {:?}",
        started.elapsed()
    );
    // 期限切れ（C3）で接続を閉じる。待ちは残らず、閉じた接続が新しい要求を断る。
    assert_eq!(host.link.cause(), Some(CloseCause::ReplyTimeout));
    assert_eq!(
        link_seam::begin_request(&host, None)
            .unwrap_err()
            .to_string(),
        replies::CLOSED
    );
    // 受け取りが早ければ、期限の中の応答は採る。
    let (mut host, _) = open_host();
    let rx = link_seam::begin_request(&host, None).unwrap();
    let slot = link_seam::reply_slot(&host);
    let late = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        slot.deliver(IpcResponse::Success)
    });
    let response = host
        .await_reply(
            Ok(done_with(WriteResult::Ok, Instant::now())),
            rx,
            a_limit(),
        )
        .unwrap();
    assert!(late.join().unwrap());
    assert!(matches!(response, IpcResponse::Success));
}

// T4：EOF の処理が、接続の確認と `begin` の間に入っても、待ち手は期限を待たずに失敗する。
// 子は生きたまま標準出力だけを閉じ、標準入力は読み続ける（書き込みは成功しうる）。
#[test]
fn t4_eof_between_the_link_check_and_begin_fails_the_waiter_at_once() {
    let f = Fixture::new([(
        "SetInputChannels",
        vec![
            response_line(&IpcResponse::Success),
            Step::WaitGate("eof".into()),
            Step::CloseStdout,
        ],
    )]);
    writer::set_limits_for_test(None, Some(Duration::from_secs(2)));
    let mut host = lock_host(&f);
    host.ensure_engine_running().unwrap();
    host.execute_running_command(IpcCommand::SetInputChannels { left: 0, right: 1 })
        .unwrap();
    let link = host.link.clone();
    let observer_dir = f.dir.clone();
    before_begin_hook::set(move || {
        std::fs::write(observer_dir.join("gate-eof"), b"").unwrap();
        wait_until("reader が EOF を処理する", || !link.is_open());
    });
    let started = Instant::now();
    // 新しい順（LinkState を先に閉じる）：待ちの登録が拒否されるか、通って EOF の結果で解放される。
    // どちらも期限を待たず、切断として返る。
    let outcome = host.execute_running_command(IpcCommand::GetDevices);
    match outcome {
        Err(error) => assert_eq!(error.to_string(), replies::CLOSED),
        Ok(IpcResponse::Error(text)) => assert_eq!(text, EXITED),
        other => panic!("切断として返らない: {other:?}"),
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "応答の期限を待たない: {:?}",
        started.elapsed()
    );
    // 待ちの登録が拒否されたときは、書き込みへ進まない（通ったときは、書き込みは中止される）。
    assert_eq!(f.sent_after_start(), ["SetInputChannels"]);
}

// T5：EOF の通知が、待ち手の解放より先。通知が止まっている間は、待ち手は解放されない。
#[test]
fn t5_the_waiter_is_released_only_after_the_eof_notices_are_out() {
    let f = Arc::new(Fixture::new([("GetDevices", vec![Step::Exit])]));
    {
        let mut host = lock_host(&f);
        host.ensure_engine_running().unwrap();
    }
    f.recorder.clear();
    f.recorder.block_after(0);
    let (finished, finished_signal) = mpsc::channel();
    let caller = {
        let f = f.clone();
        std::thread::spawn(move || {
            let result = lock_host(&f).execute_running_command(IpcCommand::GetDevices);
            finished.send(()).unwrap();
            result
        })
    };
    wait_until("reader が通知で止まる", || {
        f.recorder.blocked_emits() == 1
    });
    assert!(
        finished_signal
            .recv_timeout(Duration::from_millis(300))
            .is_err(),
        "通知が終わるまで、呼び出しは戻らない"
    );
    f.recorder.release();
    let response = caller.join().unwrap().unwrap();
    assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
    assert_eq!(
        names(&f.recorder),
        [CC, "audio-engine-exited", "audio-error"]
    );
}

// T5：競りに負けた EOF（意図した切り離しが先）は通知を出さず、待ち手は切断で解放され、結果は EOF と同じ。
#[test]
fn t5_an_eof_that_lost_the_close_emits_nothing_and_the_waiter_maps_to_engine_exited() {
    let (host, recorder) = open_host();
    let reader = reader_for(&host, 0);
    let rx = link_seam::begin_request(&host, None).unwrap();
    assert!(host.link.close(CloseCause::Intentional));
    reader.finish();
    assert!(names(&recorder).is_empty());
    assert!(matches!(
        rx.recv_timeout(Duration::from_secs(1)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
    // 呼び出し側は、切断で解放された待ち手を今の EOF と同じ結果にする。
    let (mut host, _) = open_host();
    let rx = link_seam::begin_request(&host, None).unwrap();
    assert!(host.link.close(CloseCause::Intentional));
    host.close_connection(CloseCause::Intentional);
    let response = host
        .await_reply(
            Ok(done_with(WriteResult::Aborted, Instant::now())),
            rx,
            a_limit(),
        )
        .unwrap();
    assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
}

// T6：reader が列の途中の `emit` で止まったままでも、C2 で子は終わる。保持した通知は回収の後に出る。
#[test]
fn t6_c2_retires_the_child_while_the_reader_is_stuck_in_the_middle_of_a_chain() {
    let f = Arc::new(Fixture::new([(
        "GetDevices",
        vec![
            response_line(&IpcResponse::Devices(Vec::new())),
            event_line(&started_event(1)),
            Step::StallStdin,
        ],
    )]));
    {
        let mut host = lock_host(&f);
        host.ensure_engine_running().unwrap();
        f.recorder.clear();
        f.recorder.block_after(1);
        host.execute_running_command(IpcCommand::GetDevices)
            .unwrap();
    }
    wait_until("reader が列の途中で止まる", || {
        f.recorder.blocked_emits() == 1
    });
    assert_eq!(names(&f.recorder), [CC], "列の1つ目だけが出ている");
    let cutter = {
        let f = f.clone();
        std::thread::spawn(move || {
            writer::set_limits_for_test(Some(Duration::from_millis(300)), None);
            let mut host = lock_host(&f);
            let error = host.execute_running_command(big_state()).unwrap_err();
            (
                error.to_string(),
                host.retired.pending(engine_life::Role::Primary),
            )
        })
    };
    assert!(
        f.probe(0).wait_exit(5000),
        "通知が止まったままでも、子が回収される"
    );
    assert!(!cutter.is_finished(), "保持した通知は、回収の後に出す");
    f.recorder.release();
    let (error, pending) = cutter.join().unwrap();
    assert_eq!(error, WRITE_TIMED_OUT);
    assert_eq!(pending, 0, "終了を確かめて回収済み");
    assert_eq!(
        names(&f.recorder),
        [CC, "audio-started", CC, "audio-error", CC],
        "reader の列、回収の後の通知（kill の CC・audio-error）、dispatch の失敗の後の CC（今の順）"
    );
}

// T7：正常な応答の後も、同じ接続で次の命令が通る。
#[test]
fn t7_the_connection_keeps_working_after_a_normal_reply() {
    let f = Fixture::new([]);
    let mut host = lock_host(&f);
    host.ensure_engine_running().unwrap();
    for _ in 0..3 {
        assert!(matches!(
            host.execute_running_command(IpcCommand::GetDevices),
            Ok(IpcResponse::Success)
        ));
    }
    assert_eq!(f.spawn_count(), 1);
    assert_eq!(f.sent_after_start(), ["GetDevices"; 3]);
}

// T8：C5（主だけ）。子は生きていて stdout だけが閉じた。停止・読み取り・起動を禁じる操作では作り直さず、
// 起動しうる操作の時点で、旧の子を回収して作り直す。
#[test]
fn t8_c5_a_primary_child_whose_stdout_closed_is_replaced_only_by_an_operation_that_may_start_it() {
    let f = Fixture::new([(
        "GetDevices",
        vec![
            response_line(&IpcResponse::Devices(Vec::new())),
            Step::CloseStdout,
        ],
    )]);
    let mut host = lock_host(&f);
    host.ensure_engine_running().unwrap();
    host.execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    let link = host.link.clone();
    wait_until("EOF を処理する", || !link.is_open());
    assert_eq!(link.cause(), Some(CloseCause::Eof));
    assert!(!f.probe(0).exited(), "子は生きている");
    let generation = host.engine_generation;
    // 停止・読み取り・起動しない変更では作らない。
    assert!(host.stop().is_err());
    assert!(host
        .set_noise_control_config_routed(true, true, "smart".into(), 0.5, true)
        .is_err());
    assert!(host.get_state().is_running);
    assert_eq!(f.spawn_count(), 1);
    assert_eq!(host.engine_generation, generation);
    assert!(!f.probe(0).exited());
    // 起動しうる操作で、旧の子を回収して作り直す。
    host.execute_command(IpcCommand::SetInputChannels { left: 0, right: 1 })
        .unwrap();
    assert_eq!(f.spawn_count(), 2);
    assert!(f.probe(0).wait_exit(5000), "旧の PID が回収された");
    assert!(host.engine_generation > generation);
    assert!(host.link.is_open());
}

// T8：配信ミックスの子（post_role）は対象にしない。
#[test]
fn t8_c5_does_not_replace_a_post_mix_child_whose_stdout_closed() {
    let (mut child, observer) = scripted_parts([]);
    child.post_role = true;
    child.ensure_engine_running().unwrap();
    assert!(child.link.close(CloseCause::Eof));
    child.ensure_engine_running().unwrap();
    assert_eq!(observer.spawn_count(), 1);
    drop(child);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T9：通知の列の直前の確認。閉じた接続の列は出ない（全部か無し）。
#[test]
fn t9_a_closed_connection_emits_no_notice_chain() {
    let (host, recorder) = open_host();
    let epoch = host.conditions.new_engine();
    let reader = reader_for(&host, epoch);
    reader.handle_event(EngineEvent::EditorOpened { id: "a".into() });
    assert_eq!(names(&recorder), ["plugin-editor-opened"]);
    reader.handle_event(EngineEvent::Started {
        sample_rate: 48000,
        buffer_size: 512,
        stream_generation: Some(1),
    });
    assert_eq!(names(&recorder).len(), 3);
    assert!(host.link.close(CloseCause::Intentional));
    recorder.clear();
    reader.handle_event(EngineEvent::Started {
        sample_rate: 48000,
        buffer_size: 512,
        stream_generation: Some(1),
    });
    reader.handle_event(EngineEvent::EditorClosed { id: "a".into() });
    assert!(names(&recorder).is_empty());
}

// T9：ロックを待つ間に旧い接続になった場合も、その列は出ない。
#[test]
fn t9_a_chain_that_waited_for_the_order_lock_is_dropped_when_the_connection_closed_meanwhile() {
    let (host, recorder) = open_host();
    let epoch = host.conditions.new_engine();
    let reader = reader_for(&host, epoch);
    let notifier = host.emitter.clone();
    std::thread::scope(|scope| {
        notifier.chain(|_| {
            let waiting = scope.spawn(|| {
                reader.handle_event(EngineEvent::Started {
                    sample_rate: 48000,
                    buffer_size: 512,
                    stream_generation: Some(1),
                });
            });
            // 待つ側が、順序のロックを取る直前（接続の確認の前）に着いたことを確かめる。
            wait_until("列が順序のロックの前に着く", || {
                notifier.arrivals_for_test() == 1
            });
            assert!(host.link.close(CloseCause::Intentional));
            // 列のロックを放した後に、待っていた列の確認が走る。
            drop(waiting);
        });
    });
    assert!(names(&recorder).is_empty());
}

// T9・K13：同じ出来事の列の間に、別のスレッドの通知が入らない。
#[test]
fn t9_k13_a_chain_is_never_interleaved_with_notices_from_other_threads() {
    let (host, recorder) = open_host();
    let epoch = host.conditions.new_engine();
    let reader = reader_for(&host, epoch);
    let notifier = host.emitter.clone();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            for _ in 0..200 {
                reader.handle_event(EngineEvent::Started {
                    sample_rate: 48000,
                    buffer_size: 512,
                    stream_generation: Some(1),
                });
            }
        });
        scope.spawn(|| {
            for _ in 0..400 {
                notifier.emit("other", ());
            }
        });
    });
    let all = names(&recorder);
    assert_eq!(all.len(), 200 * 2 + 400);
    for (index, name) in all.iter().enumerate() {
        if name == CC {
            assert_eq!(all[index + 1], "audio-started", "列が割り込まれた: {index}");
        }
    }
}

// T13：`Drop`。writer が詰まっていても、共通の2秒で戻り、子は終わる。writer は join しない。
#[test]
fn t13_drop_returns_within_the_shared_window_even_when_the_writer_is_stuck() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    let gate = sinks::Gated::default();
    host.replace_writer_for_test(writer::Writer::start(gate.clone(), host.link.clone()));
    let probe = writer::Probe::default();
    let _done = host
        .writer
        .as_ref()
        .unwrap()
        .submit_probed(Payload::Json("stuck".into()), probe.clone())
        .unwrap();
    wait_until("writer が書き込みで止まる", || {
        probe.serialized.load(Ordering::Acquire)
    });
    // 失敗しても門を開けて、writer のスレッドが残らないようにする。
    struct OpenOnDrop(sinks::Gated);
    impl Drop for OpenOnDrop {
        fn drop(&mut self) {
            self.0.open();
        }
    }
    let _release = OpenOnDrop(gate.clone());
    // Drop の終わりを、別のスレッドから期限つきで受け取る。
    let (finished, finished_signal) = mpsc::channel();
    let started = Instant::now();
    let dropper = std::thread::spawn(move || {
        drop(host);
        let _ = finished.send(());
    });
    finished_signal
        .recv_timeout(Duration::from_secs(5))
        .expect("writer を待たずに、Drop が終わる");
    dropper.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(observer.probe(0).wait_exit(5000), "子は終わっている");
    assert!(
        !probe.finished.load(Ordering::Acquire),
        "writer はまだ止まったまま（join していない）"
    );
    gate.open();
    wait_until("writer が終わる", || {
        probe.finished.load(Ordering::Acquire)
    });
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// 閉じたリンクへの書き込みは始めない。`LinkState` を共有する writer が `Aborted` を返す。
#[test]
fn a_writer_that_shares_the_link_aborts_once_the_host_closes_it() {
    let (mut host, _) = open_host();
    let recording = sinks::Recording::default();
    host.writer = Some(writer::Writer::start(recording.clone(), host.link.clone()));
    host.link.close(CloseCause::Intentional);
    let done = host
        .writer
        .as_ref()
        .unwrap()
        .submit(Payload::Json("late".into()))
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert!(matches!(done.result, WriteResult::Aborted));
    assert!(recording.text().is_empty());
}

// P2 4：C2 の文言。子の終了を確かめられたときだけ「終了しました」。確かめられなければ `engine_unconfirmed`。
#[test]
fn p2_c2_message_depends_on_whether_the_exit_was_confirmed() {
    use super::engine_life::{seam, EngineUnconfirmed, Role};
    for confirmed in [true, false] {
        let (mut host, observer) = scripted_parts([]);
        host.ensure_engine_running().unwrap();
        let gate = sinks::Gated::default();
        host.replace_writer_for_test(writer::Writer::start(gate.clone(), host.link.clone()));
        writer::set_limits_for_test(Some(Duration::from_millis(200)), None);
        if !confirmed {
            seam::set_wait(seam::Wait::Stuck);
        }
        let error = host
            .execute_running_command(IpcCommand::GetDevices)
            .unwrap_err();
        gate.open();
        if confirmed {
            assert_eq!(error.to_string(), WRITE_TIMED_OUT);
            assert!(error.downcast_ref::<EngineUnconfirmed>().is_none());
            assert_eq!(host.retired.pending(Role::Primary), 0);
        } else {
            assert_eq!(
                error.downcast_ref::<EngineUnconfirmed>().copied(),
                Some(EngineUnconfirmed { repeated: false })
            );
            assert_eq!(error.to_string(), engine_life::UNCONFIRMED_JA);
            assert_eq!(host.retired.pending(Role::Primary), 1);
            // J-13：作り直しの要求が確かめられない回数を、同じ記録で数える。
            for _ in 0..3 {
                host.ensure_engine_running().unwrap_err();
            }
            assert!(host.retired.unconfirmed_error().repeated);
            seam::set_wait(seam::Wait::Real);
        }
        writer::set_limits_for_test(None, None);
        drop(host);
        let _ = std::fs::remove_dir_all(&observer.dir);
    }
}

fn mixing_selection() -> crate::audio_engine::mixing::Start {
    crate::audio_engine::mixing::Start {
        config: serde_json::from_value(serde_json::json!({
            "version": 1,
            "source": { "kind": "device", "config": { "host": "WASAPI", "inputId": "wasapi:one", "inputChannels": [0, 1] } },
            "levels": { "voice": { "gain": 1.0, "muted": false }, "accompaniment": { "gain": 1.0, "muted": false }, "monitorAccompaniment": true, "offsetMs": 0 }
        }))
        .unwrap(),
        target: None,
    }
}

// 6回目：reader は接続（`LinkCell`）を閉じるとき、待ち手の送り側も同じ区間で取り出す。閉じた直後で止めても、
// - 先に登録した待ち手は、writer の `Aborted` を経て、`Eof`（`Engine Crashed/Exited`）で解放される。
// - EOF の通知（K13 の3つの列）は欠けずに出る。
// - 配信ミックスの子とオケの入力の選択は残る（主の EOF で捨てない）。
#[test]
fn t4_a_reader_stopped_just_after_closing_the_link_still_releases_the_waiter_and_keeps_the_post_mix(
) {
    let (mut host, recorder) = open_host();
    let (mut post, post_observer) = scripted_parts([]);
    post.post_role = true;
    post.ensure_engine_running().unwrap();
    host.post_mix.adopt_child_for_test(post);
    host.mixing.selected = Some(mixing_selection());
    let epoch = host.conditions.new_engine();
    let rx = link_seam::begin_request(&host, None).expect("接続は開いている");
    let pause = reader::Pause::closed();
    let mut reader = reader_for(&host, epoch);
    reader.pause = Some(pause.clone());
    let finishing = std::thread::spawn(move || reader.finish());
    wait_until("reader が接続を閉じる", || !host.link.is_open());
    pause.release();
    let response = host
        .await_reply(
            Ok(done_with(WriteResult::Aborted, Instant::now())),
            rx,
            a_limit(),
        )
        .unwrap();
    finishing.join().unwrap();
    assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
    assert_eq!(
        names(&recorder),
        [CC, "audio-engine-exited", "audio-error"],
        "EOF の通知の列が欠けずに出る"
    );
    assert!(host.post_mix.has_child_for_test(), "配信ミックスの子は残る");
    assert!(host.mixing.selected.is_some(), "オケの入力の選択は残る");
    assert_eq!(host.link.cause(), Some(CloseCause::Eof));
    drop(host);
    let _ = std::fs::remove_dir_all(&post_observer.dir);
}

/// reader が EOF の競りに勝って、`Pause` で止まっている接続。
fn host_with_a_paused_eof_reader() -> (
    AudioHost,
    Arc<emit::Recorder>,
    reader::Pause,
    std::thread::JoinHandle<()>,
) {
    let (host, recorder) = open_host();
    let epoch = host.conditions.new_engine();
    let pause = reader::Pause::closed();
    let mut reader = reader_for(&host, epoch);
    reader.pause = Some(pause.clone());
    let finishing = link_seam::finish_eof(reader);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    (host, recorder, pause, finishing)
}

fn unsent_load() -> IpcCommand {
    IpcCommand::LoadPlugin {
        path: "C:/vst/unsent.vst3".into(),
        class_id: None,
    }
}

fn exited_payload(recorder: &emit::Recorder) -> serde_json::Value {
    recorder
        .events()
        .into_iter()
        .find(|(name, _)| name == "audio-engine-exited")
        .expect("終了の通知が出る")
        .1
}

// S1（F1b-0b-1 で反転済み。設計 9.8・T2）：書き込みを始めていない VST の操作は、終了の原因に載らない。
// (i) `begin` が先：登録は通るが writer は書かず（`Aborted`）、原因は `unknown`。待ち手は `Eof` で解放される。
// (ii) EOF の競りが先：`begin` は `CLOSED`。登録は起きない。
#[test]
fn an_unsent_vst_operation_is_not_named_as_the_exit_cause() {
    let (mut host, recorder) = open_host();
    let epoch = host.conditions.new_engine();
    let rx = link_seam::begin_request(&host, Some(&unsent_load())).unwrap();
    let pause = reader::Pause::closed();
    let mut reader = reader_for(&host, epoch);
    reader.pause = Some(pause.clone());
    let finishing = link_seam::finish_eof(reader);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    assert!(!host.link.mark_sent(), "writer は書かない（`Aborted`）");
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        pause.release();
    });
    let response = host
        .await_reply(
            Ok(done_with(WriteResult::Aborted, Instant::now())),
            rx,
            a_limit(),
        )
        .unwrap();
    release.join().unwrap();
    finishing.join().unwrap();
    assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
    assert_eq!(exited_payload(&recorder)["cause"], "unknown");

    let (host, recorder, pause, finishing) = host_with_a_paused_eof_reader();
    assert_eq!(
        link_seam::begin_request(&host, Some(&unsent_load()))
            .unwrap_err()
            .to_string(),
        replies::CLOSED
    );
    pause.release();
    finishing.join().unwrap();
    assert_eq!(exited_payload(&recorder)["cause"], "unknown");
}

// S4（F1b-0b-1 で反転済み。設計 9.8）：reader が EOF の競りに勝って止まっている間に、別の入口の
// `drop_connection` が走っても、待ち手の送り側は reader の手に残る。待ち手は、通知3件の後に `Eof` で解放される。
#[test]
fn a_host_close_before_the_eof_race_still_reports_the_exit_to_the_waiter() {
    let (mut host, recorder) = open_host();
    let epoch = host.conditions.new_engine();
    let rx = link_seam::begin_request(&host, None).unwrap();
    let pause = reader::Pause::closed();
    let mut reader = reader_for(&host, epoch);
    reader.pause = Some(pause.clone());
    let finishing = link_seam::finish_eof(reader);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    assert!(!host.drop_connection(CloseCause::Intentional));
    assert!(matches!(rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
    assert!(names(&recorder).is_empty(), "通知はまだ出ていない");
    pause.release();
    finishing.join().unwrap();
    assert_eq!(
        names(&recorder),
        [CC, "audio-engine-exited", "audio-error"],
        "通知3件の後に、待ち手が解放される"
    );
    assert!(matches!(rx.recv().unwrap(), ReplyOutcome::Eof));
}

// S5（F1b-0b-1 で反転済み。設計 9.8）：EOF が先に勝っていても、`cut_off`（書き込みの失敗）は記録に触れない。
// 終了の原因は、`cas_eof` が呼んだ `close_eof` が返した、本当の VST。
// 応答の期限切れ（`reply_timed_out`）も、負けたとき記録に触れない。
#[test]
fn cut_off_leaves_the_operation_as_the_exit_cause_when_eof_won() {
    for write_failure in [true, false] {
        let (mut host, _) = open_host();
        let load = IpcCommand::LoadPlugin {
            path: "C:/vst/crashing.vst3".into(),
            class_id: None,
        };
        let rx = link_seam::register_sent_operation(&host, &load);
        assert!(link_seam::cas_eof(&host));
        link_seam::mark_notified(&host);
        if write_failure {
            let error = host
                .await_reply(Ok(done_with(broken_pipe(), Instant::now())), rx, a_limit())
                .unwrap_err();
            assert!(error.to_string().contains("broken pipe"));
        } else {
            let response = host
                .await_reply(
                    Ok(done_with(
                        WriteResult::Ok,
                        Instant::now() - Duration::from_secs(40),
                    )),
                    rx,
                    Duration::from_secs(30),
                )
                .unwrap();
            assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
        }
        assert_eq!(host.link.cause(), Some(CloseCause::Eof));
        let exit = link_seam::take_exit(&host);
        assert_eq!(
            exit["cause"], "vst_operation",
            "負けた cut_off も期限切れも、記録に触れない（write_failure={write_failure}）"
        );
        assert_eq!(exit["op"], "load");
    }
}

// S6（今の挙動の固定。F1b-0b-4 で、期待値を `false` へ反転する。設計 9.8）：
// 接続の確認を通過していた1行の `VoiceCheckState` は、閉じた接続の reader でも `voice_activity` を立てる。
#[test]
fn s6_today_a_closed_reader_can_still_raise_voice_activity() {
    let (host, recorder) = open_host();
    let reader = reader_for(&host, 0);
    assert!(host.link.close(CloseCause::Intentional));
    host.voice_activity.store(false, Ordering::Release);
    reader.handle_event(EngineEvent::VoiceCheckState {
        state: "recording".into(),
        position_ms: 0,
        duration_ms: 0,
    });
    assert!(host.voice_activity.load(Ordering::Acquire));
    assert!(names(&recorder).is_empty(), "通知は出ない");
}
