//! 子との接続の状態の正本。開閉・閉じた理由・応答の待ち・操作の記録を、1つのロックの下の状態機械にまとめる。
//!
//! 勝敗が決めるのは「誰が終了の通知を出すか」だけ。回収（子・writer・応答の待ち）は勝敗に関係なく行う。
//! ロックは葉。持つ間は、メモリの更新と待たない `mpsc` の送信・破棄だけをする。例外は `wait_notified` の待ち。
use super::engine_exit::{ExitPayload, OperationLog};
use super::replies::{ReplyOutcome, CLOSED};
use crate::ipc::{Command, Response};
use anyhow::{anyhow, Result};
#[cfg(test)]
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CloseCause {
    /// 意図した停止・再起動・手放し。通知なし。
    Intentional,
    /// 子の出力が閉じた。reader が通知を出す。
    Eof,
    /// 書き込みが失敗した。Host が通知を出す。
    WriteFailed,
    /// 書き込みが期限（5秒）を過ぎた。Host が通知を出す。
    WriteTimeout,
    /// 応答が命令の種類ごとの期限（10秒・30秒など）を過ぎた。Host が通知を出す。
    ReplyTimeout,
}

enum State {
    Idle,
    /// 応答を待っている（書き込みを始めたかどうかは操作の記録が持つ）。
    Waiting(Sender<ReplyOutcome>),
    Closed(CloseCause),
}

struct Inner {
    state: State,
    /// 勝った reader が、EOF の通知の列を出し終えた。`Closed(Eof)` のときだけ意味を持つ。
    eof_notified: bool,
    log: OperationLog,
}

/// EOF の競りに勝った reader が受け取るもの。
pub(super) struct EofWin {
    pub(super) waiter: Option<Sender<ReplyOutcome>>,
    pub(super) exit: ExitPayload,
}

enum Refused {
    Busy,
    Closed,
    Poisoned,
}

impl Refused {
    fn into_error(self) -> anyhow::Error {
        match self {
            Self::Busy => anyhow!(
                "前の音声操作の応答待ちです。しばらく待つか、エンジンを再起動してください。"
            ),
            Self::Closed => anyhow!(CLOSED),
            Self::Poisoned => anyhow!("IPC応答の状態を取得できません"),
        }
    }
}

pub(super) struct LinkCell {
    inner: Mutex<Inner>,
    notified: Condvar,
    /// 試験の継ぎ目：`wait_notified` に入った回数。
    #[cfg(test)]
    waits_entered: std::sync::atomic::AtomicUsize,
}

impl LinkCell {
    fn with(state: State) -> Self {
        Self {
            #[cfg(test)]
            waits_entered: std::sync::atomic::AtomicUsize::new(0),
            inner: Mutex::new(Inner {
                state,
                eof_notified: false,
                log: OperationLog::default(),
            }),
            notified: Condvar::new(),
        }
    }

    pub(super) fn open() -> Self {
        Self::with(State::Idle)
    }

    /// 子のいない状態。接続を作る前と、手放した後。
    pub(super) fn closed() -> Self {
        Self::with(State::Closed(CloseCause::Intentional))
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) fn is_open(&self) -> bool {
        !matches!(self.lock().state, State::Closed(_))
    }

    pub(super) fn cause(&self) -> Option<CloseCause> {
        match self.lock().state {
            State::Closed(cause) => Some(cause),
            State::Idle | State::Waiting(_) => None,
        }
    }

    /// 応答の待ちを登録する。`command` があれば、その操作の記録も始める。
    pub(super) fn begin(&self, command: Option<&Command>) -> Result<Receiver<ReplyOutcome>> {
        self.try_begin(command).map_err(Refused::into_error)
    }

    fn try_begin(&self, command: Option<&Command>) -> Result<Receiver<ReplyOutcome>, Refused> {
        let mut inner = self.inner.lock().map_err(|_| Refused::Poisoned)?;
        match inner.state {
            State::Waiting(_) => return Err(Refused::Busy),
            State::Closed(_) => return Err(Refused::Closed),
            State::Idle => {}
        }
        let (sender, receiver) = mpsc::channel();
        inner.state = State::Waiting(sender);
        match command {
            Some(command) => inner.log.begin(command, Instant::now()),
            None => inner.log.begin_untracked(),
        }
        Ok(receiver)
    }

    /// writer が書き込みの直前に呼ぶ。閉じていれば `false`（書かない）。
    pub(super) fn mark_sent(&self) -> bool {
        let mut inner = self.lock();
        match inner.state {
            State::Closed(_) => false,
            State::Waiting(_) => {
                inner.log.mark_sent();
                true
            }
            State::Idle => true,
        }
    }

