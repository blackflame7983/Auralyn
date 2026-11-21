//! 旧 API の互換（`9567061a` の振る舞い）を、実際の Tauri コマンドの関数で固定する試験。
//! 行 ID は docs/plans/audio-session-acceptance.md の K 群と、F1a で固定する行。
//! 現行の実装で通るのが正しい（振る舞いを固定するもので、新しい振る舞いを足すものではない）。
use super::*;
use crate::audio::compat_support::*;
use crate::audio::conditions::ConditionState;
use std::time::{Duration, Instant};
use tauri::Manager;

const EXPECTED_STATE_MISMATCH: &str =
    "音声の条件が変わりました。現在の設定を確認してから再試行してください。";
const MIC_DENIED: &str = "オーディオデバイスへのアクセスが拒否されました。";

fn mock(f: &Fixture) -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    let conditions = f
        .control
        .lock(audio::Entry::command("compat_test"))
        .unwrap()
        .conditions();
    app.manage(ConditionState(conditions));
    app.manage(audio::AudioState(f.control.clone()));
    app
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn options() -> AudioStartOptions {
    AudioStartOptions {
        input_source: None,
        input: None,
        output: None,
        host: Some("ASIO".into()),
        buffer_size: Some(512),
        sample_rate: Some(48000),
        input_id: None,
        output_id: None,
        channel_routing: None,
    }
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(
            Instant::now() < deadline,
            "条件が時間内に成立しませんでした"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn start_now(app: &tauri::App<tauri::test::MockRuntime>) -> audio::AudioConfig {
    run(start_audio(app.state(), options(), None)).unwrap()
}

fn state_json(app: &tauri::App<tauri::test::MockRuntime>) -> serde_json::Value {
    serde_json::to_value(run(get_audio_state(app.state())).unwrap()).unwrap()
}

fn bootstrap_request() -> audio::frontend_bootstrap::Request {
    serde_json::from_value(serde_json::json!({
        "config": {
            "host": "ASIO", "input": null, "output": null,
            "bufferSize": 512, "sampleRate": 48000, "inputChannels": [0, 1]
        },
        "inputGain": 0.3,
        "outputGain": 0.2
    }))
    .unwrap()
}

fn routing() -> crate::ipc::ChannelRouting {
    crate::ipc::ChannelRouting {
        input_channels: Some([0, 1]),
        output_routing: crate::ipc::OutputRouting::default(),
    }
}

fn routed_start_steps() -> Vec<Step> {
    vec![
        event_line(&started_event(1)),
        response_line(&crate::ipc::Response::Started {
            sample_rate: 48000,
            buffer_size: 512,
            routing: Some(routing()),
            input_id: None,
            output_id: None,
            stream_generation: Some(1),
        }),
    ]
}

fn identity_v2() -> Vec<Step> {
    vec![response_line(
        &crate::ipc::Response::StartIdentityCapability { version: 2 },
    )]
}

// §1：`get_audio_state`の形。`is_running`は子のハンドルがあること。`condition_witness`は10進数の文字列。
#[test]
fn get_audio_state_shape_and_is_running_means_a_child_exists() {
    let f = Fixture::new([("Start", start_steps(1))]);
    let app = mock(&f);
    let stopped = state_json(&app);
    assert_eq!(stopped["is_running"], false);
    assert!(stopped["config"].is_null());
    assert!(
        stopped.get("condition_witness").is_none(),
        "停止中は witness を省く"
    );
    start_now(&app);
    let running = state_json(&app);
    assert_eq!(running["is_running"], true);
    assert_eq!(running["config"]["host"], "ASIO");
    assert_eq!(running["config"]["buffer_size"], 512);
    assert!(running["config"]["input_id"].is_null() || running["config"].get("input_id").is_none());
    let witness = &running["condition_witness"];
    assert!(witness["revision"].as_str().unwrap().parse::<u64>().is_ok());
    assert!(witness["epoch"].as_str().unwrap().parse::<u64>().is_ok());
}

fn entry_phases(f: &Fixture, name: &str) -> Vec<audio::control::Phase> {
    f.control
        .admission()
        .records()
        .iter()
        .filter(|record| record.entry.name == name)
        .map(|record| record.phase)
        .collect()
}

// K2・K10：開始の応答を試験が止めている間（開始がロックを持っている間）、2つの読み取りは、それぞれ待つ。
// 開始の応答を解放すると、読み取りは、開始が保存と状態の更新を終えた後の値を返す。
#[test]
fn k2_k10_reads_wait_for_the_start_that_holds_the_lock_and_return_the_finished_values() {
    use audio::control::Phase;
    let mut gated = vec![Step::WaitGate("start".into())];
    gated.extend(start_steps(1));
    let f = Fixture::new([("Start#1", gated), ("Start", start_steps(1))]);
    let app = mock(&f);
    let (start_state, state_reader, saved_reader) =
        (app.state(), app.state::<audio::AudioState>(), app.state());
    std::thread::scope(|scope| {
        let starter = scope.spawn(move || run(start_audio(start_state, options(), None)));
        wait_until(|| f.sent().iter().any(|name| name == "Start"));
        let state_read = scope.spawn(move || run(get_audio_state(state_reader)));
        wait_until(|| entry_phases(&f, "get_audio_state") == [Phase::Accepted]);
        assert!(
            !state_read.is_finished(),
            "get_audio_state は開始の完了を待つ"
        );
        let saved_read = scope.spawn(move || run(get_saved_audio_config(saved_reader)));
        wait_until(|| entry_phases(&f, "get_saved_audio_config") == [Phase::Accepted]);
        assert!(
            !saved_read.is_finished(),
            "get_saved_audio_config は開始の完了を待つ"
        );
        assert!(
            !starter.is_finished(),
            "開始は、応答を待っていて終わっていない"
        );
        f.release("start");
        let info = state_read.join().unwrap().unwrap();
        assert!(
            info.is_running && info.config.is_some() && info.condition_witness.is_some(),
            "途中の版を返さない"
        );
        let saved = saved_read.join().unwrap().unwrap();
        assert_eq!(
            saved.expect("開始の保存の後に読む").host,
            "ASIO",
            "保存ファイルは、開始が終えた後の内容"
        );
        starter.join().unwrap().unwrap();
        // 続けて`expectedState`つきの開始を呼ぶと、その値で照合され、通る。
        let expected = serde_json::to_value(&info).unwrap();
        run(start_audio(app.state(), options(), Some(expected))).unwrap();
    });
}

// K10：ファイルなし／空の`host`／破損／移行の後。呼び出しのたびにファイルを直接読む。
#[test]
fn k10_saved_config_is_read_directly_from_the_file_on_every_call() {
    let f = Fixture::new([]);
    let app = mock(&f);
    let read = || run(get_saved_audio_config(app.state()));
    assert!(read().unwrap().is_none());
    std::fs::write(
        f.last_config_path(),
        r#"{"host":"","input":null,"output":null,"buffer_size":null,"sample_rate":null}"#,
    )
    .unwrap();
    assert_eq!(read().unwrap_err(), "保存済み接続方式が空です");
    std::fs::write(f.last_config_path(), "{not json").unwrap();
    assert!(read().is_err());
    // 移行の後など、ファイルが置き換わったら、次の呼び出しがその内容を返す（スナップショットにしない）。
    std::fs::write(
        f.last_config_path(),
        r#"{"host":"WASAPI","input":null,"output":null,"buffer_size":256,"sample_rate":44100}"#,
    )
    .unwrap();
    let config = read().unwrap().unwrap();
    assert_eq!(
        (config.host.as_str(), config.buffer_size),
        ("WASAPI", Some(256))
    );
    assert_eq!(f.spawn_count(), 0, "読み取りは子を起動しない");
}

// B14：`expectedState`は完全一致。欠落・余分・旧 witness・停止と再開の後は、すべて同じ文面で拒む。
#[test]
fn b14_expected_state_must_match_exactly_and_the_error_text_is_not_localized() {
    let f = Fixture::new([("Start", start_steps(1)), ("Stop", stop_steps(1))]);
    let app = mock(&f);
    let start_with =
        |expected: Option<serde_json::Value>| run(start_audio(app.state(), options(), expected));
    let stopped = state_json(&app);
    assert_eq!(
        start_with(Some(stopped)).unwrap_err(),
        EXPECTED_STATE_MISMATCH
    );
    assert_eq!(f.spawn_count(), 0, "照合は開始より先で、子を起動しない");

    start_now(&app);
    let current = state_json(&app);
    let mut without_witness = current.clone();
    without_witness
        .as_object_mut()
        .unwrap()
        .remove("condition_witness");
    let mut extra = current.clone();
    extra["extra"] = serde_json::json!(1);
    let mut old_revision = current.clone();
    old_revision["condition_witness"]["revision"] = serde_json::json!("0");
    for rejected in [without_witness, extra, old_revision] {
        assert_eq!(
            start_with(Some(rejected)).unwrap_err(),
            EXPECTED_STATE_MISMATCH
        );
    }
    assert!(start_with(Some(current.clone())).is_ok());

    // 同じ子で停止・開始をすると、旧の witness は拒まれる。
    let before = state_json(&app);
    run(stop_audio(app.state(), app.state())).unwrap();
    start_now(&app);
    assert_eq!(
        start_with(Some(before)).unwrap_err(),
        EXPECTED_STATE_MISMATCH
    );
}

// K12：`stop_audio`の`Pending`は、ロックを待つ前に作られ、ハンドラが終わるまで持たれる。受付の記録は、ロックの付与より先。
#[test]
fn k12_stop_audio_registers_its_pending_before_waiting_for_the_lock() {
    use audio::control::Phase;
    let mut gated = vec![Step::WaitGate("stop".into())];
    gated.extend(stop_steps(1));
    let f = Fixture::new([("Start", start_steps(1)), ("Stop", gated)]);
    let app = mock(&f);
    start_now(&app);
    let conditions = f
        .control
        .lock(audio::Entry::command("compat_test"))
        .unwrap()
        .conditions();
    let witness = conditions.control_snapshot().unwrap();
    let holder = f.control.lock(audio::Entry::command("holder")).unwrap();
    std::thread::scope(|scope| {
        let (state, condition_state) = (app.state(), app.state());
        let stop = scope.spawn(move || run(stop_audio(state, condition_state)));
        wait_until(|| {
            conditions.control_snapshot().is_err()
                && entry_phases(&f, "stop_audio") == [Phase::Accepted]
        });
        assert_eq!(
            conditions.pending_count(),
            1,
            "ロックを待つあいだは、`interrupt_restore`の Pending だけ"
        );
        assert!(!stop.is_finished(), "ロックを待っている");
        assert!(
            witness.validate().is_err(),
            "待っているあいだ、旧の witness は無効"
        );
        assert!(
            !f.sent().iter().any(|name| name == "Stop"),
            "ロックを待つあいだ、子へ Stop を送らない"
        );
        drop(holder);
        // ロックを得て、子へ`Stop`を送った。応答は試験が止めているので、ハンドラは終わっていない。
        wait_until(|| f.sent().iter().any(|name| name == "Stop"));
        wait_until(|| entry_phases(&f, "stop_audio") == [Phase::Accepted, Phase::LockGranted]);
        assert!(!stop.is_finished(), "ハンドラは子の応答を待っている");
        assert!(
            conditions.control_snapshot().is_err(),
            "ロックを渡した後も、ハンドラが終わるまで Pending が保たれる"
        );
        assert_eq!(
            conditions.pending_count(),
            2,
            "`interrupt_restore`の Pending に、停止の命令自身の Pending が加わる。前者は保たれている"
        );
        assert!(witness.validate().is_err());
        f.release("stop");
        stop.join().unwrap().unwrap();
    });
    assert!(witness.validate().is_err());
    assert!(
        conditions.control_snapshot().is_ok(),
        "ハンドラが終わると Pending が落ちる"
    );
}

// K4：`start_audio`の入力元の解決・`restart_audio_engine`の事前の検査は、`e.to_string()`を直接返す（`localize`を通さない）。
#[test]
fn k4_k14_input_source_errors_are_returned_raw_by_start_and_restart() {
    let f = Fixture::new([]);
    let app = mock(&f);
    let bad_source = || {
        let mut bad = options();
        bad.input_source = Some(crate::input_source::Request {
            source: crate::input_source::Config::Device {
                purpose: Default::default(),
            },
            candidate_id: Some("app-candidate".into()),
        });
        bad
    };
    let raw = "機器入力にアプリの選択情報は使えません";
    assert_eq!(
        run(start_audio(app.state(), bad_source(), None)).unwrap_err(),
        raw
    );
    assert_eq!(
        run(restart_audio_engine(app.state(), bad_source())).unwrap_err(),
        raw
    );
    assert_eq!(f.spawn_count(), 0);
}

// K4：再起動の事前の検査（`preflight_live_changes`）の拒否も、生の文言のまま返す。入力元の解決より先に拒み、動いている音声を保つ。
#[test]
fn k4_restart_preflight_rejection_is_raw_and_keeps_the_running_engine() {
    let protected = "本番保護中はデバイス変更・スキャン・ラック／プロファイル置換はできません。停止・ミュートは利用できます。変更する場合は本番保護を解除してください";
    let f = Fixture::new([("Start", start_steps(1))]);
    let app = mock(&f);
    start_now(&app);
    arm_live_protection(
        &mut f
            .control
            .lock(audio::Entry::command("compat_test"))
            .unwrap(),
    );
    let mut bad = options();
    bad.input_source = Some(crate::input_source::Request {
        source: crate::input_source::Config::Device {
            purpose: Default::default(),
        },
        candidate_id: Some("app-candidate".into()),
    });
    assert_eq!(
        run(restart_audio_engine(app.state(), bad)).unwrap_err(),
        protected,
        "事前の検査が、入力元の解決より先に拒む。localize を通さない"
    );
    assert_eq!(
        run(restart_audio_engine(app.state(), options())).unwrap_err(),
        protected
    );
    assert_eq!(f.spawn_count(), 1, "動いている子を作り直さない");
    assert_eq!(
        f.sent().iter().filter(|name| *name == "Start").count(),
        1,
        "新しい開始を送らない"
    );
    assert!(state_json(&app)["is_running"].as_bool().unwrap());
}

// K5：権限の案内。4つの印で、決まった日本語になる。開始の応答のエラーも同じ。
#[test]
fn k5_access_denied_markers_become_the_microphone_guidance() {
    for marker in [
        "Access Denied while opening",
        "access is denied",
        "failed with 0x80070005",
        "アクセスが拒否されました",
    ] {
        let text = audio::localize_audio_error(marker.into());
        assert!(text.starts_with(MIC_DENIED), "{marker}");
        assert!(text.contains("Windows設定 > プライバシーとセキュリティ > マイク"));
    }
    let f = Fixture::new([("Start", vec![error_line("Stream error: access is denied")])]);
    let app = mock(&f);
    let error = run(start_audio(app.state(), options(), None)).unwrap_err();
    assert!(error.starts_with(MIC_DENIED));
}

// K14：子の応答のエラーと、親の側のエラーは`localize`で包まれる（日本語の元のエラーも）。`stop_audio`は包まない。
#[test]
fn k14_child_and_parent_errors_are_wrapped_and_stop_errors_are_not() {
    let wrapped = |detail: &str| format!("オーディオエラーが発生しました。\n\n詳細: {detail}");
    let f = Fixture::new([("Start#1", vec![error_line("unknown failure")])]);
    let app = mock(&f);
    assert_eq!(
        run(start_audio(app.state(), options(), None)).unwrap_err(),
        wrapped("unknown failure")
    );

    let f = Fixture::new([("Start", vec![error_line("開始できませんでした")])]);
    let app = mock(&f);
    assert_eq!(
        run(start_audio(app.state(), options(), None)).unwrap_err(),
        wrapped("開始できませんでした"),
        "日本語の元のエラーも包まれる"
    );

    // 親の側：機器 ID を指定したが、子が照合に対応していない。
    let f = Fixture::new([("StartIdentityCapability", vec![error_line("unsupported")])]);
    let app = mock(&f);
    let mut with_id = options();
    with_id.output_id = Some("wasapi:out".into());
    assert_eq!(
        run(start_audio(app.state(), with_id, None)).unwrap_err(),
        wrapped("音声エンジンが機器IDの照合に対応していません。再起動して設定を確認してください")
    );
    assert!(!f.sent().iter().any(|name| name == "Start"));

    // `stop_audio`は包まない。
    let f = Fixture::new([
        ("Start", start_steps(1)),
        ("Stop", vec![error_line("access is denied")]),
    ]);
    let app = mock(&f);
    start_now(&app);
    assert_eq!(
        run(stop_audio(app.state(), app.state())).unwrap_err(),
        "access is denied"
    );
}

#[test]
fn lock_failure_texts_are_fixed() {
    let f = Fixture::new([]);
    let app = mock(&f);
    let control = f.control.clone();
    let _ = std::thread::spawn(move || {
        let _guard = control.lock(audio::Entry::command("poison")).unwrap();
        panic!("poison the audio state");
    })
    .join();
    assert_eq!(
        run(start_audio(app.state(), options(), None)).unwrap_err(),
        "Failed to lock audio state"
    );
    assert_eq!(
        run(get_audio_state(app.state())).unwrap_err(),
        "Failed to lock audio state"
    );
    assert_eq!(
        run(get_saved_audio_config(app.state())).unwrap_err(),
        "音声設定を取得できません"
    );
}

// D3：再起動は`audio-engine-exited`・`audio-error`を出さない。新しい接続を開始する。
#[test]
fn d3_restart_retires_the_old_connection_silently_and_starts_a_new_one() {
    let f = Fixture::new([("Start", start_steps(1))]);
    let app = mock(&f);
    start_now(&app);
    f.recorder.clear();
    run(restart_audio_engine(app.state(), options())).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let names = f.recorder.names();
    assert_eq!(f.spawn_count(), 2);
    assert!(
        !names
            .iter()
            .any(|name| matches!(name.as_str(), "audio-engine-exited" | "audio-error")),
        "{names:?}"
    );
    assert_eq!(
        names.first().map(String::as_str),
        Some("live-modes-invalidated")
    );
}

// K8a：子がない最初の呼び出し。warmup が子を生成する。保存した設定があれば、それで自動開始する。
#[test]
fn k8a_first_call_without_a_child_spawns_once_and_auto_starts_from_the_saved_config() {
    let f = Fixture::new([
        ("StartIdentityCapability", identity_v2()),
        ("Start", routed_start_steps()),
        ("AutoGain#1", vec![auto_gain_status(true, false)]),
    ]);
    // フロントの要求（ASIO・512・48000）とは違う接続設定を保存しておく。子に送られた`Start`がどちらを使ったかで区別する。
    let saved = audio::ActiveAudioConfig {
        host: "WASAPI".into(),
        buffer_size: Some(256),
        sample_rate: Some(44100),
        routing: Some(routing()),
        ..Default::default()
    };
    std::fs::write(f.last_config_path(), serde_json::to_vec(&saved).unwrap()).unwrap();
    let app = mock(&f);
    let reply = run(audio_frontend_bootstrap(app.state(), bootstrap_request())).unwrap();
    assert_eq!(serde_json::to_value(&reply).unwrap()["outcome"], "attached");
    assert!(reply.initial_page);
    assert_eq!(f.spawn_count(), 1);
    let sent = f.sent();
    assert_eq!(sent.iter().filter(|name| *name == "Start").count(), 1);
    assert!(
        sent.iter().any(|name| name == "SetGlobalMute"),
        "保存した設定の自動開始は、初期の制御を載せない通常の開始"
    );
    assert_eq!(&sent[sent.len() - 2..], ["SetInputGain", "SetOutputGain"]);
    let start = f
        .sent_json()
        .into_iter()
        .find(|line| line["type"] == "Start")
        .unwrap();
    assert_eq!(start["payload"]["host"], "WASAPI", "保存値の接続方式");
    assert_eq!(start["payload"]["buffer_size"], 256, "保存値のバッファ");
    assert_eq!(start["payload"]["sample_rate"], 44100, "保存値のレート");
    assert!(
        start["payload"].get("initial_controls").is_none(),
        "フロントの要求の設定は使わない"
    );
}

// K8a（保存した設定なし）・K7：frontend の設定で、初期の制御つきの開始を一度だけ送る。
#[test]
fn k8a_k7_without_a_saved_config_the_frontend_pair_starts_once_with_initial_controls() {
    let f = Fixture::new([
        ("StartIdentityCapability", identity_v2()),
        ("Start", routed_start_steps()),
        ("AutoGain#1", vec![auto_gain_status(false, false)]),
    ]);
    let app = mock(&f);
    let reply = run(audio_frontend_bootstrap(app.state(), bootstrap_request())).unwrap();
    assert_eq!(serde_json::to_value(&reply).unwrap()["outcome"], "started");
    assert_eq!(f.spawn_count(), 1);
    let sent = f.sent();
    assert!(!sent.iter().any(|name| name == "SetGlobalMute"));
    let start = f
        .sent_json()
        .into_iter()
        .find(|line| line["type"] == "Start")
        .unwrap();
    assert_eq!(start["payload"]["initial_controls"]["inputGain"], 0.3);
    assert_eq!(start["payload"]["initial_controls"]["outputGain"], 0.2);
}

// K8b：準備済み（warmup が済んでいて、稼働中）。状態を確かめるだけ。新しい開始をしない。
#[test]
fn k8b_prepared_and_running_only_checks_the_state() {
    let f = Fixture::new([("AutoGain", vec![auto_gain_status(true, false)])]);
    let app = mock(&f);
    f.control
        .lock(audio::Entry::new(audio::EntryKind::Warmup, "warmup"))
        .unwrap()
        .warmup()
        .unwrap();
    let before = f.sent().len();
    let reply = run(audio_frontend_bootstrap(app.state(), bootstrap_request())).unwrap();
    assert_eq!(serde_json::to_value(&reply).unwrap()["outcome"], "attached");
    assert_eq!(f.spawn_count(), 1);
    assert_eq!(&f.sent()[before..], ["AutoGain"]);
}

// K8c：保存済みの入力のペアを待っている（旧形式）。ペアが届くまで開始せず、届いたら一度だけ開始する。
#[test]
fn k8c_legacy_saved_config_waits_for_the_pair_then_starts_once() {
    let f = Fixture::new([
        ("StartIdentityCapability", identity_v2()),
        ("Start", routed_start_steps()),
        ("AutoGain#1", vec![auto_gain_status(false, false)]),
    ]);
    std::fs::write(
        f.last_config_path(),
        r#"{"host":"ASIO","input":null,"output":null,"buffer_size":512,"sample_rate":48000}"#,
    )
    .unwrap();
    let app = mock(&f);
    f.control
        .lock(audio::Entry::new(audio::EntryKind::Warmup, "warmup"))
        .unwrap()
        .warmup()
        .unwrap();
    assert!(
        !f.sent().iter().any(|name| name == "Start"),
        "ペアが届くまで開始しない"
    );
    let reply = run(audio_frontend_bootstrap(app.state(), bootstrap_request())).unwrap();
    assert_eq!(serde_json::to_value(&reply).unwrap()["outcome"], "started");
    assert_eq!(f.sent().iter().filter(|name| *name == "Start").count(), 1);
    assert_eq!(f.spawn_count(), 1);
    // ペアが届いた後の再呼び出し：開始せず、初回ではない。warmup を重ねても新しい開始を送らない。
    let sent_before = f.sent().len();
    let again = run(audio_frontend_bootstrap(app.state(), bootstrap_request())).unwrap();
    let again_json = serde_json::to_value(&again).unwrap();
    assert_eq!(again_json["outcome"], "attached");
    assert!(!again.initial_page);
    f.control
        .lock(audio::Entry::new(audio::EntryKind::Warmup, "warmup"))
        .unwrap()
        .warmup()
        .unwrap();
    assert_eq!(f.sent().len(), sent_before, "再呼び出しは子へ何も送らない");
    assert_eq!(f.sent().iter().filter(|name| *name == "Start").count(), 1);
    assert_eq!(f.spawn_count(), 1);
}

// K8d：失敗済みで、自動では生成し直さない。`inactive`とエラーを返し、子を生成し直さない。
#[test]
fn k8d_failed_warmup_is_inactive_and_never_respawns() {
    let f = Fixture::new([]);
    f.fail_spawns();
    let app = mock(&f);
    let reply = run(audio_frontend_bootstrap(app.state(), bootstrap_request())).unwrap();
    let json = serde_json::to_value(&reply).unwrap();
    assert_eq!(json["outcome"], "inactive");
    assert_eq!(
        json["error"],
        "音声エンジンの準備に失敗しました。設定から明示的に再開してください。"
    );
    assert_eq!(f.spawn_count(), 1);
    let again = run(audio_frontend_bootstrap(app.state(), bootstrap_request())).unwrap();
    assert!(!again.initial_page);
    f.control
        .lock(audio::Entry::new(audio::EntryKind::Warmup, "warmup"))
        .unwrap()
        .warmup()
        .unwrap();
    assert_eq!(f.spawn_count(), 1, "子を生成し直さない");
}

// タイムアウト：10秒。タイムアウト後も`Stop`を送らず、次の要求は「応答待ち」で拒まれる。
#[test]
fn timeout_waits_ten_seconds_sends_no_stop_and_blocks_the_next_request() {
    let f = Fixture::new([("Start", vec![Step::SleepMs(12_000)])]);
    let app = mock(&f);
    let begun = Instant::now();
    let error = run(start_audio(app.state(), options(), None)).unwrap_err();
    assert!(begun.elapsed() >= Duration::from_secs(10));
    assert!(error.starts_with("オーディオエラーが発生しました。\n\n詳細: Timeout or disconnect waiting for engine response"));
    assert_eq!(
        f.sent().last().map(String::as_str),
        Some("Start"),
        "Stop を送らない"
    );
    let blocked = run(get_engine_runtime_stats(app.state())).unwrap_err();
    assert_eq!(
        blocked,
        "前の音声操作の応答待ちです。しばらく待つか、エンジンを再起動してください。"
    );
}
