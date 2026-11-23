//! 配信ミックスの子の寿命の試験（W2 の配信ミックスの入口、J-13 の数え方、B40a）。
//! 子の `AudioHost` は、主の `AudioHost` の記録（`retired`）を共有する。
use super::*;
use crate::audio::compat_support::*;
use crate::audio::engine_life::{seam, EngineUnconfirmed, Role};
use crate::audio::reaper_seam;

const FIRST_FINAL: &str =
    "音声エンジンの終了を確認できません。しばらくしてからもう一度お試しください";

struct Rig {
    host: AudioHost,
    post: Observer,
    primary: Observer,
}

impl Rig {
    fn new(post_overrides: impl IntoIterator<Item = (&'static str, Vec<Step>)>) -> Self {
        Self::with_primary([], post_overrides)
    }

    fn with_primary(
        primary_overrides: impl IntoIterator<Item = (&'static str, Vec<Step>)>,
        post_overrides: impl IntoIterator<Item = (&'static str, Vec<Step>)>,
    ) -> Self {
        let (mut host, primary) = scripted_parts(primary_overrides);
        let (mut child, post) = scripted_parts(post_overrides);
        child.post_role = true;
        reaper_seam::share(&host, &mut child);
        child.ensure_engine_running().unwrap();
        host.post_mix.child = Some(Box::new(child));
        host.post_mix.restored = true;
        host.post_mix.enabled = true;
        Self {
            host,
            post,
            primary,
        }
    }

    fn finish(self) {
        let Self {
            host,
            post,
            primary,
        } = self;
        drop(host);
        let _ = std::fs::remove_dir_all(&post.dir);
        let _ = std::fs::remove_dir_all(&primary.dir);
    }

    fn pending(&self, role: Role) -> usize {
        reaper_seam::pending(&self.host, role)
    }
}

fn descriptor() -> crate::audio_engine::post_mix::Descriptor {
    crate::audio_engine::post_mix::Descriptor {
        name: "fixture".into(),
        sample_rate: 48000,
        protocol: 1,
    }
}

// 停止の失敗：元のエラーと状態は今のまま。結果を返す前に、子は主の記録へ移っている。
#[test]
fn w2_post_mix_stop_failure_moves_the_child_to_the_primary_record_first() {
    let mut rig = Rig::new([("Stop", vec![error_line("post stop refused")])]);
    reaper_seam::stuck();
    let error = rig.host.post_mix.stop().unwrap_err();
    assert_eq!(error.to_string(), "配信VSTを停止できませんでした");
    assert!(!rig.host.post_mix.restored && !rig.host.post_mix.running);
    assert_eq!(rig.pending(Role::PostMix), 1);
    assert_eq!(rig.pending(Role::Primary), 0);
    rig.finish();
}

// 開始の失敗：子の `Error` の応答を、そのまま返す。子は記録へ移る。
#[test]
fn w2_post_mix_start_failure_moves_the_child_to_the_primary_record_first() {
    let mut rig = Rig::new([("PostMixStart", vec![error_line("post start refused")])]);
    reaper_seam::stuck();
    let error = rig.host.post_mix.start(48000, descriptor()).unwrap_err();
    assert_eq!(error.to_string(), "post start refused");
    assert!(!rig.host.post_mix.restored);
    assert_eq!(rig.pending(Role::PostMix), 1);
    rig.finish();
}

// 書き込みの失敗（子の IPC）：子自身が `kill_engine()` して、元のエラーを返す。
#[test]
fn w2_post_mix_write_failure_moves_the_child_to_the_primary_record_first() {
    let mut rig = Rig::new([]);
    reaper_seam::stuck();
    let child = rig.host.post_mix.child.as_mut().unwrap();
    child.fail_writes_for_test();
    let error = child
        .execute_running_command(IpcCommand::ProcessingState)
        .unwrap_err();
    assert!(error.to_string().contains("Stdin not available"));
    assert_eq!(rig.pending(Role::PostMix), 1);
    rig.finish();
}

// EOF の後の `snapshot()`：子を外す前に、記録へ移る。
#[test]
fn w2_post_mix_snapshot_after_eof_moves_the_child_to_the_primary_record_before_detaching() {
    let mut rig = Rig::new([]);
    reaper_seam::stuck();
    let child = rig.host.post_mix.child.as_mut().unwrap();
    child.set_link_for_test(false);
    let snapshot = rig.host.post_mix.snapshot().unwrap();
    assert!(snapshot.error.is_some() && !snapshot.restored);
    assert!(rig.host.post_mix.child.is_none());
    assert_eq!(rig.pending(Role::PostMix), 1);
    rig.finish();
}

// 配信セットの復元とロールバック（`State` の差し替え）：差し替えの前に `kill()`、
// それを通らずに捨てても、`Drop` が記録へ移す。
#[test]
fn w2_replacing_the_state_never_loses_an_unconfirmed_child() {
    let mut rig = Rig::new([]);
    reaper_seam::stuck();
    rig.host.post_mix.kill();
    assert_eq!(rig.pending(Role::PostMix), 1);
    rig.finish();

    let mut rig = Rig::new([]);
    reaper_seam::stuck();
    let root = rig.primary.dir.clone();
    rig.host.post_mix = reaper_seam::post_mix_state(&rig.host, &root);
    assert_eq!(
        rig.pending(Role::PostMix),
        1,
        "差し替えで捨てても記録に残る"
    );
    rig.finish();
}

// 記録が残る間、配信ミックスの子を作る要求は `engine_unconfirmed`（公開の入口のエラーの文言も同じ）。
#[test]
fn w2_a_recorded_post_mix_child_blocks_a_new_one_and_the_error_text_is_final() {
    let mut rig = Rig::new([]);
    reaper_seam::stuck();
    rig.host.post_mix.kill();
    let error = rig.host.post_mix.child().map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), FIRST_FINAL);
    let request = Request::RestoreSaved {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
    };
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert!(error.to_string().contains(engine_life::UNCONFIRMED_JA));
    assert_eq!(rig.pending(Role::PostMix), 1);
    assert!(rig.post.probe(0).wait_exit(5000), "遅れて終了した");
    reaper_seam::real();
    assert!(
        reaper_seam::recheck(&rig.host).is_ok(),
        "後で終われば、次の要求で作れる"
    );
    assert_eq!(rig.pending(Role::PostMix), 0);
    rig.finish();
}

// J-13：最初の kill から期限を過ぎても記録が残るまでは初回の文言。過ぎると、主と配信ミックスの両方が再起動の案内になる。
#[test]
fn j13_the_message_switches_to_restart_once_a_record_outlives_the_deadline() {
    let mut rig = Rig::new([]);
    rig.host.ensure_engine_running().unwrap();
    reaper_seam::stuck();
    rig.host.kill_engine();
    assert_eq!(rig.pending(Role::Primary), 1);
    assert_eq!(rig.pending(Role::PostMix), 1);
    let error = rig.host.ensure_engine_running().unwrap_err();
    assert!(!error.downcast_ref::<EngineUnconfirmed>().unwrap().repeated);
    let error = rig.host.post_mix.child().map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), FIRST_FINAL);
    reaper_seam::pass_deadline();
    let error = rig.host.ensure_engine_running().unwrap_err();
    assert!(error.downcast_ref::<EngineUnconfirmed>().unwrap().repeated);
    let error = rig.host.post_mix.child().map(|_| ()).unwrap_err();
    assert!(
        error.to_string().starts_with(engine_life::REPEATED_JA),
        "配信ミックスの記録も、期限を過ぎれば再起動の案内"
    );
    rig.finish();
}
// B40a：配信ミックスの子を挟んでも、主の `engine_generation` は変わらない。
#[test]
fn b40a_post_mix_children_do_not_move_the_primary_generation() {
    let mut rig = Rig::new([]);
    rig.host.ensure_engine_running().unwrap();
    assert_eq!(rig.host.engine_generation, 1);
    let post = rig.host.post_mix.child.as_mut().unwrap();
    let post_generation = post.engine_generation;
    assert_eq!(rig.host.engine_generation, 1);
    rig.host.kill_engine();
    assert_eq!(rig.host.engine_generation, 2);
    rig.host.ensure_engine_running().unwrap();
    assert_eq!(rig.host.engine_generation, 3, "明示の再起動：1→3");
    assert_eq!(post_generation, 1);
    rig.finish();
}

