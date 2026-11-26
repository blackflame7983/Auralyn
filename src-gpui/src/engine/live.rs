//! 配信用の出力（Tauri 版と同じ `AudioHost::live_output`。保存も同じ `live_output.json`）。

use super::*;
use auralyn_ui_model::live_output::{Draft, Live};
use vst_host_lib::audio_engine::live_output::{Config as LiveConfig, Status as LiveStatus};

impl Control {
    /// `draft` があれば、今の構成に重ねて保存・反映する（自分用と配信用の処理の分け方は保つ。分けないなら外す）。
    /// 断られたら理由を送り、今の状態を読み直して送る。`None` なら読むだけ。
    pub(super) fn live_output(&mut self, draft: Option<Draft>) {
        let saving = draft.is_some();
        let result = match draft {
            None => self.host.live_output(None),
            Some(draft) => self.host.live_output(None).and_then(|status| {
                let split = status.config.split_processing && draft.device_id.is_some();
                self.host.live_output(Some(LiveConfig {
                    split_processing: split,
                    device_id: draft.device_id,
                    monitor_trim: draft.monitor_trim,
                    broadcast_trim: draft.broadcast_trim,
                    monitor_muted: draft.monitor_muted,
                    ..status.config
                }))
            }),
        };
        let result = match result {
            Err(e) if saving => {
                let _ = self.notices.send(Notice::Live(Err(e.to_string())));
                self.host.live_output(None)
            }
            other => other,
        };
        let result = result
            .map(|status| view(&status))
            .map_err(|e| e.to_string());
        let _ = self.notices.send(Notice::Live(result));
    }
}

fn view(status: &LiveStatus) -> Live {
    let config = &status.config;
    Live {
        saved: Draft {
            device_id: config.device_id.clone(),
            monitor_trim: config.monitor_trim,
            broadcast_trim: config.broadcast_trim,
            monitor_muted: config.monitor_muted,
        },
        split: config.split_processing,
        active: status.sink.as_ref().is_some_and(|sink| sink.active),
        failed: status.sink.as_ref().is_some_and(|sink| sink.failed),
        error: status.error.clone(),
    }
}
