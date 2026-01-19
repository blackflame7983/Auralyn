use libloading::Library;
use serde::Serialize;
use std::env;
use std::ffi::{c_void, CStr};
use std::path::PathBuf;
use vst_host_lib::vst_host::c_api::{IPluginFactoryVtbl, PFactoryInfo};

// We define the function pointer type locally since it's not in c_api.rs
type GetPluginFactory = unsafe extern "C" fn() -> *mut c_void;

unsafe fn get_vtbl<T>(ptr: *mut c_void) -> &'static T {
    &**(ptr as *mut *mut T)
}

#[derive(Serialize)]
struct ScanResult {
    path: String,
    name: String,
    vendor: String,
    version: String,
    success: bool,
    error: Option<String>,
}

fn main() {
    // Prevent OS-level crash/error dialogs that can freeze scanning indefinitely.
    unsafe {
        use windows::Win32::System::Diagnostics::Debug::{
            SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOOPENFILEERRORBOX, SEM_NOGPFAULTERRORBOX,
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
        print_json_and_exit(ScanResult {
            path: path_str.clone(),
            name: "".to_string(),
            vendor: "".to_string(),
            version: "".to_string(),
            success: false,
            error: Some("File not found".to_string()),
        });
    }

    // Attempt to load
    let result = unsafe { load_plugin_info(&path) };
    
    print_json_and_exit(result);
}

fn print_json_and_exit(result: ScanResult) -> ! {
    let json = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
    println!("{}", json);
    if result.success {
        std::process::exit(0);
    } else {
        std::process::exit(1);
    }
}

unsafe fn load_plugin_info(path: &PathBuf) -> ScanResult {
    let path_str = path.to_string_lossy().to_string();
    
    // Attempt library load
    let lib = match Library::new(path) {
        Ok(l) => l,
        Err(e) => return ScanResult {
            path: path_str,
            name: "".to_string(),
            vendor: "Unknown".to_string(),
            version: "".to_string(),
            success: false,
            error: Some(format!("Failed to load library: {}", e)),
        },
    };

    // Attempt GetPluginFactory
    let factory_proc = match lib.get::<GetPluginFactory>(b"GetPluginFactory") {
        Ok(p) => p,
        Err(e) => return ScanResult {
            path: path_str,
            name: "".to_string(),
            vendor: "Unknown".to_string(),
            version: "".to_string(),
            success: false,
            error: Some(format!("GetPluginFactory not found: {}", e)),
        },
    };

    let factory_ptr = factory_proc();
    if factory_ptr.is_null() {
        return ScanResult {
            path: path_str,
            name: "".to_string(),
            vendor: "Unknown".to_string(),
            version: "".to_string(),
            success: false,
            error: Some("GetPluginFactory returned null".to_string()),
        };
    }

    let factory_vtbl = get_vtbl::<IPluginFactoryVtbl>(factory_ptr);
    let mut info: PFactoryInfo = std::mem::zeroed();
    let mut vendor = "Unknown".to_string();

    if (factory_vtbl.get_factory_info)(factory_ptr, &mut info) == 0 {
        if let Ok(v) = CStr::from_ptr(info.vendor.as_ptr()).to_str() {
            if !v.is_empty() {
                vendor = v.to_string();
            }
        }
    }

    // Release factory
    (factory_vtbl.base.release)(factory_ptr);

    // Name is usually derived from filename for VST3 (factory classes have names but often multiple)
    // For scanner MVP, we use filename as name, similar to existing implementation
    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown".to_string());

    ScanResult {
        path: path_str,
        name,
        vendor,
        version: "0.0.0".to_string(), // TODO: Extract version if possible
        success: true,
        error: None,
    }
}