fn mixing_config(id: &str) -> crate::audio_engine::mixing::Config {
    serde_json::from_value(serde_json::json!({
        "version": 1,
        "source": { "kind": "device", "config": { "host": "WASAPI", "inputId": id, "inputChannels": [0, 1] } },
        "levels": { "voice": { "gain": 1.0, "muted": false }, "accompaniment": { "gain": 1.0, "muted": false }, "monitorAccompaniment": true, "offsetMs": 0 }
    }))
    .unwrap()
}

// W2：配信セットの復元の失敗とロールバック（`with_bundle_mixing` の実際の入口）。
// 復元の失敗で `kill()` と `State` の差し替えが起き、そのとき終わらない子が主の記録に残り、
// 差し替えた後の配信ミックスも、同じ記録を見て同じ役割の子を作れない。
#[cfg(windows)]
#[test]
fn w2_bundle_restore_failure_rolls_back_and_the_replaced_state_still_sees_the_recorded_child() {
    use crate::audio_engine::mixing::Start;
    use crate::bundle::mixing_configuration::PostMixPreset;
    use crate::bundle::MixingConfiguration;
    let root =
        std::env::temp_dir().join(format!("auralyn-w2-bundle-{}", crate::bundle::revision()));
    std::fs::create_dir(&root).unwrap();
    let target = MixingConfiguration {
        version: 1,
        input: Some(mixing_config("wasapi:one")),
        post_mix: PostMixPreset {
            schema_version: 1,
            role: "post_mix".into(),
            enabled: false,
            plugins: Vec::new(),
        },
    };
    let mix_bytes = serde_json::to_vec(&Some(mixing_config("wasapi:one"))).unwrap();
    let post_bytes = serde_json::to_vec(&target.post_mix).unwrap();
    std::fs::write(root.join("mixing.json"), &mix_bytes).unwrap();
    std::fs::write(root.join("post-mix.json"), &post_bytes).unwrap();
    // 復元の最初の書き込み（バックアップ先の作成）を失敗させる。
    std::fs::write(root.join("post-mix-backups"), b"keep backup fixture").unwrap();
    let original = std::fs::create_dir_all(root.join("post-mix-backups"))
        .unwrap_err()
        .to_string();
    let (post_host, post_observer) = scripted_parts([(
        "GetPluginRack",
        vec![response_line(&IpcResponse::PluginRack {
            plugins: Vec::new(),
            restore_eligible: true,
            revision: 0,
            running: false,
        })],
    )]);
    let mut post_child = post_host;
    crate::audio::session_rack::tests::with_host(
        |command| {
            match command {
            IpcCommand::Stop => IpcResponse::Success,
            IpcCommand::Mixing { .. } => IpcResponse::Mixing(Box::new(
                serde_json::from_value(serde_json::json!({
                    "epoch":"engine", "revision":"0", "config":null, "running":false, "accompaniment":null,
                    "voicePeak":[0,0], "accompanimentPeak":[0,0], "mixPeak":[0,0],
                    "knownVoiceProcessingFrames":null, "pending":false, "failed":false, "primaryClock":null
                }))
                .unwrap(),
            )),
            other => panic!("予期しない fake IPC: {other:?}"),
        }
        },
        |host, _calls| {
            host.last_config_path = root.join("last_audio_config.json");
            host.mixing = crate::audio::mixing::State::new(&root);
            host.post_mix = reaper_seam::post_mix_state(host, &root);
            host.mixing.selected = Some(Start {
                config: mixing_config("wasapi:one"),
                target: None,
            });
            host.is_global_muted = true;
            post_child.post_role = true;
            reaper_seam::share(host, &mut post_child);
            post_child.ensure_engine_running().unwrap();
            host.post_mix.child = Some(Box::new(post_child));
            host.post_mix.restored = true;
            let (_, witness) = host.capture_bundle_mixing().unwrap();
            reaper_seam::stuck();
            let epoch_before = host.post_mix.epoch.clone();
            let error = host
                .with_bundle_mixing(&target, &witness, |_| Ok(()))
                .unwrap_err();
            assert_eq!(error, original, "元のエラーが返る");
            assert_ne!(
                host.post_mix.epoch, epoch_before,
                "ロールバックで State が差し替わっている"
            );
            assert_eq!(
                reaper_seam::pending(host, Role::PostMix),
                1,
                "終わらない子は、その時点で主の記録に残っている"
            );
            let blocked = host.post_mix.child().map(|_| ()).unwrap_err();
            assert_eq!(
                blocked.to_string(),
                engine_life::EngineUnconfirmed::text(false),
                "差し替えた後の配信ミックスも、同じ役割の子を作れない"
            );
        },
    );
    let _ = std::fs::remove_dir_all(&post_observer.dir);
    let _ = std::fs::remove_dir_all(&root);
}

// ---- F1b-0a-1（T10）。子への命令を `exec_child` に集めた後の、切断の後始末 ----

use crate::audio::link::CloseCause;

const EXITED: &str = "Engine Crashed/Exited";

#[derive(Clone, Copy, Debug)]
enum When {
    /// 送る前に、すでに閉じていた（子の出力が閉じ、子は生きている）。
    Before,
    /// 送っている間に、子が終わった（EOF）。
    During,
    /// 書き込みが失敗した。
    WriteFails,
}

