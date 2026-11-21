//! F1a-1：子のプロセスの寿命の試験（B16・B17・B17b・B18・B40a・D7・W1a・W1b・W1b'・W1c・W2・W4a・W4b・J-13）。
//! 実プロセスの子（試験の実行ファイル自身）を、製品と同じ手順（停止の状態で作成・Job の割り当て・再開）で起動する。
//! 差し替えは `engine_life::seam`（試験のスレッドごと）。本番に差し替え口はない。
use super::compat_support::*;
use super::engine_life::{seam, EngineUnconfirmed, Role};
use super::*;
use std::os::windows::io::AsRawHandle;
use std::time::Duration;

const JA_REPEATED_FINAL: &str =
    "音声エンジンを終了できません。Auralyn を終了して、起動し直してください";
const JA_FIRST_FINAL: &str =
    "音声エンジンの終了を確認できません。しばらくしてからもう一度お試しください";

fn finish(host: AudioHost, observer: Observer) {
    drop(host);
    let _ = std::fs::remove_dir_all(&observer.dir);
}

fn unconfirmed(error: &anyhow::Error) -> EngineUnconfirmed {
    *error
        .downcast_ref::<EngineUnconfirmed>()
        .expect("engine_unconfirmed で失敗する")
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

/// 主の子を起動し、`try_wait` が「終わっていない」を返し続ける状態で `kill_engine` する。
/// 子は実際には終わるが、確認できないので記録へ移る。
fn stuck_primary() -> (AudioHost, Observer) {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    seam::set_wait(seam::Wait::Stuck);
    host.kill_engine();
    (host, observer)
}

// W1a：Job を作れない。停止の状態の子は終わり、起動は失敗し、次の操作で作れる。
#[test]
fn w1a_job_creation_failure_ends_the_suspended_child_and_a_later_start_works() {
    let (mut host, observer) = scripted_parts([]);
    seam::set_job(seam::JobSource::CreateFails);
    let error = host.ensure_engine_running().unwrap_err();
    assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED);
    assert!(observer.probe(0).wait_exit(5000), "子が終わっている");
    assert!(host.child.is_none() && host.engine_job.is_none());
    assert_eq!(host.retired.pending(Role::Primary), 0);
    assert_eq!(
        host.engine_generation, 0,
        "登録していないので世代は進まない"
    );
    host.ensure_engine_running().unwrap();
    assert_eq!(observer.spawn_count(), 2);
    assert_eq!(host.engine_generation, 1);
    finish(host, observer);
}

// W1b：割り当てが失敗（子は生きている）。終了を確かめるまで、同じ役割の子を作らない。
#[test]
fn w1b_assignment_failure_blocks_the_same_role_until_the_exit_is_confirmed() {
    let (mut host, observer) = scripted_parts([]);
    seam::set_assign(seam::Assign::Fails);
    seam::set_wait(seam::Wait::Stuck);
    let error = host.ensure_engine_running().unwrap_err();
    assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED);
    assert_eq!(host.retired.pending(Role::Primary), 1, "確かめられない");
    assert!(observer.probe(0).wait_exit(5000), "kill は実際に届いている");
    seam::set_assign(seam::Assign::Real);
    let error = host.ensure_engine_running().unwrap_err();
    assert!(!unconfirmed(&error).repeated);
    assert_eq!(observer.spawn_count(), 1, "作らない");
    seam::set_wait(seam::Wait::Real);
    host.ensure_engine_running().unwrap();
    assert_eq!(observer.spawn_count(), 2);
    assert_eq!(host.retired.pending(Role::Primary), 0);
    finish(host, observer);
}

// W1b'：OS が割り当てを拒否する（同時に1つの Job に、先に別のプロセスを入れて渡す）。
#[test]
fn w1b_prime_a_job_that_refuses_the_child_leaves_no_unmanaged_process() {
    let (mut host, observer) = scripted_parts([]);
    let job = crate::process_job::Job::new_with_active_process_limit(1).unwrap();
    let mut resident = spawn_idle_process();
    assert!(job.assign(windows::Win32::Foundation::HANDLE(resident.as_raw_handle())));
    seam::set_job(seam::JobSource::Provided(Some(job)));
    let error = host.ensure_engine_running().unwrap_err();
    assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED);
    assert!(
        observer.probe(0).wait_exit(5000),
        "管理外で子が動き続けない"
    );
    assert!(host.child.is_none());
    let _ = resident.kill();
    let _ = resident.wait();
    finish(host, observer);
}

