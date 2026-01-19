use crate::vst_host::blacklist::Blacklist;
use serde::{Deserialize, Serialize};
use std::env;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use walkdir::WalkDir;

#[cfg(windows)]
mod win_job {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    impl Job {
        pub fn new_kill_on_drop() -> Option<Self> {
            unsafe {
                let job = CreateJobObjectW(None, None).ok()?;

                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                let _ = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .ok()?;

                Some(Self(job))
            }
        }

        pub fn assign(&self, process: HANDLE) -> bool {
            unsafe { AssignProcessToJobObject(self.0, process).is_ok() }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VstPlugin {
    pub name: String,
    pub path: String,
    pub vendor: String,
    pub version: String,
}

#[derive(Deserialize)]
struct ScanResult {
    path: String,
    name: String,
    vendor: String,
    version: String,
    success: bool,
    error: Option<String>,
}

fn get_scanner_path() -> Option<PathBuf> {
    // 1. Try side-by-side with executable
    if let Ok(exe_path) = env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let direct = parent.join("plugin_scanner.exe");
            if direct.exists() {
                return Some(direct);
            }

            let direct_bin = parent.join("bin").join("plugin_scanner.exe");
            if direct_bin.exists() {
                return Some(direct_bin);
            }

            // Tauri externalBin naming often looks like: plugin_scanner-<target-triple>.exe
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if !p.is_file() {
                        continue;
                    }
                    let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    let lower = name.to_ascii_lowercase();
                    if lower.starts_with("plugin_scanner-") && lower.ends_with(".exe") {
                        return Some(p);
                    }
                }
            }

            if let Ok(entries) = std::fs::read_dir(parent.join("bin")) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if !p.is_file() {
                        continue;
                    }
                    let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    let lower = name.to_ascii_lowercase();
                    if lower.starts_with("plugin_scanner-") && lower.ends_with(".exe") {
                        return Some(p);
                    }
                }
            }
        }
    }

    // 2. Try CWD (development fallback)
    if let Ok(cwd) = env::current_dir() {
        // Look in target/debug/
        let debug = cwd.join("target").join("debug").join("plugin_scanner.exe");
        if debug.exists() {
            return Some(debug);
        }

        let cwd_bin = cwd.join("bin").join("plugin_scanner.exe");
        if cwd_bin.exists() {
            return Some(cwd_bin);
        }
    }

    None
}