fn command_name(op: &str) -> &'static str {
    match op {
        "rack" | "command" | "capture" => "GetPluginRack",
        "snapshot" => "ProcessingState",
        "start" => "PostMixStart",
        "stop" => "Stop",
        "restore_one" => "RestorePlugin",
        _ => unreachable!(),
    }
}

fn plugin() -> PresetPlugin {
    PresetPlugin {
        path: "post.vst3".into(),
        name: "post".into(),
        vendor: String::new(),
        version: String::new(),
        enabled: true,
        muted: false,
        gain: 1.0,
        state: Some("s".into()),
        class_id: None,
    }
}

/// 主の子も動かし、`post_attached` を立てた配信ミックスの一式。
fn rig_for(op: &str, when: When) -> Rig {
    let overrides = match when {
        When::During => vec![(command_name(op), vec![Step::Exit])],
        _ => Vec::new(),
    };
    let mut rig = Rig::new(overrides);
    rig.host.ensure_engine_running().unwrap();
    rig.host.post_attached = true;
    let child = rig.host.post_mix.child.as_mut().unwrap();
    match when {
        When::Before => assert!(child.link.close(CloseCause::Eof)),
        When::WriteFails => child.fail_writes_for_test(),
        When::During => {}
    }
    rig
}

fn run(rig: &mut Rig, op: &str) -> std::result::Result<String, String> {
    let state = &mut rig.host.post_mix;
    let result = match op {
        "rack" => state.rack().map(|_| String::new()),
        "command" => state
            .command(IpcCommand::GetPluginRack)
            .map(|_| String::new()),
        "capture" => state.capture_bundle().map(|_| String::new()),
        "snapshot" => state
            .snapshot()
            .map(|snapshot| snapshot.error.unwrap_or_default()),
        "start" => state.start(48000, descriptor()).map(|()| String::new()),
        "stop" => state.stop().map(|()| String::new()),
        "restore_one" => state.restore_one(&plugin()).map(|()| String::new()),
        _ => unreachable!(),
    };
    result.map_err(|error| error.to_string())
}

fn expected(op: &str, when: When) -> std::result::Result<&'static str, &'static str> {
    use When::*;
    match (op, when) {
        ("rack", Before) => Err("配信VSTのEngineが終了しました。保存設定を選び直してください"),
        ("command", Before) | ("restore_one", Before) => Err(replies::CLOSED),
        ("capture", Before) => Err("配信VSTの接続が終了しました"),
        ("start", Before) => Err("配信VSTの保存設定を明示的に復元してください"),
        ("start", WriteFails) => Err("配信VSTを開始できません"),
        ("stop", Before) => Ok(""),
        ("stop", During) | ("stop", WriteFails) => Err("配信VSTを停止できませんでした"),
        ("snapshot", Before) => Ok("配信VSTのEngineが終了しました"),
        (_, During) => Err(EXITED),
        (_, WriteFails) => Err("Stdin not available"),
        (_, Before) => unreachable!("{op}"),
    }
}

// 切断の後（送る前・送っている間・書き込みの失敗）の、失敗が戻った直後の状態。
// 子は外れ、`restored`・`running` は下り、`enabled` は残り、主の子と通知は触れず、`post_attached` は変わらない。
// `post_attached` を下ろす位置は今のまま（`kill_primary_engine`・`cancel_prepared_post_start`・`prepare_post_mix_start`）。
#[test]
fn t10_every_exec_child_path_detaches_a_closed_child_the_same_way() {
    for op in [
        "rack",
        "command",
        "capture",
        "snapshot",
        "start",
        "stop",
        "restore_one",
    ] {
        for when in [When::Before, When::During, When::WriteFails] {
            let mut rig = rig_for(op, when);
            let result = run(&mut rig, op);
            let label = format!("{op} / {when:?}");
            match (expected(op, when), &result) {
                (Ok(note), Ok(actual)) => assert_eq!(actual, note, "{label}"),
                (Err(text), Err(actual)) => {
                    assert!(actual.contains(text), "{label}: {actual}");
                }
                (want, got) => panic!("{label}: 期待 {want:?} / 実際 {got:?}"),
            }
            let state = &rig.host.post_mix;
            assert!(state.child.is_none(), "{label}: 子は外れている");
            assert!(!state.restored && !state.running, "{label}");
            assert!(state.enabled, "{label}: enabled は残す");
            assert!(rig.host.post_attached, "{label}: 解除の位置は変えない");
            assert!(
                !rig.primary.probe(0).exited(),
                "{label}: 主の子は生きている"
            );
            assert!(
                !rig.primary
                    .recorder
                    .names()
                    .iter()
                    .any(|name| name == "audio-error"),
                "{label}: 配信ミックスの切断で、主の audio-error は出ない"
            );
            rig.finish();
        }
    }
}

// 別の操作が切断を処理して外した後の `snapshot` は、今の EOF の説明をエラーの情報つきの成功として出す。
#[test]
fn t10_a_snapshot_after_another_operation_detached_the_child_reports_the_eof_explanation() {
    let mut rig = rig_for("rack", When::During);
    run(&mut rig, "rack").unwrap_err();
    assert!(rig.host.post_mix.child.is_none());
    let snapshot = rig.host.post_mix.snapshot().unwrap();
    assert_eq!(
        snapshot.error.as_deref(),
        Some("配信VSTのEngineが終了しました")
    );
    assert!(!snapshot.restored && !snapshot.running);
    assert!(rig.host.post_mix.enabled, "enabled と保存した設定は残る");
    rig.finish();
}

// 9章の条件3：状態を書き戻す直前にも確かめる。確認と更新の間に EOF が来ても、`running` は立たず、
// 次の `snapshot` に終了の理由が残る。
#[test]
fn t10_an_eof_between_the_check_and_the_state_update_never_leaves_running_set() {
    let mut rig = Rig::new([]);
    rig.host.post_mix.after_exec_check = Some(Box::new(|child| {
        child.link.close(CloseCause::Eof);
    }));
    let error = rig
        .host
        .post_mix
        .start(48000, descriptor())
        .unwrap_err()
        .to_string();
    assert_eq!(error, "配信VSTを開始できません");
    let state = &rig.host.post_mix;
    assert!(!state.running && !state.restored && state.child.is_none());
    rig.host.post_mix.after_exec_check = None;
    let snapshot = rig.host.post_mix.snapshot().unwrap();
    assert_eq!(
        snapshot.error.as_deref(),
        Some("配信VSTのEngineが終了しました")
    );
    rig.finish();

    // `snapshot` の成功の応答の後に閉じても、`running` を立てない。
    let rack = response_line(&IpcResponse::PluginRack {
        plugins: Vec::new(),
        restore_eligible: true,
        revision: 0,
        running: false,
    });
    let mut rig = Rig::new([
        ("GetPluginRack", vec![rack]),
        (
            "ProcessingState",
            vec![response_line(&IpcResponse::ProcessingState {
                present: true,
                failed: false,
            })],
        ),
    ]);
    rig.host.post_mix.after_exec_check = Some(Box::new(|child| {
        child.link.close(CloseCause::Eof);
    }));
    let snapshot = rig.host.post_mix.snapshot().unwrap();
    assert!(!snapshot.running && !snapshot.restored);
    assert_eq!(
        snapshot.error.as_deref(),
        Some("配信VSTのEngineが終了しました")
    );
    assert!(rig.host.post_mix.child.is_none());
    rig.finish();
}

