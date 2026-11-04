//! fake IPCの事前検証。実音声・機器の受入を意味しない。
use super::*;
use crate::audio_engine::mixing::{Config, Start};
use crate::bundle::mixing_configuration::PostMixPreset;
use std::sync::atomic::{AtomicBool, Ordering};

fn config(id: &str) -> Config {
    serde_json::from_value(serde_json::json!({
        "version": 1,
        "source": { "kind": "device", "config": { "host": "WASAPI", "inputId": id, "inputChannels": [0, 1] } },
        "levels": { "voice": { "gain": 1.0, "muted": false }, "accompaniment": { "gain": 1.0, "muted": false }, "monitorAccompaniment": true, "offsetMs": 0 }
    })).unwrap()
}
fn target(id: &str) -> MixingConfiguration {
    MixingConfiguration {
        version: 1,
        input: Some(config(id)),
        post_mix: PostMixPreset {
            schema_version: 1,
            role: "post_mix".into(),
            enabled: false,
            plugins: Vec::new(),
        },
    }
}
fn owned_root() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "auralyn-mix-bundle-test-{}",
        crate::bundle::revision()
    ));
    std::fs::create_dir(&root).unwrap();
    root
}

#[cfg(windows)]
#[test]
fn preflight_rejection_never_stops_audio_or_changes_saved_files() {
    let root = owned_root();
    let mix_bytes = serde_json::to_vec(&Some(config("wasapi:one"))).unwrap();
    let post_bytes = serde_json::to_vec(&target("wasapi:one").post_mix).unwrap();
    std::fs::write(root.join("mixing.json"), &mix_bytes).unwrap();
    std::fs::write(root.join("post-mix.json"), &post_bytes).unwrap();
    crate::audio::session_rack::tests::with_host(
        |_| panic!("事前拒否はEngineへ要求を送らない"),
        |host, calls| {
            host.mixing = crate::audio::mixing::State::new(&root);
            host.post_mix = crate::audio::post_mix::State::new(&root);
            host.mixing.selected = Some(Start {
                config: config("wasapi:one"),
                target: None,
            });
            let initial_pid = host.child.as_ref().unwrap().id();
            let initial_post = host.post_mix.bundle_revision();
            let (_, witness) = host.capture_bundle_mixing().unwrap();
            let invoked = AtomicBool::new(false);
            let attempt = |host: &mut AudioHost, target: &MixingConfiguration, revision: &str| {
                host.with_bundle_mixing(target, revision, |_| {
                    invoked.store(true, Ordering::SeqCst);
                    Ok(())
                })
            };
            host.is_global_muted = true;
            assert!(attempt(host, &target("wasapi:one"), "stale").is_err());
            host.is_global_muted = false;
            assert!(attempt(host, &target("wasapi:one"), &witness).is_err());
            host.is_global_muted = true;
            assert!(attempt(host, &target("wasapi:other"), &witness).is_err());
            assert!(!invoked.load(Ordering::SeqCst));
            assert!(calls.lock().unwrap().is_empty());
            assert_eq!(host.child.as_ref().unwrap().id(), initial_pid);
            assert!(host.reader_active.load(Ordering::Acquire));
            assert!(host.is_global_muted);
            assert_eq!(host.post_mix.bundle_revision(), initial_post);
            assert_eq!(std::fs::read(root.join("mixing.json")).unwrap(), mix_bytes);
            assert_eq!(
                std::fs::read(root.join("post-mix.json")).unwrap(),
                post_bytes
            );
        },
    );
    std::fs::remove_file(root.join("mixing.json")).unwrap();
    std::fs::remove_file(root.join("post-mix.json")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[cfg(windows)]
#[test]
fn rollback_restores_only_our_published_bytes_or_original_absence() {
    let root = owned_root();
    let path = root.join("post-mix.json");
    let original = Some(b"original state".to_vec());
    let published = Some(b"published state".to_vec());
    std::fs::write(&path, published.as_ref().unwrap()).unwrap();
    rollback_settings(&path, &original, &published).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), original.clone().unwrap());
    // 既に原本なら繰り返しても書き換えない。
    rollback_settings(&path, &original, &published).unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap(),
        original.as_deref().expect("原本あり")
    );
    std::fs::write(&path, published.as_ref().unwrap()).unwrap();
    rollback_settings(&path, &None, &published).unwrap();
    assert!(!path.exists());
    rollback_settings(&path, &None, &published).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[cfg(windows)]
