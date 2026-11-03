//! OBS資格情報は現在のWindowsユーザーのDPAPIで保護する。JSへ秘密を返さない。
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager, State};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{LocalFree, HLOCAL},
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    },
};

const FAILURE: &str =
    "OBSパスワードを保護して保存・読み込みできませんでした。設定から再入力してください。";
const MAX_BYTES: u64 = 32_768;
static TEMP_SERIAL: AtomicU64 = AtomicU64::new(0);
#[derive(Default)]
pub struct Credentials(pub tokio::sync::Mutex<()>);

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
}
impl Endpoint {
    pub fn new(host: String, port: u16) -> Result<Self, String> {
        let host = host.trim().to_ascii_lowercase();
        if host.is_empty()
            || host.len() > 253
            || host.chars().any(|c| {
                c.is_whitespace() || c.is_control() || matches!(c, '/' | '\\' | '@' | '?' | '#')
            })
            || port == 0
        {
            return Err("OBS接続先が不正です".into());
        }
        Ok(Self { host, port })
    }
}
// Debug/Serializeで秘密を誤ってログやIPCへ渡さない。Serializeは暗号化入力専用。
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    endpoint: Endpoint,
    password: String,
}

fn crypt(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
        return Err(FAILURE.into());
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: 入力は呼出し中生存し、出力はDPAPIが確保する。MACHINEフラグを指定せずユーザー単位に限定する。
    unsafe {
        let result = if decrypt {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        result.map_err(|_| FAILURE.to_string())?;
        let data = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        // DPAPIの出力だけをLocalFreeに返す。秘密の復号バッファは解放前に上書きする。
        if decrypt {
            for index in 0..output.cbData as usize {
                std::ptr::write_volatile(output.pbData.add(index), 0);
            }
        }
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(data)
    }
}
fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("obs-credentials.dpapi"))
        .map_err(|_| FAILURE.into())
}
fn read(path: &Path) -> Result<Option<Record>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(FAILURE.into()),
    };
    let mut encrypted = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut encrypted)
        .map_err(|_| FAILURE.to_string())?;
    let mut clear = crypt(&encrypted, true)?;
    let decoded = serde_json::from_slice(&clear).map_err(|_| FAILURE.to_string());
    clear.fill(0);
    decoded
}
fn save(
    path: &Path,
    endpoint: Endpoint,
    password: String,
    only_if_missing: bool,
) -> Result<(), String> {
    if password.len() > 4096 {
        return Err(FAILURE.into());
    }
    if only_if_missing && path.try_exists().map_err(|_| FAILURE.to_string())? {
        return Ok(());
    }
    let mut clear =
        serde_json::to_vec(&Record { endpoint, password }).map_err(|_| FAILURE.to_string())?;
    let encrypted = crypt(&clear, false);
    clear.fill(0);
    let encrypted = encrypted?;
    let parent = path.parent().ok_or(FAILURE)?;
    std::fs::create_dir_all(parent).map_err(|_| FAILURE.to_string())?;
    let temporary = parent.join(format!(
        ".obs-credentials-{}-{}.tmp",
        std::process::id(),
        TEMP_SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&encrypted)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|_| FAILURE.into())
}
pub async fn resolve(
    app: &AppHandle,
    endpoint: Endpoint,
    password: Option<String>,
) -> Result<Option<String>, String> {
    // Some("")は認証なしへの明示変更。Noneだけが保存済み認証を要求する。
    if let Some(value) = password {
        return if value.len() <= 4096 {
            Ok(Some(value))
        } else {
            Err(FAILURE.into())
        };
    }
    let file = path(app)?;
    tauri::async_runtime::spawn_blocking(move || Ok(select(read(&file)?, endpoint)))
        .await
        .map_err(|_| FAILURE.to_string())?
}
fn select(record: Option<Record>, endpoint: Endpoint) -> Option<String> {
    record
        .filter(|record| record.endpoint == endpoint)
        .map(|record| record.password)
}
pub async fn remember(app: &AppHandle, endpoint: Endpoint, password: String) -> Result<(), String> {
    let file = path(app)?;
    tauri::async_runtime::spawn_blocking(move || save(&file, endpoint, password, false))
        .await
        .map_err(|_| FAILURE.to_string())?
}
#[tauri::command]
pub async fn get_obs_credentials(
    app: AppHandle,
    credentials: State<'_, Credentials>,
) -> Result<Option<Endpoint>, String> {
    let _guard = credentials.0.lock().await;
    let file = path(&app)?;
    tauri::async_runtime::spawn_blocking(move || Ok(read(&file)?.map(|record| record.endpoint)))
        .await
        .map_err(|_| FAILURE.to_string())?
}
#[tauri::command]
pub async fn migrate_obs_credentials(
    app: AppHandle,
    credentials: State<'_, Credentials>,
    host: String,
    port: u16,
    password: String,
) -> Result<(), String> {
    let _guard = credentials.0.lock().await;
    let endpoint = Endpoint::new(host, port)?;
    let file = path(&app)?;
    tauri::async_runtime::spawn_blocking(move || save(&file, endpoint, password, true))
        .await
        .map_err(|_| FAILURE.to_string())?
}
#[tauri::command]
pub async fn clear_obs_credentials(
    app: AppHandle,
    credentials: State<'_, Credentials>,
) -> Result<(), String> {
    let _guard = credentials.0.lock().await;
    let file = path(&app)?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(FAILURE.into()),
    })
    .await
    .map_err(|_| FAILURE.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dpapi_round_trip_tampering_and_empty_password() {
        let secret = b"OBS_SECRET_CANARY-\xe3\x83\x86\xe3\x82\xb9\xe3\x83\x88";
        let encrypted = crypt(secret, false).unwrap();
        assert!(!encrypted.windows(secret.len()).any(|p| p == secret));
        assert_eq!(crypt(&encrypted, true).unwrap(), secret);
        let mut corrupt = encrypted;
        corrupt[24] ^= 1;
        assert!(crypt(&corrupt, true).is_err());
        assert!(crypt(&vec![0; MAX_BYTES as usize + 1], true).is_err());
    }
    #[test]
    fn isolated_store_is_encrypted_replaced_and_migration_does_not_overwrite() {
        let root = std::env::temp_dir().join(format!(
            "Auralyn-credential-test-{}-{}",
            std::process::id(),
            TEMP_SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let file = root.join("config/obs-credentials.dpapi");
        let endpoint = Endpoint::new(" Studio-PC ".into(), 4455).unwrap();
        save(&file, endpoint.clone(), "OBS_SECRET_CANARY".into(), true).unwrap();
        assert!(!std::fs::read(&file)
            .unwrap()
            .windows(17)
            .any(|v| v == b"OBS_SECRET_CANARY"));
        save(&file, endpoint.clone(), "stale".into(), true).unwrap();
        assert_eq!(read(&file).unwrap().unwrap().password, "OBS_SECRET_CANARY");
        assert_eq!(
            select(
                read(&file).unwrap(),
                Endpoint::new("other".into(), 4455).unwrap()
            ),
            None
        );
        assert_eq!(
            select(
                read(&file).unwrap(),
                Endpoint::new("studio-pc".into(), 4456).unwrap()
            ),
            None
        );
        assert_eq!(
            select(read(&file).unwrap(), endpoint.clone()),
            Some("OBS_SECRET_CANARY".into())
        );
        save(&file, endpoint.clone(), "".into(), false).unwrap();
        let saved = read(&file).unwrap().unwrap();
        assert_eq!(saved.password, "");
        assert_eq!(saved.endpoint, endpoint);
        assert!(read(&root.join("other/obs-credentials.dpapi"))
            .unwrap()
            .is_none());
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root.join("config")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn endpoints_reject_urls_credentials_and_zero_port() {
        for host in ["", "x@y", "ws://localhost", "localhost/", "host\nname"] {
            assert!(Endpoint::new(host.into(), 4455).is_err());
        }
        assert!(Endpoint::new("localhost".into(), 0).is_err());
        assert_ne!(
            Endpoint::new("localhost".into(), 4455).unwrap(),
            Endpoint::new("localhost".into(), 4456).unwrap()
        );
    }
}
