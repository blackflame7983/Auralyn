//! 配信ミックスの子の寿命の試験（W2 の配信ミックスの入口、J-13 の数え方、B40a）。
//! 子の `AudioHost` は、主の `AudioHost` の記録（`retired`）を共有する。
use super::*;
use crate::audio::compat_support::*;
use crate::audio::engine_life::{seam, EngineUnconfirmed, Role};

const FIRST_FINAL: &str =
    "音声エンジンの終了を確認できません。しばらくしてからもう一度お試しください";

struct Rig {
    host: AudioHost,
    post: Observer,
    primary: Observer,
}

impl Rig {
    fn new(post_overrides: impl IntoIterator<Item = (&'static str, Vec<Step>)>) -> Self {
        let (mut host, primary) = scripted_parts([]);
        let (mut child, post) = scripted_parts(post_overrides);
        child.post_role = true;
        child.retired = host.retired.clone();
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
        self.host.retired.pending(role)
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
    seam::set_wait(seam::Wait::Stuck);
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
    seam::set_wait(seam::Wait::Stuck);
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
    seam::set_wait(seam::Wait::Stuck);
    let child = rig.host.post_mix.child.as_mut().unwrap();
    child.stdin = None;
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
    seam::set_wait(seam::Wait::Stuck);
    let child = rig.host.post_mix.child.as_mut().unwrap();
    child.reader_active.store(false, Ordering::Release);
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
    seam::set_wait(seam::Wait::Stuck);
    rig.host.post_mix.kill();
    assert_eq!(rig.pending(Role::PostMix), 1);
    rig.finish();

    let mut rig = Rig::new([]);
    seam::set_wait(seam::Wait::Stuck);
    let root = rig.primary.dir.clone();
    rig.host.post_mix = State::new(&root, rig.host.retired.clone());
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
    seam::set_wait(seam::Wait::Stuck);
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
    seam::set_wait(seam::Wait::Real);
    assert!(
        rig.host.retired.recheck().is_ok(),
        "後で終われば、次の要求で作れる"
    );
    assert_eq!(rig.pending(Role::PostMix), 0);
    rig.finish();
}

// J-13：記録ごとに数え、どれかが3以上なら3回目以降の文言。主と配信ミックスは別の記録。
#[test]
fn j13_counts_per_record_and_any_record_at_three_switches_the_message() {
    let mut rig = Rig::new([]);
    rig.host.ensure_engine_running().unwrap();
    seam::set_wait(seam::Wait::Stuck);
    rig.host.kill_engine();
    assert_eq!(rig.pending(Role::Primary), 1);
    assert_eq!(rig.pending(Role::PostMix), 1);
    for _ in 0..2 {
        rig.host.ensure_engine_running().unwrap_err();
    }
    assert_eq!(rig.host.retired.counts(Role::Primary), [2]);
    let error = rig.host.post_mix.child().map(|_| ()).unwrap_err();
    assert_eq!(error.to_string(), FIRST_FINAL, "最大の数は2");
    assert_eq!(rig.host.retired.counts(Role::PostMix), [1]);
    let error = rig.host.ensure_engine_running().unwrap_err();
    assert!(error.downcast_ref::<EngineUnconfirmed>().unwrap().repeated);
    let error = rig.host.post_mix.child().map(|_| ()).unwrap_err();
    assert!(
        error.to_string().starts_with(engine_life::REPEATED_JA),
        "配信ミックスの記録は2でも、主の記録が3なので3回目以降の文言"
    );
    assert_eq!(rig.host.retired.counts(Role::PostMix), [2]);
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
            host.post_mix = State::new(&root, host.retired.clone());
            host.mixing.selected = Some(Start {
                config: mixing_config("wasapi:one"),
                target: None,
            });
            host.is_global_muted = true;
            post_child.post_role = true;
            post_child.retired = host.retired.clone();
            post_child.ensure_engine_running().unwrap();
            host.post_mix.child = Some(Box::new(post_child));
            host.post_mix.restored = true;
            let (_, witness) = host.capture_bundle_mixing().unwrap();
            seam::set_wait(seam::Wait::Stuck);
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
                host.retired.pending(Role::PostMix),
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