// 切断を処理した後の `validate_start` は、保存設定の復元を求める（有効で未復元）。
#[test]
fn t10_start_after_a_detached_child_requires_an_explicit_restore() {
    let mut rig = rig_for("rack", When::Before);
    run(&mut rig, "rack").unwrap_err();
    let error = rig.host.post_mix.validate_start().unwrap_err().to_string();
    assert!(error.contains("明示的に復元"), "{error}");
    rig.finish();
}

// ---- 指摘への対応（P1 1・P2 3）。公開の入口から、復元と失敗の直後の状態を確かめる ----

fn restored_step(operation_id: u64) -> Step {
    response_line(&IpcResponse::PluginRestored {
        operation_id,
        plugin: crate::ipc::RestoredPlugin {
            id: format!("id-{operation_id}"),
            name: "post".into(),
            class_id: None,
            prepared: false,
            legacy_class_ambiguous: false,
            channel_layout: crate::ipc::ChannelLayout::Stereo,
        },
    })
}

fn stopped_primary() -> Vec<(&'static str, Vec<Step>)> {
    vec![(
        "ProcessingState",
        vec![response_line(&IpcResponse::ProcessingState {
            present: false,
            failed: false,
        })],
    )]
}

/// 復元の途中で、成功の応答の直後に子が閉じる。続きに使える別の子も用意しておく。
struct RestoreRig {
    rig: Rig,
    second: Observer,
}

fn restore_rig(plugins: usize) -> RestoreRig {
    let mut rig = Rig::with_primary(stopped_primary(), []);
    // 作り直した子として、最初の `child()` が受け取る子（応答の直後に EOF を挟む）と、別の子。
    rig.host.post_mix.child = None;
    rig.host.post_mix.restored = false;
    rig.host.post_mix.enabled = false;
    let steps = vec![("RestorePlugin", vec![restored_step(1)])];
    let (first, _) = scripted_parts(steps);
    let (second, second_observer) = scripted_parts([]);
    let mut first = first;
    first.post_role = true;
    reaper_seam::share(&rig.host, &mut first);
    let mut second = second;
    second.post_role = true;
    reaper_seam::share(&rig.host, &mut second);
    rig.host.post_mix.test_children = vec![Box::new(first), Box::new(second)];
    rig.host.post_mix.after_exec_check = Some(Box::new(|child| {
        child.link.close(CloseCause::Eof);
    }));
    rig.host.post_mix.saved = Some(Saved {
        schema_version: 1,
        role: "post_mix".into(),
        enabled: true,
        plugins: (0..plugins).map(|_| plugin()).collect(),
    });
    RestoreRig {
        rig,
        second: second_observer,
    }
}

// P1 1：`RestoreSaved` の最初のプラグインの成功の直後に子が閉じたら、別の子で続きを復元せず、
// 今の EOF の失敗で中断する。`restored` は立たない。
#[test]
fn p1_restore_saved_aborts_when_the_child_closes_right_after_a_success() {
    let RestoreRig { mut rig, second } = restore_rig(2);
    let request = Request::RestoreSaved {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
    };
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), EXITED);
    let state = &rig.host.post_mix;
    assert!(!state.restored && !state.running && state.child.is_none());
    assert_eq!(state.test_children.len(), 1, "別の子は使われていない");
    assert_eq!(second.spawn_count(), 0);
    assert!(
        state.error.is_none(),
        "切断では、保存状態の読み直しを求めない"
    );
    rig.finish();
}

// P1 1：`restore_bundle` で、最後のプラグインの成功の直後に子を失っても、保存済みの設定が
// 実際のラックとの照合を通らない。
#[test]
fn p1_restore_bundle_fails_when_the_last_plugin_is_followed_by_a_lost_child() {
    let RestoreRig { mut rig, second } = restore_rig(1);
    let preset = Saved {
        schema_version: 1,
        role: "post_mix".into(),
        enabled: true,
        plugins: vec![plugin()],
    };
    let error = rig
        .host
        .post_mix
        .restore_bundle(&preset)
        .unwrap_err()
        .to_string();
    assert_eq!(error, EXITED);
    let state = &rig.host.post_mix;
    assert!(!state.restored && state.child.is_none());
    assert!(state.error.is_some(), "復元の失敗は今のとおり");
    assert_eq!(second.spawn_count(), 0);
    rig.finish();
}

fn save_request(rig: &Rig) -> Request {
    Request::Save {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
    }
}

// P2 3：公開の操作（`post_mix`）が切断（EOF・書き込みの失敗・C2）で失敗した直後も、`enabled` を残し、
// 子は外れ、`restored`・`running` は下り、保存状態の読み直しは求めない。`snapshot` はその理由を出す。
#[test]
fn p2_public_operations_keep_enabled_after_a_disconnect() {
    for when in ["before", "during", "write", "c2"] {
        let mut rig = Rig::new(if when == "during" {
            vec![("GetPluginRack", vec![Step::Exit])]
        } else {
            Vec::new()
        });
        rig.host.ensure_engine_running().unwrap();
        rig.host.post_attached = true;
        let gate = crate::audio::writer::sinks::Gated::default();
        {
            let child = rig.host.post_mix.child.as_mut().unwrap();
            match when {
                "before" => assert!(child.link.close(CloseCause::Eof)),
                "write" => child.fail_writes_for_test(),
                "c2" => {
                    child.replace_writer_for_test(crate::audio::writer::Writer::start(
                        gate.clone(),
                        child.link.clone(),
                    ));
                    crate::audio::writer::set_limits_for_test(
                        Some(std::time::Duration::from_millis(200)),
                        None,
                    );
                }
                _ => {}
            }
        }
        let request = save_request(&rig);
        let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
        let label = format!("{when}: {error}");
        let state = &rig.host.post_mix;
        assert!(state.child.is_none(), "{label}");
        assert!(!state.restored && !state.running, "{label}");
        assert!(state.enabled, "{label}: enabled は残す");
        assert!(state.error.is_none(), "{label}");
        assert!(rig.host.post_attached, "{label}");
        assert!(!rig.primary.probe(0).exited(), "{label}");
        if when == "c2" {
            assert!(error.to_string().contains("応答しない"), "{label}");
            crate::audio::writer::set_limits_for_test(None, None);
        }
        gate.open();
        // 次の `snapshot` が、今の EOF の説明を出す。
        let snapshot = rig.host.post_mix(Request::Snapshot).unwrap();
        assert_eq!(
            snapshot.error.as_deref(),
            Some("配信VSTのEngineが終了しました"),
            "{label}"
        );
        assert!(snapshot.enabled && !snapshot.restored, "{label}");
        rig.finish();
    }
}

