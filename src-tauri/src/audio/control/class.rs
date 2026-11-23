//! 入口の種類。上限・受付からの期限・停止の優先・停止より前の受付の断りの判定は、
//! `JobClass`の網羅の`match`のメソッドだけが持つ。入口の名前→種類の表と、要求で種類を決める入口の表、
//! 取得と解放の対の表もここに置く。
use super::{Entry, EntryKind};
use crate::audio::engine_life::Role;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobClass {
    /// `stop_audio`。停止のレーン。`fence`を上げる。
    Stop,
    /// ミュート。停止のレーン。`fence`は上げない。
    Mute,
    /// モード VST の定期の更新。
    Tick,
    /// 取ったものを返す・止める・取り消す。断らない。
    Release,
    /// 開始・再起動・設定の適用・VST の読み込み・音を出す操作。停止より前の受付は断る。
    Starting,
    /// 読み取り・取得・設定の保存など、上のどれでもないもの。
    Normal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Lane {
    Stop,
    Regular,
}

impl JobClass {
    /// 上限の数に入るか。
    pub(super) const fn counted(self) -> bool {
        match self {
            Self::Starting | Self::Normal => true,
            Self::Stop | Self::Mute | Self::Tick | Self::Release => false,
        }
    }

    /// 受付からの期限付きの待ちと取り消しの対象か。
    pub(super) const fn waits_with_deadline(self) -> bool {
        match self {
            Self::Starting | Self::Normal => true,
            Self::Stop | Self::Mute | Self::Tick | Self::Release => false,
        }
    }

    /// 停止より前に受け付けたものを取り出す時に断るか。
    pub(super) const fn refused_after_stop(self) -> bool {
        match self {
            Self::Starting => true,
            Self::Stop | Self::Mute | Self::Tick | Self::Release | Self::Normal => false,
        }
    }

    pub(super) const fn lane(self) -> Lane {
        match self {
            Self::Stop | Self::Mute => Lane::Stop,
            Self::Tick | Self::Release | Self::Starting | Self::Normal => Lane::Regular,
        }
    }

    pub(super) const fn raises_fence(self) -> bool {
        match self {
            Self::Stop => true,
            Self::Mute | Self::Tick | Self::Release | Self::Starting | Self::Normal => false,
        }
    }
}

/// 子を起動しうる役割。`JobClass`とは別の属性で、窓の間に保留するかを決める。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Launch {
    /// 子を起動しない。保留しない。
    None,
    /// 主の子だけを起動しうる。
    Primary,
    /// 配信ミックスの子だけを起動しうる。
    PostMix,
    /// 両方を起動しうる。
    Both,
}

impl Launch {
    /// 起動しうる子の役割。窓の判定はこれだけを見る。
    pub(super) const fn roles(self) -> &'static [Role] {
        match self {
            Self::None => &[],
            Self::Primary => &[Role::Primary],
            Self::PostMix => &[Role::PostMix],
            Self::Both => &[Role::Primary, Role::PostMix],
        }
    }
}

/// 入口の種類。`Entry::class`の指定を優先し、次に入口の種類、最後に名前で決める。未知の名前は Starting。
pub(crate) fn class_of(entry: Entry) -> JobClass {
    if let Some(class) = entry.class {
        return class;
    }
    match entry.kind {
        EntryKind::Scheduler => JobClass::Tick,
        EntryKind::Tray => JobClass::Mute,
        EntryKind::Command
        | EntryKind::Bundle
        | EntryKind::Startup
        | EntryKind::Warmup
        | EntryKind::Shortcut
        | EntryKind::Update
        | EntryKind::Migration
        | EntryKind::TemporarySession
        | EntryKind::Obs
        | EntryKind::Quit => class_of_name(entry.name),
    }
}

fn class_of_name(name: &str) -> JobClass {
    NAME_CLASSES
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .map_or(JobClass::Starting, |(_, class)| *class)
}

