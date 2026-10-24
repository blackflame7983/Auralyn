use super::Engine;
use crate::ipc::{Response, SignalCorrespondence};

#[test]
fn latency_metadata_separates_fixed_default_stop_nr_and_vst_only_bypass() {
    let mut engine = Engine::new();
    assert!(engine
        .latency_metadata((0, Some(0), false, vec![]))
        .nominal_sample_rate_hz
        .is_none());
    engine.current_sample_rate = 48_000.0;
    engine.current_block_size = 512;
    engine.fixed_buffer_request_frames = Some(256);
    engine.noise_reduction_enabled = true;
    engine.global_bypass = true;
    let fixed = engine.latency_metadata((0, Some(0), false, vec![]));
    assert_eq!(fixed.fixed_buffer_request_frames, Some(256));
    assert!(fixed.nr_configured_enabled);
    assert_eq!(fixed.nr_processing_frame_samples, Some(480));
    assert_eq!(fixed.vst_reported_latency_samples, 0);
    assert!(!fixed.stream_running);
    assert!(matches!(
        fixed.signal_correspondence,
        SignalCorrespondence::Unmeasured
    ));
    // Defaultで使う内部512仮値を、固定要求へ昇格させない。
    engine.fixed_buffer_request_frames = None;
    assert!(engine
        .latency_metadata((12, Some(12), false, vec![]))
        .fixed_buffer_request_frames
        .is_none());
    engine.fixed_buffer_request_frames = Some(128);
    engine.clear_audio_resources();
    let stopped = engine.latency_metadata((12, Some(12), false, vec![]));
    assert!(!stopped.stream_running);
    assert!(stopped.fixed_buffer_request_frames.is_none());
    engine.current_sample_rate = 384_000.0;
    let high = engine.latency_metadata((12, Some(12), false, vec![]));
    assert_eq!(high.nominal_sample_rate_hz, Some(384_000));
    assert_eq!(high.nr_processing_rate_hz, Some(384_000));
    assert_eq!(high.nr_processing_frame_samples, Some(3840));
    engine.current_sample_rate = f64::NAN;
    assert!(engine
        .latency_metadata((0, Some(0), false, vec![]))
        .nominal_sample_rate_hz
        .is_none());
}

#[test]
fn latency_metadata_is_optional_box_transparent_and_legacy_values_stay_unchanged() {
    let mut wire = serde_json::json!({"type":"RuntimeStats","payload":{
        "active_plugin_count":0,"enabled_plugin_count":0,"pending_unload_count":0,"burned_library_count":0,
        "global_bypass":true,"max_jitter_us":0,"glitch_count":0,
        "total_plugin_latency_samples":12,"total_plugin_latency_ms":0.25,
        "noise_reduction_latency_samples":480,"noise_reduction_latency_ms":10.0,
        "total_chain_latency_samples":492,"total_chain_latency_ms":10.25,
        "noise_reduction_enabled":true,"noise_reduction_active":true,"noise_reduction_mode":"low",
        "noise_learning_state":"idle","noise_learning_progress":0.0,"noise_profile_available":false,
        "noise_profile_rms":0.0,"recommended_noise_mix":0.6,"speech_detected":false,"noise_voice_guard":true,
        "noise_control_strength":0.75,"built_in_effects_enabled":false,"built_in_effects_preset":"broadcast","built_in_effects_amount":0.7
    }});
    let old: Response = serde_json::from_value(wire.clone()).unwrap();
    assert!(matches!(
        old,
        Response::RuntimeStats {
            latency_metadata: None,
            resampler_batch_timing: None,
            ..
        }
    ));
    wire["payload"]["resampler_batch_timing"] = serde_json::Value::Null;
    assert!(matches!(
        serde_json::from_value::<Response>(wire.clone()).unwrap(),
        Response::RuntimeStats {
            resampler_batch_timing: None,
            ..
        }
    ));
    let descriptor = crate::audio_engine::resampling::StreamResampler::new(44_100, 48_000, 2)
        .unwrap()
        .timing_descriptor();
    let batch =
        crate::audio_engine::frame_timing::Observer::new_batch("batch:1".into(), 1, descriptor).0;
    wire["payload"]["resampler_batch_timing"] =
        serde_json::to_value(batch.batch_snapshot()).unwrap();
    assert_eq!(
        wire["payload"]["resampler_batch_timing"]["mode"],
        "callbackBatchReadiness"
    );
    let metadata = Box::new(Engine::new().latency_metadata((12, Some(12), false, vec![])));
    wire["payload"]["latency_metadata"] = serde_json::to_value(metadata).unwrap();
    let timing = crate::audio_engine::frame_timing::Observer::new("timing:1".into(), 1, true).0;
    wire["payload"]["frame_timing"] = serde_json::to_value(Box::new(timing.snapshot())).unwrap();
    assert_eq!(wire["payload"]["frame_timing"]["epoch"], "timing:1");
    assert_eq!(wire["payload"]["latency_metadata"]["schemaVersion"], 1);
    assert_eq!(
        wire["payload"]["latency_metadata"]["signalCorrespondence"],
        "unmeasured"
    );
    let new: Response = serde_json::from_value(wire).unwrap();
    assert!(matches!(
        new,
        Response::RuntimeStats {
            latency_metadata: Some(_),
            frame_timing: Some(_),
            resampler_batch_timing: Some(_),
            noise_reduction_latency_samples: 480,
            total_chain_latency_samples: 492,
            ..
        }
    ));
}

