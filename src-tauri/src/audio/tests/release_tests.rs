//! 解放（Release）・要求で種類を決める入口・異常終了の回収・トレイのミュート（F1b-0b-2b。12章）の試験
//! Y13（トレイ）・Y25・Y27・Y30・Y32・Y35。
use super::control::request_class as classes;
use super::control::{ActorPoint, AudioControl, ControlError, Entry, EntryKind, Phase};
use super::queue_support::*;
use super::*;
use crate::audio_engine::voice_check::preview;
use crate::audio_engine::{auto_gain, builtin, core::noise_learning, live_modes};
use crate::ipc::{RestorePluginRequest, SessionRackRequest};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

fn begin(control: &AudioControl, entry: Entry) -> String {
    control
        .run(entry, |host| {
            host.begin_live_changes().map_err(|e| e.to_string())
        })
        .unwrap()
        .unwrap()
}

fn end(token: String) -> impl FnOnce(&mut AudioHost) -> Result<(), String> + Send + 'static {
    move |host| host.end_live_changes(token).map_err(|e| e.to_string())
}

// Y25：取得（Normal）を通した後は、列が満杯でも、受付から期限が過ぎても、解放（Release）は断られず、
// 取り消されず、実行される。実際の`Ticket::run`を通す。
#[test]
fn y25_a_release_survives_a_full_queue_and_an_expired_wait() {
    let control = limited(2, WAIT);
    let token = begin(&control, cmd("begin_live_changes"));
    assert_eq!(
        run_under_pressure(&control, cmd("end_live_changes"), end(token)),
        Ok(Ok(())),
        "単独のコマンドの解放"
    );
    let token = begin(&control, Entry::bundle("begin_live_changes_bundle"));
    assert_eq!(
        run_under_pressure(
            &control,
            Entry::bundle("end_live_changes_bundle"),
            end(token)
        ),
        Ok(Ok(())),
        "配信セットの解放。予約が消えて、次の取得が通る"
    );
    let token = begin(&control, cmd("begin_live_changes"));
    control
        .run(cmd("end_live_changes"), end(token))
        .unwrap()
        .unwrap();
}

#[test]
fn y25_a_refused_acquisition_takes_no_reservation() {
    let control = limited(2, WAIT);
    let hold = hold(&control);
    control.post(normal(), |_| ()).unwrap();
    control.post(normal(), |_| ()).unwrap();
    assert!(matches!(
        control.run(cmd("begin_live_changes"), |host| host
            .begin_live_changes()
            .is_ok()),
        Err(ControlError::Busy)
    ));
    hold.release();
    control.run(release_entry(), |_| ()).unwrap();
    let token = begin(&control, cmd("begin_live_changes"));
    control
        .run(cmd("end_live_changes"), end(token))
        .unwrap()
        .unwrap();
}

#[test]
fn y25_the_update_release_clears_maintenance_under_pressure() {
    let control = limited(2, WAIT);
    let update = |name: &'static str| Entry::new(EntryKind::Update, name);
    control
        .run(update("prepare_update"), |host| {
            host.prepare_update().map_err(|e| e.to_string())
        })
        .unwrap()
        .unwrap();
    assert!(control.run(normal(), |host| host.maintenance).unwrap());
    let finished = run_under_pressure(&control, update("finish_update_attempt"), |host| {
        host.finish_update_attempt();
    });
    assert_eq!(finished, Ok(()));
    assert!(
        !control.run(normal(), |host| host.maintenance).unwrap(),
        "インストールの失敗・満杯・期限切れが重なっても、メンテナンスが下りる"
    );
    let hold = hold(&control);
    control.post(normal(), |_| ()).unwrap();
    control.post(normal(), |_| ()).unwrap();
    assert_eq!(
        control.run(update("prepare_update"), |host| host.maintenance),
        Err(ControlError::Busy)
    );
    hold.release();
    control.run(release_entry(), |_| ()).unwrap();
    assert!(
        !control.run(normal(), |host| host.maintenance).unwrap(),
        "断られた取得は、メンテナンスを立てない"
    );
}

fn count(log: &Log, name: &str) -> usize {
    entries(log)
        .iter()
        .filter(|entry| entry.starts_with(name))
        .count()
}