#[test]
fn rollback_preserves_external_edits_and_the_backup_on_file_errors() {
    let root = owned_root();
    let path = root.join("mixing.json");
    let backup = root.join("original-backup.json");
    let original = Some(b"original".to_vec());
    let published = Some(b"published".to_vec());
    let external = b"external edit";
    std::fs::write(&backup, original.as_ref().unwrap()).unwrap();
    std::fs::write(&path, external).unwrap();
    let error = rollback_settings(&path, &original, &published).unwrap_err();
    assert!(error.to_string().contains("外部変更"));
    assert_eq!(std::fs::read(&path).unwrap(), external);
    assert_eq!(
        std::fs::read(&backup).unwrap(),
        original.as_ref().unwrap().as_slice()
    );
    // ディレクトリをファイルとして読めない場合も、別の退避原本を保持する。
    let inaccessible = root.join("not-a-file");
    std::fs::create_dir(&inaccessible).unwrap();
    assert!(rollback_settings(&inaccessible, &original, &published).is_err());
    assert_eq!(
        std::fs::read(&backup).unwrap(),
        original.as_deref().expect("原本あり")
    );
    std::fs::remove_file(path).unwrap();
    std::fs::remove_file(backup).unwrap();
    std::fs::remove_dir(inaccessible).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[cfg(windows)]
#[test]
fn backup_failure_after_stopping_prevents_apply_and_preserves_originals() {
    let root = owned_root();
    let mix_bytes = serde_json::to_vec(&Some(config("wasapi:one"))).unwrap();
    let post_bytes = serde_json::to_vec(&target("wasapi:one").post_mix).unwrap();
    std::fs::write(root.join("mixing.json"), &mix_bytes).unwrap();
    std::fs::write(root.join("post-mix.json"), &post_bytes).unwrap();
    // バックアップ先のディレクトリを作れない状況を、所有fixtureだけで作る。
    std::fs::write(root.join("post-mix-backups"), b"keep backup fixture").unwrap();
    crate::audio::session_rack::tests::with_host(
        |command| {
            match command {
            IpcCommand::Stop => IpcResponse::Success,
            IpcCommand::Mixing { .. } => IpcResponse::Mixing(Box::new(serde_json::from_value(serde_json::json!({
                "epoch":"engine", "revision":"0", "config":null, "running":false, "accompaniment":null,
                "voicePeak":[0,0], "accompanimentPeak":[0,0], "mixPeak":[0,0],
                "knownVoiceProcessingFrames":null, "pending":false, "failed":false, "primaryClock":null
            })).unwrap())),
            other => panic!("予期しない fake IPC: {other:?}"),
        }
        },
        |host, calls| {
            host.last_config_path = root.join("last_audio_config.json");
            host.mixing = crate::audio::mixing::State::new(&root);
            host.post_mix = crate::audio::post_mix::State::new(&root);
            host.mixing.selected = Some(Start {
                config: config("wasapi:one"),
                target: None,
            });
            host.is_global_muted = true;
            let (_, witness) = host.capture_bundle_mixing().unwrap();
            let invoked = AtomicBool::new(false);
            let result = host.with_bundle_mixing(&target("wasapi:one"), &witness, |_| {
                invoked.store(true, Ordering::SeqCst);
                Ok(())
            });
            assert!(result.is_err());
            assert!(!invoked.load(Ordering::SeqCst));
            assert!(host.is_global_muted && !host.bundle_mixing_override);
            assert!(!host.post_mix.has_current_rack());
            assert!(
                calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|c| matches!(c, IpcCommand::Stop))
                    .count()
                    >= 1
            );
            assert_eq!(std::fs::read(root.join("mixing.json")).unwrap(), mix_bytes);
            assert_eq!(
                std::fs::read(root.join("post-mix.json")).unwrap(),
                post_bytes
            );
            assert_eq!(
                std::fs::read(root.join("post-mix-backups")).unwrap(),
                b"keep backup fixture"
            );
        },
    );
    std::fs::remove_file(root.join("mixing.json")).unwrap();
    std::fs::remove_file(root.join("post-mix.json")).unwrap();
    std::fs::remove_file(root.join("post-mix-backups")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[cfg(windows)]
#[test]
fn rollback_refuses_exclusive_external_writer_and_keeps_backup() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = owned_root();
    let path = root.join("mixing.json");
    let backup = root.join("original-backup.json");
    let original = Some(b"original".to_vec());
    let published = Some(b"published".to_vec());
    std::fs::write(&backup, original.as_ref().unwrap()).unwrap();
    std::fs::write(&path, published.as_ref().unwrap()).unwrap();
    let writer = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    assert!(rollback_settings(&path, &original, &published).is_err());
    assert_eq!(
        std::fs::read(&backup).unwrap(),
        original.as_deref().expect("原本あり")
    );
    drop(writer);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        published.as_deref().expect("公開値あり")
    );
    std::fs::remove_file(path).unwrap();
    std::fs::remove_file(backup).unwrap();
    std::fs::remove_dir(root).unwrap();
}
