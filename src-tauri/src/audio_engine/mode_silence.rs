//! モード切替時の無音確認 IPC 契約。

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

pub(crate) const MAIN: usize = 0;
pub(crate) const INPUT: usize = 1;
pub(crate) const MONITOR: usize = 2;
pub(crate) const SINK: usize = 3;
const HELD: u64 = 1;
const SOURCES: u64 = 2;
const SINKS: u64 = 3;
const RELEASED: u64 = 4;
const FAILED: u64 = 5;

/// 各callbackの末尾でのみACKする。キュー投入の成功は無音成立の証拠にしない。
#[derive(Default)]
pub(crate) struct Shared {
    state: AtomicU64,
    acks: [AtomicU64; 4],
    drained: AtomicU64,
    monitor_drained: AtomicU64,
    sources: AtomicU64,
}
impl Shared {
    /// 入力履歴を破棄したcallbackだけが停止をACKする。
    /// 処理途中にSOURCESへ進んだcallbackは、次のcallbackのresetを待つ。
    pub(crate) fn pause_input(&self, reset: impl FnOnce()) -> bool {
        if !self.pause_sources() {
            return false;
        }
        reset();
        self.source_finished(INPUT);
        true
    }
    pub(crate) fn ticket(&self) -> u64 {
        self.state.load(Ordering::Acquire)
    }
    pub(crate) fn active(&self) -> bool {
        matches!(self.ticket() & 7, HELD | SOURCES | SINKS | FAILED)
    }
    pub(crate) fn pause_sources(&self) -> bool {
        matches!(self.ticket() & 7, SOURCES | SINKS | FAILED)
    }
    pub(crate) fn finish(&self, role: usize, ticket: u64, data: &mut [f32]) {
        let current = self.ticket();
        if current != ticket || self.active() {
            data.fill(0.0);
        }
        // 同じFnMut callbackの完了後は、そのcallbackから古いPCMを追加できない。
        if self.active()
            && (role != MONITOR
                || current & 7 != SOURCES
                || self.monitor_drained.load(Ordering::Acquire) == current)
        {
            self.acks[role].store(current, Ordering::Release);
        }
    }
    pub(crate) fn source_finished(&self, role: usize) {
        let current = self.ticket();
        if self.pause_sources() {
            self.acks[role].store(current, Ordering::Release);
        }
    }
    pub(crate) fn drain_worker(&self) -> bool {
        let state = self.ticket();
        state & 7 == SOURCES && self.acknowledged(self.sources.load(Ordering::Acquire), state)
    }
    pub(crate) fn drain_monitor_input(&self) -> bool {
        let state = self.ticket();
        state & 7 == SOURCES && self.acks[INPUT].load(Ordering::Acquire) == state
    }
    pub(crate) fn monitor_input_drained(&self) {
        self.monitor_drained.store(self.ticket(), Ordering::Release);
    }
    pub(crate) fn worker_drained(&self) {
        self.drained.store(self.ticket(), Ordering::Release);
    }
    fn acknowledged(&self, mask: u64, state: u64) -> bool {
        (0..4)
            .all(|role| mask & (1 << role) == 0 || self.acks[role].load(Ordering::Acquire) == state)
    }
}

