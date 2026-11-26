//! 配信ミックス：声に、別の入力（オケ）を混ぜる。オケの取り込み口は WASAPI の入力機器（仮想ケーブルなど）の2チャンネル。
//! アプリの音も取り込める（そのアプリが音を出す出力先を選び、Windows でその出力先をミュートしておく）。
//! 選び方と値の範囲は Tauri 版（`MixingPanel.tsx`・`audio_engine/mixing`）に揃える。

use crate::connect::Device;

/// 音量の上限（200%）。
pub const MAX_GAIN: f32 = 2.0;

/// オケに使える入力機器：WASAPI の入力で、ID があり、声に使っている機器でなく、チャンネルがあるもの。
pub fn sources<'a>(devices: &'a [Device], voice_input: Option<&str>) -> Vec<&'a Device> {
    devices
        .iter()
        .filter(|d| {
            d.is_input
                && d.host.eq_ignore_ascii_case("wasapi")
                && d.channels > 0
                && d.id
                    .as_deref()
                    .is_some_and(|id| !id.is_empty() && Some(id) != voice_input)
        })
        .collect()
}

/// 選べるチャンネルの組（0 から数える）。奇数なら最後は同じチャンネルを2つ使う。256 チャンネルまで。
pub fn pairs(channels: u16) -> Vec<[usize; 2]> {
    let count = usize::from(channels).min(256);
    (0..count.div_ceil(2))
        .map(|i| [i * 2, (i * 2 + 1).min(count - 1)])
        .collect()
}

/// 組の表記（1 から数える）：`1-2`、同じチャンネルなら `3`。
pub fn pair_label(pair: [usize; 2]) -> String {
    if pair[0] == pair[1] {
        (pair[0] + 1).to_string()
    } else {
        format!("{}-{}", pair[0] + 1, pair[1] + 1)
    }
}

/// オケの取り込み口。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Device {
        input_id: String,
        channels: [usize; 2],
    },
    /// アプリの音。`route` はそのアプリが音を出している出力先。
    App {
        key: String,
        name: String,
        route: String,
    },
}

/// オケに選べる起動中のアプリ。`id` は一覧を読み直すまで有効。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct App {
    pub id: String,
    pub key: String,
    pub name: String,
    pub routes: Vec<Route>,
}

/// アプリが音を出している出力先。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub id: String,
    pub name: String,
    pub muted: bool,
}

impl Route {
    /// オケに使えるのは、Windows でその出力先をミュートしてあるときだけ（原音がそのまま聞こえて二重にならないように。Tauri 版と同じ）。
    pub fn usable(&self) -> bool {
        self.muted
    }
}

/// 保存・適用中のアプリを一覧から探す：同じアプリ（キー）で、同じ出力先に音を出しているもの。
pub fn find_app<'a>(apps: &'a [App], key: &str, route: &str) -> Option<&'a App> {
    apps.iter()
        .find(|a| a.key == key && a.routes.iter().any(|r| r.id == route))
}

/// 画面で変えられる音量。オフセット（時間合わせ）は GPUI 版ではまだ変えず、エンジンが持つ値を保つ。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Levels {
    pub voice_gain: f32,
    pub voice_muted: bool,
    pub music_gain: f32,
    pub music_muted: bool,
    /// オケを自分のモニターにも返す。
    pub monitor_music: bool,
}

/// 音量の1つの操作。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Change {
    VoiceGain(f32),
    VoiceMuted(bool),
    MusicGain(f32),
    MusicMuted(bool),
    MonitorMusic(bool),
}

impl Levels {
    pub fn with(self, change: Change) -> Self {
        let gain = |g: f32| {
            if g.is_finite() {
                g.clamp(0.0, MAX_GAIN)
            } else {
                1.0
            }
        };
        match change {
            Change::VoiceGain(g) => Self {
                voice_gain: gain(g),
                ..self
            },
            Change::VoiceMuted(m) => Self {
                voice_muted: m,
                ..self
            },
            Change::MusicGain(g) => Self {
                music_gain: gain(g),
                ..self
            },
            Change::MusicMuted(m) => Self {
                music_muted: m,
                ..self
            },
            Change::MonitorMusic(m) => Self {
                monitor_music: m,
                ..self
            },
        }
    }
}

/// エンジンから読んだミックスの状態。
#[derive(Clone, Debug, PartialEq)]
pub struct Mix {
    /// 適用中の取り込み口。`None` は混ぜていない。
    pub active: Option<Source>,
    /// 保存してある取り込み口（起動し直したあとは、選び直して適用するまで混ざらない）。
    pub saved: Option<Source>,
    /// 適用中、無ければ保存の音量。
    pub levels: Option<Levels>,
    /// オケが流れている。
    pub running: bool,
    pub failed: bool,
    /// 保存の読み込みなどの問題（Tauri 版の文言のまま）。
    pub error: Option<String>,
}

impl Mix {
    /// 音量を変えられるのは、適用中のときだけ（Tauri 版と同じ）。
    pub fn can_change_levels(&self) -> bool {
        self.active.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(host: &str, id: &str, is_input: bool, channels: u16) -> Device {
        Device {
            host: host.into(),
            name: id.into(),
            id: Some(id.into()),
            is_input,
            is_default: false,
            channels,
            rates: None,
            buffers: None,
        }
    }

    #[test]
    fn sources_are_other_wasapi_inputs() {
        let devices = [
            device("WASAPI", "mic", true, 2),
            device("WASAPI", "cable", true, 8),
            device("ASIO", "asio", true, 2),
            device("WASAPI", "speaker", false, 2),
            device("WASAPI", "silent", true, 0),
        ];
        let ids: Vec<_> = sources(&devices, Some("mic"))
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(ids, ["cable"]);
    }

    #[test]
    fn pairs_cover_every_channel() {
        assert_eq!(pairs(2), [[0, 1]]);
        assert_eq!(pairs(3), [[0, 1], [2, 2]]);
        assert_eq!(pairs(0), Vec::<[usize; 2]>::new());
        assert_eq!(pair_label([0, 1]), "1-2");
        assert_eq!(pair_label([2, 2]), "3");
    }

    #[test]
    fn saved_app_is_found_by_key_and_route() {
        let route = |id: &str, muted| Route {
            id: id.into(),
            name: id.into(),
            muted,
        };
        let app = |id: &str, key: &str, routes| App {
            id: id.into(),
            key: key.into(),
            name: key.into(),
            routes,
        };
        let apps = [
            app("app-1", "player", vec![route("speaker", false)]),
            app("app-2", "player", vec![route("cable", true)]),
        ];
        assert_eq!(
            find_app(&apps, "player", "cable").map(|a| a.id.as_str()),
            Some("app-2")
        );
        assert_eq!(find_app(&apps, "browser", "cable"), None);
        assert!(!apps[0].routes[0].usable());
        assert!(apps[1].routes[0].usable());
    }

    #[test]
    fn gains_stay_in_range() {
        let levels = Levels {
            voice_gain: 1.0,
            voice_muted: false,
            music_gain: 1.0,
            music_muted: false,
            monitor_music: true,
        };
        assert_eq!(levels.with(Change::MusicGain(3.0)).music_gain, MAX_GAIN);
        assert_eq!(levels.with(Change::VoiceGain(f32::NAN)).voice_gain, 1.0);
        assert!(!levels.with(Change::MonitorMusic(false)).monitor_music);
    }
}
