use super::*;
fn process_config() -> bundle::ProcessConfiguration {
    bundle::ProcessConfiguration {
        version: 1,
        source: crate::input_source::ProcessConfig {
            app_key: "a".repeat(64),
            app_name: "player.exe".into(),
            raw_endpoint_id: "raw-id".into(),
            purpose: crate::input_source::Purpose::Voice,
        },
        output_id: "wasapi:monitor-id".into(),
    }
}
#[test]
fn process_identity_and_volatile_generation_changes_invalidate_a_preview() {
    let mut before = captured();
    before.process = Some(process_config());
    before.process_target = Some(crate::input_source::Target {
        pid: 10,
        created: 100,
    });
    let mut after = before.clone();
    assert!(unchanged(&before, &after));
    after.process_target.as_mut().unwrap().created += 1;
    assert!(!unchanged(&before, &after));
    after = before.clone();
    after.process.as_mut().unwrap().source.purpose = crate::input_source::Purpose::Music;
    assert!(!unchanged(&before, &after));
}
#[test]
fn process_restore_requires_current_choice_mute_and_both_exact_output_devices() {
    let mut current = captured();
    current.process = Some(process_config());
    current.process_target = Some(crate::input_source::Target {
        pid: 10,
        created: 100,
    });
    current.engine.running = true;
    current.active = Some(audio::ActiveAudioConfig {
        host: "Wasapi".into(),
        output: Some("Monitor".into()),
        output_id: Some("wasapi:monitor-id".into()),
        ..Default::default()
    });
    let mut saved = BundleV1 {
        mixing: None,
        process: current.process.clone(),
        live: None,
        output: None,
        schema_version: 4,
        revision: "1".into(),
        name: "process".into(),
        categories: ProfileSaveCategories {
            include_audio_config: true,
            include_plugins: true,
            include_noise_control: true,
            include_builtin_fx: true,
        },
        embedded_auralyn_preset: current.preset.clone(),
        level_intent: Some(bundle::LevelIntent {
            input_gain: 1.,
            output_gain: 1.,
        }),
        confirmation: None,
        obs: None,
    };
    saved.embedded_auralyn_preset.audio_config = Some(ProfileAudioConfig {
        host: "Wasapi".into(),
        input_device: None,
        output_device: Some("Monitor".into()),
        sample_rate: 48000,
        buffer_size: 512,
        input_channels: vec![0, 1],
        output_routing: Default::default(),
        input_gain_db: 0.,
        master_gain_db: 0.,
    });
    let device = |name: &str, id: &str| audio::AudioDevice {
        name: name.into(),
        host: "Wasapi".into(),
        id: Some(id.into()),
        is_input: false,
        channels: 2,
        index: 0,
        is_default: false,
        sample_rate_ranges: None,
        buffer_size_range: None,
    };
    let mut devices = audio::AudioDeviceList {
        inputs: vec![],
        outputs: vec![
            device("Raw", "wasapi:raw-id"),
            device("Monitor", "wasapi:monitor-id"),
        ],
    };
    validate_process_selection(&saved, &current, &devices).unwrap();
    current.engine.global_mute = false;
    assert!(validate_process_selection(&saved, &current, &devices).is_err());
    current.engine.global_mute = true;
    devices.outputs[0].id = Some("wasapi:another-raw-id".into());
    assert!(validate_process_selection(&saved, &current, &devices).is_err());
    devices.outputs[0].id = Some("wasapi:raw-id".into());
    current.process.as_mut().unwrap().source.purpose = crate::input_source::Purpose::Music;
    assert!(validate_process_selection(&saved, &current, &devices).is_err());
    current.process = Some(process_config());
    current.process_target = None;
    assert!(validate_process_selection(&saved, &current, &devices).is_err());
}
#[test]
fn live_preview_never_serializes_embedded_component_state() {
    let mut live = bundle::LiveConfiguration {
        version: 1,
        definitions: Default::default(),
        target: None,
        monitor: None,
        singing_plugins: Some(vec![]),
        talk_plugins: None,
    };
    live.singing_plugins.as_mut().unwrap().push(PresetPlugin {
        path: "fixture.vst3".into(),
        name: "fixture".into(),
        vendor: String::new(),
        version: String::new(),
        enabled: true,
        muted: false,
        gain: 1.0,
        state: Some("opaque-component-never-send-to-ui".into()),
    });
    let value = LivePreview {
        before: Some((&live).into()),
        after: (&live).into(),
    };
    let json = serde_json::to_string(&value).unwrap();
    assert!(json.contains("singingPlugins\":1"));
    assert!(!json.contains("opaque-component"));
}
#[test]
fn output_configuration_and_external_file_changes_invalidate_the_preview() {
    let mut before = captured();
    before.output = Some(bundle::OutputConfiguration {
        version: 1,
        devices: bundle::RecoveryDevices {
            input_id: "mic".into(),
            output_id: "monitor".into(),
        },
        config: Default::default(),
    });
    let mut after = before.clone();
    assert!(unchanged(&before, &after));
    after.output.as_mut().unwrap().config.broadcast_trim = 0.5;
    assert!(!unchanged(&before, &after));
    after = before.clone();
    after.output_revision = "external edit".into();
    assert!(!unchanged(&before, &after));
    after = before.clone();
    after.live_revision = "external mode edit".into();
    assert!(!unchanged(&before, &after));
}
#[test]
fn output_restore_requires_current_mute_and_exact_primary_and_secondary_ids() {
    let mut current = captured();
    current.engine.running = true;
    current.active = Some(audio::ActiveAudioConfig {
        host: "WASAPI".into(),
        input: Some("Mic".into()),
        output: Some("Monitor".into()),
        input_id: Some("mic-id".into()),
        output_id: Some("monitor-id".into()),
        ..Default::default()
    });
    let mut saved = BundleV1 {
        mixing: None,
        process: None,
        live: None,
        output: Some(bundle::OutputConfiguration {
            version: 1,
            devices: active_devices(current.active.as_ref()).unwrap(),
            config: crate::audio_engine::live_output::Config {
                device_id: Some("broadcast-id".into()),
                ..Default::default()
            },
        }),
        schema_version: 2,
        revision: "1".into(),
        name: "output".into(),
        categories: ProfileSaveCategories {
            include_plugins: true,
            include_audio_config: true,
            include_noise_control: true,
            include_builtin_fx: true,
        },
        embedded_auralyn_preset: current.preset.clone(),
        obs: None,
        confirmation: None,
        level_intent: None,
    };
    saved.embedded_auralyn_preset.audio_config = Some(ProfileAudioConfig {
        host: "WASAPI".into(),
        input_device: Some("Mic".into()),
        output_device: Some("Monitor".into()),
        sample_rate: 48000,
        buffer_size: 512,
        input_channels: vec![0, 1],
        output_routing: Default::default(),
        input_gain_db: 0.,
        master_gain_db: 0.,
    });
    let device = |name: &str, id: &str, is_input| audio::AudioDevice {
        sample_rate_ranges: None,
        name: name.into(),
        host: "WASAPI".into(),
        id: Some(id.into()),
        is_input,
        channels: 2,
        buffer_size_range: None,
        index: 0,
        is_default: false,
    };
    let mut devices = audio::AudioDeviceList {
        inputs: vec![device("Mic", "mic-id", true)],
        outputs: vec![
            device("Monitor", "monitor-id", false),
            device("Cable", "broadcast-id", false),
        ],
    };
    validate_output_devices(&saved, &current, &devices).unwrap();
    current.engine.global_mute = false;
    assert!(validate_output_devices(&saved, &current, &devices).is_err());
    current.engine.global_mute = true;
    devices.outputs[1].id = Some("replacement-id".into());
    assert!(validate_output_devices(&saved, &current, &devices).is_err());
    devices.outputs[1].id = Some("broadcast-id".into());
    current.active.as_mut().unwrap().input_id = Some("same-name-new-id".into());
    assert!(validate_output_devices(&saved, &current, &devices).is_err());
}
#[test]
fn saved_preview_rejects_same_revision_edits_and_different_operation() {
    let before = captured();
    let plan = Preview {
        id: "preview".into(),
        bundle: BundleV1 {
            mixing: None,
            process: None,
            live: None,
            output: None,
            schema_version: 1,
            revision: "1".into(),
            name: "original".into(),
            categories: ProfileSaveCategories {
                include_plugins: true,
                include_noise_control: true,
                include_builtin_fx: true,
                ..Default::default()
            },
            embedded_auralyn_preset: before.preset.clone(),
            obs: None,
            confirmation: None,
            level_intent: None,
        },
        before,
        witness: Arc::new(audio::conditions::Conditions::default())
            .control_snapshot()
            .unwrap(),
        obs: None,
        recovery_id: Some("original".into()),
    };
    let validate =
        |saved: &BundleV1| validate_saved_preview(&plan, "preview", saved, Some("original"));
    validate(&plan.bundle).unwrap();
    let mut edited = plan.bundle.clone();
    edited
        .embedded_auralyn_preset
        .noise_control
        .as_mut()
        .unwrap()
        .strength = 0.5;
    assert_eq!(edited.revision, plan.bundle.revision);
    assert!(validate(&edited).is_err());
    edited = plan.bundle.clone();
    edited.embedded_auralyn_preset.plugins.push(PresetPlugin {
        path: "test".into(),
        name: "test".into(),
        vendor: String::new(),
        version: String::new(),
        enabled: true,
        muted: false,
        gain: 1.,
        state: Some("opaque edit".into()),
    });
    assert!(validate(&edited).is_err());
    assert!(validate_saved_preview(&plan, "old-preview", &plan.bundle, Some("original")).is_err());
    assert!(validate_saved_preview(&plan, "preview", &plan.bundle, None).is_err());
}
#[test]
fn runtime_restore_requires_explicit_start_and_current_mute() {
    let mut current = captured();
    assert!(validate_runtime_restore(&current).is_err());
    current.engine.running = true;
    current.engine.global_mute = false;
    assert!(validate_runtime_restore(&current).is_err());
    current.engine.global_mute = true;
    validate_runtime_restore(&current).unwrap();
    current.engine.global_bypass = true;
    validate_runtime_restore(&current).unwrap();
}
#[test]
fn runtime_restore_accepts_only_default_equivalent_omitted_fx_fields() {
    let mut before = captured();
    let mut target = BundleV1 {
        mixing: None,
        process: None,
        live: None,
        output: None,
        schema_version: 1,
        revision: "1".into(),
        name: "fx".into(),
        categories: ProfileSaveCategories {
            include_builtin_fx: true,
            ..Default::default()
        },
        embedded_auralyn_preset: before.preset.clone(),
        obs: None,
        confirmation: None,
        level_intent: None,
    };
    before.engine.builtin.reverb = Some(Default::default());
    assert!(selected_matches(&target, &before));
    before.engine.builtin.reverb.as_mut().unwrap().enabled = true;
    assert!(!selected_matches(&target, &before));
    before.engine.builtin.reverb.as_mut().unwrap().enabled = false;
    before.engine.builtin.reverb.as_mut().unwrap().mix = 0.2;
    assert!(!selected_matches(&target, &before)); // 無効でも既定値と異なる保持値を無視しない。
    before.engine.builtin.reverb = Some(Default::default());
    before.engine.builtin.preset = "singing".into();
    before.engine.builtin.singing = Some(Default::default());
    target
        .embedded_auralyn_preset
        .builtin_fx
        .as_mut()
        .unwrap()
        .preset = "singing".into();
    assert!(selected_matches(&target, &before));
    before.engine.builtin.singing.as_mut().unwrap().dynamics = 0.9;
    assert!(!selected_matches(&target, &before));
}
#[test]
fn runtime_capture_without_existing_engine_does_not_create_backup_or_spawn_audio() {
    let root =
        std::env::temp_dir().join(format!("auralyn-runtime-no-engine-{}", bundle::revision()));
    let mut host = audio::AudioHost::new(root.clone());
    assert!(preserve_temporary_runtime(&root, &mut host).is_err());
    assert!(!host.get_state().is_running);
    assert!(!bundle::recovery_exists(&root).unwrap());
    assert!(!root.exists());
}
#[test]
fn recovery_device_identity_rejects_same_name_replacement_and_missing_id() {
    let device = audio::AudioDevice {
        sample_rate_ranges: None,
        name: "Mic".into(),
        host: "WASAPI".into(),
        id: Some("new-id".into()),
        is_input: true,
        channels: 2,
        buffer_size_range: None,
        index: 0,
        is_default: false,
    };
    let name = Some("Mic".to_string());
    assert!(!recovery_device_matches(
        std::slice::from_ref(&device),
        "WASAPI",
        &name,
        "old-id"
    ));
    assert!(recovery_device_matches(
        std::slice::from_ref(&device),
        "WASAPI",
        &name,
        "new-id"
    ));
    let mut missing = device;
    missing.id = None;
    assert!(!recovery_device_matches(
        &[missing],
        "WASAPI",
        &name,
        "old-id"
    ));
}
#[test]
fn obs_original_selection_preserves_each_requested_source_and_property() {
    use obs_setup::bundle::{Item, Property, Saved};
    let original = Saved {
        collection: "scene".into(),
        items: vec![
            Item {
                source: "mic".into(),
                kind: "input".into(),
                property: Property::Volume,
                value: serde_json::json!(0.7),
            },
            Item {
                source: "mic".into(),
                kind: "input".into(),
                property: Property::FilterEnabled {
                    name: "EQ".into(),
                    kind: "vst".into(),
                },
                value: serde_json::json!(true),
            },
            Item {
                source: "music".into(),
                kind: "input".into(),
                property: Property::Muted,
                value: serde_json::json!(false),
            },
        ],
    };
    let selected = recovery_obs_selection(&original);
    assert_eq!(selected.len(), 2);
    assert_eq!(selected[0].source, "mic");
    assert!(selected[0].volume);
    assert_eq!(selected[0].filters, ["EQ"]);
    assert_eq!(selected[1].source, "music");
    assert!(selected[1].muted);
}
#[test]
fn current_dto_contains_only_actual_rack_metadata_not_control_prefs_or_state() {
    let mut captured = captured();
    captured.engine.plugins.push(bundle::CapturedPlugin {
        id: "actual-id".into(),
        plugin: PresetPlugin {
            path: "fixture-path".into(),
            name: "Fixture".into(),
            vendor: "Vendor".into(),
            version: "1".into(),
            enabled: false,
            muted: true,
            gain: 0.5,
            state: Some("opaque-component-state".into()),
        },
    });
    let dto = current_dto(&captured);
    assert_eq!(dto.applied_categories, ["plugins"]);
    assert!(dto.applied_audio_config.is_none());
    assert!(dto.applied_noise_control.is_none());
    assert!(dto.applied_builtin_fx.is_none());
    assert_eq!(dto.loaded_plugin_instances.len(), 1);
    let actual = &dto.loaded_plugin_instances[0];
    assert_eq!(actual.id, "actual-id");
    assert!(!actual.enabled && actual.muted);
    assert_eq!(actual.gain, 0.5);
    let json = serde_json::to_string(&dto).unwrap();
    assert!(!json.contains("opaque-component-state"));
    assert!(!json.contains("appliedPlugins"));
    assert!(!json.contains("\"state\""));
}
#[tokio::test]
async fn undo_lock_wait_revalidates_conditions_before_mutation_and_pending_blocks_next_apply() {
    let conditions = Arc::new(audio::conditions::Conditions::default());
    let witness = conditions.control_snapshot().unwrap();
    let lock = tokio::sync::Mutex::new(());
    let held = lock.lock().await;
    let expected = captured();
    let changed = std::sync::atomic::AtomicBool::new(false);
    let restore = async {
        let _guard = lock.lock().await;
        verify_undo_snapshot(&witness, &expected, &expected)?;
        changed.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok::<_, String>(())
    };
    tokio::pin!(restore);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(5), &mut restore)
            .await
            .is_err()
    );
    conditions.lifecycle(false); // 別操作がHost lockを保持している間に変更。
    drop(held);
    assert!(restore.await.is_err());
    assert!(!changed.load(std::sync::atomic::Ordering::SeqCst));
    let mut result = ResultView {
        id: "undo".into(),
        complete: true,
        undo_pending: true,
        auralyn: String::new(),
        obs: vec![],
        auralyn_text: None,
        obs_texts: Some(vec![]),
        summary: None,
        current: None,
    };
    begin_undo(&mut result);
    assert!(blocks_next_apply(&result)); // OBS部分失敗/未確認で早期returnしても成功状態を残さない。
}
fn captured() -> Captured {
    let engine = EngineCapture {
        control_revision: "1".into(),
        running: false,
        fixed_buffer_request_frames: None,
        plugins: vec![],
        input_channels: vec![0, 1],
        output_routing: crate::ipc::OutputRouting::Legacy,
        input_gain: 0.,
        output_gain: 0.,
        global_mute: true,
        global_bypass: false,
        noise: ProfileNoiseControl {
            enabled: false,
            mode: "smart".into(),
            strength: 1.,
            voice_guard: true,
            learned_profile: None,
        },
        builtin: ProfileBuiltinFx {
            preset: "broadcast".into(),
            enabled: false,
            amount: 0.7,
            singing: None,
            reverb: None,
        },
    };
    Captured {
        mixing: None,
        mixing_revision: "absent".into(),
        process: None,
        process_target: None,
        live: None,
        live_revision: "absent".into(),
        output: None,
        output_revision: "absent".into(),
        preset: Preset {
            plugins_included: Some(true),
            schema_version: 2,
            name: "配信状態".into(),
            plugins: vec![],
            audio_config: None,
            noise_control: Some(engine.noise.clone()),
            builtin_fx: Some(engine.builtin.clone()),
        },
        engine,
        active: None,
    }
}

