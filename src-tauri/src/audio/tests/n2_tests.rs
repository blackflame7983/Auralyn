//! F1b-0b-4：N2（古い接続の通知を出さない）の試験。設計は docs/plans/audio-session-f1b0b-design.md の14章（Q1〜Q11）。
//! Q8（閉じた接続への `begin`）だけは、tick の補助が `mode_vst.rs` の試験の中にあるので、そちらに置く。
//! 順は門・`Recorder::block_after`・継ぎ目・到達の数で作る。`sleep` で順を作らない。
use super::compat_support::*;
use super::engine_life::{seam, EngineUnconfirmed, Role};
use super::link::CloseCause;
use super::link_seam::reader_for;
use super::*;
use std::sync::atomic::AtomicU64;
use std::sync::mpsc;
use std::time::Duration;

const CC: &str = "audio-conditions-changed";

static NEXT: AtomicU64 = AtomicU64::new(0);

/// 子を持たない、接続だけが開いている `AudioHost`。通知は記録する。
fn open_host() -> (AudioHost, Arc<emit::Recorder>) {
    let dir = std::env::temp_dir().join(format!(
        "auralyn-n2-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    let mut host = AudioHost::new(dir);
    let recorder = Arc::new(emit::Recorder::default());
    host.emitter.set(recorder.emitter());
    host.reset_engine_reader();
    (host, recorder)
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let started = Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "待っても起きない: {what}"
        );
        std::thread::yield_now();
    }
}

fn started() -> EngineEvent {
    EngineEvent::Started {
        sample_rate: 48000,
        buffer_size: 512,
        stream_generation: Some(1),
    }
}

fn stopped() -> EngineEvent {
    EngineEvent::Stopped {
        stream_generation: Some(1),
        ended_stream_generation: Some(1),
    }
}

fn voice(state: &str) -> EngineEvent {
    EngineEvent::VoiceCheckState {
        state: state.into(),
        position_ms: 0,
        duration_ms: 0,
    }
}

fn editor_opened() -> EngineEvent {
    EngineEvent::EditorOpened { id: "a".into() }
}

/// 通知を出す変種の全部（13か所・14変種。`Log` を除く）。
fn all_events() -> Vec<EngineEvent> {
    vec![
        EngineEvent::ControlStall {
            command: "c".into(),
            plugin_id: None,
            module: None,
            elapsed_ms: 1,
        },
        EngineEvent::MixingSourceFailed,
        EngineEvent::MixingOutputFailed,
        EngineEvent::Error("x".into()),
        EngineEvent::LevelMeter {
            levels: crate::ipc::MeterLevels {
                input: [0.0; 2],
                output: [0.0; 2],
            },
            stream_generation: Some(1),
        },
        stopped(),
        EngineEvent::Loudness(crate::audio_engine::loudness::LoudnessReading {
            id: 1,
            ready: true,
            silent: false,
            supported: true,
            short_term_lufs: None,
            true_peak_dbtp: None,
        }),
        EngineEvent::ChannelLevels(vec![0.0]),
        started(),
        voice("recording"),
        editor_opened(),
        EngineEvent::EditorClosed { id: "a".into() },
        EngineEvent::ProcessingHealth {
            state: crate::audio_engine::processing_watch::HealthState::Normal,
            kind: None,
            recent_late: 0,
            recent_underflow: 0,
            window_secs: 1,
        },
        EngineEvent::VoiceCheckEnvelope {
            raw_peaks: Vec::new(),
            processed_peaks: Vec::new(),
        },
    ]
}

/// 状態の変更が通知より先に起きた事象の名前（旧い列に混ざる通知の名前）。
const OLD_NAMES: [&str; 13] = [
    "audio-control-stall",
    "mixing-source-failed",
    "mixing-output-failed",
    "audio-stream-error",
    "audio-level",
    "audio-stopped",
    "audio-loudness",
    "audio-channel-scan",
    "voice-check-state",
    "plugin-editor-opened",
    "plugin-editor-closed",
    "audio-processing-health",
    "voice-check-envelope",
];

