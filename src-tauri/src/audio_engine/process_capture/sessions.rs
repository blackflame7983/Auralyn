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
    // SAFETY: PIDを列挙するsnapshotの生成成功後だけ所有Handleへ渡し、最後に一度だけ閉じる。
    let snapshot = Handle(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)? });
    let mut result = HashMap::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: 有効なsnapshotと、dwSizeを初期化した書込み可能なentryを渡す。
    let mut next = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    while next.is_ok() {
        result.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        // SAFETY: snapshotを保持した同じ列挙中に、正しいサイズを保つentryへ次の項目を書き込む。
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
        // SAFETY: 呼出元のMTAガードが生存するスレッドで、型に対応するCOMインターフェイスを生成する。
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    // SAFETY: このMTAスレッドで所有するenumeratorを使用し、戻されたcollectionも所有参照で保持する。
    let endpoints = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    // SAFETY: 所有するcollectionの有効なCOM参照から件数を取得する。
    let count = unsafe { endpoints.GetCount()? };
    for index in 0..count {
        // SAFETY: GetCountが返した範囲のindexだけを使い、collectionを呼出し完了まで保持する。
        let device = unsafe { endpoints.Item(index)? };
        // SAFETY: 所有deviceのCOM参照から、呼出元が解放するnul終端文字列を取得する。
        let id = unsafe { device.GetId()? };
        // SAFETY: GetIdで取得した有効なnul終端文字列を、解放前にRustのStringへコピーする。
        let text = unsafe { id.to_string() };
        // SAFETY: GetIdがCOM allocatorで確保した文字列をコピー後に一度だけ解放し、以後参照しない。
        unsafe { CoTaskMemFree(Some(id.0.cast())) };
        // SAFETY: 所有deviceのCOM参照から読み取り用のproperty storeを取得する。
        let store = unsafe { device.OpenPropertyStore(STGM(0))? };
        // SAFETY: 所有storeと静的なproperty keyを使い、返されたPROPVARIANTをRust側で所有する。
        let property = unsafe { store.GetValue(&PKEY_Device_FriendlyName)? };
        // SAFETY: 生存中のPROPVARIANTからCOM allocator所有のnul終端文字列を取得する。
        let name = unsafe { PropVariantToStringAlloc(&property)? };
        // SAFETY: 取得成功したnul終端文字列を、解放する前にRustのStringへコピーする。
        let converted = unsafe { name.to_string() };
        // SAFETY: PropVariantToStringAllocで確保した文字列だけを、コピー後に一度だけ解放する。
        unsafe { CoTaskMemFree(Some(name.0.cast())) };
        let volume: windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume =
            // SAFETY: MTAガード内で所有deviceを使用し、指定した型のendpoint volume参照を取得する。
            unsafe { device.Activate(CLSCTX_ALL, None)? };
        let route = Route {
            id: text?,
            name: converted?,
            // SAFETY: 同じMTAスレッドで保持するvolumeインターフェイスから状態を読み取る。
            muted: unsafe { volume.GetMute()?.as_bool() },
        };
        // SAFETY: MTAガード内で所有deviceを使用し、指定したsession manager参照を取得する。
        let manager: IAudioSessionManager2 = unsafe { device.Activate(CLSCTX_ALL, None)? };
        // SAFETY: 有効な所有managerからsession列挙子を取得し、このスレッド内で保持する。
        let sessions = unsafe { manager.GetSessionEnumerator()? };
        // SAFETY: 所有するsession列挙子の有効なCOM参照から件数を取得する。
        for session in 0..unsafe { sessions.GetCount()? } {
            // SAFETY: GetCountの範囲内のsession番号だけを使い、返されたCOM参照を所有する。
            let control: IAudioSessionControl2 = unsafe { sessions.GetSession(session)? }.cast()?;
            // SAFETY: 同じMTAスレッドの有効なsession control参照からPIDを取得する。
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
        // SAFETY: 列挙中に所有するsession controlを、呼出元のMTAガードが生存する間に使用する。
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
