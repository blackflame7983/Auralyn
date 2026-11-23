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
    reaper_seam::stuck();
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
    assert_eq!(reaper_seam::pending(&host, Role::Primary), 0);
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
    reaper_seam::stuck();
    let error = host.ensure_engine_running().unwrap_err();
    assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED);
    assert_eq!(
        reaper_seam::pending(&host, Role::Primary),
        1,
        "確かめられない"
    );
    assert!(observer.probe(0).wait_exit(5000), "kill は実際に届いている");
    seam::set_assign(seam::Assign::Real);
    let error = host.ensure_engine_running().unwrap_err();
    assert!(!unconfirmed(&error).repeated);
    assert_eq!(observer.spawn_count(), 1, "作らない");
    reaper_seam::real();
    host.ensure_engine_running().unwrap();
    assert_eq!(observer.spawn_count(), 2);
    assert_eq!(reaper_seam::pending(&host, Role::Primary), 0);
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

// W1c（J-24）：`ResumeThread` の戻り値が `0`（私たちの停止がすでになかった）と失敗（`u32::MAX`）は失敗。
// 実際に先に再開した子も同じ（戻り値は `0`）。`2` 以上は成功（下の試験）。
#[test]
fn w1c_a_resume_result_of_zero_or_failure_ends_the_child_and_fails_the_start() {
    for mode in [
        seam::Resume::Returns(0),
        seam::Resume::Returns(u32::MAX),
        seam::Resume::ResumedEarly,
    ] {
        let (mut host, observer) = scripted_parts([]);
        seam::set_resume(mode);
        let error = host.ensure_engine_running().unwrap_err();
        assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED);
        assert!(observer.probe(0).wait_exit(5000), "子が終わっている");
        assert!(host.child.is_none() && reaper_seam::pending(&host, Role::Primary) == 0);
        seam::set_resume(seam::Resume::Real);
        host.ensure_engine_running().unwrap();
        assert_eq!(observer.spawn_count(), 2);
        finish(host, observer);
    }
}

/// 子の主スレッドの停止を1回解く（外の停止が解かれた状態を作る）。
fn release_external_suspend(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::ChildExt;
    let thread = windows::Win32::Foundation::HANDLE(child.main_thread_handle().as_raw_handle());
    // SAFETY: `child` が生きているあいだ、主スレッドのハンドルは有効。
    let _ = unsafe { windows::Win32::System::Threading::ResumeThread(thread) };
}

// W1c（J-24）：外の停止が重なって戻り値が `2` でも、私たちの再開は効いている。起動は成功し、
// 外の停止が解かれるまで子は動かず、解かれたら動き出す。健全な子を終わらせない。
// 戻り値が2以上の起動は、最初の応答が来るまでを起動の確認とする（外の停止が解かれるのを待つ）。
#[test]
fn w1c_a_resume_result_of_two_succeeds_and_the_child_runs_once_the_external_suspend_is_released() {
    let (mut host, observer) = scripted_parts([]);
    seam::set_resume(seam::Resume::ExternalSuspend(Some(Duration::from_millis(
        400,
    ))));
    let started = Instant::now();
    host.ensure_engine_running().unwrap();
    seam::set_resume(seam::Resume::Real);
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "最初の応答（外の停止が解かれた後）まで、起動の確認で待った: {:?}",
        started.elapsed()
    );
    assert_eq!(observer.spawn_count(), 1);
    assert!(!observer.probe(0).exited(), "子は終わっていない");
    host.execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    finish(host, observer);
}

// J-24：外の停止が解かれないまま続く子は、最初の応答が来ないので、期限で切り離して回収し、
// 今の起動の失敗と同じ文言で失敗にする。終了を確かめられなければ `engine_unconfirmed`。次の操作で作り直せる。
#[test]
fn w1c_a_child_whose_external_suspend_is_never_released_is_retired_and_the_start_fails() {
    for confirmed in [true, false] {
        let (mut host, observer) = scripted_parts([]);
        crate::audio::writer::set_limits_for_test(None, Some(Duration::from_millis(500)));
        seam::set_resume(seam::Resume::ExternalSuspend(None));
        if !confirmed {
            reaper_seam::stuck();
        }
        let error = host.ensure_engine_running().unwrap_err();
        seam::set_resume(seam::Resume::Real);
        crate::audio::writer::set_limits_for_test(None, None);
        assert!(host.child.is_none(), "切り離している");
        if confirmed {
            assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED);
            assert!(observer.probe(0).wait_exit(5000), "子が回収されている");
            assert_eq!(reaper_seam::pending(&host, Role::Primary), 0);
        } else {
            assert_eq!(unconfirmed(&error), EngineUnconfirmed { repeated: false });
            assert_eq!(reaper_seam::pending(&host, Role::Primary), 1);
            reaper_seam::real();
        }
        // 次の操作で作り直せる（確かめられなかった場合は、終了を確かめた後）。
        assert!(observer.probe(0).wait_exit(5000));
        host.ensure_engine_running().unwrap();
        assert_eq!(observer.spawn_count(), 2);
        finish(host, observer);
    }
}

