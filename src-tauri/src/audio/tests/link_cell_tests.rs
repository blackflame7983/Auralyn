//! F1b-0b-1：`LinkCell` の試験のうち、reader・writer・Host をまたぐもの（設計 9.7 の T6・T8・T9）。
//! 遷移の表そのもの（T1・T2）は `link.rs`、`mark_sent`（T3）は `writer.rs`、配信ミックス（T5）は
//! `post_mix_life_tests.rs`、tick（T7）は `mode_vst.rs` にある。
use super::compat_support::*;
use super::link::CloseCause;
use super::link_seam;
use super::reader::Pause;
use super::writer::{self, WriteDone, WriteResult};
use super::*;
use std::sync::mpsc;
use std::time::Duration;

const EXITED: &str = "Engine Crashed/Exited";
const NOTICES: [&str; 3] = [
    "audio-conditions-changed",
    "audio-engine-exited",
    "audio-error",
];

fn done_with(result: WriteResult, flushed_at: Instant) -> mpsc::Receiver<WriteDone> {
    let (sender, receiver) = mpsc::channel();
    sender.send(WriteDone { result, flushed_at }).unwrap();
    receiver
}

fn expired() -> mpsc::Receiver<WriteDone> {
    done_with(WriteResult::Ok, Instant::now() - Duration::from_secs(12))
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "待っても起きない: {what}"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn count(observer: &Observer, name: &str) -> usize {
    observer
        .recorder
        .names()
        .iter()
        .filter(|seen| *seen == name)
        .count()
}

/// 応答しない子（門が開かない）を持つ接続。
fn silent_host() -> (AudioHost, Observer) {
    let (mut host, observer) =
        scripted_parts([("GetDevices", vec![Step::WaitGate("never".into())])]);
    host.ensure_engine_running().unwrap();
    observer.recorder.clear();
    (host, observer)
}

/// `f` が期限内に戻ることを確かめる（ロックを持たれていたら、ハングせずに失敗する）。
fn returns_promptly<R: Send + 'static>(what: &str, f: impl FnOnce() -> R + Send + 'static) -> R {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(f());
    });
    receiver
        .recv_timeout(Duration::from_secs(3))
        .unwrap_or_else(|_| panic!("ブロックしている: {what}"))
}

fn paused_eof_reader(host: &AudioHost) -> (Pause, std::thread::JoinHandle<()>) {
    let pause = Pause::closed();
    let mut reader = link_seam::reader_for(host, 0);
    reader.pause = Some(pause.clone());
    let finishing = link_seam::finish_eof(reader);
    wait_until("reader が EOF の競りに勝つ", || !host.link.is_open());
    (pause, finishing)
}

// T6：負けた `reply_timed_out` は、子を回収した後に「通知済み」を待つ。止めている間は戻らず、
// 待つ間も、別のスレッドの `is_open`・`begin`・`emit` はブロックしない。解放後、通知3件が出てから戻る。
// (i) 期限の後の応答を受け取り済みで、送り側が無い待ち手でも同じ。
#[test]
fn the_loser_waits_for_the_notices_without_holding_any_lock() {
    for late_response in [false, true] {
        let (mut host, observer) = silent_host();
        let rx = link_seam::begin_request(&host, None).unwrap();
        let limit = Duration::from_secs(10);
        let flushed_at = Instant::now() - Duration::from_secs(12);
        if late_response {
            let received_at = flushed_at + limit + Duration::from_secs(1);
            assert!(link_seam::deliver_at(
                &host,
                IpcResponse::Success,
                received_at
            ));
        }
        let (pause, reader_thread) = paused_eof_reader(&host);
        let link = host.link.clone();
        let notifier = host.emitter.clone();
        let caller = std::thread::spawn(move || {
            let response = host.await_reply(Ok(done_with(WriteResult::Ok, flushed_at)), rx, limit);
            (host, response)
        });
        assert!(observer.probe(0).wait_exit(5000), "子は回収される");
        std::thread::sleep(Duration::from_millis(200));
        assert!(!caller.is_finished(), "止めている間は戻らない");
        let probed = returns_promptly("待つ間の読み取り", move || {
            let open = link.is_open();
            let refused = link.begin(None).is_err();
            let closed = !link.close(CloseCause::Intentional);
            notifier.emit("probe", ());
            (open, refused, closed)
        });
        assert_eq!(probed, (false, true, true), "late_response={late_response}");
        assert!(!caller.is_finished());
        pause.release();
        let (host, response) = caller.join().unwrap();
        assert!(matches!(response.unwrap(), IpcResponse::Error(text) if text == EXITED));
        let names = observer.recorder.names();
        assert!(
            names.windows(3).any(|chain| chain == NOTICES),
            "戻った時点で、通知3件が出ている: {names:?}"
        );
        reader_thread.join().unwrap();
        assert_eq!(count(&observer, "audio-engine-exited"), 1);
        drop(host);
        let _ = std::fs::remove_dir_all(&observer.dir);
    }
}

