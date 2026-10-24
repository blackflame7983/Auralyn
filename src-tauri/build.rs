fn main() {
    tauri_build::build();
    // libの単体テストもCommon Controls v6を使う。link-arg-testsは統合テスト向けで、
    // libのテストEXEには届かないため共通指定する。依存はTauriのmanifestと同一に保つ。
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        // binにはTauriが同じ依存のmanifestリソースを既に埋め込む。リンカーの追加生成は
        // 重複リソースになるため無効にし、既存の製品manifestをそのまま使用する。
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
}
