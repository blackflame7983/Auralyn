//! 表示言語の保存。Tauri 版と同じ `display-locale.json` を読み書きし、どちらの版で選んでも次の起動で同じ言語になる。

use std::path::Path;

use crate::i18n::Lang;

const FILE: &str = "display-locale.json";
/// Tauri 版が書く印。これと版が合わないファイルは読まない（Tauri 版の `display_locale::load` と同じ）。
const SOURCE: &str = "webview-explicit-language";

/// 保存した言語。ファイルが無い・読めないときは `None`。
pub fn load(config_dir: &Path) -> Option<Lang> {
    let text = std::fs::read_to_string(config_dir.join(FILE)).ok()?;
    parse(&text)
}

pub fn save(config_dir: &Path, lang: Lang) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let path = config_dir.join(FILE);
    let partial = path.with_extension("json.tmp");
    std::fs::write(&partial, format(lang))?;
    std::fs::rename(&partial, &path)
}

fn parse(text: &str) -> Option<Lang> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value["schemaVersion"] != 1 || value["source"] != SOURCE {
        return None;
    }
    match value["locale"].as_str()? {
        "ja" => Some(Lang::Ja),
        "en" => Some(Lang::En),
        _ => None,
    }
}

fn format(lang: Lang) -> String {
    let locale = match lang {
        Lang::Ja => "ja",
        Lang::En => "en",
    };
    serde_json::json!({ "schemaVersion": 1, "source": SOURCE, "locale": locale }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_it_writes_and_what_tauri_writes() {
        for lang in [Lang::Ja, Lang::En] {
            assert_eq!(parse(&format(lang)), Some(lang));
        }
        let tauri = r#"{"schemaVersion":1,"source":"webview-explicit-language","locale":"en"}"#;
        assert_eq!(parse(tauri), Some(Lang::En));
    }

    #[test]
    fn ignores_other_versions_and_broken_files() {
        assert_eq!(
            parse(r#"{"schemaVersion":2,"source":"webview-explicit-language","locale":"en"}"#),
            None
        );
        assert_eq!(
            parse(r#"{"schemaVersion":1,"source":"other","locale":"en"}"#),
            None
        );
        assert_eq!(parse("{"), None);
    }
}