// Y27：実行のスレッドの異常終了で、停止の列・通常の列・取り出し直後の`current`（断る仕事を含む）の
// すべての`run`が`Stopped`で戻り、`post`は`Stopped`で1回だけ呼ばれる。
#[test]
fn y27_an_abnormal_exit_releases_every_run_in_both_lanes() {
    let control = control();
    let hold = hold(&control);
    let takes = Arc::new(AtomicUsize::new(0));
    let counter = takes.clone();
    control.set_actor_seam(Arc::new(move |at| {
        if at == ActorPoint::AfterTake && counter.fetch_add(1, Ordering::SeqCst) == 0 {
            panic!("the test seam panicked after the first take");
        }
    }));
    let calls = log();
    let mut runs = Vec::new();
    for (entry, expected_len) in [
        (mute_entry(), 1),
        (mute_entry(), 2),
        (starting(), 3),
        (normal(), 4),
    ] {
        runs.push(spawn_run(&control, entry));
        wait_len(&control, expected_len);
    }
    control
        .post(mute_entry(), record_into(&calls, "stop-lane-post"))
        .unwrap();
    control
        .post(normal(), record_into(&calls, "regular-post"))
        .unwrap();
    wait_len(&control, 6);
    hold.release();
    for run in runs {
        assert_eq!(
            join("a waiting run returns", run),
            Err(ControlError::Stopped)
        );
    }
    wait_until("both posts are called", || entries(&calls).len() == 2);
    assert_eq!(
        entries(&calls),
        ["stop-lane-post:Stopped", "regular-post:Stopped"]
    );
    assert_eq!(control.run(normal(), |_| ()), Err(ControlError::Stopped));
    assert_eq!(count(&calls, "stop-lane-post"), 1);
}

#[test]
fn y27_a_refused_job_taken_into_current_is_released_too() {
    let control = control();
    let hold = hold(&control);
    let takes = Arc::new(AtomicUsize::new(0));
    let counter = takes.clone();
    control.set_actor_seam(Arc::new(move |at| {
        if at == ActorPoint::AfterTake && counter.fetch_add(1, Ordering::SeqCst) == 1 {
            panic!("the test seam panicked after taking the refused job");
        }
    }));
    let refused = spawn_run(&control, starting());
    wait_len(&control, 1);
    let stopping = spawn_run(&control, stop_entry());
    wait_len(&control, 2);
    let rest = spawn_run(&control, normal());
    wait_len(&control, 3);
    let calls = log();
    control.post(normal(), record_into(&calls, "post")).unwrap();
    wait_len(&control, 4);
    hold.release();
    assert_eq!(join("the stop returns", stopping), Ok(()));
    assert_eq!(
        join("the refused run returns", refused),
        Err(ControlError::Stopped),
        "断る仕事が current にあるときの異常終了では、断りの返事ではなく回収で解放される"
    );
    assert_eq!(join("the rest returns", rest), Err(ControlError::Stopped));
    wait_until("the post is called", || !entries(&calls).is_empty());
    assert_eq!(entries(&calls), ["post:Stopped"]);
}

#[test]
fn y27_a_panic_just_before_the_refusal_reply_releases_the_waiting_run() {
    let control = control();
    let hold = hold(&control);
    let armed = Arc::new(AtomicBool::new(true));
    control.set_actor_seam(Arc::new(move |at| {
        if at == ActorPoint::BeforeReply && armed.swap(false, Ordering::SeqCst) {
            panic!("the test seam panicked before the refusal reply");
        }
    }));
    let refused = spawn_run(&control, starting());
    wait_len(&control, 1);
    control.post(stop_entry(), |_| ()).unwrap();
    let rest = spawn_run(&control, normal());
    wait_len(&control, 3);
    hold.release();
    assert_eq!(
        join("the refused run returns", refused),
        Err(ControlError::Stopped)
    );
    assert_eq!(
        join("the rest returns", rest),
        Err(ControlError::Poisoned),
        "閉包の外の panic ではなく、実行のスレッドは生きているので、以後は Poisoned"
    );
}

