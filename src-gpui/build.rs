fn main() -> Result<(), embed_resource::CompilationResult> {
    println!("cargo:rerun-if-changed=app.rc");
    println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");
    embed_resource::compile("app.rc", embed_resource::NONE).manifest_optional()
}
