use crate::ipc::{Command, EngineEvent};
use std::sync::{
    atomic::{AtomicU64, AtomicU8, Ordering::SeqCst},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};

// 網羅的な対応表にして、新しいコマンドの診断漏れを防ぐ。
macro_rules! command_kinds {
    ($($name:ident),+ $(,)?) => {
        #[repr(u8)]
        pub(super) enum Kind { $($name),+ }

        impl Kind {
            fn of(command: &Command) -> Self {
                match command { $(Command::$name { .. } => Self::$name),+ }
            }

            fn name(code: u8) -> &'static str {
                match code {
                    $(value if value == Self::$name as u8 => stringify!($name)),+,
                    _ => "Unknown",
                }
            }
        }
    };
}

command_kinds! {
    ProcessingState, CaptureMixingBundleState, PostMixPrepare, PostMixClear, PostMixStatus,
    PostMixStart, Mixing, ModeMonitor, ModeSilence, LiveOutput, GetPluginRack,
    RestoreSessionPlugin, GetDevices, LiveMode, ConfigureLiveModes, BeginDeviceScan,
    PollDeviceScan, CancelDeviceScan, StartIdentityCapability, ProcessInputCapability,
    AutoGain, Start, Stop, LoadPlugin, RestorePlugin, UnloadPlugin, ReorderPlugins,
    OpenEditor, SetBypass, SetMute, SetGain, ResumePlugin, SetGlobalMute, SetInputGain,
    SetNoiseReduction, StartNoiseLearning, CancelNoiseLearning, PeakProtection,
    BroadcastTruePeak, NoiseMeasurement, SetNoiseControlConfig, SetBuiltInEffects,
    BuiltinEffects, SetLoudnessMeasurement, SetOutputGain, SetGlobalBypass, SetInputChannels,
    SetChannelScan, GetRuntimeStats, GetFrameTimingTrace, GetPluginState, CaptureBundleState,
    SetPluginState, StartVoiceCheckRecording, StopVoiceCheckRecording, PlayVoiceCheck,
    StopVoiceCheckPlayback, VoiceCheckPreview, ExportVoiceCheck, PlayTestTone, StopTestTone,
    ProbeLoopback, MeasureRoundTrip, CancelMeasurement, GetRoundTripMeasurement,
}

fn plugin_id(command: &Command) -> Option<&str> {
    match command {
        Command::UnloadPlugin { id }
        | Command::OpenEditor { id }
        | Command::SetBypass { id, .. }
        | Command::SetMute { id, .. }
        | Command::SetGain { id, .. }
        | Command::ResumePlugin { id }
        | Command::GetPluginState { id }
        | Command::SetPluginState { id, .. } => Some(id),
        // 読込前はIDが未発行。一括操作も単一のVSTへ帰属させない。
        _ => None,
    }
}

struct Marker {
    epoch: Instant,
    next_sequence: AtomicU64,
    sequence: AtomicU64,
    started_ms: AtomicU64,
    kind: AtomicU8,
    plugin: Mutex<(u64, Option<String>)>,
}

#[derive(Clone, Copy)]
struct Progress {
    sequence: u64,
    started_ms: u64,
    kind: u8,
}

impl Marker {
    fn new() -> Self {
        Self {
            epoch: Instant::now(),
            next_sequence: AtomicU64::new(1),
            sequence: AtomicU64::new(0),
            started_ms: AtomicU64::new(0),
            kind: AtomicU8::new(0),
            plugin: Mutex::new((0, None)),
        }
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    fn begin(&self, command: &Command) -> Running<'_> {
        self.begin_operation(Kind::of(command), plugin_id(command))
    }

