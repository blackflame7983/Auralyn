//! 接続の画面：接続方式・マイク・出力先の選び方。
//!
//! 機器の一覧と保存した設定から、最初に選んでおく項目を決める。ASIO はドライバー1つが入出力の両方を受け持つ。
//! 周波数とバッファの候補は、機器が知らせた範囲で絞る（Tauri 版の `sampleRateOptions`・`useAudioDeviceSelection` と同じ考え方）。

/// エンジンが見つけた機器。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub host: String,
    pub name: String,
    pub id: Option<String>,
    pub is_input: bool,
    pub is_default: bool,
    /// チャンネル数（分からなければ 0）。
    pub channels: u16,
    /// 受け付ける周波数（Hz）の範囲。分からなければ `None`。
    pub rates: Option<Vec<(u32, u32)>>,
    /// 受け付けるバッファ（サンプル数）の範囲。分からなければ `None`。
    pub buffers: Option<(u32, u32)>,
}

/// 保存した設定のうち、機器を選ぶのに使う部分。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Saved {
    pub host: String,
    pub input: Option<String>,
    pub input_id: Option<String>,
    pub output: Option<String>,
    pub output_id: Option<String>,
    pub sample_rate: Option<u32>,
    pub buffer_size: Option<u32>,
    /// ASIO のチャンネルの割り当て。
    pub routing: Option<Routing>,
    /// 入力の使い道。
    pub purpose: Purpose,
    /// アプリの音声を入力にしていたら、そのアプリ。
    pub app: Option<AppSource>,
}

/// 入力の使い道（Tauri 版と同じ2つ）。音楽なら声向けの処理を省く。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Purpose {
    #[default]
    Voice,
    Music,
}

impl Purpose {
    pub const ALL: [Purpose; 2] = [Purpose::Voice, Purpose::Music];

    /// 切り替え先（Tauri 版の使い道の切り替えと同じく2つを行き来する）。
    pub fn other(self) -> Purpose {
        match self {
            Purpose::Voice => Purpose::Music,
            Purpose::Music => Purpose::Voice,
        }
    }
}

/// 入力にするアプリの音声。`route` はアプリが音を出している出力先（原音の出力先）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppSource {
    pub key: String,
    pub name: String,
    pub route: String,
}

/// 開始に使う入力。アプリの `candidate_id` は一覧を読み直すまで有効。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    Device(Device),
    App {
        candidate_id: String,
        source: AppSource,
    },
}

/// アプリの音声を選べる接続方式（Tauri 版と同じく WASAPI だけ）。
pub fn allows_app(host: &str) -> bool {
    host.eq_ignore_ascii_case("WASAPI")
}

/// 最初にアプリの音声を選んでおくか。同じ接続方式でアプリを保存していたとき。
pub fn starts_with_app(saved: Option<&Saved>, host: &str) -> bool {
    saved.is_some_and(|s| s.app.is_some() && s.host == host) && allows_app(host)
}

/// ASIO の出力の返し方（Tauri 版 `OutputRouting` と同じ3つ）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Output {
    /// 保存済みの接続を維持する。同じ番号の出力があればそこへ、なければ出力 1/2。
    #[default]
    Legacy,
    /// 指定した出力のペアへ送る。
    Independent([usize; 2]),
    /// 選んだ入力と同じ番号の出力へ返す（Voicemeeter Insert など）。
    Insert,
}

/// ASIO のチャンネルの割り当て。`input` が `None` なら入力のペアはホストに任せる。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Routing {
    pub input: Option<[usize; 2]>,
    pub output: Output,
}

impl Output {
    /// 選択欄の並び（Tauri 版と同じ：指定・Insert・従来）での位置。
    pub fn row(self) -> usize {
        match self {
            Output::Independent(_) => 0,
            Output::Insert => 1,
            Output::Legacy => 2,
        }
    }

