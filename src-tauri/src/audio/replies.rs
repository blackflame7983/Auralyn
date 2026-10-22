//! 要求IDを持たない直列IPCの応答待機を管理する。
use crate::ipc::Response;
use anyhow::{anyhow, Result};
use std::sync::{mpsc, Mutex};

#[derive(Default)]
pub(super) struct ReplySlot(Mutex<Option<mpsc::Sender<Response>>>);

impl ReplySlot {
    pub(super) fn begin(&self) -> Result<mpsc::Receiver<Response>> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| anyhow!("IPC応答の状態を取得できません"))?;
        if pending.is_some() {
            return Err(anyhow!(
                "前の音声操作の応答待ちです。しばらく待つか、エンジンを再起動してください。"
            ));
        }
        let (tx, rx) = mpsc::channel();
        *pending = Some(tx);
        Ok(rx)
    }

    pub(super) fn deliver(&self, response: Response) -> bool {
        let Ok(mut pending) = self.0.lock() else {
            return false;
        };
        if let Some(tx) = pending.take() {
            // タイムアウト済みなら送信先はないが、古い応答の消費は完了する。
            let _ = tx.send(response);
            true
        } else {
            false
        }
    }

    pub(super) fn cancel(&self) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn timed_out_response_cannot_complete_a_later_request() {
        let slot = ReplySlot::default();
        let first = slot.begin().unwrap();
        assert!(first.recv_timeout(Duration::ZERO).is_err());
        drop(first);
        assert!(slot.begin().is_err());
        assert!(slot.deliver(Response::Error("late response".into())));
        let second = slot.begin().unwrap();
        assert!(second.try_recv().is_err());
        assert!(slot.deliver(Response::Error("second response".into())));
        assert!(matches!(second.recv().unwrap(), Response::Error(s) if s == "second response"));
    }

    #[test]
    fn exit_and_send_failure_release_the_waiter() {
        let slot = ReplySlot::default();
        let first = slot.begin().unwrap();
        slot.deliver(Response::Error("exited".into()));
        assert!(matches!(first.recv().unwrap(), Response::Error(s) if s == "exited"));
        let second = slot.begin().unwrap();
        slot.cancel();
        assert!(second.recv().is_err());
        assert!(!slot.deliver(Response::Error("unsolicited".into())));
        assert!(slot.begin().is_ok());
    }
}
