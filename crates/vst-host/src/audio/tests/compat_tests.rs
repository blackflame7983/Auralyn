//! 旧 API の互換（`9567061a` の振る舞い）の試験。F1a-0：現行の振る舞いを固定するもので、修正前の実装でも通る。
//! 行 ID は docs/plans/audio-session-acceptance.md の K 群と、F1a で固定する行（A・B・C・D 群）。
//! 通知の順序は、実際の読み取りスレッドが`emit`を呼んだ順序（Rust 側の事実）。
use super::compat_support::*;
use super::*;

const CC: &str = "audio-conditions-changed";

fn host(f: &Fixture) -> std::sync::MutexGuard<'_, AudioHost> {
    f.host.lock().unwrap()
}

fn start(host: &mut AudioHost) -> Result<AudioConfig> {
    host.start_with_input_source(
        Some("ASIO".into()),
        None,
        None,
        Some(512),
        Some(48000),
        None,
        None,
        None,
        None,
    )
}

fn names(f: &Fixture) -> Vec<String> {
    f.recorder.names()
}

fn controls() -> crate::ipc::StartControls {
    crate::ipc::StartControls {
        input_gain: 0.5,
        output_gain: 0.25,
        input_channels: [0, 1],
        output_routing: crate::ipc::OutputRouting::default(),
        muted: false,
        bypassed: false,
    }
}

fn routed_started() -> IpcResponse {
    IpcResponse::Started {
        sample_rate: 48000,
        buffer_size: 512,
        routing: Some(controls().routing()),
        input_id: None,
        output_id: None,
        stream_generation: Some(1),
    }
}

// K1・K13：開始の成功。`emit`は、結果を返す前に終わっている。
#[test]
fn k1_k13_start_success_emits_conditions_then_started_before_the_result_returns() {
    let f = Fixture::new([("Start", start_steps(1))]);
    let mut host = host(&f);
    let config = start(&mut host).unwrap();
    assert_eq!(config.stream_generation.as_deref(), Some("1:1"));
    // 起動・ミュート確認・開始の前後の通知。そのあいだに reader が出す2つ（`Started`の通知）。
    assert_eq!(
        names(&f),
        [CC, CC, CC, CC, CC, "audio-started", CC],
        "最後の2つ前の CC と audio-started は reader、残りは AudioHost が出す"
    );
    let started = &f.recorder.events()[5];
    assert_eq!(
        started.1,
        serde_json::json!({"sample_rate": 48000, "buffer_size": 512, "stream_generation": "1:1"})
    );
    assert_eq!(
        f.sent_after_start(),
        ["ConfigureLiveModes", "SetGlobalMute", "Start"]
    );
}

// K13：開始の失敗。`Stopped`が先に出て、そのあとにエラーの応答。
#[test]
fn k13_failed_start_emits_stopped_before_the_error_returns() {
    let f = Fixture::new([(
        "Start",
        vec![
            event_line(&stopped_event(1)),
            error_line("device not found"),
        ],
    )]);
    let mut host = host(&f);
    let error = start(&mut host).unwrap_err().to_string();
    assert_eq!(error, "device not found");
    assert_eq!(names(&f), [CC, CC, CC, CC, CC, "audio-stopped", CC]);
}

// K13・K9b の前提：停止。`Stopped`の通知は応答の前。
#[test]
fn k13_stop_emits_conditions_then_stopped_before_the_result_returns() {
    let f = Fixture::new([("Start", start_steps(1)), ("Stop", stop_steps(1))]);
    let mut host = host(&f);
    start(&mut host).unwrap();
    f.recorder.clear();
    host.stop().unwrap();
    assert_eq!(names(&f), [CC, CC, "audio-stopped", CC]);
}