    fn begin_operation(&self, kind: Kind, plugin_id: Option<&str>) -> Running<'_> {
        let sequence = self.next_sequence.fetch_add(1, SeqCst);
        // 診断側が文字列を複製中でも、制御側を待たせない。
        if let Ok(mut plugin) = self.plugin.try_lock() {
            *plugin = (sequence, plugin_id.map(str::to_owned));
        }
        self.started_ms.store(self.now_ms(), SeqCst);
        self.kind.store(kind as u8, SeqCst);
        // メタデータを書き終えてから実行中として公開する。
        self.sequence.store(sequence, SeqCst);
        Running(self)
    }

    fn snapshot(&self) -> Option<Progress> {
        let sequence = self.sequence.load(SeqCst);
        if sequence == 0 {
            return None;
        }
        let progress = Progress {
            sequence,
            started_ms: self.started_ms.load(SeqCst),
            kind: self.kind.load(SeqCst),
        };
        (self.sequence.load(SeqCst) == sequence).then_some(progress)
    }

    fn plugin(&self, sequence: u64) -> Option<String> {
        let plugin = self.plugin.try_lock().ok()?;
        // 競合時に前のコマンドのIDを誤って表示しない。
        (plugin.0 == sequence).then(|| plugin.1.clone()).flatten()
    }
}

pub(super) struct Running<'a>(&'a Marker);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.sequence.store(0, SeqCst);
    }
}

#[derive(Default)]
struct Decision {
    sequence: u64,
    reports: u8,
}

impl Decision {
    // 時刻を引数にして、実時間を待たず境界と重複抑止を検証する。
    fn poll(&mut self, progress: Option<Progress>, now_ms: u64) -> Option<u64> {
        let Some(progress) = progress else {
            *self = Self::default();
            return None;
        };
        if self.sequence != progress.sequence {
            self.sequence = progress.sequence;
            self.reports = 0;
        }
        let elapsed = now_ms.saturating_sub(progress.started_ms);
        let threshold = match self.reports {
            0 => 5_000,
            1 => 30_000,
            _ => return None,
        };
        if elapsed < threshold {
            return None;
        }
        self.reports += 1;
        Some(elapsed)
    }
}

pub(super) struct Watchdog {
    marker: Arc<Marker>,
    stop: mpsc::Sender<()>,
}

impl Watchdog {
    pub(super) fn start() -> Self {
        let marker = Arc::new(Marker::new());
        let watched = marker.clone();
        let (stop, stopped) = mpsc::channel();
        let sampler = platform::Sampler::capture_current();
        let result = std::thread::Builder::new()
            .name("control-stall-watch".into())
            .spawn(move || {
                let mut decision = Decision::default();
                while matches!(stopped.recv_timeout(Duration::from_secs(1)), Err(mpsc::RecvTimeoutError::Timeout)) {
                    let progress = watched.snapshot();
                    let Some(elapsed_ms) = decision.poll(progress, watched.now_ms()) else {
                        continue;
                    };
                    let Some(progress) = progress else { continue };
                    let plugin_id = watched.plugin(progress.sequence);
                    let module = sampler.as_ref().and_then(|sampler| sampler.module());
                    // 採取中に完了・交代したコマンドへ結果を結び付けない。
                    if watched.sequence.load(SeqCst) != progress.sequence {
                        continue;
                    }
                    let command = Kind::name(progress.kind);
                    log::error!("Control stall: command={command} plugin_id={plugin_id:?} module={module:?} elapsed_ms={elapsed_ms}");
                    super::Engine::emit_event(EngineEvent::ControlStall {
                        command: command.into(),
                        plugin_id,
                        module,
                        elapsed_ms,
                    });
                }
            });
        if let Err(error) = result {
            log::error!("Control stall watchdog failed to start: {error}");
        }
        Self { marker, stop }
    }

    pub(super) fn begin(&self, command: &Command) -> Running<'_> {
        self.marker.begin(command)
    }

    pub(super) fn begin_operation(&self, kind: Kind, plugin_id: &str) -> Running<'_> {
        self.marker.begin_operation(kind, Some(plugin_id))
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        // 終了時に監視だけを起こし、制御スレッドではjoin待ちをしない。
        let _ = self.stop.send(());
    }
}

