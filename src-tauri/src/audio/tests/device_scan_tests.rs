use super::*;
fn ticket(generation: u64, token: u64) -> DeviceScanTicket {
    DeviceScanTicket {
        generation,
        token,
        started: std::time::Instant::now(),
        terminal: Arc::new(OnceLock::new()),
    }
}
#[test]
fn scanner_identity_and_buffer_range_reach_frontend_without_name_fallback() {
    // scannerのJSONをEngine IPC DTOとして受け、Hostの実際の変換・完了経路へ渡す。
    let scanner_json = r#"[{"name":"Headphones","host":"Wasapi","id":"WASAPI:{endpoint-id}","is_input":false,"buffer_size_range":[128,1024],"channels":2,"is_default":false},{"name":"Legacy","host":"ASIO","is_input":false,"buffer_size_range":null,"channels":2,"is_default":true}]"#;
    let devices: Vec<crate::ipc::DeviceInfo> = serde_json::from_str(scanner_json).unwrap();
    assert!(devices[1].id.is_none());
    let mut host = AudioHost::new(std::env::temp_dir());
    host.engine_generation = 2;
    let scan = ticket(2, 8);
    host.device_scan = Some(scan.clone());
    let result = host.finish_device_scan(&scan, devices).unwrap();
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json["outputs"][0]["id"], "WASAPI:{endpoint-id}");
    assert_eq!(
        json["outputs"][0]["buffer_size_range"],
        serde_json::json!([128, 1024])
    );
    assert!(json["outputs"][1].get("id").is_none());
    assert!(json["outputs"][1].get("buffer_size_range").is_none());
    assert!(host.child.is_none());
}
#[test]
fn old_scan_ticket_cannot_poll_or_cancel_another_generation() {
    let mut host = AudioHost::new(std::env::temp_dir());
    let old = ticket(3, 1);
    let current = ticket(4, 1);
    host.engine_generation = 4;
    host.device_scan = Some(current.clone());
    assert!(host.poll_device_scan(&old).is_err());
    host.cancel_device_scan(&old).unwrap();
    assert!(host.scan_is_current(&current));
    assert!(host.child.is_none());
}
#[test]
fn cache_hit_and_coalesced_request_do_not_start_an_engine_or_destroy_cache() {
    let mut host = AudioHost::new(std::env::temp_dir());
    host.cached_devices = Some(AudioDeviceList {
        inputs: Vec::new(),
        outputs: Vec::new(),
    });
    assert!(matches!(
        host.begin_device_scan(false).unwrap(),
        DeviceScanStart::Cached(_)
    ));
    host.device_scan = Some(ticket(0, 1));
    assert!(matches!(
        host.begin_device_scan(true).unwrap(),
        DeviceScanStart::Pending(_)
    ));
    assert!(host.cached_devices.is_some());
    assert!(host.child.is_none());
}
#[test]
fn parallel_callers_keep_completion_after_next_scan_and_reject_previous_engine() {
    let mut host = AudioHost::new(std::env::temp_dir());
    host.engine_generation = 2;
    host.device_scan = Some(ticket(2, 8));
    let DeviceScanStart::Pending(first) = host.begin_device_scan(true).unwrap() else {
        panic!("not pending")
    };
    let DeviceScanStart::Pending(second) = host.begin_device_scan(false).unwrap() else {
        panic!("not pending")
    };
    assert!(Arc::ptr_eq(&first.terminal, &second.terminal));
    let device = crate::ipc::DeviceInfo {
        sample_rate_ranges: None,
        name: "Current Mic".into(),
        host: "Wasapi".into(),
        id: None,
        is_input: true,
        channels: 2,
        buffer_size_range: None,
        is_default: true,
    };
    host.finish_device_scan(&first, vec![device]).unwrap();
    // CのBeginが成功した直後と同じ状態。Bのterminalはhostの新ticketと独立する。
    let next = ticket(2, 9);
    host.device_scan = Some(next.clone());
    let DeviceScanStart::Pending(third) = host.begin_device_scan(true).unwrap() else {
        panic!("not pending")
    };
    assert_eq!(third.token, 9);
    assert_eq!(
        host.poll_device_scan(&second).unwrap().unwrap().inputs[0].name,
        "Current Mic"
    );
    assert!(host.scan_is_current(&next));
    host.engine_generation += 1;
    assert!(host.poll_device_scan(&second).is_err());
    assert!(host.finish_device_scan(&first, Vec::new()).is_err());
    assert_eq!(
        host.cached_devices.as_ref().unwrap().inputs[0].name,
        "Current Mic"
    );
    assert!(host.child.is_none());
}
#[test]
fn failed_terminal_is_shared_without_destroying_cache_or_cancelling_new_request() {
    let mut host = AudioHost::new(std::env::temp_dir());
    let first = ticket(0, 1);
    let second = first.clone();
    host.device_scan = Some(first.clone());
    host.cached_devices = Some(AudioDeviceList {
        inputs: Vec::new(),
        outputs: Vec::new(),
    });
    assert!(host
        .fail_device_scan(&first, "scanner timeout".into())
        .is_err());
    let next = ticket(0, 2);
    host.device_scan = Some(next.clone());
    assert_eq!(
        host.poll_device_scan(&second).unwrap_err().to_string(),
        "scanner timeout"
    );
    host.cancel_device_scan(&second).unwrap();
    assert!(host.scan_is_current(&next));
    assert!(host.cached_devices.is_some());
}
fn proposal_prepare_request() -> crate::audio_engine::voice_check::preview::Request {
    use crate::audio_engine::voice_check::preview::{Action, Request};
    Request {
        client_id: "proposal-host".into(),
        session_id: 1,
        operation_id: 2,
        epoch: Some("old-preview".into()),
        action: Action::PrepareProposal {
            rule_version: None,
            preferences: None,
            preferences_revision: None,
            recording_id: 1,
            builtin_epoch: "old-builtin".into(),
            expected_revision: "1".into(),
        },
    }
}
#[cfg(windows)]
#[test]
fn proposal_prepare_exited_child_with_late_reader_notification_never_ensures_or_spawns() {
    use std::os::windows::process::CommandExt;
    let mut host = AudioHost::new(std::env::temp_dir());
    // 音声sidecarではない所有fixture。ensureへ退行しても実engineは起動させない。
    host.maintenance = true;
    let mut child = Command::new("cmd.exe")
        .args(["/D", "/C", "exit 0"])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.wait().unwrap();
    let pid = child.id();
    host.child = Some(child);
    host.engine_generation = 7;
    host.reader_active.store(true, Ordering::Release);
    let error = host
        .voice_check_preview(proposal_prepare_request())
        .unwrap_err()
        .to_string();
    let unchanged =
        host.engine_generation == 7 && host.child.as_ref().is_some_and(|c| c.id() == pid);
    host.kill_engine();
    assert!(unchanged);
    assert!(error.contains("音声エンジンが終了しました"));
}
#[cfg(windows)]
#[test]
fn proposal_prepare_exit_after_connection_check_rejects_same_generation_without_spawn() {
    use std::os::windows::process::CommandExt;
    let mut host = AudioHost::new(std::env::temp_dir());
    host.maintenance = true;
    let mut child = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$null=[Console]::In.ReadLine()",
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    host.stdin = Some(BufWriter::new(child.stdin.take().unwrap()));
    let pid = child.id();
    host.child = Some(child);
    host.engine_generation = 7;
    host.reader_active.store(true, Ordering::Release);
    assert!(host.require_proposal_connection(6).is_err());
    host.require_proposal_connection(7).unwrap();
    // 公開入口の接続確認と実際の送信の間でchildだけが終了。reader通知はまだtrue。
    host.stdin = None;
    host.child.as_mut().unwrap().wait().unwrap();
    assert!(host.reader_active.load(Ordering::Acquire));
    let error = host
        .prepare_proposal_on_existing_generation(7, proposal_prepare_request())
        .unwrap_err()
        .to_string();
    let unchanged =
        host.engine_generation == 7 && host.child.as_ref().is_some_and(|c| c.id() == pid);
    host.kill_engine();
    assert!(unchanged);
    assert!(error.contains("音声エンジンが終了しました"));
}