/// 今の `engine_epoch`。
fn epoch_of(host: &AudioHost) -> u64 {
    host.conditions.control_snapshot().unwrap().engine_epoch()
}

fn revision(host: &AudioHost) -> Result<u64, String> {
    host.conditions.snapshot().map(|witness| witness.revision())
}

// Q1：閉じた接続の reader が `voice_activity` を立てても、更新の確認は「ボイスチェック中」とは言わない。
// 開いている間は、立っていれば断る。
#[test]
fn q1_a_stale_voice_activity_does_not_block_an_update_once_the_link_is_closed() {
    let (mut host, recorder) = open_host();
    let reader = reader_for(&host, 0);
    reader.handle_event(voice("recording"));
    assert_eq!(recorder.names(), ["voice-check-state"]);
    let refusal = host.check_can_interrupt().unwrap_err().to_string();
    assert!(refusal.contains("ボイスチェック"), "{refusal}");
    assert!(host.link.close(CloseCause::Intentional));
    host.voice_activity.store(false, Ordering::Release);
    reader.handle_event(voice("playing"));
    assert!(
        host.voice_activity.load(Ordering::Acquire),
        "旧い書き込みは届く"
    );
    assert!(host.check_can_interrupt().is_ok());
}

// Q2：接続が閉じられ、epoch が失効した後の旧い行は、状態を変える種類でも何も変えず、通知も出さない。
// 接続が開いていれば、今のとおり変わり、通知が出る。
#[test]
fn q2_a_retired_reader_changes_no_conditions_for_each_gated_event() {
    let gated = [
        ("mixing-source", EngineEvent::MixingSourceFailed),
        ("mixing-output", EngineEvent::MixingOutputFailed),
        ("error", EngineEvent::Error("x".into())),
        ("stopped", stopped()),
        ("started", started()),
    ];
    for (label, event) in gated {
        let running_first = label != "started";
        for closed in [true, false] {
            let (host, recorder) = open_host();
            let epoch = host.conditions.new_engine();
            let reader = reader_for(&host, epoch);
            if running_first {
                reader.handle_event(started());
            }
            let before = revision(&host);
            assert_eq!(before.is_ok(), running_first, "{label}");
            recorder.clear();
            if closed {
                assert!(host.link.close(CloseCause::Intentional));
                host.conditions.retire_engine();
            }
            let before = if closed { revision(&host) } else { before };
            reader.handle_event(event.clone());
            let after = revision(&host);
            if closed {
                assert_eq!(before, after, "閉じた後は何も変えない: {label}");
                assert!(recorder.names().is_empty(), "通知なし: {label}");
            } else {
                assert_ne!(before, after, "開いていれば変わる: {label}");
                assert!(!recorder.names().is_empty(), "通知が出る: {label}");
            }
        }
    }
}