/// 名前で種類が決まる入口。要求で決める入口（`REQUEST_ENTRIES`）の既定は Normal。
pub(crate) const NAME_CLASSES: &[(&str, JobClass)] = &[
    ("stop_audio", JobClass::Stop),
    ("toggle_global_mute", JobClass::Mute),
    ("set_global_mute", JobClass::Mute),
    ("mute_toggle", JobClass::Mute),
    ("global_shortcut_mute", JobClass::Mute),
    ("poll_mode_vst", JobClass::Tick),
    ("cancel_device_scan", JobClass::Release),
    ("cancel_noise_learning", JobClass::Release),
    ("stop_test_tone", JobClass::Release),
    ("cancel_round_trip_measurement", JobClass::Release),
    ("stop_voice_check", JobClass::Release),
    ("stop_voice_check_playback", JobClass::Release),
    ("end_live_changes", JobClass::Release),
    ("end_live_changes_bundle", JobClass::Release),
    ("finish_update_attempt", JobClass::Release),
    ("stop", JobClass::Release),
    ("start_audio", JobClass::Starting),
    ("restart_audio_engine", JobClass::Starting),
    ("restore_plugin", JobClass::Starting),
    ("load_plugin", JobClass::Starting),
    ("reorder_plugins", JobClass::Starting),
    ("set_bypass", JobClass::Starting),
    ("set_mute", JobClass::Starting),
    ("resume_plugin", JobClass::Starting),
    ("set_gain", JobClass::Starting),
    ("open_editor", JobClass::Starting),
    ("set_plugin_state", JobClass::Starting),
    ("set_input_gain", JobClass::Starting),
    ("set_output_gain", JobClass::Starting),
    ("set_noise_reduction", JobClass::Starting),
    ("start_noise_learning", JobClass::Starting),
    ("set_noise_control_config", JobClass::Starting),
    ("set_built_in_effects", JobClass::Starting),
    ("set_global_bypass", JobClass::Starting),
    ("set_input_channels", JobClass::Starting),
    ("set_channel_scan", JobClass::Normal),
    ("play_test_tone", JobClass::Starting),
    ("measure_round_trip", JobClass::Starting),
    ("probe_loopback", JobClass::Starting),
    ("apply_profile", JobClass::Starting),
    ("restore_backup_profile", JobClass::Starting),
    ("apply_owned", JobClass::Starting),
    ("undo_owned", JobClass::Starting),
    ("start_voice_check", JobClass::Starting),
    ("play_voice_check", JobClass::Starting),
    ("warmup", JobClass::Starting),
    ("play", JobClass::Starting),
    ("global_shortcut", JobClass::Starting),
    ("post_mix", JobClass::Normal),
    ("mixing", JobClass::Normal),
    ("live_modes", JobClass::Normal),
    ("session_rack", JobClass::Normal),
    ("builtin_effects", JobClass::Normal),
    ("auto_gain", JobClass::Normal),
    ("voice_check_preview", JobClass::Normal),
    ("audio_frontend_bootstrap", JobClass::Normal),
    ("live_output", JobClass::Normal),
    ("set_loudness_measurement", JobClass::Normal),
    ("get_output_gain_observation", JobClass::Normal),
    ("get_saved_audio_config", JobClass::Normal),
    ("get_audio_state", JobClass::Normal),
    ("get_engine_tuning_config", JobClass::Normal),
    ("set_engine_tuning_config", JobClass::Normal),
    ("get_engine_runtime_stats", JobClass::Normal),
    ("remove_plugin", JobClass::Normal),
    ("get_plugin_state", JobClass::Normal),
    ("get_round_trip_measurement", JobClass::Normal),
    ("get_routing_diagnostics", JobClass::Normal),
    ("preflight_live_changes", JobClass::Normal),
    ("begin_live_changes", JobClass::Normal),
    ("begin_live_changes_bundle", JobClass::Normal),
    ("enumerate_devices_async", JobClass::Normal),
    ("validate_checked", JobClass::Normal),
    ("capture_async", JobClass::Normal),
    ("broadcast_bundle", JobClass::Normal),
    ("snapshot_conditions", JobClass::Normal),
    ("save_profile", JobClass::Normal),
    ("export_voice_check_wav", JobClass::Normal),
    ("export_voice_check", JobClass::Normal),
    ("analyze_voice_check", JobClass::Normal),
    ("get_process_input_sources", JobClass::Normal),
    ("peak_protection", JobClass::Normal),
    ("broadcast_true_peak", JobClass::Normal),
    ("noise_measurement", JobClass::Normal),
    ("set_event_emitter", JobClass::Normal),
    ("quit_app", JobClass::Normal),
    ("prepare_update", JobClass::Normal),
    ("apply_migration", JobClass::Normal),
    ("acknowledge_session_review", JobClass::Normal),
    ("switch_session", JobClass::Normal),
];

