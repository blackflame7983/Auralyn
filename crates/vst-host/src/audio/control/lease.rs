//! 試験専用：実行のスレッドがホストを箱ごと貸し出す。貸している間、実行のスレッドは次の仕事を取り出さない。
//!
//! ホストは貸した相手のスレッドの上で動くので、`thread_local!`の継ぎ目はそのまま効く。
use super::{AudioControl, ControlError};
use crate::audio::AudioHost;
use std::marker::PhantomData;
use std::ops::{Deref, DerefMut};
use std::sync::mpsc::{Receiver, SyncSender};

/// 実行のスレッドが持つ側。ホストを渡し、返ってくるのを待つ。
pub(super) struct LeaseGrant {
    pub(super) grant: SyncSender<Result<Box<AudioHost>, ControlError>>,
    pub(super) back: Receiver<(Box<AudioHost>, bool)>,
}

/// 借りた側。`Drop`でホストを返す。持ったまま panic していれば、返す時に poison を立てる。
pub(crate) struct HostLease<'a> {
    host: Option<Box<AudioHost>>,
    back: SyncSender<(Box<AudioHost>, bool)>,
    _control: PhantomData<&'a AudioControl>,
}

impl<'a> HostLease<'a> {
    pub(super) fn new(host: Box<AudioHost>, back: SyncSender<(Box<AudioHost>, bool)>) -> Self {
        Self {
            host: Some(host),
            back,
            _control: PhantomData,
        }
    }
}

impl Deref for HostLease<'_> {
    type Target = AudioHost;
    fn deref(&self) -> &AudioHost {
        self.host.as_deref().expect("the lease holds the host")
    }
}

impl DerefMut for HostLease<'_> {
    fn deref_mut(&mut self) -> &mut AudioHost {
        self.host.as_deref_mut().expect("the lease holds the host")
    }
}

impl Drop for HostLease<'_> {
    fn drop(&mut self) {
        if let Some(host) = self.host.take() {
            let _ = self.back.send((host, std::thread::panicking()));
        }
    }
}
