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
    pub const RAIL_HELP: &str = "rail.help";
    pub const BAND_LABEL: &str = "band.label";
    pub const STATUS_UNCONFIGURED: &str = "shell.unconfigured";
    pub const STATUS_STOPPED: &str = "shell.stopped";
    pub const STATUS_RUNNING: &str = "device.engine";
    pub const START: &str = "home.startAudio";
    pub const STARTING: &str = "home.starting";
    pub const START_FAILED: &str = "home.startFailed";
    pub const STOP: &str = "band.stopAudio";
    pub const STOP_SHORT: &str = "gpuiShell.stopShort";
    pub const STOPPING: &str = "band.stopping";
    pub const STOP_FAILED: &str = "band.stopFailed";
    pub const APPLY_RESTART: &str = "gpuiShell.applyRestart";
    pub const RESTART_NOTE: &str = "gpuiShell.restartNote";
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
    pub const SETUPS_EXISTS: &str = "presets.copy.022";
    pub const SETUPS_DELETE: &str = "presets.copy.080";
    pub const SETUPS_DELETE_TITLE: &str = "presets.copy.036";
    pub const SETUPS_DELETE_WARNING: &str = "presets.copy.037";
    pub const SETUPS_CONFIRM_DELETE: &str = "presets.copy.038";
    pub const SETUPS_EXPORT: &str = "presets.copy.078";
    pub const SETUPS_EXPORTED: &str = "presets.copy.041";
    pub const SETUPS_IMPORT: &str = "presets.copy.065";
    pub const SETUPS_IMPORTED: &str = "presets.copy.043";
    pub const SETUPS_APPLIED: &str = "gpuiShell.setupsApplied";
    pub const SETUPS_RESTORED: &str = "gpuiShell.setupsRestored";
    pub const SETUPS_IMPORT_EXISTS: &str = "gpuiShell.setupImportExists";
    pub const SETUPS_IMPORT_NOTHING: &str = "gpuiShell.setupImportNothing";
    pub const SETUPS_IMPORT_INVALID: &str = "gpuiShell.setupImportInvalid";
    pub const VOICE_TITLE: &str = "voice.copy.001";
    pub const VOICE_LEAD: &str = "voice.copy.002";
    pub const VOICE_SCOPE: &str = "voice.copy.003";
    pub const VOICE_NEEDS_AUDIO: &str = "gpuiShell.voiceNeedsAudio";
    pub const VOICE_RECORD: &str = "voice.recordMax";
    pub const VOICE_STOP: &str = "voice.copy.012";
    pub const VOICE_REMAINING: &str = "voice.copy.013";
    pub const VOICE_SAVE: &str = "voice.copy.062";
    pub const VOICE_BEFORE: &str = "voice.copy.056";
    pub const VOICE_AFTER: &str = "voice.copy.057";
    pub const VOICE_SAVED: &str = "voice.copy.121";
    pub const LISTEN_TITLE: &str = "voice.copy.036";
    pub const LISTEN_LEAD: &str = "voice.copy.038";
    pub const LISTEN_REFRESH: &str = "voice.copy.040";
    pub const LISTEN_DEVICE: &str = "voice.copy.041";
    pub const LISTEN_CHOOSE: &str = "voice.copy.042";
    pub const LISTEN_SAFE: &str = "voice.copy.045";
    pub const LISTEN_PLAYING: &str = "voice.copy.049";
    pub const LISTEN_STOPPED: &str = "voice.copy.051";
    pub const LISTEN_PLAY: &str = "voice.copy.059";
    pub const LISTEN_STOP: &str = "voice.copy.060";
    pub const LISTEN_LOOP: &str = "voice.copy.061";
    pub const LISTEN_RETRY: &str = "voice.copy.039";
    pub const DIAG_TITLE: &str = "structure.diagnostics";
    pub const DIAG_REFRESH: &str = "settings.AudioSettingsModal.170";
    pub const DIAG_LOADED: &str = "settings.AudioSettingsModal.171";
    pub const DIAG_ENABLED: &str = "settings.AudioSettingsModal.172";
    pub const DIAG_PENDING: &str = "settings.AudioSettingsModal.173";
    pub const DIAG_BURNED: &str = "settings.AudioSettingsModal.174";
    pub const DIAG_JITTER: &str = "settings.AudioSettingsModal.175";
    pub const DIAG_GLITCHES: &str = "settings.AudioSettingsModal.176";
    pub const DIAG_RECENT_LABEL: &str = "master.recentAnomaliesLabel";
    pub const DIAG_RECENT: &str = "master.recentAnomalies";
    pub const DIAG_RECENT_NOTE: &str = "master.recentAnomaliesNote";
    pub const DIAG_RECENT_HIGH: &str = "master.recentAnomaliesHigh";
    pub const PLUGINS_TITLE: &str = "settings.AudioSettingsModal.179";
    pub const EXCL_TITLE: &str = "settings.AudioSettingsModal.180";
    pub const EXCL_LEAD: &str = "settings.AudioSettingsModal.181";
    pub const EXCL_CONFIRM_TITLE: &str = "settings.AudioSettingsModal.182";
    pub const EXCL_CONFIRM_TEXT: &str = "settings.AudioSettingsModal.183";
    pub const EXCL_CONFIRM: &str = "settings.AudioSettingsModal.184";
    pub const EXCL_DONE: &str = "settings.AudioSettingsModal.185";
    pub const EXCL_FAILED: &str = "settings.AudioSettingsModal.186";
    pub const EXCL_BUTTON: &str = "settings.AudioSettingsModal.187";
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
    pub const VST_REMOVE_NAMED: &str = "rack.card.removeAccessible";
    pub const VST_UP: &str = "postMix.up";
    pub const VST_DOWN: &str = "postMix.down";
    pub const VST_REMOVE_TITLE: &str = "rack.card.removeTitle";
    pub const VST_REMOVE_WARNING: &str = "gpuiShell.removeVst";
    pub const VST_CONFIRM_REMOVE: &str = "rack.card.confirmRemove";
    pub const CANCEL: &str = "rack.card.cancel";
    pub const VST_NOT_LOADED: &str = "gpuiShell.notLoaded";
    pub const VST_RELOAD_MISSING: &str = "gpuiShell.reloadMissing";
    pub const VST_RELOAD_MISSING_HINT: &str = "gpuiShell.reloadMissingHint";
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
    pub const SINGING_PRESET: &str = "settings.SingingControls.403";
    pub const SINGING_LOW_CUT: &str = "settings.SingingControls.407";
    pub const SINGING_DYNAMICS: &str = "settings.SingingControls.408";
    pub const SINGING_BRIGHTNESS: &str = "settings.SingingControls.409";
    pub const REVERB: &str = "gpuiShell.reverb";
    pub const REVERB_ON: &str = "settings.SingingControls.414";
    pub const REVERB_LEAD: &str = "settings.SingingControls.415";
    pub const REVERB_MIX: &str = "settings.SingingControls.416";
    pub const REVERB_DECAY: &str = "settings.SingingControls.417";
    pub const REVERB_DAMPING: &str = "settings.SingingControls.418";
    pub const DEESSER: &str = "settings.deesser";
    pub const DEESSER_HINT: &str = "settings.deesserHint";
    pub const DEESSER_AMOUNT: &str = "settings.deesserAmount";
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
    pub const PEAK_LOCKED: &str = "peak.liveLocked";
    pub const TRUE_PEAK_TITLE: &str = "truePeak.title";
    pub const TRUE_PEAK_LEAD: &str = "truePeak.lead";
    pub const TRUE_PEAK_SCOPE: &str = "truePeak.scope";
    pub const TRUE_PEAK_REDUCTION: &str = "truePeak.reduction";
    pub const TRUE_PEAK_LATENCY: &str = "truePeak.latency";
    pub const TRUE_PEAK_NOT_APPLIED: &str = "truePeak.notApplied";
    pub const TRUE_PEAK_LIMITS: &str = "truePeak.limits";
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
    pub const SHORTCUTS_TITLE: &str = "settings.ShortcutsPanel.378";
    pub const SHORTCUTS_EMPTY: &str = "shortcuts.captureEmpty";
    pub const SHORTCUTS_UNREADABLE: &str = "gpuiShell.shortcutsUnreadable";
    pub const SHORTCUTS_EDIT_IN_TAURI: &str = "gpuiShell.shortcutsEditInTauri";
    pub const SHORTCUT_MUTE_TOGGLE: &str = "settings.ShortcutsPanel.363";
    pub const SHORTCUT_MUTE_ON: &str = "settings.ShortcutsPanel.364";
    pub const SHORTCUT_MUTE_OFF: &str = "settings.ShortcutsPanel.365";
    pub const SHORTCUT_BYPASS_TOGGLE: &str = "settings.ShortcutsPanel.366";
    pub const SHORTCUT_BYPASS_ON: &str = "settings.ShortcutsPanel.367";
    pub const SHORTCUT_BYPASS_OFF: &str = "settings.ShortcutsPanel.368";
    pub const SHORTCUT_GAIN_UP: &str = "settings.ShortcutsPanel.369";
    pub const SHORTCUT_GAIN_DOWN: &str = "settings.ShortcutsPanel.370";
    pub const SHORTCUT_SINGING: &str = "settings.ShortcutsPanel.371";
    pub const SHORTCUT_TALK: &str = "settings.ShortcutsPanel.372";
    pub const SHORTCUT_NOISE: &str = "settings.ShortcutsPanel.393";
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
    pub const LIVE_TITLE: &str = "liveOutput.title";
    pub const LIVE_SCOPE: &str = "liveOutput.scope";
    pub const LIVE_REFRESH: &str = "liveOutput.refresh";
    pub const LIVE_DEVICE: &str = "liveOutput.device";
    pub const LIVE_OFF: &str = "liveOutput.disabled";
    pub const LIVE_MISSING: &str = "liveOutput.missing";
    pub const LIVE_ACTIVE: &str = "liveOutput.active";
    pub const LIVE_INACTIVE: &str = "gpuiShell.liveInactive";
    pub const LIVE_FAILED: &str = "liveOutput.failed";
    pub const LIVE_MONITOR_TRIM: &str = "liveOutput.monitorTrim";
    pub const LIVE_BROADCAST_TRIM: &str = "liveOutput.broadcastTrim";
    pub const LIVE_MONITOR_MUTED: &str = "liveOutput.monitorMuted";
    pub const LIVE_CONFIRM: &str = "liveOutput.confirm";
    pub const LIVE_SAVE: &str = "liveOutput.save";
    pub const LIVE_SPLIT_KEPT: &str = "gpuiShell.liveSplitKept";
    pub const LIVE_SPLIT: &str = "liveOutput.split";
    pub const LIVE_SPLIT_SCOPE: &str = "liveOutput.splitScope";
    pub const MIX_TITLE: &str = "streamMix.title";
    pub const MIX_LEAD: &str = "mixing.prepare";
    pub const MIX_NEED_OUTPUT: &str = "gpuiShell.mixNeedOutput";
    pub const MIX_CURRENT: &str = "mixing.current";
    pub const MIX_SAVED: &str = "mixing.saved";
    pub const MIX_NONE: &str = "mixing.none";
    pub const MIX_APP: &str = "mixing.process";
    pub const MIX_REFRESH_APPS: &str = "mixing.refreshApps";
    pub const MIX_ROUTE: &str = "mixing.chooseRoute";
    pub const MIX_ROUTE_HELP: &str = "mixing.routeHelp";
    pub const MIX_ROUTE_MUTED: &str = "mixing.muted";
    pub const MIX_ROUTE_NEEDS_MUTE: &str = "mixing.unmuted";
    pub const MIX_ROUTE_MUTE_FIRST: &str = "mixingUi.routeMuted";
    pub const MIX_INPUT_FAILED: &str = "mixing.accompanimentFailed";
    pub const MIX_SOURCE: &str = "mixing.device";
    pub const MIX_CHANNELS: &str = "mixing.channels";
    pub const MIX_STOP_FIRST: &str = "mixing.stopped";
    pub const MIX_CONFIRM: &str = "mixing.confirm";
    pub const MIX_APPLY: &str = "mixing.save";
    pub const MIX_DISABLE: &str = "mixing.disable";
    pub const MIX_VOICE: &str = "mixing.voice";
    pub const MIX_MUSIC: &str = "mixing.accompaniment";
    pub const MIX_VOICE_MUTE: &str = "gpuiShell.mixVoiceMute";
    pub const MIX_MUSIC_MUTE: &str = "gpuiShell.mixMusicMute";
    pub const MIX_MONITOR: &str = "mixing.monitor";
    pub const MIX_RELOAD: &str = "mixing.reload";
    pub const MIX_OFFSET: &str = "mixing.offset";
    pub const MIX_OFFSET_APPLY: &str = "mixing.applyLevels";
    pub const MIX_OFFSET_INVALID: &str = "mixingUi.invalidLevels";
    pub const MIX_OFFSET_HELP: &str = "mixing.offsetHelp";
    pub const MIX_OFFSET_UNCONFIRMED: &str = "mixing.offsetUnconfirmed";
    pub const MIX_OFFSET_CHANGED: &str = "mixing.offsetChanged";
    pub const MIX_OFFSET_LEGACY: &str = "mixing.offsetLegacy";
    pub const MIX_OFFSET_UNKNOWN: &str = "mixing.offsetUnknown";
    pub const MIX_OFFSET_CONFIRM: &str = "mixing.offsetConfirm";
    pub const MIX_OFFSET_VOICE_INPUT: &str = "mixing.offsetVoiceInput";
    pub const MIX_OFFSET_CHANNELS: &str = "mixing.offsetChannels";
    pub const MIX_OFFSET_OUTPUT: &str = "mixing.offsetOutput";
    pub const MIX_OFFSET_BROADCAST: &str = "mixing.offsetBroadcast";
    pub const POST_TITLE: &str = "postMix.title";
    pub const POST_SCOPE: &str = "mixingUi.postScope";
    pub const POST_SAVED: &str = "postMix.saved";
    pub const POST_NONE: &str = "postMix.none";
    pub const POST_ERROR: &str = "postMix.error";
    pub const POST_RESTORE_NEEDED: &str = "postMix.restoreNeeded";
    pub const POST_RESTORE: &str = "postMix.restore";
    pub const POST_STOP: &str = "postMix.stop";
    pub const POST_ENABLED: &str = "postMix.enabled";
    pub const POST_NEEDS_MIX: &str = "mixingUi.postNeedsMix";
    pub const POST_CHOOSE: &str = "postMix.choose";
    pub const POST_ADD: &str = "postMix.add";
    pub const POST_SCAN: &str = "postMix.scan";
    pub const POST_RECOVERY: &str = "postMix.recovery";
    pub const POST_RECOVERY_HELP: &str = "postMix.recoveryHelp";
    pub const POST_RESET: &str = "postMix.reset";
    pub const POST_SAVE: &str = "postMix.save";
    pub const POST_RELOAD: &str = "postMix.reload";
    pub const SETUP_TITLE: &str = "wizard.title";
    pub const SETUP_LEAD: &str = "gpuiShell.setupLead";
    pub const SETUP_GOAL: &str = "wizard.chooseGoal";
    pub const SETUP_GOAL_OBS: &str = "wizard.obs";
    pub const SETUP_GOAL_CHAT: &str = "wizard.chat";
    pub const SETUP_GOAL_LISTEN: &str = "prep.local";
    pub const SETUP_MICROPHONE: &str = "wizard.microphone";
    pub const SETUP_OUTPUT: &str = "wizard.destination";
    pub const SETUP_CABLE_BEFORE: &str = "wizard.cableBefore";
    pub const SETUP_CABLE: &str = "wizard.cable";
    pub const SETUP_CABLE_AFTER: &str = "wizard.cableAfter";
    pub const SETUP_LISTEN_HINT: &str = "wizard.listeningHint";
    pub const SETUP_START: &str = "wizard.saveStart";
    pub const SETUP_OTHER: &str = "gpuiShell.setupOther";
    pub const HELP_TROUBLE: &str = "help.section.trouble";
    pub const HELP_DOCS: &str = "help.readMore";
    pub const HELP_MORE: &str = "help.learnMore";
    pub const HELP_TERMS: &str = "help.section.terms";
    pub const GUIDE_OBS: &str = "gpuiShell.guideObs";
    pub const GUIDE_CALL: &str = "gpuiShell.guideCall";
    pub const MODES_TITLE: &str = "liveBar.label";
    pub const MODES_UNREAD: &str = "settings.LiveModeControls.216";
    pub const MODES_STATE_FAILED: &str = "liveNotices.stateFailed";
    pub const MODES_SWITCHING: &str = "liveBar.switching";
    pub const MODES_PARTIAL: &str = "liveOutput.partial";
    pub const MODES_STOPPED: &str = "liveBar.stopped";
    pub const MODES_CUSTOM: &str = "liveBar.customHint";
    pub const MODES_HINT: &str = "gpuiShell.modesHint";
    pub const MODES_SINGING: &str = "liveBar.singing";
    pub const MODES_TALK: &str = "liveBar.talk";
    pub const MODES_TRANSACTION_RUNNING: &str = "gpuiShell.modesSwitching";
    pub const MODES_TRANSACTION_FAILED: &str = "liveTransaction.failed";
    pub const MODES_RECOVER: &str = "liveTransaction.recover";
    pub const MODES_FAILED: &str = "liveNotices.operationFailed";
    pub const MODES_SAVED: &str = "settings.LiveModeControls.232";
    pub const MODES_UNSAVED: &str = "settings.LiveModeControls.233";
    pub const MODES_REGISTER: &str = "settings.LiveModeControls.230";
    pub const MODES_REGISTER_NOTE: &str = "gpuiShell.modesRegisterNote";
    pub const MODES_SAVE_SINGING: &str = "gpuiShell.modesSaveSinging";
    pub const MODES_SAVE_TALK: &str = "gpuiShell.modesSaveTalk";
    pub const MODES_REVERB_CONFIRM: &str = "settings.mode.reverbConfirm";
    pub const MODES_WITHOUT_REVERB: &str = "settings.mode.registerWithoutReverb";
    pub const MODES_PROTECTING: &str = "liveBar.protecting";
    pub const MODES_PROTECT: &str = "liveBar.protect";
    pub const MODES_UNLOCK_HINT: &str = "liveBar.unlockHint";
    pub const MODES_PROTECT_HINT: &str = "liveBar.protectHint";
    pub const MODES_PROTECT_NEEDS_AUDIO: &str = "liveBar.protectNeedsAudio";
    pub const MODES_REFRESH: &str = "settings.LiveModeControls.236";
    pub const MODES_LINKED: &str = "gpuiShell.modesLinked";
    pub const MODES_CANCEL: &str = "settings.mode.cancelRegistration";
    pub const MODES_LOCKED: &str = "gpuiShell.modesLocked";
    pub const HELP_SILENT: &str = "help.trouble.silent";
    pub const HELP_SILENT_BODY: &str = "gpuiShell.helpSilentBody";
    pub const HELP_RECEIVER: &str = "help.trouble.receiver";
    pub const HELP_RECEIVER_BODY: &str = "gpuiShell.helpReceiverBody";
    pub const HELP_DROPOUTS: &str = "help.trouble.dropouts";
    pub const HELP_DROPOUTS_BODY: &str = "gpuiShell.helpDropoutsBody";
    pub const HELP_KEEPS_RUNNING: &str = "help.trouble.keepsRunning";
    pub const HELP_KEEPS_RUNNING_BODY: &str = "gpuiShell.helpKeepsRunningBody";
    pub const ROUTING_INDEPENDENT: &str = "settings.routing.independent";
    pub const ROUTING_INSERT: &str = "settings.routing.insert";
    pub const ROUTING_LEGACY: &str = "settings.routing.legacy";
    pub const ROUTING_INDEPENDENT_HINT: &str = "settings.routing.independentHint";
    pub const ROUTING_INSERT_HINT: &str = "settings.routing.insertHint";
    pub const ROUTING_LEGACY_HINT: &str = "settings.routing.legacyHint";
    pub const ROUTING_MODE: &str = "settings.routing.mode";
    pub const ROUTING_CHANNELS: &str = "settings.routing.channels";
    pub const ROUTING_PAIR: &str = "settings.routing.pair";
    pub const ROUTING_UNVERIFIED: &str = "settings.routing.unverified";
    pub const CHANNEL_INPUT: &str = "settings.channel.input";
    pub const CHANNEL_TITLE: &str = "settings.InputChannelSelector.205";
    pub const CHANNEL_UNVERIFIED: &str = "settings.InputChannelSelector.unverified";
    pub const ACTION_FAILED: &str = "gpuiShell.actionFailed";
    pub const CLOSE: &str = "licenses.close";
    pub const RESET_TO_100: &str = "gpuiShell.resetTo100";
    pub const UNMUTE: &str = "gpuiShell.unmute";
    pub const RESET_NAMED: &str = "gpuiShell.resetNamed";
    pub const QUICK_ADJUST: &str = "gpuiShell.quickAdjust";
    pub const SCAN_FAILED: &str = "pluginNotices.scanFailed";
    pub const CHANNEL_HEARD: &str = "gpuiShell.channelHeard";
    pub const CHANNEL_SILENT: &str = "gpuiShell.channelSilent";
    pub const CHANNEL_WAITING: &str = "gpuiShell.channelWaiting";
    pub const CHANNEL_SUGGEST: &str = "gpuiShell.channelSuggest";
    pub const CHANNEL_USE: &str = "gpuiShell.channelUse";
    pub const CHANNEL_USE_HINT: &str = "gpuiShell.channelUseHint";
    pub const APPEARANCE: &str = "settings.appearance";
    pub const THEME_TITLE: &str = "settings.AudioSettingsModal.130";
    pub const THEME_LIGHT: &str = "header.light";
    pub const THEME_DARK: &str = "header.dark";
    pub const THEME_GAMING: &str = "header.gaming";
    pub const THEME_LIGHT_BODY: &str = "settings.AudioSettingsModal.131";
    pub const THEME_DARK_BODY: &str = "settings.AudioSettingsModal.132";
    pub const THEME_GAMING_BODY: &str = "gpuiShell.themeGamingBody";
    pub const THEME_NOTE: &str = "gpuiShell.themeNote";
    pub const THEME_SAVE_FAILED: &str = "gpuiShell.themeSaveFailed";
    pub const SOURCE: &str = "processInput.source";
    pub const SOURCE_DEVICE: &str = "processInput.device";
    pub const SOURCE_APP: &str = "processInput.process";
    pub const SOURCE_ASIO: &str = "processInput.asioUnavailable";
    pub const PURPOSE: &str = "processInput.purpose";
    pub const PURPOSE_VOICE: &str = "processInput.voice";
    pub const PURPOSE_MUSIC: &str = "processInput.music";
    pub const APP: &str = "processInput.app";
    pub const APP_CHOOSE: &str = "processInput.choose";
    pub const APP_RESELECT: &str = "processInput.reselect";
    pub const APP_RESELECT_HELP: &str = "processInput.reselectHelp";
    pub const APP_CANDIDATE: &str = "processInput.candidate";
    pub const APP_REFRESH: &str = "processInput.refresh";
    pub const APP_REFRESH_HELP: &str = "processInput.refreshHelp";
    pub const APP_ROUTE_HELP: &str = "processInput.routeHelp";
    pub const APP_RAW: &str = "processInput.raw";
    pub const APP_CHOOSE_RAW: &str = "processInput.chooseRaw";
    pub const APP_MUTED: &str = "processInput.muted";
    pub const APP_MUTE_NEEDED: &str = "processInput.muteNeeded";
    pub const RECOVERY_TITLE: &str = "recovery.title";
    pub const RECOVERY_DESCRIPTION: &str = "recovery.description";
    pub const RECOVERY_DEVICE_DESCRIPTION: &str = "recovery.deviceDescription";
    pub const RECOVERY_PENDING: &str = "recovery.pending";
    pub const RECOVERY_EXCLUDE: &str = "recovery.exclude";
    pub const RECOVERY_RELOAD: &str = "recovery.reload";
    pub const RECOVERY_EMPTY: &str = "recovery.empty";
    pub const RECOVERY_SAFETY: &str = "gpuiShell.recoverySafety";
    pub const RECOVERY_STOP: &str = "recovery.stop";
    pub const RECOVERY_DEVICE_STOP: &str = "recovery.deviceStop";
    pub const RECOVERY_CHOOSE_DEVICE: &str = "recovery.chooseDevice";
    pub const EXITED_UNKNOWN: &str = "audioNotices.engineExitedUnknown";
    pub const EXITED_VST: &str = "audioNotices.engineExitedVst";
    pub const EXITED_DEVICE_OPENING: &str = "audioNotices.engineExitedDeviceOpening";
    pub const EXITED_DEVICE_SETTLING: &str = "audioNotices.engineExitedDeviceSettling";
    pub const EXITED_DEVICE_FALLBACK: &str = "audioNotices.deviceFallback";
    pub const EXITED_VST_FALLBACK: &str = "audioNotices.vstFallback";
    pub const VST_OP_LOAD: &str = "audioNotices.vstOp.load";
    pub const VST_OP_RESTORE: &str = "audioNotices.vstOp.restore";
    pub const VST_OP_SET_STATE: &str = "audioNotices.vstOp.setState";
    pub const VST_OP_GET_STATE: &str = "audioNotices.vstOp.getState";
    pub const VST_OP_OPEN_EDITOR: &str = "audioNotices.vstOp.openEditor";
    pub const VST_OP_REMOVE: &str = "audioNotices.vstOp.remove";
    pub const VST_OP_RESUME: &str = "audioNotices.vstOp.resume";
    pub const VST_OP_PROCESSING_SETUP: &str = "audioNotices.vstOp.processingSetup";
    pub const VST_OP_OTHER: &str = "audioNotices.vstOp.other";
    pub const OBS_TITLE: &str = "obs.section.connect";
    pub const OBS_HOST: &str = "settings.ObsConnectionSettings.280";
    pub const OBS_PORT: &str = "settings.ObsConnectionSettings.282";
    pub const OBS_PASSWORD: &str = "settings.ObsConnectionSettings.285";
    pub const OBS_PASSWORD_SCOPE: &str = "obs.passwordScope";
    pub const OBS_USE_SAVED: &str = "obs.useSavedPassword";
    pub const OBS_FORGET: &str = "obs.forgetPassword";
    pub const OBS_SAVED_UNREADABLE: &str = "obs.credentialsUnavailable";
    pub const OBS_CHECKING: &str = "settings.ObsConnectionSettings.288";
    pub const OBS_CONNECTING: &str = "settings.ObsConnectionSettings.289";
    pub const OBS_CONNECT: &str = "settings.ObsConnectionSettings.290";
    pub const OBS_CONNECTED: &str = "settings.ObsConnectionSettings.291";
    pub const OBS_DISCONNECT: &str = "settings.ObsConnectionSettings.292";
    pub const OBS_FAILED: &str = "settings.ObsConnectionSettings.268";
    pub const OBS_DISCONNECTED: &str = "obs.status.disconnected";
    pub const OBS_TARGET: &str = "settings.obs.connectedTarget";
    pub const OBS_EDIT_HINT: &str = "settings.ObsConnectionSettings.287";
    pub const OBS_NEEDS: &str = "settings.ObsConnectionSettings.296";
    pub const OBS_SERVER: &str = "settings.ObsConnectionSettings.297";
    pub const OBS_PEAK: &str = "settings.obs.peak";
    pub const OBS_REACHED: &str = "obsReach.confirmed";
    pub const OBS_NOT_REACHED: &str = "settings.ObsConnectionSettings.277";
    pub const OBS_NOT_REACHED_HINT: &str = "settings.ObsConnectionSettings.306";
    pub const OBS_METER_UNSUPPORTED: &str = "settings.ObsConnectionSettings.301";
    pub const OBS_REACH_STALE: &str = "obsReach.stale";
    pub const OBS_REACH_TITLE: &str = "obs.section.reach";
    pub const OBS_REACHING: &str = "settings.ObsConnectionSettings.299";
    pub const OBS_REACH_CHECK: &str = "settings.ObsConnectionSettings.300";
    pub const OBS_REACH_CONFIRM_TITLE: &str = "settings.ObsConnectionSettings.271";
    pub const OBS_REACH_CONFIRM_TEXT: &str = "settings.ObsConnectionSettings.272";
    pub const OBS_REACH_PLAY: &str = "settings.ObsConnectionSettings.273";
    pub const OBS_REACH_FAILED: &str = "settings.ObsConnectionSettings.279";
    pub const OBS_REACH_SCOPE: &str = "obsReach.scope";
    pub const SCENE_TITLE: &str = "structure.sceneRouting";
    pub const SCENE_LEAD: &str = "settings.apply.sceneDraft";
    pub const SCENE_NONE: &str = "settings.ObsModeRoutingSettings.317";
    pub const SCENE_PROFILE: &str = "settings.ObsModeRoutingSettings.318";
    pub const SCENE_MODE: &str = "settings.ObsModeRoutingSettings.319";
    pub const SCENE_ENABLE: &str = "settings.ObsModeRoutingSettings.320";
    pub const SCENE_MODE_LEAD: &str = "settings.ObsModeRoutingSettings.321";
    pub const SCENE_NAME_N: &str = "settings.ObsModeRoutingSettings.323";
    pub const SCENE_SINGING: &str = "settings.ObsModeRoutingSettings.326";
    pub const SCENE_TALK: &str = "settings.ObsModeRoutingSettings.327";
    pub const SCENE_REMOVE: &str = "settings.ObsModeRoutingSettings.328";
    pub const SCENE_ADD: &str = "settings.ObsModeRoutingSettings.329";
    pub const SCENE_SAVE: &str = "settings.ObsModeRoutingSettings.330";
    pub const SCENE_SAVED: &str = "settings.ObsModeRoutingSettings.309";
    pub const SCENE_NAMES: &str = "settings.ObsModeRoutingSettings.308";
    pub const SCENE_SAVE_FAILED: &str = "settings.ObsModeRoutingSettings.310";
    pub const OBS_SETUP_TITLE: &str = "settings.ObsSafeSetup.335";
    pub const OBS_SETUP_STOP_FIRST: &str = "obsSetup.stopFirst";
    pub const OBS_SETUP_PREVIEW: &str = "settings.ObsSafeSetup.337";
    pub const OBS_SETUP_BUSY: &str = "settings.obs.operationBusy";
    pub const OBS_SETUP_NEEDS_OBS: &str = "settings.obs.connectionRequired";
    pub const OBS_SETUP_NOTHING: &str = "settings.ObsSafeSetup.341";
    pub const OBS_SETUP_APPLY: &str = "settings.ObsSafeSetup.342";
    pub const OBS_SETUP_CANCEL: &str = "settings.ObsSafeSetup.343";
    pub const OBS_SETUP_DUPLICATE_MIC: &str = "settings.ObsSafeSetup.344";
    pub const OBS_SETUP_MUTE_PREVIEW: &str = "settings.obs.mutePreview";
    pub const OBS_SETUP_HISTORY: &str = "structure.history";
    pub const OBS_SETUP_HISTORY_LEAD: &str = "settings.ObsSafeSetup.346";
    pub const OBS_SETUP_REFRESH: &str = "settings.ObsSafeSetup.347";
    pub const OBS_SETUP_TIMING_CHANGE: &str = "settings.ObsSafeSetup.349";
    pub const OBS_SETUP_CHANGE: &str = "settings.ObsSafeSetup.350";
    pub const OBS_SETUP_NOT_RESTORABLE: &str = "settings.ObsSafeSetup.355";
    pub const OBS_SETUP_UNDO: &str = "settings.obs.undo";
    pub const OBS_SETUP_FORGET: &str = "settings.obs.forget";
    pub const OBS_SETUP_FORGET_TEXT: &str = "settings.ObsSafeSetup.360";
    pub const OBS_SETUP_FORGET_OK: &str = "settings.ObsSafeSetup.361";
    pub const OBS_SETUP_FORGET_CANCEL: &str = "settings.ObsSafeSetup.362";
    pub const OBS_SETUP_HISTORY_FULL: &str = "obsSetup.historyFull";
    pub const OBS_SETUP_PREVIEW_FAILED: &str = "obsSetup.previewFailed";
    pub const OBS_SETUP_PREVIEW_NEXT: &str = "obsSetup.previewNextStep";
    pub const OBS_SETUP_APPLY_FAILED: &str = "obsSetup.applyFailed";
    pub const OBS_SETUP_ERROR_NEXT: &str = "obsSetup.errorNextStep";
    pub const OBS_SETUP_UNDO_FAILED: &str = "obsSetup.undoFailed";
    pub const OBS_SETUP_FORGET_FAILED: &str = "obsSetup.forgetFailed";
    pub const OBS_SETUP_FORGET_NEXT: &str = "obsSetup.forgetNextStep";
    pub const OBS_TIMING_TITLE: &str = "obsTiming.copy.06";
    pub const OBS_TIMING_LEAD: &str = "obsTiming.copy.07";
    pub const OBS_TIMING_SCOPE: &str = "obsTiming.copy.08";
    pub const OBS_TIMING_STEP: &str = "obsTiming.copy.16";
    pub const OBS_TIMING_COMPARE: &str = "obsTiming.copy.17";
    pub const OBS_TIMING_VOICE_MUSIC: &str = "obsTiming.copy.18";
    pub const OBS_TIMING_AUDIO_VIDEO: &str = "obsTiming.copy.19";
    pub const OBS_TIMING_SEPARATE: &str = "guide.copy.149";
    pub const OBS_TIMING_MIXED: &str = "guide.copy.150";
    pub const OBS_TIMING_WHEN: &str = "obsTiming.copy.20";
    pub const OBS_TIMING_AV_EARLY: &str = "obsTiming.copy.22";
    pub const OBS_TIMING_VOICE_EARLY: &str = "obsTiming.copy.23";
    pub const OBS_TIMING_AV_LATE: &str = "obsTiming.copy.24";
    pub const OBS_TIMING_VOICE_LATE: &str = "obsTiming.copy.25";
    pub const OBS_TIMING_UNKNOWN: &str = "obsTiming.copy.26";
    pub const OBS_TIMING_DIFFERENCE: &str = "obsTiming.copy.27";
    pub const OBS_TIMING_NOTE: &str = "obsTiming.copy.28";
    pub const OBS_TIMING_NOTE_HINT: &str = "obsTiming.copy.29";
    pub const OBS_TIMING_FPS: &str = "obsTiming.copy.30";
    pub const OBS_TIMING_TRACK: &str = "obsTiming.copy.31";
    pub const OBS_TIMING_CHECKED: &str = "obsTiming.copy.32";
    pub const OBS_TIMING_BLOCK_MIXED: &str = "obsTiming.copy.33";
    pub const OBS_TIMING_BLOCK_UNKNOWN: &str = "obsTiming.copy.34";
    pub const OBS_TIMING_BLOCK_AUDIO_LATE: &str = "obsTiming.copy.35";
    pub const OBS_TIMING_ROLE_AUDIO: &str = "obsTiming.copy.03";
    pub const OBS_TIMING_ROLE_MUSIC: &str = "obsTiming.copy.04";
    pub const OBS_TIMING_ROLE_VOICE: &str = "obsTiming.copy.05";
    pub const OBS_TIMING_ROLE: &str = "obsTiming.targetRole";
    pub const OBS_TIMING_FETCH: &str = "obsTiming.copy.36";
    pub const OBS_TIMING_NO_TARGETS: &str = "obsTiming.copy.37";
    pub const OBS_TIMING_TARGET: &str = "obsTiming.copy.38";
    pub const OBS_TIMING_OUT_OF_RANGE: &str = "obsTiming.copy.40";
    pub const OBS_TIMING_PREVIEW: &str = "obsTiming.copy.41";
    pub const OBS_TIMING_READY: &str = "obsTiming.targetsReady";
    pub const OBS_TIMING_UNAVAILABLE: &str = "obsTiming.targetsUnavailable";
    pub const OBS_TIMING_SOURCE: &str = "obsTiming.sourceOption";
    pub const OBS_TIMING_OFFSET: &str = "obsTiming.offset";
    pub const OBS_TIMING_FAILURE: &str = "obsTiming.failure";
    pub const OBS_TIMING_FOOTER: &str = "obsTiming.copy.53";
    pub const OBS_TIMING_HISTORY: &str = "settings.obs.timing";
    pub const HOME_CHANGE_DEVICES: &str = "home.changeDevices";
    pub const HOME_VOICE_CHECK: &str = "home.voiceCheck";
    pub const PREP_ACK_LISTEN: &str = "prep.ackListen";
    pub const PREP_ACK_LOCAL: &str = "prep.ackLocal";
    pub const PREP_ACK_PURPOSE: &str = "prep.ackPurpose";
    pub const PREP_ACK_RECEIVER: &str = "prep.ackReceiver";
    pub const PREP_ACK_SOUND: &str = "prep.ackSound";
    pub const PREP_CALL: &str = "prep.call";
    pub const PREP_CALL_SCOPE: &str = "prep.callScope";
    pub const PREP_CHECKING: &str = "prep.checking";
    pub const PREP_CHECK_RECEIVER: &str = "prep.checkReceiver";
    pub const PREP_EXTERNAL_CHANGED: &str = "prep.externalChanged";
    pub const PREP_EXTERNAL_SCOPE: &str = "prep.externalScope";
    pub const PREP_FAILED: &str = "prep.failed";
    pub const PREP_HOME: &str = "prep.home";
    pub const PREP_LISTEN_CONFIRMED: &str = "prep.listenConfirmed";
    pub const PREP_LISTEN_UNCONFIRMED: &str = "prep.listenUnconfirmed";
    pub const PREP_LOCAL: &str = "prep.local";
    pub const PREP_LOCAL_RECEIVER: &str = "prep.localReceiver";
    pub const PREP_LOCAL_SCOPE: &str = "prep.localScope";
    pub const PREP_LOCATION: &str = "prep.location";
    pub const PREP_MANUAL_SCOPE: &str = "prep.manualScope";
    pub const PREP_MIXED: &str = "prep.mixed";
    pub const PREP_MIXED_WARNING: &str = "prep.mixedWarning";
    pub const PREP_MUTED: &str = "prep.muted";
    pub const PREP_OBS: &str = "prep.obs";
    pub const PREP_OBS_TARGET: &str = "prep.obsTarget";
    pub const PREP_OTHER: &str = "prep.other";
    pub const PREP_PENDING: &str = "prep.pending";
    pub const PREP_RECEIVER: &str = "prep.receiver";
    pub const PREP_REFRESH: &str = "prep.refresh";
    pub const PREP_RUNNING: &str = "prep.running";
    pub const PREP_SEPARATE: &str = "prep.separate";
    pub const PREP_SESSION_CHECKED: &str = "prep.sessionChecked";
    pub const PREP_SIGNAL: &str = "prep.signal";
    pub const PREP_SIGNAL_UNKNOWN: &str = "prep.signalUnknown";
    pub const PREP_STALE: &str = "prep.stale";
    pub const PREP_STEPS: &str = "prep.steps";
    pub const PREP_TARGET: &str = "prep.target";
    pub const PREP_TITLE: &str = "prep.title";
    pub const PREP_UNCONFIRM: &str = "prep.unconfirm";
    pub const PREP_UNCONFIRMED: &str = "prep.unconfirmed";
    pub const PREP_USER_CONFIRMED: &str = "prep.userConfirmed";
    pub const PREP_VENUE: &str = "prep.venue";
    pub const PREP_VENUE_WARNING: &str = "prep.venueWarning";
    pub const SHELL_CONFIGURE: &str = "shell.configure";
    pub const SHELL_LISTEN: &str = "shell.listen";
    pub const SHELL_SOUND: &str = "shell.sound";
    pub const SHELL_STOPPED: &str = "shell.stopped";
    pub const SHELL_UNCONFIGURED: &str = "shell.unconfigured";
    pub const SHELL_UNKNOWN: &str = "shell.unknown";
    pub const SCAN_FOLDERS: &str = "pluginBrowser.scanFolders";
    pub const SCAN_FOLDERS_HINT: &str = "pluginBrowser.scanFoldersHint";
    pub const SCAN_FOLDER_COUNT: &str = "pluginBrowser.scanFolderCount";
    pub const SCAN_FOLDER_STANDARD: &str = "pluginBrowser.scanFolderStandard";
    pub const SCAN_FOLDER_PATH: &str = "pluginBrowser.scanFolderPath";
    pub const SCAN_FOLDER_ADD: &str = "pluginBrowser.scanFolderAdd";
    pub const SCAN_FOLDER_REMOVE: &str = "pluginBrowser.scanFolderRemove";
    pub const SCAN_FOLDER_REMOVE_NAMED: &str = "pluginBrowser.scanFolderRemoveNamed";
    pub const SCAN_FOLDER_MISSING: &str = "pluginBrowser.scanFolderMissing";
    pub const SCAN_FOLDER_NOT_DIRECTORY: &str = "pluginBrowser.scanFolderNotDirectory";
    pub const SCAN_FOLDER_INVALID: &str = "pluginBrowser.scanFolderInvalid";
    pub const SCAN_FOLDER_DUPLICATE: &str = "pluginBrowser.scanFolderDuplicate";
    pub const SCAN_FOLDER_EMPTY: &str = "pluginBrowser.scanFolderEmpty";
    pub const SCAN_FOLDER_SAVE_FAILED: &str = "pluginBrowser.scanFolderSaveFailed";
    pub const SCAN_FOLDER_FULL: &str = "pluginBrowser.scanFolderFull";
    pub const USAGE_LOAD: &str = "gpuiShell.usageLoad";
    pub const USAGE_SWITCH_DEVICES: &str = "purpose.switchDevices";
    pub const MUSIC_PLAYBACK: &str = "music.playback";
    pub const MUSIC_PRESET_LABEL: &str = "music.presetLabel";
    pub const MUSIC_PRESET_CHOOSE: &str = "music.presetChoose";
    pub const MUSIC_SOUND_HINT: &str = "music.soundHint";
    pub const MUSIC_SOURCE_HINT: &str = "music.sourceHint";
    pub const MUSIC_SOURCE_HINT_GENERIC: &str = "music.sourceHintGeneric";
    pub const SETTINGS_OBS: &str = "settings.obs";
    pub const SETTINGS_SHORTCUTS: &str = "settings.shortcuts";
    pub const SETTINGS_SYSTEM: &str = "settings.system";
    pub const POST_ON: &str = "flow.enabled";
    pub const POST_OFF: &str = "flow.disabled";
    pub const MIX_DIAG_TITLE: &str = "mixingDiagnostics.title";
    pub const MIX_DIAG_CAPTURE: &str = "mixingDiagnostics.capture";
    pub const MIX_DIAG_QUEUE: &str = "mixingDiagnostics.queue";
    pub const MIX_DIAG_CORRECTION: &str = "mixingDiagnostics.correction";
    pub const MIX_DIAG_DISCONTINUITIES: &str = "mixingDiagnostics.discontinuities";
    pub const MIX_DIAG_TIMESTAMPS: &str = "mixingDiagnostics.timestamps";
    pub const MIX_DIAG_NONFINITE: &str = "mixingDiagnostics.nonfinite";
    pub const MIX_DIAG_DISCARDED: &str = "mixingDiagnostics.discarded";
    pub const MIX_DIAG_PRIMARY_QUEUE: &str = "mixingDiagnostics.primaryQueue";
    pub const MIX_DIAG_PRIMARY_CORRECTION: &str = "mixingDiagnostics.primaryCorrection";
    pub const MIX_DIAG_UNDERRUNS: &str = "mixingDiagnostics.underruns";
    pub const MIX_DIAG_VOICE_FRAMES: &str = "mixingDiagnostics.voiceFrames";
    pub const MIX_DIAG_ATTACHED: &str = "mixingDiagnostics.attached";
    pub const MIX_DIAG_READY: &str = "mixingDiagnostics.ready";
    pub const MIX_DIAG_FAILED: &str = "mixingDiagnostics.failed";
    pub const MIX_DIAG_PACKETS: &str = "mixingDiagnostics.packets";
    pub const MIX_DIAG_RATE: &str = "mixingDiagnostics.rate";
    pub const MIX_DIAG_TRANSPORT: &str = "mixingDiagnostics.transport";
    pub const MIX_DIAG_DECLARED: &str = "mixingDiagnostics.declared";

    #[cfg(test)]
    pub const ALL: [&str; 688] = [
        OBS_SETUP_TITLE,
        OBS_SETUP_STOP_FIRST,
        OBS_SETUP_PREVIEW,
        OBS_SETUP_BUSY,
        OBS_SETUP_NEEDS_OBS,
        OBS_SETUP_NOTHING,
        OBS_SETUP_APPLY,
        OBS_SETUP_CANCEL,
        OBS_SETUP_DUPLICATE_MIC,
        OBS_SETUP_MUTE_PREVIEW,
        OBS_SETUP_HISTORY,
        OBS_SETUP_HISTORY_LEAD,
        OBS_SETUP_REFRESH,
        OBS_SETUP_TIMING_CHANGE,
        OBS_SETUP_CHANGE,
        OBS_SETUP_NOT_RESTORABLE,
        OBS_SETUP_UNDO,
        OBS_SETUP_FORGET,
        OBS_SETUP_FORGET_TEXT,
        OBS_SETUP_FORGET_OK,
        OBS_SETUP_FORGET_CANCEL,
        OBS_SETUP_HISTORY_FULL,
        OBS_SETUP_PREVIEW_FAILED,
        OBS_SETUP_PREVIEW_NEXT,
        OBS_SETUP_APPLY_FAILED,
        OBS_SETUP_ERROR_NEXT,
        OBS_SETUP_UNDO_FAILED,
        OBS_SETUP_FORGET_FAILED,
        OBS_SETUP_FORGET_NEXT,
        SCENE_TITLE,
        SCENE_LEAD,
        SCENE_NONE,
        SCENE_PROFILE,
        SCENE_MODE,
        SCENE_ENABLE,
        SCENE_MODE_LEAD,
        SCENE_NAME_N,
        SCENE_SINGING,
        SCENE_TALK,
        SCENE_REMOVE,
        SCENE_ADD,
        SCENE_SAVE,
        SCENE_SAVED,
        SCENE_NAMES,
        SCENE_SAVE_FAILED,
        OBS_PEAK,
        OBS_REACHED,
        OBS_NOT_REACHED,
        OBS_NOT_REACHED_HINT,
        OBS_METER_UNSUPPORTED,
        OBS_REACH_STALE,
        OBS_REACH_TITLE,
        OBS_REACHING,
        OBS_REACH_CHECK,
        OBS_REACH_CONFIRM_TITLE,
        OBS_REACH_CONFIRM_TEXT,
        OBS_REACH_PLAY,
        OBS_REACH_FAILED,
        OBS_REACH_SCOPE,
        OBS_TITLE,
        OBS_HOST,
        OBS_PORT,
        OBS_PASSWORD,
        OBS_PASSWORD_SCOPE,
        OBS_USE_SAVED,
        OBS_FORGET,
        OBS_SAVED_UNREADABLE,
        OBS_CHECKING,
        OBS_CONNECTING,
        OBS_CONNECT,
        OBS_CONNECTED,
        OBS_DISCONNECT,
        OBS_FAILED,
        OBS_DISCONNECTED,
        OBS_TARGET,
        OBS_EDIT_HINT,
        OBS_NEEDS,
        OBS_SERVER,
        FLOW_VOICE,
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
        APPLY_RESTART,
        RESTART_NOTE,
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
        SETUPS_EXISTS,
        SETUPS_DELETE,
        SETUPS_DELETE_TITLE,
        SETUPS_DELETE_WARNING,
        SETUPS_CONFIRM_DELETE,
        SETUPS_EXPORT,
        SETUPS_EXPORTED,
        SETUPS_IMPORT,
        SETUPS_IMPORTED,
        SETUPS_APPLIED,
        SETUPS_RESTORED,
        SETUPS_IMPORT_EXISTS,
        SETUPS_IMPORT_NOTHING,
        SETUPS_IMPORT_INVALID,
        VOICE_TITLE,
        VOICE_LEAD,
        VOICE_SCOPE,
        VOICE_NEEDS_AUDIO,
        VOICE_RECORD,
        VOICE_STOP,
        VOICE_REMAINING,
        VOICE_SAVE,
        VOICE_BEFORE,
        VOICE_AFTER,
        VOICE_SAVED,
        LISTEN_TITLE,
        LISTEN_LEAD,
        LISTEN_REFRESH,
        LISTEN_DEVICE,
        LISTEN_CHOOSE,
        LISTEN_SAFE,
        LISTEN_PLAYING,
        LISTEN_STOPPED,
        LISTEN_PLAY,
        LISTEN_STOP,
        LISTEN_LOOP,
        LISTEN_RETRY,
        DIAG_TITLE,
        DIAG_REFRESH,
        DIAG_LOADED,
        DIAG_ENABLED,
        DIAG_PENDING,
        DIAG_BURNED,
        DIAG_JITTER,
        DIAG_GLITCHES,
        DIAG_RECENT_LABEL,
        DIAG_RECENT,
        DIAG_RECENT_NOTE,
        DIAG_RECENT_HIGH,
        PLUGINS_TITLE,
        EXCL_TITLE,
        EXCL_LEAD,
        EXCL_CONFIRM_TITLE,
        EXCL_CONFIRM_TEXT,
        EXCL_CONFIRM,
        EXCL_DONE,
        EXCL_FAILED,
        EXCL_BUTTON,
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
        VST_REMOVE_NAMED,
        VST_UP,
        VST_DOWN,
        VST_REMOVE_TITLE,
        VST_REMOVE_WARNING,
        VST_CONFIRM_REMOVE,
        CANCEL,
        VST_NOT_LOADED,
        VST_RELOAD_MISSING,
        VST_RELOAD_MISSING_HINT,
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
        SINGING_PRESET,
        SINGING_LOW_CUT,
        SINGING_DYNAMICS,
        SINGING_BRIGHTNESS,
        REVERB,
        REVERB_ON,
        REVERB_LEAD,
        REVERB_MIX,
        REVERB_DECAY,
        REVERB_DAMPING,
        DEESSER,
        DEESSER_HINT,
        DEESSER_AMOUNT,
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
        PEAK_LOCKED,
        TRUE_PEAK_TITLE,
        TRUE_PEAK_LEAD,
        TRUE_PEAK_SCOPE,
        TRUE_PEAK_REDUCTION,
        TRUE_PEAK_LATENCY,
        TRUE_PEAK_NOT_APPLIED,
        TRUE_PEAK_LIMITS,
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
        SHORTCUTS_TITLE,
        SHORTCUTS_EMPTY,
        SHORTCUTS_UNREADABLE,
        SHORTCUTS_EDIT_IN_TAURI,
        SHORTCUT_MUTE_TOGGLE,
        SHORTCUT_MUTE_ON,
        SHORTCUT_MUTE_OFF,
        SHORTCUT_BYPASS_TOGGLE,
        SHORTCUT_BYPASS_ON,
        SHORTCUT_BYPASS_OFF,
        SHORTCUT_GAIN_UP,
        SHORTCUT_GAIN_DOWN,
        SHORTCUT_SINGING,
        SHORTCUT_TALK,
        SHORTCUT_NOISE,
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
        LIVE_TITLE,
        LIVE_SCOPE,
        LIVE_REFRESH,
        LIVE_DEVICE,
        LIVE_OFF,
        LIVE_MISSING,
        LIVE_ACTIVE,
        LIVE_INACTIVE,
        LIVE_FAILED,
        LIVE_MONITOR_TRIM,
        LIVE_BROADCAST_TRIM,
        LIVE_MONITOR_MUTED,
        LIVE_CONFIRM,
        LIVE_SAVE,
        LIVE_SPLIT_KEPT,
        LIVE_SPLIT,
        LIVE_SPLIT_SCOPE,
        MIX_TITLE,
        MIX_LEAD,
        MIX_NEED_OUTPUT,
        MIX_CURRENT,
        MIX_SAVED,
        MIX_NONE,
        MIX_APP,
        MIX_REFRESH_APPS,
        MIX_ROUTE,
        MIX_ROUTE_HELP,
        MIX_ROUTE_MUTED,
        MIX_ROUTE_NEEDS_MUTE,
        MIX_ROUTE_MUTE_FIRST,
        MIX_INPUT_FAILED,
        MIX_SOURCE,
        MIX_CHANNELS,
        MIX_STOP_FIRST,
        MIX_CONFIRM,
        MIX_APPLY,
        MIX_DISABLE,
        MIX_VOICE,
        MIX_MUSIC,
        MIX_VOICE_MUTE,
        MIX_MUSIC_MUTE,
        MIX_MONITOR,
        MIX_RELOAD,
        MIX_OFFSET,
        MIX_OFFSET_APPLY,
        MIX_OFFSET_INVALID,
        MIX_OFFSET_HELP,
        MIX_OFFSET_UNCONFIRMED,
        MIX_OFFSET_CHANGED,
        MIX_OFFSET_LEGACY,
        MIX_OFFSET_UNKNOWN,
        MIX_OFFSET_CONFIRM,
        MIX_OFFSET_VOICE_INPUT,
        MIX_OFFSET_CHANNELS,
        MIX_OFFSET_OUTPUT,
        MIX_OFFSET_BROADCAST,
        POST_TITLE,
        POST_SCOPE,
        POST_SAVED,
        POST_NONE,
        POST_ERROR,
        POST_RESTORE_NEEDED,
        POST_RESTORE,
        POST_STOP,
        POST_ENABLED,
        POST_NEEDS_MIX,
        POST_CHOOSE,
        POST_ADD,
        POST_SCAN,
        POST_RECOVERY,
        POST_RECOVERY_HELP,
        POST_RESET,
        POST_SAVE,
        POST_RELOAD,
        SETUP_TITLE,
        SETUP_LEAD,
        SETUP_GOAL,
        SETUP_GOAL_OBS,
        SETUP_GOAL_CHAT,
        SETUP_GOAL_LISTEN,
        SETUP_MICROPHONE,
        SETUP_OUTPUT,
        SETUP_CABLE_BEFORE,
        SETUP_CABLE,
        SETUP_CABLE_AFTER,
        SETUP_LISTEN_HINT,
        SETUP_START,
        SETUP_OTHER,
        HELP_TROUBLE,
        HELP_DOCS,
        HELP_MORE,
        HELP_TERMS,
        GUIDE_OBS,
        GUIDE_CALL,
        MODES_TITLE,
        MODES_UNREAD,
        MODES_STATE_FAILED,
        MODES_SWITCHING,
        MODES_PARTIAL,
        MODES_STOPPED,
        MODES_CUSTOM,
        MODES_HINT,
        MODES_SINGING,
        MODES_TALK,
        MODES_TRANSACTION_RUNNING,
        MODES_TRANSACTION_FAILED,
        MODES_RECOVER,
        MODES_FAILED,
        MODES_SAVED,
        MODES_UNSAVED,
        MODES_REGISTER,
        MODES_REGISTER_NOTE,
        MODES_SAVE_SINGING,
        MODES_SAVE_TALK,
        MODES_REVERB_CONFIRM,
        MODES_WITHOUT_REVERB,
        MODES_PROTECTING,
        MODES_PROTECT,
        MODES_UNLOCK_HINT,
        MODES_PROTECT_HINT,
        MODES_PROTECT_NEEDS_AUDIO,
        MODES_REFRESH,
        MODES_LINKED,
        MODES_CANCEL,
        MODES_LOCKED,
        HELP_SILENT,
        HELP_SILENT_BODY,
        HELP_RECEIVER,
        HELP_RECEIVER_BODY,
        HELP_DROPOUTS,
        HELP_DROPOUTS_BODY,
        HELP_KEEPS_RUNNING,
        HELP_KEEPS_RUNNING_BODY,
        ROUTING_INDEPENDENT,
        ROUTING_INSERT,
        ROUTING_LEGACY,
        ROUTING_INDEPENDENT_HINT,
        ROUTING_INSERT_HINT,
        ROUTING_LEGACY_HINT,
        ROUTING_MODE,
        ROUTING_CHANNELS,
        ROUTING_PAIR,
        ROUTING_UNVERIFIED,
        CHANNEL_INPUT,
        CHANNEL_TITLE,
        CHANNEL_UNVERIFIED,
        ACTION_FAILED,
        CLOSE,
        RESET_TO_100,
        UNMUTE,
        STOP_SHORT,
        RAIL_HELP,
        RESET_NAMED,
        QUICK_ADJUST,
        SCAN_FAILED,
        CHANNEL_HEARD,
        CHANNEL_SILENT,
        CHANNEL_WAITING,
        CHANNEL_SUGGEST,
        CHANNEL_USE,
        CHANNEL_USE_HINT,
        APPEARANCE,
        THEME_TITLE,
        THEME_LIGHT,
        THEME_DARK,
        THEME_GAMING,
        THEME_LIGHT_BODY,
        THEME_DARK_BODY,
        THEME_GAMING_BODY,
        THEME_NOTE,
        THEME_SAVE_FAILED,
        SOURCE,
        SOURCE_DEVICE,
        SOURCE_APP,
        SOURCE_ASIO,
        PURPOSE,
        PURPOSE_VOICE,
        PURPOSE_MUSIC,
        APP,
        APP_CHOOSE,
        APP_RESELECT,
        APP_RESELECT_HELP,
        APP_CANDIDATE,
        APP_REFRESH,
        APP_REFRESH_HELP,
        APP_ROUTE_HELP,
        APP_RAW,
        APP_CHOOSE_RAW,
        APP_MUTED,
        APP_MUTE_NEEDED,
        RECOVERY_TITLE,
        RECOVERY_DESCRIPTION,
        RECOVERY_DEVICE_DESCRIPTION,
        RECOVERY_PENDING,
        RECOVERY_EXCLUDE,
        RECOVERY_RELOAD,
        RECOVERY_EMPTY,
        RECOVERY_SAFETY,
        RECOVERY_STOP,
        RECOVERY_DEVICE_STOP,
        RECOVERY_CHOOSE_DEVICE,
        EXITED_UNKNOWN,
        EXITED_VST,
        EXITED_DEVICE_OPENING,
        EXITED_DEVICE_SETTLING,
        EXITED_DEVICE_FALLBACK,
        EXITED_VST_FALLBACK,
        VST_OP_LOAD,
        VST_OP_RESTORE,
        VST_OP_SET_STATE,
        VST_OP_GET_STATE,
        VST_OP_OPEN_EDITOR,
        VST_OP_REMOVE,
        VST_OP_RESUME,
        VST_OP_PROCESSING_SETUP,
        VST_OP_OTHER,
        OBS_TIMING_TITLE,
        OBS_TIMING_LEAD,
        OBS_TIMING_SCOPE,
        OBS_TIMING_STEP,
        OBS_TIMING_COMPARE,
        OBS_TIMING_VOICE_MUSIC,
        OBS_TIMING_AUDIO_VIDEO,
        OBS_TIMING_SEPARATE,
        OBS_TIMING_MIXED,
        OBS_TIMING_WHEN,
        OBS_TIMING_AV_EARLY,
        OBS_TIMING_VOICE_EARLY,
        OBS_TIMING_AV_LATE,
        OBS_TIMING_VOICE_LATE,
        OBS_TIMING_UNKNOWN,
        OBS_TIMING_DIFFERENCE,
        OBS_TIMING_NOTE,
        OBS_TIMING_NOTE_HINT,
        OBS_TIMING_FPS,
        OBS_TIMING_TRACK,
        OBS_TIMING_CHECKED,
        OBS_TIMING_BLOCK_MIXED,
        OBS_TIMING_BLOCK_UNKNOWN,
        OBS_TIMING_BLOCK_AUDIO_LATE,
        OBS_TIMING_ROLE_AUDIO,
        OBS_TIMING_ROLE_MUSIC,
        OBS_TIMING_ROLE_VOICE,
        OBS_TIMING_ROLE,
        OBS_TIMING_FETCH,
        OBS_TIMING_NO_TARGETS,
        OBS_TIMING_TARGET,
        OBS_TIMING_OUT_OF_RANGE,
        OBS_TIMING_PREVIEW,
        OBS_TIMING_READY,
        OBS_TIMING_UNAVAILABLE,
        OBS_TIMING_SOURCE,
        OBS_TIMING_OFFSET,
        OBS_TIMING_FAILURE,
        OBS_TIMING_FOOTER,
        OBS_TIMING_HISTORY,
        HOME_CHANGE_DEVICES,
        HOME_VOICE_CHECK,
        PREP_ACK_LISTEN,
        PREP_ACK_LOCAL,
        PREP_ACK_PURPOSE,
        PREP_ACK_RECEIVER,
        PREP_ACK_SOUND,
        PREP_CALL,
        PREP_CALL_SCOPE,
        PREP_CHECKING,
        PREP_CHECK_RECEIVER,
        PREP_EXTERNAL_CHANGED,
        PREP_EXTERNAL_SCOPE,
        PREP_FAILED,
        PREP_HOME,
        PREP_LISTEN_CONFIRMED,
        PREP_LISTEN_UNCONFIRMED,
        PREP_LOCAL,
        PREP_LOCAL_RECEIVER,
        PREP_LOCAL_SCOPE,
        PREP_LOCATION,
        PREP_MANUAL_SCOPE,
        PREP_MIXED,
        PREP_MIXED_WARNING,
        PREP_MUTED,
        PREP_OBS,
        PREP_OBS_TARGET,
        PREP_OTHER,
        PREP_PENDING,
        PREP_RECEIVER,
        PREP_REFRESH,
        PREP_RUNNING,
        PREP_SEPARATE,
        PREP_SESSION_CHECKED,
        PREP_SIGNAL,
        PREP_SIGNAL_UNKNOWN,
        PREP_STALE,
        PREP_STEPS,
        PREP_TARGET,
        PREP_TITLE,
        PREP_UNCONFIRM,
        PREP_UNCONFIRMED,
        PREP_USER_CONFIRMED,
        PREP_VENUE,
        PREP_VENUE_WARNING,
        SHELL_CONFIGURE,
        SHELL_LISTEN,
        SHELL_SOUND,
        SHELL_STOPPED,
        SHELL_UNCONFIGURED,
        SHELL_UNKNOWN,
        SCAN_FOLDERS,
        SCAN_FOLDERS_HINT,
        SCAN_FOLDER_COUNT,
        SCAN_FOLDER_STANDARD,
        SCAN_FOLDER_PATH,
        SCAN_FOLDER_ADD,
        SCAN_FOLDER_REMOVE,
        SCAN_FOLDER_REMOVE_NAMED,
        SCAN_FOLDER_MISSING,
        SCAN_FOLDER_NOT_DIRECTORY,
        SCAN_FOLDER_INVALID,
        SCAN_FOLDER_DUPLICATE,
        SCAN_FOLDER_EMPTY,
        SCAN_FOLDER_SAVE_FAILED,
        SCAN_FOLDER_FULL,
        USAGE_LOAD,
        USAGE_SWITCH_DEVICES,
        MUSIC_PLAYBACK,
        MUSIC_PRESET_LABEL,
        MUSIC_PRESET_CHOOSE,
        MUSIC_SOUND_HINT,
        MUSIC_SOURCE_HINT,
        MUSIC_SOURCE_HINT_GENERIC,
        SETTINGS_OBS,
        SETTINGS_SHORTCUTS,
        SETTINGS_SYSTEM,
        POST_ON,
        POST_OFF,
        MIX_DIAG_TITLE,
        MIX_DIAG_CAPTURE,
        MIX_DIAG_QUEUE,
        MIX_DIAG_CORRECTION,
        MIX_DIAG_DISCONTINUITIES,
        MIX_DIAG_TIMESTAMPS,
        MIX_DIAG_NONFINITE,
        MIX_DIAG_DISCARDED,
        MIX_DIAG_PRIMARY_QUEUE,
        MIX_DIAG_PRIMARY_CORRECTION,
        MIX_DIAG_UNDERRUNS,
        MIX_DIAG_VOICE_FRAMES,
        MIX_DIAG_ATTACHED,
        MIX_DIAG_READY,
        MIX_DIAG_FAILED,
        MIX_DIAG_PACKETS,
        MIX_DIAG_RATE,
        MIX_DIAG_TRANSPORT,
        MIX_DIAG_DECLARED,
    ];
}

/// キーを組み立てる文言（OBS の変更の説明など）。無いキーなら `None`。
pub fn text(lang: Lang, key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> Option<String> {
    catalog().text(locale(lang), key, args)
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
    text(lang, key, args).unwrap_or_else(|| panic!("文言 {key} がありません"))
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