/// 1つの名前が複数の用途を兼ねるため、要求の中身で種類を決める入口（`Entry::class`で渡す）。
#[cfg(test)]
pub(crate) const REQUEST_ENTRIES: &[&str] = &[
    "post_mix",
    "mixing",
    "live_modes",
    "session_rack",
    "builtin_effects",
    "auto_gain",
    "noise_measurement",
    "voice_check_preview",
    "audio_frontend_bootstrap",
    "peak_protection",
    "broadcast_true_peak",
    "live_output",
    "set_loudness_measurement",
    "set_channel_scan",
];

/// 要求の変種ごとの種類。`request_class`の関数は変種の名前を返すだけで、種類はこの表で決まる。
pub(crate) struct RequestClass {
    pub(crate) entry: &'static str,
    pub(crate) variant: &'static str,
    pub(crate) class: JobClass,
}

const fn rc(entry: &'static str, variant: &'static str, class: JobClass) -> RequestClass {
    RequestClass {
        entry,
        variant,
        class,
    }
}

pub(crate) const REQUEST_CLASSES: &[RequestClass] = &[
    rc("post_mix", "Snapshot", JobClass::Normal),
    rc("post_mix", "Enable", JobClass::Normal),
    rc("post_mix", "RestoreSaved", JobClass::Starting),
    rc("post_mix", "Add", JobClass::Starting),
    rc("post_mix", "Remove", JobClass::Normal),
    rc("post_mix", "Reorder", JobClass::Normal),
    rc("post_mix", "Bypass", JobClass::Normal),
    rc("post_mix", "Mute", JobClass::Normal),
    rc("post_mix", "Gain", JobClass::Normal),
    rc("post_mix", "Editor", JobClass::Normal),
    rc("post_mix", "Save", JobClass::Normal),
    rc("post_mix", "Reload", JobClass::Normal),
    rc("post_mix", "Reset", JobClass::Normal),
    rc("mixing", "Snapshot", JobClass::Normal),
    rc("mixing", "Configure", JobClass::Starting),
    rc("mixing", "Levels", JobClass::Normal),
    rc("mixing", "Reload", JobClass::Normal),
    rc("mixing", "Reset", JobClass::Normal),
    rc("live_modes", "Snapshot", JobClass::Normal),
    rc("live_modes", "Save", JobClass::Normal),
    rc("live_modes", "BindProfile", JobClass::Normal),
    rc("live_modes", "Recover", JobClass::Starting),
    rc("live_modes", "SingingOn", JobClass::Starting),
    rc("live_modes", "TalkOn", JobClass::Starting),
    rc("live_modes", "Arm", JobClass::Starting),
    rc("live_modes", "Disarm", JobClass::Release),
    rc("session_rack", "Snapshot", JobClass::Normal),
    rc("session_rack", "Retain", JobClass::Normal),
    rc("session_rack", "Begin", JobClass::Starting),
    rc("session_rack", "Add", JobClass::Normal),
    rc("session_rack", "Finish", JobClass::Release),
    rc("builtin_effects", "Snapshot", JobClass::Normal),
    rc("builtin_effects", "Apply", JobClass::Starting),
    rc("builtin_effects", "ApplyProposal", JobClass::Starting),
    rc("builtin_effects", "Undo", JobClass::Starting),
    rc("builtin_effects", "Redo", JobClass::Starting),
    rc("auto_gain", "Status", JobClass::Normal),
    rc("auto_gain", "Devices", JobClass::Normal),
    rc("auto_gain", "Initialize", JobClass::Starting),
    rc("auto_gain", "Begin", JobClass::Starting),
    rc("auto_gain", "Cancel", JobClass::Release),
    rc("auto_gain", "Preview", JobClass::Starting),
    rc("auto_gain", "StopPreview", JobClass::Release),
    rc("auto_gain", "Apply", JobClass::Starting),
    rc("auto_gain", "UndoHistory", JobClass::Starting),
    rc("auto_gain", "RedoHistory", JobClass::Starting),
    rc("auto_gain", "Restore", JobClass::Starting),
    rc("noise_measurement", "Snapshot", JobClass::Normal),
    rc("noise_measurement", "Start", JobClass::Starting),
    rc("noise_measurement", "Cancel", JobClass::Release),
    rc("noise_measurement", "Invalidate", JobClass::Release),
    rc("noise_measurement", "Approve", JobClass::Normal),
    rc("voice_check_preview", "Open", JobClass::Normal),
    rc("voice_check_preview", "Status", JobClass::Normal),
    rc("voice_check_preview", "HistoryStatus", JobClass::Normal),
    rc("voice_check_preview", "Devices", JobClass::Normal),
    rc("voice_check_preview", "Start", JobClass::Starting),
    rc("voice_check_preview", "Update", JobClass::Starting),
    rc("voice_check_preview", "PrepareNoise", JobClass::Starting),
    rc("voice_check_preview", "ApplyNoise", JobClass::Starting),
    rc("voice_check_preview", "UndoNoise", JobClass::Starting),
    rc("voice_check_preview", "RedoNoise", JobClass::Starting),
    rc(
        "voice_check_preview",
        "PrepareCandidate",
        JobClass::Starting,
    ),
    rc("voice_check_preview", "PrepareProposal", JobClass::Starting),
    rc("voice_check_preview", "CandidateStatus", JobClass::Normal),
    rc("voice_check_preview", "CancelCandidate", JobClass::Release),
    rc("voice_check_preview", "Stop", JobClass::Release),
    rc("voice_check_preview", "Close", JobClass::Release),
    rc("audio_frontend_bootstrap", "WithConfig", JobClass::Starting),
    rc(
        "audio_frontend_bootstrap",
        "WithoutConfig",
        JobClass::Normal,
    ),
    rc("peak_protection", "None", JobClass::Normal),
    rc("peak_protection", "Some", JobClass::Starting),
    rc("broadcast_true_peak", "None", JobClass::Normal),
    rc("broadcast_true_peak", "Some", JobClass::Starting),
    rc("live_output", "None", JobClass::Normal),
    rc("live_output", "Some", JobClass::Starting),
    rc("set_channel_scan", "True", JobClass::Starting),
    rc("set_channel_scan", "False", JobClass::Release),
    rc("set_loudness_measurement", "None", JobClass::Release),
    rc("set_loudness_measurement", "Some", JobClass::Starting),
];

