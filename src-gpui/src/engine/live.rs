//! 配信用の出力（`AudioHost::live_output`。保存も同じ `live_output.json`）。

use super::*;
use auralyn_ui_model::live_output::{Draft, Live};
use vst_host_lib::audio_engine::builtin::{Config as BuiltinConfig, Preset as BuiltinPreset};
use vst_host_lib::audio_engine::live_output::{Config as LiveConfig, Status as LiveStatus};
use vst_host_lib::audio_engine::reverb::ReverbParams;
use vst_host_lib::audio_engine::singing::SingingParams;

impl Control {
    /// `draft` があれば、今の構成に重ねて保存・反映する。
    /// 保存の結果を送り、断られたら今の状態を読み直して送る。`None` なら読むだけ。
    pub(super) fn live_output(&mut self, draft: Option<Draft>) {
        let saving = draft.is_some();
        let result = match draft {
            None => self.host.live_output(None),
            Some(draft) => self.host.live_output(None).and_then(|status| {
                // 分けるときは、自分用の歌・雑談の加工が要る。無ければ既定で入れる（ある値は変えない）。
                let (singing, talk) = if draft.split {
                    (
                        status
                            .config
                            .monitor_singing
                            .clone()
                            .or_else(|| Some(monitor(true))),
                        status
                            .config
                            .monitor_talk
                            .clone()
                            .or_else(|| Some(monitor(false))),
                    )
                } else {
                    (
                        status.config.monitor_singing.clone(),
                        status.config.monitor_talk.clone(),
                    )
                };
                self.host.live_output(Some(LiveConfig {
                    split_processing: draft.split && draft.device_id.is_some(),
                    monitor_singing: singing,
                    monitor_talk: talk,
                    device_id: draft.device_id,
                    monitor_trim: draft.monitor_trim,
                    broadcast_trim: draft.broadcast_trim,
                    monitor_muted: draft.monitor_muted,
                }))
            }),
        };
        // 保存の結果は、読んだ状態と別に送る（読み直しの成功で、断られた理由を消さないため）。
        let result = if saving {
            let saved = result.as_ref().map(|_| ()).map_err(|e| e.to_string());
            let _ = self.notices.send(Notice::LiveSaved(saved));
            result.or_else(|_| self.host.live_output(None))
        } else {
            result
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
            split: config.split_processing,
        },
        active: status.sink.as_ref().is_some_and(|sink| sink.active),
        failed: status.sink.as_ref().is_some_and(|sink| sink.failed),
        error: status.error.clone(),
    }
}

/// 自分用の歌（`singing`）・雑談の加工の既定。
fn monitor(singing: bool) -> BuiltinConfig {
    BuiltinConfig {
        active: true,
        preset: BuiltinPreset::Singing,
        amount: 0.35,
        singing: Some(SingingParams::default()),
        reverb: Some(ReverbParams {
            enabled: singing,
            mix: if singing {
                0.05
            } else {
                ReverbParams::default().mix
            },
            ..ReverbParams::default()
        }),
        deesser: None,
    }
}