#[cfg(all(windows, target_arch = "x86_64"))]
mod platform {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{DuplicateHandle, DUPLICATE_HANDLE_OPTIONS, HANDLE, HMODULE};
    use windows::Win32::System::Diagnostics::Debug::{CONTEXT, CONTEXT_CONTROL_AMD64};
    use windows::Win32::System::LibraryLoader::{
        GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    };
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentThread, GetCurrentThreadId, ResumeThread, SuspendThread,
        THREAD_GET_CONTEXT, THREAD_QUERY_INFORMATION, THREAD_SUSPEND_RESUME,
    };

    // Result変換を避け、停止中の失敗経路でも割当・COMエラー参照を行わない。
    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "GetThreadContext"]
        fn get_thread_context(thread: HANDLE, context: *mut CONTEXT) -> i32;
    }

    #[repr(C, align(16))]
    struct AlignedContext(CONTEXT);

    pub(super) struct Sampler {
        handle: OwnedHandle,
        thread_id: u32,
    }

    impl Sampler {
        pub(super) fn capture_current() -> Option<Self> {
            let mut handle = HANDLE::default();
            // SAFETY: 現在のスレッドを必要最小権限で複製し、所有権を一度だけ移す。
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    GetCurrentThread(),
                    GetCurrentProcess(),
                    &mut handle,
                    (THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION).0,
                    false,
                    DUPLICATE_HANDLE_OPTIONS(0),
                )
                .ok()?;
                Some(Self {
                    handle: OwnedHandle::from_raw_handle(handle.0),
                    thread_id: GetCurrentThreadId(),
                })
            }
        }

        pub(super) fn module(&self) -> Option<String> {
            // SAFETY: IDの取得だけであり、疑似ハンドルの所有権を変更しない。
            if unsafe { GetCurrentThreadId() } == self.thread_id {
                return None;
            }
            let handle = HANDLE(self.handle.as_raw_handle());
            let mut context = AlignedContext(CONTEXT {
                ContextFlags: CONTEXT_CONTROL_AMD64,
                ..CONTEXT::default()
            });
            // SAFETY: ハンドルを保持し、16バイト境界のスタック領域を渡す。
            // 停止成功後は生の取得と再開だけを行い、失敗判定も再開後に行う。
            let (captured, resumed) = unsafe {
                if SuspendThread(handle) == u32::MAX {
                    return None;
                }
                let captured = get_thread_context(handle, &mut context.0);
                let resumed = ResumeThread(handle);
                (captured, resumed)
            };
            if captured == 0 || resumed == u32::MAX {
                return None;
            }

            let mut module = HMODULE::default();
            let mut path = [0u16; 32_768];
            // SAFETY: 再開後にアドレスを照合する。参照カウントやDLLの所有権は変えない。
            let len = unsafe {
                GetModuleHandleExW(
                    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                        | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                    PCWSTR(context.0.Rip as *const u16),
                    &mut module,
                )
                .ok()?;
                GetModuleFileNameW(Some(module), &mut path) as usize
            };
            if len == 0 || len >= path.len() {
                return None;
            }
            let path = String::from_utf16(&path[..len]).ok()?;
            path.rsplit(['\\', '/'])
                .next()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        }
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
mod platform {
    pub(super) struct Sampler;

    impl Sampler {
        pub(super) fn capture_current() -> Option<Self> {
            None
        }
        pub(super) fn module(&self) -> Option<String> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(sequence: u64) -> Option<Progress> {
        Some(Progress {
            sequence,
            started_ms: 100,
            kind: Kind::OpenEditor as u8,
        })
    }

    #[test]
    fn thresholds_report_once_each() {
        let mut decision = Decision::default();
        assert_eq!(decision.poll(progress(1), 5_099), None);
        assert_eq!(decision.poll(progress(1), 5_100), Some(5_000));
        assert_eq!(decision.poll(progress(1), 5_100), None);
        assert_eq!(decision.poll(progress(1), 30_099), None);
        assert_eq!(decision.poll(progress(1), 30_100), Some(30_000));
        assert_eq!(decision.poll(progress(1), 30_100), None);
        assert_eq!(decision.poll(progress(1), u64::MAX), None);
    }