// Y30：解放は通常の列のまま。同じ呼び出し側の「取得→適用→解放」の順を保ち、前に受け付けた無関係な操作を
// 追い越さない。長い閉包の後ろでも、無期限に待って実行される。
#[test]
fn y30_a_release_stays_in_the_normal_lane_and_keeps_the_callers_order() {
    let control = control();
    let hold = hold(&control);
    let order = log();
    control
        .post(
            cmd("get_engine_runtime_stats"),
            record_into(&order, "unrelated"),
        )
        .unwrap();
    control
        .post(cmd("begin_live_changes"), record_into(&order, "begin"))
        .unwrap();
    control
        .post(cmd("apply_profile"), record_into(&order, "apply"))
        .unwrap();
    control
        .post(cmd("end_live_changes"), record_into(&order, "end"))
        .unwrap();
    control
        .post(mute_entry(), record_into(&order, "mute"))
        .unwrap();
    hold.release();
    control.run(normal(), |_| ()).unwrap();
    assert_eq!(
        entries(&order),
        ["mute:ok", "unrelated:ok", "begin:ok", "apply:ok", "end:ok"],
        "解放は停止の列へ入らず、前に受け付けた操作を追い越さない"
    );
}

#[test]
fn y30_a_release_waits_without_a_deadline_behind_a_long_closure() {
    let control = limited(256, WAIT);
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let runner = control.clone();
    let long = std::thread::spawn(move || {
        runner.run(starting(), move |_| {
            let _ = entered_tx.send(());
            std::thread::sleep(WAIT * 4);
        })
    });
    entered_rx
        .recv_timeout(GATE)
        .expect("長い閉包が始まらなかった");
    let release = spawn_run(&control, release_entry());
    assert_eq!(join("the long closure returns", long), Ok(()));
    assert_eq!(
        join("the release returns", release),
        Ok(()),
        "受付から期限を過ぎても、解放は取り消されず実行される"
    );
}

fn json<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn rack_add() -> SessionRackRequest {
    SessionRackRequest::Add {
        token: "t".into(),
        request: RestorePluginRequest {
            path: "p.vst3".into(),
            state: None,
            bypassed: false,
            muted: false,
            gain: 1.0,
            class_id: None,
        },
    }
}

fn rack_begin() -> SessionRackRequest {
    SessionRackRequest::Begin {
        explicit: true,
        generation: "g".into(),
        revision: "r".into(),
        ids: Vec::new(),
        input_gain: 1.0,
        output_gain: 1.0,
    }
}

fn preview_request(action: preview::Action) -> preview::Request {
    preview::Request {
        client_id: "c".into(),
        session_id: 1,
        operation_id: 1,
        epoch: None,
        action,
    }
}

fn live_intent() -> live_modes::Intent {
    live_modes::Intent {
        client_id: "c".into(),
        sequence: 1,
        expected_epoch: "e".into(),
    }
}