    /// 今の時刻を `received_at` にして渡す。
    #[cfg(test)]
    pub(super) fn deliver(&self, response: Response) -> bool {
        self.deliver_at(response, Instant::now())
    }

    /// 応答を待ち手へ渡す。待ち手がなければ `false`（応答の ID・種類は照合しない）。
    pub(super) fn deliver_at(&self, response: Response, received_at: Instant) -> bool {
        let mut inner = self.lock();
        if matches!(inner.state, State::Closed(_)) {
            return false;
        }
        inner.log.response(&response, Instant::now());
        let State::Waiting(sender) = std::mem::replace(&mut inner.state, State::Idle) else {
            return false;
        };
        // 待ち手が受け取りをやめていても、応答の消費は完了する。
        let _ = sender.send(ReplyOutcome {
            resp: Box::new(response),
            received_at,
        });
        true
    }

    /// 待ちを取り消す。閉じた状態は変えない。
    pub(super) fn cancel(&self) {
        let mut inner = self.lock();
        if matches!(inner.state, State::Waiting(_)) {
            inner.state = State::Idle;
        }
    }

    /// reader の終端。EOF で閉じる競りに勝てば、待ち手の送り側と終了の原因を渡す。
    pub(super) fn close_eof(&self) -> Option<EofWin> {
        let mut inner = self.lock();
        if matches!(inner.state, State::Closed(_)) {
            return None;
        }
        let previous = std::mem::replace(&mut inner.state, State::Closed(CloseCause::Eof));
        let waiter = match previous {
            State::Waiting(sender) => Some(sender),
            State::Idle | State::Closed(_) => None,
        };
        let exit = inner.log.exit(Instant::now());
        Some(EofWin { waiter, exit })
    }

    /// 開いていれば閉じて `true`。すでに閉じていれば何もせず `false`。
    /// 勝てば、待ち手の送り側を捨てて解放し、原因ごとに操作の記録を片づける。
    pub(super) fn close(&self, cause: CloseCause) -> bool {
        let mut inner = self.lock();
        if matches!(inner.state, State::Closed(_)) {
            return false;
        }
        drop(std::mem::replace(&mut inner.state, State::Closed(cause)));
        match cause {
            CloseCause::WriteFailed | CloseCause::WriteTimeout => inner.log.abandon(),
            CloseCause::ReplyTimeout => inner.log.timeout(),
            CloseCause::Intentional | CloseCause::Eof => {}
        }
        true
    }

    /// EOF の通知の列を出し終えたことを知らせる。通知の列のロックを放した後に呼ぶ。
    pub(super) fn mark_notified(&self) {
        self.lock().eof_notified = true;
        self.notified.notify_all();
    }

