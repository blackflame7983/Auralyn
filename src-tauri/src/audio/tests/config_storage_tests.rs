use super::*;
#[test]
fn live_output_read_and_invalid_configuration_never_spawn_or_invalidate_conditions() {
    let root = std::env::temp_dir().join(format!(
        "auralyn-readonly-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut host = AudioHost::new(root);
    let witness = host.conditions.control_snapshot().unwrap();
    let snapshot = host.live_output(None).unwrap();
    assert!(snapshot.config.device_id.is_none());
    assert!(snapshot.sink.is_none());
    assert!(snapshot.monitor.is_none());
    assert!(host.child.is_none());
    assert!(witness.validate().is_ok());
    assert!(host
        .live_output(Some(crate::audio_engine::live_output::Config {
            monitor_trim: f32::NAN,
            ..Default::default()
        }))
        .is_err());
    assert!(host.child.is_none());
    assert!(witness.validate().is_ok());
}

#[test]
fn obs_reach_never_spawns_for_stopped_or_missing_stream() {
    let mut host = AudioHost::new(std::env::temp_dir());
    assert!(host.begin_obs_reach_tone(100).is_err());
    assert!(host.child.is_none());
    host.conditions.lifecycle(true);
    assert!(host.begin_obs_reach_tone(100).is_err());
    assert!(host.child.is_none());
}

#[cfg(windows)]
#[test]
fn obs_reach_ack_captures_own_stop_but_old_cleanup_never_stops_new_tone_or_user_stop() {
    use std::os::windows::process::CommandExt;
    let mut host = AudioHost::new(std::env::temp_dir());
    // 音声engineではない有限の所有fixture。実音声・OBSへ接続しない。
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "while($null -ne ($line=[Console]::In.ReadLine())){[Console]::Out.WriteLine($line)}",
        ])
        .creation_flags(0x0800_0000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    host.child = Some(child);
    host.reader_active.store(true, Ordering::Release);
    let slot = host.pending_reply_tx.clone();
    let commands = Arc::new(Mutex::new(Vec::new()));
    let recorded = commands.clone();
    let fail_start = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let failure = fail_start.clone();
    let conditions = host.conditions.clone();
    let worker = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            recorded
                .lock()
                .unwrap()
                .push(serde_json::from_str::<IpcCommand>(&line).unwrap());
            let response = match failure.swap(0, Ordering::SeqCst) {
                1 => IpcResponse::Error("開始拒否".into()),
                2 => {
                    conditions.lifecycle(false);
                    IpcResponse::Success
                }
                _ => IpcResponse::Success,
            };
            slot.deliver(response);
        }
    });
    host.conditions.lifecycle(true);
    let result = (|| -> Result<()> {
        let first = host.begin_obs_reach_tone(100)?;
        let finished = host.finish_obs_reach_tone(&first)?;
        assert!(finished.validate().is_ok());
        assert!(finished.revision() > first.revision());
        let old = host.begin_obs_reach_tone(100)?;
        host.execute_running_command(IpcCommand::SetInputGain { value: 0.5 })?;
        let count = commands.lock().unwrap().len();
        assert!(host.finish_obs_reach_tone(&old).is_err());
        assert_eq!(commands.lock().unwrap().len(), count);
        let new = host.begin_obs_reach_tone(100)?;
        assert!(host.finish_obs_reach_tone(&old).is_err());
        host.finish_obs_reach_tone(&new)?;
        let last = host.begin_obs_reach_tone(100)?;
        host.execute_running_command(IpcCommand::Stop)?;
        let count = commands.lock().unwrap().len();
        assert!(host.finish_obs_reach_tone(&last).is_err());
        assert_eq!(commands.lock().unwrap().len(), count);
        // 開始拒否／開始ACK後のstream異常では所有権を発行せず、
        // 未所有のStopを送らない。IPCのduration自体に有限期限がある。
        for failure in [1, 2] {
            host.conditions.lifecycle(true);
            fail_start.store(failure, Ordering::SeqCst);
            let count = commands.lock().unwrap().len();
            assert!(host.begin_obs_reach_tone(100).is_err());
            let sent = commands.lock().unwrap();
            assert_eq!(sent.len(), count + 1);
            assert!(matches!(
                sent.last(),
                Some(IpcCommand::PlayTestTone {
                    duration_ms: 100,
                    ..
                })
            ));
        }
        Ok(())
    })();
    host.kill_engine();
    worker.join().unwrap();
    result.unwrap();
}