pub fn scan_system_vst3(config_dir: &PathBuf) -> Vec<VstPlugin> {
    let mut plugins = Vec::new();
    let mut blacklist = Blacklist::new(config_dir);

    let scanner_path = match get_scanner_path() {
        Some(p) => p,
        None => {
            log::error!("Could not find plugin_scanner.exe");
            return Vec::new();
        }
    };
    log::info!("Using scanner binary at: {:?}", scanner_path);

    // Common VST3 paths on Windows
    let paths = vec![
        r"C:\Program Files\Common Files\VST3",
        r"C:\Program Files\Steinberg\VST3",
    ];

    for path_str in paths {
        let path = Path::new(path_str);
        if path.exists() {
            let mut walker = WalkDir::new(path).into_iter();
            while let Some(entry_res) = walker.next() {
                let entry = match entry_res {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                let entry_path = entry.path();
                // Check for .vst3 extension
                if entry_path.extension().map_or(false, |ext| ext == "vst3") {
                    // CRITICAL FIX: If it's a bundle (directory), do NOT recurse into it.
                    // This prevents finding the inner binary as a separate entry later.
                    if entry_path.is_dir() {
                        walker.skip_current_dir();
                    }

                    let mut final_path = entry_path.to_path_buf();
                    let name = entry_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "Unknown Plugin".to_string());

                    // If it's a directory (Bundle), look for the binary
                    if entry_path.is_dir() {
                        let binary_path = entry_path
                            .join("Contents/x86_64-win")
                            .join(format!("{}.vst3", name));
                        if binary_path.exists() {
                            final_path = binary_path;
                        } else {
                            // Fallback: search safely inside architecture dir
                            // Note: we can't use the main walker for this as we skipped the dir,
                            // so we do a localized search here.
                            let arch_dir = entry_path.join("Contents/x86_64-win");
                            if arch_dir.exists() {
                                if let Ok(mut entries) = std::fs::read_dir(arch_dir) {
                                    if let Some(Ok(inner)) = entries.find(|e| {
                                        e.as_ref().ok().map_or(false, |dir_entry| {
                                            dir_entry
                                                .path()
                                                .extension()
                                                .map_or(false, |ext| ext == "vst3")
                                        })
                                    }) {
                                        final_path = inner.path();
                                    }
                                }
                            }
                        }
                    }

                    // Only process if it points to a file now
                    if final_path.is_file() {
                        let path_string = final_path.to_string_lossy().to_string();

                        if blacklist.contains(&path_string) {
                            log::warn!("Skipping blacklisted plugin: {}", path_string);
                            continue;
                        }

                        log::info!("Scanning: {:?}", final_path);

                        // Per-plugin timeout (hang protection) - Increased to 30s
                        let timeout = Duration::from_secs(30);
                        let output = (|| {
                            let mut command = Command::new(&scanner_path);
                            command.arg(&path_string);

                            #[cfg(windows)]
                            {
                                use std::os::windows::process::CommandExt;
                                const CREATE_NO_WINDOW: u32 = 0x08000000;
                                command.creation_flags(CREATE_NO_WINDOW);
                            }

                            let mut child = command
                                .stdin(Stdio::null())
                                .stdout(Stdio::piped())
                                .stderr(Stdio::piped())
                                .spawn()?;

                            // Best-effort: kill process tree on timeout (Windows)
                            #[cfg(windows)]
                            let _job = {
                                use std::os::windows::io::AsRawHandle;
                                use windows::Win32::Foundation::HANDLE;

                                let job = win_job::Job::new_kill_on_drop();
                                if let Some(ref job) = job {
                                    let handle = HANDLE(child.as_raw_handle());
                                    let _ = job.assign(handle);
                                }
                                job
                            };

                            let start = Instant::now();
                            loop {
                                match child.try_wait() {
                                    Ok(Some(_status)) => {
                                        return child.wait_with_output();
                                    }
                                    Ok(None) => {
                                        if start.elapsed() >= timeout {
                                            let _ = child.kill();
                                            let _ = child.wait();
                                            return Err(io::Error::new(
                                                io::ErrorKind::TimedOut,
                                                "plugin_scanner timeout",
                                            ));
                                        }
                                        std::thread::sleep(Duration::from_millis(10));
                                    }
                                    Err(e) => return Err(e),
                                }
                            }
                        })();

                        match output {
                            Ok(out) => {
                                if out.status.success() {
                                    let stdout = String::from_utf8_lossy(&out.stdout);
                                    match serde_json::from_str::<ScanResult>(&stdout) {
                                        Ok(res) => {
                                            if res.success {
                                                plugins.push(VstPlugin {
                                                    name: res.name,
                                                    path: res.path,
                                                    vendor: res.vendor,
                                                    version: res.version,
                                                });
                                            } else {
                                                log::warn!(
                                                    "Plugin scan failed (internal): {:?} - {:?}",
                                                    final_path,
                                                    res.error
                                                );
                                            }
                                        }
                                        Err(e) => {
                                            log::error!(
                                                "Failed to parse scanner output: {} - Output: {}",
                                                e,
                                                stdout
                                            );
                                            // Bad output -> likely crash or garbage -> Blacklist (Safe Mode!)
                                            blacklist.add(&path_string);
                                        }
                                    }
                                } else {
                                    log::warn!(
                                        "Plugin scanner crashed or failed: {:?} (Code: {:?})",
                                        final_path,
                                        out.status.code()
                                    );
                                    // Crash -> Blacklist
                                    blacklist.add(&path_string);
                                }
                            }
                            Err(e) => {
                                if e.kind() == std::io::ErrorKind::TimedOut {
                                    log::warn!(
                                        "Plugin scanner timed out: {:?} (>{:?})",
                                        final_path,
                                        timeout
                                    );
                                    blacklist.add(&path_string);
                                } else {
                                    log::error!("Failed to spawn scanner: {}", e);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    plugins
}
