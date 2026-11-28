//! デザイントークン。正本は `design/tokens.json`（色の値はここで直す）。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    Gaming,
}

impl Theme {
    pub const ALL: [Theme; 3] = [Theme::Light, Theme::Dark, Theme::Gaming];
}

/// 不透明な sRGB の色。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    /// `#rrggbb` を読む。
    pub fn parse_hex(text: &str) -> Option<Self> {
        let hex = text.strip_prefix('#')?;
        if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
        Some(Self {
            r: channel(0)?,
            g: channel(2)?,
            b: channel(4)?,
        })
    }
}

impl fmt::Display for Rgb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }
}

impl<'de> Deserialize<'de> for Rgb {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Rgb::parse_hex(&text)
            .ok_or_else(|| serde::de::Error::custom(format!("#rrggbb ではない色です: {text}")))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemedColor {
    pub light: Rgb,
    pub dark: Rgb,
    pub gaming: Rgb,
}

impl ThemedColor {
    pub fn get(&self, theme: Theme) -> Rgb {
        match theme {
            Theme::Light => self.light,
            Theme::Dark => self.dark,
            Theme::Gaming => self.gaming,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tokens {
    pub source: String,
    pub themes: Vec<Theme>,
    /// 名前は `index.css` の変数名から `--` を除いたもの（例：`primary`、`card-foreground`）。
    pub colors: BTreeMap<String, ThemedColor>,
    /// 角丸（px）。
    pub radius: BTreeMap<String, f32>,
}

impl Tokens {
    pub fn from_json(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    pub fn color(&self, name: &str, theme: Theme) -> Option<Rgb> {
        self.colors.get(name).map(|color| color.get(theme))
    }

    pub fn radius(&self, name: &str) -> Option<f32> {
        self.radius.get(name).copied()
    }
}

const TOKENS_JSON: &str = include_str!("../../../../design/tokens.json");

/// アプリに埋め込んだトークン。形の誤りは試験 `builtin_tokens_load` で止める。
pub fn tokens() -> &'static Tokens {
    static TOKENS: OnceLock<Tokens> = OnceLock::new();
    TOKENS.get_or_init(|| {
        Tokens::from_json(TOKENS_JSON).expect("埋め込んだ design/tokens.json が読めません")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_tokens_load() {
        let tokens = tokens();
        assert_eq!(tokens.themes, Theme::ALL);
        assert!(!tokens.colors.is_empty());
        for name in ["background", "foreground", "primary", "card"] {
            for theme in Theme::ALL {
                assert!(tokens.color(name, theme).is_some(), "{name} {theme:?}");
            }
        }
        assert_eq!(tokens.radius("card"), Some(12.0));
    }

    #[test]
    fn hex_colors_round_trip() {
        let color = Rgb::parse_hex("#0b6f65").unwrap();
        assert_eq!(
            color,
            Rgb {
                r: 0x0b,
                g: 0x6f,
                b: 0x65
            }
        );
        assert_eq!(color.to_string(), "#0b6f65");
        for bad in ["0b6f65", "#0b6f6", "#0b6f65ff", "#zz6f65"] {
            assert_eq!(Rgb::parse_hex(bad), None, "{bad}");
        }
    }

    #[test]
    fn unknown_color_names_and_bad_values_are_errors() {
        assert!(Tokens::from_json(
            r##"{"source":"x","themes":[],"colors":{"a":{"light":"#000000","dark":"#000000","gaming":"red"}},"radius":{}}"##
        )
        .is_err());
        assert!(tokens().color("no-such-color", Theme::Dark).is_none());
    }
}