/// 閉じ方（`ensure_engine_running` の3経路）。
#[derive(Clone, Copy, Debug)]
enum Close {
    /// `:887`：動いていた子がすでに終わっている。
    Exited,
    /// `:899`：子は生きていて、出力だけが閉じている（C5）。
    StdoutClosed,
    /// `:905`：`try_wait` が失敗する。
    WaitFails,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Clear {
    Succeeds,
    Fails,
}

/// 閉じる側を止めておく reader の台。`ensure_engine_running` が戻る前後で、reader が発行の途中で止まったままを観測する。
struct Hold {
    recorder: mpsc::Sender<Arc<emit::Recorder>>,
    returned: mpsc::Sender<Vec<String>>,
    release: mpsc::Receiver<()>,
}

/// 1つの再生成の経路を動かす。`ensure_clear` の結果と閉じ方は別々に注入する。
fn run_case(close: Close, clear: Clear, hold: Option<Hold>) {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    let epoch = epoch_of(&host);
    host.conditions.lifecycle(true);
    let witness = host.conditions.snapshot().unwrap();
    let control = host.conditions.control_snapshot().unwrap();
    host.voice_activity.store(true, Ordering::Release);
    let old_reader = reader_for(&host, epoch);
    let stuck = hold.as_ref().map(|hold| {
        observer.recorder.block_after(0);
        let reader = reader_for(&host, epoch);
        let thread = std::thread::spawn(move || reader.handle_event(editor_opened()));
        wait_until("reader が発行の途中で止まる", || {
            observer.recorder.blocked_emits() == 1
        });
        hold.recorder.send(observer.recorder.clone()).unwrap();
        thread
    });
    match close {
        Close::Exited => {
            observer.probe(0).terminate();
            assert!(observer.probe(0).wait_exit(5000));
        }
        Close::StdoutClosed => {
            host.link.close(CloseCause::Eof);
        }
        Close::WaitFails => reaper_seam::fails(),
    }
    if clear == Clear::Fails && !matches!(close, Close::WaitFails) {
        reaper_seam::adopt(&host, Role::Primary, spawn_idle_process());
    }
    let stages: Arc<Mutex<Vec<String>>> = Arc::default();
    seam::on_stage({
        let stages = stages.clone();
        move |stage| match stage {
            seam::Stage::Retired(_) => stages.lock().unwrap().push("retired".into()),
            seam::Stage::ResultDecided => stages.lock().unwrap().push("decided".into()),
            _ => {}
        }
    });
    let reached = Arc::new(AtomicBool::new(false));
    before_ensure_clear::set({
        let (conditions, voice_activity) = (host.conditions.clone(), host.voice_activity.clone());
        let (witness, control, reached) = (witness.clone(), control.clone(), reached.clone());
        let probe = observer.probe(0);
        move || {
            assert!(conditions.snapshot().is_err(), "確定の後は running=false");
            assert!(!voice_activity.load(Ordering::Acquire));
            assert!(witness.validate().is_err(), "閉鎖の前の条件は失効する");
            assert!(control.validate().is_err());
            if clear == Clear::Succeeds && matches!(close, Close::WaitFails) {
                assert!(probe.wait_exit(5000), "kill は届いている");
                reaper_seam::real();
            }
            reached.store(true, Ordering::Release);
        }
    });
    let result = host.ensure_engine_running();
    assert!(reached.load(Ordering::Acquire), "{close:?}/{clear:?}");
    match clear {
        Clear::Fails => {
            let error = result.expect_err("ensure_clear が失敗する");
            assert!(
                error.downcast_ref::<EngineUnconfirmed>().is_some(),
                "engine_unconfirmed: {error}"
            );
            assert!(host.child.is_none());
            assert_eq!(observer.spawn_count(), 1, "新しい子を作らない");
            assert!(
                host.conditions.snapshot().is_err(),
                "new_engine が来なくても running=true は残らない: {close:?}"
            );
            assert!(!host.voice_activity.load(Ordering::Acquire));
            old_reader.handle_event(started());
            assert!(host.conditions.snapshot().is_err());
            assert!(stages
                .lock()
                .unwrap()
                .iter()
                .any(|stage| stage == "decided"));
        }
        Clear::Succeeds => {
            result.expect("ensure_clear が通る");
            assert!(host.child.is_some());
            assert_eq!(observer.spawn_count(), 2);
        }
    }
    assert!(
        witness.validate().is_err(),
        "成功でも失敗でも、旧い条件は失効する"
    );
    assert!(control.validate().is_err());
    if let (Some(hold), Some(stuck)) = (hold, stuck) {
        hold.returned.send(stages.lock().unwrap().clone()).unwrap();
        hold.release.recv_timeout(Duration::from_secs(10)).unwrap();
        stuck.join().unwrap();
    }
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

const CLOSES: [Close; 3] = [Close::Exited, Close::StdoutClosed, Close::WaitFails];

// Q4：再生成の3つの閉じ方（`:887`・`:899`・`:905`）と `ensure_clear` の成否を、別々に注入した6通り。
// 継ぎ目 `before_ensure_clear` の時点で、切断状態が確定している。失敗しても `running=true` は残らない。
// 閉鎖の前に取った条件の証明は、成功でも失敗でも失効する（epoch の契約）。
#[test]
fn q4_the_reconnect_paths_settle_the_disconnected_state_and_expire_old_conditions() {
    for close in CLOSES {
        for clear in [Clear::Succeeds, Clear::Fails] {
            std::thread::spawn(move || run_case(close, clear, None))
                .join()
                .unwrap_or_else(|_| panic!("{close:?}/{clear:?}"));
        }
    }
}

/// 閉じる側を、reader が発行の途中で止まっている間に動かし、戻った時点の観測を返す。
fn run_held(close: Close) -> (Arc<emit::Recorder>, Vec<String>) {
    let (recorder_tx, recorder_rx) = mpsc::channel();
    let (returned_tx, returned_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let runner = std::thread::spawn(move || {
        run_case(
            close,
            Clear::Fails,
            Some(Hold {
                recorder: recorder_tx,
                returned: returned_tx,
                release: release_rx,
            }),
        )
    });
    let recorder = recorder_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    let stages = returned_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("reader を解放する前に、閉じる側が戻る");
    assert_eq!(
        recorder.blocked_emits(),
        1,
        "戻った時点で、reader は発行の途中のまま（待っていない）: {close:?}"
    );
    release_tx.send(()).unwrap();
    recorder.release();
    runner.join().unwrap();
    (recorder, stages)
}

// Q5：閉じる側は、発行の途中で止まった reader を待たない。回収が終わり（`Stage::Retired`）、失敗が決まった後に戻る。
// 配信ミックスの子の `release_engine`・`Drop`、主の `Drop` も待たない。
#[test]
fn q5_the_closing_side_never_waits_for_a_reader_stuck_in_emit() {
    let (recorder, stages) = run_held(Close::StdoutClosed);
    assert_eq!(
        stages,
        ["retired", "decided"],
        "回収の完了が、失敗の決定より先"
    );
    assert_eq!(
        recorder
            .names()
            .iter()
            .filter(|name| *name == "plugin-editor-opened")
            .count(),
        1,
        "止まっていた旧い1列は、解放の後に出る"
    );
    // 配信ミックスの子と主：自分の reader が発行の途中で止まったままでも、`release_engine`・`Drop` は戻る。
    for as_child in [true, false] {
        let (mut host, observer) = scripted_parts([]);
        host.post_role = as_child;
        host.ensure_engine_running().unwrap();
        let recorder = observer.recorder.clone();
        recorder.clear();
        recorder.block_after(0);
        let reader = reader_for(&host, epoch_of(&host));
        let stuck = std::thread::spawn(move || reader.handle_event(editor_opened()));
        wait_until("reader が止まる", || recorder.blocked_emits() == 1);
        let (done_tx, done_rx) = mpsc::channel();
        let closer = std::thread::spawn(move || {
            if as_child {
                host.release_engine();
            }
            drop(host);
            done_tx.send(()).unwrap();
        });
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("待っている: child={as_child}"));
        assert!(observer.probe(0).wait_exit(5000), "回収は済んでいる");
        assert_eq!(recorder.blocked_emits(), 1, "reader は止まったまま");
        recorder.release();
        stuck.join().unwrap();
        closer.join().unwrap();
        let _ = std::fs::remove_dir_all(&observer.dir);
    }
}

// Q6：契約。閉鎖の時点で通知の列に入っていた旧い1列は出る。それは `order` により、閉じる側が積んだ通知より前、
// 新しい接続の通知より前に出し終わる。閉鎖の後に来た旧い行（全種）は、列を増やさない。
#[test]
fn q6_one_straddling_chain_comes_out_before_the_new_notices() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    let recorder = observer.recorder.clone();
    recorder.clear();
    let epoch = epoch_of(&host);
    let late = Arc::new(reader_for(&host, epoch));
    let straddler_reader = reader_for(&host, epoch);
    recorder.block_after(1);
    let straddler = std::thread::spawn(move || straddler_reader.handle_event(started()));
    wait_until("旧い列が途中で止まる", || {
        recorder.blocked_emits() == 1
    });
    assert_eq!(recorder.names(), [CC], "列の1つ目だけが出ている");
    let closer = std::thread::spawn(move || {
        host.kill_primary_engine();
        host
    });
    assert!(observer.probe(0).wait_exit(5000), "回収は通知を待たない");
    assert!(!closer.is_finished(), "保持した通知は、旧い列の後に出る");
    let late_threads: Vec<_> = all_events()
        .into_iter()
        .map(|event| {
            let late = late.clone();
            std::thread::spawn(move || late.handle_event(event))
        })
        .collect();
    recorder.release();
    straddler.join().unwrap();
    for thread in late_threads {
        thread.join().unwrap();
    }
    let mut host = closer.join().unwrap();
    let names = recorder.names();
    assert_eq!(
        names,
        [CC, "audio-started", CC],
        "旧い1列 → host の保持した通知"
    );
    host.ensure_engine_running().unwrap();
    let fresh = reader_for(&host, epoch_of(&host));
    fresh.handle_event(editor_opened());
    assert_eq!(
        recorder.names(),
        [CC, "audio-started", CC, CC, "plugin-editor-opened"],
        "旧い列 → 保持した通知 → 新しい接続の最初の通知 → 新しい接続の通知"
    );
    for name in OLD_NAMES
        .iter()
        .filter(|name| **name != "plugin-editor-opened")
    {
        assert!(
            !recorder.names().iter().any(|seen| seen == name),
            "閉鎖の後の旧い行は出ない: {name}"
        );
    }
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// Q7（I56）：配信ミックスの子の門（子の `Notifier`）が閉じたままでも、主は進む。
#[test]
fn q7_a_closed_door_of_the_post_mix_child_does_not_stop_the_primary() {
    let (mut child, child_observer) = scripted_parts([]);
    child.post_role = true;
    child.ensure_engine_running().unwrap();
    let child_recorder = child_observer.recorder.clone();
    child_recorder.clear();
    child_recorder.block_after(0);
    let child_reader = reader_for(&child, epoch_of(&child));
    let stuck = std::thread::spawn(move || child_reader.handle_event(editor_opened()));
    wait_until("子の reader が止まる", || {
        child_recorder.blocked_emits() == 1
    });
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    host.post_mix.adopt_child_for_test(child);
    let (done_tx, done_rx) = mpsc::channel();
    let primary = std::thread::spawn(move || {
        host.kill_primary_engine();
        host.ensure_engine_running().unwrap();
        host.kill_primary_engine();
        done_tx.send(()).unwrap();
        host
    });
    done_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("子の門が閉じたままでも、主は進む");
    assert_eq!(
        child_recorder.blocked_emits(),
        1,
        "子の reader は止まったまま"
    );
    child_recorder.release();
    stuck.join().unwrap();
    let host = primary.join().unwrap();
    assert!(host.post_mix.has_child_for_test(), "主の回収は子に触れない");
    drop(host);
    let _ = std::fs::remove_dir_all(&child_observer.dir);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// Q9：失敗の結果の確定（`Stage::ResultDecided`）と実際の返却を別々に観測する。どちらも、reader を解放する前に起きる。
// 閉じ方は3通り（`:887`・`:899`・`:905`）。結果の種類は `engine_unconfirmed`。
#[test]
fn q9_the_failure_result_is_decided_and_returned_without_waiting_for_the_reader() {
    for close in CLOSES {
        let (_, stages) = run_held(close);
        assert_eq!(
            stages.last().map(String::as_str),
            Some("decided"),
            "失敗の決定の後に返る: {close:?}"
        );
        if let Some(retired) = stages.iter().position(|stage| stage == "retired") {
            let decided = stages.iter().position(|stage| stage == "decided").unwrap();
            assert!(retired < decided, "回収の後に決まる: {close:?}");
        }
    }
}

/// `source` の中で、`marker` の次の `(` から、対応する `)` までの本文。
fn spans<'a>(source: &'a str, marker: &str) -> Vec<&'a str> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = source[from..].find(marker) {
        let open = from + at + marker.len() - 1;
        let mut depth = 0usize;
        let mut end = open;
        for (offset, ch) in source[open..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + offset;
                        break;
                    }
                }
                _ => {}
            }
        }
        found.push(&source[open + 1..end]);
        from = end;
    }
    found
}