/// 要求の変種の、種類と子を起動しうる役割。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RequestKind {
    pub(super) class: JobClass,
    pub(super) launch: Launch,
}

pub(crate) fn request_kind(entry: &str, variant: &str) -> RequestKind {
    RequestKind {
        class: request_class(entry, variant),
        launch: request_launch(entry, variant),
    }
}

/// 要求の変種の種類。表に無い（要求を足して表を直し忘れた）ときは、停止の後に実行する側へ倒さない。
pub(crate) fn request_class(entry: &str, variant: &str) -> JobClass {
    REQUEST_CLASSES
        .iter()
        .find(|row| row.entry == entry && row.variant == variant)
        .map_or(JobClass::Starting, |row| row.class)
}

/// 取得と解放の対（入口の名前の単位）。解放は Release。取得を通したものは必ず解放できる。
#[cfg(test)]
pub(crate) const NAME_PAIRS: &[(&str, &str)] = &[
    ("begin_live_changes", "end_live_changes"),
    ("begin_live_changes_bundle", "end_live_changes_bundle"),
    ("prepare_update", "finish_update_attempt"),
    ("enumerate_devices_async", "cancel_device_scan"),
    ("start_noise_learning", "cancel_noise_learning"),
    ("play_test_tone", "stop_test_tone"),
    ("measure_round_trip", "cancel_round_trip_measurement"),
    ("start_voice_check", "stop_voice_check"),
    ("play_voice_check", "stop_voice_check_playback"),
    ("play", "stop"),
];

