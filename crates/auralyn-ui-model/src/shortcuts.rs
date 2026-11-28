//! グローバルショートカット。保存は Tauri 版と同じ `shortcuts.json`（`[{"action": "muteToggle", "shortcut": "Alt+KeyM"}]`）。
//! 読み方・既定・確かめ方は Tauri 版（`src-tauri/src/shortcuts.rs`）に揃える。

/// 登録できる数の上限（Tauri 版と同じ）。
pub const MAX: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    MuteToggle,
    MuteOn,
    MuteOff,
    BypassToggle,
    BypassOn,
    BypassOff,
    GainUp,
    GainDown,
    SingingOn,
    TalkOn,
    NoiseToggle,
}

impl Action {
    /// 保存の名前（camelCase）から読む。知らない名前は `None`。
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "muteToggle" => Self::MuteToggle,
            "muteOn" => Self::MuteOn,
            "muteOff" => Self::MuteOff,
            "bypassToggle" => Self::BypassToggle,
            "bypassOn" => Self::BypassOn,
            "bypassOff" => Self::BypassOff,
            "gainUp" => Self::GainUp,
            "gainDown" => Self::GainDown,
            "singingOn" => Self::SingingOn,
            "talkOn" => Self::TalkOn,
            "noiseToggle" => Self::NoiseToggle,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    pub action: Action,
    pub shortcut: String,
}

/// 読めなかった理由と、そのもとの値。どれでも、Tauri 版と同じく1つも登録しない。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Issue {
    TooMany(usize),
    UnknownAction(String),
    InvalidShortcut(String),
    ModifierRequired(String),
    Duplicate(String),
}

impl Issue {
    /// 断った値（画面で理由のあとに添える）。
    pub fn detail(&self) -> String {
        match self {
            Self::TooMany(count) => format!("{count} > {MAX}"),
            Self::UnknownAction(text)
            | Self::InvalidShortcut(text)
            | Self::ModifierRequired(text)
            | Self::Duplicate(text) => text.clone(),
        }
    }
}

/// ファイルが無いときの既定（Tauri 版と同じ）。
pub fn defaults() -> Vec<Binding> {
    vec![
        Binding {
            action: Action::MuteToggle,
            shortcut: "Alt+KeyM".into(),
        },
        Binding {
            action: Action::BypassToggle,
            shortcut: "Alt+KeyP".into(),
        },
    ]
}

/// 保存から読んだ組（操作の名前・キー）を確かめる（Tauri 版の `validate` と同じ）。
/// `key` はキーを読み、同じ組合せなら同じ値を返す（書き方の違う `Alt+M` と `Alt+KeyM` も同じにする）。読めなければ `None`。
/// GPUI 版で使わない操作のキーも確かめる。
pub fn check<K: PartialEq>(
    pairs: Vec<(String, String)>,
    key: impl Fn(&str) -> Option<K>,
) -> Result<Vec<Binding>, Issue> {
    if pairs.len() > MAX {
        return Err(Issue::TooMany(pairs.len()));
    }
    let mut bindings: Vec<(Binding, K)> = Vec::new();
    for (name, shortcut) in pairs {
        let action = Action::parse(&name).ok_or(Issue::UnknownAction(name))?;
        let id = key(&shortcut).ok_or_else(|| Issue::InvalidShortcut(shortcut.clone()))?;
        if shortcut.len() > 80 || !shortcut.contains('+') {
            return Err(Issue::ModifierRequired(shortcut));
        }
        if bindings
            .iter()
            .any(|(b, other)| b.action == action || *other == id)
        {
            return Err(Issue::Duplicate(shortcut));
        }
        bindings.push((Binding { action, shortcut }, id));
    }
    Ok(bindings.into_iter().map(|(binding, _)| binding).collect())
}