#[derive(Default)]
pub(crate) struct Controller {
    pub(crate) shared: Arc<Shared>,
    id: Option<String>,
    serial: u64,
    stream: u64,
    roles: u64,
}
impl Controller {
    pub(crate) fn invalidate(&mut self) {
        if self.shared.active() {
            self.shared
                .state
                .store((self.serial << 3) | FAILED, Ordering::Release);
        }
    }
    pub(crate) fn request(
        &mut self,
        request: Request,
        stream: u64,
        running: bool,
        split: bool,
        sink: bool,
        failed: bool,
    ) -> Result<Snapshot, String> {
        let id = match &request {
            Request::Begin { id } | Request::Snapshot { id } | Request::Finish { id } => id,
        };
        if id.is_empty() || id.len() > 128 {
            return Err("切替の識別情報が不正です".into());
        }
        if matches!(request, Request::Begin { .. }) {
            if self.shared.active() {
                if self.id.as_ref() != Some(id) {
                    return Err("別の切替を処理中です".into());
                }
            } else {
                if self.id.as_ref() == Some(id) {
                    return Err("完了した切替要求の再利用を拒否しました".into());
                }
                if !running || failed {
                    return Err("音声の稼働を確認してから切り替えてください".into());
                }
                self.serial = self
                    .serial
                    .checked_add(1)
                    .filter(|n| *n < (u64::MAX >> 3))
                    .ok_or("切替回数の上限です")?;
                self.id = Some(id.clone());
                self.stream = stream;
                self.roles = (1 << MAIN)
                    | if split { 1 << MONITOR } else { 0 }
                    | if sink { 1 << SINK } else { 0 };
                self.shared.sources.store(
                    (1 << INPUT) | if split { 1 << MONITOR } else { 0 },
                    Ordering::Release,
                );
                self.shared
                    .state
                    .store((self.serial << 3) | HELD, Ordering::Release);
            }
        } else if self.id.as_ref() != Some(id) {
            return Err("古い切替要求を拒否しました".into());
        }
        if self.stream != stream || !running || failed {
            self.invalidate();
        }
        let mut state = self.shared.ticket();
        if matches!(request, Request::Finish { .. }) && state & 7 == HELD {
            if !self.shared.acknowledged(self.roles, state) {
                return Err("出力の無音確認を待っています".into());
            }
            state = (self.serial << 3) | SOURCES;
            self.shared.state.store(state, Ordering::Release);
        }
        // source停止→worker排出→物理sink排出を順番に確認してから解除する。
        if state & 7 == SOURCES
            && self
                .shared
                .acknowledged(self.shared.sources.load(Ordering::Acquire), state)
            && self.shared.drained.load(Ordering::Acquire) == state
            && self.shared.acks[MAIN].load(Ordering::Acquire) == state
        {
            state = (self.serial << 3) | SINKS;
            self.shared.state.store(state, Ordering::Release);
        }
        if state & 7 == SINKS && self.shared.acknowledged(self.roles & (1 << SINK), state) {
            state = (self.serial << 3) | RELEASED;
            self.shared.state.store(state, Ordering::Release);
        }
        Ok(Snapshot {
            id: id.clone(),
            active: self.shared.active(),
            ready: state & 7 == HELD && self.shared.acknowledged(self.roles, state),
            running,
            failed: state & 7 == FAILED,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Request {
    Begin { id: String },
    Snapshot { id: String },
    Finish { id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub active: bool,
    pub ready: bool,
    pub running: bool,
    pub failed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(controller: &mut Controller, action: &str) -> Snapshot {
        let id = "operation".to_owned();
        let request = match action {
            "begin" => Request::Begin { id },
            "finish" => Request::Finish { id },
            _ => Request::Snapshot { id },
        };
        controller
            .request(request, 1, true, true, true, false)
            .unwrap()
    }
    fn ack(shared: &Shared, role: usize) {
        let mut data = [1.0; 16];
        let ticket = shared.ticket();
        if role == MONITOR && shared.drain_monitor_input() {
            shared.monitor_input_drained();
        }
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| shared.finish(role, ticket, &mut data)),
            (0, 0)
        );
        assert_eq!(data, [0.0; 16]);
    }

    #[test]
    fn mode_silence_requires_actual_output_acks_and_ordered_release() {
        let mut controller = Controller::default();
        assert!(!request(&mut controller, "begin").ready);
        assert!(controller
            .request(
                Request::Finish {
                    id: "operation".into()
                },
                1,
                true,
                true,
                true,
                false
            )
            .is_err());
        ack(&controller.shared, MAIN);
        ack(&controller.shared, MONITOR);
        assert!(!request(&mut controller, "snapshot").ready);
        ack(&controller.shared, SINK);
        assert!(request(&mut controller, "snapshot").ready);
        assert!(request(&mut controller, "finish").active);
        // 制御側のFinish成功だけでは解除せず、先行入力の終了とqueue排出を待つ。
        assert!(!controller.shared.drain_worker());
        controller.shared.source_finished(INPUT);
        ack(&controller.shared, MONITOR);
        assert!(controller.shared.drain_worker());
        controller.shared.worker_drained();
        assert!(request(&mut controller, "snapshot").active);
        ack(&controller.shared, MAIN);
        assert!(request(&mut controller, "snapshot").active);
        ack(&controller.shared, SINK);
        assert!(!request(&mut controller, "snapshot").active);
    }

    #[test]
    fn mode_silence_stale_ids_stopped_stream_and_failures_never_release() {
        let mut controller = Controller::default();
        assert!(controller
            .request(
                Request::Begin {
                    id: "operation".into()
                },
                1,
                false,
                false,
                false,
                false
            )
            .is_err());
        request(&mut controller, "begin");
        for request in [
            Request::Begin { id: "other".into() },
            Request::Finish { id: "other".into() },
            Request::Snapshot { id: "other".into() },
        ] {
            assert!(controller
                .request(request, 1, true, true, true, false)
                .is_err());
        }
        ack(&controller.shared, MAIN);
        ack(&controller.shared, MONITOR);
        ack(&controller.shared, SINK);
        let value = controller
            .request(
                Request::Snapshot {
                    id: "operation".into(),
                },
                2,
                true,
                true,
                true,
                false,
            )
            .unwrap();
        assert!(value.active && value.failed && !value.ready);
        assert!(request(&mut controller, "finish").active);
    }

    #[test]
    fn mode_silence_late_block_is_zeroed_and_old_acks_do_not_match_next_operation() {
        let mut controller = Controller::default();
        let stale = controller.shared.ticket();
        request(&mut controller, "begin");
        let mut data = [0.7; 32];
        controller.shared.finish(MAIN, stale, &mut data);
        assert_eq!(data, [0.0; 32]);
        assert!(!request(&mut controller, "snapshot").ready);
        controller.invalidate();
        assert!(request(&mut controller, "snapshot").failed);
    }

    #[test]
    fn mode_silence_single_path_releases_only_after_input_and_dsp_drain() {
        let mut controller = Controller::default();
        let make = |action| match action {
            0 => Request::Begin {
                id: "single".into(),
            },
            1 => Request::Finish {
                id: "single".into(),
            },
            _ => Request::Snapshot {
                id: "single".into(),
            },
        };
        controller
            .request(make(0), 1, true, false, false, false)
            .unwrap();
        ack(&controller.shared, MAIN);
        controller
            .request(make(1), 1, true, false, false, false)
            .unwrap();
        assert!(controller.shared.pause_input(|| {}));
        assert!(controller.shared.drain_worker());
        controller.shared.worker_drained();
        ack(&controller.shared, MAIN);
        assert!(
            !controller
                .request(make(2), 1, true, false, false, false)
                .unwrap()
                .active
        );
    }

    #[test]
    fn mode_silence_mid_input_callback_waits_for_next_history_reset() {
        let mut controller = Controller::default();
        request(&mut controller, "begin");
        // 入力callbackの入口ではまだHELD。ここから通常処理が続く。
        assert!(!controller.shared.pause_input(|| panic!("not paused")));
        ack(&controller.shared, MAIN);
        ack(&controller.shared, MONITOR);
        ack(&controller.shared, SINK);
        request(&mut controller, "finish");
        // callback途中のFinishでは、履歴破棄なしのACKは出せない。
        assert!(!controller.shared.drain_monitor_input());
        assert!(!controller.shared.drain_worker());
        let mut reset = false;
        assert_eq!(
            crate::vst_host::instance::allocation_counts(|| {
                assert!(controller.shared.pause_input(|| {
                    assert!(!controller.shared.drain_monitor_input());
                    reset = true;
                }));
            }),
            (0, 0)
        );
        assert!(reset);
        assert!(controller.shared.drain_monitor_input());
        assert!(!controller.shared.drain_worker());
        ack(&controller.shared, MONITOR);
        assert!(controller.shared.drain_worker());
        controller.shared.worker_drained();
        ack(&controller.shared, MAIN);
        assert!(request(&mut controller, "snapshot").active);
        ack(&controller.shared, SINK);
        assert!(!request(&mut controller, "snapshot").active);
    }

    #[test]
    fn mode_silence_ipc_contract() {
        let request = Request::Begin { id: "op".into() };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({"action": "begin", "id": "op"})
        );
        let snapshot = Snapshot {
            id: "op".into(),
            active: true,
            ready: false,
            running: true,
            failed: false,
        };
        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            serde_json::json!({
                "id": "op", "active": true, "ready": false,
                "running": true, "failed": false
            })
        );
    }
}