/// 関数 `name` の本文（次の同じ深さの `fn` まで）。
fn body<'a>(source: &'a str, name: &str) -> &'a str {
    let start = source
        .find(&format!("fn {name}("))
        .unwrap_or_else(|| panic!("見つからない: {name}"));
    let rest = &source[start..];
    let end = rest[1..]
        .find("\n    fn ")
        .or_else(|| rest[1..].find("\n    pub fn "))
        .or_else(|| rest[1..].find("\n    pub(super) fn "))
        .map_or(rest.len(), |at| at + 1);
    &rest[..end]
}

// Q11：状態の変更・ログ・待ちが、設計の置く場所にだけある（構造の試験）。
#[test]
fn q11_the_state_changes_the_logs_and_the_waits_stay_where_the_design_puts_them() {
    let reader = include_str!("../reader.rs");
    let production = reader.split("pub(super) fn finish").next().unwrap();
    for body in spans(production, "emit_chain(") {
        assert!(
            !body.contains("[Engine]"),
            "R3 のログは通知の列の中に置かない"
        );
    }
    let audio = include_str!("../../audio.rs");
    for name in [
        "drop_connection",
        "close_connection",
        "release_engine",
        "take_engine_for_shutdown",
    ] {
        let text = body(audio, name);
        for banned in [
            "settle_disconnected",
            "wait_notified",
            "Condvar",
            ".chain(",
            "emitter",
        ] {
            assert!(!text.contains(banned), "{name} に `{banned}` を足さない");
        }
    }
    let waits: usize = [
        include_str!("../../audio.rs"),
        include_str!("../mode_vst.rs"),
        include_str!("../post_mix.rs"),
        include_str!("../reader.rs"),
        include_str!("../writer.rs"),
        include_str!("../control.rs"),
        include_str!("../engine_life.rs"),
    ]
    .iter()
    .map(|source| source.matches(".wait_notified(").count())
    .sum();
    assert_eq!(waits, 1, "通知済みの待ちは `reply_timed_out` の1つだけ");
    let kill = body(audio, "kill_primary_engine");
    let order = [
        "drop_connection(",
        "voice_activity.store(false",
        "notify_conditions_changed(",
    ]
    .map(|needle| kill.find(needle).unwrap_or_else(|| panic!("{needle}")));
    assert!(
        order[0] < order[1] && order[1] < order[2],
        "切断状態の確定が、通知を積む前に済む"
    );
    // 閉じる側の呼び出し元の一覧（設計 14.3）。新しい閉じる側が増えたら、確定の要否を決めるまで落ちる。
    let mut callers = Vec::new();
    for needle in ["close_connection(", "drop_connection(", "release_engine("] {
        for (index, _) in audio.match_indices(needle) {
            let line_start = audio[..index].rfind('\n').map_or(0, |at| at + 1);
            if audio[line_start..index].trim_start().starts_with("fn ") {
                continue;
            }
            let owner = audio[..index].rfind("fn ").map(|at| {
                audio[at + 3..]
                    .split('(')
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            });
            callers.push(format!("{needle}{}", owner.unwrap_or_default()));
        }
    }
    callers.sort();
    let expected = [
        "close_connection(drop",
        "close_connection(drop_connection",
        "close_connection(ensure_engine_running",
        "close_connection(reset_engine_reader",
        "close_connection(take_engine_for_shutdown",
        "drop_connection(ensure_engine_running",
        "drop_connection(ensure_engine_running",
        "drop_connection(kill_primary_engine",
        "drop_connection(release_engine",
        "release_engine(drop",
    ];
    assert_eq!(callers, expected, "閉じる側の呼び出し元");
}
