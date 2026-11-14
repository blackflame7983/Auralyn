use crate::child_process as process;
use crate::vst_host::blacklist::Blacklist;
use crate::vst_host::catalog::{
    self, Candidate, CatalogFile, FailureKind, Outcome, ProbeEffect, ScanMode, ScanStats,
};
use crate::vst_host::class_listing::{ClassEntry, ScanReport, SCAN_FORMAT_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use walkdir::WalkDir;

pub const SCAN_BUSY: &str = "スキャン中です";
const SCAN_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_TIMEOUT: Duration = Duration::from_secs(120);

static SCAN_GATE: Mutex<catalog::ScanGate> = Mutex::new(catalog::ScanGate::new());

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

#[cfg(test)]
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
#[cfg(test)]
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

#[cfg(test)]
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

/// 子プロセスの1件分。exit 0 かつ成功でない完了はエフェクトなし。JSON が無い非0終了はクラッシュ。
pub(crate) fn classify_scanner_output(stdout: &str, exit_success: bool) -> ProbeEffect {
    let Some(line) = stdout
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with('{'))
    else {
        return if exit_success {
            failed_effect(FailureKind::InvalidOutput, Some("JSONがありません".into()))
        } else {
            failed_effect(FailureKind::Crashed, None)
        };
    };
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return failed_effect(FailureKind::InvalidOutput, Some(error.to_string()));
        }
    };
    if value.get("formatVersion").is_some() {
        let version = value.get("formatVersion").and_then(|item| item.as_u64());
        if version != Some(u64::from(SCAN_FORMAT_VERSION)) {
            return failed_effect(
                FailureKind::InvalidOutput,
                Some("formatVersion が対応範囲外です".into()),
            );
        }
        let report: ScanReport = match serde_json::from_value(value) {
            Ok(report) => report,
            Err(error) => {
                return failed_effect(FailureKind::InvalidOutput, Some(error.to_string()))
            }
        };
        return classify_report(report, exit_success);
    }
    let legacy: LegacyScan = match serde_json::from_value(value) {
        Ok(legacy) => legacy,
        Err(error) => return failed_effect(FailureKind::Unknown, Some(error.to_string())),
    };
    if legacy.success && exit_success {
        let version = if legacy.version.is_empty() || legacy.version == "0.0.0" {
            None
        } else {
            Some(legacy.version)
        };
        return ProbeEffect::Legacy {
            plugin: catalog::LegacyPlugin {
                name: if legacy.name.is_empty() {
                    file_label(&legacy.path)
                } else {
                    legacy.name
                },
                vendor: known_text(legacy.vendor),
                version,
            },
        };
    }
    failed_effect(FailureKind::Unknown, legacy.error)
}

fn classify_report(report: ScanReport, exit_success: bool) -> ProbeEffect {
    if report.success && exit_success {
        return ProbeEffect::Classes {
            classes: report.classes,
            factory_vendor: report.factory_vendor,
        };
    }
    if exit_success && !report.success && report.error_kind.is_none() {
        return ProbeEffect::NoEffects;
    }
    if let Some(kind) = report.error_kind {
        return failed_effect(FailureKind::parse(&kind), report.error);
    }
    failed_effect(FailureKind::Unknown, report.error)
}

fn failed_effect(kind: FailureKind, detail: Option<String>) -> ProbeEffect {
    ProbeEffect::Failed { kind, detail }
}