    #[test]
    fn new_sequence_resets_both_thresholds_without_observing_idle() {
        let mut decision = Decision::default();
        for sequence in [1, 2] {
            assert_eq!(decision.poll(progress(sequence), 5_100), Some(5_000));
            assert_eq!(decision.poll(progress(sequence), 30_100), Some(30_000));
        }
    }

    #[test]
    fn idle_never_reports() {
        let mut decision = Decision::default();
        assert_eq!(decision.poll(None, u64::MAX), None);
        assert_eq!(decision.poll(progress(1), 5_100), Some(5_000));
        assert_eq!(decision.poll(None, u64::MAX), None);
        assert_eq!(decision.poll(None, u64::MAX), None);
    }

    #[test]
    fn delayed_first_poll_preserves_two_report_limit() {
        let mut decision = Decision::default();
        assert_eq!(decision.poll(progress(1), 31_100), Some(31_000));
        assert_eq!(decision.poll(progress(1), 32_100), Some(32_000));
        assert_eq!(decision.poll(progress(1), 33_100), None);
    }

    #[test]
    fn marker_tracks_command_plugin_and_clears_on_return() {
        let marker = Marker::new();
        assert!(marker.snapshot().is_none());
        let running = marker.begin(&Command::SetPluginState {
            id: "vst-1".into(),
            state: "state".into(),
        });
        let first = marker.snapshot().unwrap();
        assert_eq!(Kind::name(first.kind), "SetPluginState");
        assert_eq!(marker.plugin(first.sequence).as_deref(), Some("vst-1"));
        drop(running);
        assert!(marker.snapshot().is_none());
        let _running = marker.begin(&Command::Stop);
        let second = marker.snapshot().unwrap();
        assert_ne!(first.sequence, second.sequence);
        assert_eq!(Kind::name(second.kind), "Stop");
        assert_eq!(marker.plugin(second.sequence), None);
        assert_eq!(marker.plugin(first.sequence), None);
    }

    #[test]
    fn contended_plugin_metadata_never_blocks_or_reuses_old_id() {
        let marker = Marker::new();
        let first = marker.begin(&Command::OpenEditor { id: "old".into() });
        drop(first);
        let held = marker.plugin.lock().unwrap();
        let _running = marker.begin(&Command::GetPluginState { id: "new".into() });
        let progress = marker.snapshot().unwrap();
        assert_eq!(marker.plugin(progress.sequence), None);
        drop(held);
        assert_eq!(marker.plugin(progress.sequence), None);
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn windows_sampler_resolves_waiting_thread_and_resumes_it() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

        // SAFETY: 新規イベントの所有権を一度だけOwnedHandleへ渡す。
        let event = Arc::new(unsafe {
            OwnedHandle::from_raw_handle(CreateEventW(None, true, false, None).unwrap().0)
        });
        let helper_event = event.clone();
        let (ready, receive) = mpsc::channel();
        let (done, completed) = mpsc::channel();
        let helper = std::thread::spawn(move || {
            ready.send(platform::Sampler::capture_current()).unwrap();
            // SAFETY: イベントは両スレッドの完了まで保持する。待機も有限にする。
            let result =
                unsafe { WaitForSingleObject(HANDLE(helper_event.as_raw_handle()), 5_000) };
            done.send(result == WAIT_OBJECT_0).unwrap();
        });
        let sampler = receive
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let module = sampler.module();
        // SAFETY: 検査失敗時も先に待機解除し、ヘルパーを残さない。
        unsafe { SetEvent(HANDLE(event.as_raw_handle())).unwrap() };
        let resumed = completed.recv_timeout(Duration::from_secs(2));
        assert!(resumed.unwrap());
        helper.join().unwrap();
        let module = module.expect("待機中のスレッドのDLLを取得できること");
        assert!(
            matches!(
                module.to_ascii_lowercase().as_str(),
                "ntdll.dll" | "kernelbase.dll" | "kernel32.dll"
            ),
            "{module}"
        );
        assert!(!module.contains(['\\', '/']));
    }
}