    /// 選択欄の位置から。「指定」で出力のペアが分からなければ 1/2。
    pub fn from_row(row: Option<usize>, pair: Option<[usize; 2]>) -> Output {
        match row {
            Some(0) => Output::Independent(pair.unwrap_or([0, 1])),
            Some(1) => Output::Insert,
            _ => Output::Legacy,
        }
    }
}

/// 選択欄のラベル（`labels` の形）から機器を探す。
pub fn by_label<'a>(
    devices: &'a [Device],
    host: &str,
    is_input: bool,
    label: &str,
) -> Option<&'a Device> {
    let choices = of_host(devices, host, is_input);
    let row = labels(&choices).iter().position(|l| l == label)?;
    choices.get(row).copied()
}

/// 入力・出力のペアの候補（Tauri 版と同じ）。端数の最後は左右同じ（モノラル）。`keep` が候補に無ければ足す
/// （チャンネル数が分からなくても、保存した番号を消さない）。
pub fn pairs(channels: u16, keep: Option<[usize; 2]>) -> Vec<[usize; 2]> {
    let mut pairs = crate::mix::pairs(channels);
    if let Some(keep) = keep.filter(|keep| !pairs.contains(keep)) {
        pairs.push(keep);
    }
    pairs
}

/// ASIO 以外で送る割り当て（Tauri 版と同じ。入力 1/2 を出力 1/2 へ）。
pub const SYSTEM_ROUTING: Routing = Routing {
    input: Some([0, 1]),
    output: Output::Independent([0, 1]),
};

/// 最初のペア。モノラルの機器なら左右とも 1 番。
pub fn first_pair(channels: u16) -> [usize; 2] {
    [0, usize::from(channels != 1)]
}

/// 機器を選んだときに最初に入れておく割り当て（Tauri 版と同じ）。
/// 保存した同じドライバーなら保存した割り当て（返し方が無ければ従来の返し方）、違う機器なら最初のペアを同じ番号の出力へ。
pub fn initial_routing(saved: Option<&Saved>, input: &Device) -> Routing {
    let first = first_pair(input.channels);
    let same = saved.filter(|saved| is_saved_input(saved, input));
    match same {
        Some(saved) => saved.routing.unwrap_or(Routing {
            input: Some(first),
            output: Output::Legacy,
        }),
        None => Routing {
            input: Some(first),
            output: Output::Independent(first),
        },
    }
}

/// 保存した接続の入力の機器か（ID か名前が同じ、同じ接続方式の機器）。
pub fn is_saved_input(saved: &Saved, device: &Device) -> bool {
    saved.host == device.host
        && (saved.input_id.is_some() && saved.input_id == device.id
            || saved.input.as_deref() == Some(device.name.as_str()))
}

/// 動いている接続が ASIO の機器（アプリの音声でない）なら、その入力のペア。割り当てが無ければエンジンと同じく 1-2。
pub fn running_asio_pair(
    host: &str,
    from_app: bool,
    input: Option<[usize; 2]>,
) -> Option<[usize; 2]> {
    (shares_device(&canonical_host(host)) && !from_app).then(|| input.unwrap_or([0, 1]))
}

const ASIO: &str = "ASIO";
const WASAPI: &str = "WASAPI";

/// WASAPI の共有モードは、Windows のサウンド設定と同じ周波数でないと開始できない。
pub fn uses_system_rate(host: &str) -> bool {
    host == WASAPI
}

/// ASIO では、選んだドライバーが入出力の両方を受け持つ（出力は選ばせない）。
pub fn shares_device(host: &str) -> bool {
    host == ASIO
}

/// 接続方式の名前をそろえる。エンジンは一覧で「Wasapi」、動いている機器と保存した設定では「WASAPI」と
/// 書くので、大文字小文字の違いを同じ方式として ASIO・WASAPI の表記にする（ほかの名前はそのまま）。
pub fn canonical_host(host: &str) -> String {
    [ASIO, WASAPI]
        .into_iter()
        .find(|known| known.eq_ignore_ascii_case(host))
        .unwrap_or(host)
        .to_owned()
}