/// 取得と解放の対（要求の変種の単位）。`(入口, 取得の変種, 解放の変種)`。
#[cfg(test)]
pub(crate) const REQUEST_PAIRS: &[(&str, &str, &str)] = &[
    ("auto_gain", "Begin", "Cancel"),
    ("auto_gain", "Preview", "StopPreview"),
    ("voice_check_preview", "Start", "Stop"),
    ("voice_check_preview", "Start", "Close"),
    ("voice_check_preview", "PrepareNoise", "CancelCandidate"),
    ("voice_check_preview", "PrepareCandidate", "CancelCandidate"),
    ("voice_check_preview", "PrepareProposal", "CancelCandidate"),
    ("noise_measurement", "Start", "Cancel"),
    ("set_loudness_measurement", "Some", "None"),
    ("set_channel_scan", "True", "False"),
    ("noise_measurement", "Start", "Invalidate"),
    ("session_rack", "Begin", "Finish"),
    ("live_modes", "Arm", "Disarm"),
];

/// 入口の名前→子を起動しうる役割。要求で決める入口（`REQUEST_ENTRIES`）の既定は、要求の表（`REQUEST_LAUNCH`）が決める。
/// 未知の名前は Both。
pub(crate) const NAME_LAUNCH: &[(&str, Launch)] = &[
    ("stop_audio", Launch::None),
    ("toggle_global_mute", Launch::Primary),
    ("set_global_mute", Launch::Primary),
    ("mute_toggle", Launch::Primary),
    ("global_shortcut_mute", Launch::Primary),
    ("poll_mode_vst", Launch::None),
    ("cancel_device_scan", Launch::Primary),
    ("cancel_noise_learning", Launch::Primary),
    ("stop_test_tone", Launch::Primary),
    ("cancel_round_trip_measurement", Launch::Primary),
    ("stop_voice_check", Launch::Primary),
    ("stop_voice_check_playback", Launch::Primary),
    ("end_live_changes", Launch::None),
    ("end_live_changes_bundle", Launch::None),
    ("finish_update_attempt", Launch::None),
    ("stop", Launch::Primary),
    ("start_audio", Launch::Primary),
    ("restart_audio_engine", Launch::Primary),
    ("restore_plugin", Launch::Primary),
    ("load_plugin", Launch::Primary),
    ("reorder_plugins", Launch::Primary),
    ("set_bypass", Launch::Primary),
    ("set_mute", Launch::Primary),
    ("resume_plugin", Launch::Primary),
    ("set_gain", Launch::Primary),
    ("open_editor", Launch::Primary),
    ("set_plugin_state", Launch::Primary),
    ("set_input_gain", Launch::Primary),
    ("set_output_gain", Launch::Primary),
    ("set_noise_reduction", Launch::Primary),
    ("start_noise_learning", Launch::Primary),
    ("set_noise_control_config", Launch::Primary),
    ("set_built_in_effects", Launch::Primary),
    ("set_global_bypass", Launch::Primary),
    ("set_input_channels", Launch::Primary),
    ("set_channel_scan", Launch::Primary),
    ("play_test_tone", Launch::Primary),
    ("measure_round_trip", Launch::Primary),
    ("probe_loopback", Launch::Primary),
    ("apply_profile", Launch::Both),
    ("restore_backup_profile", Launch::Both),
    ("apply_owned", Launch::Both),
    ("undo_owned", Launch::Both),
    ("start_voice_check", Launch::Primary),
    ("play_voice_check", Launch::Primary),
    ("warmup", Launch::Primary),
    ("play", Launch::Primary),
    ("global_shortcut", Launch::Both),
    ("post_mix", Launch::PostMix),
    ("mixing", Launch::Primary),
    ("live_modes", Launch::Primary),
    ("session_rack", Launch::Both),
    ("builtin_effects", Launch::Both),
    ("auto_gain", Launch::Both),
    ("voice_check_preview", Launch::Both),
    ("audio_frontend_bootstrap", Launch::Primary),
    ("live_output", Launch::Both),
    ("set_loudness_measurement", Launch::Both),
    ("get_output_gain_observation", Launch::None),
    ("get_saved_audio_config", Launch::None),
    ("get_audio_state", Launch::None),
    ("get_engine_tuning_config", Launch::None),
    ("set_engine_tuning_config", Launch::None),
    ("get_engine_runtime_stats", Launch::None),
    ("remove_plugin", Launch::None),
    ("get_plugin_state", Launch::None),
    ("get_round_trip_measurement", Launch::Primary),
    ("get_routing_diagnostics", Launch::None),
    ("preflight_live_changes", Launch::None),
    ("begin_live_changes", Launch::None),
    ("begin_live_changes_bundle", Launch::None),
    ("enumerate_devices_async", Launch::Primary),
    ("validate_checked", Launch::None),
    ("capture_async", Launch::None),
    ("broadcast_bundle", Launch::None),
    ("snapshot_conditions", Launch::None),
    ("save_profile", Launch::None),
    ("export_voice_check_wav", Launch::Primary),
    ("export_voice_check", Launch::Primary),
    ("analyze_voice_check", Launch::Primary),
    ("get_process_input_sources", Launch::None),
    ("peak_protection", Launch::None),
    ("broadcast_true_peak", Launch::None),
    ("noise_measurement", Launch::None),
    ("set_event_emitter", Launch::None),
    ("quit_app", Launch::None),
    ("prepare_update", Launch::None),
    ("apply_migration", Launch::None),
    ("acknowledge_session_review", Launch::None),
    ("switch_session", Launch::None),
];

