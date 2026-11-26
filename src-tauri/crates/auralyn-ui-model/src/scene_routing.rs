//! OBS のシーン連動（Tauri 版 `useLiveSceneRouting`・`ObsModeRoutingSettings` と同じ判断）。
//! シーンが替わったら、同じ名前の構成を読むか、割り当てた歌・雑談モードへ切り替える。方式は1つだけ。
//! 接続・再接続のときは切り替えず、OBS で実際にシーンが替わったときだけ動く。

use crate::live_modes::Mode;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Strategy {
    #[default]
    None,
    /// 同じ名前の構成を読む（VST を読み直す）。
    Profile,
    /// 割り当てた歌・雑談へ切り替える（VST はそのまま）。
    Mode,
}

impl Strategy {
    pub const ALL: [Strategy; 3] = [Strategy::None, Strategy::Profile, Strategy::Mode];

    /// 保存するときの名前（Tauri 版と同じ）。
    pub fn key(self) -> &'static str {
        match self {
            Strategy::None => "none",
            Strategy::Profile => "preset",
            Strategy::Mode => "mode",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|s| s.key() == key)
    }
}

pub fn mode_key(mode: Mode) -> &'static str {
    match mode {
        Mode::Singing => "singing",
        Mode::Talk => "talk",
    }
}

pub fn mode_from_key(key: &str) -> Option<Mode> {
    Mode::ALL.into_iter().find(|m| mode_key(*m) == key)
}

/// 保存した連動。無ければ連動しない（Tauri 版の「未設定なら同名の構成」は、GPUI 版では引き継がない）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Routing {
    pub strategy: Strategy,
    pub enabled: bool,
    /// シーン名と切り替え先。歌・雑談の方式だけが使う。
    pub scenes: Vec<(String, Mode)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Profile(String),
    Mode(Mode),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Issue {
    /// シーン名が空か、同じ名前が2つある。
    Names,
}

impl Routing {
    /// 入力から保存する形を作る。シーン名は前後の空白を除く。「連動なし」なら有効にしない。
    pub fn checked(
        strategy: Strategy,
        enabled: bool,
        rows: &[(String, Mode)],
    ) -> Result<Routing, Issue> {
        let scenes: Vec<(String, Mode)> = rows
            .iter()
            .map(|(name, mode)| (name.trim().to_string(), *mode))
            .collect();
        let blank = scenes.iter().any(|(name, _)| name.is_empty());
        let repeated = scenes
            .iter()
            .enumerate()
            .any(|(i, (name, _))| scenes[..i].iter().any(|(other, _)| other == name));
        if blank || repeated {
            return Err(Issue::Names);
        }
        Ok(Routing {
            strategy,
            enabled: enabled && strategy != Strategy::None,
            scenes,
        })
    }

    /// シーンが替わったときの操作。割り当ての無いシーンでは何もしない。
    /// 構成の方式では、同じ名前の構成があるかは呼ぶ側が確かめる（無ければ何もしない）。
    pub fn action(&self, scene: &str) -> Option<Action> {
        if !self.enabled {
            return None;
        }
        match self.strategy {
            Strategy::None => None,
            Strategy::Profile => Some(Action::Profile(scene.to_string())),
            Strategy::Mode => self
                .scenes
                .iter()
                .find(|(name, _)| name == scene)
                .map(|(_, mode)| Action::Mode(*mode)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_and_match_the_tauri_names() {
        for strategy in Strategy::ALL {
            assert_eq!(Strategy::from_key(strategy.key()), Some(strategy));
        }
        assert_eq!(Strategy::Profile.key(), "preset");
        for mode in Mode::ALL {
            assert_eq!(mode_from_key(mode_key(mode)), Some(mode));
        }
        assert_eq!(Strategy::from_key("other"), None);
    }

    #[test]
    fn blank_or_repeated_scene_names_are_refused() {
        let row = |name: &str| (name.to_string(), Mode::Singing);
        assert_eq!(
            Routing::checked(Strategy::Mode, true, &[row(" ")]),
            Err(Issue::Names)
        );
        assert_eq!(
            Routing::checked(Strategy::Mode, true, &[row("歌"), row(" 歌 ")]),
            Err(Issue::Names)
        );
        let ok = Routing::checked(Strategy::Mode, true, &[row(" 歌 ")]).unwrap();
        assert_eq!(ok.scenes, vec![("歌".to_string(), Mode::Singing)]);
    }

    #[test]
    fn only_enabled_routing_acts_and_none_is_never_enabled() {
        let rows = [("Talk".to_string(), Mode::Talk)];
        let off = Routing::checked(Strategy::Mode, false, &rows).unwrap();
        assert_eq!(off.action("Talk"), None);
        let none = Routing::checked(Strategy::None, true, &rows).unwrap();
        assert!(!none.enabled);
        let modes = Routing::checked(Strategy::Mode, true, &rows).unwrap();
        assert_eq!(modes.action("Talk"), Some(Action::Mode(Mode::Talk)));
        assert_eq!(modes.action("Other"), None);
        let profiles = Routing::checked(Strategy::Profile, true, &[]).unwrap();
        assert_eq!(
            profiles.action("Live"),
            Some(Action::Profile("Live".into()))
        );
    }
}