// W1c：`ResumeThread` の戻り値が `1` 以外（`0`・失敗・`2` 以上）は失敗。実際に先に再開した子も同じ。
#[test]
fn w1c_a_resume_result_other_than_one_ends_the_child_and_fails_the_start() {
    for mode in [
        seam::Resume::Returns(0),
        seam::Resume::Returns(u32::MAX),
        seam::Resume::Returns(2),
        seam::Resume::ResumedEarly,
    ] {
        let (mut host, observer) = scripted_parts([]);
        seam::set_resume(mode);
        let error = host.ensure_engine_running().unwrap_err();
        assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED);
        assert!(observer.probe(0).wait_exit(5000), "子が終わっている");
        assert!(host.child.is_none() && host.retired.pending(Role::Primary) == 0);
        seam::set_resume(seam::Resume::Real);
        host.ensure_engine_running().unwrap();
        assert_eq!(observer.spawn_count(), 2);
        finish(host, observer);
    }
}

// Job の失敗が、マイクの権限の案内（フロントの判定と `localize_audio_error`）に写らない。
#[test]
fn a_job_failure_is_never_read_as_a_microphone_permission_denial() {
    for text in [
        engine_life::LAUNCH_FAILED.to_owned(),
        EngineUnconfirmed::text(false),
        EngineUnconfirmed::text(true),
        localize_audio_error(engine_life::LAUNCH_FAILED.to_owned()),
    ] {
        let lower = text.to_lowercase();
        let frontend = text.contains("0x80070005")
            || (text.contains("アクセス") && text.contains("拒否"))
            || (lower.contains("access") && lower.contains("denied"));
        assert!(!frontend, "{text}");
        assert!(!text.contains("マイク") && !text.contains("Store・MSIX版"));
    }
}

// B17・D7：確かめられない子は、2秒で記録へ移り、同じ役割の子を作らない。期限は最初の kill から10秒。
#[test]
fn b17_d7_an_unconfirmed_child_is_recorded_after_two_seconds_and_blocks_a_new_one_until_the_deadline(
) {
    let (mut host, observer) = stuck_primary();
    let after_kill = seam::elapsed();
    assert!(after_kill >= Duration::from_secs(2) && after_kill < Duration::from_millis(2100));
    assert_eq!(host.retired.pending(Role::Primary), 1);
    assert!(host.child.is_none() && !host.get_state().is_running);
    let error = host.ensure_engine_running().unwrap_err();
    assert_eq!(unconfirmed(&error), EngineUnconfirmed { repeated: false });
    let first = seam::elapsed();
    assert!(
        first >= Duration::from_secs(10) && first < Duration::from_millis(10100),
        "待ちは最初の kill から10秒まで: {first:?}"
    );
    assert_eq!(observer.spawn_count(), 1, "新しい子を作らない");
    assert_eq!(host.retired.counts(Role::Primary), [1]);
    // 期限の後の要求は、待たずに1回だけ確かめて即座に答える（期限を要求ごとにやり直さない）。
    let error = host.ensure_engine_running().unwrap_err();
    assert!(!unconfirmed(&error).repeated);
    assert_eq!(seam::elapsed(), first, "待たない");
    assert_eq!(host.retired.counts(Role::Primary), [2]);
    finish(host, observer);
}

// B18：遅れて終了を確かめたら、次の要求で片付けて作り直す。数も消える。
#[test]
fn b18_a_child_that_ends_late_is_cleared_by_the_next_request_and_the_role_can_start_again() {
    let (mut host, observer) = stuck_primary();
    assert!(host.ensure_engine_running().is_err());
    assert!(observer.probe(0).wait_exit(5000), "遅れて終了した");
    seam::set_wait(seam::Wait::Real);
    host.ensure_engine_running().unwrap();
    assert_eq!(observer.spawn_count(), 2);
    assert_eq!(host.retired.pending(Role::Primary), 0);
    assert!(host.retired.counts(Role::Primary).is_empty());
    finish(host, observer);
}

// B17b：`try_wait` が `Err` でも、作り直さない（今の挙動は、`Err` で作り直していた）。
#[test]
fn b17b_a_try_wait_error_is_not_evidence_of_exit_and_does_not_respawn() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    seam::set_wait(seam::Wait::Fails);
    let error = host.ensure_engine_running().unwrap_err();
    assert!(!unconfirmed(&error).repeated);
    assert_eq!(observer.spawn_count(), 1, "作り直さない");
    assert!(host.child.is_none());
    assert_eq!(host.retired.pending(Role::Primary), 1);
    assert!(observer.probe(0).wait_exit(5000), "kill は届いている");
    seam::set_wait(seam::Wait::Real);
    host.ensure_engine_running().unwrap();
    assert_eq!(observer.spawn_count(), 2);
    finish(host, observer);
}

