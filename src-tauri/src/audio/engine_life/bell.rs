//! 記録の変化を、列を見ている実行のスレッドへ知らせる。
use std::sync::{Mutex, PoisonError};

type Wake = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub(in crate::audio) struct Bell {
    wake: Mutex<Option<Wake>>,
}

impl Bell {
    pub(in crate::audio) fn register(&self, wake: Wake) {
        *self.wake.lock().unwrap_or_else(PoisonError::into_inner) = Some(wake);
    }

    /// `Store.slots` を放してから呼ぶ。登録された列は、自分のロックを取って起こす。
    pub(in crate::audio) fn ring(&self) {
        let guard = self.wake.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(wake) = guard.as_ref() {
            wake();
        }
    }
}