pub(crate) fn probe_command(command: &mut Command, timeout: Duration) -> ProbeEffect {
    match process::run(command, timeout) {
        Ok(output) => classify_scanner_output(
            &String::from_utf8_lossy(&output.stdout),
            output.status.success(),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
            failed_effect(FailureKind::TimedOut, Some(error.to_string()))
        }
        Err(error) => failed_effect(FailureKind::SpawnFailed, Some(error.to_string())),
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginScanFailure {
    pub path: String,
    pub name: String,
    pub kind: FailureKind,
    pub detail: Option<String>,
    pub scanned_at: String,
    pub attempts: u32,
}

/// 追加フォルダーをスキャンに使わなかった理由。スキャン全体は止めない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkippedScanRootReason {
    Missing,
    NotDirectory,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedScanRoot {
    pub path: String,
    pub reason: SkippedScanRootReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogView {
    pub plugins: Vec<VstPlugin>,
    pub failures: Vec<PluginScanFailure>,
    pub stats: ScanStats,
    pub generation: u64,
    pub recovered_from_corrupt: bool,
    pub save_error: Option<String>,
    /// 追加フォルダーのうち、今回の探索に入れなかったもの。標準の2つは含めない。
    pub skipped_roots: Vec<SkippedScanRoot>,
}

struct ScanGuard(u64);

impl Drop for ScanGuard {
    fn drop(&mut self) {
        lock_gate().finish(self.0);
    }
}

pub fn scan_system_vst3(
    config_dir: &Path,
    extra_roots: &[String],
) -> Result<Vec<VstPlugin>, String> {
    Ok(scan_plugin_catalog(config_dir, ScanMode::Incremental, extra_roots)?.plugins)
}

pub fn scan_plugin_catalog(
    config_dir: &Path,
    mode: ScanMode,
    extra_roots: &[String],
) -> Result<PluginCatalogView, String> {
    run_catalog_scan(config_dir, mode, None, SCAN_TIMEOUT, extra_roots)
}

pub fn retry_plugin_scan(
    config_dir: &Path,
    path: &str,
    extra_roots: &[String],
) -> Result<PluginCatalogView, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("再試行するファイルが指定されていません".into());
    }
    run_catalog_scan(
        config_dir,
        ScanMode::Incremental,
        Some(path),
        RETRY_TIMEOUT,
        extra_roots,
    )
}

pub fn clear_scan_exclusions(config_dir: &Path) -> Result<(), String> {
    let guard = begin_scan()?;
    let result = (|| {
        let mut prepared =
            catalog::prepare_catalog(config_dir, &catalog::utc_timestamp(), SCAN_FORMAT_VERSION)?;
        catalog::clear_failures(&mut prepared.catalog);
        catalog::save_catalog(config_dir, &prepared.catalog)?;
        Blacklist::new(&config_dir.to_path_buf()).clear();
        Ok(())
    })();
    drop(guard);
    result
}

fn run_catalog_scan(
    config_dir: &Path,
    mode: ScanMode,
    retry_path: Option<&str>,
    timeout: Duration,
    extra_roots: &[String],
) -> Result<PluginCatalogView, String> {
    let guard = begin_scan()?;
    // 不正な追加フォルダーで探索を落とさない。使えないものは除き、標準のフォルダーは残す。
    let (roots, skipped_roots) = resolve_scan_roots(extra_roots);
    let scanner = get_scanner_path().ok_or_else(|| {
        log::error!("Could not find plugin_scanner.exe");
        "スキャン用のプログラムが見つかりません".to_string()
    })?;
    log::info!("Using scanner binary at: {:?}", scanner);
    let now = catalog::utc_timestamp();
    let prepared = catalog::prepare_catalog(config_dir, &now, SCAN_FORMAT_VERSION)?;
    let mut save_error = prepared.save_error;
    let candidates = candidates_under(&roots);
    let plan = if let Some(path) = retry_path {
        let candidate = find_candidate(&candidates, path)
            .ok_or_else(|| "再試行するファイルが見つかりません".to_string())?;
        catalog::plan_retry(candidate)
    } else {
        catalog::plan_scan(
            &prepared.catalog.entries,
            &candidates,
            mode,
            SCAN_FORMAT_VERSION,
        )
    };
    let generation = guard.0;
    let reconciled = catalog::reconcile(
        prepared.catalog,
        &plan,
        |candidate| {
            log::info!("Scanning: {}", candidate.path);
            let mut command = Command::new(&scanner);
            command.arg(&candidate.path);
            probe_command(&mut command, timeout)
        },
        |file| catalog::save_catalog(config_dir, file),
        &now,
        || lock_gate().current() == generation,
        SCAN_FORMAT_VERSION,
    );
    if save_error.is_none() {
        save_error = reconciled.save_error;
    }
    log::info!(
        "VSTスキャン: 再利用 {}、スキャン {}、削除 {}",
        reconciled.stats.reused,
        reconciled.stats.scanned,
        reconciled.stats.removed
    );
    let view = view_from(
        &reconciled.catalog,
        reconciled.stats,
        generation,
        prepared.recovered_from_corrupt,
        save_error,
        skipped_roots,
    );
    drop(guard);
    Ok(view)
}

fn begin_scan() -> Result<ScanGuard, String> {
    lock_gate()
        .try_begin()
        .map(ScanGuard)
        .ok_or_else(|| SCAN_BUSY.to_string())
}

fn lock_gate() -> std::sync::MutexGuard<'static, catalog::ScanGate> {
    SCAN_GATE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

fn default_roots() -> Vec<PathBuf> {
    vec![
        PathBuf::from(r"C:\Program Files\Common Files\VST3"),
        PathBuf::from(r"C:\Program Files\Steinberg\VST3"),
    ]
}

const MAX_SCAN_ROOT_CHARS: usize = 32_767;
/// 画面は32件までにしている。IPC から多く渡されても、歩く木の数を抑える。
const MAX_EXTRA_SCAN_ROOTS: usize = 64;

/// 標準の2フォルダーに、使える追加フォルダーだけを足す。
/// 見つからない・ディレクトリーでない・不正なパスは `skipped` に残し、探索は続ける。
pub(crate) fn resolve_scan_roots(extra_roots: &[String]) -> (Vec<PathBuf>, Vec<SkippedScanRoot>) {
    let mut accepted = default_roots();
    let mut seen = HashSet::new();
    for root in &accepted {
        seen.insert(path_key(root));
    }
    let mut skipped = Vec::new();
    for (index, raw) in extra_roots.iter().enumerate() {
        let trimmed = raw.trim();
        // 相対パスは作業フォルダーで意味が変わるので使わない。
        if index >= MAX_EXTRA_SCAN_ROOTS
            || trimmed.is_empty()
            || trimmed.contains('\0')
            || trimmed.chars().count() > MAX_SCAN_ROOT_CHARS
            || !Path::new(trimmed).is_absolute()
        {
            skipped.push(SkippedScanRoot {
                path: raw.clone(),
                reason: SkippedScanRootReason::Invalid,
            });
            continue;
        }
        let path = PathBuf::from(trimmed);
        let key = path_key(&path);
        if seen.contains(&key) {
            continue;
        }
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_dir() => {
                let normalized = PathBuf::from(catalog::normalize_path(&path));
                let normalized_key = path_key(&normalized);
                if seen.insert(normalized_key) {
                    seen.insert(key);
                    accepted.push(normalized);
                }
            }
            Ok(_) => skipped.push(SkippedScanRoot {
                path: trimmed.to_string(),
                reason: SkippedScanRootReason::NotDirectory,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                skipped.push(SkippedScanRoot {
                    path: trimmed.to_string(),
                    reason: SkippedScanRootReason::Missing,
                });
            }
            Err(_) => skipped.push(SkippedScanRoot {
                path: trimmed.to_string(),
                reason: SkippedScanRootReason::Invalid,
            }),
        }
    }
    (accepted, skipped)
}

/// 存在するパスは正規化して比べ、無いパスは区切りと末尾の区切りだけをそろえる。
fn path_key(path: &Path) -> String {
    let text = if path.exists() {
        catalog::normalize_path(path)
    } else {
        path.to_string_lossy().into_owned()
    };
    text.replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

pub(crate) fn candidates_under(roots: &[PathBuf]) -> Vec<Candidate> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        if !root.exists() {
            continue;
        }
        let mut walker = WalkDir::new(root).into_iter();
        while let Some(entry_res) = walker.next() {
            let entry = match entry_res {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let entry_path = entry.path();
            if entry_path.extension().is_some_and(|ext| ext == "vst3") {
                // bundle の中へ降りると、中の binary を別プラグインとして数えてしまう。
                if entry_path.is_dir() {
                    walker.skip_current_dir();
                }
                let Some(binary) = resolve_binary(entry_path) else {
                    continue;
                };
                let Some(file_id) = catalog::file_id(&binary) else {
                    continue;
                };
                let path = catalog::normalize_path(&binary);
                if seen.insert(path.clone()) {
                    let bundle_path = entry_path
                        .is_dir()
                        .then(|| catalog::normalize_path(entry_path));
                    found.push(Candidate {
                        path,
                        bundle_path,
                        file_id,
                    });
                }
            }
        }
    }
    found
}

/// `.vst3` のファイル、またはバンドル（Contents/x86_64-win）から読み込む実体を探す。
pub fn resolve_binary(entry_path: &Path) -> Option<PathBuf> {
    if entry_path.is_file() {
        return Some(entry_path.to_path_buf());
    }
    let name = entry_path.file_stem()?.to_string_lossy();
    let expected = entry_path
        .join("Contents/x86_64-win")
        .join(format!("{name}.vst3"));
    if expected.is_file() {
        return Some(expected);
    }
    let arch_dir = entry_path.join("Contents/x86_64-win");
    let mut entries = std::fs::read_dir(arch_dir).ok()?;
    entries.find_map(|entry| {
        let path = entry.ok()?.path();
        path.extension()
            .is_some_and(|ext| ext == "vst3")
            .then_some(path)
    })
}

fn find_candidate(candidates: &[Candidate], path: &str) -> Option<Candidate> {
    let normalized = catalog::normalize_path(Path::new(path));
    candidates
        .iter()
        .find(|candidate| candidate.path == path || candidate.path == normalized)
        .cloned()
}

fn view_from(
    catalog: &CatalogFile,
    stats: ScanStats,
    generation: u64,
    recovered_from_corrupt: bool,
    save_error: Option<String>,
    skipped_roots: Vec<SkippedScanRoot>,
) -> PluginCatalogView {
    let mut plugins = Vec::new();
    let mut failures = Vec::new();
    for entry in &catalog.entries {
        match &entry.outcome {
            Outcome::Ok {
                classes,
                factory_vendor,
                legacy,
            } => {
                if !classes.is_empty() {
                    plugins.extend(classes.iter().cloned().map(|class| {
                        plugin_from_class(&entry.path, factory_vendor.clone(), class)
                    }));
                } else if let Some(legacy) = legacy {
                    plugins.push(VstPlugin {
                        name: legacy.name.clone(),
                        path: entry.path.clone(),
                        vendor: legacy.vendor.clone(),
                        version: legacy.version.clone(),
                        class_id: None,
                        sub_categories: None,
                        name_source: Some("file".to_string()),
                    });
                }
            }
            Outcome::NoEffects => {}
            Outcome::Failed {
                kind,
                detail,
                attempts,
            } => failures.push(PluginScanFailure {
                path: entry.path.clone(),
                name: Path::new(&entry.path)
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| entry.path.clone()),
                kind: *kind,
                detail: detail.clone(),
                scanned_at: entry.scanned_at.clone(),
                attempts: *attempts,
            }),
        }
    }
    PluginCatalogView {
        plugins,
        failures,
        stats,
        generation,
        recovered_from_corrupt,
        save_error,
        skipped_roots,
    }
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
        assert_eq!(
            parsed.error.as_deref(),
            Some("対応するエフェクトがありません")
        );
    }

    #[test]
    fn error_kind_selects_the_failure_and_missing_kind_stays_unknown() {
        let failed = classify_scanner_output(
            r#"{"formatVersion":2,"path":"C:/A.vst3","success":false,"error":"Failed to load library: boom","errorKind":"load_failed","classes":[]}"#,
            false,
        );
        assert!(matches!(
            failed,
            ProbeEffect::Failed {
                kind: FailureKind::LoadFailed,
                ..
            }
        ));
        let factory = classify_scanner_output(
            r#"{"formatVersion":2,"path":"C:/A.vst3","success":false,"error":"GetPluginFactory returned null","errorKind":"no_factory","classes":[]}"#,
            false,
        );
        assert!(matches!(
            factory,
            ProbeEffect::Failed {
                kind: FailureKind::NoFactory,
                ..
            }
        ));
        let unknown = classify_scanner_output(
            r#"{"formatVersion":2,"path":"C:/A.vst3","success":false,"error":"Failed to load library: boom","classes":[]}"#,
            false,
        );
        assert!(matches!(
            unknown,
            ProbeEffect::Failed {
                kind: FailureKind::Unknown,
                ..
            }
        ));
        let crashed = classify_scanner_output("", false);
        assert!(matches!(
            crashed,
            ProbeEffect::Failed {
                kind: FailureKind::Crashed,
                ..
            }
        ));
        let invalid = classify_scanner_output("{", true);
        assert!(matches!(
            invalid,
            ProbeEffect::Failed {
                kind: FailureKind::InvalidOutput,
                ..
            }
        ));
        let version = classify_scanner_output(r#"{"formatVersion":9,"success":false}"#, false);
        assert!(matches!(
            version,
            ProbeEffect::Failed {
                kind: FailureKind::InvalidOutput,
                ..
            }
        ));
        assert!(matches!(
            classify_scanner_output(
                r#"{"formatVersion":2,"path":"C:/A.vst3","success":false,"error":"対応するエフェクトがありません","classes":[]}"#,
                true,
            ),
            ProbeEffect::NoEffects
        ));
    }

    fn fake_scanner(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        let name = format!(
            "{}::fake_plugin_scanner",
            module_path!().split_once("::").unwrap().1
        );
        command.args(["--exact", &name, "--nocapture"]);
        command.env("AURALYN_FAKE_SCANNER", mode);
        command
    }

    #[test]
    fn fake_plugin_scanner() {
        let mode = std::env::var("AURALYN_FAKE_SCANNER").unwrap_or_default();
        match mode.as_str() {
            "load_failed" => {
                println!(
                    r#"{{"formatVersion":2,"path":"C:/A.vst3","success":false,"error":"Failed to load library: boom","errorKind":"load_failed","classes":[]}}"#
                );
                std::process::exit(1);
            }
            "no_factory" => {
                println!(
                    r#"{{"formatVersion":2,"path":"C:/A.vst3","success":false,"error":"GetPluginFactory returned null","errorKind":"no_factory","classes":[]}}"#
                );
                std::process::exit(1);
            }
            "crash" => std::process::exit(1),
            "invalid" => {
                println!("not-json");
                std::process::exit(0);
            }
            "hang" => std::thread::sleep(Duration::from_secs(5)),
            _ => {}
        }
    }

    #[test]
    fn child_process_error_kinds_cover_load_factory_crash_timeout_and_spawn() {
        assert!(matches!(
            probe_command(&mut fake_scanner("load_failed"), Duration::from_secs(10)),
            ProbeEffect::Failed {
                kind: FailureKind::LoadFailed,
                ..
            }
        ));
        assert!(matches!(
            probe_command(&mut fake_scanner("no_factory"), Duration::from_secs(10)),
            ProbeEffect::Failed {
                kind: FailureKind::NoFactory,
                ..
            }
        ));
        assert!(matches!(
            probe_command(&mut fake_scanner("crash"), Duration::from_secs(10)),
            ProbeEffect::Failed {
                kind: FailureKind::Crashed,
                ..
            }
        ));
        assert!(matches!(
            probe_command(&mut fake_scanner("invalid"), Duration::from_secs(10)),
            ProbeEffect::Failed {
                kind: FailureKind::InvalidOutput,
                ..
            }
        ));
        assert!(matches!(
            probe_command(&mut fake_scanner("hang"), Duration::from_millis(50)),
            ProbeEffect::Failed {
                kind: FailureKind::TimedOut,
                ..
            }
        ));
        assert!(matches!(
            probe_command(
                &mut Command::new("auralyn-missing-plugin-scanner"),
                Duration::from_secs(5)
            ),
            ProbeEffect::Failed {
                kind: FailureKind::SpawnFailed,
                ..
            }
        ));
    }

    #[test]
    fn bundle_candidate_uses_the_inner_binary_and_skips_nested_files() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-scan-walk-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let binary = root
            .join("Foo.vst3")
            .join("Contents")
            .join("x86_64-win")
            .join("Foo.vst3");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, b"bundle").unwrap();
        std::fs::write(root.join("Loose.vst3"), b"loose").unwrap();
        let nested = root
            .join("Foo.vst3")
            .join("Contents")
            .join("x86_64-win")
            .join("Other.vst3");
        std::fs::write(&nested, b"other").unwrap();
        let found = candidates_under(std::slice::from_ref(&root));
        let names: Vec<_> = found
            .iter()
            .map(|candidate| candidate.path.clone())
            .collect();
        assert_eq!(found.len(), 2, "{names:?}");
        assert!(found
            .iter()
            .any(|candidate| candidate.bundle_path.is_some() && candidate.file_id.size == 6));
        assert!(found
            .iter()
            .any(|candidate| candidate.bundle_path.is_none() && candidate.file_id.size == 5));
        assert!(found
            .iter()
            .all(|candidate| !candidate.path.contains("Other.vst3")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn extra_roots_beyond_the_limit_are_skipped() {
        let missing = std::env::temp_dir().join("auralyn-scan-roots-limit-missing");
        let inputs: Vec<String> = (0..MAX_EXTRA_SCAN_ROOTS + 2)
            .map(|index| {
                missing
                    .join(index.to_string())
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        let (roots, skipped) = resolve_scan_roots(&inputs);
        assert_eq!(roots.len(), default_roots().len());
        assert_eq!(skipped.len(), inputs.len());
        let invalid = skipped
            .iter()
            .filter(|item| item.reason == SkippedScanRootReason::Invalid)
            .count();
        assert_eq!(invalid, 2);
    }

    #[test]
    fn extra_folder_vst3_is_scanned_and_bad_paths_do_not_stop_the_walk() {
        let root = std::env::temp_dir().join(format!(
            "auralyn-scan-roots-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let extra = root.join("extra");
        std::fs::create_dir_all(&extra).unwrap();
        std::fs::write(extra.join("Room.vst3"), b"room-vst3").unwrap();
        let file = root.join("not-a-folder.txt");
        std::fs::write(&file, b"file").unwrap();
        let missing = root.join("missing");
        let extra_text = extra.to_string_lossy().into_owned();
        let slash_text = extra_text.replace('\\', "/") + "/";
        let inputs = vec![
            extra_text.clone(),
            slash_text,
            missing.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            String::new(),
            " \t".to_string(),
            "\0".to_string(),
            "a".repeat(40_000),
            r"relative\VST3".to_string(),
            r"C:\Program Files\Common Files\VST3".to_string(),
            "C:/Program Files/Common Files/VST3/".to_string(),
        ];
        let (roots, skipped) = resolve_scan_roots(&inputs);
        assert_eq!(roots.len(), default_roots().len() + 1, "{roots:?}");
        let added: Vec<_> = roots
            .iter()
            .filter(|path| {
                !default_roots()
                    .iter()
                    .any(|default| path_key(path) == path_key(default))
            })
            .cloned()
            .collect();
        assert_eq!(added.len(), 1);
        let found = candidates_under(&added);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].path.to_ascii_lowercase().ends_with("room.vst3"));
        assert_eq!(found[0].file_id.size, 9);
        let reasons: Vec<_> = skipped.iter().map(|item| item.reason).collect();
        assert!(reasons.contains(&SkippedScanRootReason::Missing));
        assert!(reasons.contains(&SkippedScanRootReason::NotDirectory));
        assert!(reasons.contains(&SkippedScanRootReason::Invalid));
        assert!(skipped
            .iter()
            .all(|item| item.reason != SkippedScanRootReason::Missing
                || item.path.contains("missing")));
        // 使えないパスが混ざっても、存在する追加フォルダーの探索は残る。
        let continued = candidates_under(&[added[0].clone(), missing.clone(), file.clone()]);
        assert_eq!(continued.len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }
}