// T6：「通知済み」は、通知の列を出し終えて順序のロックを放した後に立つ。reader が列の途中（`emit` の途中）で
// 止まっている間は、待ち手の「通知済み」の待ちは期限になる。列が終われば、待ちは起きる。
#[test]
fn the_notice_is_marked_only_after_the_chain_is_out() {
    let (mut host, observer) = scripted_parts([]);
    host.set_link_for_test(true);
    observer.recorder.block_after(1);
    let finishing = link_seam::finish_eof(link_seam::reader_for(&host, 0));
    wait_until("reader が列の途中で止まる", || {
        observer.recorder.blocked_emits() == 1
    });
    let link = host.link.clone();
    assert!(
        !returns_promptly("通知済みの待ち", move || {
            link.wait_notified(Instant::now() + Duration::from_millis(300))
        }),
        "列の途中では、通知済みになっていない"
    );
    let link = host.link.clone();
    let waiting =
        std::thread::spawn(move || link.wait_notified(Instant::now() + Duration::from_secs(5)));
    std::thread::sleep(Duration::from_millis(100));
    observer.recorder.release();
    finishing.join().unwrap();
    assert!(waiting.join().unwrap(), "列が終われば、待ちは起きる");
    assert_eq!(observer.recorder.names(), NOTICES);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T6 (ii)：上限。reader を解放しないと、`EOF_WAIT` の後に `Engine Crashed/Exited` で戻り、警告は1回だけ。
// そのあとで reader を解放しても、通知は1列だけ出る。
#[test]
fn the_wait_for_the_notices_is_capped_and_the_chain_is_not_doubled() {
    let (mut host, observer) = silent_host();
    let rx = link_seam::begin_request(&host, None).unwrap();
    let (pause, reader_thread) = paused_eof_reader(&host);
    writer::set_eof_wait_for_test(Some(Duration::from_millis(300)));
    let started = Instant::now();
    let response = host
        .await_reply(Ok(expired()), rx, Duration::from_secs(10))
        .unwrap();
    let elapsed = started.elapsed();
    writer::set_eof_wait_for_test(None);
    assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
    assert!(
        elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(3),
        "待ちに足された時間は上限の近く: {elapsed:?}"
    );
    assert_eq!(writer::eof_wait_exceeded_for_test(), 1, "警告は1回だけ");
    assert_eq!(count(&observer, "audio-engine-exited"), 0, "通知の前に返る");
    pause.release();
    reader_thread.join().unwrap();
    assert_eq!(count(&observer, "audio-engine-exited"), 1);
    let names = observer.recorder.names();
    assert_eq!(
        names.windows(3).filter(|chain| *chain == NOTICES).count(),
        1,
        "通知の列は1列だけ: {names:?}"
    );
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T6 (iii)：EOF 以外（書き込みの失敗）に負けたときは、通知の列が出ないので待たない。
#[test]
fn losing_to_something_other_than_eof_does_not_wait() {
    let (mut host, observer) = silent_host();
    let rx = link_seam::begin_request(&host, None).unwrap();
    assert!(host.link.close(CloseCause::WriteFailed));
    writer::set_eof_wait_for_test(Some(Duration::from_secs(10)));
    let started = Instant::now();
    let response = host
        .await_reply(Ok(expired()), rx, Duration::from_secs(10))
        .unwrap();
    let elapsed = started.elapsed();
    writer::set_eof_wait_for_test(None);
    assert!(matches!(response, IpcResponse::Error(text) if text == EXITED));
    assert!(
        elapsed < Duration::from_secs(3),
        "待たずに戻る: {elapsed:?}"
    );
    assert_eq!(writer::eof_wait_exceeded_for_test(), 0);
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T8：reader が `emit` の途中で止まっている間も、`LinkCell` のロックは持たれていない。
// `begin`・`close`・`cancel`・`mark_sent`・`deliver` は、ブロックせずに戻る。
#[test]
fn the_link_lock_is_not_held_while_the_reader_is_stuck_in_emit() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    observer.recorder.clear();
    observer.recorder.block_after(0);
    let reader = link_seam::reader_for(&host, 0);
    let finishing = link_seam::finish_eof(reader);
    wait_until("reader が通知で止まる", || {
        observer.recorder.blocked_emits() == 1
    });
    let link = host.link.clone();
    let outcome = returns_promptly("emit の途中の遷移", move || {
        let begin = link.begin(None).unwrap_err().to_string();
        let close = link.close(CloseCause::Intentional);
        link.cancel();
        let sent = link.mark_sent();
        let delivered = link.deliver(IpcResponse::Success);
        (begin, close, sent, delivered)
    });
    assert_eq!(
        outcome,
        (replies::CLOSED.to_owned(), false, false, false),
        "閉じた接続への遷移は、何もせずに戻る"
    );
    assert!(!finishing.is_finished(), "reader は通知で止まったまま");
    observer.recorder.release();
    finishing.join().unwrap();
    assert_eq!(observer.recorder.names(), NOTICES);
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// T9：鏡。`LinkCell` のロックを持たれていても、`is_open`・`cause`・通知の列の直前の確認は、ロックを待たずに戻る。
// 遷移の直後の鏡は `Closed` を示す。
#[test]
fn the_mirror_is_read_without_the_lock_and_follows_the_transitions() {
    let (host, observer) = scripted_parts([]);
    let link = Arc::new(super::link::LinkCell::open());
    let reader = reader::Reader {
        link: link.clone(),
        voice_activity: host.voice_activity.clone(),
        notifier: host.emitter.clone(),
        conditions: host.conditions.clone(),
        epoch: host.conditions.new_engine(),
        engine_generation: 1,
        pause: None,
    };
    let reads = link.hold_for_test(|| {
        let link = link.clone();
        returns_promptly(
            "ロックを持たれた間の鏡の読み取り",
            move || {
                reader.handle_event(EngineEvent::EditorOpened { id: "a".into() });
                (link.is_open(), link.cause())
            },
        )
    });
    assert_eq!(reads, (true, None));
    assert_eq!(observer.recorder.names(), ["plugin-editor-opened"]);
    assert!(link.close(CloseCause::WriteFailed));
    assert!(!link.is_open());
    assert_eq!(link.cause(), Some(CloseCause::WriteFailed));
    let _ = std::fs::remove_dir_all(&observer.dir);
}
