//! 配信ミックス：声に、別の入力（オケ）を混ぜる。オケの取り込み口は WASAPI の入力機器（仮想ケーブルなど）の2チャンネル。
//! アプリの音も取り込める（アプリの音を1つの出力先に出し、Windows でその出力先をミュートしておく）。
//! 選び方と値の範囲、時間差を確かめた機材の比べ方は `audio_engine/mixing` に揃える。

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

impl App {
    /// オケに使える出力先：アプリの音がすべて1つの出力先に出ていて、そこを Windows でミュートしてあるとき
    /// （原音がそのまま聞こえて二重にならないように。ホストの `process_capture::sessions` の確認と同じ）。
    pub fn usable_route(&self) -> Option<&Route> {
        let first = self.routes.first()?;
        self.routes
            .iter()
            .all(|r| r.id == first.id && r.muted)
            .then_some(first)
    }
}

/// 一覧を読み直したあと、前に選んでいたアプリを探す。同じ候補（`id`）、無ければ同じ出力先に音を出す同じアプリ、
/// それも無ければ同じアプリ（キー）の位置。
pub fn find_app(apps: &[App], id: Option<&str>, key: &str, route: Option<&str>) -> Option<usize> {
    let same = |a: &App| a.key == key;
    id.and_then(|id| apps.iter().position(|a| same(a) && a.id == id))
        .or_else(|| {
            let route = route?;
            apps.iter()
                .position(|a| same(a) && a.routes.iter().any(|r| r.id == route))
        })
        .or_else(|| apps.iter().position(same))
}

/// 時間差の範囲（±ms）。
pub const MAX_OFFSET_MS: i32 = 2000;

/// 画面で変えられる音量と時間差。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Levels {
    pub voice_gain: f32,
    pub voice_muted: bool,
    pub music_gain: f32,
    pub music_muted: bool,
    /// オケを自分のモニターにも返す。
    pub monitor_music: bool,
    /// 配信用の手動の時間差（ms）。正はオケ、負は声を遅らせる。
    pub offset_ms: i32,
}

/// 音量の1つの操作。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Change {
    VoiceGain(f32),
    VoiceMuted(bool),
    MusicGain(f32),
    MusicMuted(bool),
    MonitorMusic(bool),
    OffsetMs(i32),
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
            Change::OffsetMs(ms) => Self {
                offset_ms: ms.clamp(-MAX_OFFSET_MS, MAX_OFFSET_MS),
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
    /// 時間差を合わせたときと今の機材の組み合わせが同じか。
    pub offset: OffsetStatus,
    /// オケが流れている。
    pub running: bool,
    pub failed: bool,
    /// 保存の読み込みなどの問題。
    pub error: Option<String>,
}

/// 時間差を合わせたときの機材の組み合わせ（保存済みの記録と同じ作り方）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OffsetContext {
    pub voice_input_id: String,
    pub voice_channels: [usize; 2],
    /// オケの取り込み口を表す文字列（作り方はエンジン側。表示名や PID は入れない）。
    pub accompaniment: String,
    pub output_id: String,
    pub broadcast_id: Option<String>,
}

/// 組み合わせのうち、変わったもの。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Field {
    VoiceInput,
    VoiceChannels,
    Accompaniment,
    Output,
    Broadcast,
}

/// 時間差の確かめの状態。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OffsetStatus {
    /// 時間差なし。
    None,
    /// 合わせたときと同じ機材。
    Confirmed,
    /// 機材が変わった（変わったもの）。空なら、合わせたときの記録が無い。
    Unconfirmed(Vec<Field>),
    /// 今の組み合わせが分からない（まだ開始していない・アプリの音を声に使っている など）。
    Unknown,
}

/// 機器の識別：ID、無ければ `name:名前`。
pub fn identity(id: Option<&str>, name: Option<&str>) -> Option<String> {
    let id = id.map(str::trim).filter(|id| !id.is_empty());
    let name = name.map(str::trim).filter(|name| !name.is_empty());
    id.map(str::to_owned)
        .or_else(|| name.map(|name| format!("name:{name}")))
}

/// 合わせたときから変わったもの。
pub fn changes(saved: &OffsetContext, current: &OffsetContext) -> Vec<Field> {
    [
        (
            Field::VoiceInput,
            saved.voice_input_id == current.voice_input_id,
        ),
        (
            Field::VoiceChannels,
            saved.voice_channels == current.voice_channels,
        ),
        (
            Field::Accompaniment,
            saved.accompaniment == current.accompaniment,
        ),
        (Field::Output, saved.output_id == current.output_id),
        (Field::Broadcast, saved.broadcast_id == current.broadcast_id),
    ]
    .into_iter()
    .filter(|(_, same)| !same)
    .map(|(field, _)| field)
    .collect()
}