#[test]
fn output_routing_roundtrip_preview_partial_and_undo_intent() {
    use crate::ipc::OutputRouting;
    let mut before = captured();
    before.engine.input_channels = vec![2, 3];
    before.engine.output_routing = OutputRouting::Independent { channels: [0, 1] };
    let audio = ProfileAudioConfig {
        host: "ASIO".into(),
        input_device: None,
        output_device: None,
        sample_rate: 48000,
        buffer_size: 512,
        input_channels: vec![2, 3],
        output_routing: before.engine.output_routing,
        input_gain_db: 0.0,
        master_gain_db: 0.0,
    };
    before.preset.audio_config = Some(audio.clone());
    let mut target = BundleV1 {
        mixing: None,
        process: None,
        live: None,
        output: None,
        schema_version: 1,
        revision: "1".into(),
        name: "test".into(),
        categories: ProfileSaveCategories {
            include_audio_config: true,
            ..Default::default()
        },
        embedded_auralyn_preset: before.preset.clone(),
        obs: None,
        confirmation: None,
        level_intent: Some(bundle::LevelIntent {
            input_gain: 0.0,
            output_gain: 0.0,
        }),
    };
    target.embedded_auralyn_preset.noise_control = None;
    target.embedded_auralyn_preset.builtin_fx = None;
    target
        .embedded_auralyn_preset
        .audio_config
        .as_mut()
        .unwrap()
        .output_routing = OutputRouting::Insert;
    let json = serde_json::to_value(&target).unwrap();
    let decoded: BundleV1 = serde_json::from_value(json).unwrap();
    assert_eq!(
        decoded
            .embedded_auralyn_preset
            .audio_config
            .as_ref()
            .unwrap()
            .output_routing,
        OutputRouting::Insert
    );
    assert!(!selected_matches(&decoded, &before));
    let rows = preview_diff(&before, &decoded);
    let output_row = rows.iter().find(|r| r.label == "出力チャンネル").unwrap();
    assert_eq!(output_row.status, "changed");
    assert_eq!(
        output_row.before_text.as_ref().unwrap().code,
        "bundle.value.outputIndependent"
    );
    assert_eq!(
        output_row.after_text.as_ref().unwrap().code,
        "bundle.value.outputInsert"
    );
    assert_eq!(
        selected_start_intent(&decoded, &before)
            .unwrap()
            .output_routing,
        OutputRouting::Insert
    );
    target.embedded_auralyn_preset.audio_config = Some(audio);
    assert_eq!(
        selected_start_intent(&target, &before)
            .unwrap()
            .output_routing,
        OutputRouting::Independent { channels: [0, 1] }
    );
    target.embedded_auralyn_preset.audio_config = None;
    target.level_intent = None;
    target.categories.include_audio_config = false;
    assert_eq!(
        selected_start_intent(&target, &before)
            .unwrap()
            .output_routing,
        before.engine.output_routing
    );
    let mut old = serde_json::to_value(before.preset.audio_config.as_ref().unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("outputRouting");
    assert_eq!(
        serde_json::from_value::<ProfileAudioConfig>(old)
            .unwrap()
            .output_routing,
        OutputRouting::Legacy
    );
}
#[test]
fn partial_and_skipped_are_not_complete_and_state_or_flags_change_is_conflict() {
    let before = captured();
    let mut after = before.clone();
    assert!(unchanged(&before, &after));
    after.engine.global_mute = false;
    assert!(!unchanged(&before, &after));
    let mut summary = ApplyProfileSummary::default();
    assert!(complete(&summary));
    summary.skipped_categories.push("plugins".into());
    assert!(!complete(&summary));
    let mut result = ResultView {
        id: "operation".into(),
        complete: true,
        undo_pending: true,
        auralyn: String::new(),
        obs: vec![],
        auralyn_text: None,
        obs_texts: Some(vec![]),
        summary: None,
        current: None,
    };
    assert!(!blocks_next_apply(&result)); // 全成功は次の明示applyでarchiveできる。
    result.complete = false;
    assert!(blocks_next_apply(&result)); // partial/unknownは原本を上書きしない。
    summary.skipped_categories.clear();
    summary.missing_plugins.push(MissingPlugin {
        name: "missing".into(),
        path: "not-present".into(),
    });
    assert!(!complete(&summary));
}
#[test]
fn checked_save_requires_a_running_unmuted_settled_stream_and_the_exact_observed_conditions() {
    let p = crate::ipc::PreparationSnapshot {
        engine_epoch: "engine".into(),
        processing_revision: "4".into(),
        routing_revision: "2".into(),
        input_gain: 1.0,
        input_channels: [0, 1],
        output_routing: crate::ipc::OutputRouting::Legacy,
        output_gain: 1.0,
        output_revision: "3".into(),
        muted: false,
        controls_pending: false,
        nr_backend: "nnnoiseless-0.5.2".into(),
        nr_model: "bundled".into(),
    };
    assert!(validate_checked_conditions(true, Some(&p), &p).is_ok());
    assert!(validate_checked_conditions(false, Some(&p), &p).is_err());
    assert!(validate_checked_conditions(true, None, &p).is_err());
    let mut changed = p.clone();
    changed.processing_revision = "6".into();
    assert!(validate_checked_conditions(true, Some(&changed), &p).is_err());
    for kind in 0..3 {
        let mut current = p.clone();
        match kind {
            0 => current.muted = true,
            1 => current.controls_pending = true,
            _ => current.output_gain = 0.0,
        };
        assert!(validate_checked_conditions(true, Some(&current), &current).is_err());
    }
}
#[test]
fn preview_and_result_expose_differences_without_opaque_state_or_default_buffer_claim() {
    let before = captured();
    let target = BundleV1 {
        mixing: None,
        process: None,
        live: None,
        output: None,
        schema_version: 1,
        revision: "1".into(),
        name: "test".into(),
        categories: ProfileSaveCategories {
            include_plugins: true,
            ..Default::default()
        },
        embedded_auralyn_preset: select(
            before.preset.clone(),
            &ProfileSaveCategories {
                include_plugins: true,
                ..Default::default()
            },
        )
        .unwrap(),
        obs: None,
        confirmation: None,
        level_intent: None,
    };
    let rows = preview_diff(&before, &target);
    for row in &rows {
        assert!(row.field_code.is_some());
        assert_eq!(row.label_text.as_ref().unwrap().fallback_ja, row.label);
        assert!(row.before_text.is_some());
        assert!(row.after_text.is_some());
    }
    let buffer = rows.iter().find(|r| r.label == "固定バッファ要求").unwrap();
    assert_eq!(buffer.status, "notSelected");
    assert_eq!(buffer.before, "未確認");
    assert_eq!(
        buffer.after_text.as_ref().unwrap().code,
        "bundle.value.notChanged"
    );
    assert!(!serde_json::to_string(&rows).unwrap().contains("512"));
    let mut selected = target.categories.clone();
    selected.include_audio_config = true;
    assert!(select(before.preset.clone(), &selected).is_err());
    let secret = "opaque-state-must-not-cross-the-command-boundary";
    let mut summary = ApplyProfileSummary::default();
    summary.applied_plugins.push(PresetPlugin {
        path: "test".into(),
        name: "test".into(),
        vendor: String::new(),
        version: String::new(),
        enabled: true,
        muted: false,
        gain: 1.,
        state: Some(secret.into()),
    });
    let dto: SummaryDto = summary.into();
    let json = serde_json::to_string(&dto).unwrap();
    assert!(!json.contains(secret));
    assert!(!json.contains("appliedPlugins"));
}
#[test]
fn typed_result_updates_preserve_authority_flags_and_keep_remote_errors_out_of_args() {
    let mut result = ResultView {
        id: "typed".into(),
        complete: false,
        undo_pending: true,
        auralyn: String::new(),
        obs: vec![],
        auralyn_text: None,
        obs_texts: None,
        summary: None,
        current: None,
    };
    result.set_auralyn("bundle.apply.incomplete", "一部未確認");
    assert_eq!(
        result.auralyn_text.as_ref().unwrap().fallback_ja,
        result.auralyn
    );
    let remote_error = "unstructured remote error with opaque detail";
    result.set_obs_unknown(remote_error);
    assert_eq!(result.obs, [remote_error]);
    let typed = &result.obs_texts.as_ref().unwrap()[0];
    assert_eq!(typed.fallback_ja, remote_error);
    assert_eq!(typed.code, "bundle.obs.applyUnknown");
    assert!(typed.args.is_empty());
    assert!(!result.complete);
    assert!(result.undo_pending);
    begin_undo(&mut result);
    assert_eq!(
        result.auralyn_text.as_ref().unwrap().code,
        "bundle.undo.checking"
    );
    assert!(blocks_next_apply(&result));
}
#[test]
fn selected_backup_does_not_include_untouched_categories_and_empty_rack_is_explicit() {
    let before = captured();
    let categories = ProfileSaveCategories {
        include_plugins: true,
        ..Default::default()
    };
    let backup = select(before.preset.clone(), &categories).unwrap();
    assert!(backup.plugins.is_empty());
    assert!(backup.noise_control.is_none());
    assert!(backup.builtin_fx.is_none());
    assert!(backup.audio_config.is_none());
    let target = BundleV1 {
        mixing: None,
        process: None,
        live: None,
        output: None,
        schema_version: 1,
        revision: "1".into(),
        name: "empty".into(),
        categories,
        embedded_auralyn_preset: backup,
        obs: None,
        confirmation: None,
        level_intent: None,
    };
    assert!(selected_matches(&target, &before));
    let mut actual = before;
    actual.engine.plugins.push(bundle::CapturedPlugin {
        id: "remaining".into(),
        plugin: PresetPlugin {
            path: "test".into(),
            name: "test".into(),
            vendor: String::new(),
            version: String::new(),
            state: Some(String::new()),
            enabled: true,
            muted: false,
            gain: 1.,
        },
    });
    assert!(!selected_matches(&target, &actual));
    let mut opaque = actual.clone();
    opaque.engine.plugins[0].plugin.state = Some("changed by GUI or processing".into());
    assert!(!unchanged(&actual, &opaque));
}

#[test]
fn mixing_revision_selection_and_opaque_diff_are_checked() {
    use crate::audio_engine::mixing::{Config, Levels, Source};
    let mut before = captured();
    before.engine.running = true;
    before.engine.global_mute = true;
    let mut mixing = empty_mixing();
    mixing.input = Some(Config {
        version: 1,
        source: serde_json::from_value(serde_json::json!({ "kind": "device", "config": { "host": "WASAPI", "inputId": "private-device-id", "inputChannels": [0, 1] } })).unwrap(),
        levels: Levels::default(),
    });
    mixing.post_mix.enabled = true;
    mixing.post_mix.plugins = vec![
        PresetPlugin {
            path: "first.vst3".into(),
            name: "first".into(),
            vendor: String::new(),
            version: String::new(),
            enabled: true,
            muted: false,
            gain: 1.0,
            state: Some("private-state-one".into()),
        },
        PresetPlugin {
            path: "second.vst3".into(),
            name: "second".into(),
            vendor: String::new(),
            version: String::new(),
            enabled: false,
            muted: false,
            gain: 0.5,
            state: Some("private-state-two".into()),
        },
    ];
    before.mixing = Some(mixing.clone());
    before.mixing_revision = "epoch:1".into();
    let mut target = BundleV1 {
        mixing: Some(mixing),
        process: None,
        live: None,
        output: None,
        schema_version: 5,
        revision: "revision".into(),
        name: "test".into(),
        categories: ProfileSaveCategories::default(),
        embedded_auralyn_preset: before.preset.clone(),
        obs: None,
        confirmation: None,
        level_intent: None,
    };
    assert!(validate_mixing_selection(&target, &before).is_ok());
    let mut changed = before.clone();
    changed.mixing_revision = "epoch:2".into();
    assert!(!unchanged(&before, &changed));
    changed = before.clone();
    changed.mixing.as_mut().unwrap().post_mix.plugins.swap(0, 1);
    assert!(!unchanged(&before, &changed));
    before.engine.global_mute = false;
    assert!(validate_mixing_selection(&target, &before).is_err());
    before.engine.global_mute = true;
    if let Source::Device(device) = &mut target
        .mixing
        .as_mut()
        .unwrap()
        .input
        .as_mut()
        .unwrap()
        .source
    {
        device.input_id = "other".into();
    }
    assert!(validate_mixing_selection(&target, &before).is_err());
    target.mixing.as_mut().unwrap().post_mix.plugins[0].state = Some("new-private-state".into());
    let devices = audio::AudioDeviceList {
        inputs: vec![],
        outputs: vec![],
    };
    let preview = mixing_preview(
        before.mixing.as_ref().unwrap(),
        target.mixing.as_ref().unwrap(),
        &devices,
        vec![],
    );
    let value = serde_json::to_value(preview).unwrap();
    assert!(!value.to_string().contains("private-state"));
    assert_eq!(value["pluginStateChanged"], true);
    assert_eq!(
        value["before"]["input"]["source"]["config"]["inputId"],
        "private-device-id"
    );
    assert_eq!(
        value["after"]["input"]["source"]["config"]["inputId"],
        "other"
    );
    assert_eq!(value["before"]["postMix"]["plugins"][0]["name"], "first");
    assert_eq!(value["after"]["postMix"]["plugins"][1]["name"], "second");
    target.mixing = None;
    assert!(validate_mixing_selection(&target, &before).is_err());
}

#[test]
fn prepared_mixing_voice_is_not_reloaded_and_explicit_empty_stays_applied() {
    let before = captured();
    let plugin = PresetPlugin {
        path: "voice.vst3".into(),
        name: "voice".into(),
        vendor: String::new(),
        version: String::new(),
        enabled: true,
        muted: false,
        gain: 0.8,
        state: Some("opaque".into()),
    };
    let mut target = BundleV1 {
        mixing: Some(empty_mixing()),
        process: None,
        live: None,
        output: None,
        schema_version: 5,
        revision: "1".into(),
        name: "test".into(),
        categories: ProfileSaveCategories {
            include_plugins: true,
            include_audio_config: true,
            include_noise_control: true,
            include_builtin_fx: true,
        },
        embedded_auralyn_preset: before.preset.clone(),
        obs: None,
        confirmation: None,
        level_intent: Some(bundle::LevelIntent {
            input_gain: 0.5,
            output_gain: 0.25,
        }),
    };
    target.embedded_auralyn_preset.plugins = vec![plugin.clone()];
    target.embedded_auralyn_preset.audio_config = Some(ProfileAudioConfig {
        host: "WASAPI".into(),
        input_device: Some("Mic".into()),
        output_device: Some("Out".into()),
        sample_rate: 48_000,
        buffer_size: 512,
        input_channels: vec![0, 1],
        output_routing: Default::default(),
        input_gain_db: 0.0,
        master_gain_db: 0.0,
    });
    let legacy = restore_profile(&target, false);
    assert_eq!(legacy.plugins, vec![plugin.clone()]);
    assert!(legacy.audio_config.is_some());
    let stripped = restore_profile(&target, true);
    assert!(stripped.plugins.is_empty() && stripped.audio_config.is_none());
    assert!(stripped.noise_control == target.embedded_auralyn_preset.noise_control);
    assert!(stripped.builtin_fx == target.embedded_auralyn_preset.builtin_fx);
    let actual = LoadedPluginInstance {
        id: "actual-id".into(),
        path: plugin.path.clone(),
        name: plugin.name.clone(),
        vendor: String::new(),
        version: String::new(),
        enabled: true,
        muted: false,
        gain: 0.8,
    };
    let initial = selected_start_intent(&target, &before).unwrap();
    let mut summary = ApplyProfileSummary::default();
    add_prepared_summary(&mut summary, &target, &[actual], initial).unwrap();
    assert_eq!(summary.applied_plugins, vec![plugin]);
    assert_eq!(summary.loaded_plugin_instances[0].id, "actual-id");
    assert!(summary.applied_categories.contains(&"plugins".into()));
    assert!(summary.applied_categories.contains(&"audioConfig".into()));
    assert!(complete(&summary));
    target.embedded_auralyn_preset.plugins.clear();
    let mut empty = ApplyProfileSummary::default();
    add_prepared_summary(&mut empty, &target, &[], initial).unwrap();
    assert!(empty.applied_plugins.is_empty() && empty.loaded_plugin_instances.is_empty());
    assert!(empty.applied_categories.contains(&"plugins".into()));
    target.embedded_auralyn_preset.plugins.push(PresetPlugin {
        path: "missing.vst3".into(),
        name: String::new(),
        vendor: String::new(),
        version: String::new(),
        enabled: true,
        muted: false,
        gain: 1.0,
        state: None,
    });
    assert!(
        add_prepared_summary(&mut ApplyProfileSummary::default(), &target, &[], initial).is_err()
    );
}

#[test]
fn prepared_voice_does_not_restart_for_mismatched_route_or_device() {
    let expected = ProfileAudioConfig {
        host: "WASAPI".into(),
        input_device: Some("Mic".into()),
        output_device: Some("Out".into()),
        sample_rate: 48_000,
        buffer_size: 512,
        input_channels: vec![0, 1],
        output_routing: Default::default(),
        input_gain_db: 0.0,
        master_gain_db: 0.0,
    };
    let devices = bundle::RecoveryDevices {
        input_id: "input".into(),
        output_id: "output".into(),
    };
    let initial = profile::StartIntent {
        input_gain: 1.0,
        output_gain: 1.0,
        input_channels: [0, 1],
        output_routing: Default::default(),
        muted: true,
        bypassed: false,
    };
    let routing = crate::ipc::ChannelRouting {
        input_channels: Some([0, 1]),
        output_routing: Default::default(),
    };
    let started = audio::AudioConfig {
        sample_rate: 48_000,
        buffer_size: 512,
        channels: 2,
        routing: Some(routing),
    };
    let mut actual = audio::ActiveAudioConfig {
        host: "WASAPI".into(),
        input: Some("Mic".into()),
        output: Some("Out".into()),
        input_id: Some("input".into()),
        output_id: Some("output".into()),
        sample_rate: Some(48_000),
        buffer_size: Some(512),
        routing: Some(routing),
        input_source: None,
    };
    assert!(prepared_start_matches(
        &started,
        Some(&actual),
        Some(routing),
        &expected,
        &devices,
        initial
    ));
    assert!(!prepared_start_matches(
        &started,
        Some(&actual),
        None,
        &expected,
        &devices,
        initial
    ));
    actual.output_id = Some("different".into());
    assert!(!prepared_start_matches(
        &started,
        Some(&actual),
        Some(routing),
        &expected,
        &devices,
        initial
    ));
}

#[test]
fn mixing_preview_exposes_fields_without_plugin_state_and_detects_missing_input() {
    let current = empty_mixing();
    let mut target = empty_mixing();
    target.input = Some(serde_json::from_value(serde_json::json!({
        "version": 1, "source": { "kind": "device", "config": { "host": "WASAPI", "inputId": "wasapi:missing", "inputChannels": [0, 1] } },
        "levels": { "voice": { "gain": 0.5, "muted": true }, "accompaniment": { "gain": 1.0, "muted": false }, "monitorAccompaniment": false, "offsetMs": -12 }
    })).unwrap());
    target
        .post_mix
        .plugins
        .push(crate::vst_host::presets::PresetPlugin {
            path: "missing.vst3".into(),
            name: "plugin".into(),
            vendor: "vendor".into(),
            version: "1".into(),
            enabled: true,
            muted: false,
            gain: 0.8,
            state: Some("private-state".into()),
        });
    let devices = audio::AudioDeviceList {
        inputs: vec![],
        outputs: vec![],
    };
    let json = serde_json::to_value(mixing_preview(
        &current,
        &target,
        &devices,
        vec!["plugin".into()],
    ))
    .unwrap();
    assert_eq!(json["after"]["input"]["levels"]["voice"]["gain"], 0.5);
    assert_eq!(json["after"]["input"]["levels"]["voice"]["muted"], true);
    assert_eq!(
        json["after"]["input"]["levels"]["monitorAccompaniment"],
        false
    );
    assert_eq!(json["after"]["input"]["levels"]["offsetMs"], -12);
    assert_eq!(json["missingDevices"][0], "wasapi:missing");
    assert_eq!(json["missingPlugins"][0], "plugin");
    assert_eq!(json["pluginStateChanged"], true);
    assert_eq!(json["after"]["postMix"]["plugins"][0]["name"], "plugin");
    assert!(!json.to_string().contains("private-state"));
}