/// 接続方式の一覧。一覧に出てきた順で、重ねない。
pub fn hosts(devices: &[Device]) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for device in devices {
        if !hosts.contains(&device.host) {
            hosts.push(device.host.clone());
        }
    }
    hosts
}

/// 最初に選ぶ接続方式：保存した方式、無ければ WASAPI、無ければ先頭。
pub fn initial_host(hosts: &[String], saved: Option<&Saved>) -> Option<usize> {
    let find = |name: &str| hosts.iter().position(|host| host == name);
    saved
        .and_then(|saved| find(&saved.host))
        .or_else(|| find(WASAPI))
        .or(if hosts.is_empty() { None } else { Some(0) })
}

/// その接続方式の入力（または出力）の機器。
pub fn of_host<'a>(devices: &'a [Device], host: &str, is_input: bool) -> Vec<&'a Device> {
    devices
        .iter()
        .filter(|device| device.host == host && device.is_input == is_input)
        .collect()
}

/// 最初に選ぶ機器（`choices` の中の位置）：保存した ID、同じ名前、既定の機器、先頭の順。
/// 保存した設定は、同じ接続方式のときだけ使う。
pub fn initial_device(choices: &[&Device], saved: Option<&Saved>, is_input: bool) -> Option<usize> {
    let saved = saved.filter(|saved| choices.first().is_some_and(|d| d.host == saved.host));
    let (id, name) = match saved {
        Some(saved) if is_input => (saved.input_id.as_deref(), saved.input.as_deref()),
        Some(saved) => (saved.output_id.as_deref(), saved.output.as_deref()),
        None => (None, None),
    };
    let find = |matches: &dyn Fn(&Device) -> bool| choices.iter().position(|d| matches(d));
    id.and_then(|id| find(&|d| d.id.as_deref() == Some(id)))
        .or_else(|| name.and_then(|name| find(&|d| d.name == name)))
        .or_else(|| find(&|d| d.is_default))
        .or(if choices.is_empty() { None } else { Some(0) })
}

/// 選択肢に出す名前。同じ名前の機器が2台以上あれば、2台目から「名前 (2)」のように番号を付けて見分ける。
/// 選択肢は名前で選んだ行を覚えるので、名前が重なると選んだ機器と違う機器で始まってしまう。
pub fn labels(choices: &[&Device]) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for device in choices {
        let mut label = device.name.clone();
        let mut number = 1;
        while labels.contains(&label) {
            number += 1;
            label = format!("{} ({number})", device.name);
        }
        labels.push(label);
    }
    labels
}

/// よく使う周波数（Hz）とバッファ（サンプル数）。機器の範囲が分からないときは、これをそのまま出す。
pub const COMMON_RATES: [u32; 5] = [44_100, 48_000, 88_200, 96_000, 192_000];
pub const COMMON_BUFFERS: [u32; 7] = [64, 128, 256, 512, 1024, 2048, 4096];

/// 周波数の候補。WASAPI は出力の範囲、ASIO は入出力の両方の範囲に入るものだけ。
/// 範囲の端の値と、範囲に入る保存した値（`keep`）も候補に入れる。
pub fn rates(input: &Device, output: &Device, asio: bool, keep: Option<u32>) -> Vec<u32> {
    let relevant: Vec<&Vec<(u32, u32)>> = if asio {
        [input, output]
            .iter()
            .filter_map(|d| d.rates.as_ref())
            .collect()
    } else {
        output.rates.iter().collect()
    };
    let ends = relevant
        .iter()
        .flat_map(|ranges| ranges.iter().flat_map(|&(a, b)| [a, b]));
    let mut rates: Vec<u32> = COMMON_RATES
        .into_iter()
        .chain(ends)
        .chain(keep)
        .filter(|&rate| {
            rate > 0
                && relevant
                    .iter()
                    .all(|ranges| ranges.iter().any(|&(min, max)| (min..=max).contains(&rate)))
        })
        .collect();
    rates.sort_unstable();
    rates.dedup();
    rates
}