/// 時間差の確かめの状態。`saved` は合わせたときの記録、`current` は今の組み合わせ（分からなければ `None`）。
pub fn offset_status(
    offset_ms: i32,
    saved: Option<&OffsetContext>,
    current: Option<&OffsetContext>,
) -> OffsetStatus {
    if offset_ms == 0 {
        return OffsetStatus::None;
    }
    let Some(current) = current else {
        return OffsetStatus::Unknown;
    };
    match saved.map(|saved| changes(saved, current)) {
        Some(changed) if changed.is_empty() => OffsetStatus::Confirmed,
        Some(changed) => OffsetStatus::Unconfirmed(changed),
        None => OffsetStatus::Unconfirmed(Vec::new()),
    }
}

/// 入力した時間差（整数の ms、±2000 まで）。読めなければ `None`。
pub fn parse_offset(text: &str) -> Option<i32> {
    text.trim()
        .parse::<i32>()
        .ok()
        .filter(|ms| (-MAX_OFFSET_MS..=MAX_OFFSET_MS).contains(ms))
}

impl Mix {
    /// 音量を変えられるのは、適用中のときだけ。
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

    fn route(id: &str, muted: bool) -> Route {
        Route {
            id: id.into(),
            name: id.into(),
            muted,
        }
    }

    fn app(id: &str, key: &str, routes: Vec<Route>) -> App {
        App {
            id: id.into(),
            key: key.into(),
            name: key.into(),
            routes,
        }
    }

    #[test]
    fn app_is_usable_only_through_one_muted_output() {
        let usable = |routes| {
            app("a", "player", routes)
                .usable_route()
                .map(|r| r.id.clone())
        };
        assert_eq!(usable(vec![route("cable", true)]), Some("cable".into()));
        assert_eq!(
            usable(vec![route("cable", true), route("cable", true)]),
            Some("cable".into())
        );
        assert_eq!(usable(vec![route("cable", false)]), None);
        assert_eq!(
            usable(vec![route("cable", true), route("speaker", false)]),
            None
        );
        assert_eq!(usable(vec![]), None);
    }

    #[test]
    fn previous_app_is_found_by_id_then_route_then_key() {
        let apps = [
            app("app-1", "player", vec![route("speaker", false)]),
            app("app-2", "player", vec![route("cable", true)]),
        ];
        assert_eq!(
            find_app(&apps, Some("app-1"), "player", Some("cable")),
            Some(0)
        );
        assert_eq!(find_app(&apps, None, "player", Some("cable")), Some(1));
        assert_eq!(
            find_app(&apps, Some("app-9"), "player", Some("gone")),
            Some(0)
        );
        assert_eq!(find_app(&apps, Some("app-1"), "browser", None), None);
    }

    #[test]
    fn gains_stay_in_range() {
        let levels = Levels {
            voice_gain: 1.0,
            voice_muted: false,
            music_gain: 1.0,
            music_muted: false,
            monitor_music: true,
            offset_ms: 0,
        };
        assert_eq!(levels.with(Change::MusicGain(3.0)).music_gain, MAX_GAIN);
        assert_eq!(
            levels.with(Change::OffsetMs(-5000)).offset_ms,
            -MAX_OFFSET_MS
        );
        assert_eq!(levels.with(Change::VoiceGain(f32::NAN)).voice_gain, 1.0);
        assert!(!levels.with(Change::MonitorMusic(false)).monitor_music);
    }

    fn context() -> OffsetContext {
        OffsetContext {
            voice_input_id: "mic".into(),
            voice_channels: [0, 1],
            accompaniment: "cable".into(),
            output_id: "speaker".into(),
            broadcast_id: Some("live".into()),
        }
    }

    #[test]
    fn offset_is_confirmed_only_on_the_same_rig() {
        let saved = context();
        let moved = OffsetContext {
            voice_channels: [2, 3],
            broadcast_id: None,
            ..context()
        };
        assert_eq!(offset_status(0, None, None), OffsetStatus::None);
        assert_eq!(offset_status(30, Some(&saved), None), OffsetStatus::Unknown);
        assert_eq!(
            offset_status(30, Some(&saved), Some(&saved)),
            OffsetStatus::Confirmed
        );
        assert_eq!(
            offset_status(30, Some(&saved), Some(&moved)),
            OffsetStatus::Unconfirmed(vec![Field::VoiceChannels, Field::Broadcast])
        );
        assert_eq!(
            offset_status(-30, None, Some(&saved)),
            OffsetStatus::Unconfirmed(Vec::new())
        );
    }

    #[test]
    fn devices_are_identified_by_id_then_name() {
        assert_eq!(identity(Some(" id "), Some("Mic")).as_deref(), Some("id"));
        assert_eq!(
            identity(Some(""), Some(" Mic ")).as_deref(),
            Some("name:Mic")
        );
        assert_eq!(identity(None, None), None);
    }

    #[test]
    fn offset_text_is_whole_milliseconds_in_range() {
        assert_eq!(parse_offset(" -120 "), Some(-120));
        assert_eq!(parse_offset("2001"), None);
        assert_eq!(parse_offset("1.5"), None);
        assert_eq!(parse_offset(""), None);
    }
}
