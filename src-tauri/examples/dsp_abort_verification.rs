fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 通常のテストハーネスを使わず、製品と同じpanic方式でメモリ内のDSPだけを検証する。
    // デバイス列挙・ストリーム開始・Tauri起動・VSTロードは呼び出さない。
    if cfg!(debug_assertions) || !cfg!(panic = "abort") {
        return Err("release・panic=abort構成が必要です".into());
    }
    let dir = std::env::var_os("AURALYN_DSP_SNAPSHOT_DIR")
        .ok_or("空の記録先をAURALYN_DSP_SNAPSHOT_DIRで指定してください")?;
    let mut entries = std::fs::read_dir(dir)?;
    if entries.next().transpose()?.is_some() {
        return Err("空の記録先を指定してください".into());
    }
    // 記録先検査のハンドルも検証へ入る前に閉じる。
    drop(entries);
    vst_host_lib::audio_engine::core::run_dsp_abort_verification();
    println!(
        "DSP_ABORT_VERIFICATION: 5 suites passed; measured allocations=0 deallocations=0; panic=abort"
    );
    Ok(())
}
