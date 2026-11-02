//! 選択したプロセスを専用MTAスレッドで取得する。製品の既定出力や音量は変更しない。
mod activation;
mod capture;
pub(crate) mod clock;
pub(crate) mod sessions;
mod support;

use crate::input_source::{ProcessConfig, Target};
use anyhow::{anyhow, ensure, Result};
use ringbuf::{
    traits::{Observer, Producer, Split},
    HeapRb,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Media::Audio::{
            eRender, Endpoints::IAudioEndpointVolume, IMMDevice, IMMDeviceEnumerator,
            MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
        },
        System::Com::{CoCreateInstance, CLSCTX_ALL},
    },
};

pub const RATE: u32 = capture::RATE;
pub type ProducerQueue = <Arc<HeapRb<f32>> as Split>::Prod;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub captured_frames: u64,
    pub nonzero_frames: u64,
    pub failed: bool,
    pub waiting_for_audio: bool,
    pub input_rate_hz: u32,
    pub correction_limit_ppm: u32,
    pub queued_frames: u64,
    pub rendered_frames: u64,
    pub correction_ppm: i32,
    pub pause_resets: u64,
    pub waiting_discarded_frames: u64,
    pub discontinuities: u64,
    pub timestamp_errors: u64,
    pub nonfinite_samples: u64,
}

pub struct Shared {
    pub failed: Arc<AtomicBool>,
    code: AtomicU8,
    received: AtomicU64,
    nonzero: AtomicU64,
    activity_ms: AtomicU64,
    packet_ms: AtomicU64,
    origin: Instant,
    queued: AtomicU64,
    rendered: AtomicU64,
    correction: std::sync::atomic::AtomicI32,
    pause_resets: AtomicU64,
    waiting_discarded: AtomicU64,
    discontinuities: AtomicU64,
    timestamp_errors: AtomicU64,
    nonfinite: AtomicU64,
}
impl Shared {
    pub fn new(failed: Arc<AtomicBool>) -> Self {
        Self {
            failed,
            code: AtomicU8::new(0),
            received: AtomicU64::new(0),
            nonzero: AtomicU64::new(0),
            activity_ms: AtomicU64::new(0),
            packet_ms: AtomicU64::new(0),
            origin: Instant::now(),
            queued: AtomicU64::new(0),
            rendered: AtomicU64::new(0),
            correction: std::sync::atomic::AtomicI32::new(0),
            pause_resets: AtomicU64::new(0),
            waiting_discarded: AtomicU64::new(0),
            discontinuities: AtomicU64::new(0),
            timestamp_errors: AtomicU64::new(0),
            nonfinite: AtomicU64::new(0),
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            captured_frames: self.received.load(Ordering::Relaxed),
            nonzero_frames: self.nonzero.load(Ordering::Relaxed),
            failed: self.failed.load(Ordering::Acquire),
            waiting_for_audio: self.origin.elapsed().as_millis() as u64
                > self.activity_ms.load(Ordering::Relaxed).saturating_add(200),
            input_rate_hz: RATE,
            correction_limit_ppm: 2000,
            queued_frames: self.queued.load(Ordering::Relaxed),
            rendered_frames: self.rendered.load(Ordering::Relaxed),
            correction_ppm: self.correction.load(Ordering::Relaxed),
            pause_resets: self.pause_resets.load(Ordering::Relaxed),
            waiting_discarded_frames: self.waiting_discarded.load(Ordering::Relaxed),
            discontinuities: self.discontinuities.load(Ordering::Relaxed),
            timestamp_errors: self.timestamp_errors.load(Ordering::Relaxed),
            nonfinite_samples: self.nonfinite.load(Ordering::Relaxed),
        }
    }
    pub fn rendered(&self, renderer: &clock::Renderer, queued: usize) {
        self.queued.store(queued as u64, Ordering::Relaxed);
        self.rendered.store(renderer.rendered, Ordering::Relaxed);
        self.correction
            .store(renderer.correction_ppm.round() as i32, Ordering::Relaxed);
    }
    pub fn paused(&self, discarded: usize) {
        self.pause_resets.fetch_add(1, Ordering::Relaxed);
        self.waiting_discarded
            .fetch_add(discarded as u64, Ordering::Relaxed);
    }
    fn fail(&self, code: u8, cancel: &support::Event) {
        self.code.store(code, Ordering::Release);
        self.failed.store(true, Ordering::Release);
        let _ = cancel.signal();
    }
    pub fn packet_age_ms(&self) -> u64 {
        (self.origin.elapsed().as_millis() as u64)
            .saturating_sub(self.packet_ms.load(Ordering::Relaxed))
    }
    pub fn elapsed_ms(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }
}