// F1b-0a-2 の T2：配信ミックスの子が応答しなくなったときの C3。公開の操作（共通のエラー処理の境界）から起こす。
// 子は回収されて外れ、`enabled` と保存した設定は残る。主の子・オケの入力・主の通知には触れない。
#[test]
fn t2_c3_a_post_mix_child_that_stops_answering_is_retired_and_the_primary_is_untouched() {
    use crate::audio_engine::mixing::Start;
    let mut rig = Rig::new([("GetPluginRack", vec![Step::WaitGate("never".into())])]);
    rig.host.ensure_engine_running().unwrap();
    rig.host.post_attached = true;
    rig.host.mixing.selected = Some(Start {
        config: mixing_config("wasapi:one"),
        target: None,
    });
    rig.primary.recorder.clear();
    crate::audio::writer::set_limits_for_test(None, Some(std::time::Duration::from_millis(400)));
    let request = save_request(&rig);
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    crate::audio::writer::set_limits_for_test(None, None);
    let state = &rig.host.post_mix;
    assert!(error.to_string().contains("応答しない"), "{error}");
    assert!(state.child.is_none(), "子は外れている");
    assert!(!state.restored && !state.running);
    assert!(state.enabled, "enabled は残す");
    assert!(state.error.is_none(), "保存状態の読み直しは求めない");
    assert!(rig.host.post_attached);
    assert!(rig.host.mixing.selected.is_some(), "オケの入力の選択は残る");
    assert!(!rig.primary.probe(0).exited(), "主の子は残る");
    assert!(
        rig.post.probe(0).wait_exit(5000),
        "配信ミックスの子は回収される"
    );
    assert!(
        !rig.primary
            .recorder
            .names()
            .iter()
            .any(|name| name == "audio-error"),
        "主の audio-error は出さない"
    );
    let snapshot = rig.host.post_mix(Request::Snapshot).unwrap();
    assert_eq!(
        snapshot.error.as_deref(),
        Some("配信VSTのEngineが終了しました"),
        "続く snapshot に切断が表示される"
    );
    assert!(snapshot.enabled && !snapshot.restored);
    rig.finish();
}

fn refused_add(rig: &Rig) -> Request {
    Request::Add {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
        path: "new.vst3".into(),
        class_id: None,
    }
}

// S2（F1b-0b-1 で反転済み。設計 9.8・T5）：切断ではない理由で公開の操作が失敗し、失敗の処理が決める直前に
// EOF が来ても、切断として数える。`enabled` は残り、`disconnected` が立ち、`error` は空。子は外れて回収される。
#[test]
fn an_eof_right_after_settle_keeps_enabled() {
    let mut rig = Rig::with_primary(
        stopped_primary(),
        [
            ("GetPluginRack", vec![rack_with_a_plugin()]),
            ("LoadPlugin", vec![error_line("load refused")]),
        ],
    );
    rig.host.post_mix.after_failure_settle = Some(Box::new(|child| {
        assert!(child.link.close(CloseCause::Eof));
    }));
    let request = refused_add(&rig);
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert_ne!(error.to_string(), EXITED, "切断ではない理由の失敗");
    let state = &rig.host.post_mix;
    assert!(state.enabled && !state.restored && !state.running);
    assert!(state.child.is_none(), "子は外れている");
    assert!(state.error.is_none(), "保存状態の読み直しは求めない");
    assert!(state.disconnected.is_some() && state.detached == 1);
    assert!(rig.post.probe(0).wait_exit(5000), "子は回収される");
    rig.finish();
}

// T5：切断ではない理由の通常の失敗は、今のとおり、子を捨てて `enabled` を落とし、保存状態の読み直しを求める。
#[test]
fn an_ordinary_failure_still_discards_the_child_and_drops_enabled() {
    let mut rig = Rig::with_primary(
        stopped_primary(),
        [
            ("GetPluginRack", vec![rack_with_a_plugin()]),
            ("LoadPlugin", vec![error_line("load refused")]),
        ],
    );
    let request = refused_add(&rig);
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert_ne!(error.to_string(), EXITED, "切断ではない理由の失敗");
    let state = &rig.host.post_mix;
    assert!(!state.enabled && !state.restored && state.child.is_none());
    assert!(state.error.is_some(), "保存状態の読み直しを求める");
    assert!(state.disconnected.is_none() && state.detached == 0);
    rig.finish();
}

// S8（F1b-0a-2 設計 9章の2点目）：C3 で配信ミックスの子を切り離しても、保存した設定は、メモリ（`saved`・`raw`）にも
// 保存のファイルにも、そのまま残る。
#[test]
fn s8_t2_c3_keeps_the_saved_post_mix_settings_in_memory_and_on_disk() {
    use crate::audio_engine::mixing::Start;
    let mut post_script = stopped_primary();
    post_script.push(("GetPluginRack", vec![empty_rack()]));
    let mut rig = Rig::new(post_script);
    rig.host.ensure_engine_running().unwrap();
    rig.host.post_attached = true;
    rig.host.mixing.selected = Some(Start {
        config: mixing_config("wasapi:one"),
        target: None,
    });
    let request = save_request(&rig);
    rig.host.post_mix(request).unwrap();
    let path = rig.host.post_mix.path.clone();
    let saved_before = serde_json::to_value(&rig.host.post_mix.saved).unwrap();
    let raw_before = rig.host.post_mix.raw.clone();
    let file_before = std::fs::read(&path).unwrap();
    assert!(raw_before.is_some() && saved_before.is_object());
    assert_eq!(raw_before.as_deref(), Some(file_before.as_slice()));

    let (mut silent, silent_observer) =
        scripted_parts([("GetPluginRack", vec![Step::WaitGate("never".into())])]);
    silent.post_role = true;
    reaper_seam::share(&rig.host, &mut silent);
    silent.ensure_engine_running().unwrap();
    rig.host.post_mix.child = Some(Box::new(silent));
    rig.host.post_mix.restored = true;
    crate::audio::writer::set_limits_for_test(None, Some(std::time::Duration::from_millis(400)));
    let request = save_request(&rig);
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    crate::audio::writer::set_limits_for_test(None, None);
    assert!(error.to_string().contains("応答しない"), "{error}");
    let state = &rig.host.post_mix;
    assert!(state.child.is_none(), "子は外れている");
    assert!(state.enabled, "enabled は残す");
    assert_eq!(serde_json::to_value(&state.saved).unwrap(), saved_before);
    assert_eq!(state.raw, raw_before);
    assert_eq!(std::fs::read(&path).unwrap(), file_before);
    assert!(
        silent_observer.probe(0).wait_exit(5000),
        "配信ミックスの子は回収される"
    );
    let _ = std::fs::remove_dir_all(&silent_observer.dir);
    rig.finish();
}

