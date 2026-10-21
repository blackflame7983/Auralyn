#![cfg(windows)]

use vst_host_lib::audio::AudioHost;

#[test]
fn maintenance_does_not_start_an_idle_engine_and_rejects_duplicate_application() {
    let root =
        std::env::temp_dir().join(format!("auralyn-idle-maintenance-{}", std::process::id()));
    let mut host = AudioHost::new(root.clone());
    assert!(host.check_can_interrupt().is_ok());
    host.prepare_update().unwrap();
    assert!(!host.get_state().is_running);
    assert!(host.check_can_interrupt().is_err());
    assert!(!root.exists());
    host.finish_update_attempt();
    assert!(host.check_can_interrupt().is_ok());
}
