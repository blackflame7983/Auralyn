//! 命令の種類ごとの応答の期限（J-23・J-25）。
//!
//! 分類の根拠は docs/plans/audio-session-f1b0a2-design.md の付録。`match` は `_` を使わず、
//! 命令や要求を足すと、分類の漏れがコンパイルで分かる。
use crate::audio_engine::{
    auto_gain, builtin, core::noise_learning, live_modes, mixing, mode_silence, split_monitor,
};
use crate::ipc::Command;
use std::time::Duration;

/// A：メモリ・実行中の列への投入・状態の読み取りだけで応答する命令。
pub(super) const A: Duration = Duration::from_secs(10);
/// B：VST・音声機器・共有メモリ・ファイルをその場で扱いうる命令（試聴の破棄の前処理を含む）。
pub(super) const B: Duration = Duration::from_secs(30);
/// C：録音の時間に上乗せする余裕。
const PROBE_MARGIN: Duration = Duration::from_secs(10);
/// `ProbeLoopback` の録音の時間の上限。
pub(super) const PROBE_MAX_MS: u32 = 10_000;

pub(super) fn probe_duration_ms(requested: u32) -> u32 {
    requested.min(PROBE_MAX_MS)
}

pub(super) fn reply_deadline(command: &Command) -> Duration {
    match command {
        Command::ProcessingState
        | Command::PostMixStatus
        | Command::GetPluginRack
        | Command::GetDevices
        | Command::ConfigureLiveModes { .. }
        | Command::BeginDeviceScan
        | Command::PollDeviceScan { .. }
        | Command::CancelDeviceScan { .. }
        | Command::StartIdentityCapability
        | Command::ProcessInputCapability
        | Command::SetLoudnessMeasurement { .. }
        | Command::SetChannelScan { .. }
        | Command::GetFrameTimingTrace { .. }
        | Command::StopVoiceCheckRecording
        | Command::StopVoiceCheckPlayback => A,
        Command::ModeMonitor { request } => match request {
            split_monitor::Request::Snapshot | split_monitor::Request::Restore { .. } => A,
        },
        Command::ModeSilence { request } => match request {
            mode_silence::Request::Snapshot { .. } | mode_silence::Request::Finish { .. } => A,
            mode_silence::Request::Begin { .. } => B,
        },
        Command::LiveMode { request } => match request {
            live_modes::Request::Snapshot
            | live_modes::Request::Save { .. }
            | live_modes::Request::BindProfile { .. }
            | live_modes::Request::Recover { .. }
            | live_modes::Request::Arm { .. }
            | live_modes::Request::Disarm { .. } => A,
            live_modes::Request::SingingOn { .. } | live_modes::Request::TalkOn { .. } => B,
        },
        Command::Mixing { request } => match request {
            mixing::Request::Snapshot => A,
            mixing::Request::Configure { .. } | mixing::Request::Levels { .. } => B,
        },
        Command::NoiseMeasurement { request } => match request {
            noise_learning::Request::Snapshot => A,
            noise_learning::Request::Start { .. }
            | noise_learning::Request::Cancel { .. }
            | noise_learning::Request::Invalidate
            | noise_learning::Request::Approve { .. } => B,
        },
        Command::BuiltinEffects { request } => match request {
            builtin::Request::Snapshot => A,
            builtin::Request::Apply { .. }
            | builtin::Request::ApplyProposal { .. }
            | builtin::Request::Undo { .. }
            | builtin::Request::Redo { .. } => B,
        },
        Command::LiveOutput { config } => match config {
            None => A,
            Some(_) => B,
        },
        Command::PeakProtection { config } => match config {
            None => A,
            Some(_) => B,
        },
        Command::BroadcastTruePeak { config } => match config {
            None => A,
            Some(_) => B,
        },
        Command::AutoGain { request } => match request {
            auto_gain::Request::Status
            | auto_gain::Request::Initialize { .. }
            | auto_gain::Request::Devices
            | auto_gain::Request::Begin { .. }
            | auto_gain::Request::Cancel
            | auto_gain::Request::Preview { .. }
            | auto_gain::Request::StopPreview
            | auto_gain::Request::Apply { .. }
            | auto_gain::Request::UndoHistory { .. }
            | auto_gain::Request::RedoHistory { .. }
            | auto_gain::Request::Restore { .. } => B,
        },
        Command::CaptureMixingBundleState
        | Command::PostMixPrepare { .. }
        | Command::PostMixClear
        | Command::PostMixStart { .. }
        | Command::RestoreSessionPlugin { .. }
        | Command::Start { .. }
        | Command::Stop
        | Command::LoadPlugin { .. }
        | Command::RestorePlugin { .. }
        | Command::UnloadPlugin { .. }
        | Command::ReorderPlugins { .. }
        | Command::OpenEditor { .. }
        | Command::SetBypass { .. }
        | Command::SetMute { .. }
        | Command::SetGain { .. }
        | Command::ResumePlugin { .. }
        | Command::SetGlobalMute { .. }
        | Command::SetInputGain { .. }
        | Command::SetNoiseReduction { .. }
        | Command::StartNoiseLearning { .. }
        | Command::CancelNoiseLearning
        | Command::SetNoiseControlConfig { .. }
        | Command::SetBuiltInEffects { .. }
        | Command::SetOutputGain { .. }
        | Command::SetGlobalBypass { .. }
        | Command::SetInputChannels { .. }
        | Command::GetRuntimeStats
        | Command::GetPluginState { .. }
        | Command::CaptureBundleState
        | Command::SetPluginState { .. }
        | Command::StartVoiceCheckRecording { .. }
        | Command::PlayVoiceCheck { .. }
        | Command::VoiceCheckPreview { .. }
        | Command::ExportVoiceCheck { .. }
        | Command::PlayTestTone { .. }
        | Command::StopTestTone
        | Command::MeasureRoundTrip { .. }
        | Command::CancelMeasurement
        | Command::GetRoundTripMeasurement => B,
        Command::ProbeLoopback { duration_ms, .. } => {
            Duration::from_millis(u64::from(probe_duration_ms(*duration_ms))) + PROBE_MARGIN
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_deadline(command: Command, expected: Duration) {
        assert_eq!(reply_deadline(&command), expected, "{command:?}");
    }

    // T5：代表の命令で、A 10秒・B 30秒・C 録音の時間＋10秒。
    #[test]
    fn t5_representative_commands_get_their_class_deadline() {
        for command in [
            Command::ProcessingState,
            Command::PostMixStatus,
            Command::GetDevices,
            Command::StartIdentityCapability,
            Command::PollDeviceScan { token: 1 },
            Command::GetPluginRack,
        ] {
            assert_deadline(command, Duration::from_secs(10));
        }
        for command in [
            Command::Start {
                input_source: None,
                host: String::new(),
                input: None,
                output: None,
                input_id: None,
                output_id: None,
                buffer_size: None,
                sample_rate: None,
                initial_controls: None,
                channel_routing: None,
            },
            Command::Stop,
            Command::GetPluginState { id: String::new() },
            Command::PostMixClear,
            Command::SetInputGain { value: 1.0 },
            Command::SetOutputGain { value: 1.0 },
            Command::SetGlobalMute { active: true },
            Command::SetMute {
                id: String::new(),
                active: true,
            },
            Command::AutoGain {
                request: auto_gain::Request::Status,
            },
            Command::GetRuntimeStats,
        ] {
            assert_deadline(command, Duration::from_secs(30));
        }
        assert_deadline(
            Command::ProbeLoopback {
                input_device: String::new(),
                duration_ms: 1500,
                freq_hz: 1000.0,
            },
            Duration::from_millis(11_500),
        );
    }

    // T5：要求の中身で分かれる命令。読み取りだけの要求は A、それ以外は B。
    #[test]
    fn t5_requests_split_by_their_content() {
        assert_deadline(
            Command::Mixing {
                request: mixing::Request::Snapshot,
            },
            A,
        );
        assert_deadline(
            Command::Mixing {
                request: mixing::Request::Levels {
                    expected_epoch: String::new(),
                    expected_revision: String::new(),
                    levels: serde_json::from_value(serde_json::json!({
                        "voice": { "gain": 1.0, "muted": false },
                        "accompaniment": { "gain": 1.0, "muted": false },
                        "monitorAccompaniment": true,
                        "offsetMs": 0
                    }))
                    .unwrap(),
                },
            },
            B,
        );
        assert_deadline(
            Command::BuiltinEffects {
                request: builtin::Request::Snapshot,
            },
            A,
        );
        assert_deadline(
            Command::NoiseMeasurement {
                request: noise_learning::Request::Snapshot,
            },
            A,
        );
        assert_deadline(
            Command::NoiseMeasurement {
                request: noise_learning::Request::Invalidate,
            },
            B,
        );
        assert_deadline(Command::LiveOutput { config: None }, A);
        assert_deadline(Command::PeakProtection { config: None }, A);
        assert_deadline(Command::BroadcastTruePeak { config: None }, A);
        for (request, expected) in [
            (mode_silence::Request::Snapshot { id: "x".into() }, A),
            (mode_silence::Request::Finish { id: "x".into() }, A),
            (mode_silence::Request::Begin { id: "x".into() }, B),
        ] {
            assert_deadline(Command::ModeSilence { request }, expected);
        }
        assert_deadline(
            Command::ModeMonitor {
                request: split_monitor::Request::Snapshot,
            },
            A,
        );
        assert_deadline(
            Command::LiveMode {
                request: live_modes::Request::Snapshot,
            },
            A,
        );
        assert_deadline(
            Command::LiveMode {
                request: live_modes::Request::Disarm {
                    intent: live_modes::Intent {
                        client_id: String::new(),
                        sequence: 0,
                        expected_epoch: String::new(),
                    },
                },
            },
            A,
        );
    }

    // T6：`ProbeLoopback` の録音の時間は10秒までに丸め、期限は丸めた時間＋10秒。
    #[test]
    fn t6_probe_loopback_duration_is_clamped_to_ten_seconds() {
        assert_eq!(probe_duration_ms(1500), 1500);
        assert_eq!(probe_duration_ms(PROBE_MAX_MS), PROBE_MAX_MS);
        assert_eq!(probe_duration_ms(PROBE_MAX_MS + 1), PROBE_MAX_MS);
        assert_eq!(probe_duration_ms(u32::MAX), PROBE_MAX_MS);
        for requested in [PROBE_MAX_MS, u32::MAX] {
            assert_deadline(
                Command::ProbeLoopback {
                    input_device: String::new(),
                    duration_ms: requested,
                    freq_hz: 1000.0,
                },
                Duration::from_secs(20),
            );
        }
    }
}