#[test]
fn frame_timing_engine_cleanup_seals_after_recorders_drop_and_retains_attempt() {
    use crate::audio_engine::frame_timing::Observer;
    let mut engine = Engine::new();
    let (observer, input, output) = Observer::new("engine:queue:1".into(), 1, true);
    let (mut input, mut output) = (input.unwrap(), output.unwrap());
    input.record(5, 3, 0, None);
    output.record(2, 0, 0, None);
    engine.frame_timing = Some(observer);
    drop(input);
    drop(output);
    engine.clear_audio_resources();
    let sealed = engine.frame_timing.as_ref().unwrap().snapshot();
    assert!(sealed.sealed);
    assert_eq!(
        (
            sealed.consumed_frames,
            sealed.matched_frames,
            sealed.unknown_frames,
            sealed.pending_frames
        ),
        (2, 2, 0, 0)
    );
    engine.clear_audio_resources();
    assert_eq!(
        engine
            .frame_timing
            .as_ref()
            .unwrap()
            .snapshot()
            .observation_ms,
        sealed.observation_ms
    );
    engine.frame_timing = Some(Observer::new("engine:queue:2".into(), 2, true).0);
    let next = engine.frame_timing.as_ref().unwrap().snapshot();
    assert_ne!(next.epoch, sealed.epoch);
    assert_eq!(next.consumed_frames, 0);
    assert!(next.p50.is_none());
}

#[test]
fn frame_timing_trace_command_is_epoch_checked_and_wire_read_only() {
    use crate::{audio_engine::frame_timing::Observer, ipc::Command};
    let mut engine = Engine::new();
    assert!(engine.frame_timing_trace("epoch").is_err());
    engine.frame_timing = Some(Observer::new("epoch".into(), 1, true).0);
    let revision = engine.voice_revision;
    assert!(engine.frame_timing_trace("old").is_err());
    let first = engine.frame_timing_trace("epoch").unwrap();
    let response = serde_json::to_value(Response::FrameTimingTrace(Box::new(first))).unwrap();
    assert_eq!(response["type"], "FrameTimingTrace");
    assert_eq!(response["payload"]["epoch"], "epoch");
    let request: Command = serde_json::from_value(
        serde_json::json!({"type":"GetFrameTimingTrace","payload":{"expectedEpoch":"epoch"}}),
    )
    .unwrap();
    assert!(
        matches!(request, Command::GetFrameTimingTrace { expected_epoch } if expected_epoch == "epoch")
    );
    assert!(serde_json::from_value::<Command>(
        serde_json::json!({"type":"GetFrameTimingTrace","payload":{}})
    )
    .is_err());
    assert_eq!(engine.voice_revision, revision);
    assert!(engine.output_stream.is_none());
}

#[test]
fn latency_stage_breakdown_missing_and_null_remain_unavailable_in_old_metadata() {
    let m = Engine::new().latency_metadata((0, Some(0), false, vec![]));
    let mut v = serde_json::to_value(m).unwrap();
    v.as_object_mut().unwrap().remove("stageBreakdown");
    let old: crate::ipc::LatencyMetadata = serde_json::from_value(v.clone()).unwrap();
    assert!(old.stage_breakdown.is_none());
    v["stageBreakdown"] = serde_json::Value::Null;
    let old: crate::ipc::LatencyMetadata = serde_json::from_value(v).unwrap();
    assert!(old.stage_breakdown.is_none());
}
