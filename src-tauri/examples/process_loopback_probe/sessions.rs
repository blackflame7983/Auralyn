//! 候補は全ての有効な再生endpointから取得する。フルパスは外へ出さない。
use super::support::{Handle, Process};
use anyhow::Result;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    mem::size_of,
    path::Path,
};
use windows::{
    core::Interface,
    Win32::{
        Media::Audio::{
            eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
            IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
        },
        System::{
            Com::{CoCreateInstance, CLSCTX_ALL},
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
        },
    },
};

#[derive(Serialize)]
pub struct Candidate {
    pub pid: u32,
    pub created: u64,
    pub name: String,
    pub sessions: usize,
    pub endpoints: usize,
}

fn parents() -> Result<HashMap<u32, u32>> {
    let snapshot = Handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)? });
    let mut result = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while next.is_ok() {
        result.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        next = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    Ok(result)
}

fn app_root(mut process: Process, parents: &HashMap<u32, u32>) -> Result<(Process, String)> {
    let image = process.image()?;
    let mut visited = BTreeSet::new();
    // explorer/terminalまで遡らない。同じ実行ファイルの親だけを同一アプリとして扱う。
    for _ in 0..64 {
        if !visited.insert(process.pid) {
            break;
        }
        let Some(parent) = parents.get(&process.pid).copied() else {
            break;
        };
        let Ok(parent) = Process::open(parent) else {
            break;
        };
        if parent.created > process.created || !parent.image()?.eq_ignore_ascii_case(&image) {
            break;
        }
        process = parent;
    }
    Ok((process, image))
}

fn for_each_session(
    mut visit: impl FnMut(u32, u32, &IAudioSessionControl2) -> Result<()>,
) -> Result<u32> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let endpoints = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    let count = unsafe { endpoints.GetCount()? };
    for index in 0..count {
        let device = unsafe { endpoints.Item(index)? };
        let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };
        let sessions = unsafe { manager.GetSessionEnumerator()? };
        for session in 0..unsafe { sessions.GetCount()? } {
            let control: IAudioSessionControl2 = unsafe { sessions.GetSession(session)? }.cast()?;
            let pid = unsafe { control.GetProcessId()? };
            if pid != 0 {
                visit(index, pid, &control)?;
            }
        }
    }
    Ok(count)
}

pub fn list() -> Result<Vec<Candidate>> {
    let tree = parents()?;
    let mut result = BTreeMap::<(u32, u64), (Candidate, BTreeSet<u32>)>::new();
    for_each_session(|endpoint, pid, control| {
        if unsafe { control.GetState()? } != AudioSessionStateActive {
            return Ok(());
        }
        let Ok(process) = Process::open(pid) else {
            return Ok(());
        };
        let Ok((root, image)) = app_root(process, &tree) else {
            return Ok(());
        };
        if root.pid == std::process::id() {
            return Ok(());
        }
        let name = Path::new(&image)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        if ["AuralynHost.exe", "audio_engine.exe", "plugin_scanner.exe"]
            .iter()
            .any(|value| name.eq_ignore_ascii_case(value))
        {
            return Ok(());
        }
        let (candidate, endpoints) = result.entry((root.pid, root.created)).or_insert_with(|| {
            (
                Candidate {
                    pid: root.pid,
                    created: root.created,
                    name,
                    sessions: 0,
                    endpoints: 0,
                },
                BTreeSet::new(),
            )
        });
        candidate.sessions += 1;
        endpoints.insert(endpoint);
        candidate.endpoints = endpoints.len();
        Ok(())
    })?;
    Ok(result
        .into_values()
        .map(|(candidate, _)| candidate)
        .collect())
}

pub fn configure_own_session(mute: bool, level: f32) -> Result<(usize, u32)> {
    let pid = std::process::id();
    let mut muted = 0;
    let endpoints = for_each_session(|_, session_pid, control| {
        if session_pid == pid {
            let volume: ISimpleAudioVolume = control.cast()?;
            unsafe {
                volume.SetMasterVolume(level, std::ptr::null())?;
                volume.SetMute(mute, std::ptr::null())?;
                anyhow::ensure!(
                    volume.GetMute()?.as_bool() == mute
                        && (volume.GetMasterVolume()? - level).abs() < 0.001,
                    "試験音のセッション設定を確認できません"
                );
            }
            muted += 1;
        }
        Ok(())
    })?;
    Ok((muted, endpoints))
}
