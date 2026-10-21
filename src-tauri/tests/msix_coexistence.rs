#[cfg(test)]
mod tests {
    use std::{
        path::Path,
        process::Command,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    use tauri::utils::config::AppDirectoriesOverride;
    use tauri::Listener;
    use tauri::Manager;
    use vst_host_lib::coexistence::plugin;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };

    fn context(root: &Path, id: &str, packaged: bool) -> tauri::Context<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().identifier = id.into();
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Root(root.join(if packaged {
                "packaged"
            } else {
                "standalone"
            })));
        context
    }

    // 子テストのsetup到達を記録する。実際の音声・ユーザー設定は使わない。
    #[test]
    fn secondary_process_probe() {
        let Some(root) = std::env::var_os("AURALYN_COEXIST_TEST_ROOT") else {
            return;
        };
        let id = std::env::var("AURALYN_COEXIST_TEST_ID").unwrap();
        let packaged = std::env::var("AURALYN_COEXIST_TEST_PACKAGED").unwrap() == "1";
        let root = std::path::PathBuf::from(root);
        let app = tauri::test::mock_builder()
            .plugin(plugin())
            .build(context(&root, &id, packaged))
            .unwrap();
        // buildのプラグイン初期化を抜けたら、この後にwindow/setupへ進める。
        std::fs::write(root.join("secondary-setup"), "initialization allowed").unwrap();
        tauri_plugin_single_instance::destroy(&app);
    }

    #[test]
    fn different_storage_roots_share_one_native_instance_in_both_orders() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-coexist-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir(&root).unwrap();
        for packaged in [false, true] {
            let id = format!("com.auralyn.test.coexist.{}.{packaged}", std::process::id());
            let app = tauri::test::mock_builder()
                .plugin(plugin())
                .build(context(&root, &id, packaged))
                .unwrap();
            assert_eq!(
                app.path().app_config_dir().unwrap(),
                root.join(if packaged { "packaged" } else { "standalone" })
            );
            assert_eq!(
                app.path().app_local_data_dir().unwrap(),
                root.join(if packaged { "packaged" } else { "standalone" })
            );
            let notified = Arc::new(AtomicBool::new(false));
            let received = notified.clone();
            app.listen("second-instance", move |_| {
                received.store(true, Ordering::SeqCst);
            });
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "tests::secondary_process_probe", "--nocapture"])
                .env("AURALYN_COEXIST_TEST_ROOT", &root)
                .env("AURALYN_COEXIST_TEST_ID", &id)
                .env(
                    "AURALYN_COEXIST_TEST_PACKAGED",
                    if packaged { "0" } else { "1" },
                )
                .spawn()
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(15);
            let status = loop {
                // single-instanceの転送通知を実際のWindowsメッセージループで受ける。
                unsafe {
                    let mut message = MSG::default();
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if Instant::now() > deadline {
                    child.kill().unwrap();
                    child.wait().unwrap();
                    panic!("二重起動の終了がタイムアウトしました");
                }
                std::thread::sleep(Duration::from_millis(10));
            };
            tauri_plugin_single_instance::destroy(&app);
            assert!(status.success());
            assert!(
                notified.load(Ordering::SeqCst),
                "既存アプリに起動通知が届きませんでした"
            );
            assert!(
                !root.join("secondary-setup").exists(),
                "後発プロセスがsetupへ到達しました"
            );
            // 別の識別子なら初期化へ進む陽性対照。マーカー欠落だけで成功にしない。
            let control = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "tests::secondary_process_probe", "--nocapture"])
                .env("AURALYN_COEXIST_TEST_ROOT", &root)
                .env("AURALYN_COEXIST_TEST_ID", format!("{id}.control"))
                .env("AURALYN_COEXIST_TEST_PACKAGED", "0")
                .status()
                .unwrap();
            assert!(control.success());
            assert!(root.join("secondary-setup").exists());
            std::fs::remove_file(root.join("secondary-setup")).unwrap();
        }
        // このテストで作成した空ディレクトリだけを削除する。
        std::fs::remove_dir(&root).unwrap();
    }
}