// 製品の生成（``spawn_engine_process`` が呼ぶ `spawn_engine_binary`）が、子を停止の状態で作る。
// 試験の launcher は別の組み立てなので、製品のフラグを外しても W1・W4 の試験は気づかない。この試験が気づく。
#[test]
fn the_product_spawn_creates_the_child_suspended_so_the_resume_succeeds() {
    let host = AudioHost::new(std::env::temp_dir().join("auralyn-product-spawn"));
    let cmd = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join("cmd.exe");
    // 作った直後から預け、ハンドルの取得や再開が失敗しても、停止したままの子を残さない。
    let guard = ChildGuard::new(host.spawn_engine_binary(cmd).unwrap());
    let probe = ProcessProbe::open(guard.id()).unwrap();
    let (child, job, suspended) =
        reaper_seam::contain(&host, Role::Primary, guard.release()).unwrap();
    let guard = ChildGuard::new(child);
    // 停止の状態で作ったので、再開の戻り値は1以上（外の停止が重なっていれば2以上）。
    assert!(job.is_some());
    let _ = suspended;
    drop(guard);
    assert!(probe.wait_exit(5000));

    // 外の停止が重なって戻り値が 2 でも、製品の経路は成功し、解かれた子は動く（J-24）。
    seam::set_resume(seam::Resume::ExternalSuspend(None));
    let guard = ChildGuard::new(host.spawn_engine_binary(cmd_exe()).unwrap());
    let probe = ProcessProbe::open(guard.id()).unwrap();
    let (child, job, suspended) =
        reaper_seam::contain(&host, Role::Primary, guard.release()).unwrap();
    seam::set_resume(seam::Resume::Real);
    let guard = ChildGuard::new(child);
    assert!(
        job.is_some() && suspended,
        "戻り値が2なので、外の停止の確認が要る"
    );
    release_external_suspend(guard.child());
    assert!(!probe.wait_exit(500), "外の停止が解かれた子は、動き続ける");
    drop(guard);
    assert!(probe.wait_exit(5000));
}

fn cmd_exe() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32")
        .join("cmd.exe")
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
    assert_eq!(reaper_seam::pending(&host, Role::Primary), 1);
    assert!(host.child.is_none() && !host.get_state().is_running);
    // 窓の中の要求は、待たずに失敗し、数を進めない。
    let error = host.ensure_engine_running().unwrap_err();
    assert_eq!(unconfirmed(&error), EngineUnconfirmed { repeated: false });
    assert_eq!(reaper_seam::counts(&host, Role::Primary), [0]);
    assert_eq!(seam::elapsed(), after_kill, "待たない");
    // 窓（最初の kill から期限まで）が過ぎた後の要求は、待たずに答え、記録ごとに数を1つ進める。
    reaper_seam::pass_window(&host);
    let error = host.ensure_engine_running().unwrap_err();
    assert_eq!(unconfirmed(&error), EngineUnconfirmed { repeated: false });
    assert_eq!(observer.spawn_count(), 1, "新しい子を作らない");
    assert_eq!(reaper_seam::counts(&host, Role::Primary), [1]);
    let error = host.ensure_engine_running().unwrap_err();
    assert!(!unconfirmed(&error).repeated);
    assert_eq!(seam::elapsed(), after_kill, "待たない");
    assert_eq!(reaper_seam::counts(&host, Role::Primary), [2]);
    finish(host, observer);
}

