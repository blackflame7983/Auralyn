//! 終了を確かめられない子の記録と、その監視（reaper）に試験が触れる窓口。
//! 設計は docs/plans/audio-session-f1b0b-design.md の13.13。試験は、`Store`・`Retired`・`seam` の内側を直接つかまず、ここを通る。
use super::engine_life::{seam, EngineUnconfirmed, Mode, Role, Timing};
use super::*;
use std::time::Duration;

/// `try_wait` を「終わらない」に差し替える。差し替え中に記録へ移った子の監視も、終わりを観測しない。
pub(super) fn stuck() {
    seam::set_wait(seam::Wait::Stuck);
}

/// `try_wait` を実際の子へ戻す。止めていた監視は、実際の子を確かめる。
pub(super) fn real() {
    seam::set_wait(seam::Wait::Real);
}

/// `try_wait` を失敗させる。
pub(super) fn fails() {
    seam::set_wait(seam::Wait::Fails);
}

pub(super) fn pending(host: &AudioHost, role: Role) -> usize {
    host.retired.pending(role)
}

pub(super) fn counts(host: &AudioHost, role: Role) -> Vec<u32> {
    host.retired.counts(role)
}

pub(super) fn unconfirmed(host: &AudioHost) -> EngineUnconfirmed {
    host.retired.unconfirmed_error()
}

pub(super) fn recheck(host: &AudioHost) -> Result<(), EngineUnconfirmed> {
    host.retired.recheck()
}

/// `child` を、`host` と同じ記録（と監視）につなぐ。
pub(super) fn share(host: &AudioHost, child: &mut AudioHost) {
    child.retired = host.retired.clone();
}

pub(super) fn post_mix_state(host: &AudioHost, root: &std::path::Path) -> post_mix::State {
    post_mix::State::new(root, host.retired.clone())
}

/// 生きたままの子を、`kill` も確認もせずに記録へ置く（終わらない子の再現）。子は終わらせるまで残る。
pub(super) fn adopt(host: &AudioHost, role: Role, child: std::process::Child) {
    host.retired.adopt_for_test(role, child);
}

/// 停止の状態の子を Job に入れて動かす。失敗すれば、記録へ移る。
pub(super) fn contain(
    host: &AudioHost,
    role: Role,
    child: std::process::Child,
) -> anyhow::Result<(std::process::Child, Option<engine_life::JobHandle>, bool)> {
    engine_life::contain_and_resume(&host.retired, role, child)
}

/// 記録の窓の長さ（最初の `kill()` から）と、`kill()` のやり直しの間隔・見直しの間隔を縮める。
pub(super) fn set_timing(host: &AudioHost, timing: Timing) {
    host.retired.set_timing(timing);
}

/// 試験で使う、縮めた時間の設定。
pub(super) fn short(deadline: Duration) -> Timing {
    Timing {
        deadline,
        retry_kill: (deadline / 3).max(Duration::from_millis(10)),
        rescan: Duration::from_millis(50),
    }
}

/// 窓を縮めて、記録の窓が実時間で過ぎるまで待つ。「窓が過ぎた後」の規則を試験するとき、要求の前に入れる。
pub(super) fn pass_window(host: &AudioHost) {
    let deadline = Duration::from_millis(200);
    set_timing(host, short(deadline));
    std::thread::sleep(deadline + Duration::from_millis(100));
}

/// 差し替え中に記録へ移った子の監視への台本。
pub(super) fn script() -> Option<std::sync::Arc<engine_life::Script>> {
    seam::current_script()
}

/// 台本の動き（終わりを観測しない・実際の子を確かめる・panic する・失敗し続ける）を切り替える。
pub(super) fn set_mode(mode: Mode) {
    if let Some(script) = script() {
        script.set(mode);
    }
}
