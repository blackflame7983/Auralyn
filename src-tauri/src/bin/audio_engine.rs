// Hide console window on Windows release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use vst_host_lib::audio_engine::core::Engine;

fn perf_tweaks_enabled() -> bool {
    use std::sync::OnceLock;

    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        let Some(v) = std::env::var_os("AURALYN_DISABLE_PERF_TWEAKS") else {
            return true;
        };

        let v = v.to_string_lossy().to_ascii_lowercase();
        !(v == "1" || v == "true" || v == "yes" || v == "on")
    })
}

fn env_flag(name: &str) -> bool {
    let Some(v) = std::env::var_os(name) else {
        return false;
    };
    let v = v.to_string_lossy().to_ascii_lowercase();
    v == "1" || v == "true" || v == "yes" || v == "on"
}

fn affinity_mask_from_env() -> Option<usize> {
    let raw = std::env::var("AURALYN_AFFINITY_MASK").ok()?;
    let parsed = if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        usize::from_str_radix(hex, 16).ok()
    } else {
        raw.parse::<usize>().ok()
    }?;
    if parsed == 0 {
        None
    } else {
        Some(parsed)
    }
}

fn main() {
    // Initialize logger FIRST so all subsequent code can use log:: macros.
    // Target stderr so JSON on stdout (IPC) is not corrupted.
    env_logger::Builder::new()
        .filter_level(log::LevelFilter::Info)
        .target(env_logger::Target::Stderr)
        .init();

    // Prevent OS-level crash/error dialogs that can freeze a real-time audio app.
    // (e.g. "DLL load failed" message boxes, GP fault error boxes)
    unsafe {
        use windows::Win32::System::Diagnostics::Debug::{
            SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX,
        };
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    }

    // [CRITICAL] Initialize COM as STA (Single-Threaded Apartment) immediately.
    // VSTGUI on Windows requires STA for proper GDI+/Drag-n-Drop functionality.
    // Must be done before ANY other crate (like winit/cpal) implicitly initializes COM.
    unsafe {
        use windows::Win32::System::Ole::OleInitialize;
        // OleInitialize calls CoInitializeEx(NULL, COINIT_APARTMENTTHREADED) internally.
        // It enables Drag & Drop, Clipboard, which VSTGUI needs.
        let res = OleInitialize(None);
        if res.is_ok() {
            log::info!("[AudioEngine] OleInitialize (STA) Success");
            // Note: Keep OleUninitialize for cleanup if efficient, or rely on process exit.
        } else {
            // S_FALSE means already initialized. RPC_E_CHANGED_MODE means wrong thread model.
            log::warn!("[AudioEngine] OleInitialize failed: {:?} (If -2147417850, threading model mismatch)", res);
        }
    }

    // Build/Path sanity (ユーザー環境で「古い audio_engine.exe を参照している」事故が多いので可視化)
    if let Ok(exe) = std::env::current_exe() {
        if let Ok(meta) = std::fs::metadata(&exe) {
            if let Ok(modified) = meta.modified() {
                log::info!("[AudioEngine] exe={:?} modified={:?}", exe, modified);
            } else {
                log::info!("[AudioEngine] exe={:?} modified=<unknown>", exe);
            }
        } else {
            log::info!("[AudioEngine] exe={:?} metadata=<unavailable>", exe);
        }
    }

    // Setup Panic Hook
    std::panic::set_hook(Box::new(|info| {
        eprintln!("CRITICAL PANIC: {:?}", info);
        if let Some(s) = info.payload().downcast_ref::<&str>() {
            eprintln!("Panic payload: {}", s);
        }
    }));

    // Initialize COM strictly as STA for VST3 GUI support
    unsafe {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
        use windows::Win32::System::SystemInformation::{GetSystemInfo, SYSTEM_INFO};
        use windows::Win32::System::Threading::{
            GetCurrentProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessAffinityMask,
            SetProcessInformation, SetProcessWorkingSetSize, ABOVE_NORMAL_PRIORITY_CLASS,
            HIGH_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_STATE, REALTIME_PRIORITY_CLASS,
        };
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };

        // 0. Force Per-Monitor v2 DPI Awareness (Modern approach for VSTGUI/DirectComposition)
        // PROCESS_SYSTEM_DPI_AWARE causes text clipping issues with DComp-based plugins like OTT.
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        // 0.5. Initialize GDI+ (CRITICAL for older plugins like OTT)
        // Many plugins rely on GDI+ for rendering but don't initialize it themselves.
        use windows::Win32::Graphics::GdiPlus::{
            GdiplusStartup, GdiplusStartupInput, GdiplusStartupOutput,
        };
        let mut token: usize = 0;
        let input = GdiplusStartupInput {
            GdiplusVersion: 1,
            DebugEventCallback: 0,
            SuppressBackgroundThread: windows::Win32::Foundation::FALSE,
            SuppressExternalCodecs: windows::Win32::Foundation::FALSE,
        };
        let mut output = GdiplusStartupOutput::default();
        let status = GdiplusStartup(&mut token, &input, &mut output);
        if status == windows::Win32::Graphics::GdiPlus::Ok {
            log::info!("[AudioEngine] GdiplusStartup Success (Token={})", token);
        } else {
            log::error!("[AudioEngine] GdiplusStartup Failed: {:?}", status);
        }

        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let current_process = GetCurrentProcess();

        let tweaks_enabled = perf_tweaks_enabled();
        if !tweaks_enabled {
            log::info!("[AudioEngine] Perf tweaks disabled via AURALYN_DISABLE_PERF_TWEAKS");
        }

        if tweaks_enabled {
            // 1. Disable Power Throttling (EcoQoS) AND Timer Resolution Throttling
            // RESEARCH: "PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION" (0x4) is critical on Win11
            let mut power_throttling = PROCESS_POWER_THROTTLING_STATE {
                Version: 1,
                ControlMask: 1 | 4, // EXECUTION_SPEED (1) | IGNORE_TIMER_RESOLUTION (4)
                StateMask: 0,       // 0 = Disable Throttling for both
            };

            let ret = SetProcessInformation(
                current_process,
                ProcessPowerThrottling,
                &mut power_throttling as *mut _ as *const std::ffi::c_void,
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            );

            if ret.is_err() {
                log::warn!(
                    "Failed to disable Power Throttling (EcoQoS + Timer). Cause: {:?}",
                    ret
                );
            } else {
                log::info!("Power Throttling (EcoQoS + Timer) disabled successfully.");
            }

            // 2. CPU Affinity: opt-in only to avoid topology-dependent regressions.
            // Set explicit mask with AURALYN_AFFINITY_MASK (e.g. 0xff), or
            // enable legacy first-half pinning with AURALYN_ENABLE_AFFINITY_PINNING=1.
            let mut requested_affinity_mask = affinity_mask_from_env();
            if requested_affinity_mask.is_none() && env_flag("AURALYN_ENABLE_AFFINITY_PINNING") {
                let mut sys_info = SYSTEM_INFO::default();
                GetSystemInfo(&mut sys_info);
                let num_cpus = sys_info.dwNumberOfProcessors as usize;
                if num_cpus > 1 {
                    requested_affinity_mask = Some(if num_cpus >= 64 {
                        usize::MAX
                    } else {
                        (1usize << (num_cpus / 2)) - 1
                    });
                }
            }

            if let Some(mask) = requested_affinity_mask {
                if let Err(e) = SetProcessAffinityMask(current_process, mask) {
                    log::warn!("Failed to set Affinity Mask: {:?}", e);
                } else {
                    log::info!("Affinity Mask set to: {:#x}", mask);
                }
            } else {
                log::debug!("Affinity pinning skipped (default).");
            }

            // 3. Memory Locking: Reserve Working Set to prevent Paging
            // 64MB min, 256MB max (Just a heuristic boost)
            let min_size = 64 * 1024 * 1024;
            let max_size = 256 * 1024 * 1024;
            if let Err(e) = SetProcessWorkingSetSize(current_process, min_size, max_size) {
                log::warn!("Failed to set Working Set Size: {:?}", e);
            } else {
                log::info!("Working Set Size reserved (Min: 64MB)");
            }

            // 4. Boost Process Priority with safer defaults.
            // Default: HIGH -> ABOVE_NORMAL
            // Opt-in: REALTIME first via AURALYN_ENABLE_REALTIME_PRIORITY=1
            let allow_realtime = env_flag("AURALYN_ENABLE_REALTIME_PRIORITY");
            let mut priority_set = if allow_realtime {
                if SetPriorityClass(current_process, REALTIME_PRIORITY_CLASS).is_ok() {
                    log::info!("Process priority set to REALTIME_PRIORITY_CLASS (opt-in).");
                    true
                } else {
                    false
                }
            } else {
                false
            };

            if !priority_set {
                if SetPriorityClass(current_process, HIGH_PRIORITY_CLASS).is_ok() {
                    log::info!("Process priority set to HIGH_PRIORITY_CLASS.");
                    priority_set = true;
                } else if SetPriorityClass(current_process, ABOVE_NORMAL_PRIORITY_CLASS).is_ok() {
                    log::info!("Process priority set to ABOVE_NORMAL_PRIORITY_CLASS.");
                    priority_set = true;
                }
            }

            if !priority_set {
                log::warn!("Failed to set process priority. Running at Normal.");
            }

            // Force 1ms Timer Resolution (Standard for Audio Apps on Windows)
            // If we can't link statically, we use dynamic load. But let's try dynamic first to avoid build hell.
            if let Ok(lib) = libloading::Library::new("winmm.dll") {
                type TimeBeginPeriod = unsafe extern "system" fn(u32) -> u32;
                if let Ok(func) = lib.get::<TimeBeginPeriod>(b"timeBeginPeriod") {
                    let _ = func(1);
                    log::info!("Timer resolution set to 1ms via winmm.dll");
                }
            }
        }
    }

    // (Logger already initialized at the top of main())

    // Check for --scan flag for OOP device enumeration
    let args: Vec<String> = std::env::args().collect();
    if args.contains(&"--scan".to_string()) {
        scan_devices();
        return;
    }

    // Normal startup
    let engine = Engine::new();
    engine.run_loop();
}

