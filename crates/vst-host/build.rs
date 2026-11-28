fn main() {
    // 子の実行ファイル（audio_engine など）と単体試験に、Common Controls v6 の manifest を埋め込む（VST の編集画面が使う）。
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
}
