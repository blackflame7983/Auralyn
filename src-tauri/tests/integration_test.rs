mod common;

use common::EngineProcess;
use std::{thread, time::Duration};
use vst_host_lib::ipc::{Command, EngineEvent, Response};

fn start(host: &str) -> Command {
    Command::Start {
        input_source: None,
        host: host.into(),
        input: None,
        output: None,
        input_id: None,
        output_id: None,
        buffer_size: None,
        sample_rate: None,
        initial_controls: None,
        channel_routing: None,
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

fn stopped_generations(events: Vec<EngineEvent>) -> Vec<Option<u64>> {
    events
        .into_iter()
        .filter_map(|event| match event {
            EngineEvent::Stopped {
                stream_generation,
                ended_stream_generation,
            } => {
                // 動いていない状態からの失敗や停止では、終わった音声はない。
                assert_eq!(ended_stream_generation, None);
                Some(stream_generation)
            }
            _ => None,
        })
        .collect()
}

#[test]
fn every_start_attempt_uses_a_new_stream_generation_even_when_it_fails() {
    let mut engine = EngineProcess::spawn();
    assert!(matches!(engine.request(Command::Stop), Response::Success));
    // 一度も開始を試していなければ、停止の通知は番号を持たない。
    assert_eq!(stopped_generations(engine.take_events()), vec![None]);
    for expected in [1, 2] {
        assert!(matches!(
            engine.request(start("invalid-test-host")),
            Response::Error(_)
        ));
        assert_eq!(
            stopped_generations(engine.take_events()),
            vec![Some(expected)]
        );
    }
    // 開始していない後の停止は、最後の試行の番号を名乗る。
    assert!(matches!(engine.request(Command::Stop), Response::Success));
    assert_eq!(stopped_generations(engine.take_events()), vec![Some(2)]);
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
    engine.take_events();
    assert!(matches!(
        engine.request(start("Wasapi")),
        Response::Started { .. }
    ));
    assert!(
        !engine
            .take_events()
            .iter()
            .any(|event| matches!(event, EngineEvent::Stopped { .. })),
        "同じStart内の再設定を利用者の停止として通知してはいけない"
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
