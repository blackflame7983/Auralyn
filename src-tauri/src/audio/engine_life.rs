//! 音声エンジンの子プロセスの寿命。停止の状態で作って Job に入れてから動かし、
//! 終了は上限つきで確かめる。終了を確かめられない子は、主の `AudioHost` の役割ごとの記録に残す。
use std::process::{Child, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

#[cfg(windows)]
pub(super) type JobHandle = crate::process_job::Job;
#[cfg(not(windows))]
pub(super) type JobHandle = ();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Role {
    Primary,
    PostMix,
}

impl Role {
    fn index(self) -> usize {
        match self {
            Self::Primary => 0,
            Self::PostMix => 1,
        }
    }
}

/// 終了の確認を繰り返す間隔。
const POLL: Duration = Duration::from_millis(50);
/// `kill()` の後に終了を確かめる上限。
pub(super) const CONFIRM: Duration = Duration::from_secs(2);
/// 最初の `kill()` から、案内を「アプリを再起動してください」へ切り替えるまで。
pub(crate) const DEADLINE: Duration = Duration::from_secs(10);
/// アプリの終了で、全部の子に共通の確認の上限。
const SHUTDOWN: Duration = Duration::from_secs(2);

pub(crate) const UNCONFIRMED_JA: &str =
    "音声エンジンの終了を確認できません。しばらくしてからもう一度お試しください";
pub(crate) const REPEATED_JA: &str =
    "音声エンジンを終了できません。Auralyn を終了して、起動し直してください";
/// Job の失敗を、OS のエラー文言（マイクの権限の案内へ写る語を含みうる）なしで伝える。
pub(super) const LAUNCH_FAILED: &str =
    "音声エンジンの起動を完了できませんでした。音声を開始していません";

/// `engine_unconfirmed`。旧の子の終了を確かめられないので、同じ役割の子を作らない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EngineUnconfirmed {
    pub(crate) repeated: bool,
}

impl EngineUnconfirmed {
    pub(crate) fn text(repeated: bool) -> String {
        if repeated {
            REPEATED_JA.to_owned()
        } else {
            UNCONFIRMED_JA.to_owned()
        }
    }
}

impl std::fmt::Display for EngineUnconfirmed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&Self::text(self.repeated))
    }
}

impl std::error::Error for EngineUnconfirmed {}

fn now() -> Instant {
    #[cfg(test)]
    if let Some(virtual_now) = seam::virtual_now() {
        return virtual_now;
    }
    Instant::now()
}

fn sleep(duration: Duration) {
    #[cfg(test)]
    if seam::advance_clock(duration) {
        return;
    }
    std::thread::sleep(duration);
}

pub(super) fn try_wait(child: &mut Child) -> std::io::Result<Option<ExitStatus>> {
    #[cfg(test)]
    match seam::wait() {
        seam::Wait::Real => {}
        seam::Wait::Stuck => return Ok(None),
        seam::Wait::Fails => return Err(std::io::Error::other("seam: try_wait")),
    }
    child.try_wait()
}

/// `Ok(Some)` だけを終了の証拠にする。`Ok(None)` と `Err` は確かめられていない。
fn exited(child: &mut Child) -> bool {
    matches!(try_wait(child), Ok(Some(_)))
}

fn confirm(child: &mut Child, limit: Duration) -> bool {
    let start = now();
    loop {
        if exited(child) {
            return true;
        }
        let elapsed = now().saturating_duration_since(start);
        if elapsed >= limit {
            return false;
        }
        sleep(POLL.min(limit - elapsed));
    }
}

struct Retired {
    child: Child,
    _job: Option<JobHandle>,
    /// 最初の `kill()` の時刻。
    killed_at: Instant,
}

type Slots = [Vec<Retired>; 2];

/// 終了が確かめられた記録を取り除いて返す。残った子へは `kill()` をやり直す。返した記録は、ロックの外で落とす。
fn reap(list: &mut Vec<Retired>) -> Vec<Retired> {
    let mut removed = Vec::new();
    let mut at = 0;
    while at < list.len() {
        if exited(&mut list[at].child) {
            removed.push(list.remove(at));
        } else {
            let _ = list[at].child.kill();
            at += 1;
        }
    }
    removed
}

