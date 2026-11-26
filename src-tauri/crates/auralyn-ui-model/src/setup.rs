//! はじめての設定：使い道を選び、マイクと出力先を勧める。勧め方は Tauri 版のセットアップ（`wizardModel.ts`・`useSetupWizard.ts`・`audioDevices.ts`）に揃える。
//! ここでは WASAPI だけを扱う（ASIO は接続の画面で選ぶ）。

use crate::connect::Device;

/// 使い道。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Goal {
    /// OBS で配信する（仮想ケーブルへ送る）。
    Obs,
    /// Discord などで通話する（仮想ケーブルへ送る）。
    Chat,
    /// 自分で聴く（ヘッドホン・スピーカーへ出す）。
    Listen,
}

impl Goal {
    pub const ALL: [Goal; 3] = [Goal::Obs, Goal::Chat, Goal::Listen];

    /// 仮想ケーブルへ送る使い道か。
    pub fn sends_to_cable(self) -> bool {
        matches!(self, Goal::Obs | Goal::Chat)
    }
}

fn contains_any(name: &str, words: &[&str]) -> bool {
    let name = name.to_lowercase();
    words.iter().any(|word| name.contains(word))
}

/// 仮想ケーブルの出力（OBS・通話アプリへ送る口）。
pub fn is_virtual_output(name: &str) -> bool {
    contains_any(name, &["cable", "voicemeeter"])
}

/// 再生の音を取り込む入力（マイクではない）。
pub fn is_playback_input(name: &str) -> bool {
    let name = name.to_lowercase();
    let compact: String = name.split_whitespace().collect();
    contains_any(
        &name,
        &[
            "cable",
            "voicemeeter",
            "再生リダイレクト",
            "loopback",
            "ループバック",
        ],
    ) || ["stereomix", "ステレオミキサー", "whatuhear", "waveout"]
        .iter()
        .any(|word| compact.contains(word))
}

fn wasapi(devices: &[Device], is_input: bool) -> Vec<&Device> {
    devices
        .iter()
        .filter(|d| d.is_input == is_input && d.host.eq_ignore_ascii_case("wasapi"))
        .collect()
}

/// マイクに選べる入力：WASAPI の入力で、再生の音の取り込みでないもの。
pub fn microphones(devices: &[Device]) -> Vec<&Device> {
    wasapi(devices, true)
        .into_iter()
        .filter(|d| !is_playback_input(&d.name))
        .collect()
}

/// 出力先に選べる出力（WASAPI）。
pub fn outputs(devices: &[Device]) -> Vec<&Device> {
    wasapi(devices, false)
}

/// 勧めるマイクの位置：名前からマイクと分かるものが1つだけならそれ、無ければ候補が1つだけならそれ。迷うなら勧めない。
pub fn recommend_microphone(microphones: &[&Device]) -> Option<usize> {
    let named: Vec<usize> = (0..microphones.len())
        .filter(|&i| {
            contains_any(
                &microphones[i].name,
                &["microphone", "マイク", "headset", "ヘッドセット"],
            ) || microphones[i]
                .name
                .to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .any(|word| word == "mic")
        })
        .collect();
    match named.as_slice() {
        [only] => Some(*only),
        [] if microphones.len() == 1 => Some(0),
        _ => None,
    }
}

/// 勧める出力先の位置。配信・通話は仮想ケーブルが1つだけならそれ、自分で聴くなら Windows の既定（仮想ケーブルでなく、1つだけ）。
pub fn recommend_output(goal: Goal, outputs: &[&Device]) -> Option<usize> {
    let found: Vec<usize> = (0..outputs.len())
        .filter(|&i| {
            let output = outputs[i];
            if goal.sends_to_cable() {
                is_virtual_output(&output.name)
            } else {
                output.is_default && !is_virtual_output(&output.name)
            }
        })
        .collect();
    match found.as_slice() {
        [only] => Some(*only),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(name: &str, is_input: bool, is_default: bool) -> Device {
        Device {
            host: "WASAPI".into(),
            name: name.into(),
            id: Some(name.into()),
            is_input,
            is_default,
            channels: 2,
            rates: None,
            buffers: None,
        }
    }

    #[test]
    fn playback_captures_are_not_microphones() {
        let devices = [
            device("マイク (USB Audio)", true, true),
            device("CABLE Output (VB-Audio Virtual Cable)", true, false),
            device("Stereo Mix (Realtek)", true, false),
            device("ステレオ ミキサー", true, false),
            device("Speakers", false, true),
        ];
        let names: Vec<_> = microphones(&devices)
            .iter()
            .map(|d| d.name.as_str())
            .collect();
        assert_eq!(names, ["マイク (USB Audio)"]);
    }

    #[test]
    fn microphone_is_recommended_only_when_clear() {
        let usb = device("USB Mic", true, false);
        let line = device("Line In", true, false);
        let headset = device("Headset Microphone", true, false);
        assert_eq!(recommend_microphone(&[&line, &usb]), Some(1));
        assert_eq!(recommend_microphone(&[&line]), Some(0));
        assert_eq!(recommend_microphone(&[&line, &line]), None);
        assert_eq!(recommend_microphone(&[&usb, &headset]), None);
        // 単語の途中の「mic」は数えない。
        let dynamic = device("Dynamics", true, false);
        assert_eq!(recommend_microphone(&[&dynamic, &line]), None);
    }

    #[test]
    fn output_follows_the_goal() {
        let speakers = device("Speakers", false, true);
        let cable = device("CABLE Input (VB-Audio Virtual Cable)", false, false);
        let outputs = [&speakers, &cable];
        assert_eq!(recommend_output(Goal::Obs, &outputs), Some(1));
        assert_eq!(recommend_output(Goal::Listen, &outputs), Some(0));
        let vm = device("Voicemeeter Input", false, false);
        assert_eq!(recommend_output(Goal::Chat, &[&cable, &vm]), None);
        let default_cable = device("CABLE Input", false, true);
        assert_eq!(recommend_output(Goal::Listen, &[&default_cable]), None);
    }
}