// 主の書き込みの失敗：元のエラーと通知は今のまま。結果を返す前に、子は記録へ移っている。
#[test]
fn w2_a_primary_write_failure_records_the_child_before_returning_the_original_error() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    seam::set_wait(seam::Wait::Stuck);
    host.stdin = None;
    let error = host
        .execute_running_command(IpcCommand::GetDevices)
        .unwrap_err();
    assert!(error.to_string().contains("Stdin not available"));
    assert_eq!(host.retired.pending(Role::Primary), 1);
    assert!(host.child.is_none());
    assert!(observer
        .recorder
        .names()
        .iter()
        .any(|name| name == "audio-error"));
    finish(host, observer);
}

// J-13：どれかの記録が3回に達したら案内を変える。開始（`localize_audio_error`）と更新（生の文字列）の両方。
#[test]
fn j13_the_third_unconfirmed_request_changes_the_message_on_both_paths_in_both_languages() {
    let (mut host, observer) = stuck_primary();
    let first = start(&mut host).unwrap_err().to_string();
    assert_eq!(first, JA_FIRST_FINAL);
    assert_eq!(localize_audio_error(first), JA_FIRST_FINAL);
    let update = host.prepare_update().unwrap_err().to_string();
    assert_eq!(update, JA_FIRST_FINAL, "更新の経路は生の文字列");
    assert!(!host.maintenance, "更新へ進まない");
    let third = start(&mut host).unwrap_err().to_string();
    assert_eq!(third, JA_REPEATED_FINAL);
    assert_eq!(localize_audio_error(third), JA_REPEATED_FINAL);
    assert_eq!(
        host.prepare_update().unwrap_err().to_string(),
        JA_REPEATED_FINAL
    );
    assert_eq!(observer.spawn_count(), 1);
    assert!(observer.probe(0).wait_exit(5000), "遅れて終了した");
    seam::set_wait(seam::Wait::Real);
    host.prepare_update().unwrap();
    assert!(host.maintenance && host.retired.pending(Role::Primary) == 0);
    finish(host, observer);
}

// B40a：`engine_generation` の更新点は今のまま（明示の再起動で 1→3、自然な終了の後の `ensure` で 1→2）。
#[test]
fn b40a_engine_generation_keeps_its_update_points() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    assert_eq!(host.engine_generation, 1);
    host.kill_engine();
    host.ensure_engine_running().unwrap();
    assert_eq!(host.engine_generation, 3, "明示の再起動：1→3");
    finish(host, observer);

    let (mut host, observer) = scripted_parts([("GetDevices", vec![Step::Exit])]);
    host.ensure_engine_running().unwrap();
    assert_eq!(host.engine_generation, 1);
    let _ = host.execute_running_command(IpcCommand::GetDevices);
    assert!(observer.probe(0).wait_exit(5000));
    host.ensure_engine_running().unwrap();
    assert_eq!(host.engine_generation, 2, "自然な終了の後：1→2");
    assert_eq!(observer.spawn_count(), 2);
    finish(host, observer);
}

// `Drop`：記録の子も含め、共通の2秒で終える。確かめられなくても戻る（今は上限なく待つ）。
#[test]
fn drop_waits_at_most_the_shared_two_seconds_even_when_a_child_never_confirms() {
    let (host, observer) = stuck_primary();
    let before = seam::elapsed();
    drop(host);
    let waited = seam::elapsed() - before;
    assert!(waited >= Duration::from_secs(2) && waited < Duration::from_millis(2100));
    assert!(observer.probe(0).wait_exit(5000), "kill は届いている");
    let _ = std::fs::remove_dir_all(&observer.dir);
}

// ---- 実プロセス（W4a・W4b）。試験の実行ファイル自身を「親」として起動し、外から終わらせる。 ----

const PARENT_ENV: &str = "AURALYN_LIFE_PARENT";

#[derive(Serialize, Deserialize)]
struct ParentPlan {
    dir: PathBuf,
    mode: String,
}

fn parent_file(dir: &std::path::Path, name: &str) -> PathBuf {
    dir.join(name)
}