/// `(ラベル, 入口, 停止より前の受付を断るか)`。入口は本番と同じく、要求から種類を決めて渡す。
fn request_cases() -> Vec<(&'static str, Entry, bool)> {
    let post_mix =
        |value: serde_json::Value| cmd("post_mix").class(classes::post_mix(&json(value)));
    let mixing = |value: serde_json::Value| cmd("mixing").class(classes::mixing(&json(value)));
    let witness = || serde_json::json!({"expectedEpoch": "e", "expectedRevision": "r"});
    let with_witness = |action: &str, extra: serde_json::Value| {
        let mut value = witness();
        value["action"] = action.into();
        if let (Some(map), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            map.extend(extra.clone());
        }
        value
    };
    vec![
        (
            "post_mix(Snapshot)",
            post_mix(serde_json::json!({"action": "snapshot"})),
            false,
        ),
        (
            "post_mix(RestoreSaved)",
            post_mix(with_witness("restore_saved", serde_json::json!({}))),
            true,
        ),
        (
            "post_mix(Add)",
            post_mix(with_witness("add", serde_json::json!({"path": "p.vst3"}))),
            true,
        ),
        (
            "post_mix(Remove)",
            post_mix(with_witness("remove", serde_json::json!({"id": "x"}))),
            false,
        ),
        (
            "mixing(Snapshot)",
            mixing(serde_json::json!({"action": "snapshot"})),
            false,
        ),
        (
            "mixing(Reset)",
            mixing(with_witness("reset", serde_json::json!({}))),
            false,
        ),
        (
            "mixing(Configure)",
            mixing(with_witness(
                "configure",
                serde_json::json!({"config": null, "candidateId": null}),
            )),
            true,
        ),
        (
            "live_modes(Snapshot)",
            cmd("live_modes").class(classes::live_modes(&live_modes::Request::Snapshot)),
            false,
        ),
        (
            "live_modes(SingingOn)",
            cmd("live_modes").class(classes::live_modes(&live_modes::Request::SingingOn {
                intent: live_intent(),
            })),
            true,
        ),
        (
            "live_modes(TalkOn)",
            cmd("live_modes").class(classes::live_modes(&live_modes::Request::TalkOn {
                intent: live_intent(),
            })),
            true,
        ),
        (
            "session_rack(Snapshot)",
            cmd("session_rack").class(classes::session_rack(&SessionRackRequest::Snapshot)),
            false,
        ),
        (
            "session_rack(Add)",
            cmd("session_rack").class(classes::session_rack(&rack_add())),
            false,
        ),
        (
            "session_rack(Begin)",
            cmd("session_rack").class(classes::session_rack(&rack_begin())),
            true,
        ),
        (
            "builtin_effects(Snapshot)",
            cmd("builtin_effects").class(classes::builtin_effects(&json(
                serde_json::json!({"action": "snapshot"}),
            ))),
            false,
        ),
        (
            "auto_gain(Status)",
            cmd("auto_gain").class(classes::auto_gain(&auto_gain::Request::Status)),
            false,
        ),
        (
            "auto_gain(Apply)",
            cmd("auto_gain").class(classes::auto_gain(&auto_gain::Request::Apply {
                id: 1,
                revision: 1,
            })),
            true,
        ),
        (
            "noise_measurement(Snapshot)",
            cmd("noise_measurement").class(classes::noise_measurement(
                &noise_learning::Request::Snapshot,
            )),
            false,
        ),
        (
            "noise_measurement(Start)",
            cmd("noise_measurement").class(classes::noise_measurement(
                &noise_learning::Request::Start {
                    epoch: "e".into(),
                    generation: "g".into(),
                },
            )),
            true,
        ),
        (
            "peak_protection(None)",
            cmd("peak_protection").class(classes::peak_protection::<()>(&None)),
            false,
        ),
        (
            "peak_protection(Some)",
            cmd("peak_protection").class(classes::peak_protection(&Some(()))),
            true,
        ),
        (
            "voice_check_preview(Status)",
            cmd("voice_check_preview").class(classes::voice_check_preview(&preview_request(
                preview::Action::Status,
            ))),
            false,
        ),
        (
            "voice_check_preview(Start)",
            cmd("voice_check_preview").class(classes::voice_check_preview(&preview_request(
                preview::Action::Start {
                    recording_id: 1,
                    device_id: "d".into(),
                    candidate_id: None,
                    options: preview::Options::default(),
                },
            ))),
            true,
        ),
        (
            "audio_frontend_bootstrap(without config)",
            cmd("audio_frontend_bootstrap").class(classes::frontend_bootstrap(&json(
                serde_json::json!({"config": null, "inputGain": 1.0, "outputGain": 1.0}),
            ))),
            false,
        ),
    ]
}

// Y32：要求で種類を決める入口は、読み取りの要求なら、停止より前に受け付けても断られず、適用の要求なら断られる。
#[test]
fn y32_request_dependent_entries_get_their_class_from_the_request() {
    for (label, entry, refused) in request_cases() {
        let control = control();
        let hold = hold(&control);
        let order = log();
        control.post(entry, record_into(&order, "request")).unwrap();
        control.post(stop_entry(), |_| ()).unwrap();
        hold.release();
        control.run(normal(), |_| ()).unwrap();
        let expected = if refused {
            "request:StoppedFirst"
        } else {
            "request:ok"
        };
        assert_eq!(entries(&order), [expected], "{label}");
    }
}

