//! 入口の種類。上限・受付からの期限・停止の優先・停止より前の受付の断りの判定は、
//! `JobClass`の網羅の`match`のメソッドだけが持つ。入口の名前→種類の表と、取得と解放の対の表もここに置く。
use super::{Entry, EntryKind};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobClass {
    /// `stop_audio`。停止のレーン。`fence`を上げる。
    Stop,
    /// ミュート。停止のレーン。`fence`は上げない。
    Mute,
    /// 取ったものを返す・止める・取り消す・モード VST の定期の更新。断らない。
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
    /// 上限の数に入り、受付からの期限付きの待ちと取り消しの対象になるか。
    pub(super) const fn bounded(self) -> bool {
        match self {
            Self::Starting | Self::Normal => true,
            Self::Stop | Self::Mute | Self::Release => false,
        }
    }

    /// 停止より前に受け付けたものを取り出す時に断るか。
    pub(super) const fn refused_after_stop(self) -> bool {
        match self {
            Self::Starting => true,
            Self::Stop | Self::Mute | Self::Release | Self::Normal => false,
        }
    }

    pub(super) const fn lane(self) -> Lane {
        match self {
            Self::Stop | Self::Mute => Lane::Stop,
            Self::Release | Self::Starting | Self::Normal => Lane::Regular,
        }
    }

    pub(super) const fn raises_fence(self) -> bool {
        match self {
            Self::Stop => true,
            Self::Mute | Self::Release | Self::Starting | Self::Normal => false,
        }
    }
}

/// 入口の種類。`Entry::class`の指定を優先し、次に入口の種類、最後に名前で決める。未知の名前は Starting。
pub(crate) fn class_of(entry: Entry) -> JobClass {
    if let Some(class) = entry.class {
        return class;
    }
    match entry.kind {
        EntryKind::Scheduler => JobClass::Release,
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

/// 名前で種類が決まる入口。要求で決める入口（`.class(…)`を付けて呼ぶ）の既定は Normal。
pub(crate) const NAME_CLASSES: &[(&str, JobClass)] = &[
    ("stop_audio", JobClass::Stop),
    ("toggle_global_mute", JobClass::Mute),
    ("set_global_mute", JobClass::Mute),
    ("mute_toggle", JobClass::Mute),
    ("global_shortcut_mute", JobClass::Mute),
    ("poll_mode_vst", JobClass::Release),
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