#[test]
fn frame_timing_trace_read_does_not_spawn_or_invalidate_audio_conditions() {
    let mut host = AudioHost::new(std::env::temp_dir());
    host.conditions.lifecycle(true);
    let witness = host.conditions.snapshot().unwrap();
    assert!(host
        .execute_command(IpcCommand::GetFrameTimingTrace {
            expected_epoch: "old".into()
        })
        .is_err());
    assert!(host.child.is_none());
    assert!(!host.reader_active.load(Ordering::Acquire));
    assert!(witness.validate().is_ok());
}

#[test]
fn restore_requires_matching_operation_and_engine_generation_and_valid_input() {
    let response = || IpcResponse::PluginRestored {
        operation_id: 7,
        plugin: crate::ipc::RestoredPlugin {
            id: "id".into(),
            name: "Mock".into(),
            prepared: false,
        },
    };
    assert!(validate_restore_response(1, 1, 7, response()).is_ok());
    assert!(validate_restore_response(1, 2, 7, response()).is_err());
    assert!(validate_restore_response(1, 1, 8, response()).is_err());
    let mut host = AudioHost::new(std::env::temp_dir());
    assert!(host
        .restore_plugin(crate::ipc::RestorePluginRequest {
            path: "mock.vst3".into(),
            state: None,
            bypassed: false,
            muted: false,
            gain: f32::NAN
        })
        .is_err());
    assert!(host.child.is_none());
    let request = crate::ipc::RestorePluginRequest {
        path: "mock.vst3".into(),
        state: Some(String::new()),
        bypassed: true,
        muted: true,
        gain: 0.0,
    };
    let json = serde_json::to_value(&request).unwrap();
    assert_eq!(json["state"], "");
    assert_eq!(json["bypassed"], true);
    assert_eq!(
        serde_json::from_value::<crate::ipc::RestorePluginRequest>(json)
            .unwrap()
            .state
            .as_deref(),
        Some("")
    );
}

fn start_command() -> IpcCommand {
    IpcCommand::Start {
        host: "ASIO".into(),
        input: None,
        output: None,
        input_id: None,
        output_id: None,
        buffer_size: None,
        sample_rate: None,
        initial_controls: None,
        channel_routing: None,
    }
}

#[test]
fn identity_bound_start_requires_new_engine_before_any_start_is_sent() {
    let mut start = start_command();
    if let IpcCommand::Start {
        input_id,
        output_id,
        ..
    } = &mut start
    {
        *input_id = Some("input-exact".into());
        *output_id = Some("output-exact".into());
    }
    for failure in 0..4 {
        let mut sent = Vec::new();
        let result = (|| -> Result<()> {
            require_identity_capability(&start, |probe| {
                sent.push(probe);
                match failure {
                    0 => Err(anyhow!("old engine")),
                    1 => Ok(IpcResponse::Error("unsupported".into())),
                    2 => Ok(IpcResponse::Success),
                    _ => Ok(IpcResponse::StartIdentityCapability { version: 0 }),
                }
            })?;
            sent.push(start.clone());
            Ok(())
        })();
        assert!(result.is_err());
        assert!(matches!(
            sent.as_slice(),
            [IpcCommand::StartIdentityCapability]
        ));
    }
    let mut sent = Vec::new();
    require_identity_capability(&start, |probe| {
        sent.push(probe);
        Ok(IpcResponse::StartIdentityCapability { version: 1 })
    })
    .unwrap();
    assert!(matches!(
        sent.as_slice(),
        [IpcCommand::StartIdentityCapability]
    ));
    let mut probed = false;
    require_identity_capability(&start_command(), |_| {
        probed = true;
        Ok(IpcResponse::Success)
    })
    .unwrap();
    assert!(!probed);
}

