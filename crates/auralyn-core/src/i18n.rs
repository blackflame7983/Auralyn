//! 日英の文言。正本は `locales/ja.json`・`locales/en.json` で、TypeScript の画面も同じファイルを読む。
use serde::de::{Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    #[default]
    Ja,
    En,
}

impl Locale {
    pub const ALL: [Locale; 2] = [Locale::Ja, Locale::En];
}

/// 1つの言語の文言。キーの重複を読み込みの失敗にする（JSON の仕様は重複を禁じないため）。
#[derive(Debug)]
pub struct Messages {
    entries: Vec<(String, String)>,
    index: HashMap<String, usize>,
}

impl Messages {
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.index
            .get(key)
            .map(|&position| self.entries[position].1.as_str())
    }

    /// ファイルに書かれた順のキー。
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(key, _)| key.as_str())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl<'de> Deserialize<'de> for Messages {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Table;
        impl<'de> Visitor<'de> for Table {
            type Value = Messages;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("キーと文字列の表")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Messages, A::Error> {
                let mut entries = Vec::new();
                let mut index = HashMap::new();
                while let Some((key, value)) = map.next_entry::<String, String>()? {
                    if index.insert(key.clone(), entries.len()).is_some() {
                        return Err(serde::de::Error::custom(format!(
                            "キーが重複しています: {key}"
                        )));
                    }
                    entries.push((key, value));
                }
                Ok(Messages { entries, index })
            }
        }
        deserializer.deserialize_map(Table)
    }
}

/// 埋め込んだ日英の文言。
#[derive(Debug)]
pub struct Catalog {
    ja: Messages,
    en: Messages,
}

impl Catalog {
    pub fn from_json(ja: &str, en: &str) -> Result<Self, serde_json::Error> {
        Ok(Self {
            ja: Messages::from_json(ja)?,
            en: Messages::from_json(en)?,
        })
    }

    pub fn messages(&self, locale: Locale) -> &Messages {
        match locale {
            Locale::Ja => &self.ja,
            Locale::En => &self.en,
        }
    }

    /// `{name}` を `args` の値に置き換えた文言。`args` に無い差し込みはそのまま残す（TypeScript の `message()` と同じ）。
    pub fn text(
        &self,
        locale: Locale,
        key: &str,
        args: &[(&str, &dyn fmt::Display)],
    ) -> Option<String> {
        self.messages(locale)
            .get(key)
            .map(|template| fill(template, args))
    }
}

const JA_JSON: &str = include_str!("../locales/ja.json");
const EN_JSON: &str = include_str!("../locales/en.json");

/// アプリに埋め込んだ文言。形の誤りは試験 `builtin_catalog_loads` で止める。
pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        Catalog::from_json(JA_JSON, EN_JSON).expect("埋め込んだ文言の JSON が読めません")
    })
}

pub fn text(locale: Locale, key: &str, args: &[(&str, &dyn fmt::Display)]) -> Option<String> {
    catalog().text(locale, key, args)
}

/// 差し込みの名前は TypeScript の `\w` と同じく ASCII の英数字と `_`。
fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn fill(template: &str, args: &[(&str, &dyn fmt::Display)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after
            .find(|c: char| !is_name_char(c))
            .unwrap_or(after.len());
        let name = &after[..name_len];
        let closed = !name.is_empty() && after[name_len..].starts_with('}');
        match args.iter().find(|(arg, _)| closed && *arg == name) {
            Some((_, value)) => {
                out.push_str(&value.to_string());
                rest = &after[name_len + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `{name}` の名前の集合。
pub fn placeholders(template: &str) -> Vec<&str> {
    let mut names = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        let name_len = after
            .find(|c: char| !is_name_char(c))
            .unwrap_or(after.len());
        if name_len > 0 && after[name_len..].starts_with('}') {
            names.push(&after[..name_len]);
        }
        rest = after;
    }
    names.sort_unstable();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_catalog_loads() {
        let catalog = catalog();
        assert!(!catalog.messages(Locale::Ja).is_empty());
    }

    #[test]
    fn ja_and_en_have_the_same_keys_and_placeholders() {
        let catalog = catalog();
        let ja = catalog.messages(Locale::Ja);
        let en = catalog.messages(Locale::En);
        assert_eq!(ja.len(), en.len());
        for key in ja.keys() {
            let english = en
                .get(key)
                .unwrap_or_else(|| panic!("en に {key} がありません"));
            assert_eq!(
                placeholders(ja.get(key).unwrap()),
                placeholders(english),
                "{key}"
            );
        }
    }

    #[test]
    fn duplicate_keys_are_rejected() {
        let error = Messages::from_json(r#"{"a": "1", "a": "2"}"#).unwrap_err();
        assert!(error.to_string().contains("キーが重複しています: a"));
        assert!(Messages::from_json(r#"{"a": 1}"#).is_err());
    }

    #[test]
    fn fill_matches_the_typescript_rules() {
        let n = 3;
        let cases: [(&str, &str); 7] = [
            ("{action}のキーを一覧から選ぶ", "保存のキーを一覧から選ぶ"),
            ("{missing}は残す", "{missing}は残す"),
            ("{count}件と{count}件", "3件と3件"),
            ("{ action }", "{ action }"),
            ("{}{", "{}{"),
            ("{{action}}", "{保存}"),
            ("{action-x}", "{action-x}"),
        ];
        for (template, expected) in cases {
            assert_eq!(
                fill(template, &[("action", &"保存"), ("count", &n)]),
                expected,
                "{template}"
            );
        }
    }

    #[test]
    fn text_reads_the_shared_catalog() {
        assert_eq!(
            text(
                Locale::En,
                "shortcuts.chooseFromListNamed",
                &[("action", &"Mute")]
            )
            .as_deref(),
            Some("Choose keys for Mute from a list")
        );
        assert_eq!(
            text(Locale::Ja, "help.title", &[]).as_deref(),
            Some("使い方")
        );
        assert_eq!(text(Locale::Ja, "no.such.key", &[]), None);
    }
}