/// 保存値（`Control+Alt+KeyM`）を、キーボードの刻印に近い表記（`Ctrl + Alt + M`）にする（Tauri 版の `formatShortcut` と同じ）。
pub fn label(shortcut: &str) -> String {
    let mut parts: Vec<&str> = shortcut.split('+').collect();
    let key = parts.pop().unwrap_or_default();
    let key = match key {
        "ArrowUp" => "↑",
        "ArrowDown" => "↓",
        "ArrowLeft" => "←",
        "ArrowRight" => "→",
        _ => key
            .strip_prefix("Key")
            .filter(|k| k.len() == 1)
            .or_else(|| key.strip_prefix("Digit").filter(|k| k.len() == 1))
            .unwrap_or(key),
    };
    parts
        .into_iter()
        .map(|part| match part.to_lowercase().as_str() {
            "control" | "ctrl" => "Ctrl",
            "alt" => "Alt",
            "shift" => "Shift",
            "super" | "meta" => "Windows",
            _ => part,
        })
        .chain([key])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" + ")
}

/// 出力音量を 1% 上げ下げした値（0〜2 に収める。Tauri 版と同じ）。
pub fn gain_step(current: f32, up: bool) -> f32 {
    (current + if up { 0.01 } else { -0.01 }).clamp(0.0, 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(action: &str, shortcut: &str) -> (String, String) {
        (action.into(), shortcut.into())
    }

    /// 試験用のキーの読み方：`Ctrl` を `Control` と同じにし、修飾キーの順を問わない。`?` を含むと読めない。
    fn key(shortcut: &str) -> Option<Vec<String>> {
        if shortcut.contains('?') {
            return None;
        }
        let mut parts: Vec<String> = shortcut
            .to_lowercase()
            .replace("ctrl", "control")
            .split('+')
            .map(str::to_owned)
            .collect();
        parts.sort();
        Some(parts)
    }

    #[test]
    fn saved_bindings_are_checked_like_tauri() {
        assert_eq!(
            check(vec![pair("muteOn", "Control+Alt+KeyM")], key),
            Ok(vec![Binding {
                action: Action::MuteOn,
                shortcut: "Control+Alt+KeyM".into()
            }])
        );
        assert_eq!(
            check(vec![pair("x", "Alt+KeyM")], key),
            Err(Issue::UnknownAction("x".into()))
        );
        assert_eq!(
            check(vec![pair("muteOn", "KeyM")], key),
            Err(Issue::ModifierRequired("KeyM".into()))
        );
        assert_eq!(
            check(
                vec![
                    pair("muteOn", "Ctrl+Alt+KeyM"),
                    pair("muteOff", "Alt+Control+KeyM")
                ],
                key
            ),
            Err(Issue::Duplicate("Alt+Control+KeyM".into()))
        );
        assert_eq!(
            check(
                vec![pair("muteOn", "Alt+KeyA"), pair("muteOn", "Alt+KeyB")],
                key
            ),
            Err(Issue::Duplicate("Alt+KeyB".into()))
        );
        // GPUI 版で使わない操作でも、読めないキーがあれば全部断る。
        assert_eq!(
            check(
                vec![pair("muteOn", "Alt+KeyM"), pair("talkOn", "Alt+?")],
                key
            ),
            Err(Issue::InvalidShortcut("Alt+?".into()))
        );
        assert_eq!(
            check(
                (0..9)
                    .map(|i| pair("muteOn", &format!("Alt+Digit{i}")))
                    .collect(),
                key
            ),
            Err(Issue::TooMany(9))
        );
    }

    #[test]
    fn labels_read_like_the_keyboard() {
        assert_eq!(label("Control+Alt+KeyM"), "Ctrl + Alt + M");
        assert_eq!(label("Super+Shift+Digit1"), "Windows + Shift + 1");
        assert_eq!(label("Alt+ArrowUp"), "Alt + ↑");
        assert_eq!(label("Alt+F12"), "Alt + F12");
    }

    #[test]
    fn gain_steps_by_one_percent_within_range() {
        assert!((gain_step(1.0, true) - 1.01).abs() < 1e-6);
        assert_eq!(gain_step(0.0, false), 0.0);
        assert_eq!(gain_step(2.0, true), 2.0);
    }
}