#[test]
fn routing_start_requires_version_two_even_without_device_ids() {
    let mut start = start_command();
    if let IpcCommand::Start {
        channel_routing, ..
    } = &mut start
    {
        *channel_routing = Some(crate::ipc::ChannelRouting::default());
    }
    assert!(require_identity_capability(&start, |_| {
        Ok(IpcResponse::StartIdentityCapability { version: 1 })
    })
    .is_err());
    assert!(require_identity_capability(&start, |_| {
        Ok(IpcResponse::StartIdentityCapability { version: 2 })
    })
    .is_ok());
}

#[test]
fn start_sends_retained_mute_before_start_in_both_states() {
    for active in [false, true] {
        let mut sent = Vec::new();
        let response = start_with_mute(active, start_command(), |command| {
            let response = if matches!(command, IpcCommand::Start { .. }) {
                IpcResponse::Started {
                    sample_rate: 48000,
                    buffer_size: 512,
                    routing: None,
                    input_id: None,
                    output_id: None,
                }
            } else {
                IpcResponse::Success
            };
            sent.push(command);
            Ok(response)
        })
        .unwrap();
        assert!(
            matches!(sent.as_slice(), [IpcCommand::SetGlobalMute { active: value }, IpcCommand::Start { .. }] if *value == active)
        );
        assert!(matches!(response, IpcResponse::Started { .. }));
    }
}

#[test]
fn bundle_start_keeps_initial_controls_in_one_request_and_rejects_retired_generation() {
    let mut command = start_command();
    if let IpcCommand::Start {
        initial_controls, ..
    } = &mut command
    {
        *initial_controls = Some(crate::ipc::StartControls {
            input_gain: 0.,
            output_gain: 0.,
            input_channels: [4, 5],
            output_routing: crate::ipc::OutputRouting::Legacy,
            muted: true,
            bypassed: true,
        });
    }
    let json = serde_json::to_value(&command).unwrap();
    let mut legacy_controls = json.clone();
    legacy_controls["payload"]["initial_controls"]
        .as_object_mut()
        .unwrap()
        .remove("outputRouting");
    let old: IpcCommand = serde_json::from_value(legacy_controls).unwrap();
    assert!(matches!(
        old,
        IpcCommand::Start {
            initial_controls: Some(crate::ipc::StartControls {
                output_routing: crate::ipc::OutputRouting::Legacy,
                ..
            }),
            ..
        }
    ));
    let parsed: IpcCommand = serde_json::from_value(json).unwrap();
    assert!(matches!(
        parsed,
        IpcCommand::Start {
            initial_controls: Some(crate::ipc::StartControls {
                output_gain: 0.,
                input_channels: [4, 5],
                ..
            }),
            ..
        }
    ));
    assert!(validate_start_generation(7, 7).is_ok());
    assert!(validate_start_generation(7, 8).is_err());
    let mut host = AudioHost::new(std::env::temp_dir());
    host.engine_generation = 7;
    assert!(host
        .start_on_existing_generation(6, start_command())
        .is_err());
    assert!(host.child.is_none());
    // 同じ世代でもStart直前のreader終了を新engine起動で補わない。
    assert!(host
        .start_on_existing_generation(7, start_command())
        .is_err());
    assert!(host.child.is_none());
    assert!(!host.reader_active.load(Ordering::Acquire));
    let mut legacy = serde_json::to_value(start_command()).unwrap();
    legacy.as_object_mut().unwrap().remove("initial_controls");
    assert!(serde_json::from_value::<IpcCommand>(legacy).is_ok());
}

#[test]
fn start_ipc_roundtrips_exact_ids_and_accepts_legacy_without_ids() {
    let mut command = start_command();
    if let IpcCommand::Start {
        input_id,
        output_id,
        ..
    } = &mut command
    {
        *input_id = Some("WASAPI:input-1".into());
        *output_id = Some("WASAPI:output-1".into());
    }
    let json = serde_json::to_value(&command).unwrap();
    let parsed: IpcCommand = serde_json::from_value(json).unwrap();
    assert!(
        matches!(parsed, IpcCommand::Start { input_id: Some(i), output_id: Some(o), .. } if i == "WASAPI:input-1" && o == "WASAPI:output-1")
    );
    let legacy = serde_json::to_value(start_command()).unwrap();
    assert!(matches!(
        serde_json::from_value::<IpcCommand>(legacy).unwrap(),
        IpcCommand::Start {
            input_id: None,
            output_id: None,
            ..
        }
    ));
}