/// バッファの候補。範囲が分かれば、その中のよく使う値（無ければ範囲の両端）。範囲に入る保存した値（`keep`）も入れる。
pub fn buffers(device: &Device, keep: Option<u32>) -> Vec<u32> {
    let (min, max) = device.buffers.unwrap_or((1, u32::MAX));
    let inside = |size: &u32| (min..=max).contains(size);
    let mut sizes: Vec<u32> = COMMON_BUFFERS.into_iter().filter(inside).collect();
    if sizes.is_empty() {
        sizes = vec![min, max];
    }
    sizes.extend(keep.filter(inside));
    sizes.sort_unstable();
    sizes.dedup();
    sizes
}

/// 保存した周波数やバッファ。同じ接続方式のものだけ使う。`None` は「自動」（エンジンが機器に合わせて決める）。
pub fn saved_value(
    saved: Option<&Saved>,
    host: &str,
    value: impl Fn(&Saved) -> Option<u32>,
) -> Option<u32> {
    saved.filter(|saved| saved.host == host).and_then(value)
}

/// 周波数やバッファの選択肢の行。0 行目は「自動」で、`values[n]` は n + 1 行目。候補に無い値は「自動」。
pub fn row_of(values: &[u32], value: Option<u32>) -> usize {
    value
        .and_then(|value| values.iter().position(|&v| v == value))
        .map_or(0, |row| row + 1)
}

/// `row_of` の逆。「自動」の行は `None`。
pub fn value_at(values: &[u32], row: usize) -> Option<u32> {
    values.get(row.checked_sub(1)?).copied()
}

