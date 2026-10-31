use super::*;
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