// B18：遅れて終了を確かめたら、次の要求で片付けて作り直す。数も消える。
#[test]
fn b18_a_child_that_ends_late_is_cleared_by_the_next_request_and_the_role_can_start_again() {
    let (mut host, observer) = stuck_primary();
    assert!(host.ensure_engine_running().is_err());
    assert!(observer.probe(0).wait_exit(5000), "遅れて終了した");
    reaper_seam::real();
    host.ensure_engine_running().unwrap();
    assert_eq!(observer.spawn_count(), 2);
    assert_eq!(reaper_seam::pending(&host, Role::Primary), 0);
    assert!(reaper_seam::counts(&host, Role::Primary).is_empty());
    finish(host, observer);
}

// B17b：`try_wait` が `Err` でも、作り直さない（今の挙動は、`Err` で作り直していた）。
#[test]
fn b17b_a_try_wait_error_is_not_evidence_of_exit_and_does_not_respawn() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    reaper_seam::fails();
    let error = host.ensure_engine_running().unwrap_err();
    assert!(!unconfirmed(&error).repeated);
    assert_eq!(observer.spawn_count(), 1, "作り直さない");
    assert!(host.child.is_none());
    assert_eq!(reaper_seam::pending(&host, Role::Primary), 1);
    assert!(observer.probe(0).wait_exit(5000), "kill は届いている");
    reaper_seam::real();
    host.ensure_engine_running().unwrap();
    assert_eq!(observer.spawn_count(), 2);
    finish(host, observer);
}

// 主の書き込みの失敗：元のエラーと通知は今のまま。結果を返す前に、子は記録へ移っている。
#[test]
fn w2_a_primary_write_failure_records_the_child_before_returning_the_original_error() {
    let (mut host, observer) = scripted_parts([]);
    host.ensure_engine_running().unwrap();
    reaper_seam::stuck();
    host.fail_writes_for_test();
    let error = host
        .execute_running_command(IpcCommand::GetDevices)
        .unwrap_err();
    assert!(error.to_string().contains("Stdin not available"));
    assert_eq!(reaper_seam::pending(&host, Role::Primary), 1);
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
fn j13_the_third_unconfirmed_request_changes_the_japanese_message_on_both_paths() {
    let (mut host, observer) = stuck_primary();
    reaper_seam::pass_window(&host);
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
    reaper_seam::real();
    host.prepare_update().unwrap();
    assert!(host.maintenance && reaper_seam::pending(&host, Role::Primary) == 0);
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
    let panic = path
        .parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("parent-panic.txt")).ok())
        .unwrap_or_default();
    panic!("{} が現れない（親の panic: {panic}）", path.display());
}

fn publish(dir: &std::path::Path, name: &str, text: &str) {
    let temporary = dir.join(format!("{name}.tmp"));
    std::fs::write(&temporary, text).unwrap();
    std::fs::rename(temporary, parent_file(dir, name)).unwrap();
}

/// 親の側。`mode` は `exit`・`drop`・`wait`（再開の後）、`before_assign`・`before_resume`。
fn run_parent(plan: ParentPlan) {
    let dir = plan.dir;
    // 親が panic で消えたとき、待つ側が原因を読めるように残す。
    let panic_dir = dir.clone();
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::fs::write(panic_dir.join("parent-panic.txt"), info.to_string());
    }));
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

/// 親のプロセス。試験が外側の Job（kill-on-close）を持ち、親と、親が作る子・孫を入れる。
/// 試験が途中で失敗しても、Drop で全部が回収される（親が死んでも、外側の Job は残る）。
struct Parent {
    child: Child,
    dir: PathBuf,
    _outer: crate::process_job::Job,
}

impl Parent {
    fn start(mode: &str) -> Self {
        match Self::try_start(mode, false) {
            Ok(parent) => parent,
            Err(_) => panic!("外側の Job へ入れられない"),
        }
    }

