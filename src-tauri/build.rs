fn main() {
    tauri_build::build();
    // MockRuntimeを使うWindows統合テストにもCommon Controls v6が必要。
    // テストだけに指定し、製品EXEのTauri生成manifestは変更しない。
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
}
