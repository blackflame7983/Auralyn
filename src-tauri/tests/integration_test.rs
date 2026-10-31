mod common;

use common::EngineProcess;
use std::{thread, time::Duration};
use vst_host_lib::ipc::{Command, Response};

fn start(host: &str) -> Command {
    Command::Start {
        host: host.into(),
        input: None,
        output: None,
        input_id: None,
        output_id: None,
        buffer_size: None,
        sample_rate: None,
        initial_controls: None,
    }
}

#[test]
fn sidecar_ipc_smoke_without_audio_device() {
    let mut engine = EngineProcess::spawn();
    let response = engine.request(start("invalid-test-host"));
    assert!(
        matches!(response, Response::Error(ref message) if message == "Unsupported host: invalid-test-host"),
        "unexpected start response: {response:?}"
    );
    assert!(matches!(
        engine.request(Command::ReorderPlugins { order: vec![] }),
        Response::Success
    ));
    assert!(matches!(engine.request(Command::Stop), Response::Success));
    // 停止中を「無音確認済み」とは返さず、Host専用の構成操作もsidecarへ通さない。
    assert!(matches!(
        engine.request(Command::ModeSilence {
            request: vst_host_lib::audio_engine::mode_silence::Request::Begin {
                id: "no-stream".into()
            }
        }),
        Response::Error(_)
    ));
    assert!(matches!(
        engine.request(Command::LiveMode {
            request: vst_host_lib::audio_engine::live_modes::Request::BindProfile {
                expected_version: "1".into(),
                mode: vst_host_lib::audio_engine::live_modes::Mode::Singing,
                name: None
            }
        }),
        Response::Error(_)
    ));
    engine.finish();
}

#[test]
#[ignore = "既定の WASAPI 入出力デバイスによる実機録音が必要"]
fn audio_engine_hardware_recording_lifecycle() {
    let mut engine = EngineProcess::spawn();
    let response = engine.request(start("Wasapi"));
    assert!(
        matches!(response, Response::Started { .. }),
        "audio start failed: {response:?}"
    );
    assert!(matches!(
        engine.request(Command::StartVoiceCheckRecording { max_ms: 2000 }),
        Response::Success
    ));
    thread::sleep(Duration::from_millis(600));
    assert!(matches!(
        engine.request(Command::StopVoiceCheckRecording),
        Response::Success
    ));
    engine.wait_for_recording();
    assert!(matches!(engine.request(Command::Stop), Response::Success));
    engine.finish();
}
