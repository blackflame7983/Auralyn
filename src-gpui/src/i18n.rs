//! 画面の文言。正本は `src-tauri/crates/auralyn-core/locales/{ja,en}.json`。新しい文言は [`core`] でそこから取る。
//! [`t`] の表は試作のときに写した分で、順に [`core`] へ置き換える。

use auralyn_core::i18n::{catalog, Locale};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Ja,
    En,
}

impl Lang {
    pub fn toggled(self) -> Self {
        match self {
            Lang::Ja => Lang::En,
            Lang::En => Lang::Ja,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Key {
    SafetyColumn,
    Emergency,
    MuteOn,
    MutedShort,
    Mic,
    InputLevel,
    MicVolume,
    Output,
    OutputVolume,
    Peak,
    OutputPeak,
    OutputPeakStopped,
    LevelHigh,
    LevelLow,
    LevelOk,
    Muted,
    Compare,
    CompareOn,
    StateStopped,
    StateWaiting,
    StateSilent,
    StateActive,
    Checks,
    ImeField,
    ImePlaceholder,
    Language,
    TrayShow,
    TrayQuit,
    HotkeyFailed,
}

pub fn t(lang: Lang, key: Key) -> &'static str {
    use Key::*;
    match (lang, key) {
        (Lang::Ja, SafetyColumn) => "本番中の操作",
        (Lang::En, SafetyColumn) => "Live controls",
        (Lang::Ja, Emergency) => "緊急ミュート",
        (Lang::En, Emergency) => "Emergency mute",
        (Lang::Ja, MuteOn) => "緊急ミュート中です。Auralyn の出力は無音です。",
        (Lang::En, MuteOn) => "Emergency mute is on. Auralyn output is silent.",
        (Lang::Ja, MutedShort) => "ミュート中",
        (Lang::En, MutedShort) => "Muted",
        (Lang::Ja, Mic) => "マイク",
        (Lang::En, Mic) => "Microphone",
        (Lang::Ja, InputLevel) => "マイクの入力レベル",
        (Lang::En, InputLevel) => "Microphone input level",
        (Lang::Ja, MicVolume) => "マイク音量",
        (Lang::En, MicVolume) => "Mic volume",
        (Lang::Ja, Output) => "出力",
        (Lang::En, Output) => "Output",
        (Lang::Ja, OutputVolume) => "出力音量",
        (Lang::En, OutputVolume) => "Output volume",
        (Lang::Ja, Peak) => "ピーク",
        (Lang::En, Peak) => "Peak",
        (Lang::Ja, OutputPeak) => "出力のピーク",
        (Lang::En, OutputPeak) => "Output peak",
        (Lang::Ja, OutputPeakStopped) => "出力のピーク（音声停止中）",
        (Lang::En, OutputPeakStopped) => "Output peak (audio stopped)",
        (Lang::Ja, LevelHigh) => "大きすぎ",
        (Lang::En, LevelHigh) => "Too loud",
        (Lang::Ja, LevelLow) => "小さめ",
        (Lang::En, LevelLow) => "A bit low",
        (Lang::Ja, LevelOk) => "適正",
        (Lang::En, LevelOk) => "In range",
        (Lang::Ja, Muted) => "出力ミュート・音量ゼロ",
        (Lang::En, Muted) => "Muted / 0%",
        (Lang::Ja, Compare) => "VSTを外して比較",
        (Lang::En, Compare) => "Bypass VST",
        (Lang::Ja, CompareOn) => {
            "VSTを外して比較中です（VSTオフ。ノイズ低減・声を整える機能は継続）"
        }
        (Lang::En, CompareOn) => {
            "Bypass VST is on (VST off; noise reduction and voice shaping continue)"
        }
        (Lang::Ja, StateStopped) => "音声停止中",
        (Lang::En, StateStopped) => "Audio stopped",
        (Lang::Ja, StateWaiting) => "レベル未受信",
        (Lang::En, StateWaiting) => "Waiting for level updates",
        (Lang::Ja, StateSilent) => "無音",
        (Lang::En, StateSilent) => "Silent",
        (Lang::Ja, StateActive) => "受信中",
        (Lang::En, StateActive) => "Receiving",
        (Lang::Ja, Checks) => "確認用",
        (Lang::En, Checks) => "Checks",
        (Lang::Ja, ImeField) => "日本語入力の確認",
        (Lang::En, ImeField) => "IME check",
        (Lang::Ja, ImePlaceholder) => "ここに日本語を入力",
        (Lang::En, ImePlaceholder) => "Type Japanese here",
        (Lang::Ja, Language) => "English",
        (Lang::En, Language) => "日本語",
        (Lang::Ja, TrayShow) => "Auralyn を表示",
        (Lang::En, TrayShow) => "Show Auralyn",
        (Lang::Ja, TrayQuit) => "終了",
        (Lang::En, TrayQuit) => "Quit",
        (Lang::Ja, HotkeyFailed) => "Alt+M を登録できません（Auralyn が起動中かもしれません）",
        (Lang::En, HotkeyFailed) => "Could not register Alt+M (Auralyn may be running)",
    }
}

/// `auralyn-core` の文言のキー。
pub mod keys {
    pub const FLOW_VOICE: &str = "home.flowVoice";
    pub const FLOW_COMPARE: &str = "home.flowCompare";
    pub const FLOW_BEFORE: &str = "home.flowBefore";
    pub const FLOW_AFTER: &str = "home.flowAfter";
    pub const FLOW_GRAPH: &str = "home.flowGraph";
    pub const RAIL_LABEL: &str = "rail.label";
    pub const RAIL_HOME: &str = "rail.home";
    pub const RAIL_SOUND: &str = "rail.sound";
    pub const RAIL_VST: &str = "rail.vst";
    pub const RAIL_CONNECT: &str = "rail.connect";
    pub const RAIL_CONNECT_NAME: &str = "rail.connectName";
    pub const RAIL_SETTINGS: &str = "rail.settings";
    pub const BAND_LABEL: &str = "band.label";
    pub const STATUS_UNCONFIGURED: &str = "shell.unconfigured";
    pub const STATUS_STOPPED: &str = "shell.stopped";
    pub const STATUS_RUNNING: &str = "device.engine";
    pub const START: &str = "home.startAudio";
    pub const STARTING: &str = "home.starting";
    pub const START_FAILED: &str = "home.startFailed";
    pub const STOP: &str = "band.stopAudio";
    pub const STOPPING: &str = "band.stopping";
    pub const STOP_FAILED: &str = "band.stopFailed";
    pub const NOT_YET: &str = "gpuiShell.notYet";
    pub const STOP_TO_CHANGE: &str = "gpuiShell.stopToChange";
    pub const CONNECTION_METHOD: &str = "settings.AudioSettingsModal.035";
    pub const DEVICE: &str = "settings.AudioSettingsModal.037";
    pub const MICROPHONE: &str = "settings.AudioSettingsModal.038";
    pub const OUTPUT: &str = "settings.AudioSettingsModal.041";
    pub const NO_DEVICES: &str = "settings.AudioSettingsModal.040";
    pub const ASIO_SHARED: &str = "settings.AudioSettingsModal.044";
    pub const FIRST_START_HINT: &str = "settings.connection.firstStartHint";
    pub const VST_ADD: &str = "rack.addEffects";
    pub const VST_SEARCH: &str = "pluginBrowser.searchPlaceholder";
    pub const VST_SCANNING: &str = "pluginBrowser.scanning";
    pub const VST_REFRESH: &str = "pluginBrowser.refresh";
    pub const VST_EMPTY: &str = "rack.empty.title";
    pub const VST_EMPTY_SCOPE: &str = "rack.empty.scope";
    pub const VST_OFF: &str = "vst.off";
    pub const VST_ENABLE: &str = "rack.card.enable";
    pub const VST_EDIT: &str = "rack.card.edit";
    pub const VST_EDIT_NAMED: &str = "rack.card.editAccessible";
    pub const VST_REMOVE: &str = "rack.card.remove";
    pub const VST_REMOVE_NAMED: &str = "rack.card.removeAccessible";
    pub const VST_UP: &str = "postMix.up";
    pub const VST_DOWN: &str = "postMix.down";
    pub const VST_REMOVE_TITLE: &str = "rack.card.removeTitle";
    pub const VST_REMOVE_WARNING: &str = "gpuiShell.removeVst";
    pub const VST_CONFIRM_REMOVE: &str = "rack.card.confirmRemove";
    pub const CANCEL: &str = "rack.card.cancel";
    pub const VST_NOT_LOADED: &str = "gpuiShell.notLoaded";

    #[cfg(test)]
    pub const ALL: [&str; 50] = [
        FLOW_VOICE,
        FLOW_COMPARE,
        FLOW_BEFORE,
        FLOW_AFTER,
        FLOW_GRAPH,
        RAIL_LABEL,
        RAIL_HOME,
        RAIL_SOUND,
        RAIL_VST,
        RAIL_CONNECT,
        RAIL_CONNECT_NAME,
        RAIL_SETTINGS,
        BAND_LABEL,
        STATUS_UNCONFIGURED,
        STATUS_STOPPED,
        STATUS_RUNNING,
        START,
        STARTING,
        START_FAILED,
        STOP,
        STOPPING,
        STOP_FAILED,
        NOT_YET,
        STOP_TO_CHANGE,
        CONNECTION_METHOD,
        DEVICE,
        MICROPHONE,
        OUTPUT,
        NO_DEVICES,
        ASIO_SHARED,
        FIRST_START_HINT,
        VST_ADD,
        VST_SEARCH,
        VST_SCANNING,
        VST_REFRESH,
        VST_EMPTY,
        VST_EMPTY_SCOPE,
        VST_OFF,
        VST_ENABLE,
        VST_EDIT,
        VST_EDIT_NAMED,
        VST_REMOVE,
        VST_REMOVE_NAMED,
        VST_UP,
        VST_DOWN,
        VST_REMOVE_TITLE,
        VST_REMOVE_WARNING,
        VST_CONFIRM_REMOVE,
        CANCEL,
        VST_NOT_LOADED,
    ];
}

fn locale(lang: Lang) -> Locale {
    match lang {
        Lang::Ja => Locale::Ja,
        Lang::En => Locale::En,
    }
}

/// `auralyn-core` の文言。`key` は [`keys`] の定数で渡す。あることは試験 `every_core_key_exists_in_both_languages` で確かめる。
pub fn core(lang: Lang, key: &'static str) -> &'static str {
    catalog()
        .messages(locale(lang))
        .get(key)
        .unwrap_or_else(|| panic!("文言 {key} がありません"))
}

/// `{name}` に値を差し込んだ `auralyn-core` の文言。
pub fn core_with(lang: Lang, key: &'static str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    catalog()
        .text(locale(lang), key, args)
        .unwrap_or_else(|| panic!("文言 {key} がありません"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_core_key_exists_in_both_languages() {
        for key in keys::ALL {
            for lang in [Lang::Ja, Lang::En] {
                assert!(!core(lang, key).is_empty());
            }
        }
    }
}
