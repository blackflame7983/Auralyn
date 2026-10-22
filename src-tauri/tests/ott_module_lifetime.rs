use vst_host_lib::audio_engine::plugins::PluginManager;
use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};

// 実機の入出力は開始せず、インストール済みOTTを隔離したテストプロセスで使う。
#[test]
#[ignore = "OTT 1.37のインストールが必要。明示指定して実行する"]
fn ott_processors_survive_other_instance_retirement_and_module_pinning() {
    unsafe { OleInitialize(None) }.expect("STA初期化");
    struct OleGuard;
    impl Drop for OleGuard {
        fn drop(&mut self) {
            unsafe { OleUninitialize() };
        }
    }
    let _ole = OleGuard;
    let path = std::env::var("AURALYN_TEST_OTT_PATH")
        .unwrap_or_else(|_| r"C:\Program Files\Common Files\VST3\OTT.vst3".to_string());
    assert!(std::path::Path::new(&path).is_file(), "OTTが見つからない");

    let mut manager = PluginManager::new();
    // ロード後の処理準備で失敗しても、未登録のInstanceとRT番号を残さない。
    assert!(manager.load_plugin(&path, 0.0, 256, 2, true).is_err());
    assert!(manager.order.is_empty());
    assert!(manager.plugins.is_empty());
    assert_eq!(manager.runtime_stats(), (0, 0, 0));
    let (first, _, first_index, first_processor) = manager
        .load_plugin(&path, 48_000.0, 256, 2, true)
        .expect("OTT追加1");
    let (second, _, second_index, second_processor) = manager
        .load_plugin(&path, 48_000.0, 256, 2, true)
        .expect("OTT追加2");
    let first_processor = first_processor.expect("Processor1");
    assert_eq!(first_index, 0);
    let mut second_processor = second_processor.expect("Processor2");
    let state = manager.get(&second).unwrap().get_state().expect("状態保存");
    manager
        .get(&second)
        .unwrap()
        .set_state(&state)
        .expect("保存した状態の再適用");
    assert_eq!(manager.get(&second).unwrap().get_state().unwrap(), state);
    let retained_module = manager.get(&second).unwrap()._library.clone();

    // 重複追加を拒否した場合と同じく、余分なhandleだけを非RT側で解放する。
    let original_module_refs = std::sync::Arc::strong_count(&retained_module);
    let duplicate = manager
        .get(&second)
        .unwrap()
        .create_processor()
        .expect("重複handle");
    assert_eq!(
        std::sync::Arc::strong_count(&retained_module),
        original_module_refs + 1
    );
    drop(duplicate);
    assert_eq!(
        std::sync::Arc::strong_count(&retained_module),
        original_module_refs
    );
    assert_eq!(manager.rt_index_of(&second), Some(second_index));
    assert!(manager
        .get(&second)
        .unwrap()
        .active_flag
        .load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(manager.get(&second).unwrap().get_state().unwrap(), state);
    assert_eq!(manager.runtime_stats(), (2, 0, 0));

    assert_eq!(manager.begin_unload(&first).unwrap(), first_index);
    assert_eq!(manager.runtime_stats().1, 1);
    assert!(manager.pending_drop_by_index.contains_key(&first_index));
    drop(first_processor);
    manager.on_processor_retired(first_index);
    assert_eq!(manager.runtime_stats(), (1, 0, 1));
    assert_eq!(manager.get(&second).unwrap().get_state().unwrap(), state);

    // 残るインスタンスでメモリ内の無音を処理し、DLL終了の巻き添えがないことを確認。
    let inputs = vec![vec![0.0; 256]; 2];
    let mut outputs = vec![vec![f32::NAN; 256]; 2];
    second_processor.process_planar(&inputs, &mut outputs, 256);
    assert!(outputs.iter().flatten().all(|sample| sample.is_finite()));
    manager.begin_unload(&second).unwrap();
    drop(second_processor);
    manager.on_processor_retired(second_index);
    assert_eq!(manager.runtime_stats(), (0, 0, 1));

    // 保持済みDLLがある状態で再ロードし、InitDll/ExitDllの対が崩れないことを確認。
    let (third, _, third_index, third_processor) = manager
        .load_plugin(&path, 48_000.0, 256, 2, true)
        .expect("OTT再追加");
    manager.begin_unload(&third).unwrap();
    drop(third_processor);
    manager.on_processor_retired(third_index);
    assert_eq!(manager.runtime_stats(), (0, 0, 1));
    drop(manager);
    // Instance・Processor・保持先を落としても、独立した共有参照は最後まで残る。
    assert_eq!(std::sync::Arc::strong_count(&retained_module), 1);
    drop(retained_module);
}
