//! 画面の文言。正本は `src-tauri/crates/auralyn-core/locales/{ja,en}.json`。[`core`] でそこから取る。

use auralyn_core::i18n::{catalog, Locale};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Ja,
    En,
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
    pub const STOP_TO_CHANGE: &str = "gpuiShell.stopToChange";
    pub const CONNECTION_METHOD: &str = "settings.AudioSettingsModal.035";
    pub const DEVICE: &str = "settings.AudioSettingsModal.037";
    pub const MICROPHONE: &str = "settings.AudioSettingsModal.038";
    pub const OUTPUT: &str = "settings.AudioSettingsModal.041";
    pub const NO_DEVICES: &str = "settings.AudioSettingsModal.040";
    pub const ASIO_SHARED: &str = "settings.AudioSettingsModal.044";
    pub const FIRST_START_HINT: &str = "settings.connection.firstStartHint";
    pub const SAMPLE_RATE: &str = "settings.AudioSettingsModal.060";
    pub const WASAPI_RATE: &str = "settings.AudioSettingsModal.070";
    pub const BUFFER_SIZE: &str = "settings.AudioSettingsModal.065";
    pub const SAMPLES: &str = "settings.AudioSettingsModal.067";
    pub const AUTO: &str = "gpuiShell.auto";
    pub const SETUPS: &str = "presets.savedProfiles";
    pub const SETUPS_LEAD: &str = "presets.copy.060";
    pub const SETUPS_SCOPE: &str = "gpuiShell.setupScope";
    pub const SETUPS_CHOOSE: &str = "music.presetChoose";
    pub const SETUPS_EMPTY: &str = "presets.copy.070";
    pub const SETUPS_APPLY: &str = "presets.copy.074";
    pub const SETUPS_RESTORE: &str = "presets.copy.052";
    pub const SETUPS_BACKED_UP: &str = "presets.copy.030";
    pub const SETUPS_NAME: &str = "presets.copy.061";
    pub const SETUPS_SAVE: &str = "presets.copy.063";
    pub const SETUPS_NAME_NEEDED: &str = "presets.saveNameNeeded";
    pub const SETUPS_EXISTS: &str = "presets.copy.022";
    pub const VST_ADD: &str = "rack.addEffects";
    pub const VST_SEARCH: &str = "pluginBrowser.searchPlaceholder";
    pub const VST_SCANNING: &str = "pluginBrowser.scanning";
    pub const VST_REFRESH: &str = "pluginBrowser.refresh";
    pub const VST_EMPTY: &str = "rack.empty.title";
    pub const VST_EMPTY_SCOPE: &str = "rack.empty.scope";
    pub const VST_OFF: &str = "vst.off";
    pub const VST_ENABLE: &str = "rack.card.enable";
    pub const VST_MUTE: &str = "rack.card.mute";
    pub const VST_MUTE_NAMED: &str = "rack.card.muteAccessible";
    pub const VST_MUTED: &str = "rack.card.muted";
    pub const VST_GAIN_NAMED: &str = "rack.card.gainAccessible";
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
    pub const SOUND_UNREAD: &str = "gpuiShell.soundUnread";
    pub const OFF_UNTIL_ON: &str = "gpuiShell.offUntilOn";
    pub const NOISE: &str = "settings.AudioSettingsModal.105";
    pub const NOISE_LEAD: &str = "settings.AudioSettingsModal.106";
    pub const NOISE_LOW: &str = "master.nrLow";
    pub const NOISE_HIGH: &str = "master.nrHigh";
    pub const NOISE_MEASURED: &str = "master.nrLearn";
    pub const NOISE_VENUE: &str = "master.nrVenue";
    pub const NOISE_ADVANCED: &str = "settings.noiseAdvancedActive";
    pub const NOISE_ADAPTIVE: &str = "structure.noise.adaptive";
    pub const NOISE_MEASURED_MEANS: &str = "settings.AudioSettingsModal.115";
    pub const NOISE_VENUE_MEANS: &str = "settings.AudioSettingsModal.116";
    pub const MEASURE_TITLE: &str = "measurement.title";
    pub const MEASURE_SCOPE: &str = "measurement.scope";
    pub const MEASURE_START: &str = "settings.AudioSettingsModal.121";
    pub const MEASURE_CANCEL: &str = "settings.AudioSettingsModal.122";
    pub const MEASURE_REFRESH: &str = "prep.refresh";
    pub const MEASURE_CHECKING: &str = "prep.checking";
    pub const MEASURE_ERROR: &str = "measurement.error";
    pub const MEASURE_IDLE: &str = "measurement.idle";
    pub const MEASURE_CAPTURING: &str = "measurement.capturing";
    pub const MEASURE_REVIEW: &str = "measurement.review";
    pub const MEASURE_APPROVED: &str = "measurement.approved";
    pub const MEASURE_INVALID: &str = "measurement.invalid";
    pub const MEASURE_STALE: &str = "measurement.stale";
    pub const MEASURE_NON_FINITE: &str = "measurement.nonFinite";
    pub const MEASURE_SILENT: &str = "measurement.silent";
    pub const MEASURE_CLIPPED: &str = "measurement.clipped";
    pub const MEASURE_SHORT: &str = "measurement.short";
    pub const MEASURE_VARIABLE: &str = "measurement.variable";
    pub const MEASURE_UNCERTAIN: &str = "measurement.uncertain";
    pub const MEASURE_QUIET: &str = "measurement.quiet";
    pub const MEASURE_USE: &str = "measurement.use";
    pub const MEASURE_PREVIOUS: &str = "measurement.previous";
    pub const MEASURE_LIMITS: &str = "measurement.limits";
    pub const NOISE_MIX: &str = "sound.noiseMix";
    pub const EFFECTS: &str = "settings.AudioSettingsModal.095";
    pub const EFFECTS_LEAD: &str = "settings.AudioSettingsModal.096";
    pub const PRESET_BROADCAST: &str = "settings.AudioSettingsModal.098";
    pub const PRESET_WARM: &str = "settings.AudioSettingsModal.099";
    pub const PRESET_BRIGHT: &str = "settings.AudioSettingsModal.100";
    pub const EFFECTS_AMOUNT: &str = "settings.AudioSettingsModal.104";
    pub const EFFECTS_AMOUNT_MEANS: &str = "sound.amountMeans";
    pub const SINGING_NOT_YET: &str = "gpuiShell.singingNotYet";
    pub const QUIT_HELP: &str = "band.quitHelp";
    pub const PEAK_TITLE: &str = "peak.title";
    pub const PEAK_LEAD: &str = "peak.lead";
    pub const PEAK_SCOPE: &str = "peak.scope";
    pub const PEAK_RESETS: &str = "gpuiShell.peakResets";
    pub const PEAK_DETAILS: &str = "peak.details";
    pub const PEAK_CEILING: &str = "peak.ceiling";
    pub const PEAK_RELEASE: &str = "peak.release";
    pub const PEAK_UNKNOWN: &str = "peak.unknown";
    pub const PEAK_PENDING: &str = "peak.pending";
    pub const PEAK_STOPPED: &str = "peak.stopped";
    pub const NOISE_MODE_FIRST: &str = "gpuiShell.noiseModeFirst";
    pub const NOISE_DETAILS: &str = "settings.noiseDetails";
    pub const STRENGTH: &str = "settings.AudioSettingsModal.119";
    pub const STRENGTH_NAMED: &str = "settings.AudioSettingsModal.120";
    pub const VOICE_GUARD: &str = "settings.AudioSettingsModal.127";
    pub const VOICE_GUARD_MEANS: &str = "settings.AudioSettingsModal.128";
    pub const LANGUAGE: &str = "language.label";
    pub const LANGUAGE_PARTIAL: &str = "language.partial";
    pub const LANGUAGE_SAVE_FAILED: &str = "language.saveFailed";
    pub const DESKTOP: &str = "gpuiShell.desktop";
    pub const TRAY: &str = "gpuiShell.tray";
    pub const HOTKEY: &str = "gpuiShell.hotkey";
    pub const READY: &str = "gpuiShell.ready";
    pub const UNAVAILABLE: &str = "gpuiShell.unavailable";
    pub const VERSION: &str = "settings.AudioSettingsModal.138";

    pub const SAFETY_COLUMN: &str = "shell.safetyColumn";
    pub const EMERGENCY: &str = "header.emergency";
    pub const MUTE_ON: &str = "header.muteOn";
    pub const MUTED_SHORT: &str = "header.muted";
    pub const MIC: &str = "wizard.input";
    pub const INPUT_LEVEL: &str = "home.inputLevel";
    pub const MIC_VOLUME: &str = "header.inputGain";
    pub const OUTPUT_HEADING: &str = "meter.output";
    pub const OUTPUT_VOLUME: &str = "master.outputGain";
    pub const PEAK: &str = "home.peakLabel";
    pub const OUTPUT_PEAK: &str = "home.outputPeak";
    pub const OUTPUT_PEAK_STOPPED: &str = "home.outputPeakStopped";
    pub const LEVEL_HIGH: &str = "home.levelHigh";
    pub const LEVEL_LOW: &str = "home.levelLow";
    pub const LEVEL_OK: &str = "home.levelOk";
    pub const OUTPUT_MUTED: &str = "prep.muted";
    pub const COMPARE: &str = "header.compare";
    pub const COMPARE_ON: &str = "shell.compareOn";
    pub const STATE_STOPPED: &str = "meter.state.stopped";
    pub const STATE_WAITING: &str = "meter.state.waiting";
    pub const STATE_SILENT: &str = "meter.state.silent";
    pub const STATE_ACTIVE: &str = "meter.state.active";
    pub const TRAY_SHOW: &str = "gpuiShell.trayShow";
    pub const TRAY_QUIT: &str = "gpuiShell.trayQuit";
    pub const HOTKEY_FAILED: &str = "gpuiShell.hotkeyFailed";

    #[cfg(test)]
    pub const ALL: [&str; 165] = [
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
        STOP_TO_CHANGE,
        CONNECTION_METHOD,
        DEVICE,
        MICROPHONE,
        OUTPUT,
        NO_DEVICES,
        ASIO_SHARED,
        FIRST_START_HINT,
        SAMPLE_RATE,
        WASAPI_RATE,
        BUFFER_SIZE,
        SAMPLES,
        AUTO,
        SETUPS,
        SETUPS_LEAD,
        SETUPS_SCOPE,
        SETUPS_CHOOSE,
        SETUPS_EMPTY,
        SETUPS_APPLY,
        SETUPS_RESTORE,
        SETUPS_BACKED_UP,
        SETUPS_NAME,
        SETUPS_SAVE,
        SETUPS_NAME_NEEDED,
        SETUPS_EXISTS,
        VST_ADD,
        VST_SEARCH,
        VST_SCANNING,
        VST_REFRESH,
        VST_EMPTY,
        VST_EMPTY_SCOPE,
        VST_OFF,
        VST_ENABLE,
        VST_MUTE,
        VST_MUTE_NAMED,
        VST_MUTED,
        VST_GAIN_NAMED,
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
        SOUND_UNREAD,
        OFF_UNTIL_ON,
        NOISE,
        NOISE_LEAD,
        NOISE_LOW,
        NOISE_HIGH,
        NOISE_MEASURED,
        NOISE_VENUE,
        NOISE_ADVANCED,
        NOISE_ADAPTIVE,
        NOISE_MEASURED_MEANS,
        NOISE_VENUE_MEANS,
        MEASURE_TITLE,
        MEASURE_SCOPE,
        MEASURE_START,
        MEASURE_CANCEL,
        MEASURE_REFRESH,
        MEASURE_CHECKING,
        MEASURE_ERROR,
        MEASURE_IDLE,
        MEASURE_CAPTURING,
        MEASURE_REVIEW,
        MEASURE_APPROVED,
        MEASURE_INVALID,
        MEASURE_STALE,
        MEASURE_NON_FINITE,
        MEASURE_SILENT,
        MEASURE_CLIPPED,
        MEASURE_SHORT,
        MEASURE_VARIABLE,
        MEASURE_UNCERTAIN,
        MEASURE_QUIET,
        MEASURE_USE,
        MEASURE_PREVIOUS,
        MEASURE_LIMITS,
        NOISE_MIX,
        EFFECTS,
        EFFECTS_LEAD,
        PRESET_BROADCAST,
        PRESET_WARM,
        PRESET_BRIGHT,
        EFFECTS_AMOUNT,
        EFFECTS_AMOUNT_MEANS,
        SINGING_NOT_YET,
        QUIT_HELP,
        PEAK_TITLE,
        PEAK_LEAD,
        PEAK_SCOPE,
        PEAK_RESETS,
        PEAK_DETAILS,
        PEAK_CEILING,
        PEAK_RELEASE,
        PEAK_UNKNOWN,
        PEAK_PENDING,
        PEAK_STOPPED,
        NOISE_MODE_FIRST,
        NOISE_DETAILS,
        STRENGTH,
        STRENGTH_NAMED,
        VOICE_GUARD,
        VOICE_GUARD_MEANS,
        LANGUAGE,
        LANGUAGE_PARTIAL,
        LANGUAGE_SAVE_FAILED,
        DESKTOP,
        TRAY,
        HOTKEY,
        READY,
        UNAVAILABLE,
        VERSION,
        SAFETY_COLUMN,
        EMERGENCY,
        MUTE_ON,
        MUTED_SHORT,
        MIC,
        INPUT_LEVEL,
        MIC_VOLUME,
        OUTPUT_HEADING,
        OUTPUT_VOLUME,
        PEAK,
        OUTPUT_PEAK,
        OUTPUT_PEAK_STOPPED,
        LEVEL_HIGH,
        LEVEL_LOW,
        LEVEL_OK,
        OUTPUT_MUTED,
        COMPARE,
        COMPARE_ON,
        STATE_STOPPED,
        STATE_WAITING,
        STATE_SILENT,
        STATE_ACTIVE,
        TRAY_SHOW,
        TRAY_QUIT,
        HOTKEY_FAILED,
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
