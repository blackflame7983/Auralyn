use crate::child_process as process;
use crate::vst_host::blacklist::Blacklist;
use crate::vst_host::class_listing::{ClassEntry, ScanReport};
use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use walkdir::WalkDir;

/// スキャン結果の1クラス。`version` が無いときは取得できていない。
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VstPlugin {
    pub name: String,
    pub path: String,
    /// 空文字はメーカー不明。固定の "Unknown" は入れない。
    pub vendor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub_categories: Option<String>,
    /// "class" はクラス名、"file" はファイル名への退避。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_source: Option<String>,
}

#[derive(Deserialize)]
struct LegacyScan {
    path: String,
    name: String,
    vendor: String,
    version: String,
    success: bool,
    error: Option<String>,
}

pub(crate) struct ParsedScan {
    pub plugins: Vec<VstPlugin>,
    pub success: bool,
    pub error: Option<String>,
}

fn file_label(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.is_empty())
        .unwrap_or_else(|| path.to_string())
}

fn known_text(value: String) -> String {
    if value.is_empty() || value == "Unknown" {
        String::new()
    } else {
        value
    }
}

/// formatVersion 2 をクラスごとに展開し、版フィールドの無い旧出力は1件として読む。
pub(crate) fn plugins_from_scanner_output(stdout: &str) -> Result<ParsedScan, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(stdout)?;
    if value
        .get("formatVersion")
        .and_then(|version| version.as_u64())
        == Some(2)
    {
        let report: ScanReport = serde_json::from_value(value)?;
        return Ok(plugins_from_report(report));
    }
    let legacy: LegacyScan = serde_json::from_value(value)?;
    if !legacy.success {
        return Ok(ParsedScan {
            plugins: Vec::new(),
            success: false,
            error: legacy.error,
        });
    }
    let version = if legacy.version.is_empty() || legacy.version == "0.0.0" {
        None
    } else {
        Some(legacy.version)
    };
    Ok(ParsedScan {
        plugins: vec![VstPlugin {
            name: if legacy.name.is_empty() {
                file_label(&legacy.path)
            } else {
                legacy.name
            },
            path: legacy.path,
            vendor: known_text(legacy.vendor),
            version,
            class_id: None,
            sub_categories: None,
            name_source: Some("file".to_string()),
        }],
        success: true,
        error: None,
    })
}

fn plugins_from_report(report: ScanReport) -> ParsedScan {
    if !report.success {
        return ParsedScan {
            plugins: Vec::new(),
            success: false,
            error: report.error,
        };
    }
    let plugins = report
        .classes
        .into_iter()
        .map(|class| plugin_from_class(&report.path, report.factory_vendor.clone(), class))
        .collect();
    ParsedScan {
        plugins,
        success: true,
        error: None,
    }
}

fn plugin_from_class(path: &str, factory_vendor: Option<String>, class: ClassEntry) -> VstPlugin {
    let (name, name_source) = match class.name {
        Some(name) => (name, "class"),
        None => (file_label(path), "file"),
    };
    VstPlugin {
        name,
        path: path.to_string(),
        vendor: class
            .vendor
            .filter(|vendor| !vendor.is_empty())
            .or(factory_vendor.filter(|vendor| !vendor.is_empty()))
            .unwrap_or_default(),
        version: class.version.filter(|version| !version.is_empty()),
        class_id: Some(class.class_id),
        sub_categories: class.sub_categories,
        name_source: Some(name_source.to_string()),
    }
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

    #[cfg(debug_assertions)]
    {
        // Development fallbacks should not be probed in release builds.
        if let Ok(cwd) = env::current_dir() {
            let debug = cwd.join("target").join("debug").join("plugin_scanner.exe");
            if debug.exists() {
                return Some(debug);
            }

            let cwd_bin = cwd.join("bin").join("plugin_scanner.exe");
            if cwd_bin.exists() {
                return Some(cwd_bin);
            }
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
                if entry_path.extension().is_some_and(|ext| ext == "vst3") {
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
                                        e.as_ref().ok().is_some_and(|dir_entry| {
                                            dir_entry
                                                .path()
                                                .extension()
                                                .is_some_and(|ext| ext == "vst3")
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
                        let output =
                            process::run(Command::new(&scanner_path).arg(&path_string), timeout);

                        match output {
                            Ok(out) => {
                                if out.status.success() {
                                    let stdout = String::from_utf8_lossy(&out.stdout);
                                    match plugins_from_scanner_output(&stdout) {
                                        Ok(parsed) => {
                                            if parsed.success {
                                                plugins.extend(parsed.plugins);
                                            } else {
                                                log::warn!(
                                                    "Plugin scan failed (internal): {:?} - {:?}",
                                                    final_path,
                                                    parsed.error
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_version_2_expands_one_class_per_plugin_and_keeps_unknowns_empty() {
        let parsed = plugins_from_scanner_output(
            r#"{"formatVersion":2,"path":"C:/Plugins/Multi.vst3","success":true,"factoryVendor":"Factory","classes":[
                {"classId":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"Delay","vendor":"Class","version":"2","subCategories":"Fx|Delay","infoSource":"classInfo2","kindKnown":true},
                {"classId":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","infoSource":"classInfo","kindKnown":false}
            ]}"#,
        )
        .unwrap();
        assert!(parsed.success);
        assert_eq!(parsed.plugins.len(), 2);
        assert_eq!(parsed.plugins[0].name, "Delay");
        assert_eq!(parsed.plugins[0].name_source.as_deref(), Some("class"));
        assert_eq!(parsed.plugins[0].vendor, "Class");
        assert_eq!(parsed.plugins[0].version.as_deref(), Some("2"));
        assert_eq!(
            parsed.plugins[0].class_id.as_deref(),
            Some("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        );
        assert_eq!(parsed.plugins[1].name, "Multi");
        assert_eq!(parsed.plugins[1].name_source.as_deref(), Some("file"));
        assert_eq!(parsed.plugins[1].vendor, "Factory");
        assert!(parsed.plugins[1].version.is_none());
    }

    #[test]
    fn legacy_scanner_output_is_one_path_without_a_class_id() {
        let parsed = plugins_from_scanner_output(
            r#"{"path":"C:/Plugins/Old.vst3","name":"Old","vendor":"Unknown","version":"0.0.0","success":true,"error":null}"#,
        )
        .unwrap();
        assert_eq!(parsed.plugins.len(), 1);
        assert!(parsed.plugins[0].class_id.is_none());
        assert!(parsed.plugins[0].version.is_none());
        assert!(parsed.plugins[0].vendor.is_empty());
        assert_eq!(parsed.plugins[0].name_source.as_deref(), Some("file"));
    }

    #[test]
    fn no_effect_report_is_not_a_plugin() {
        let parsed = plugins_from_scanner_output(
            r#"{"formatVersion":2,"path":"C:/Plugins/Inst.vst3","success":false,"error":"対応するエフェクトがありません","classes":[]}"#,
        )
        .unwrap();
        assert!(!parsed.success);
        assert!(parsed.plugins.is_empty());
    }
}