// F1b-0a-2 の T8：起動の確認（J-24）の期限は A の10秒のまま。確認の間の C3 は、主の子だけを回収し、
// 配信ミックスの子・`enabled`・オケの入力を残し、`audio-error` を出さず、`kill_primary_engine` を二重に呼ばない。
// 起動の失敗か、終了を確かめられなければ `engine_unconfirmed`。
#[test]
fn t8_c3_during_the_start_confirmation_recovers_only_the_primary_child() {
    use crate::audio_engine::mixing::Start;
    assert_eq!(
        crate::audio::writer::reply_limit(&IpcCommand::StartIdentityCapability),
        std::time::Duration::from_secs(10)
    );
    for confirmed in [true, false] {
        let mut rig = Rig::new([]);
        rig.host.mixing.selected = Some(Start {
            config: mixing_config("wasapi:one"),
            target: None,
        });
        let generation = rig.host.engine_generation;
        crate::audio::writer::set_limits_for_test(
            None,
            Some(std::time::Duration::from_millis(500)),
        );
        seam::set_resume(seam::Resume::ExternalSuspend(None));
        if !confirmed {
            reaper_seam::stuck();
        }
        let error = rig.host.ensure_engine_running().unwrap_err();
        seam::set_resume(seam::Resume::Real);
        crate::audio::writer::set_limits_for_test(None, None);
        let label = format!("confirmed={confirmed}: {error}");
        if confirmed {
            assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED, "{label}");
        } else {
            assert!(
                error.downcast_ref::<EngineUnconfirmed>().is_some(),
                "{label}"
            );
            reaper_seam::real();
        }
        assert_eq!(
            rig.host.link.cause(),
            Some(CloseCause::ReplyTimeout),
            "{label}"
        );
        assert!(rig.host.child.is_none(), "{label}: 主の子は回収されている");
        assert!(rig.host.post_mix.child.is_some(), "{label}");
        assert!(
            rig.host.post_mix.restored && rig.host.post_mix.enabled,
            "{label}"
        );
        assert!(rig.host.mixing.selected.is_some(), "{label}");
        assert!(!rig.post.probe(0).exited(), "{label}");
        assert!(
            !rig.primary
                .recorder
                .names()
                .iter()
                .any(|name| name == "audio-error"),
            "{label}: audio-error は出さない"
        );
        assert_eq!(
            rig.host.engine_generation,
            generation + 2,
            "{label}: 起動で1、回収で1（二重に回収しない）"
        );
        rig.finish();
    }
}

// P2 3：通常の失敗（切断ではない）は、今のとおり `enabled` を下ろして保存状態の読み直しを求める。
#[test]
fn p2_a_non_disconnect_failure_still_discards_the_child_and_disables() {
    let mut rig = Rig::new([("GetPluginRack", vec![error_line("rack refused")])]);
    let request = save_request(&rig);
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), "rack refused");
    let state = &rig.host.post_mix;
    assert!(!state.enabled && !state.restored && state.child.is_none());
    assert!(state.error.is_some());
    rig.finish();
}

// P2 3：`snapshot` の最後の IPC（`rack`）の後に閉じても、接続と理由を確定してから返す。
#[test]
fn p2_snapshot_settles_the_link_after_its_last_ipc() {
    let rack = response_line(&IpcResponse::PluginRack {
        plugins: Vec::new(),
        restore_eligible: true,
        revision: 0,
        running: false,
    });
    let mut rig = Rig::new([
        ("GetPluginRack", vec![rack]),
        (
            "ProcessingState",
            vec![response_line(&IpcResponse::ProcessingState {
                present: true,
                failed: false,
            })],
        ),
    ]);
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = calls.clone();
    // 1回目（ProcessingState）の後は何もせず、2回目（最後の IPC の GetPluginRack）の後に閉じる。
    rig.host.post_mix.after_exec_check = Some(Box::new(move |child| {
        if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            child.link.close(CloseCause::Eof);
        }
    }));
    let snapshot = rig.host.post_mix.snapshot().unwrap();
    assert!(
        !snapshot.running && !snapshot.restored,
        "閉じた接続を動作中と返さない"
    );
    assert_eq!(
        snapshot.error.as_deref(),
        Some("配信VSTのEngineが終了しました")
    );
    assert!(rig.host.post_mix.child.is_none());
    rig.finish();
}

// P1：`Add` で、ラックの応答の直後に子が閉じたら、既存のラックを欠いたまま別の子で続けない。
// 子を作り直さず、復元済みにならず、保存した設定も変わらない。
#[test]
fn p1_add_aborts_when_the_rack_reply_is_followed_by_eof() {
    let existing = crate::ipc::RackPlugin {
        id: "existing".into(),
        path: "post.vst3".into(),
        name: "post".into(),
        enabled: true,
        muted: false,
        gain: 1.0,
        class_id: None,
        channel_layout: crate::ipc::ChannelLayout::Stereo,
    };
    let rack = response_line(&IpcResponse::PluginRack {
        plugins: vec![existing],
        restore_eligible: true,
        revision: 1,
        running: false,
    });
    let mut rig = Rig::with_primary(stopped_primary(), [("GetPluginRack", vec![rack])]);
    let (second, second_observer) = scripted_parts([]);
    let mut second = second;
    second.post_role = true;
    reaper_seam::share(&rig.host, &mut second);
    rig.host.post_mix.test_children = vec![Box::new(second)];
    rig.host.post_mix.saved = Some(Saved {
        schema_version: 1,
        role: "post_mix".into(),
        enabled: true,
        plugins: vec![plugin()],
    });
    let saved_before = serde_json::to_value(&rig.host.post_mix.saved).unwrap();
    let raw_before = rig.host.post_mix.raw.clone();
    rig.host.post_mix.after_exec_check = Some(Box::new(|child| {
        child.link.close(CloseCause::Eof);
    }));
    let request = Request::Add {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
        path: "new.vst3".into(),
        class_id: None,
    };
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), EXITED);
    let state = &rig.host.post_mix;
    assert_eq!(state.test_children.len(), 1, "子を作り直していない");
    assert_eq!(second_observer.spawn_count(), 0);
    assert!(state.child.is_none() && !state.restored);
    assert_eq!(serde_json::to_value(&state.saved).unwrap(), saved_before);
    assert_eq!(state.raw, raw_before, "保存した設定は変わらない");
    rig.finish();
}

