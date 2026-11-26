//! 表示言語の保存。GPUI 版は自分のファイル（`gpui_locale.json`）にだけ書く。
//! 自分のファイルが無いときは、Tauri 版のトレイ用の写し（`display-locale.json`）を読み、Tauri 版で選んだ言語で始める。
//! Tauri 版のファイルへは書かない（Tauri 版は起動のたびに自分の画面の言語で書き直し・削除するため、共有できない）。

use std::path::Path;

use crate::i18n::Lang;

const FILE: &str = "gpui_locale.json";
const TAURI_FILE: &str = "display-locale.json";

/// 保存した言語。どちらのファイルも無い・読めないときは `None`。
pub fn load(config_dir: &Path) -> Option<Lang> {
    let read = |name| std::fs::read_to_string(config_dir.join(name)).ok();
    match read(FILE) {
        Some(text) => parse_own(&text),
        None => read(TAURI_FILE).and_then(|text| parse_tauri(&text)),
    }
}

pub fn save(config_dir: &Path, lang: Lang) -> std::io::Result<()> {
    let text = serde_json::json!({ "locale": code(lang) }).to_string();
    crate::store::write_atomic(&config_dir.join(FILE), text.as_bytes())
}

pub fn code(lang: Lang) -> &'static str {
    match lang {
        Lang::Ja => "ja",
        Lang::En => "en",
    }
}

fn from_code(code: &str) -> Option<Lang> {
    match code {
        "ja" => Some(Lang::Ja),
        "en" => Some(Lang::En),
        _ => None,
    }
}

fn parse_own(text: &str) -> Option<Lang> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    from_code(value["locale"].as_str()?)
}

/// Tauri 版の `display_locale::load` と同じ条件で読む（ほかのキーがあれば読まない）。
fn parse_tauri(text: &str) -> Option<Lang> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.len() != 3
        || value["schemaVersion"] != 1
        || value["source"] != "webview-explicit-language"
    {
        return None;
    }
    from_code(value["locale"].as_str()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_its_own_file() {
        assert_eq!(parse_own(r#"{"locale":"en"}"#), Some(Lang::En));
        assert_eq!(parse_own(r#"{"locale":"fr"}"#), None);
        assert_eq!(parse_own("{"), None);
    }

    #[test]
    fn reads_tauri_file_like_tauri_does() {
        let tauri = r#"{"schemaVersion":1,"source":"webview-explicit-language","locale":"en"}"#;
        assert_eq!(parse_tauri(tauri), Some(Lang::En));
        for other in [
            r#"{"schemaVersion":2,"source":"webview-explicit-language","locale":"en"}"#,
            r#"{"schemaVersion":1,"source":"other","locale":"en"}"#,
            r#"{"schemaVersion":1,"source":"webview-explicit-language","locale":"en","x":1}"#,
            "{",
        ] {
            assert_eq!(parse_tauri(other), None, "{other}");
        }
    }
}
