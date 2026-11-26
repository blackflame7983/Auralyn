//! テーマの保存。GPUI 版は自分のファイル（`gpui_theme.json`）に書く。
//! Tauri 版はテーマを画面（WebView）の中だけに保存していて読めないので、無ければ標準（オーロラ）で始める。

use std::path::Path;

use auralyn_core::design::Theme;

const FILE: &str = "gpui_theme.json";

/// 保存したテーマ。無い・読めないときは `None`。
pub fn load(config_dir: &Path) -> Option<Theme> {
    parse(&std::fs::read_to_string(config_dir.join(FILE)).ok()?)
}

pub fn save(config_dir: &Path, theme: Theme) -> std::io::Result<()> {
    let text = serde_json::json!({ "theme": theme }).to_string();
    crate::store::write_atomic(&config_dir.join(FILE), text.as_bytes())
}

fn parse(text: &str) -> Option<Theme> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    serde_json::from_value(value.get("theme")?.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_it_writes() {
        for theme in Theme::ALL {
            let text = serde_json::json!({ "theme": theme }).to_string();
            assert_eq!(parse(&text), Some(theme));
        }
        assert_eq!(parse(r#"{"theme":"gaming"}"#), Some(Theme::Gaming));
        assert_eq!(parse(r#"{"theme":"neon"}"#), None);
        assert_eq!(parse("{"), None);
    }
}