// P2：C2 で終了を確かめられなかったとき、その理由（`engine_unconfirmed`）を `snapshot` まで引き継ぐ。
#[test]
fn p2_an_unconfirmed_c2_reason_is_carried_to_the_next_snapshot() {
    let mut rig = Rig::new([]);
    let gate = crate::audio::writer::sinks::Gated::default();
    {
        let child = rig.host.post_mix.child.as_mut().unwrap();
        child.replace_writer_for_test(crate::audio::writer::Writer::start(
            gate.clone(),
            child.link.clone(),
        ));
    }
    crate::audio::writer::set_limits_for_test(Some(std::time::Duration::from_millis(200)), None);
    reaper_seam::stuck();
    let request = save_request(&rig);
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    crate::audio::writer::set_limits_for_test(None, None);
    reaper_seam::real();
    gate.open();
    assert_eq!(
        error.downcast_ref::<EngineUnconfirmed>().copied(),
        Some(EngineUnconfirmed { repeated: false })
    );
    assert!(rig.host.post_mix.enabled && rig.host.post_mix.child.is_none());
    let snapshot = rig.host.post_mix(Request::Snapshot).unwrap();
    assert_eq!(
        snapshot.error.as_deref(),
        Some(engine_life::UNCONFIRMED_JA),
        "「終了しました」に変えない"
    );
    rig.finish();
}

fn rack_with_a_plugin() -> Step {
    response_line(&IpcResponse::PluginRack {
        plugins: vec![crate::ipc::RackPlugin {
            id: "existing".into(),
            path: "post.vst3".into(),
            name: "post".into(),
            enabled: true,
            muted: false,
            gain: 1.0,
            class_id: None,
            channel_layout: crate::ipc::ChannelLayout::Stereo,
        }],
        restore_eligible: true,
        revision: 1,
        running: false,
    })
}

// P1（3回目）：`rack()` の最後の確認を通った後、`command()` の前に子が終わっても、空の子を起動して
// 変更を送らない。ラックを読んだ接続へだけ送り、違えば `Engine Crashed/Exited`。
#[test]
fn p1_a_child_ending_after_the_rack_check_never_gets_replaced_for_the_change() {
    let mut rig = Rig::with_primary(
        stopped_primary(),
        [("GetPluginRack", vec![rack_with_a_plugin()])],
    );
    let (second, second_observer) = scripted_parts([]);
    let mut second = second;
    second.post_role = true;
    reaper_seam::share(&rig.host, &mut second);
    rig.host.post_mix.test_children = vec![Box::new(second)];
    rig.host.post_mix.saved = Some(Saved {
        schema_version: 1,
        role: "post_mix".into(),
        enabled: true,
        plugins: vec![plugin()],
    });
    let saved_before = serde_json::to_value(&rig.host.post_mix.saved).unwrap();
    // `command()` が送る直前（`rack()` の確認の後）に、子が終わる。
    rig.host.post_mix.between_ops = Some(Box::new(|child| {
        child.link.close(CloseCause::Eof);
    }));
    let request = Request::Add {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
        path: "new.vst3".into(),
        class_id: None,
    };
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), EXITED);
    let state = &rig.host.post_mix;
    assert_eq!(state.test_children.len(), 1, "子を作り直していない");
    assert_eq!(second_observer.spawn_count(), 0);
    assert!(state.child.is_none() && !state.restored);
    assert_eq!(serde_json::to_value(&state.saved).unwrap(), saved_before);
    assert!(rig.primary.sent().iter().all(|name| name != "LoadPlugin"));
    rig.finish();
}

// P1（3回目）：ラックを読んだ後に子がいなくなっても（接続が違う場合を含む）、同じく失敗にする。
#[test]
fn p1_a_missing_or_different_child_after_the_rack_fails_without_a_start() {
    for replaced in [false, true] {
        let mut rig = Rig::new([("GetPluginRack", vec![rack_with_a_plugin()])]);
        let (spare, spare_observer) = scripted_parts([]);
        let mut spare = spare;
        spare.post_role = true;
        reaper_seam::share(&rig.host, &mut spare);
        rig.host.post_mix.test_children = vec![Box::new(spare)];
        assert_eq!(rig.host.post_mix.rack().unwrap().len(), 1);
        if replaced {
            // 別の接続（別の子）に入れ替わった。
            let (mut other, _other_observer) = scripted_parts([]);
            other.post_role = true;
            reaper_seam::share(&rig.host, &mut other);
            other.ensure_engine_running().unwrap();
            rig.host.post_mix.child = Some(Box::new(other));
        } else {
            rig.host.post_mix.child = None;
        }
        let error = rig
            .host
            .post_mix
            .command(IpcCommand::GetPluginRack)
            .unwrap_err();
        assert_eq!(error.to_string(), EXITED);
        assert_eq!(rig.host.post_mix.test_children.len(), 1, "起動していない");
        assert_eq!(spare_observer.spawn_count(), 0);
        rig.finish();
    }
}

// P2（3回目）：`snapshot()` の最後の確認で切断を見たら、VST が入ったラックも載せない。
#[test]
fn p2_snapshot_drops_a_rack_with_plugins_when_the_last_check_sees_a_disconnect() {
    let mut rig = Rig::new([
        ("GetPluginRack", vec![rack_with_a_plugin()]),
        (
            "ProcessingState",
            vec![response_line(&IpcResponse::ProcessingState {
                present: true,
                failed: false,
            })],
        ),
    ]);
    rig.host.post_mix.between_ops = Some(Box::new(|child| {
        child.link.close(CloseCause::Eof);
    }));
    let snapshot = rig.host.post_mix.snapshot().unwrap();
    assert!(snapshot.plugins.is_empty(), "切断済みのラックを載せない");
    assert!(!snapshot.running && !snapshot.restored);
    assert_eq!(
        snapshot.error.as_deref(),
        Some("配信VSTのEngineが終了しました")
    );
    rig.finish();
}

// P2（3回目）：外の停止の確認が失敗しても、回収するのは起動を試みた主の子だけ。
// 配信ミックスの子と、オケの入力の選択は残る。
#[test]
fn p2_a_failed_start_confirmation_keeps_the_post_mix_child_and_the_mixing_selection() {
    use crate::audio_engine::mixing::Start;
    let mut rig = Rig::new([]);
    rig.host.mixing.selected = Some(Start {
        config: mixing_config("wasapi:one"),
        target: None,
    });
    crate::audio::writer::set_limits_for_test(None, Some(std::time::Duration::from_millis(500)));
    seam::set_resume(seam::Resume::ExternalSuspend(None));
    let error = rig.host.ensure_engine_running().unwrap_err();
    seam::set_resume(seam::Resume::Real);
    crate::audio::writer::set_limits_for_test(None, None);
    assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED);
    assert!(rig.host.child.is_none(), "主の子は回収されている");
    assert!(rig.host.post_mix.child.is_some(), "配信ミックスの子は残る");
    assert!(rig.host.mixing.selected.is_some(), "オケの入力の選択は残る");
    assert!(!rig.post.probe(0).exited());
    rig.finish();
}