// D2・D9・K13：異常終了（EOF）。通知3つのあとに、待っている呼び出しが解放される。`is_running`は`true`のまま。
#[test]
fn d2_d9_k13_eof_emits_exit_notifications_before_releasing_the_waiting_call() {
    let f = Fixture::new([("Start", start_steps(1)), ("Stop", vec![Step::Exit])]);
    let mut host = host(&f);
    start(&mut host).unwrap();
    f.recorder.clear();
    let error = host.stop().unwrap_err().to_string();
    assert_eq!(error, "Engine Crashed/Exited");
    let events = f.recorder.events();
    let order: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        order,
        [CC, CC, "audio-engine-exited", "audio-error", CC],
        "reader が CC・audio-engine-exited・audio-error の順に出してから、待ち手が解放される"
    );
    assert_eq!(
        events[3].1,
        serde_json::json!("Audio Engine Process Exited (Crash?)")
    );
    assert!(
        host.get_state().is_running,
        "EOF で死んだ後も、子のハンドルが残るあいだは true"
    );
}

// A13：番号のない`Error`は、接続の現在のストリームの障害として旧の通知に出る。
#[test]
fn a13_unnumbered_stream_error_marks_the_current_connection_not_running() {
    let f = Fixture::new([
        ("Start", start_steps(1)),
        (
            "GetDevices",
            vec![
                event_line(&EngineEvent::Error("Input Stream Error: fixture".into())),
                response_line(&IpcResponse::Success),
            ],
        ),
    ]);
    let mut host = host(&f);
    start(&mut host).unwrap();
    assert!(host.conditions.snapshot().is_ok());
    f.recorder.clear();
    host.execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    assert_eq!(names(&f), [CC, "audio-stream-error"]);
    assert_eq!(
        f.recorder.events()[1].1,
        serde_json::json!("Input Stream Error: fixture")
    );
    assert!(host.conditions.snapshot().is_err());
}

// K6：`Stopped`を出さない`Error`は、`audio-stopped`を出さない。親は範囲外の初期音量を子へ送らない。
// 子の事前の検査が`Stopped`を出さないことは、実際のサイドカーを起動する`tests/audio_engine_start_rejection.rs`で確かめる。
#[test]
fn k6_error_without_stopped_emits_no_audio_stopped_and_parent_rejects_bad_controls() {
    let f = Fixture::new([("Start", vec![error_line("initial controls rejected")])]);
    let mut host = host(&f);
    let error = start(&mut host).unwrap_err().to_string();
    assert_eq!(error, "initial controls rejected");
    assert!(!names(&f).iter().any(|name| name == "audio-stopped"));
    let sent = f.sent().len();
    let mut bad = controls();
    bad.output_gain = 3.0;
    let error = host
        .start_internal_guarded_with_ids(
            Some("ASIO".into()),
            None,
            None,
            Some(512),
            Some(48000),
            Some(bad),
            None,
            None,
            None,
            None,
        )
        .unwrap_err()
        .to_string();
    assert_eq!(error, "初期音量が範囲外です");
    assert_eq!(f.sent().len(), sent, "親は範囲外の初期音量を子へ送らない");
}

// K7：`initial_controls`つきの開始は`SetGlobalMute`を送らず、`Start`の行に初期の制御が載る。
#[test]
fn k7_start_with_initial_controls_sends_no_global_mute_and_carries_controls_in_start() {
    let f = Fixture::new([
        (
            "StartIdentityCapability",
            vec![response_line(&IpcResponse::StartIdentityCapability {
                version: 2,
            })],
        ),
        (
            "Start",
            vec![
                event_line(&started_event(1)),
                response_line(&routed_started()),
            ],
        ),
    ]);
    let mut host = host(&f);
    host.start_internal_guarded_with_ids(
        Some("ASIO".into()),
        None,
        None,
        Some(512),
        Some(48000),
        Some(controls()),
        None,
        None,
        None,
        Some(controls().routing()),
    )
    .unwrap();
    assert_eq!(
        f.sent_after_start(),
        ["ConfigureLiveModes", "StartIdentityCapability", "Start"]
    );
    let start = &f.sent_json_after_start()[2]["payload"];
    assert_eq!(start["initial_controls"]["inputGain"], 0.5);
    assert_eq!(start["initial_controls"]["outputGain"], 0.25);
    assert_eq!(start["initial_controls"]["muted"], false);
}