/// 終了を確かめられない子の記録。主の `AudioHost` が持ち、配信ミックスの子の `AudioHost` と共有する。
/// 子を手放す経路が、次の生成・`State` の差し替え・呼び出し元への復帰より先に、ここへ移す。
#[derive(Default)]
pub(super) struct Store {
    slots: Mutex<Slots>,
    recorded: [AtomicU64; 2],
}

impl Store {
    fn lock(&self) -> std::sync::MutexGuard<'_, Slots> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn push(&self, role: Role, child: Child, job: Option<JobHandle>, killed_at: Instant) {
        self.recorded[role.index()].fetch_add(1, Ordering::AcqRel);
        self.lock()[role.index()].push(Retired {
            child,
            _job: job,
            killed_at,
        });
    }

    /// 試験で、生きたままの子を、`kill` も確認もせずに記録へ置く（終わらない子の再現）。
    #[cfg(test)]
    pub(super) fn adopt_for_test(&self, role: Role, child: Child) {
        self.push(role, child, None, now());
    }

    /// 案内を切り替えるのは、確かめた役割の記録が、最初の `kill()` から期限を過ぎても残るとき。
    fn error(slots: &Slots, roles: &[Role]) -> EngineUnconfirmed {
        let now = now();
        EngineUnconfirmed {
            repeated: roles.iter().any(|role| {
                slots[role.index()]
                    .iter()
                    .any(|record| now.saturating_duration_since(record.killed_at) >= DEADLINE)
            }),
        }
    }

    /// `roles` の記録を1回だけ確かめる。待たない。残れば失敗にする。
    fn check(&self, roles: &[Role]) -> Result<(), EngineUnconfirmed> {
        let (removed, failed) = {
            let mut slots = self.lock();
            let mut removed = Vec::new();
            for role in roles {
                removed.extend(reap(&mut slots[role.index()]));
            }
            let alive = roles.iter().any(|role| !slots[role.index()].is_empty());
            (removed, alive.then(|| Self::error(&slots, roles)))
        };
        if !removed.is_empty() {
            log::info!("終了を確認しました（{roles:?}）");
        }
        drop(removed);
        failed.map_or(Ok(()), Err)
    }

    /// 同じ役割の子を作る前に呼ぶ。待たない。
    pub(super) fn ensure_clear(&self, role: Role) -> Result<(), EngineUnconfirmed> {
        self.check(&[role])
    }

    /// 更新の前に、全部の役割を1回だけ確かめる。
    pub(super) fn recheck(&self) -> Result<(), EngineUnconfirmed> {
        self.check(&[Role::Primary, Role::PostMix])
    }

    /// アプリの終了で、記録の子を共通の期限へ渡す。
    pub(super) fn drain(&self) -> Vec<(Child, Option<JobHandle>)> {
        self.lock()
            .iter_mut()
            .flat_map(std::mem::take)
            .map(|r| (r.child, r._job))
            .collect()
    }

    /// 終了を確かめられず、記録に残っている子の数。
    #[cfg(test)]
    pub(super) fn pending(&self, role: Role) -> usize {
        self.lock()[role.index()].len()
    }

    /// 記録した累計。減らない。
    pub(super) fn recorded(&self, role: Role) -> u64 {
        self.recorded[role.index()].load(Ordering::Acquire)
    }

    /// `role` の記録を確かめ直して作る `engine_unconfirmed`。残っていなければ初回の案内。
    pub(super) fn unconfirmed_error(&self, role: Role) -> EngineUnconfirmed {
        self.check(&[role])
            .err()
            .unwrap_or(EngineUnconfirmed { repeated: false })
    }
}

/// 子を `kill()` し、最大 `CONFIRM` だけ終了を確かめる。確かめられなければ、子と Job と
/// 最初の `kill()` の時刻を記録へ移す。子を手放す経路は、すべてこれを通す。
pub(super) fn retire_child(store: &Store, role: Role, mut child: Child, job: Option<JobHandle>) {
    let killed_at = now();
    let _ = child.kill();
    if confirm(&mut child, CONFIRM) {
        drop(job);
        #[cfg(test)]
        seam::stage(seam::Stage::Retired(role));
        return;
    }
    log::warn!("音声エンジンの終了を確認できません（{role:?}）。記録して、作り直しを止めます");
    store.push(role, child, job, killed_at);
    #[cfg(test)]
    seam::stage(seam::Stage::Retired(role));
}