// Y21：要求の種類の結果を、実際の要求の値で固定する。取得は Starting、解除は Release。
// 変種の網羅は各関数の`match`が保証する（要求を足すとコンパイルが落ちる）。
#[test]
fn y21_request_classes_are_pinned_for_starting_and_release_requests() {
    use super::control::JobClass::{Normal, Release, Starting};
    let witnessed = |action: &str, extra: serde_json::Value| {
        let mut value = serde_json::json!({
            "action": action, "expectedEpoch": "e", "expectedRevision": "r"
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    };
    let none = || serde_json::json!({});
    let builtin_config = serde_json::to_value(builtin::Config::default()).unwrap();
    let builtin = |action: &str, extra: serde_json::Value| {
        let mut value =
            serde_json::json!({"action": action, "epoch": "e", "expectedRevision": "r"});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json::<builtin::Request>(value)
    };
    let intent = live_intent;
    let preview = |action| classes::voice_check_preview(&preview_request(action));
    let options = preview::Options::default;
    let candidate_variant = || json(serde_json::json!("current"));
    let auto = |request| classes::auto_gain(&request);
    let noise = |request| classes::noise_measurement(&request);
    let epoch_generation = || ("e".to_string(), "g".to_string());
    let (epoch, generation) = epoch_generation();
    let bootstrap = |config: serde_json::Value| {
        classes::frontend_bootstrap(&json(
            serde_json::json!({"config": config, "inputGain": 1.0, "outputGain": 1.0}),
        ))
    };
    let host = |host: &str| serde_json::json!({"host": host, "input": null, "output": null, "bufferSize": null, "sampleRate": null, "inputChannels": null});
    let cases = vec![
        (
            "post_mix(Snapshot)",
            classes::post_mix(&json(serde_json::json!({"action": "snapshot"}))),
            Normal,
        ),
        (
            "post_mix(RestoreSaved)",
            classes::post_mix(&json(witnessed("restore_saved", none()))),
            Starting,
        ),
        (
            "post_mix(Add)",
            classes::post_mix(&json(witnessed(
                "add",
                serde_json::json!({"path": "p.vst3"}),
            ))),
            Starting,
        ),
        (
            "post_mix(Save)",
            classes::post_mix(&json(witnessed("save", none()))),
            Normal,
        ),
        (
            "mixing(Configure)",
            classes::mixing(&json(witnessed(
                "configure",
                serde_json::json!({"config": null, "candidateId": null}),
            ))),
            Starting,
        ),
        (
            "mixing(Reset)",
            classes::mixing(&json(witnessed("reset", none()))),
            Normal,
        ),
        (
            "live_modes(Snapshot)",
            classes::live_modes(&live_modes::Request::Snapshot),
            Normal,
        ),
        (
            "live_modes(Recover)",
            classes::live_modes(&live_modes::Request::Recover {
                expected_epoch: "e".into(),
            }),
            Starting,
        ),
        (
            "live_modes(SingingOn)",
            classes::live_modes(&live_modes::Request::SingingOn { intent: intent() }),
            Starting,
        ),
        (
            "live_modes(TalkOn)",
            classes::live_modes(&live_modes::Request::TalkOn { intent: intent() }),
            Starting,
        ),
        (
            "live_modes(Arm)",
            classes::live_modes(&live_modes::Request::Arm { intent: intent() }),
            Starting,
        ),
        (
            "live_modes(Disarm)",
            classes::live_modes(&live_modes::Request::Disarm { intent: intent() }),
            Release,
        ),
        (
            "session_rack(Snapshot)",
            classes::session_rack(&SessionRackRequest::Snapshot),
            Normal,
        ),
        (
            "session_rack(Add)",
            classes::session_rack(&rack_add()),
            Normal,
        ),
        (
            "session_rack(Begin)",
            classes::session_rack(&rack_begin()),
            Starting,
        ),
        (
            "session_rack(Finish)",
            classes::session_rack(&SessionRackRequest::Finish { token: "t".into() }),
            Release,
        ),
        (
            "builtin_effects(Snapshot)",
            classes::builtin_effects(&builtin::Request::Snapshot),
            Normal,
        ),
        (
            "builtin_effects(Apply)",
            classes::builtin_effects(&builtin(
                "apply",
                serde_json::json!({"config": builtin_config}),
            )),
            Starting,
        ),
        (
            "builtin_effects(ApplyProposal)",
            classes::builtin_effects(&builtin(
                "apply_proposal",
                serde_json::json!({"proposalId": "p", "recordingId": 1}),
            )),
            Starting,
        ),
        (
            "builtin_effects(Undo)",
            classes::builtin_effects(&builtin("undo", serde_json::json!({"undoToken": "t"}))),
            Starting,
        ),
        (
            "builtin_effects(Redo)",
            classes::builtin_effects(&builtin("redo", serde_json::json!({"redoToken": "t"}))),
            Starting,
        ),
        (
            "auto_gain(Status)",
            auto(auto_gain::Request::Status),
            Normal,
        ),
        (
            "auto_gain(Devices)",
            auto(auto_gain::Request::Devices),
            Normal,
        ),
        (
            "auto_gain(Initialize)",
            auto(auto_gain::Request::Initialize { value: 1.0 }),
            Starting,
        ),
        (
            "auto_gain(Begin)",
            auto(auto_gain::Request::Begin {
                target: -23.0,
                revision: 1,
            }),
            Starting,
        ),
        (
            "auto_gain(Cancel)",
            auto(auto_gain::Request::Cancel),
            Release,
        ),
        (
            "auto_gain(Preview)",
            auto(auto_gain::Request::Preview {
                id: 1,
                after: true,
                device: "d".into(),
            }),
            Starting,
        ),
        (
            "auto_gain(StopPreview)",
            auto(auto_gain::Request::StopPreview),
            Release,
        ),
        (
            "auto_gain(Apply)",
            auto(auto_gain::Request::Apply { id: 1, revision: 1 }),
            Starting,
        ),
        (
            "auto_gain(UndoHistory)",
            auto(auto_gain::Request::UndoHistory {
                id: 1,
                revision: 1,
                epoch: "e".into(),
            }),
            Starting,
        ),
        (
            "auto_gain(RedoHistory)",
            auto(auto_gain::Request::RedoHistory {
                id: 1,
                revision: 1,
                epoch: "e".into(),
            }),
            Starting,
        ),
        (
            "auto_gain(Restore)",
            auto(auto_gain::Request::Restore { id: 1, revision: 1 }),
            Starting,
        ),
        (
            "noise_measurement(Snapshot)",
            noise(noise_learning::Request::Snapshot),
            Normal,
        ),
        (
            "noise_measurement(Start)",
            noise(noise_learning::Request::Start {
                epoch: epoch.clone(),
                generation: generation.clone(),
            }),
            Starting,
        ),
        (
            "noise_measurement(Cancel)",
            noise(noise_learning::Request::Cancel {
                epoch: epoch.clone(),
                generation: generation.clone(),
            }),
            Release,
        ),
        (
            "noise_measurement(Invalidate)",
            noise(noise_learning::Request::Invalidate),
            Release,
        ),
        (
            "noise_measurement(Approve)",
            noise(noise_learning::Request::Approve {
                epoch,
                generation,
                acknowledged_quiet: true,
            }),
            Normal,
        ),
        (
            "voice_check_preview(Status)",
            preview(preview::Action::Status),
            Normal,
        ),
        (
            "voice_check_preview(Start)",
            preview(preview::Action::Start {
                recording_id: 1,
                device_id: "d".into(),
                candidate_id: None,
                options: options(),
            }),
            Starting,
        ),
        (
            "voice_check_preview(Update)",
            preview(preview::Action::Update { options: options() }),
            Starting,
        ),
        (
            "voice_check_preview(PrepareNoise)",
            preview(preview::Action::PrepareNoise {
                recording_id: 1,
                expected_basis: "b".into(),
                variant: candidate_variant(),
            }),
            Starting,
        ),
        (
            "voice_check_preview(ApplyNoise)",
            preview(preview::Action::ApplyNoise {
                candidate_id: "c".into(),
                expected_basis: "b".into(),
            }),
            Starting,
        ),
        (
            "voice_check_preview(UndoNoise)",
            preview(preview::Action::UndoNoise { token: "t".into() }),
            Starting,
        ),
        (
            "voice_check_preview(RedoNoise)",
            preview(preview::Action::RedoNoise { token: "t".into() }),
            Starting,
        ),
        (
            "voice_check_preview(PrepareCandidate)",
            preview(preview::Action::PrepareCandidate {
                recording_id: 1,
                expected_revision: "r".into(),
                config: builtin::Config::default(),
            }),
            Starting,
        ),
        (
            "voice_check_preview(PrepareProposal)",
            preview(preview::Action::PrepareProposal {
                rule_version: None,
                preferences: None,
                preferences_revision: None,
                recording_id: 1,
                builtin_epoch: "e".into(),
                expected_revision: "r".into(),
            }),
            Starting,
        ),
        (
            "voice_check_preview(CandidateStatus)",
            preview(preview::Action::CandidateStatus {
                candidate_id: "c".into(),
            }),
            Normal,
        ),
        (
            "voice_check_preview(CancelCandidate)",
            preview(preview::Action::CancelCandidate {
                candidate_id: "c".into(),
            }),
            Release,
        ),
        (
            "voice_check_preview(Stop)",
            preview(preview::Action::Stop),
            Release,
        ),
        (
            "voice_check_preview(Close)",
            preview(preview::Action::Close),
            Release,
        ),
        (
            "audio_frontend_bootstrap(with config)",
            bootstrap(host("wasapi")),
            Starting,
        ),
        (
            "audio_frontend_bootstrap(empty host)",
            bootstrap(host("")),
            Normal,
        ),
        (
            "audio_frontend_bootstrap(none)",
            bootstrap(serde_json::Value::Null),
            Normal,
        ),
        (
            "peak_protection(None)",
            classes::peak_protection::<()>(&None),
            Normal,
        ),
        (
            "peak_protection(Some)",
            classes::peak_protection(&Some(())),
            Starting,
        ),
        (
            "broadcast_true_peak(None)",
            classes::broadcast_true_peak::<()>(&None),
            Normal,
        ),
        (
            "broadcast_true_peak(Some)",
            classes::broadcast_true_peak(&Some(())),
            Starting,
        ),
        (
            "live_output(None)",
            classes::live_output::<()>(&None),
            Normal,
        ),
        (
            "live_output(Some)",
            classes::live_output(&Some(())),
            Starting,
        ),
        (
            "set_channel_scan(true)",
            classes::set_channel_scan(true),
            Starting,
        ),
        (
            "set_channel_scan(false)",
            classes::set_channel_scan(false),
            Release,
        ),
        (
            "set_loudness_measurement(Some)",
            classes::set_loudness_measurement(&Some(1)),
            Starting,
        ),
        (
            "set_loudness_measurement(None)",
            classes::set_loudness_measurement(&None),
            Release,
        ),
    ];
    for (label, actual, expected) in cases {
        assert_eq!(actual, expected, "{label}");
    }
}

/// `(解除の入口, 取得の入口)`。解除は満杯・期限切れの下で断られず、取得は断られる。
fn release_pairs() -> Vec<(&'static str, Entry, Entry)> {
    let auto = |request: auto_gain::Request| cmd("auto_gain").class(classes::auto_gain(&request));
    let voice = |action: preview::Action| {
        cmd("voice_check_preview").class(classes::voice_check_preview(&preview_request(action)))
    };
    let noise = |request: noise_learning::Request| {
        cmd("noise_measurement").class(classes::noise_measurement(&request))
    };
    let start = || preview::Action::Start {
        recording_id: 1,
        device_id: "d".into(),
        candidate_id: None,
        options: preview::Options::default(),
    };
    vec![
        (
            "auto_gain(Cancel)",
            auto(auto_gain::Request::Cancel),
            auto(auto_gain::Request::Begin {
                target: -23.0,
                revision: 1,
            }),
        ),
        (
            "auto_gain(StopPreview)",
            auto(auto_gain::Request::StopPreview),
            auto(auto_gain::Request::Preview {
                id: 1,
                after: true,
                device: "d".into(),
            }),
        ),
        (
            "voice_check_preview(Stop)",
            voice(preview::Action::Stop),
            voice(start()),
        ),
        (
            "voice_check_preview(Close)",
            voice(preview::Action::Close),
            voice(start()),
        ),
        (
            "voice_check_preview(CancelCandidate)",
            voice(preview::Action::CancelCandidate {
                candidate_id: "c".into(),
            }),
            voice(preview::Action::PrepareNoise {
                recording_id: 1,
                expected_basis: "b".into(),
                variant: json(serde_json::json!("current")),
            }),
        ),
        (
            "noise_measurement(Cancel)",
            noise(noise_learning::Request::Cancel {
                epoch: "e".into(),
                generation: "g".into(),
            }),
            noise(noise_learning::Request::Start {
                epoch: "e".into(),
                generation: "g".into(),
            }),
        ),
        (
            "noise_measurement(Invalidate)",
            noise(noise_learning::Request::Invalidate),
            noise(noise_learning::Request::Start {
                epoch: "e".into(),
                generation: "g".into(),
            }),
        ),
        (
            "set_channel_scan(false)",
            cmd("set_channel_scan").class(classes::set_channel_scan(false)),
            cmd("set_channel_scan").class(classes::set_channel_scan(true)),
        ),
        (
            "set_loudness_measurement(None)",
            cmd("set_loudness_measurement").class(classes::set_loudness_measurement(&None)),
            cmd("set_loudness_measurement").class(classes::set_loudness_measurement(&Some(1))),
        ),
        (
            "session_rack(Finish)",
            cmd("session_rack").class(classes::session_rack(&SessionRackRequest::Finish {
                token: "t".into(),
            })),
            cmd("session_rack").class(classes::session_rack(&rack_begin())),
        ),
    ]
}

// Y35：解除の要求は、満杯の列・期限切れの下でも、実際の`Ticket::run`を通して、断られず、無期限に待って実行される。
// 同じ要求の取得側は、満杯のとき`Busy`、停止より前に受け付けたとき`StoppedFirst`で断られる。
#[test]
fn y35_a_full_queue_and_an_expired_wait_never_refuse_a_release_request() {
    for (label, release, acquire) in release_pairs() {
        let control = limited(2, WAIT);
        assert_eq!(
            run_under_pressure(&control, release, |_| ()),
            Ok(()),
            "{label}"
        );
        let blocker = hold(&control);
        control.post(normal(), |_| ()).unwrap();
        control.post(normal(), |_| ()).unwrap();
        assert_eq!(
            control.run(acquire, |_| ()),
            Err(ControlError::Busy),
            "{label} の取得側は満杯のとき断られる"
        );
        blocker.release();
        control.run(release_entry(), |_| ()).unwrap();

        let control = self::control();
        let hold = hold(&control);
        let order = log();
        control
            .post(acquire, record_into(&order, "acquire"))
            .unwrap();
        control
            .post(release, record_into(&order, "release"))
            .unwrap();
        control.post(stop_entry(), |_| ()).unwrap();
        hold.release();
        control.run(normal(), |_| ()).unwrap();
        assert_eq!(
            entries(&order),
            ["acquire:StoppedFirst", "release:ok"],
            "{label}：解除は停止より前に受け付けても断られない"
        );
    }
}

// Y13（トレイ）：トレイのミュートは、実行のスレッドを止めたまま呼んでも待たずに戻り、待つ前に
// `interrupt_restore`の`Pending`を取る。閉包が終わる・断られる・捨てられるときに落ちる。
#[test]
fn y13_the_tray_mute_takes_the_interrupt_pending_before_it_waits() {
    use super::conditions::Conditions;
    let conditions = Arc::new(Conditions::default());
    let control = control();
    let hold = hold(&control);
    let tray = control.clone();
    let tray_conditions = conditions.clone();
    within("the tray mute", move || {
        super::post_tray_mute(&tray, Some(&tray_conditions));
    });
    assert_eq!(conditions.pending_count(), 1, "待つ前に取る");
    assert!(
        conditions.control_snapshot().is_err(),
        "旧い Witness は失効する"
    );
    assert_eq!(phases(&control, "mute_toggle"), [Phase::Accepted]);
    hold.release();
    wait_until("the pending drops after the closure", || {
        conditions.pending_count() == 0
    });
    assert!(conditions.control_snapshot().is_ok());

    control.close_for_test();
    super::post_tray_mute(&control, Some(&conditions));
    assert_eq!(conditions.pending_count(), 0, "受付に失敗したときも落ちる");
    super::post_tray_mute(&control, None);

    let poisoned = self::control();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        poisoned.run(cmd("poison"), |_| -> () {
            panic!("poison the audio state")
        })
    }));
    super::post_tray_mute(&poisoned, Some(&conditions));
    poisoned
        .run(normal(), |_| ())
        .expect_err("poison した後の run は Poisoned");
    wait_until("the pending drops after a poisoned closure", || {
        conditions.pending_count() == 0
    });
}
