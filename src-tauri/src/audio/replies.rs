//! 要求IDを持たない直列IPCの応答待機を管理する。
//!
//! 葉のロック。I/O も `emit` もしない。
use crate::ipc::Response;
use anyhow::{anyhow, Result};
use std::sync::{mpsc, Mutex};
use std::time::Instant;

pub(super) const CLOSED: &str = "音声エンジンとの通信が終了しました";

/// 待ち手が受け取る結果。送り側が捨てられた場合（`Disconnected`）は、呼び出し側が EOF と同じに扱う。
pub(super) enum ReplyOutcome {
    /// `received_at` は reader が応答の行を読んだ時刻。受け取りが遅れても、期限の判定はこの時刻で行う。
    Response {
        resp: Box<Response>,
        received_at: Instant,
    },
    /// 子の出力が閉じた。通知は出し終えている。
    Eof,
}

enum State {
    Idle,
    Waiting(mpsc::Sender<ReplyOutcome>),
    Closed,
}

pub(super) struct ReplySlot(Mutex<State>);

impl Default for ReplySlot {
    fn default() -> Self {
        Self(Mutex::new(State::Idle))
    }
}

impl ReplySlot {
    pub(super) fn begin(&self) -> Result<mpsc::Receiver<ReplyOutcome>> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| anyhow!("IPC応答の状態を取得できません"))?;
        match &*state {
            State::Waiting(_) => Err(anyhow!(
                "前の音声操作の応答待ちです。しばらく待つか、エンジンを再起動してください。"
            )),
            State::Closed => Err(anyhow!(CLOSED)),
            State::Idle => {
                let (tx, rx) = mpsc::channel();
                *state = State::Waiting(tx);
                Ok(rx)
            }
        }
    }

    /// 今の時刻を `received_at` にして渡す。
    #[cfg(test)]
    pub(super) fn deliver(&self, response: Response) -> bool {
        self.deliver_at(response, Instant::now())
    }

    /// 応答を待ち手へ渡す。待ち手がなければ `false`（応答の ID・種類は照合しない）。
    pub(super) fn deliver_at(&self, response: Response, received_at: Instant) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if !matches!(&*state, State::Waiting(_)) {
            return false;
        }
        let State::Waiting(tx) = std::mem::replace(&mut *state, State::Idle) else {
            return false;
        };
        // 待ち手が受け取りをやめていても、応答の消費は完了する。
        let _ = tx.send(ReplyOutcome::Response {
            resp: Box::new(response),
            received_at,
        });
        true
    }

    /// 待ちを取り消す。閉じた状態は変えない。
    pub(super) fn cancel(&self) {
        if let Ok(mut state) = self.0.lock() {
            if matches!(&*state, State::Waiting(_)) {
                *state = State::Idle;
            }
        }
    }

    /// 試験で、閉じた状態を開き直す（接続の状態を直接決める試験用）。
    #[cfg(test)]
    pub(super) fn reopen_for_test(&self) {
        let mut state = self.0.lock().unwrap();
        if matches!(&*state, State::Closed) {
            *state = State::Idle;
        }
    }

    /// 一度だけ閉じる。以後の `begin` は失敗する。保留中の送り側を取り出して返す。
    pub(super) fn close(&self) -> Option<mpsc::Sender<ReplyOutcome>> {
        let mut state = match self.0.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        match std::mem::replace(&mut *state, State::Closed) {
            State::Waiting(tx) => Some(tx),
            State::Idle | State::Closed => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn response(outcome: ReplyOutcome) -> Response {
        match outcome {
            ReplyOutcome::Response { resp, .. } => *resp,
            ReplyOutcome::Eof => panic!("EOF ではなく応答のはず"),
        }
    }

    // F1b-0a-2：応答の期限切れは、呼び出し側が待ちを閉じる。遅い応答は捨てられ、同じスロットは使い直さない。
    #[test]
    fn a_timed_out_request_closes_the_slot_and_a_late_response_is_dropped() {
        let slot = ReplySlot::default();
        let first = slot.begin().unwrap();
        assert!(first.recv_timeout(Duration::ZERO).is_err());
        assert!(slot.begin().is_err(), "期限の後も、閉じるまでは待ちが残る");
        let sender = slot.close().expect("待ち手の送り側を取り出せる");
        drop(sender);
        assert!(matches!(
            first.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
        assert_eq!(slot.begin().unwrap_err().to_string(), CLOSED);
        assert!(!slot.deliver(Response::Error("late response".into())));
        assert_eq!(slot.begin().unwrap_err().to_string(), CLOSED);
    }

    // `received_at` は渡した時刻のまま届く（受け取りの遅れで変わらない）。
    #[test]
    fn the_received_at_stamp_travels_with_the_response() {
        let slot = ReplySlot::default();
        let waiter = slot.begin().unwrap();
        let stamp = Instant::now() - Duration::from_secs(3);
        assert!(slot.deliver_at(Response::Success, stamp));
        match waiter.recv().unwrap() {
            ReplyOutcome::Response { received_at, .. } => assert_eq!(received_at, stamp),
            ReplyOutcome::Eof => panic!("応答のはず"),
        }
    }

    #[test]
    fn exit_and_send_failure_release_the_waiter() {
        let slot = ReplySlot::default();
        let first = slot.begin().unwrap();
        slot.deliver(Response::Error("exited".into()));
        assert!(matches!(response(first.recv().unwrap()), Response::Error(s) if s == "exited"));
        let second = slot.begin().unwrap();
        slot.cancel();
        assert!(second.recv().is_err());
        assert!(!slot.deliver(Response::Error("unsolicited".into())));
        assert!(slot.begin().is_ok());
    }

    #[test]
    fn a_closed_slot_refuses_begin_and_releases_the_waiter_exactly_once() {
        let slot = ReplySlot::default();
        let waiter = slot.begin().unwrap();
        let sender = slot.close().expect("保留中の送り側を取り出せる");
        assert!(slot.close().is_none(), "二度目は取り出せない");
        assert_eq!(slot.begin().unwrap_err().to_string(), CLOSED);
        assert!(!slot.deliver(Response::Success), "閉じた後の応答は捨てる");
        sender.send(ReplyOutcome::Eof).unwrap();
        assert!(matches!(waiter.recv().unwrap(), ReplyOutcome::Eof));
        slot.cancel();
        assert!(slot.begin().is_err(), "取り消しでは開かない");
    }

    #[test]
    fn dropping_the_extracted_sender_disconnects_the_waiter() {
        let slot = ReplySlot::default();
        let waiter = slot.begin().unwrap();
        drop(slot.close());
        assert!(matches!(
            waiter.recv_timeout(Duration::from_secs(1)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        ));
    }

    #[test]
    fn closing_an_idle_slot_still_closes_it() {
        let slot = ReplySlot::default();
        assert!(slot.close().is_none());
        assert!(slot.begin().is_err());
    }
}