// K9a：`prepare_update`、子がない。停止せず`maintenance`にして`kill_engine`。通知は`audio-conditions-changed`だけ。
#[test]
fn k9a_prepare_update_without_a_child_only_retires_the_connection() {
    let f = Fixture::new([]);
    let mut host = host(&f);
    host.prepare_update().unwrap();
    assert!(host.maintenance);
    assert_eq!(names(&f), [CC]);
    assert_eq!(f.spawn_count(), 0);
    // K9e：`maintenance`済みでは、もう一度の確認が失敗する。
    let error = host.check_can_interrupt().unwrap_err().to_string();
    assert_eq!(
        error,
        "変更を反映済みです。再起動してから操作してください。"
    );
}

// K9b：子があり`stop()`が成功。`audio-stopped`が出て、`maintenance`と`kill_engine`へ進む。
#[test]
fn k9b_prepare_update_with_a_child_stops_then_retires_the_connection() {
    let f = Fixture::new([
        ("Start", start_steps(1)),
        ("Stop", stop_steps(1)),
        ("AutoGain", vec![auto_gain_status(true, false)]),
    ]);
    let mut host = host(&f);
    start(&mut host).unwrap();
    f.recorder.clear();
    host.prepare_update().unwrap();
    assert!(host.maintenance);
    assert!(host.child.is_none());
    assert_eq!(
        names(&f),
        [CC, CC, "audio-stopped", CC, "live-modes-invalidated", CC],
        "Stop の通知のあと、kill_engine が live-modes-invalidated と CC を出す"
    );
    assert_eq!(&f.sent_after_start()[3..], ["AutoGain", "Stop"]);
}

// K9c：主の`Stop`が失敗。先へ進まず、`maintenance`にならず、主の状態は変わらない。
#[test]
fn k9c_prepare_update_stops_here_when_the_primary_stop_fails() {
    let f = Fixture::new([
        ("Start", start_steps(1)),
        ("Stop", vec![error_line("stop refused")]),
        ("AutoGain", vec![auto_gain_status(true, false)]),
    ]);
    let mut host = host(&f);
    start(&mut host).unwrap();
    f.recorder.clear();
    let error = host.prepare_update().unwrap_err().to_string();
    assert_eq!(error, "stop refused");
    assert!(!host.maintenance);
    assert!(host.child.is_some() && host.link.is_open());
    assert!(!names(&f).iter().any(|name| name == "audio-stopped"));
}