#[test]
fn start_is_not_sent_after_mute_rejection_or_connection_loss() {
    for failure in 0..3 {
        let mut sent = Vec::new();
        assert!(start_with_mute(true, start_command(), |command| {
            sent.push(command);
            match failure {
                0 => Err(anyhow!("connection lost")),
                1 => Ok(IpcResponse::Error("rejected".into())),
                _ => Ok(IpcResponse::Started {
                    sample_rate: 48000,
                    buffer_size: 512,
                    routing: None,
                    input_id: None,
                    output_id: None,
                }),
            }
        })
        .is_err());
        assert!(matches!(
            sent.as_slice(),
            [IpcCommand::SetGlobalMute { active: true }]
        ));
    }
    let mut sent = Vec::new();
    assert!(start_with_mute(true, start_command(), |command| {
        sent.push(command);
        if sent.len() == 1 {
            Ok(IpcResponse::Success)
        } else {
            Err(anyhow!("engine exited after mute"))
        }
    })
    .is_err());
    assert_eq!(sent.len(), 2); // 再接続や設定なしの再Startは行わない。
}

#[test]
fn invalid_noise_strength_is_rejected_before_starting_or_sending_to_engine() {
    let mut host = AudioHost::new(std::env::temp_dir());
    for strength in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert!(host
            .set_noise_control_config(true, "smart".into(), strength, true)
            .is_err());
        assert!(host.child.is_none());
    }
}

#[test]
fn stopped_without_child_is_idempotent_but_rejected_mutations_keep_mute_intent() {
    let mut host = AudioHost::new(std::env::temp_dir());
    host.maintenance = true;
    host.is_global_muted = true;
    assert!(host.stop().is_ok());
    assert!(host.unload_all_plugins(&["plugin".into()]).is_err());
    assert!(host.set_global_mute(false).is_err());
    assert!(host.is_global_muted);
}

#[test]
fn stop_without_engine_never_spawns_or_changes_retained_intent() {
    let mut host = AudioHost::new(std::env::temp_dir());
    host.is_global_muted = true;
    host.conditions.lifecycle(true);
    let old_conditions = host.conditions.snapshot().unwrap();
    host.voice_activity.store(true, Ordering::Release);
    assert!(host.stop().is_ok());
    assert!(host.child.is_none());
    assert!(host.stdin.is_none());
    assert!(!host.reader_active.load(Ordering::Acquire));
    assert!(old_conditions.validate().is_err());
    assert!(!host.voice_activity.load(Ordering::Acquire));
    assert!(host.is_global_muted);
}

#[test]
fn stop_after_reader_exit_or_broken_pipe_does_not_restart_engine() {
    let mut host = AudioHost::new(std::env::temp_dir());
    // UIが稼働状態を読んだ後、readerが終了した場合。
    host.reader_active.store(true, Ordering::Release);
    host.reader_active.store(false, Ordering::Release);
    assert!(host.stop().is_ok());
    assert!(host.child.is_none());
    // reader終了通知より先にstdinが失われた場合も、失敗接続を回収するだけ。
    host.reader_active.store(true, Ordering::Release);
    assert!(host.stop().is_err());
    assert!(host.child.is_none());
    assert!(host.stdin.is_none());
    assert!(!host.reader_active.load(Ordering::Acquire));
}

#[test]
fn cancelled_restore_cleanup_never_spawns_for_old_plugin_id() {
    let mut host = AudioHost::new(std::env::temp_dir());
    assert!(host.remove_plugin("late-old-id").is_err());
    assert!(host.child.is_none());
    assert_eq!(host.engine_generation, 0);
    // 一度同期済みのreader終了・壊れたpipeも、新しいengineでは回収しない。
    host.live_modes.needs_sync = false;
    assert!(host.remove_plugin("late-old-id").is_err());
    assert!(host.child.is_none());
    host.reader_active.store(true, Ordering::Release);
    assert!(host.remove_plugin("late-old-id").is_err());
    assert!(host.child.is_none());
    assert!(!host.reader_active.load(Ordering::Acquire));
}

