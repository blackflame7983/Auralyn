//! 要求の中身で種類を決める入口。各関数は網羅の`match`で要求の変種ごとの種類を返す。要求を足すとコンパイルが落ちる。
use super::class::JobClass::{self, Normal, Release, Starting};
use crate::audio::{frontend_bootstrap, mixing, post_mix};
use crate::audio_engine::voice_check::preview;
use crate::audio_engine::{auto_gain, builtin, core::noise_learning, live_modes};
use crate::ipc::SessionRackRequest;

pub(crate) fn post_mix(request: &post_mix::Request) -> JobClass {
    use post_mix::Request as R;
    match request {
        R::RestoreSaved { .. } | R::Add { .. } => Starting,
        R::Snapshot
        | R::Enable { .. }
        | R::Remove { .. }
        | R::Reorder { .. }
        | R::Bypass { .. }
        | R::Mute { .. }
        | R::Gain { .. }
        | R::Editor { .. }
        | R::Save { .. }
        | R::Reload { .. }
        | R::Reset { .. } => Normal,
    }
}

pub(crate) fn mixing(request: &mixing::Request) -> JobClass {
    use mixing::Request as R;
    match request {
        R::Configure { .. } => Starting,
        R::Snapshot | R::Levels { .. } | R::Reload { .. } | R::Reset { .. } => Normal,
    }
}

pub(crate) fn live_modes(request: &live_modes::Request) -> JobClass {
    use live_modes::Request as R;
    match request {
        R::Recover { .. } | R::SingingOn { .. } | R::TalkOn { .. } | R::Arm { .. } => Starting,
        R::Disarm { .. } => Release,
        R::Snapshot | R::Save { .. } | R::BindProfile { .. } => Normal,
    }
}

pub(crate) fn session_rack(request: &SessionRackRequest) -> JobClass {
    use SessionRackRequest as R;
    match request {
        R::Begin { .. } => Starting,
        R::Finish { .. } => Release,
        R::Snapshot | R::Retain { .. } | R::Add { .. } => Normal,
    }
}

pub(crate) fn builtin_effects(request: &builtin::Request) -> JobClass {
    use builtin::Request as R;
    match request {
        R::Apply { .. } | R::ApplyProposal { .. } | R::Undo { .. } | R::Redo { .. } => Starting,
        R::Snapshot => Normal,
    }
}

pub(crate) fn auto_gain(request: &auto_gain::Request) -> JobClass {
    use auto_gain::Request as R;
    match request {
        R::Initialize { .. }
        | R::Begin { .. }
        | R::Preview { .. }
        | R::Apply { .. }
        | R::UndoHistory { .. }
        | R::RedoHistory { .. }
        | R::Restore { .. } => Starting,
        R::Cancel | R::StopPreview => Release,
        R::Status | R::Devices => Normal,
    }
}

pub(crate) fn noise_measurement(request: &noise_learning::Request) -> JobClass {
    use noise_learning::Request as R;
    match request {
        R::Start { .. } => Starting,
        R::Cancel { .. } | R::Invalidate => Release,
        R::Snapshot | R::Approve { .. } => Normal,
    }
}

pub(crate) fn voice_check_preview(request: &preview::Request) -> JobClass {
    use preview::Action as A;
    match &request.action {
        A::Start { .. }
        | A::Update { .. }
        | A::PrepareNoise { .. }
        | A::ApplyNoise { .. }
        | A::UndoNoise { .. }
        | A::RedoNoise { .. }
        | A::PrepareCandidate { .. }
        | A::PrepareProposal { .. } => Starting,
        A::CancelCandidate { .. } | A::Stop | A::Close => Release,
        A::Open | A::Status | A::HistoryStatus | A::Devices | A::CandidateStatus { .. } => Normal,
    }
}

/// 自動開始の設定を持つ要求だけが開始を伴う。
pub(crate) fn frontend_bootstrap(request: &frontend_bootstrap::Request) -> JobClass {
    match &request.config {
        Some(config) if !config.host.is_empty() => Starting,
        Some(_) | None => Normal,
    }
}

pub(crate) fn peak_protection<T>(config: &Option<T>) -> JobClass {
    if config.is_some() {
        Starting
    } else {
        Normal
    }
}

pub(crate) fn broadcast_true_peak<T>(config: &Option<T>) -> JobClass {
    peak_protection(config)
}

pub(crate) fn live_output<T>(config: &Option<T>) -> JobClass {
    peak_protection(config)
}

pub(crate) fn set_channel_scan(active: bool) -> JobClass {
    if active {
        Starting
    } else {
        Release
    }
}

pub(crate) fn set_loudness_measurement(id: &Option<u64>) -> JobClass {
    if id.is_some() {
        Starting
    } else {
        Release
    }
}