pub struct Controller {
    cancel: Arc<support::Event>,
    start: Arc<support::Event>,
    capture: Option<JoinHandle<()>>,
    watch: Option<JoinHandle<()>>,
    pub shared: Arc<Shared>,
}

fn route_device(id: &str) -> Result<IMMDevice> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let id: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    let device = unsafe { enumerator.GetDevice(PCWSTR(id.as_ptr()))? };
    let endpoint: windows::Win32::Media::Audio::IMMEndpoint =
        windows::core::Interface::cast(&device)?;
    ensure!(
        unsafe { endpoint.GetDataFlow()? } == eRender,
        "原音の出力先が再生機器ではありません"
    );
    Ok(device)
}

fn validate_route(device: &IMMDevice, volume: &IAudioEndpointVolume) -> Result<()> {
    ensure!(
        unsafe { device.GetState()? } == DEVICE_STATE_ACTIVE
            && unsafe { volume.GetMute()?.as_bool() },
        "原音用の出力先が使えないか、ミュートが解除されました"
    );
    Ok(())
}

impl Controller {
    pub fn prepare(
        config: ProcessConfig,
        target: Target,
        mut queue: ProducerQueue,
        shared: Arc<Shared>,
    ) -> Result<Self> {
        config_validation(&config, &target)?;
        let cancel = Arc::new(support::Event::new(true)?);
        let start = Arc::new(support::Event::new(true)?);
        let (ready, result) = mpsc::sync_channel(1);
        let worker_cancel = cancel.clone();
        let worker_start = start.clone();
        let worker_shared = shared.clone();
        let worker_target = target.clone();
        let capture = thread::spawn(move || {
            let prepared = (|| -> Result<_> {
                let apartment = support::Apartment::new()?;
                let process = support::Process::open(worker_target.pid)?;
                process.verify(worker_target.created)?;
                let capture = capture::Capture::open(process, &worker_cancel)?;
                Ok((apartment, capture))
            })();
            let Ok((_apartment, capture)) = prepared else {
                let _ = ready.send(Err(
                    "アプリ音声の取得を準備できません。選び直してください".to_owned()
                ));
                return;
            };
            if ready.send(Ok(())).is_err() {
                return;
            }
            while !worker_shared.failed.load(Ordering::Acquire) {
                match support::wait(
                    &[worker_cancel.raw(), worker_start.raw()],
                    Duration::from_millis(100),
                ) {
                    Ok(Some(0)) | Err(_) => return,
                    Ok(Some(1)) => break,
                    _ => {}
                }
            }
            let mut received = 0u64;
            let mut nonzero = 0u64;
            let mut last_nonzero = 0u64;
            let result = capture.run_until_stopped(
                &worker_cancel,
                |frame| {
                    received += 1;
                    nonzero += u64::from(frame[0] != 0.0 || frame[1] != 0.0);
                    if queue.vacant_len() < 2 || queue.push_slice(&frame) != 2 {
                        worker_shared.fail(3, &worker_cancel);
                    }
                    if received.is_multiple_of(480) {
                        worker_shared.packet_ms.store(
                            worker_shared.origin.elapsed().as_millis() as u64,
                            Ordering::Relaxed,
                        );
                        worker_shared.received.store(received, Ordering::Relaxed);
                        worker_shared.nonzero.store(nonzero, Ordering::Relaxed);
                        if nonzero > last_nonzero {
                            last_nonzero = nonzero;
                            worker_shared.activity_ms.store(
                                worker_shared.origin.elapsed().as_millis() as u64,
                                Ordering::Relaxed,
                            );
                        }
                    }
                },
                |stats| {
                    worker_shared
                        .discontinuities
                        .store(stats.discontinuities, Ordering::Relaxed);
                    worker_shared
                        .timestamp_errors
                        .store(stats.timestamp_errors, Ordering::Relaxed);
                    worker_shared
                        .nonfinite
                        .store(stats.nonfinite_samples, Ordering::Relaxed);
                    if stats.nonfinite_samples > 0 {
                        worker_shared.fail(1, &worker_cancel);
                    }
                },
            );
            if result
                .as_ref()
                .map_or(true, |s| s.ended == "process_exited")
            {
                worker_shared.fail(1, &worker_cancel);
            }
        });
        let mut controller = Self {
            cancel,
            start,
            capture: Some(capture),
            watch: None,
            shared,
        };
        result
            .recv_timeout(Duration::from_secs(6))
            .map_err(|_| anyhow!("アプリ取得の開始待ちが期限を超えました"))?
            .map_err(|e| anyhow!(e))?;
        let watch_cancel = controller.cancel.clone();
        let watch_shared = controller.shared.clone();
        controller.watch = Some(thread::spawn(move || {
            let result = (|| -> Result<()> {
                let _apartment = support::Apartment::new()?;
                let device = route_device(&config.raw_endpoint_id)?;
                let volume: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None)? };
                let mut tick = 0;
                while support::wait(&[watch_cancel.raw()], Duration::from_millis(100))?.is_none() {
                    validate_route(&device, &volume)?;
                    tick += 1;
                    if tick % 5 == 0 {
                        // 休止中はセッションが列挙されない。別再生先へ移ったときだけ拒否する。
                        if let Some(current) = sessions::list()?
                            .into_iter()
                            .find(|c| c.pid == target.pid && c.created == target.created)
                        {
                            ensure!(
                                current
                                    .routes
                                    .iter()
                                    .all(|r| r.id == config.raw_endpoint_id && r.muted),
                                "原音用の経路が変わりました"
                            );
                        }
                    }
                }
                Ok(())
            })();
            if result.is_err() {
                watch_shared.fail(2, &watch_cancel);
            }
        }));
        Ok(controller)
    }

    pub fn play(&self) -> Result<()> {
        self.start.signal()
    }

    pub fn failure_message(&self) -> Option<&'static str> {
        if !self.shared.failed.load(Ordering::Acquire) {
            return None;
        }
        Some(match self.shared.code.load(Ordering::Acquire) {
            1 => "選んだアプリが終了したか、音声取得に失敗しました。選び直してください。",
            2 => "原音用の出力先が変わったか、ミュートが解除されたため停止しました。経路を確認してください。",
            3 => "アプリ音声の処理が追いつかないため停止しました。出力設定を確認してください。",
            _ => "アプリ入力の音声処理または出力に失敗したため停止しました。出力機器と入力設定を確認してください。",
        })
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        let _ = self.cancel.signal();
        if let Some(worker) = self.capture.take() {
            let _ = worker.join();
        }
        if let Some(worker) = self.watch.take() {
            let _ = worker.join();
        }
    }
}

pub fn config_validation(config: &ProcessConfig, target: &Target) -> Result<()> {
    supported_os()?;
    let config = config.clone();
    let target = target.clone();
    thread::spawn(move || {
        let _apartment = support::Apartment::new()?;
        crate::input_source::Start {
            source: crate::input_source::Config::ProcessLoopback(config.clone()),
            target: Some(target.clone()),
        }
        .validate()
        .map_err(|e| anyhow!(e))?;
        sessions::validate_target(&target, &config)
    })
    .join()
    .map_err(|_| anyhow!("アプリ入力の確認に失敗しました"))?
}

pub fn candidates() -> Result<Vec<sessions::Candidate>> {
    supported_os()?;
    thread::spawn(|| {
        let _apartment = support::Apartment::new()?;
        sessions::list()
    })
    .join()
    .map_err(|_| anyhow!("アプリ一覧の取得に失敗しました"))?
}

fn supported_os() -> Result<()> {
    let version = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
        .open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion")?;
    let build: String = version.get_value("CurrentBuildNumber")?;
    ensure!(
        build.parse::<u32>().unwrap_or(0) >= 20348,
        "アプリ入力にはWindowsビルド20348以降が必要です。仮想ケーブル入力を使ってください"
    );
    Ok(())
}
