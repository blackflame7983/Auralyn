mod common;

use common::EngineProcess;
use vst_host_lib::ipc::{Command, Response};

#[test]
#[ignore = "OTT VST3 のインストールとデスクトップ環境が必要"]
fn test_ott_editor_loading() {
    let mut engine = EngineProcess::spawn();
    let response = engine.request(Command::LoadPlugin {
        path: r"C:\Program Files\Common Files\VST3\OTT.vst3".into(),
    });
    let id = match response {
        Response::PluginLoaded { id, .. } if !id.is_empty() => id,
        other => panic!("OTT load failed: {other:?}"),
    };
    let response = engine.request(Command::OpenEditor { id: id.clone() });
    assert!(
        matches!(response, Response::Success),
        "editor open failed: {response:?}"
    );
    // UnloadPlugin は内部でエディターを閉じてからアンロードする。
    let response = engine.request(Command::UnloadPlugin { id });
    assert!(
        matches!(response, Response::Success),
        "editor close / unload failed: {response:?}"
    );
    engine.finish();
}
