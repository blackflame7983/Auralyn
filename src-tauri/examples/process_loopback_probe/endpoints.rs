//! 段階0用の再生先確認。既定出力や使用中の出力ではミュート試験を開始しない。
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::OpenOptions,
    path::Path,
    time::{Duration, Instant},
};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Media::Audio::{
            eCapture, eCommunications, eConsole, eMultimedia, eRender, AudioSessionStateActive,
            Endpoints::IAudioEndpointVolume, IAudioSessionControl2, IAudioSessionManager2,
            IMMDevice, IMMDeviceEnumerator, IMMEndpoint, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
        },
        System::Com::{
            CoCreateInstance, CoTaskMemFree, StructuredStorage::PropVariantToStringAlloc,
            CLSCTX_ALL, STGM,
        },
    },
};

#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub id: String,
    pub name: String,
    pub default_roles: Vec<String>,
    pub muted: bool,
    pub volume: f32,
    pub hardware_support: u32,
    pub active_processes: Vec<u32>,
}

fn enumerator() -> Result<IMMDeviceEnumerator> {
    Ok(unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? })
}

fn identifier(device: &IMMDevice) -> Result<String> {
    let value = unsafe { device.GetId()? };
    let result = unsafe { value.to_string() };
    unsafe { CoTaskMemFree(Some(value.0.cast())) };
    Ok(result?)
}

fn get(id: &str) -> Result<IMMDevice> {
    ensure!(
        !id.is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control),
        "再生先IDが不正です"
    );
    let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    Ok(unsafe { enumerator()?.GetDevice(PCWSTR(wide.as_ptr()))? })
}

fn describe(device: &IMMDevice) -> Result<Snapshot> {
    let flow = unsafe { device.cast::<IMMEndpoint>()?.GetDataFlow()? };
    let id = identifier(device)?;
    let store = unsafe { device.OpenPropertyStore(STGM(0))? };
    let value = unsafe { store.GetValue(&PKEY_Device_FriendlyName)? };
    let name = unsafe { PropVariantToStringAlloc(&value)? };
    let converted = unsafe { name.to_string() };
    unsafe { CoTaskMemFree(Some(name.0.cast())) };
    let volume: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None)? };
    let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };
    let sessions = unsafe { manager.GetSessionEnumerator()? };
    let mut active = BTreeSet::new();
    for i in 0..unsafe { sessions.GetCount()? } {
        let control: IAudioSessionControl2 = unsafe { sessions.GetSession(i)? }.cast()?;
        if unsafe { control.GetState()? } == AudioSessionStateActive {
            active.insert(unsafe { control.GetProcessId()? });
        }
    }
    let mut default_roles = Vec::new();
    let enumerator = enumerator()?;
    for (role, name) in [
        (eConsole, "console"),
        (eMultimedia, "multimedia"),
        (eCommunications, "communications"),
    ] {
        if let Ok(default) = unsafe { enumerator.GetDefaultAudioEndpoint(flow, role) } {
            if identifier(&default)? == id {
                default_roles.push(name.to_owned());
            }
        }
    }
    Ok(Snapshot {
        id,
        name: converted?,
        default_roles,
        muted: unsafe { volume.GetMute()?.as_bool() },
        volume: unsafe { volume.GetMasterVolumeLevelScalar()? },
        hardware_support: unsafe { volume.QueryHardwareSupport()? },
        active_processes: active.into_iter().collect(),
    })
}

pub fn list() -> Result<Vec<Snapshot>> {
    let devices = unsafe { enumerator()?.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    (0..unsafe { devices.GetCount()? })
        .map(|i| describe(&unsafe { devices.Item(i)? }))
        .collect()
}

// 音声streamを開かず、試験用の録音端点が他用途で使われていないか照会する。
pub fn list_capture() -> Result<Vec<Snapshot>> {
    let devices = unsafe { enumerator()?.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)? };
    (0..unsafe { devices.GetCount()? })
        .map(|i| describe(&unsafe { devices.Item(i)? }))
        .collect()
}

struct Restore {
    volume: IAudioEndpointVolume,
    muted: bool,
}
impl Restore {
    fn apply(&self) -> Result<()> {
        unsafe { self.volume.SetMute(self.muted, std::ptr::null())? };
        ensure!(
            unsafe { self.volume.GetMute()?.as_bool() } == self.muted,
            "再生先のミュートを元に戻せません"
        );
        Ok(())
    }
}
impl Drop for Restore {
    fn drop(&mut self) {
        let _ = self.apply();
    }
}

pub fn hold_muted(id: &str, duration: Duration, ready: &Path) -> Result<()> {
    ensure!(
        (1..=14_400).contains(&duration.as_secs()),
        "ミュート試験は1〜14400秒です"
    );
    let device = get(id)?;
    let before = describe(&device)?;
    ensure!(
        before.default_roles.is_empty(),
        "既定出力ではミュート試験を開始しません"
    );
    ensure!(
        before.active_processes.is_empty(),
        "使用中の出力ではミュート試験を開始しません"
    );
    let volume = unsafe { device.Activate(CLSCTX_ALL, None)? };
    let restore = Restore {
        volume,
        muted: before.muted,
    };
    // 強制終了時も親runnerが元の状態を照合して回復できるよう、変更前に記録する。
    serde_json::to_writer(
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(ready.with_extension("restore.json"))?,
        &before,
    )?;
    unsafe { restore.volume.SetMute(true, std::ptr::null())? };
    ensure!(
        unsafe { restore.volume.GetMute()?.as_bool() },
        "出力デバイスのミュートを確認できません"
    );
    serde_json::to_writer(
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(ready)?,
        &before,
    )?;
    let started = Instant::now();
    while started.elapsed() < duration {
        ensure!(
            unsafe { restore.volume.GetMute()?.as_bool() },
            "試験中に出力のミュートが解除されました"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    restore.apply()?;
    println!("{}", serde_json::json!({"restored": describe(&device)?}));
    Ok(())
}

pub fn restore(path: &Path) -> Result<()> {
    let before: Snapshot = serde_json::from_reader(std::fs::File::open(path)?)?;
    let device = get(&before.id)?;
    let current = describe(&device)?;
    ensure!(
        (current.volume - before.volume).abs() < 0.0001,
        "試験中に音量が変わりました。自動復元を止めます"
    );
    let volume: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None)? };
    Restore {
        volume,
        muted: before.muted,
    }
    .apply()?;
    println!("{}", serde_json::json!({"restored": describe(&device)?}));
    Ok(())
}