fn park_forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn wait_for_file(path: &std::path::Path) -> String {
    for _ in 0..1500 {
        if let Ok(text) = std::fs::read_to_string(path) {
            if !text.is_empty() {
                return text;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("{} が現れない", path.display());
}

fn publish(dir: &std::path::Path, name: &str, text: &str) {
    let temporary = dir.join(format!("{name}.tmp"));
    std::fs::write(&temporary, text).unwrap();
    std::fs::rename(temporary, parent_file(dir, name)).unwrap();
}

/// 親の側。`mode` は `exit`・`drop`・`wait`（再開の後）、`before_assign`・`before_resume`。
fn run_parent(plan: ParentPlan) {
    let dir = plan.dir;
    let grandchild = parent_file(&dir, "grandchild.pid");
    let (mut host, _observer) = scripted_parts([(
        "GetDevices",
        vec![
            Step::SpawnGrandchild(grandchild),
            response_line(&IpcResponse::Devices(Vec::new())),
        ],
    )]);
    let hook_dir = dir.clone();
    match plan.mode.as_str() {
        "before_assign" => seam::on_stage(move |stage| {
            if let seam::Stage::Spawned(pid) = stage {
                publish(&hook_dir, "child.pid", &pid.to_string());
                park_forever();
            }
        }),
        "before_resume" => seam::on_stage(move |stage| {
            if let seam::Stage::Assigned(pid) = stage {
                publish(&hook_dir, "child.pid", &pid.to_string());
                park_forever();
            }
        }),
        _ => {}
    }
    host.ensure_engine_running().unwrap();
    host.execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    let child = host.child.as_ref().unwrap().id();
    publish(&dir, "child.pid", &child.to_string());
    match plan.mode.as_str() {
        "exit" | "drop" => {
            wait_for_file(&parent_file(&dir, "go"));
            if plan.mode == "drop" {
                drop(host);
            }
            // `quit_app` の `app.exit(0)` と同じく、残りの後始末を待たずにプロセスを終える。
            std::process::exit(0);
        }
        _ => park_forever(),
    }
}

#[test]
fn life_parent_entry() {
    if let Ok(text) = std::env::var(PARENT_ENV) {
        run_parent(serde_json::from_str(&text).unwrap());
    }
}

struct Parent {
    child: Child,
    dir: PathBuf,
}

impl Parent {
    fn start(mode: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "auralyn-life-{}-{}",
            std::process::id(),
            crate::bundle::revision()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let name = format!(
            "{}::life_parent_entry",
            module_path!().split_once("::").unwrap().1
        );
        let plan = ParentPlan {
            dir: dir.clone(),
            mode: mode.into(),
        };
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture"])
            .env(PARENT_ENV, serde_json::to_string(&plan).unwrap())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self { child, dir }
    }

    fn pid(&self, name: &str) -> u32 {
        wait_for_file(&parent_file(&self.dir, name))
            .trim()
            .parse()
            .unwrap()
    }

    fn probe(&self, name: &str) -> ProcessProbe {
        ProcessProbe::open(self.pid(name)).expect("開ける")
    }
}

impl Drop for Parent {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// W4a：通常の終了（`Drop` が走らない場合と走る場合）。Job に入った子と孫が残らない。
#[test]
fn w4a_a_normal_exit_leaves_no_child_or_grandchild() {
    for mode in ["exit", "drop"] {
        let mut parent = Parent::start(mode);
        let child = parent.probe("child.pid");
        let grandchild = parent.probe("grandchild.pid");
        assert!(
            !child.exited() && !grandchild.exited(),
            "終了の前は動いている"
        );
        publish(&parent.dir, "go", "1");
        parent.child.wait().unwrap();
        assert!(child.wait_exit(5000), "子が残らない（{mode}）");
        assert!(grandchild.wait_exit(5000), "孫が残らない（{mode}）");
    }
}

// W4b (3)：再開の後に、親だけを強制終了する。Job の kill-on-close が子と孫を回収する。
#[test]
fn w4b_forced_exit_after_resume_leaves_no_child_or_grandchild() {
    let mut parent = Parent::start("wait");
    let child = parent.probe("child.pid");
    let grandchild = parent.probe("grandchild.pid");
    parent.child.kill().unwrap();
    parent.child.wait().unwrap();
    assert!(child.wait_exit(5000), "子が残らない");
    assert!(grandchild.wait_exit(5000), "孫が残らない");
}

// W4b (2)：割り当ての後・再開の前に、親だけを強制終了する。子は Job に入っているので残らない。
#[test]
fn w4b_forced_exit_after_assignment_and_before_resume_leaves_no_child() {
    let mut parent = Parent::start("before_resume");
    let child = parent.probe("child.pid");
    assert!(!child.exited(), "停止の状態で生きている");
    parent.child.kill().unwrap();
    parent.child.wait().unwrap();
    assert!(child.wait_exit(5000), "Job が子を回収する");
}

// W4b (1)：割り当ての前に、親だけを強制終了する。停止したままの子が残る（J-15。自動では回収しない）。
// 試験が持つ子のハンドルで残ったことを確かめ、そのハンドルで片付ける。
#[test]
fn w4b_forced_exit_before_assignment_leaves_the_suspended_child_which_the_test_then_cleans_up() {
    let mut parent = Parent::start("before_assign");
    let child = parent.probe("child.pid");
    parent.child.kill().unwrap();
    parent.child.wait().unwrap();
    assert!(!child.wait_exit(1500), "停止したままの子が残る（J-15）");
    child.terminate();
    assert!(child.wait_exit(5000), "試験のハンドルで片付けた");
}