/// アプリの終了。全部の子へ `kill()` を送り、共通の `SHUTDOWN` だけ確かめて、終わらなくても戻る。
pub(super) fn terminate_all(children: Vec<(Child, Option<JobHandle>)>) {
    let mut children = children;
    for (child, _) in &mut children {
        let _ = child.kill();
    }
    let start = now();
    loop {
        children.retain_mut(|(child, _)| !exited(child));
        let elapsed = now().saturating_duration_since(start);
        if children.is_empty() || elapsed >= SHUTDOWN {
            return;
        }
        sleep(POLL.min(SHUTDOWN - elapsed));
    }
}

/// 子の生成のフラグ。停止の状態で作り（`contain_and_resume` が Job へ入れてから動かす）、窓を出さない。
/// 製品の生成と試験の起動が、この1か所を通る。
pub(super) fn apply_creation_flags(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_SUSPENDED: u32 = 0x00000004;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// 停止の状態の子を Job に入れ、主スレッドを再開する。どれかが失敗したら、子を終わらせて失敗にする。
#[cfg(windows)]
pub(super) fn contain_and_resume(
    store: &Store,
    role: Role,
    child: Child,
) -> anyhow::Result<(Child, Option<JobHandle>, bool)> {
    #[cfg(test)]
    seam::stage(seam::Stage::Spawned(child.id()));
    let Some(job) = new_job() else {
        log::error!("Job を作成できません。音声エンジンを起動しません");
        retire_child(store, role, child, None);
        anyhow::bail!(LAUNCH_FAILED);
    };
    if !assign(&job, &child) {
        log::error!("音声エンジンを Job に割り当てられません。起動しません");
        retire_child(store, role, child, Some(job));
        anyhow::bail!(LAUNCH_FAILED);
    }
    #[cfg(test)]
    seam::stage(seam::Stage::Assigned(child.id()));
    let resumed = resume(&child);
    // 0 は私たちの停止がすでになかった（Job に入れる前に動いていた）、u32::MAX は失敗。
    // 2 以上は、外の停止（ウイルス対策ソフトなど）が重なっている。私たちの再開は効いているので成功にする。
    if resumed == 0 || resumed == u32::MAX {
        log::error!("音声エンジンの主スレッドを再開できません（戻り値 {resumed}）。起動しません");
        retire_child(store, role, child, Some(job));
        anyhow::bail!(LAUNCH_FAILED);
    }
    if resumed > 1 {
        log::warn!("音声エンジンの主スレッドに、外の停止が重なっていました（再開の前の停止の数 {resumed}）。外の停止が解かれると動き出します");
    }
    // 外の停止が重なった子は、解かれるまで動かない。最初の応答が来るまでを起動の確認にする（呼び出し側）。
    Ok((child, Some(job), resumed > 1))
}

#[cfg(not(windows))]
pub(super) fn contain_and_resume(
    _store: &Store,
    _role: Role,
    child: Child,
) -> anyhow::Result<(Child, Option<JobHandle>, bool)> {
    Ok((child, None, false))
}

#[cfg(windows)]
fn new_job() -> Option<JobHandle> {
    #[cfg(test)]
    match seam::job() {
        seam::JobSource::Real => {}
        seam::JobSource::CreateFails => return None,
        seam::JobSource::Provided(job) => return job,
    }
    crate::process_job::Job::new_kill_on_drop()
}

#[cfg(windows)]
fn assign(job: &JobHandle, child: &Child) -> bool {
    #[cfg(test)]
    if matches!(seam::assign(), seam::Assign::Fails) {
        return false;
    }
    use std::os::windows::io::AsRawHandle;
    job.assign(windows::Win32::Foundation::HANDLE(child.as_raw_handle()))
}

/// `ResumeThread` の戻り値（停止の数の、再開の前の値）。成功は `1` 以上（`2` 以上は外の停止が重なっている）。
#[cfg(windows)]
fn resume(child: &Child) -> u32 {
    #[cfg(test)]
    match seam::resume() {
        seam::Resume::Real => {}
        seam::Resume::Returns(value) => return value,
        // 外の停止が重なっていても、停止の数が0になるまで再開し、通常の起動と同じ `1` を返す。
        seam::Resume::Normalized => loop {
            let before = resume_main_thread(child);
            if before <= 1 || before == u32::MAX {
                return before;
            }
        },
        seam::Resume::ResumedEarly => {
            // 外の停止が重なっていても、停止の数が0になるまで先に再開する（その後の本来の再開は 0 を返す）。
            loop {
                let before = resume_main_thread(child);
                if before <= 1 || before == u32::MAX {
                    break;
                }
            }
        }
        // 外の停止を1回重ねてから、本来の再開を呼ぶ（戻り値は `2`。子は外の停止が解かれるまで止まる）。
        seam::Resume::ExternalSuspend(release_after) => {
            use std::os::windows::io::AsRawHandle;
            use std::os::windows::process::ChildExt;
            let thread =
                windows::Win32::Foundation::HANDLE(child.main_thread_handle().as_raw_handle());
            // SAFETY: `child` が生きているあいだ、主スレッドのハンドルは有効で、呼び出しの間だけ借りる。
            let _ = unsafe { windows::Win32::System::Threading::SuspendThread(thread) };
            if let (Some(delay), Some(owned)) =
                (release_after, seam::OwnedThread::duplicate(thread))
            {
                // 外の停止が解かれる時刻。解く側は、自分で複製したハンドルを持つ。
                std::thread::spawn(move || {
                    let owned = owned;
                    std::thread::sleep(delay);
                    // SAFETY: 複製したハンドルは、このスレッドだけが持ち、`Drop` で一度だけ閉じる。
                    let _ = unsafe { windows::Win32::System::Threading::ResumeThread(owned.0) };
                });
            }
        }
    }
    resume_main_thread(child)
}

#[cfg(windows)]
fn resume_main_thread(child: &Child) -> u32 {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::ChildExt;
    let thread = windows::Win32::Foundation::HANDLE(child.main_thread_handle().as_raw_handle());
    // SAFETY: `child` が生きているあいだ、主スレッドのハンドルは有効で、呼び出しの間だけ借りる。
    unsafe { windows::Win32::System::Threading::ResumeThread(thread) }
}

/// 試験の継ぎ目。本番の経路は変えず、試験のスレッドごとに Job・割り当て・再開・`try_wait`・時計を差し替える。
#[cfg(test)]
pub(crate) mod seam {
    use super::{Duration, Instant, JobHandle};
    use std::cell::RefCell;

    /// 試験のスレッドへ渡す、複製したスレッドのハンドル。
    pub(super) struct OwnedThread(pub(super) windows::Win32::Foundation::HANDLE);

    // SAFETY: 複製したハンドルは所有者だけが使い、`Drop` で一度だけ閉じる。
    unsafe impl Send for OwnedThread {}

    impl OwnedThread {
        pub(super) fn duplicate(thread: windows::Win32::Foundation::HANDLE) -> Option<Self> {
            use windows::Win32::Foundation::{DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE};
            use windows::Win32::System::Threading::GetCurrentProcess;
            let mut copy = HANDLE::default();
            // SAFETY: `thread` は呼び出しの間だけ借りる有効なハンドルで、複製は呼び出し側が所有する。
            unsafe {
                let process = GetCurrentProcess();
                DuplicateHandle(
                    process,
                    thread,
                    process,
                    &mut copy,
                    0,
                    false,
                    DUPLICATE_SAME_ACCESS,
                )
            }
            .ok()
            .map(|()| Self(copy))
        }
    }

    impl Drop for OwnedThread {
        fn drop(&mut self) {
            // SAFETY: この複製を所有するのは自分だけで、ここで一度だけ閉じる。
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub(crate) enum Wait {
        Real,
        Stuck,
        Fails,
    }

    pub(crate) enum JobSource {
        Real,
        CreateFails,
        Provided(Option<JobHandle>),
    }

    #[derive(Clone, Copy)]
    pub(crate) enum Assign {
        Real,
        Fails,
    }

    #[derive(Clone, Copy)]
    pub(crate) enum Resume {
        Real,
        /// 再開を呼ばずに、この値を返す。
        Returns(u32),
        /// 先に実際に再開してから、本来の再開を呼ぶ（戻り値は `0`。子は動いている）。
        ResumedEarly,
        /// 本来の再開の前に、外の停止を1回重ねる（戻り値は `2`）。`Some` なら、その時間の後に外の停止を解く。
        ExternalSuspend(Option<Duration>),
        /// 負荷で外の停止が重なっても、戻り値が 1 の通常の起動にそろえる。
        Normalized,
    }

    pub(in crate::audio) enum Stage {
        Spawned(u32),
        Assigned(u32),
        /// `retire_child` が、終了を確かめた、または記録へ移した直後。
        Retired(super::Role),
        /// `ensure_clear` の失敗（`engine_unconfirmed`）が決まった直後。まだ返していない。
        ResultDecided,
    }

    struct State {
        wait: Wait,
        job: JobSource,
        assign: Assign,
        resume: Resume,
        clock: Option<(Instant, Duration)>,
        stage: Option<Box<dyn FnMut(Stage)>>,
    }

    thread_local! {
        static STATE: RefCell<State> = const { RefCell::new(State {
            wait: Wait::Real,
            job: JobSource::Real,
            assign: Assign::Real,
            resume: Resume::Real,
            clock: None,
            stage: None,
        }) };
    }

    fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
        STATE.with(|state| f(&mut state.borrow_mut()))
    }

    pub(super) fn wait() -> Wait {
        with(|s| s.wait)
    }
    pub(super) fn job() -> JobSource {
        with(|s| std::mem::replace(&mut s.job, JobSource::Real))
    }
    pub(super) fn assign() -> Assign {
        with(|s| s.assign)
    }
    pub(super) fn resume() -> Resume {
        with(|s| s.resume)
    }
    /// 仮想の時計の今。実際の時間は混ざらず、`sleep` の分だけ進む。
    pub(super) fn virtual_now() -> Option<Instant> {
        with(|s| s.clock.map(|(base, offset)| base + offset))
    }
    pub(super) fn advance_clock(duration: Duration) -> bool {
        with(|s| match &mut s.clock {
            Some((_, offset)) => {
                *offset += duration;
                true
            }
            None => false,
        })
    }
    pub(in crate::audio) fn stage(stage: Stage) {
        if let Some(mut hook) = with(|s| s.stage.take()) {
            hook(stage);
            with(|s| s.stage = Some(hook));
        }
    }

    /// `try_wait` を差し替える。`Stuck` と `Fails` では、時計も仮想にして実際には待たない。
    pub(crate) fn set_wait(wait: Wait) {
        with(|s| {
            s.wait = wait;
            if wait != Wait::Real && s.clock.is_none() {
                s.clock = Some((Instant::now(), Duration::ZERO));
            }
        });
    }
    /// 仮想の時計を進める。記録の子が、最初の `kill()` から期限を過ぎた状況を作る。
    pub(crate) fn pass(duration: Duration) {
        with(|s| {
            let (_, offset) = s.clock.get_or_insert((Instant::now(), Duration::ZERO));
            *offset += duration;
        });
    }
    pub(crate) fn set_job(job: JobSource) {
        with(|s| s.job = job);
    }
    pub(crate) fn set_assign(assign: Assign) {
        with(|s| s.assign = assign);
    }
    pub(crate) fn set_resume(resume: Resume) {
        with(|s| s.resume = resume);
    }
    pub(in crate::audio) fn on_stage(hook: impl FnMut(Stage) + 'static) {
        with(|s| s.stage = Some(Box::new(hook)));
    }
    /// 仮想の時計が進んだ量。
    pub(crate) fn elapsed() -> Duration {
        with(|s| s.clock.map(|(_, offset)| offset).unwrap_or_default())
    }
}