/// ASIO で入力に選んだドライバーと同じ名前の出力。
pub fn shared_output<'a>(outputs: &[&'a Device], input: &Device) -> Option<&'a Device> {
    outputs
        .iter()
        .copied()
        .find(|output| output.name == input.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_asio_pair_defaults_to_the_first_pair() {
        assert_eq!(running_asio_pair("ASIO", false, Some([6, 7])), Some([6, 7]));
        assert_eq!(running_asio_pair("Asio", false, None), Some([0, 1]));
        assert_eq!(running_asio_pair("ASIO", true, Some([6, 7])), None);
        assert_eq!(running_asio_pair("Wasapi", false, None), None);
    }

    #[test]
    fn host_names_from_the_engine_are_unified() {
        assert_eq!(canonical_host("Wasapi"), "WASAPI");
        assert_eq!(canonical_host("WASAPI"), "WASAPI");
        assert_eq!(canonical_host("asio"), "ASIO");
        assert_eq!(canonical_host("JACK"), "JACK");
    }

    fn device(host: &str, name: &str, is_input: bool, is_default: bool) -> Device {
        Device {
            host: host.into(),
            name: name.into(),
            id: Some(format!("{host}:{name}")),
            is_input,
            is_default,
            channels: 2,
            rates: None,
            buffers: None,
        }
    }

    fn list() -> Vec<Device> {
        vec![
            device("ASIO", "Interface", true, false),
            device("ASIO", "Interface", false, false),
            device("WASAPI", "Mic A", true, false),
            device("WASAPI", "Mic B", true, true),
            device("WASAPI", "Speaker", false, true),
            device("WASAPI", "Cable", false, false),
        ]
    }

    #[test]
    fn hosts_keep_first_seen_order_without_duplicates() {
        assert_eq!(hosts(&list()), ["ASIO", "WASAPI"]);
    }

    #[test]
    fn host_prefers_saved_then_wasapi() {
        let hosts = hosts(&list());
        let saved = Saved {
            host: "ASIO".into(),
            ..Saved::default()
        };
        assert_eq!(initial_host(&hosts, Some(&saved)), Some(0));
        assert_eq!(initial_host(&hosts, None), Some(1));
        assert_eq!(initial_host(&[], None), None);
    }

    #[test]
    fn device_prefers_saved_id_then_name_then_default() {
        let devices = list();
        let inputs = of_host(&devices, "WASAPI", true);
        let by_id = Saved {
            host: "WASAPI".into(),
            input: Some("Mic B".into()),
            input_id: Some("WASAPI:Mic A".into()),
            ..Saved::default()
        };
        assert_eq!(initial_device(&inputs, Some(&by_id), true), Some(0));
        let by_name = Saved {
            input_id: Some("gone".into()),
            ..by_id.clone()
        };
        assert_eq!(initial_device(&inputs, Some(&by_name), true), Some(1));
        assert_eq!(initial_device(&inputs, None, true), Some(1));
    }

    #[test]
    fn saved_devices_of_another_host_are_ignored() {
        let devices = list();
        let outputs = of_host(&devices, "WASAPI", false);
        let saved = Saved {
            host: "ASIO".into(),
            output: Some("Cable".into()),
            ..Saved::default()
        };
        assert_eq!(initial_device(&outputs, Some(&saved), false), Some(0));
    }

    #[test]
    fn same_names_get_numbers_so_each_choice_is_unique() {
        let a = device("WASAPI", "USB Mic", true, false);
        let b = device("WASAPI", "USB Mic", true, false);
        let c = device("WASAPI", "USB Mic (2)", true, false);
        let d = device("WASAPI", "Line", true, true);
        assert_eq!(
            labels(&[&a, &b, &c, &d]),
            ["USB Mic", "USB Mic (2)", "USB Mic (2) (2)", "Line"]
        );
    }

    #[test]
    fn asio_output_follows_the_input_driver() {
        let devices = list();
        let outputs = of_host(&devices, "ASIO", false);
        let input = &of_host(&devices, "ASIO", true)[0];
        assert!(shares_device("ASIO"));
        assert_eq!(
            shared_output(&outputs, input).map(|d| d.name.as_str()),
            Some("Interface")
        );
    }

    #[test]
    fn rates_follow_the_output_range_or_both_for_asio() {
        let mut input = device("ASIO", "Interface", true, false);
        let mut output = device("ASIO", "Interface", false, false);
        assert_eq!(rates(&input, &output, false, None), COMMON_RATES);
        output.rates = Some(vec![(44_100, 48_000)]);
        assert_eq!(rates(&input, &output, false, None), [44_100, 48_000]);
        input.rates = Some(vec![(48_000, 48_000)]);
        assert_eq!(rates(&input, &output, true, None), [48_000]);
        output.rates = Some(vec![(32_000, 32_000)]);
        assert_eq!(rates(&input, &output, false, None), [32_000]);
    }

    #[test]
    fn buffers_stay_inside_the_device_range() {
        let mut d = device("ASIO", "Interface", true, false);
        assert_eq!(buffers(&d, None), COMMON_BUFFERS);
        d.buffers = Some((100, 600));
        assert_eq!(buffers(&d, None), [128, 256, 512]);
        d.buffers = Some((100, 120));
        assert_eq!(buffers(&d, None), [100, 120]);
        d.buffers = Some((96, 96));
        assert_eq!(buffers(&d, None), [96]);
    }

    #[test]
    fn saved_values_inside_the_range_stay_offered() {
        let mut d = device("ASIO", "Interface", true, false);
        assert_eq!(
            buffers(&d, Some(480)),
            [64, 128, 256, 480, 512, 1024, 2048, 4096]
        );
        d.buffers = Some((100, 600));
        assert_eq!(buffers(&d, Some(700)), [128, 256, 512]);
        d.rates = Some(vec![(8_000, 48_000)]);
        assert_eq!(
            rates(&d, &d, false, Some(32_000)),
            [8_000, 32_000, 44_100, 48_000]
        );
        assert_eq!(rates(&d, &d, false, Some(96_000)), [8_000, 44_100, 48_000]);
    }

    #[test]
    fn saved_value_is_used_only_for_the_same_host() {
        let saved = Saved {
            host: "WASAPI".into(),
            sample_rate: Some(48_000),
            ..Saved::default()
        };
        let rate = |s: &Saved| s.sample_rate;
        assert_eq!(saved_value(Some(&saved), "WASAPI", rate), Some(48_000));
        assert_eq!(saved_value(Some(&saved), "ASIO", rate), None);
        assert_eq!(saved_value(None, "WASAPI", rate), None);
    }

    #[test]
    fn rows_put_auto_first() {
        let values = [256, 512];
        assert_eq!(row_of(&values, None), 0);
        assert_eq!(row_of(&values, Some(512)), 2);
        assert_eq!(row_of(&values, Some(480)), 0);
        assert_eq!(value_at(&values, 0), None);
        assert_eq!(value_at(&values, 2), Some(512));
        assert_eq!(value_at(&values, 3), None);
        assert!(uses_system_rate("WASAPI") && !uses_system_rate("ASIO"));
    }

    #[test]
    fn output_rows_round_trip_and_same_names_are_told_apart() {
        for output in [Output::Independent([2, 3]), Output::Insert, Output::Legacy] {
            assert_eq!(Output::from_row(Some(output.row()), Some([2, 3])), output);
        }
        assert_eq!(Output::from_row(Some(0), None), Output::Independent([0, 1]));
        let twins = [
            device("WASAPI", "Mic", true, false),
            Device {
                id: Some("second".into()),
                ..device("WASAPI", "Mic", true, false)
            },
        ];
        let labels = labels(&of_host(&twins, "WASAPI", true));
        let second = by_label(&twins, "WASAPI", true, &labels[1]).unwrap();
        assert_eq!(second.id.as_deref(), Some("second"));
        assert!(by_label(&twins, "WASAPI", false, &labels[1]).is_none());
    }

    #[test]
    fn app_audio_is_offered_only_on_wasapi_and_restored_on_the_same_host() {
        assert!(allows_app("WASAPI") && !allows_app("ASIO"));
        let saved = Saved {
            host: "WASAPI".into(),
            app: Some(AppSource {
                key: "k".into(),
                name: "player.exe".into(),
                route: "r".into(),
            }),
            ..Saved::default()
        };
        assert!(starts_with_app(Some(&saved), "WASAPI"));
        assert!(!starts_with_app(Some(&saved), "ASIO"));
        let device = Saved { app: None, ..saved };
        assert!(!starts_with_app(Some(&device), "WASAPI"));
        assert!(!starts_with_app(None, "WASAPI"));
    }

    #[test]
    fn pairs_end_with_a_mono_pair_and_keep_the_saved_one() {
        assert_eq!(pairs(4, None), [[0, 1], [2, 3]]);
        assert_eq!(pairs(3, None), [[0, 1], [2, 2]]);
        assert_eq!(pairs(0, Some([4, 5])), [[4, 5]]);
        assert_eq!(pairs(2, Some([0, 1])), [[0, 1]]);
    }

    #[test]
    fn routing_is_taken_only_from_the_same_driver() {
        let interface = device("ASIO", "Interface", true, false);
        let routing = Routing {
            input: Some([2, 3]),
            output: Output::Independent([4, 5]),
        };
        let saved = Saved {
            host: "ASIO".into(),
            input: Some("Interface".into()),
            routing: Some(routing),
            ..Saved::default()
        };
        assert_eq!(initial_routing(Some(&saved), &interface), routing);
        let other = device("ASIO", "Other", true, false);
        let fresh = |pair| Routing {
            input: Some(pair),
            output: Output::Independent(pair),
        };
        assert_eq!(initial_routing(Some(&saved), &other), fresh([0, 1]));
        let mono = Device {
            channels: 1,
            ..device("ASIO", "Mono", true, false)
        };
        assert_eq!(initial_routing(None, &mono), fresh([0, 0]));
        let unrouted = Saved {
            routing: None,
            ..saved
        };
        assert_eq!(
            initial_routing(Some(&unrouted), &interface).output,
            Output::Legacy
        );
    }
}
