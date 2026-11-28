//! 設定の JSON を、一時ファイルへ書いてから置き換えて保存する（途中で落ちても壊れたファイルを残さない）。
use std::{fs, io::Write, path::Path};

use serde::Serialize;

pub(crate) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("保存先がありません")?).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = path.with_file_name(format!(".auralyn-save-{stamp}.tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| e.to_string())
}