    /// 親を停止の状態で作った直後から ChildGuard に預ける。割り当てが失敗（`fail_assign` は注入）したら、
    /// 親を kill して終了を待ち、作った親のハンドルを返す（残っていないことを呼び出し側が確かめる）。
    fn try_start(mode: &str, fail_assign: bool) -> Result<Self, ProcessProbe> {
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
        use std::os::windows::process::{ChildExt, CommandExt};
        const CREATE_SUSPENDED: u32 = 0x00000004;
        // 親は停止の状態で作り、外側の Job へ入れてから動かす（子・孫が外側の Job から漏れない）。
        let outer = crate::process_job::Job::new_kill_on_drop().unwrap();
        let guard = ChildGuard::new(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--nocapture"])
                .env(PARENT_ENV, serde_json::to_string(&plan).unwrap())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_SUSPENDED)
                .spawn()
                .unwrap(),
        );
        let probe = ProcessProbe::open(guard.id()).expect("親のハンドルを開ける");
        let assigned = !fail_assign
            && outer.assign(windows::Win32::Foundation::HANDLE(
                guard.child().as_raw_handle(),
            ));
        if !assigned {
            drop(guard);
            let _ = std::fs::remove_dir_all(&dir);
            return Err(probe);
        }
        let child = guard.release();
        let guard = ChildGuard::new(child);
        let thread =
            windows::Win32::Foundation::HANDLE(guard.child().main_thread_handle().as_raw_handle());
        // SAFETY: 親の child が生きているあいだ、主スレッドのハンドルは有効。
        let resumed = unsafe { windows::Win32::System::Threading::ResumeThread(thread) };
        // 外の停止が重なっていれば2以上（J-24）。0 と失敗だけが異常。
        assert!(resumed >= 1 && resumed != u32::MAX);
        Ok(Self {
            child: guard.release(),
            dir,
            _outer: outer,
        })
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

// 外側の Job へ入れられない（注入）。作った親は kill され、終了が確かめられ、残らない。
#[test]
fn a_parent_that_cannot_join_the_outer_job_is_killed_and_not_left_suspended() {
    let Err(probe) = Parent::try_start("wait", true) else {
        panic!("注入した割り当ての失敗で成功してはいけない");
    };
    assert!(probe.exited(), "持っているハンドルで、親が終わっている");
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
        let status = parent.child.wait().unwrap();
        assert!(status.success(), "親は正常に終了する（{mode}）: {status:?}");
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

// 戻り値が1の通常の起動は、外の停止の確認を足さない（挙動を変えない）。確認が要るのは2以上のときだけ。
#[test]
fn only_a_resume_result_of_two_or_more_asks_for_the_start_confirmation() {
    let host = AudioHost::new(std::env::temp_dir().join("auralyn-confirm-flag"));
    for (result, confirmation) in [(1, false), (2, true), (3, true)] {
        seam::set_resume(seam::Resume::Returns(result));
        let guard = ChildGuard::new(host.spawn_engine_binary(cmd_exe()).unwrap());
        let (child, _job, suspended) =
            reaper_seam::contain(&host, Role::Primary, guard.release()).unwrap();
        seam::set_resume(seam::Resume::Real);
        assert_eq!(suspended, confirmation, "戻り値 {result}");
        // 実際には再開していない（戻り値だけの差し替え）。停止したままの子を残さない。
        drop(ChildGuard::new(child));
    }
}
// J-24：確認の命令への応答が EOF・拒否のときは、成功にしない（起動の失敗）。
#[test]
fn w1c_an_eof_or_a_rejection_during_the_start_confirmation_is_a_failed_start() {
    for (label, steps) in [
        ("eof", vec![Step::Exit]),
        ("rejected", vec![error_line("unknown command")]),
    ] {
        let (mut host, observer) = scripted_parts([("StartIdentityCapability", steps)]);
        seam::set_resume(seam::Resume::ExternalSuspend(Some(Duration::from_millis(
            100,
        ))));
        let error = host.ensure_engine_running().unwrap_err();
        seam::set_resume(seam::Resume::Real);
        assert_eq!(error.to_string(), engine_life::LAUNCH_FAILED, "{label}");
        assert!(host.child.is_none(), "{label}");
        assert!(observer.probe(0).wait_exit(5000), "{label}: 回収されている");
        finish(host, observer);
    }
}

// 通常の起動（戻り値が1）の後、子へ最初に届く命令は確認の命令ではない（呼び出し側から確かめる）。
#[test]
fn a_normal_start_sends_no_confirmation_command_to_the_child() {
    let (mut host, observer) = scripted_parts([]);
    seam::set_resume(seam::Resume::Normalized);
    host.ensure_engine_running().unwrap();
    seam::set_resume(seam::Resume::Real);
    host.execute_running_command(IpcCommand::GetDevices)
        .unwrap();
    assert_eq!(
        observer.sent().first().map(String::as_str),
        Some("GetDevices"),
        "先頭に StartIdentityCapability がない"
    );
    finish(host, observer);
}
