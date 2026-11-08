#![warn(clippy::undocumented_unsafe_blocks)]
use libloading::Library;
use std::env;
use std::ffi::c_void;
use std::path::PathBuf;
use vst_host_lib::vst_host::c_api::{IPluginFactoryVtbl, PFactoryInfo};
use vst_host_lib::vst_host::class_listing::{
    decode_fixed_c_string, list_effect_classes, ScanReport, NO_EFFECT_ERROR, SCAN_FORMAT_VERSION,
};

// We define the function pointer type locally since it's not in c_api.rs
type GetPluginFactory = unsafe extern "C" fn() -> *mut c_void;

unsafe fn get_vtbl<T>(ptr: *mut c_void) -> &'static T {
    &**(ptr as *mut *mut T)
}

fn failed(path: &str, kind: &str, error: String) -> ScanReport {
    ScanReport {
        format_version: SCAN_FORMAT_VERSION,
        path: path.to_string(),
        success: false,
        error: Some(error),
        error_kind: Some(kind.to_string()),
        factory_vendor: None,
        classes: Vec::new(),
    }
}

fn main() {
    // Prevent OS-level crash/error dialogs that can freeze scanning indefinitely.
    // SAFETY: 定義済みフラグのみを渡し、ポインタや借用は渡さない。
    unsafe {
        use windows::Win32::System::Diagnostics::Debug::{
            SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX,
        };
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }

    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: plugin_scanner <VST3_PATH>");
        std::process::exit(1);
    }

    let path_str = &args[1];
    let path = PathBuf::from(path_str);

    if !path.exists() {
        print_json_and_exit(failed(
            path_str,
            "load_failed",
            "File not found".to_string(),
        ));
    }

    // SAFETY: ここからはVST3 ABI準拠のDLLを信頼する境界であり、export・vtable・
    // 文字列終端の契約を前提とする。DLLはfactory解放まで保持し単一threadで使う。
    // 悪意ある/非準拠DLLの安全性は保証できず、scanner分離はクラッシュの影響範囲だけを制限する。
    let result = unsafe { load_plugin_info(&path) };

    print_json_and_exit(result);
}

fn print_json_and_exit(result: ScanReport) -> ! {
    let json = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
    println!("{}", json);
    // エフェクト0件は走査完了であり、クラッシュではない。ホストが黒名簿へ入れないよう 0 で終える。
    let completed = result.success || result.error.as_deref() == Some(NO_EFFECT_ERROR);
    std::process::exit(if completed { 0 } else { 1 });
}

struct FactoryRelease(*mut c_void);

impl Drop for FactoryRelease {
    fn drop(&mut self) {
        if self.0.is_null() {
            return;
        }
        // SAFETY: GetPluginFactory が返した参照を、DLL を捨てる前に1回解放する。
        unsafe {
            let vtbl = get_vtbl::<IPluginFactoryVtbl>(self.0);
            (vtbl.base.release)(self.0);
        }
    }
}

unsafe fn load_plugin_info(path: &PathBuf) -> ScanReport {
    let path_str = path.to_string_lossy().to_string();
    let lib = match Library::new(path) {
        Ok(library) => library,
        Err(error) => {
            return failed(
                &path_str,
                "load_failed",
                format!("Failed to load library: {error}"),
            )
        }
    };
    let factory_proc = match lib.get::<GetPluginFactory>(b"GetPluginFactory") {
        Ok(symbol) => symbol,
        Err(error) => {
            return failed(
                &path_str,
                "no_factory",
                format!("GetPluginFactory not found: {error}"),
            )
        }
    };
    let factory_ptr = factory_proc();
    if factory_ptr.is_null() {
        return failed(
            &path_str,
            "no_factory",
            "GetPluginFactory returned null".to_string(),
        );
    }
    let _release = FactoryRelease(factory_ptr);
    let factory_vtbl = get_vtbl::<IPluginFactoryVtbl>(factory_ptr);
    let mut info: PFactoryInfo = std::mem::zeroed();
    let factory_vendor = if (factory_vtbl.get_factory_info)(factory_ptr, &mut info) == 0 {
        decode_fixed_c_string(&info.vendor)
    } else {
        None
    };
    let classes = match list_effect_classes(factory_ptr) {
        Ok(classes) => classes,
        Err(error) => return failed(&path_str, "unknown", error.to_string()),
    };
    if classes.is_empty() {
        return ScanReport {
            format_version: SCAN_FORMAT_VERSION,
            path: path_str,
            success: false,
            error: Some(NO_EFFECT_ERROR.to_string()),
            error_kind: None,
            factory_vendor,
            classes: Vec::new(),
        };
    }
    ScanReport {
        format_version: SCAN_FORMAT_VERSION,
        path: path_str,
        success: true,
        error: None,
        error_kind: None,
        factory_vendor,
        classes: classes.into_iter().map(|class| class.entry).collect(),
    }
}