/// 要求で決める入口の、要求の変種を問わない既定。
pub(crate) const REQUEST_LAUNCH_DEFAULT: &[(&str, Launch)] = &[
    ("post_mix", Launch::PostMix),
    ("mixing", Launch::Primary),
    ("live_modes", Launch::Primary),
    ("session_rack", Launch::Primary),
    ("builtin_effects", Launch::Primary),
    ("auto_gain", Launch::Primary),
    ("noise_measurement", Launch::None),
    ("voice_check_preview", Launch::Primary),
    ("audio_frontend_bootstrap", Launch::Primary),
    ("peak_protection", Launch::None),
    ("broadcast_true_peak", Launch::None),
    ("live_output", Launch::Primary),
    ("set_loudness_measurement", Launch::Primary),
    ("set_channel_scan", Launch::Primary),
];

/// 既定と違う要求の変種。
pub(crate) const REQUEST_LAUNCH: &[(&str, &str, Launch)] = &[
    ("post_mix", "Snapshot", Launch::None),
    ("mixing", "Snapshot", Launch::None),
    ("session_rack", "Snapshot", Launch::None),
    ("session_rack", "Retain", Launch::None),
];

/// 要求の変種の、子を起動しうる役割。表に無い入口は Both。
pub(crate) fn request_launch(entry: &str, variant: &str) -> Launch {
    REQUEST_LAUNCH
        .iter()
        .find(|(name, candidate, _)| *name == entry && *candidate == variant)
        .map(|(_, _, launch)| *launch)
        .or_else(|| {
            REQUEST_LAUNCH_DEFAULT
                .iter()
                .find(|(name, _)| *name == entry)
                .map(|(_, launch)| *launch)
        })
        .unwrap_or(Launch::Both)
}

/// 入口の起動しうる役割。`Entry::launch`の指定を優先し、次に入口の種類（定期の更新は起動しない）、最後に名前で決める。
pub(crate) fn launch_of(entry: Entry) -> Launch {
    if let Some(launch) = entry.launch {
        return launch;
    }
    match entry.kind {
        EntryKind::Scheduler => Launch::None,
        EntryKind::Tray
        | EntryKind::Command
        | EntryKind::Bundle
        | EntryKind::Startup
        | EntryKind::Warmup
        | EntryKind::Shortcut
        | EntryKind::Update
        | EntryKind::Migration
        | EntryKind::TemporarySession
        | EntryKind::Obs
        | EntryKind::Quit => NAME_LAUNCH
            .iter()
            .find(|(candidate, _)| *candidate == entry.name)
            .map_or(Launch::Both, |(_, launch)| *launch),
    }
}

/// 実行の時間の警告を出す長さ。開始・再起動は、起動と確認の分だけ長い。
pub(super) fn is_start_request(entry: Entry) -> bool {
    matches!(entry.name, "start_audio" | "restart_audio_engine")
}