// Function effectively similar to asio_diag but integrated
fn scan_devices() {
    use cpal::traits::{DeviceTrait, HostTrait};
    use serde::Serialize;

    #[derive(Serialize)]
    struct DeviceInfo {
        name: String,
        host: String,
        is_input: bool,
        buffer_size_range: Option<(u32, u32)>,
        channels: u16,
        is_default: bool,
    }

    let mut devices = Vec::new();
    let hosts = cpal::available_hosts();

    // Helper to format supported rates
    let get_rates_str = |d: &cpal::Device, is_in: bool| -> String {
        let targets = [44100, 48000, 88200, 96000, 192000];
        let mut found = Vec::new();
        let mut ranges: Vec<cpal::SupportedStreamConfigRange> = Vec::new();
        if is_in {
            if let Ok(iter) = d.supported_input_configs() {
                ranges.extend(iter);
            }
        } else {
            if let Ok(iter) = d.supported_output_configs() {
                ranges.extend(iter);
            }
        }

        for &r in &targets {
            if ranges
                .iter()
                .any(|c| c.min_sample_rate() <= r && c.max_sample_rate() >= r)
            {
                found.push(r);
            }
        }

        if found.is_empty() {
            String::new()
        } else {
            let s = found
                .iter()
                .map(|r| format!("{}", r / 1000))
                .collect::<Vec<_>>()
                .join("/");
            format!(" [{}kHz]", s)
        }
    };

    // New Helper: Get Buffer Size Range
    let get_buffer_range = |d: &cpal::Device, is_in: bool| -> Option<(u32, u32)> {
        let mut min_buf = u32::MAX;
        let mut max_buf = 0;
        let mut found = false;

        let mut ranges: Vec<cpal::SupportedStreamConfigRange> = Vec::new();
        if is_in {
            if let Ok(iter) = d.supported_input_configs() {
                ranges.extend(iter);
            }
        } else {
            if let Ok(iter) = d.supported_output_configs() {
                ranges.extend(iter);
            }
        }

        for r in ranges {
            match r.buffer_size() {
                cpal::SupportedBufferSize::Range { min, max } => {
                    if *min < min_buf {
                        min_buf = *min;
                    }
                    if *max > max_buf {
                        max_buf = *max;
                    }
                    found = true;
                }
                _ => {}
            }
        }

        if found && min_buf <= max_buf {
            Some((min_buf, max_buf))
        } else {
            None
        }
    };

    // New Helper: Get Max Channels
    let get_max_channels = |d: &cpal::Device, is_in: bool| -> u16 {
        let mut max_channels = 0;
        let mut ranges: Vec<cpal::SupportedStreamConfigRange> = Vec::new();
        if is_in {
            if let Ok(iter) = d.supported_input_configs() {
                ranges.extend(iter);
            }
        } else {
            if let Ok(iter) = d.supported_output_configs() {
                ranges.extend(iter);
            }
        }

        for r in ranges {
            if r.channels() > max_channels {
                max_channels = r.channels();
            }
        }
        max_channels
    };

    for host_id in hosts {
        if let Ok(host) = cpal::host_from_id(host_id) {
            let host_name = match host_id {
                cpal::HostId::Asio => "ASIO",
                cpal::HostId::Wasapi => "Wasapi",
            }
            .to_string();

            // Get Default Devices
            #[allow(deprecated)]
            let default_in_name = host.default_input_device().and_then(|d| d.name().ok());
            #[allow(deprecated)]
            let default_out_name = host.default_output_device().and_then(|d| d.name().ok());

            // Inputs
            if let Ok(inputs) = host.input_devices() {
                log::debug!("[Scanner] Checking Inputs for host: {}", host_name);

                let mut raw_items: Vec<(String, String, Option<(u32, u32)>, u16, bool)> =
                    Vec::new();
                for d in inputs {
                    #[allow(deprecated)]
                    if let Ok(n) = d.name() {
                        let rates = if host_name == "ASIO" {
                            String::new()
                        } else {
                            get_rates_str(&d, true)
                        };
                        let buf_range = get_buffer_range(&d, true);
                        let channels = get_max_channels(&d, true);
                        let is_def = default_in_name.as_ref().map(|dn| dn == &n).unwrap_or(false);
                        raw_items.push((n, rates, buf_range, channels, is_def));
                    }
                }

                let mut name_counts = std::collections::HashMap::new();
                for (n, _, _, _, _) in &raw_items {
                    *name_counts.entry(n.clone()).or_insert(0) += 1;
                }

                let mut current_counts = std::collections::HashMap::new();
                for (n, rates, buf_range, channels, is_def) in raw_items {
                    let total = *name_counts.get(&n).unwrap_or(&0);
                    let final_name = if total > 1 {
                        let idx = current_counts.entry(n.clone()).or_insert(0);
                        *idx += 1;
                        format!("{} ({}){}", n, idx, rates)
                    } else {
                        format!("{}{}", n, rates)
                    };
                    log::debug!(
                        "[Scanner] Found Input: {} (Default: {})",
                        final_name, is_def
                    );
                    devices.push(DeviceInfo {
                        name: final_name,
                        host: host_name.clone(),
                        is_input: true,
                        buffer_size_range: buf_range,
                        channels,
                        is_default: is_def,
                    });
                }
            } else {
                log::warn!(
                    "[Scanner] Failed to get input_devices stream for {}",
                    host_name
                );
            }

            // Outputs
            if let Ok(outputs) = host.output_devices() {
                log::debug!("[Scanner] Checking Outputs for host: {}", host_name);

                let mut raw_items: Vec<(String, String, Option<(u32, u32)>, u16, bool)> =
                    Vec::new();
                for d in outputs {
                    #[allow(deprecated)]
                    if let Ok(n) = d.name() {
                        let rates = if host_name == "ASIO" {
                            String::new()
                        } else {
                            get_rates_str(&d, false)
                        };
                        let buf_range = get_buffer_range(&d, false);
                        let channels = get_max_channels(&d, false);
                        let is_def = default_out_name
                            .as_ref()
                            .map(|dn| dn == &n)
                            .unwrap_or(false);
                        raw_items.push((n, rates, buf_range, channels, is_def));
                    }
                }

                let mut name_counts = std::collections::HashMap::new();
                for (n, _, _, _, _) in &raw_items {
                    *name_counts.entry(n.clone()).or_insert(0) += 1;
                }

                let mut current_counts = std::collections::HashMap::new();
                for (n, rates, buf_range, channels, is_def) in raw_items {
                    let total = *name_counts.get(&n).unwrap_or(&0);
                    let final_name = if total > 1 {
                        let idx = current_counts.entry(n.clone()).or_insert(0);
                        *idx += 1;
                        format!("{} ({}){}", n, idx, rates)
                    } else {
                        format!("{}{}", n, rates)
                    };
                    log::debug!(
                        "[Scanner] Found Output: {} (Default: {})",
                        final_name, is_def
                    );
                    devices.push(DeviceInfo {
                        name: final_name,
                        host: host_name.clone(),
                        is_input: false,
                        buffer_size_range: buf_range,
                        channels,
                        is_default: is_def,
                    });
                }
            } else {
                log::warn!(
                    "[Scanner] Failed to get output_devices stream for {}",
                    host_name
                );
            }
        }
    }

    let json = serde_json::to_string(&devices).unwrap_or("[]".to_string());
    println!("{}", json);
}
