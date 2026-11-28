//! ホームの「接続の確認」のために、音声の状態を読む。
//! 読む間に条件が変われば、読めなかったことにする（古い条件で確認を記録しない）。

use auralyn_ui_model::preparation::{availability, Availability, Facts};
use vst_host_lib::audio::{AudioStateInfo, EngineRuntimeStats};
use vst_host_lib::audio_engine::live_output::Status as LiveStatus;
use vst_host_lib::audio_engine::queue_diagnostics::QueueState;
use vst_host_lib::input_source::Config as InputSource;

use super::{Control, Notice};

/// 読んだ状態。鍵は音づくり（入力と処理）と出力の条件で、記録の失効に使う。
#[derive(Clone, Debug)]
pub struct Observation {
    pub availability: Availability,
    pub keys: Option<(String, String)>,
    /// 入力の名前（アプリの音声ならアプリ名）。
    pub input: String,
    pub output: String,
}

impl Observation {
    fn without(availability: Availability, state: &AudioStateInfo) -> Self {
        let config = state.config.as_ref();
        Self {
            availability,
            keys: None,
            input: config.and_then(input_name).unwrap_or_default(),
            output: config.and_then(|c| c.output.clone()).unwrap_or_default(),
        }
    }
}

fn input_name(config: &vst_host_lib::audio::ActiveAudioConfig) -> Option<String> {
    match &config.input_source {
        Some(InputSource::ProcessLoopback(app)) => Some(app.app_name.clone()),
        _ => config.input.clone().filter(|name| !name.is_empty()),
    }
}

/// 読む前後で同じか比べる印（メーターの開始などの番号は混ぜない）。
fn stamp(stats: &EngineRuntimeStats) -> String {
    let latency = stats.latency_metadata.as_ref();
    serde_json::to_string(&(
        &stats.preparation,
        latency.and_then(|l| l.stream_epoch.as_ref()),
        latency.and_then(|l| l.comparison_revision.as_ref()),
    ))
    .unwrap_or_default()
}

fn build(state: &AudioStateInfo, stats: &EngineRuntimeStats, live: &LiveStatus) -> Observation {
    let Some(config) = state.config.as_ref() else {
        return Observation::without(Availability::Unconfigured, state);
    };
    let sink = live.sink.as_ref();
    let p = stats.preparation.as_deref().filter(|p| {
        [
            &p.engine_epoch,
            &p.processing_revision,
            &p.routing_revision,
            &p.output_revision,
            &p.nr_backend,
            &p.nr_model,
        ]
        .iter()
        .all(|s| !s.is_empty())
            && [p.input_gain, p.output_gain]
                .iter()
                .all(|g| g.is_finite() && (0.0..=2.0).contains(g))
    });
    let latency = stats.latency_metadata.as_deref();
    let stream = latency
        .filter(|l| l.stream_running)
        .and_then(|l| l.stream_epoch.clone())
        .filter(|epoch| !epoch.is_empty());
    let facts = Facts {
        configured: !config.host.is_empty()
            && input_name(config).is_some()
            && config.output.as_ref().is_some_and(|o| !o.is_empty()),
        running: state.is_running,
        failed: live.error.is_some()
            || sink.is_some_and(|s| s.failed)
            || live.monitor.as_ref().is_some_and(|m| m.broadcast_failed)
            || stats
                .queue_diagnostics
                .as_ref()
                .is_some_and(|q| matches!(q.state, QueueState::Failed))
            || stats.process_input.as_ref().is_some_and(|p| p.failed),
        output_missing: (live.config.split_processing && live.config.device_id.is_none())
            || (live.config.device_id.is_some() && !sink.is_some_and(|s| s.active)),
        readable: p.is_some() && stream.is_some(),
        controls_pending: p.is_some_and(|p| p.controls_pending),
        muted: p.is_some_and(|p| p.muted),
        output_gain_zero: p.is_some_and(|p| p.output_gain == 0.0),
    };
    let availability = availability(facts);
    let mut observation = Observation::without(availability, state);
    let (Some(p), Some(stream)) = (p, stream) else {
        return observation;
    };
    if !availability.usable() {
        return observation;
    }
    let identity = match &config.input_source {
        Some(InputSource::ProcessLoopback(app)) => {
            serde_json::json!(["app", app.app_key, app.raw_endpoint_id])
        }
        _ => serde_json::json!(config.input),
    };
    let sound = serde_json::json!([
        p.engine_epoch,
        stream,
        [
            serde_json::json!(config.host),
            identity,
            serde_json::json!(config.sample_rate),
            serde_json::json!(config.buffer_size),
            serde_json::json!(p.input_gain),
            serde_json::json!(p.input_channels),
        ],
        p.processing_revision,
        p.nr_backend,
        p.nr_model,
    ]);
    let output = serde_json::json!([
        config.output,
        p.output_routing,
        p.output_gain,
        p.output_revision,
        p.routing_revision,
        p.muted,
        live.config,
        live.broadcast_epoch,
    ]);
    observation.keys = Some((sound.to_string(), output.to_string()));
    observation
}

impl Control {
    /// 音声の状態を読み、`Notice::Preparation` で返す。`confirm` は、確認の記録を頼まれて読み直したときの印。
    pub(super) fn read_preparation(&mut self, confirm: Option<u64>) {
        let observation = self.observe();
        let _ = self.notices.send(Notice::Preparation {
            observation,
            confirm,
        });
    }

    fn observe(&mut self) -> Option<Observation> {
        let state = self.host.get_state();
        if !state.is_running {
            let facts = Facts {
                configured: state.config.as_ref().is_some_and(|c| !c.host.is_empty()),
                ..Facts::default()
            };
            return Some(Observation::without(availability(facts), &state));
        }
        let before = self.host.get_engine_runtime_stats().ok()?;
        let live = self.host.live_output(None).ok()?;
        let after = self.host.get_engine_runtime_stats().ok()?;
        let again = self.host.get_state();
        let same_state = serde_json::to_string(&state).ok() == serde_json::to_string(&again).ok();
        (stamp(&before) == stamp(&after) && same_state).then(|| build(&again, &after, &live))
    }
}
