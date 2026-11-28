//! activationの期限は呼出し側で管理し、遅い通知から新しい取得を再開しない。
use super::support::{wait, Event, Process};
use anyhow::{anyhow, bail, ensure, Result};
use std::{
    mem::{size_of, ManuallyDrop},
    sync::{
        atomic::{AtomicU8, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use windows::{
    core::{implement, IUnknown, Interface, Ref, HRESULT},
    Win32::{
        Media::Audio::{
            ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
            IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioClient,
            AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
            AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        },
        System::{
            Com::{
                StructuredStorage::{
                    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
                },
                BLOB,
            },
            Variant::VT_BLOB,
        },
    },
};

const PENDING: u8 = 0;
const COMPLETE: u8 = 1;
const ABANDONED: u8 = 2;
static OUTSTANDING: AtomicUsize = AtomicUsize::new(0);

struct Lease;
impl Lease {
    fn acquire() -> Result<Self> {
        ensure!(
            OUTSTANDING
                .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "前のactivationがまだ完了していません。検証プロセスを終了してから再試行してください"
        );
        Ok(Self)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        OUTSTANDING.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Payload {
    // Boxの位置を固定し、PROPVARIANTが指す領域を完了通知まで所有する。
    _params: Box<AUDIOCLIENT_ACTIVATION_PARAMS>,
    variant: Box<ManuallyDrop<PROPVARIANT>>,
    _lease: Lease,
}
// variantは不変で、唯一の生pointerは上で所有する不変のparamsを指す。
// COM interfaceやapartment固有の資源は含まない。PropVariantClearは外部メモリを解放するため呼ばない。
unsafe impl Send for Payload {}
unsafe impl Sync for Payload {}
impl Payload {
    fn new(pid: u32) -> Result<Self> {
        let lease = Lease::acquire()?;
        let mut params = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        });
        // windowsのPROPVARIANTのDropはPropVariantClearを呼ぶ。BLOBはRustのBoxが
        // 所有する借用領域なので、自動のCoTaskMemFreeを必ず抑止する。
        let variant = Box::new(ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                            pBlobData: std::ptr::from_mut(&mut *params).cast(),
                        },
                    },
                    ..Default::default()
                }),
            },
        }));
        Ok(Self {
            _params: params,
            variant,
            _lease: lease,
        })
    }
}

struct Completion {
    state: AtomicU8,
    event: Event,
    payload: Payload,
}
impl Completion {
    fn complete(&self) -> bool {
        self.state
            .compare_exchange(PENDING, COMPLETE, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
    fn abandon(&self) {
        // COMPLETE直後の取消も、開始成功として採用しない。
        self.state.store(ABANDONED, Ordering::Release);
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Handler {
    completion: Arc<Completion>,
}
impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        if self.completion.complete() {
            self.completion
                .event
                .signal()
                .map_err(|_| windows::core::Error::from_thread())?;
        }
        Ok(())
    }
}

pub fn activate(process: &Process, timeout: Duration, cancel: &Event) -> Result<IAudioClient> {
    ensure!(
        !timeout.is_zero() && timeout <= Duration::from_secs(30),
        "開始期限が不正です"
    );
    process.verify(process.created)?;
    ensure!(
        wait(&[cancel.raw()], Duration::ZERO)?.is_none(),
        "取得の開始は取消済みです"
    );
    let completion = Arc::new(Completion {
        state: AtomicU8::new(PENDING),
        event: Event::new(true)?,
        payload: Payload::new(process.pid)?,
    });
    let handler: IActivateAudioInterfaceCompletionHandler = Handler {
        completion: completion.clone(),
    }
    .into();
    let deadline = Instant::now() + timeout;
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(std::ptr::from_ref(&**completion.payload.variant)),
            &handler,
        )?
    };
    wait_for_completion(&completion, process, cancel, deadline)?;
    let mut status = HRESULT(0);
    let mut interface: Option<IUnknown> = None;
    unsafe { operation.GetActivateResult(&mut status, &mut interface)? };
    status.ok()?;
    let client = interface
        .ok_or_else(|| anyhow!("取得クライアントがありません"))?
        .cast()?;
    Ok(client)
}

fn wait_for_completion(
    completion: &Completion,
    process: &Process,
    cancel: &Event,
    deadline: Instant,
) -> Result<()> {
    if Instant::now() >= deadline {
        completion.abandon();
        bail!("取得の開始が期限を超えました");
    }
    // cancelを先に置き、通知と同時に到着しても取消を優先する。
    let result = wait(
        &[cancel.raw(), process.handle.0, completion.event.raw()],
        deadline.saturating_duration_since(Instant::now()),
    );
    match result {
        Ok(Some(2)) => {}
        other => {
            completion.abandon();
            match other {
                Ok(Some(0)) => bail!("取得の開始を取り消しました"),
                Ok(Some(1)) => bail!("取得の開始中に対象が終了しました"),
                Ok(None) => bail!("取得の開始が期限を超えました"),
                Err(error) => return Err(error),
                _ => bail!("取得の開始通知が不正です"),
            }
        }
    }
    if Instant::now() >= deadline
        || wait(&[cancel.raw(), process.handle.0], Duration::ZERO)?.is_some()
    {
        completion.abandon();
        bail!("取得の開始完了時に取消または対象終了を検出しました");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Com::IAgileObject;

    #[test]
    fn callback_is_agile_and_late_completion_does_not_revive_cancelled_request() {
        let completion = Arc::new(Completion {
            state: AtomicU8::new(PENDING),
            event: Event::new(true).unwrap(),
            payload: Payload::new(std::process::id()).unwrap(),
        });
        let weak = Arc::downgrade(&completion);
        let handler: IActivateAudioInterfaceCompletionHandler = Handler {
            completion: completion.clone(),
        }
        .into();
        assert!(handler.cast::<IAgileObject>().is_ok());
        let process = Process::open(std::process::id()).unwrap();
        let cancel = Event::new(true).unwrap();
        assert!(wait_for_completion(
            &completion,
            &process,
            &cancel,
            Instant::now() + Duration::from_millis(2)
        )
        .is_err());
        assert!(!completion.complete());
        assert_eq!(completion.state.load(Ordering::Acquire), ABANDONED);
        assert!(Payload::new(1).is_err());
        drop(completion);
        assert!(
            weak.upgrade().is_some(),
            "callbackがactivation引数の寿命を保持する"
        );
        drop(handler);
        assert!(weak.upgrade().is_none());
        assert!(Payload::new(1).is_ok());
    }
}