// K9d：主は止まり、配信ミックスだけが失敗。エラーで更新へ進まず、主の音声は止まったまま。
#[test]
fn k9d_prepare_update_leaves_the_primary_stopped_when_only_the_post_mix_stop_fails() {
    let f = Fixture::new([
        ("Start", start_steps(1)),
        ("Stop", stop_steps(1)),
        ("AutoGain", vec![auto_gain_status(true, false)]),
    ]);
    let (mut child, observer) = scripted_parts([("Stop", vec![error_line("post stop refused")])]);
    child.post_role = true;
    child.ensure_engine_running().unwrap();
    let mut host = host(&f);
    host.post_mix.adopt_child_for_test(child);
    start(&mut host).unwrap();
    f.recorder.clear();
    let error = host.prepare_update().unwrap_err().to_string();
    assert_eq!(error, "配信VSTを停止できませんでした");
    assert!(!host.maintenance, "更新へ進まない");
    assert!(
        names(&f).iter().any(|name| name == "audio-stopped"),
        "主の Stop は成功している"
    );
    assert!(
        host.conditions.snapshot().is_err(),
        "主の音声は止まったまま"
    );
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// K9e：録音・試聴中や`maintenance`済みでは、何も止めない。
#[test]
fn k9e_prepare_update_refuses_while_voice_check_is_active_and_stops_nothing() {
    let f = Fixture::new([
        ("Start", start_steps(1)),
        ("AutoGain", vec![auto_gain_status(true, false)]),
    ]);
    let mut host = host(&f);
    start(&mut host).unwrap();
    host.voice_activity.store(true, Ordering::Release);
    let sent = f.sent();
    let error = host.prepare_update().unwrap_err().to_string();
    assert_eq!(
        error,
        "ボイスチェックの録音・試聴を終了してから更新してください。"
    );
    assert_eq!(f.sent(), sent, "何も送らない");
    assert!(!host.maintenance && host.child.is_some());
}

// K15・F12：`IPC:`の行、外側の`kind/data`、`LevelMeter`の`stream_generation`の省略（旧の子）。
#[test]
fn k15_f12_level_meter_lines_parse_with_and_without_stream_generation() {
    let f = Fixture::new([(
        "GetDevices",
        vec![
            raw_line(
                r#"IPC:{"kind":"Event","data":{"type":"LevelMeter","payload":{"input":[0.5,0.25],"output":[0.125,0.0625]}}}"#,
            ),
            raw_line(
                r#"IPC:{"kind":"Event","data":{"type":"LevelMeter","payload":{"input":[0.5,0.25],"output":[0.125,0.0625],"stream_generation":3}}}"#,
            ),
            response_line(&IpcResponse::Success),
        ],
    )]);
    let mut host = host(&f);
    host.ensure_engine_running().unwrap();
    f.recorder.clear();
    host.execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    let events = f.recorder.events();
    assert_eq!(names(&f), ["audio-level", "audio-level"]);
    assert_eq!(
        events[0].1,
        serde_json::json!({"input": [0.5, 0.25], "output": [0.125, 0.0625]}),
        "旧の子：stream_generation を出さない"
    );
    assert_eq!(
        events[1].1,
        serde_json::json!({"input": [0.5, 0.25], "output": [0.125, 0.0625], "stream_generation": "1:3"})
    );
}

// K16：`auto_gain`の`status`は camelCase で、フロントの`getAudioStreamState`が読める。
#[test]
fn k16_auto_gain_status_is_camel_case() {
    let f = Fixture::new([("AutoGain", vec![auto_gain_status(true, false)])]);
    let mut host = host(&f);
    host.ensure_engine_running().unwrap();
    let status = host
        .auto_gain(crate::audio_engine::auto_gain::Request::Status)
        .unwrap();
    let value = serde_json::to_value(&status).unwrap();
    assert_eq!(value["running"], true);
    assert_eq!(value["streamFailed"], false);
    assert!(value.get("confirmedGain").is_some());
    assert!(value.get("stream_failed").is_none());
}

// B15：`stop_audio`（接続なし）。成功し、子を起動せず、`audio-conditions-changed`だけ。
#[test]
fn b15_stop_without_a_connection_never_spawns_and_emits_only_conditions() {
    let f = Fixture::new([]);
    let mut host = host(&f);
    host.stop().unwrap();
    assert_eq!(f.spawn_count(), 0);
    assert_eq!(names(&f), [CC]);
}

// B12：機器 ID の不一致では`Stop`を送り、その結果を無視する。`Stop`が失敗しても、エラーを返し、音声が残りうる。
#[test]
fn b12_device_id_mismatch_sends_stop_ignores_its_failure_and_may_leave_audio_running() {
    let f = Fixture::new([
        (
            "StartIdentityCapability",
            vec![response_line(&IpcResponse::StartIdentityCapability {
                version: 1,
            })],
        ),
        ("Start", start_steps(1)),
        ("Stop", vec![error_line("stop refused")]),
    ]);
    let mut host = host(&f);
    let error = host
        .start_with_input_source(
            Some("ASIO".into()),
            None,
            None,
            Some(512),
            Some(48000),
            None,
            Some("expected-output".into()),
            None,
            None,
        )
        .unwrap_err()
        .to_string();
    assert_eq!(
        error,
        "開始した機器のIDを確認できません。機器を選び直してください"
    );
    assert_eq!(f.sent().last().map(String::as_str), Some("Stop"));
    assert!(
        host.child.is_some(),
        "Stop が拒否されても、清掃や隔離はしない"
    );
    assert!(host.active_config.is_none());
}

// C4：保存の失敗はログだけで、開始は成功を返す。
#[test]
fn c4_persist_failure_does_not_fail_the_start() {
    let f = Fixture::new([("Start", start_steps(1))]);
    std::fs::create_dir(f.last_config_path()).unwrap();
    let mut host = host(&f);
    let config = start(&mut host).unwrap();
    assert_eq!(config.sample_rate, 48000);
    assert!(host.active_config.is_some());
    assert!(f.last_config_path().is_dir());
}

// D3：再起動（`kill_engine`）は`audio-engine-exited`・`audio-error`・`audio-stopped`を出さない。
#[test]
fn d3_kill_engine_before_restart_emits_only_conditions_changed() {
    let f = Fixture::new([("Start", start_steps(1))]);
    let mut host = host(&f);
    start(&mut host).unwrap();
    f.recorder.clear();
    host.kill_engine();
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(names(&f), ["live-modes-invalidated", CC]);
    assert!(
        !names(&f).iter().any(|name| matches!(
            name.as_str(),
            "audio-engine-exited" | "audio-error" | "audio-stopped"
        )),
        "旧の6通知のうち出るのは audio-conditions-changed だけ"
    );
}

// §5：`MixingSourceFailed`・`MixingOutputFailed`は、動いている現行の接続でだけ、`audio-conditions-changed`のあとに旧の通知（ペイロードなし）で転送される。
#[test]
fn mixing_failures_forward_conditions_then_the_legacy_notification_only_while_running() {
    let script = || {
        vec![
            event_line(&EngineEvent::MixingSourceFailed),
            event_line(&EngineEvent::MixingOutputFailed),
            response_line(&IpcResponse::Success),
        ]
    };
    let f = Fixture::new([("Start", start_steps(1)), ("GetDevices", script())]);
    let mut running = host(&f);
    start(&mut running).unwrap();
    f.recorder.clear();
    running
        .execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    let null = serde_json::Value::Null;
    assert_eq!(
        f.recorder.events(),
        [
            (CC.to_owned(), null.clone()),
            ("mixing-source-failed".to_owned(), null.clone()),
            (CC.to_owned(), null.clone()),
            ("mixing-output-failed".to_owned(), null),
        ]
    );
    drop(running);

    let stopped = Fixture::new([("GetDevices", script())]);
    let mut idle = host(&stopped);
    idle.ensure_engine_running().unwrap();
    stopped.recorder.clear();
    idle.execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    assert!(
        names(&stopped).is_empty(),
        "動いていない接続の障害は通知しない"
    );
}

// §5：reader が子の通知をそのまま旧の通知へ転送する。名前とペイロードが契約。
#[test]
fn reader_forwards_the_remaining_legacy_notifications_with_their_names_and_payloads() {
    use crate::audio_engine::loudness::LoudnessReading;
    use crate::audio_engine::processing_watch::{HealthState, StallKind};
    let f = Fixture::new([(
        "GetDevices",
        vec![
            event_line(&EngineEvent::ControlStall {
                command: "LoadPlugin".into(),
                plugin_id: Some("p1".into()),
                module: None,
                elapsed_ms: 1500,
            }),
            event_line(&EngineEvent::Loudness(LoudnessReading {
                id: 7,
                ready: true,
                silent: false,
                supported: true,
                short_term_lufs: Some(-14.5),
                true_peak_dbtp: None,
            })),
            event_line(&EngineEvent::ChannelLevels(vec![0.5, 0.25])),
            event_line(&EngineEvent::VoiceCheckState {
                state: "recording".into(),
                position_ms: 10,
                duration_ms: 2000,
            }),
            event_line(&EngineEvent::VoiceCheckEnvelope {
                raw_peaks: vec![0.5],
                processed_peaks: vec![0.25],
            }),
            event_line(&EngineEvent::EditorOpened { id: "e1".into() }),
            event_line(&EngineEvent::EditorClosed { id: "e1".into() }),
            event_line(&EngineEvent::ProcessingHealth {
                state: HealthState::Stalled,
                kind: Some(StallKind::Processing),
                recent_late: 2,
                recent_underflow: 3,
                window_secs: 60,
            }),
            response_line(&IpcResponse::Success),
        ],
    )]);
    let mut host = host(&f);
    host.ensure_engine_running().unwrap();
    f.recorder.clear();
    host.execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    let expected = [
        (
            "audio-control-stall",
            serde_json::json!({"command": "LoadPlugin", "pluginId": "p1", "module": null, "elapsedMs": 1500}),
        ),
        (
            "audio-loudness",
            serde_json::json!({"id": 7, "ready": true, "silent": false, "supported": true, "short_term_lufs": -14.5, "true_peak_dbtp": null}),
        ),
        ("audio-channel-scan", serde_json::json!([0.5, 0.25])),
        (
            "voice-check-state",
            serde_json::json!({"state": "recording", "position_ms": 10, "duration_ms": 2000}),
        ),
        (
            "voice-check-envelope",
            serde_json::json!({"raw_peaks": [0.5], "processed_peaks": [0.25]}),
        ),
        ("plugin-editor-opened", serde_json::json!({"id": "e1"})),
        ("plugin-editor-closed", serde_json::json!({"id": "e1"})),
        (
            "audio-processing-health",
            serde_json::json!({"state": "stalled", "stallKind": "processing", "recentLate": 2, "recentUnderflow": 3, "windowSecs": 60}),
        ),
    ];
    let actual = f.recorder.events();
    assert_eq!(actual.len(), expected.len(), "{actual:?}");
    for ((name, payload), (expected_name, expected_payload)) in actual.iter().zip(expected) {
        assert_eq!(name, expected_name);
        assert_eq!(payload, &expected_payload, "{name}");
    }
}

// §5：`audio-started`・`audio-stopped`・`audio-engine-exited` のペイロード（名前と項目）。
#[test]
fn started_stopped_and_exited_payloads_keep_their_legacy_shape() {
    let f = Fixture::new([
        ("Start", start_steps(1)),
        ("Stop", stop_steps(1)),
        ("GetDevices", vec![Step::Exit]),
    ]);
    let mut host = host(&f);
    start(&mut host).unwrap();
    let events = f.recorder.events();
    let started = events.iter().find(|(name, _)| name == "audio-started");
    assert_eq!(
        started.map(|(_, payload)| payload),
        Some(
            &serde_json::json!({"sample_rate": 48000, "buffer_size": 512, "stream_generation": "1:1"})
        )
    );
    f.recorder.clear();
    host.stop().unwrap();
    let events = f.recorder.events();
    let stopped = events.iter().find(|(name, _)| name == "audio-stopped");
    assert_eq!(
        stopped.map(|(_, payload)| payload),
        Some(&serde_json::json!({"stream_generation": "1:1", "ended_stream_generation": "1:1"}))
    );
    f.recorder.clear();
    let _ = host.execute_running_command(IpcCommand::GetDevices);
    let events = f.recorder.events();
    let exited = events
        .iter()
        .find(|(name, _)| name == "audio-engine-exited")
        .expect("audio-engine-exited");
    assert_eq!(
        exited.1,
        serde_json::json!({"cause": "unknown"}),
        "利用者の停止のあとの終了は、原因の文脈を持たない"
    );
}

// §5：開始の途中で子が終了したときの`audio-engine-exited`は、開始の文脈つき。
#[test]
fn exit_during_start_forwards_the_device_open_context() {
    let f = Fixture::new([("Start", vec![Step::Exit])]);
    let mut host = host(&f);
    let _ = start(&mut host);
    let mut payload = f
        .recorder
        .events()
        .into_iter()
        .find(|(name, _)| name == "audio-engine-exited")
        .expect("audio-engine-exited")
        .1;
    assert!(payload["elapsedMs"].is_u64(), "{payload}");
    payload.as_object_mut().unwrap().remove("elapsedMs");
    assert_eq!(
        payload,
        serde_json::json!({"cause": "device_open", "host": "ASIO", "phase": "opening"})
    );
}

// §5：VST の操作の途中で子が終了したときの`audio-engine-exited`は、操作・パス・クラス ID つき。
#[test]
fn exit_during_a_vst_load_forwards_the_operation_context() {
    let f = Fixture::new([("LoadPlugin", vec![Step::Exit])]);
    let mut host = host(&f);
    host.ensure_engine_running().unwrap();
    f.recorder.clear();
    let _ = host.execute_running_command(IpcCommand::LoadPlugin {
        path: "C:\\fixture\\a.vst3".into(),
        class_id: Some("CID1".into()),
    });
    let mut payload = f
        .recorder
        .events()
        .into_iter()
        .find(|(name, _)| name == "audio-engine-exited")
        .expect("audio-engine-exited")
        .1;
    assert!(payload["elapsedMs"].is_u64(), "{payload}");
    payload.as_object_mut().unwrap().remove("elapsedMs");
    assert_eq!(
        payload,
        serde_json::json!({"cause": "vst_operation", "op": "load", "path": "C:\\fixture\\a.vst3", "classId": "CID1"})
    );
}
