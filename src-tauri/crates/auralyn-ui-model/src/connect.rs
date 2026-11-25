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

    fn device(host: &str, name: &str, is_input: bool, is_default: bool) -> Device {
        Device {
            host: host.into(),
            name: name.into(),
            id: Some(format!("{host}:{name}")),
            is_input,
            is_default,
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
}