    /// EOF の通知が出し終わるのを、絶対期限まで待つ。待つ間はロックを放す。
    pub(super) fn wait_notified(&self, deadline: Instant) -> bool {
        #[cfg(test)]
        self.waits_entered.fetch_add(1, Ordering::AcqRel);
        let mut inner = self.lock();
        loop {
            if inner.eof_notified {
                return true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            inner = match self.notified.wait_timeout(inner, remaining) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }

    /// 試験で、接続の状態を直接決める。
    #[cfg(test)]
    pub(super) fn set_open_for_test(&self, open: bool) {
        let mut inner = self.lock();
        inner.state = if open {
            State::Idle
        } else {
            State::Closed(CloseCause::Intentional)
        };
        inner.eof_notified = false;
    }

    /// 試験で、`wait_notified` に入った回数。
    #[cfg(test)]
    pub(super) fn waits_entered_for_test(&self) -> usize {
        self.waits_entered.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(super) fn with_log_for_test<R>(&self, f: impl FnOnce(&mut OperationLog) -> R) -> R {
        f(&mut self.lock().log)
    }

    /// 試験で、操作の記録から終了の原因を採る（接続は閉じない）。
    #[cfg(test)]
    pub(super) fn exit_for_test(&self) -> ExitPayload {
        self.lock().log.exit(Instant::now())
    }

    #[cfg(test)]
    pub(super) fn shape_for_test(&self) -> Shape {
        match self.lock().state {
            State::Idle => Shape::Idle,
            State::Waiting(_) => Shape::Waiting,
            State::Closed(cause) => Shape::Closed(cause),
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Shape {
    Idle,
    Waiting,
    Closed(CloseCause),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::ChannelLayout;
    use std::sync::Arc;
    use std::time::Duration;

    fn load() -> Command {
        Command::LoadPlugin {
            path: "C:/VST/Echo.vst3".into(),
            class_id: None,
        }
    }

    fn started() -> Response {
        Response::Started {
            sample_rate: 48000,
            buffer_size: 512,
            routing: None,
            input_id: None,
            output_id: None,
            stream_generation: Some(1),
        }
    }

    fn start() -> Command {
        Command::Start {
            host: "ASIO".into(),
            input: None,
            output: None,
            input_source: None,
            input_id: None,
            output_id: None,
            buffer_size: None,
            sample_rate: None,
            initial_controls: None,
            channel_routing: None,
        }
    }

    fn response_of(outcome: ReplyOutcome) -> Response {
        *outcome.resp
    }

    fn cause_of(exit: &ExitPayload) -> String {
        serde_json::to_value(exit).unwrap()["cause"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn only_the_first_close_wins_and_its_cause_is_kept() {
        let link = LinkCell::open();
        assert!(link.is_open() && link.cause().is_none());
        assert!(link.close(CloseCause::Eof));
        assert!(!link.close(CloseCause::WriteFailed));
        assert!(!link.close(CloseCause::Intentional));
        assert!(!link.is_open());
        assert_eq!(link.cause(), Some(CloseCause::Eof));
    }

    #[test]
    fn a_link_without_a_child_is_closed_and_never_wins() {
        let link = LinkCell::closed();
        assert!(!link.is_open());
        assert!(!link.close(CloseCause::Eof));
        assert!(link.close_eof().is_none());
    }

    #[test]
    fn exactly_one_of_many_racing_closers_wins() {
        for _ in 0..50 {
            let link = Arc::new(LinkCell::open());
            let wins = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let threads: Vec<_> = [
                CloseCause::Eof,
                CloseCause::WriteFailed,
                CloseCause::WriteTimeout,
                CloseCause::ReplyTimeout,
                CloseCause::Intentional,
            ]
            .into_iter()
            .map(|cause| {
                let (link, wins) = (link.clone(), wins.clone());
                std::thread::spawn(move || {
                    if link.close(cause) {
                        wins.fetch_add(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
            for thread in threads {
                thread.join().unwrap();
            }
            assert_eq!(wins.load(Ordering::SeqCst), 1);
        }
    }

    // T2：`begin` と `close_eof` は同じロックの区間。どちらが先でも、閉じた接続に登録は残らず、
    // 書き込みを始めていない操作は原因に載らない。
    #[test]
    fn begin_and_close_eof_race_in_either_order_without_leaving_a_registration() {
        for _ in 0..300 {
            let link = Arc::new(LinkCell::open());
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let begin = {
                let (link, barrier) = (link.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    link.begin(Some(&load())).map(|_| ())
                })
            };
            let close = {
                let (link, barrier) = (link.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    link.close_eof()
                })
            };
            let began = begin.join().unwrap();
            let win = close.join().unwrap().expect("EOF が勝つ");
            assert_eq!(link.shape_for_test(), Shape::Closed(CloseCause::Eof));
            assert_eq!(cause_of(&win.exit), "unknown", "未送信は載らない");
            match began {
                Ok(()) => assert!(
                    win.waiter.is_some(),
                    "先に登録したなら、送り側は reader の手にある"
                ),
                Err(error) => {
                    assert_eq!(error.to_string(), CLOSED);
                    assert!(win.waiter.is_none());
                }
            }
            assert!(!link.mark_sent());
        }
    }

    #[test]
    fn begin_registers_once_and_the_shape_follows_the_transitions() {
        let link = LinkCell::open();
        assert_eq!(link.shape_for_test(), Shape::Idle);
        let _rx = link.begin(Some(&load())).unwrap();
        assert_eq!(link.shape_for_test(), Shape::Waiting);
        assert!(link.with_log_for_test(|log| log.in_flight_for_test()));
        assert!(link
            .begin(None)
            .unwrap_err()
            .to_string()
            .contains("前の音声操作の応答待ちです"));
        assert!(link.mark_sent());
        assert_eq!(link.shape_for_test(), Shape::Waiting);
        assert!(link.begin(None).is_err(), "書き込み中も待ちは1件");
        assert!(link.mark_sent(), "二度目も書いてよい");
        assert!(link.deliver(Response::Success));
        assert_eq!(link.shape_for_test(), Shape::Idle);
        assert!(link.begin(None).is_ok());
    }

    #[test]
    fn mark_sent_without_a_registration_writes_and_a_closed_link_refuses() {
        let link = LinkCell::open();
        assert!(link.mark_sent());
        assert_eq!(link.shape_for_test(), Shape::Idle);
        assert!(link.close(CloseCause::Eof));
        assert!(!link.mark_sent());
        assert_eq!(link.shape_for_test(), Shape::Closed(CloseCause::Eof));
    }

    #[test]
    fn a_closed_link_refuses_begin_with_the_closed_message_and_never_reopens() {
        let link = LinkCell::open();
        let waiter = link.begin(None).unwrap();
        assert!(link.close(CloseCause::Intentional));
        assert!(matches!(
            waiter.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
        assert_eq!(link.begin(None).unwrap_err().to_string(), CLOSED);
        assert!(!link.deliver(Response::Success), "閉じた後の応答は捨てる");
        link.cancel();
        assert_eq!(link.begin(None).unwrap_err().to_string(), CLOSED);
        assert_eq!(
            link.shape_for_test(),
            Shape::Closed(CloseCause::Intentional)
        );
    }

    #[test]
    fn a_lost_close_leaves_the_waiter_and_the_log_alone() {
        let link = LinkCell::open();
        let waiter = link.begin(Some(&load())).unwrap();
        assert!(link.mark_sent());
        let win = link.close_eof().expect("EOF が勝つ");
        assert!(!link.close(CloseCause::WriteFailed));
        assert!(!link.close(CloseCause::ReplyTimeout));
        assert_eq!(cause_of(&win.exit), "vst_operation");
        drop(win.waiter.expect("送り側は reader の手にある"));
        assert!(waiter.recv().is_err());
    }

    // T4：負けた `close` は、操作の記録に触れない。終了の原因は、先に閉じた側が採る本当の VST のまま。
    #[test]
    fn a_lost_close_does_not_clear_the_operation_record() {
        for cause in [
            CloseCause::WriteFailed,
            CloseCause::WriteTimeout,
            CloseCause::ReplyTimeout,
        ] {
            let link = LinkCell::open();
            let _rx = link.begin(Some(&load())).unwrap();
            assert!(link.mark_sent());
            assert!(link.close(CloseCause::Eof));
            assert!(!link.close(cause));
            assert_eq!(
                cause_of(&link.exit_for_test()),
                "vst_operation",
                "{cause:?}"
            );
        }
    }

    #[test]
    fn close_eof_hands_over_the_sender_and_the_cause_exactly_once() {
        let link = LinkCell::open();
        let _waiter = link.begin(Some(&load())).unwrap();
        link.mark_sent();
        assert!(link.close_eof().is_some_and(|win| win.waiter.is_some()));
        assert!(link.close_eof().is_none());
        assert_eq!(link.cause(), Some(CloseCause::Eof));
        let idle = LinkCell::open();
        let win = idle.close_eof().unwrap();
        assert!(win.waiter.is_none());
        assert_eq!(cause_of(&win.exit), "unknown");
    }

    #[test]
    fn the_exit_cause_is_the_sent_operation_then_a_valid_settling_then_unknown() {
        let link = LinkCell::open();
        let _rx = link.begin(Some(&load())).unwrap();
        assert_eq!(
            cause_of(&link.exit_for_test()),
            "unknown",
            "未送信は載らない"
        );

        let link = LinkCell::open();
        let _rx = link.begin(Some(&load())).unwrap();
        link.mark_sent();
        assert_eq!(cause_of(&link.exit_for_test()), "vst_operation");

        for sent in [false, true] {
            let link = LinkCell::open();
            let _rx = link.begin(Some(&start())).unwrap();
            link.mark_sent();
            link.deliver(started());
            let _rx = link.begin(Some(&load())).unwrap();
            if sent {
                link.mark_sent();
            }
            let expected = if sent { "vst_operation" } else { "device_open" };
            assert_eq!(cause_of(&link.exit_for_test()), expected, "sent={sent}");
        }
    }

    #[test]
    fn close_clears_the_operation_by_cause() {
        for (cause, in_flight) in [
            (CloseCause::WriteFailed, false),
            (CloseCause::WriteTimeout, false),
            (CloseCause::ReplyTimeout, false),
            (CloseCause::Intentional, true),
        ] {
            let link = LinkCell::open();
            let _rx = link.begin(Some(&load())).unwrap();
            link.mark_sent();
            assert!(link.close(cause));
            assert_eq!(
                link.with_log_for_test(|log| log.in_flight_for_test()),
                in_flight,
                "{cause:?}"
            );
        }
    }

    #[test]
    fn a_response_goes_to_the_waiter_with_its_received_at_and_an_idle_response_only_updates_the_log(
    ) {
        let link = LinkCell::open();
        let waiter = link.begin(None).unwrap();
        let stamp = Instant::now() - Duration::from_secs(3);
        assert!(link.deliver_at(Response::Success, stamp));
        let ReplyOutcome { received_at, resp } = waiter.recv().unwrap();
        assert_eq!(received_at, stamp);
        assert!(matches!(*resp, Response::Success));
        let loaded = Response::PluginLoaded {
            id: "id-a".into(),
            name: "Echo".into(),
            vendor: "Maker".into(),
            class_id: None,
            legacy_class_ambiguous: false,
            channel_layout: ChannelLayout::Stereo,
        };
        let _rx = link.begin(Some(&load())).unwrap();
        link.cancel();
        assert!(!link.deliver(loaded), "待ち手がいなければ false");
        assert_eq!(link.with_log_for_test(|log| log.plugin_count_for_test()), 1);
    }

    #[test]
    fn cancel_returns_to_idle_and_releases_the_waiter() {
        let link = LinkCell::open();
        let waiter = link.begin(None).unwrap();
        link.cancel();
        assert!(waiter.recv().is_err());
        assert!(!link.deliver(Response::Error("unsolicited".into())));
        assert!(link.begin(None).is_ok());
    }

    #[test]
    fn a_response_that_beats_the_close_is_delivered_once() {
        let link = LinkCell::open();
        let waiter = link.begin(None).unwrap();
        assert!(link.deliver(Response::Success));
        assert!(matches!(
            response_of(waiter.recv().unwrap()),
            Response::Success
        ));
        assert!(link.close_eof().is_some_and(|win| win.waiter.is_none()));
    }

    #[test]
    fn notified_wakes_the_waiter_and_an_absolute_deadline_returns_false() {
        let link = Arc::new(LinkCell::open());
        link.close_eof().unwrap();
        let waiting = {
            let link = link.clone();
            std::thread::spawn(move || link.wait_notified(Instant::now() + Duration::from_secs(5)))
        };
        std::thread::sleep(Duration::from_millis(50));
        link.mark_notified();
        assert!(waiting.join().unwrap());
        assert!(
            link.wait_notified(Instant::now()),
            "通知済みなら期限が過ぎていても true"
        );

        let late = LinkCell::open();
        late.close_eof().unwrap();
        let started = Instant::now();
        assert!(!late.wait_notified(started + Duration::from_millis(100)));
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(100) && waited < Duration::from_secs(2));
    }

    #[test]
    fn spurious_wakeups_do_not_extend_the_absolute_deadline() {
        let link = Arc::new(LinkCell::open());
        link.close_eof().unwrap();
        let poker = {
            let link = link.clone();
            std::thread::spawn(move || {
                for _ in 0..100 {
                    std::thread::sleep(Duration::from_millis(10));
                    link.notified.notify_all();
                }
            })
        };
        let started = Instant::now();
        assert!(!link.wait_notified(started + Duration::from_millis(150)));
        assert!(started.elapsed() < Duration::from_millis(500));
        poker.join().unwrap();
    }

    #[test]
    fn waiting_for_the_notice_does_not_hold_the_lock() {
        let link = Arc::new(LinkCell::open());
        link.close_eof().unwrap();
        let waiting = {
            let link = link.clone();
            std::thread::spawn(move || {
                link.wait_notified(Instant::now() + Duration::from_millis(400))
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        assert!(!link.is_open());
        assert!(link.begin(None).is_err());
        assert!(!link.close(CloseCause::Intentional));
        assert!(started.elapsed() < Duration::from_millis(300));
        assert!(!waiting.join().unwrap());
    }

    #[test]
    fn a_poisoned_lock_refuses_begin_with_its_message_and_every_other_transition_proceeds() {
        let link = Arc::new(LinkCell::open());
        let poisoner = {
            let link = link.clone();
            std::thread::spawn(move || {
                let _guard = link.inner.lock().unwrap();
                panic!("lock を汚す");
            })
        };
        assert!(poisoner.join().is_err());
        assert_eq!(
            link.begin(None).unwrap_err().to_string(),
            "IPC応答の状態を取得できません"
        );
        assert!(!link.deliver(Response::Success));
        link.cancel();
        assert!(link.mark_sent());
        link.mark_notified();
        assert!(link.is_open());
        assert!(link.close_eof().is_some());
        assert!(!link.close(CloseCause::Intentional));
    }
}