// P2（4回目）：外の停止の起動の確認の中で、stdin の書き込みが失敗しても期限切れになっても、
// 回収するのは主の子だけ。配信ミックスの子（ラック）とオケの入力の選択は残る。
#[test]
fn p2_a_write_failure_or_timeout_during_the_start_confirmation_keeps_the_post_mix_and_mixing() {
    use crate::audio::writer::{override_next_sink_for_test, sinks::Gated, SinkOverride};
    use crate::audio_engine::mixing::Start;
    for stall in [false, true] {
        let mut rig = Rig::new([]);
        rig.host.mixing.selected = Some(Start {
            config: mixing_config("wasapi:one"),
            target: None,
        });
        let gate = Gated::default();
        override_next_sink_for_test(if stall {
            SinkOverride::Stall(gate.clone())
        } else {
            SinkOverride::Fail
        });
        crate::audio::writer::set_limits_for_test(
            Some(std::time::Duration::from_millis(200)),
            Some(std::time::Duration::from_millis(500)),
        );
        seam::set_resume(seam::Resume::ExternalSuspend(None));
        let error = rig.host.ensure_engine_running().unwrap_err();
        seam::set_resume(seam::Resume::Real);
        crate::audio::writer::set_limits_for_test(None, None);
        gate.open();
        let label = format!("stall={stall}: {error}");
        assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED, "{label}");
        assert!(rig.host.child.is_none(), "{label}: 主の子は回収されている");
        assert!(
            rig.host.post_mix.child.is_some(),
            "{label}: 配信ミックスの子"
        );
        assert!(
            rig.host.post_mix.restored && rig.host.post_mix.enabled,
            "{label}: 配信ミックスのラック"
        );
        assert!(rig.host.mixing.selected.is_some(), "{label}: オケの入力");
        rig.finish();
    }
}

// P2（4回目・新しい順）：配信ミックスは、接続（`LinkState`）が閉じたら、待ち（`ReplySlot`）がまだ開いていても切断として扱う。
#[test]
fn p2_a_closed_link_with_an_open_slot_is_a_disconnect_for_the_post_mix() {
    // `snapshot`：理由つきの成功。
    let mut rig = Rig::new([]);
    rig.host
        .post_mix
        .child
        .as_ref()
        .unwrap()
        .link
        .close(CloseCause::Eof);
    let snapshot = rig.host.post_mix.snapshot().unwrap();
    assert_eq!(
        snapshot.error.as_deref(),
        Some("配信VSTのEngineが終了しました")
    );
    assert!(!snapshot.restored && rig.host.post_mix.child.is_none());
    assert!(rig.host.post_mix.enabled);
    rig.finish();

    // 変更を送るとき（ラックを読んだ後で接続が閉じる）：失敗にして、`enabled` を残す。
    let mut rig = Rig::with_primary(
        stopped_primary(),
        [("GetPluginRack", vec![rack_with_a_plugin()])],
    );
    rig.host.post_mix.between_ops = Some(Box::new(|child| {
        child.link.close(CloseCause::Eof);
    }));
    let request = Request::Add {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
        path: "new.vst3".into(),
        class_id: None,
    };
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), EXITED);
    let state = &rig.host.post_mix;
    assert!(state.enabled && !state.restored && state.child.is_none());
    assert!(state.error.is_none(), "切断として扱う");
    rig.finish();
}

fn empty_rack() -> Step {
    response_line(&IpcResponse::PluginRack {
        plugins: Vec::new(),
        restore_eligible: true,
        revision: 1,
        running: false,
    })
}

// P1（5回目）：最後の `GetPluginRack` の応答の後に接続が閉じたら、切断済みの取得結果で
// 保存せず、保存のファイルは変わらない（`enabled` は残る）。
#[test]
fn p1_save_never_overwrites_the_saved_file_after_a_late_link_close() {
    let mut rig = Rig::new([("GetPluginRack", vec![empty_rack()])]);
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = calls.clone();
    // 1回目（前の GetPluginRack）は何もせず、2回目（最後の GetPluginRack）の後に待ちだけを閉じる。
    rig.host.post_mix.after_exec_check = Some(Box::new(move |child| {
        if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            child.link.close(CloseCause::Eof);
        }
    }));
    let path = rig.host.post_mix.path.clone();
    let request = save_request(&rig);
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), EXITED);
    let state = &rig.host.post_mix;
    assert!(!path.exists(), "保存のファイルを作っていない");
    assert!(state.raw.is_none() && state.saved.is_none());
    assert!(state.enabled && !state.restored && state.child.is_none());
    assert!(state.error.is_none(), "切断として扱う");
    rig.finish();
}

// P2（5回目）：`Enable(true)` の事前の確認で切断を見つけたら、切断の後処理を通して `enabled` を残す。
#[test]
fn p2_enable_true_keeps_enabled_when_the_precheck_finds_a_disconnect() {
    use crate::audio_engine::mixing::Start;
    let mut rig = Rig::with_primary(stopped_primary(), []);
    rig.host.mixing.selected = Some(Start {
        config: mixing_config("wasapi:one"),
        target: None,
    });
    rig.host
        .post_mix
        .child
        .as_ref()
        .unwrap()
        .link
        .close(CloseCause::Eof);
    let request = Request::Enable {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
        enabled: true,
    };
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert!(error.to_string().contains("明示的に復元"), "{error}");
    let state = &rig.host.post_mix;
    assert!(state.enabled, "enabled を残す");
    assert!(state.child.is_none() && !state.restored);
    assert!(state.error.is_none(), "切断として扱う");
    assert_eq!(
        rig.host
            .post_mix(Request::Snapshot)
            .unwrap()
            .error
            .as_deref(),
        Some("配信VSTのEngineが終了しました")
    );
    rig.finish();
}

// 6回目：公開の操作の失敗の処理は、子の接続が閉じていれば、どの段で見つけた失敗でも、切断の後処理
// （`enabled` を残す）を通す。ここでは切断とは別の理由（空のパス）で失敗するが、接続は閉じている。
#[test]
fn p3_any_failure_with_a_closed_link_keeps_enabled_through_the_disconnect_cleanup() {
    let mut rig = Rig::with_primary(stopped_primary(), []);
    assert!(rig
        .host
        .post_mix
        .child
        .as_ref()
        .unwrap()
        .link
        .close(CloseCause::Eof));
    let request = Request::Add {
        expected_epoch: rig.host.post_mix.epoch.clone(),
        expected_revision: rig.host.post_mix.revision.to_string(),
        path: String::new(),
        class_id: None,
    };
    let error = rig.host.post_mix(request).map(|_| ()).unwrap_err();
    assert!(error.to_string().contains("追加できません"), "{error}");
    let state = &rig.host.post_mix;
    assert!(state.enabled, "enabled を残す");
    assert!(state.child.is_none() && !state.restored);
    assert!(state.error.is_none());
    rig.finish();
}