fn background_observation(host: &mut AudioHost, kind: usize) -> Result<()> {
    use crate::audio_engine::auto_gain::Request;
    match kind {
        0 => host.auto_gain(Request::Status).map(|_| ()),
        1 => host
            .auto_gain(Request::Initialize { value: 0.5 })
            .map(|_| ()),
        2 => host.get_plugin_state("old-id").map(|_| ()),
        _ => host.get_engine_runtime_stats().map(|_| ()),
    }
}

#[test]
fn bundle_restore_fatal_stops_later_chain_requests_before_send_or_spawn() {
    let mut host = AudioHost::new(std::env::temp_dir());
    host.engine_generation = 7;
    host.reader_active.store(true, Ordering::Release);
    // ensure経路に退行しても、fixtureが実sidecarを起動しないよう防ぐ。
    host.maintenance = true;
    let request = || crate::ipc::RestorePluginRequest {
        path: "fixture-vst".into(),
        state: Some(String::new()),
        bypassed: false,
        muted: false,
        gain: 1.,
    };
    let result = host.bundle_change_scope(|host| {
        // 最初の要求は既存接続へ送信を試み、閉じたstdinによりfatalになる。
        assert!(host.restore_plugin(request()).is_err());
        assert_eq!(host.next_restore_operation, 1);
        assert!(!host.reader_active.load(Ordering::Acquire));
        assert!(host.child.is_none());
        let retired_generation = host.engine_generation;
        // チェーンがmissing扱いでcontinueしても、後続はID発行/送信前に拒否。
        assert!(host.restore_plugin(request()).is_err());
        assert_eq!(host.next_restore_operation, 1);
        assert_eq!(host.engine_generation, retired_generation);
        assert!(host.child.is_none());
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(host.engine_generation, 8); // fatalによる旧世代退役だけ。新engineは生成しない。
    assert!(host.child.is_none());
    assert!(host.bundle_change_generation.is_none());
}

#[test]
fn bundle_state_capture_never_spawns_absent_or_closed_reader_engine() {
    let mut host = AudioHost::new(std::env::temp_dir());
    assert!(host.capture_bundle_state().is_err());
    assert!(host.child.is_none());
    assert_eq!(host.engine_generation, 0);
    host.live_modes.needs_sync = false;
    host.reader_active.store(true, Ordering::Release);
    assert!(host.capture_bundle_state().is_err());
    assert!(host.child.is_none());
}
#[test]
fn bundle_change_scope_rejects_dead_stats_and_setters_without_spawning_or_adopting_generation() {
    let mut host = AudioHost::new(std::env::temp_dir());
    host.engine_generation = 5;
    host.reader_active.store(true, Ordering::Release);
    let result = host.bundle_change_scope(|host| {
        // capture後の終了。通常pollのdefault statsを成功した実状態に昇格しない。
        host.reader_active.store(false, Ordering::Release);
        assert!(host.get_engine_runtime_stats().is_err());
        assert!(host
            .set_noise_control_config(true, "smart".into(), 0.5, true)
            .is_err());
        assert!(host.set_built_in_effects(false, None, 0.5).is_err());
        assert!(host.child.is_none());
        Ok(()) // 旧callerがエラーを無視しても、scope終端で成功にしない。
    });
    assert!(result.is_err());
    assert!(host.child.is_none());
    assert_eq!(host.engine_generation, 5);
    assert!(host.bundle_change_generation.is_none());
    host.reader_active.store(true, Ordering::Release);
    let result = host.bundle_change_scope(|host| {
        host.engine_generation += 1;
        Ok(())
    });
    assert!(result.is_err());
    assert!(host.child.is_none());
}

fn cleanup_observation(host: &mut AudioHost, cancel: bool) -> Result<()> {
    if cancel {
        let snapshot = host.auto_gain(crate::audio_engine::auto_gain::Request::Cancel)?;
        assert_eq!(snapshot.phase, "idle");
        assert!(!snapshot.playing);
        assert!(!snapshot.running);
        assert!(!snapshot.settled, "取消ACKを音量の確認済み値にしない");
        assert!(snapshot.proposal.is_none());
        Ok(())
    } else {
        host.set_loudness_measurement(None)
    }
}

#[test]
fn absent_engine_cleanup_acknowledges_stop_without_spawning_or_changing_mute() {
    for cancel in [false, true] {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.is_global_muted = true;
        host.conditions.lifecycle(true);
        let witness = host.conditions.snapshot().unwrap();
        host.voice_activity.store(true, Ordering::Release);
        assert!(cleanup_observation(&mut host, cancel).is_ok());
        assert!(host.child.is_none());
        assert!(host.stdin.is_none());
        assert!(!host.reader_active.load(Ordering::Acquire));
        assert!(host.is_global_muted);
        assert!(!host.voice_activity.load(Ordering::Acquire));
        assert!(witness.validate().is_err());
    }
}

#[cfg(windows)]
#[test]
fn cleanup_reaps_only_confirmed_exit_and_never_replaces_disconnected_child() {
    use std::os::windows::process::CommandExt;
    // 0=確実終了、1=生存reader断、2=生存pipe断。音声engineは起動しない。
    for state in 0..3 {
        for cancel in [false, true] {
            let mut host = AudioHost::new(std::env::temp_dir());
            let mut command = if state == 0 {
                let mut command = Command::new("cmd.exe");
                command.args(["/D", "/C", "exit 0"]);
                command
            } else {
                let mut command = Command::new("powershell.exe");
                command.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ]);
                command
            };
            host.child = Some(
                command
                    .creation_flags(0x0800_0000)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let pid = host.child.as_ref().unwrap().id();
            if state == 0 {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while host.child.as_mut().unwrap().try_wait().unwrap().is_none() {
                    if std::time::Instant::now() >= deadline {
                        host.kill_engine();
                        panic!("fixture終了期限超過");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            host.reader_active.store(state == 2, Ordering::Release);
            host.conditions.lifecycle(true);
            let witness = host.conditions.snapshot().unwrap();
            let result = cleanup_observation(&mut host, cancel);
            let same_or_absent = host.child.as_ref().is_none_or(|child| child.id() == pid);
            let alive_disconnected_retained = state != 1 || host.child.is_some();
            host.kill_engine();
            assert_eq!(result.is_ok(), state == 0);
            assert!(same_or_absent);
            assert!(alive_disconnected_retained);
            assert!(witness.validate().is_err());
            assert!(host.child.is_none());
        }
    }
}

#[test]
fn background_observations_do_not_spawn_cold_or_closed_reader_engine() {
    for kind in 0..4 {
        let mut host = AudioHost::new(std::env::temp_dir());
        host.is_global_muted = true;
        let result = background_observation(&mut host, kind);
        assert_eq!(result.is_ok(), kind == 3); // 旧runtime statsの不在default契約だけ保持。
        assert!(host.child.is_none());
        assert!(host.stdin.is_none());
        assert_eq!(host.engine_generation, 0);
        assert!(host.is_global_muted);
        host.live_modes.needs_sync = false;
        host.reader_active.store(false, Ordering::Release);
        assert_eq!(background_observation(&mut host, kind).is_ok(), kind == 3);
        assert!(host.child.is_none());
    }
}

#[cfg(windows)]
#[test]
fn background_observations_do_not_replace_exited_child_or_broken_pipe() {
    use std::os::windows::process::CommandExt;
    for exited in [true, false] {
        for kind in 0..4 {
            let mut host = AudioHost::new(std::env::temp_dir());
            let mut command = if exited {
                let mut command = Command::new("cmd.exe");
                command.args(["/D", "/C", "exit 0"]);
                command
            } else {
                let mut command = Command::new("powershell.exe");
                command.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ]);
                command
            };
            host.child = Some(
                command
                    .creation_flags(0x0800_0000)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let pid = host.child.as_ref().unwrap().id();
            if exited {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while host.child.as_mut().unwrap().try_wait().unwrap().is_none() {
                    if std::time::Instant::now() >= deadline {
                        host.kill_engine();
                        panic!("fixture終了期限超過");
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            host.reader_active.store(!exited, Ordering::Release);
            host.conditions.lifecycle(true);
            let witness = host.conditions.snapshot().unwrap();
            let result = background_observation(&mut host, kind);
            let same_or_absent = host.child.as_ref().is_none_or(|child| child.id() == pid);
            host.kill_engine();
            assert_eq!(result.is_ok(), exited && kind == 3);
            assert!(same_or_absent, "読取のために新childを作らない");
            assert!(witness.validate().is_err());
            assert!(host.child.is_none());
        }
    }
}

#[cfg(windows)]
#[test]
fn existing_background_reads_keep_values_and_only_gain_initialize_invalidates_witness() {
    use crate::audio_engine::auto_gain::{Request, Snapshot};
    use std::os::windows::process::CommandExt;
    let mut host = AudioHost::new(std::env::temp_dir());
    let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "for($i=0;$i -lt 6;$i++){ $line=[Console]::In.ReadLine(); [Console]::Out.WriteLine($line) }; Start-Sleep -Seconds 30"])
            .creation_flags(0x0800_0000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let pid = child.id();
    host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    host.child = Some(child);
    host.reader_active.store(true, Ordering::Release);
    host.live_modes.needs_sync = false;
    let slot = host.pending_reply_tx.clone();
    let worker = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        for _ in 0..6 {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let response = match serde_json::from_str::<IpcCommand>(&line).unwrap() {
                IpcCommand::AutoGain { .. } => IpcResponse::AutoGain(Snapshot {
                    revision: 4,
                    gain: 0.5,
                    confirmed_gain: 0.5,
                    settled: true,
                    running: false,
                    stream_failed: false,
                    id: 0,
                    phase: "idle".into(),
                    progress: 0.,
                    proposal: None,
                    playing: false,
                    error: None,
                    devices: Vec::new(),
                    history_id: None,
                    history_epoch: None,
                    history_reason: Some(crate::audio_engine::history::Reason::NotCreated),
                    undo_available: false,
                    redo_available: false,
                }),
                IpcCommand::GetPluginState { id } => IpcResponse::PluginState {
                    id,
                    state: "saved-state".into(),
                },
                IpcCommand::GetRuntimeStats => {
                    let value = serde_json::to_value(EngineRuntimeStats::default()).unwrap();
                    let fields: serde_json::Map<String, serde_json::Value> = value
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(key, value)| {
                            let snake = key
                                .chars()
                                .flat_map(|c| {
                                    if c.is_ascii_uppercase() {
                                        vec!['_', c.to_ascii_lowercase()]
                                    } else {
                                        vec![c]
                                    }
                                })
                                .collect::<String>();
                            (snake, value.clone())
                        })
                        .collect();
                    serde_json::from_value(
                        serde_json::json!({ "type": "RuntimeStats", "payload": fields }),
                    )
                    .unwrap()
                }
                IpcCommand::SetLoudnessMeasurement { id: None } => IpcResponse::Success,
                _ => panic!("状態取得以外のIPCを送りました"),
            };
            assert!(slot.deliver(response));
        }
    });
    host.conditions.lifecycle(true);
    let witness = host.conditions.snapshot().unwrap();
    let result = (|| -> Result<()> {
        assert_eq!(host.auto_gain(Request::Status)?.gain, 0.5);
        assert!(witness.validate().is_ok());
        assert_eq!(
            host.auto_gain(Request::Initialize { value: 0.5 })?.gain,
            0.5
        );
        assert!(witness.validate().is_err());
        let after_gain = host.conditions.snapshot().unwrap();
        assert_eq!(host.get_plugin_state("old-id")?, "saved-state");
        assert_eq!(host.get_engine_runtime_stats()?.active_plugin_count, 0);
        assert!(after_gain.validate().is_ok());
        host.set_loudness_measurement(None)?;
        let cancelled = host.auto_gain(Request::Cancel)?;
        assert_eq!(cancelled.gain, 0.5);
        assert!(cancelled.settled); // 生存engineの実応答は保持する。
        Ok(())
    })();
    let same_child = host.child.as_ref().is_some_and(|child| child.id() == pid);
    host.kill_engine();
    worker.join().unwrap();
    assert!(result.is_ok());
    assert!(same_child);
    assert!(host.child.is_none());
}

#[cfg(windows)]
#[test]
fn remove_plugin_on_live_child_with_stopped_audio_sends_unload_and_invalidates_witness() {
    use std::os::windows::process::CommandExt;
    let mut host = AudioHost::new(std::env::temp_dir());
    let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$line=[Console]::In.ReadLine(); [Console]::Out.WriteLine($line); Start-Sleep -Seconds 30"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().unwrap();
    let pid = child.id();
    host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
    let stdout = child.stdout.take().unwrap();
    host.child = Some(child);
    host.reader_active.store(true, Ordering::Release);
    host.live_modes.needs_sync = false;
    // 音声streamが停止中でも、常駐child上のVSTは削除できる。
    host.voice_activity.store(false, Ordering::Release);
    host.conditions.lifecycle(true);
    let witness = host.conditions.snapshot().unwrap();
    let reply = host.pending_reply_tx.clone();
    let worker = std::thread::spawn(move || {
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        assert!(
            matches!(serde_json::from_str::<IpcCommand>(&line).unwrap(), IpcCommand::UnloadPlugin { id } if id == "stopped-id")
        );
        assert!(reply.deliver(IpcResponse::Success));
    });
    let result = host.remove_plugin("stopped-id");
    let same_child = host.child.as_ref().is_some_and(|child| child.id() == pid);
    // 成否にかかわらず、所有fixtureだけを先に回収してからassertする。
    host.kill_engine();
    worker.join().unwrap();
    assert!(result.is_ok());
    assert!(same_child);
    assert!(witness.validate().is_err());
    assert!(host.child.is_none());
}

#[cfg(windows)]
#[test]
fn stop_reaps_exited_child_but_refuses_live_child_with_closed_reader() {
    use std::os::windows::process::CommandExt;
    // 音声engineではなく、所有する短命fixtureだけを起動する。consoleは表示しない。
    let mut host = AudioHost::new(std::env::temp_dir());
    host.child = Some(
        Command::new("cmd.exe")
            .args(["/D", "/C", "exit 0"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while host.child.as_mut().unwrap().try_wait().unwrap().is_none() {
        if std::time::Instant::now() >= deadline {
            host.kill_engine();
            panic!("fixture終了期限を超過しました");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    // 実クラッシュと同じくchildはSome、readerはfalseのまま。
    assert!(host.get_state().is_running);
    host.is_global_muted = true;
    host.conditions.lifecycle(true);
    let witness = host.conditions.snapshot().unwrap();
    assert!(host.stop().is_ok());
    assert!(!host.get_state().is_running);
    assert!(host.child.is_none());
    assert!(witness.validate().is_err());
    assert!(host.is_global_muted);

    host.child = Some(
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let generation = host.engine_generation;
    assert!(host.stop().is_err());
    assert!(host.child.is_some());
    assert_eq!(host.engine_generation, generation);
    // 自分のfixtureだけを確実にkill/waitする。assert失敗時もAudioHost::dropが回収する。
    host.kill_engine();
    assert!(host.child.is_none());
}

#[test]
fn saving_packaged_audio_config_does_not_read_or_overwrite_standalone() {
    let root = std::env::temp_dir().join(format!(
        "auralyn-audio-storage-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let standalone = root.join("legacy/last_audio_config.json");
    let packaged = root.join("package/LocalState/Auralyn/last_audio_config.json");
    let legacy = ActiveAudioConfig {
        host: "ASIO".into(),
        input: Some("Legacy Input".into()),
        output: None,
        input_id: None,
        output_id: None,
        sample_rate: Some(96000),
        buffer_size: Some(512),
        routing: None,
    };
    persist_audio_config(&standalone, &legacy).unwrap();
    let before = std::fs::read(&standalone).unwrap();
    assert!(!packaged.exists(), "既存版から暗黙にコピーしない");
    let current = ActiveAudioConfig {
        host: "Wasapi".into(),
        ..legacy
    };
    persist_audio_config(&packaged, &current).unwrap();
    assert_eq!(std::fs::read(&standalone).unwrap(), before);
    let loaded: ActiveAudioConfig =
        serde_json::from_slice(&std::fs::read(&packaged).unwrap()).unwrap();
    assert_eq!(loaded.host, "Wasapi");
    // 削除対象はこのテストが作成した絶対パスの専用ディレクトリだけ。
    assert!(root.is_absolute() && root.starts_with(std::env::temp_dir()));
    std::fs::remove_dir_all(root).unwrap();
}
