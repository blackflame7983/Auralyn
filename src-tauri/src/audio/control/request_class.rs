//! 要求の中身で種類を決める入口。各関数は要求の変種の名前を網羅の`match`で返し、種類と起動しうる役割は
//! `class::REQUEST_CLASSES`・`class::REQUEST_LAUNCH`の表で決まる。要求を足すとコンパイルが落ち、表の漏れは構造の試験が落とす。
use super::class::{request_kind, RequestKind};
use crate::audio::{frontend_bootstrap, mixing, post_mix};
use crate::audio_engine::voice_check::preview;
use crate::audio_engine::{auto_gain, builtin, core::noise_learning, live_modes};
use crate::ipc::SessionRackRequest;

pub(crate) fn post_mix(request: &post_mix::Request) -> RequestKind {
    use post_mix::Request as R;
    request_kind(
        "post_mix",
        match request {
            R::Snapshot => "Snapshot",
            R::Enable { .. } => "Enable",
            R::RestoreSaved { .. } => "RestoreSaved",
            R::Add { .. } => "Add",
            R::Remove { .. } => "Remove",
            R::Reorder { .. } => "Reorder",
            R::Bypass { .. } => "Bypass",
            R::Mute { .. } => "Mute",
            R::Gain { .. } => "Gain",
            R::Editor { .. } => "Editor",
            R::Save { .. } => "Save",
            R::Reload { .. } => "Reload",
            R::Reset { .. } => "Reset",
        },
    )
}

pub(crate) fn mixing(request: &mixing::Request) -> RequestKind {
    use mixing::Request as R;
    request_kind(
        "mixing",
        match request {
            R::Snapshot => "Snapshot",
            R::Configure { .. } => "Configure",
            R::Levels { .. } => "Levels",
            R::Reload { .. } => "Reload",
            R::Reset { .. } => "Reset",
        },
    )
}

pub(crate) fn live_modes(request: &live_modes::Request) -> RequestKind {
    use live_modes::Request as R;
    request_kind(
        "live_modes",
        match request {
            R::Snapshot => "Snapshot",
            R::Save { .. } => "Save",
            R::BindProfile { .. } => "BindProfile",
            R::Recover { .. } => "Recover",
            R::SingingOn { .. } => "SingingOn",
            R::TalkOn { .. } => "TalkOn",
            R::Arm { .. } => "Arm",
            R::Disarm { .. } => "Disarm",
        },
    )
}

pub(crate) fn session_rack(request: &SessionRackRequest) -> RequestKind {
    use SessionRackRequest as R;
    request_kind(
        "session_rack",
        match request {
            R::Snapshot => "Snapshot",
            R::Retain { .. } => "Retain",
            R::Begin { .. } => "Begin",
            R::Add { .. } => "Add",
            R::Finish { .. } => "Finish",
        },
    )
}

pub(crate) fn builtin_effects(request: &builtin::Request) -> RequestKind {
    use builtin::Request as R;
    request_kind(
        "builtin_effects",
        match request {
            R::Snapshot => "Snapshot",
            R::Apply { .. } => "Apply",
            R::ApplyProposal { .. } => "ApplyProposal",
            R::Undo { .. } => "Undo",
            R::Redo { .. } => "Redo",
        },
    )
}

pub(crate) fn auto_gain(request: &auto_gain::Request) -> RequestKind {
    use auto_gain::Request as R;
    request_kind(
        "auto_gain",
        match request {
            R::Status => "Status",
            R::Devices => "Devices",
            R::Initialize { .. } => "Initialize",
            R::Begin { .. } => "Begin",
            R::Cancel => "Cancel",
            R::Preview { .. } => "Preview",
            R::StopPreview => "StopPreview",
            R::Apply { .. } => "Apply",
            R::UndoHistory { .. } => "UndoHistory",
            R::RedoHistory { .. } => "RedoHistory",
            R::Restore { .. } => "Restore",
        },
    )
}

pub(crate) fn noise_measurement(request: &noise_learning::Request) -> RequestKind {
    use noise_learning::Request as R;
    request_kind(
        "noise_measurement",
        match request {
            R::Snapshot => "Snapshot",
            R::Start { .. } => "Start",
            R::Cancel { .. } => "Cancel",
            R::Invalidate => "Invalidate",
            R::Approve { .. } => "Approve",
        },
    )
}

pub(crate) fn voice_check_preview(request: &preview::Request) -> RequestKind {
    use preview::Action as A;
    request_kind(
        "voice_check_preview",
        match &request.action {
            A::Open => "Open",
            A::Status => "Status",
            A::HistoryStatus => "HistoryStatus",
            A::Devices => "Devices",
            A::Start { .. } => "Start",
            A::Update { .. } => "Update",
            A::PrepareNoise { .. } => "PrepareNoise",
            A::ApplyNoise { .. } => "ApplyNoise",
            A::UndoNoise { .. } => "UndoNoise",
            A::RedoNoise { .. } => "RedoNoise",
            A::PrepareCandidate { .. } => "PrepareCandidate",
            A::PrepareProposal { .. } => "PrepareProposal",
            A::CandidateStatus { .. } => "CandidateStatus",
            A::CancelCandidate { .. } => "CancelCandidate",
            A::Stop => "Stop",
            A::Close => "Close",
        },
    )
}

/// 自動開始の設定を持つ要求だけが開始を伴う。
pub(crate) fn frontend_bootstrap(request: &frontend_bootstrap::Request) -> RequestKind {
    request_kind(
        "audio_frontend_bootstrap",
        match &request.config {
            Some(config) if !config.host.is_empty() => "WithConfig",
            Some(_) | None => "WithoutConfig",
        },
    )
}

fn option_class<T>(entry: &str, value: &Option<T>) -> RequestKind {
    request_kind(
        entry,
        match value {
            Some(_) => "Some",
            None => "None",
        },
    )
}

pub(crate) fn peak_protection<T>(config: &Option<T>) -> RequestKind {
    option_class("peak_protection", config)
}

pub(crate) fn broadcast_true_peak<T>(config: &Option<T>) -> RequestKind {
    option_class("broadcast_true_peak", config)
}

pub(crate) fn live_output<T>(config: &Option<T>) -> RequestKind {
    option_class("live_output", config)
}

pub(crate) fn set_channel_scan(active: bool) -> RequestKind {
    request_kind("set_channel_scan", if active { "True" } else { "False" })
}

pub(crate) fn set_loudness_measurement(id: &Option<u64>) -> RequestKind {
    option_class("set_loudness_measurement", id)
}
