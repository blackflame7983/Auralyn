//! VST を探す追加のフォルダーの保存。GPUI 版は自分のファイル（`gpui_scan_folders.json`）に書く

use std::path::Path;

use auralyn_ui_model::scan_folders::sanitize;

const FILE: &str = "gpui_scan_folders.json";

pub fn load(config_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(config_dir.join(FILE))
        .ok()
        .map(|text| parse(&text))
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, folders: &[String]) -> std::io::Result<()> {
    crate::store::write_atomic(
        &config_dir.join(FILE),
        serde_json::json!(folders).to_string().as_bytes(),
    )
}

/// 文字列でないものは飛ばす。
fn parse(text: &str) -> Vec<String> {
    let items = serde_json::from_str::<Vec<serde_json::Value>>(text).unwrap_or_default();
    sanitize(
        items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_string)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_folders_read_back_and_odd_entries_are_skipped() {
        let folders = vec!["D:\\VST".to_string(), "E:\\Plugins".to_string()];
        assert_eq!(parse(&serde_json::json!(folders).to_string()), folders);
        assert_eq!(parse(r#"["D:\\VST", 3, null, "d:/vst/"]"#), vec!["D:\\VST"]);
        assert!(parse("{}").is_empty());
    }
}
