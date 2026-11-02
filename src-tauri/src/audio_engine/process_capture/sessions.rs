//! 候補は全ての有効な再生endpointから取得する。フルパスは外へ出さない。
use super::support::{Handle, Process};
use anyhow::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    mem::size_of,
    path::Path,
};
use windows::{
    core::Interface,
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Media::Audio::{
            eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
            IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
        },
        System::{
            Com::{
                CoCreateInstance, CoTaskMemFree, StructuredStorage::PropVariantToStringAlloc,
                CLSCTX_ALL, STGM,
            },
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
    pub app_key: String,
    pub routes: Vec<Route>,
}

#[derive(Clone, Serialize)]
pub struct Route {
    pub id: String,
    pub name: String,
    pub muted: bool,
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
    mut visit: impl FnMut(u32, &Route, u32, &IAudioSessionControl2) -> Result<()>,
) -> Result<u32> {
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let endpoints = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    let count = unsafe { endpoints.GetCount()? };
    for index in 0..count {
        let device = unsafe { endpoints.Item(index)? };
        let id = unsafe { device.GetId()? };
        let text = unsafe { id.to_string() };
        unsafe { CoTaskMemFree(Some(id.0.cast())) };
        let store = unsafe { device.OpenPropertyStore(STGM(0))? };
        let property = unsafe { store.GetValue(&PKEY_Device_FriendlyName)? };
        let name = unsafe { PropVariantToStringAlloc(&property)? };
        let converted = unsafe { name.to_string() };
        unsafe { CoTaskMemFree(Some(name.0.cast())) };
        let volume: windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume =
            unsafe { device.Activate(CLSCTX_ALL, None)? };
        let route = Route {
            id: text?,
            name: converted?,
            muted: unsafe { volume.GetMute()?.as_bool() },
        };
        let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };
        let sessions = unsafe { manager.GetSessionEnumerator()? };
        for session in 0..unsafe { sessions.GetCount()? } {
            let control: IAudioSessionControl2 = unsafe { sessions.GetSession(session)? }.cast()?;
            let pid = unsafe { control.GetProcessId()? };
            if pid != 0 {
                visit(index, &route, pid, &control)?;
            }
        }
    }
    Ok(count)
}

pub fn list() -> Result<Vec<Candidate>> {
    let tree = parents()?;
    let mut result = BTreeMap::<(u32, u64), (Candidate, BTreeSet<u32>)>::new();
    for_each_session(|endpoint, route, pid, control| {
        if unsafe { control.GetState()? } != AudioSessionStateActive {
            return Ok(());
        }
        let Ok(process) = Process::open(pid) else {
            return Ok(());
        };
        let Ok((root, image)) = app_root(process, &tree) else {
            return Ok(());
        };
        if own_family(root.pid, &tree) {
            return Ok(());
        }
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
                    app_key: format!("{:x}", Sha256::digest(image.to_lowercase().as_bytes())),
                    routes: Vec::new(),
                },
                BTreeSet::new(),
            )
        });
        candidate.sessions += 1;
        endpoints.insert(endpoint);
        candidate.endpoints = endpoints.len();
        if !candidate
            .routes
            .iter()
            .any(|existing| existing.id == route.id)
        {
            candidate.routes.push(route.clone());
        }
        Ok(())
    })?;
    Ok(result
        .into_values()
        .map(|(candidate, _)| candidate)
        .collect())
}

fn own_family(mut pid: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut visited = BTreeSet::new();
    for _ in 0..64 {
        if pid == std::process::id() {
            return true;
        }
        if !visited.insert(pid) {
            break;
        }
        if let Ok(process) = Process::open(pid) {
            if let Ok(image) = process.image() {
                let name = Path::new(&image)
                    .file_name()
                    .and_then(|p| p.to_str())
                    .unwrap_or("");
                if ["AuralynHost.exe", "audio_engine.exe", "plugin_scanner.exe"]
                    .iter()
                    .any(|own| name.eq_ignore_ascii_case(own))
                {
                    return true;
                }
            }
        }
        let Some(parent) = parents.get(&pid) else {
            break;
        };
        pid = *parent;
    }
    false
}

pub fn validate_target(
    target: &crate::input_source::Target,
    config: &crate::input_source::ProcessConfig,
) -> Result<()> {
    Process::open(target.pid)?.verify(target.created)?;
    let candidate = list()?
        .into_iter()
        .find(|c| c.pid == target.pid && c.created == target.created)
        .ok_or_else(|| {
            anyhow::anyhow!("選んだアプリの音声を確認できません。再生して選び直してください")
        })?;
    anyhow::ensure!(
        candidate.app_key == config.app_key && candidate.name == config.app_name,
        "アプリの識別情報が変わりました。選び直してください"
    );
    anyhow::ensure!(!candidate.routes.is_empty() && candidate.routes.iter().all(|r| r.id == config.raw_endpoint_id && r.muted),
        "原音の出力先を本人用とは別にし、その出力デバイスをミュートしてください。使えない場合は仮想ケーブルを選んでください");
    Ok(())
}
