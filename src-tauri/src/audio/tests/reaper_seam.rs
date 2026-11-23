//! 終了を確かめられない子の記録に、試験が触れる窓口。試験は、`Store`・`Retired`・`seam` の内側を直接つかまず、ここを通る。
use super::engine_life::{seam, EngineUnconfirmed, Role, DEADLINE};
use super::*;

/// `try_wait` を「終わらない」に差し替える。
pub(super) fn stuck() {
    seam::set_wait(seam::Wait::Stuck);
}

/// `try_wait` を実際の子へ戻す。
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

pub(super) fn unconfirmed(host: &AudioHost) -> EngineUnconfirmed {
    host.retired.unconfirmed_error()
}

pub(super) fn recheck(host: &AudioHost) -> Result<(), EngineUnconfirmed> {
    host.retired.recheck()
}

/// `child` を、`host` と同じ記録につなぐ。
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

/// 仮想の時計を、期限（最初の `kill()` から10秒）の分だけ進める。`stuck` の間の試験で使う。
pub(super) fn pass_deadline() {
    seam::pass(DEADLINE);
}
