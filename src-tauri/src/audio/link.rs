//! 子との接続が開いているかと、閉じた理由。一度だけ閉じる（CAS）。
//!
//! 勝敗が決めるのは「誰が終了の通知を出すか」だけ。回収（子・writer・応答の待ち）は勝敗に関係なく行う。
use std::sync::atomic::{AtomicU8, Ordering};

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
}

const OPEN: u8 = 0;

impl CloseCause {
    fn code(self) -> u8 {
        match self {
            Self::Intentional => 1,
            Self::Eof => 2,
            Self::WriteFailed => 3,
            Self::WriteTimeout => 4,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Intentional),
            2 => Some(Self::Eof),
            3 => Some(Self::WriteFailed),
            4 => Some(Self::WriteTimeout),
            _ => None,
        }
    }
}

pub(super) struct LinkState(AtomicU8);

impl LinkState {
    pub(super) fn open() -> Self {
        Self(AtomicU8::new(OPEN))
    }

    /// 子のいない状態。接続を作る前と、手放した後。
    pub(super) fn closed() -> Self {
        Self(AtomicU8::new(CloseCause::Intentional.code()))
    }

    pub(super) fn is_open(&self) -> bool {
        self.0.load(Ordering::Acquire) == OPEN
    }

    /// 開いていれば閉じて `true`。すでに閉じていれば何もせず `false`。
    pub(super) fn close(&self, cause: CloseCause) -> bool {
        self.0
            .compare_exchange(OPEN, cause.code(), Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(super) fn cause(&self) -> Option<CloseCause> {
        CloseCause::from_code(self.0.load(Ordering::Acquire))
    }

    /// 試験で、接続の状態を直接決める。
    #[cfg(test)]
    pub(super) fn set_open_for_test(&self, open: bool) {
        self.0.store(
            if open {
                OPEN
            } else {
                CloseCause::Intentional.code()
            },
            Ordering::Release,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_close_wins_and_its_cause_is_kept() {
        let link = LinkState::open();
        assert!(link.is_open() && link.cause().is_none());
        assert!(link.close(CloseCause::Eof));
        assert!(!link.close(CloseCause::WriteFailed));
        assert!(!link.close(CloseCause::Intentional));
        assert!(!link.is_open());
        assert_eq!(link.cause(), Some(CloseCause::Eof));
    }

    #[test]
    fn a_link_without_a_child_is_closed_and_never_wins() {
        let link = LinkState::closed();
        assert!(!link.is_open());
        assert!(!link.close(CloseCause::Eof));
    }

    #[test]
    fn exactly_one_of_many_racing_closers_wins() {
        for _ in 0..50 {
            let link = std::sync::Arc::new(LinkState::open());
            let wins = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let threads: Vec<_> = [
                CloseCause::Eof,
                CloseCause::WriteFailed,
                CloseCause::WriteTimeout,
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
}
