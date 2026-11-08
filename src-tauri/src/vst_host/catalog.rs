//! VSTスキャン結果の差分カタログ。
//!
//! 除外の正本はこちら。旧 `vst_blacklist.json` はカタログが無いときだけ読み、移行後はスキャンでは更新しない。
//! ファイルの同一性は binary のサイズと更新時刻で見る。時刻を保った内容だけの置換は検出できない。

use crate::vst_host::blacklist::Blacklist;
use crate::vst_host::class_listing::ClassEntry;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE_NAME: &str = "vst_catalog.json";
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileId {
    pub size: u64,
    pub modified_ns: u64,
}

/// 失敗理由。子プロセスの `errorKind` と同じ語彙を使う。文字列からの推定はしない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Crashed,
    TimedOut,
    LoadFailed,
    NoFactory,
    InvalidOutput,
    SpawnFailed,
    LegacyBlacklisted,
    Unknown,
}

impl FailureKind {
    pub fn parse(value: &str) -> Self {
        match value {
            "crashed" => Self::Crashed,
            "timed_out" => Self::TimedOut,
            "load_failed" => Self::LoadFailed,
            "no_factory" => Self::NoFactory,
            "invalid_output" => Self::InvalidOutput,
            "spawn_failed" => Self::SpawnFailed,
            "legacy_blacklisted" => Self::LegacyBlacklisted,
            "unknown" => Self::Unknown,
            _ => Self::Unknown,
        }
    }
}

/// クラス ID の無い旧スキャナー出力を、偽の ID を付けずに残す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPlugin {
    pub name: String,
    pub vendor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Outcome {
    Ok {
        classes: Vec<ClassEntry>,
        /// クラス側にメーカーが無いときの表示用。#450 の factory 名を落とさない。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        factory_vendor: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        legacy: Option<LegacyPlugin>,
    },
    NoEffects,
    Failed {
        kind: FailureKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        attempts: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_path: Option<String>,
    pub file_id: FileId,
    pub scanner_format_version: u32,
    pub scanned_at: String,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFile {
    pub schema_version: u32,
    pub entries: Vec<Entry>,
}

impl Default for CatalogFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanMode {
    Incremental,
    /// 一致する成功・エフェクトなしは再スキャンする。失敗は `retry_failed` のときだけ。
    Full {
        retry_failed: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub path: String,
    pub bundle_path: Option<String>,
    pub file_id: FileId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanStep {
    Reuse(String),
    Scan(Candidate),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanPlan {
    pub steps: Vec<PlanStep>,
    pub removed: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStats {
    pub reused: u32,
    pub scanned: u32,
    pub removed: u32,
}

/// 1件を調べた結果。attempts はカタログ側で足す。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeEffect {
    Classes {
        classes: Vec<ClassEntry>,
        factory_vendor: Option<String>,
    },
    Legacy {
        plugin: LegacyPlugin,
    },
    NoEffects,
    Failed {
        kind: FailureKind,
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileOutput {
    pub catalog: CatalogFile,
    pub stats: ScanStats,
    pub save_error: Option<String>,
    pub stopped_for_stale: bool,
}

#[derive(Debug)]
pub struct PreparedCatalog {
    pub catalog: CatalogFile,
    pub recovered_from_corrupt: bool,
    pub save_error: Option<String>,
}

/// 同時スキャンは拒否する。待たせると、認証待ちの再試行の間 UI の別要求が長く止まる。
#[derive(Debug, Default)]
pub struct ScanGate {
    generation: u64,
    busy: bool,
}

impl ScanGate {
    pub const fn new() -> Self {
        Self {
            generation: 0,
            busy: false,
        }
    }

    pub fn try_begin(&mut self) -> Option<u64> {
        if self.busy {
            return None;
        }
        self.busy = true;
        self.generation = self.generation.wrapping_add(1);
        Some(self.generation)
    }

    pub fn finish(&mut self, generation: u64) {
        if self.generation == generation {
            self.busy = false;
        }
    }

    pub fn current(&self) -> u64 {
        self.generation
    }
}

pub fn utc_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format_unix_secs(secs)
}

pub fn format_unix_secs(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = tod / 3_600;
    let minute = (tod % 3_600) / 60;
    let second = tod % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

pub fn file_id(path: &Path) -> Option<FileId> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified_ns = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    Some(FileId {
        size: meta.len(),
        modified_ns,
    })
}

/// `\\?\` を外したフルパス。存在しないパスは与えられた表記のままにする。
pub fn normalize_path(path: &Path) -> String {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim(&canonical)
}

pub fn plan_scan(
    existing: &[Entry],
    candidates: &[Candidate],
    mode: ScanMode,
    format_version: u32,
) -> ScanPlan {
    let mut seen = HashSet::new();
    let mut steps = Vec::new();
    for candidate in candidates {
        if !seen.insert(candidate.path.clone()) {
            continue;
        }
        let reusable = existing
            .iter()
            .find(|entry| entry.path == candidate.path)
            .is_some_and(|entry| {
                same_identity(entry, candidate, format_version) && keep_cached(entry, mode)
            });
        if reusable {
            steps.push(PlanStep::Reuse(candidate.path.clone()));
        } else {
            steps.push(PlanStep::Scan(candidate.clone()));
        }
    }
    let removed = existing
        .iter()
        .filter(|entry| !seen.contains(&entry.path))
        .map(|entry| entry.path.clone())
        .collect();
    ScanPlan { steps, removed }
}

pub fn plan_retry(candidate: Candidate) -> ScanPlan {
    ScanPlan {
        steps: vec![PlanStep::Scan(candidate)],
        removed: Vec::new(),
    }
}

pub fn reconcile(
    mut catalog: CatalogFile,
    plan: &ScanPlan,
    mut probe: impl FnMut(&Candidate) -> ProbeEffect,
    mut persist: impl FnMut(&CatalogFile) -> Result<(), String>,
    now: &str,
    mut is_current: impl FnMut() -> bool,
    format_version: u32,
) -> ReconcileOutput {
    let mut stats = ScanStats::default();
    let mut save_error = None;
    if !is_current() {
        return ReconcileOutput {
            catalog,
            stats,
            save_error,
            stopped_for_stale: true,
        };
    }
    stats.removed = remove_paths(&mut catalog.entries, &plan.removed);
    if stats.removed > 0 {
        remember(&mut save_error, persist(&catalog));
    }
    let mut stopped_for_stale = false;
    for step in &plan.steps {
        if !is_current() {
            stopped_for_stale = true;
            break;
        }
        match step {
            PlanStep::Reuse(path) => {
                if catalog.entries.iter().any(|entry| &entry.path == path) {
                    stats.reused = stats.reused.saturating_add(1);
                }
            }
            PlanStep::Scan(candidate) => {
                let previous = catalog
                    .entries
                    .iter()
                    .find(|entry| entry.path == candidate.path)
                    .map(|entry| entry.outcome.clone());
                let effect = probe(candidate);
                if !is_current() {
                    stopped_for_stale = true;
                    break;
                }
                let entry = entry_from(candidate, previous.as_ref(), effect, format_version, now);
                upsert(&mut catalog.entries, entry);
                stats.scanned = stats.scanned.saturating_add(1);
                remember(&mut save_error, persist(&catalog));
            }
        }
    }
    ReconcileOutput {
        catalog,
        stats,
        save_error,
        stopped_for_stale,
    }
}

pub fn clear_failures(catalog: &mut CatalogFile) -> usize {
    let before = catalog.entries.len();
    catalog
        .entries
        .retain(|entry| !matches!(entry.outcome, Outcome::Failed { .. }));
    before - catalog.entries.len()
}

pub fn prepare_catalog(
    dir: &Path,
    now: &str,
    format_version: u32,
) -> Result<PreparedCatalog, String> {
    let loaded = load_catalog(dir)?;
    let mut catalog = loaded.catalog;
    let mut save_error = None;
    if loaded.missing {
        let imported = import_blacklist(dir, &mut catalog, now, format_version);
        if imported > 0 {
            remember(&mut save_error, save_catalog(dir, &catalog));
        }
    }
    Ok(PreparedCatalog {
        catalog,
        recovered_from_corrupt: loaded.recovered_from_corrupt,
        save_error,
    })
}

pub fn load_catalog(dir: &Path) -> Result<LoadedCatalog, String> {
    let path = dir.join(FILE_NAME);
    match fs::read_to_string(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LoadedCatalog {
            catalog: CatalogFile::default(),
            missing: true,
            recovered_from_corrupt: false,
        }),
        Err(error) => Err(format!("スキャン結果を読めません: {error}")),
        Ok(text) => match serde_json::from_str::<CatalogFile>(&text) {
            Ok(catalog) if catalog.schema_version == SCHEMA_VERSION => Ok(LoadedCatalog {
                catalog,
                missing: false,
                recovered_from_corrupt: false,
            }),
            _ => {
                quarantine(&path)?;
                Ok(LoadedCatalog {
                    catalog: CatalogFile::default(),
                    missing: false,
                    recovered_from_corrupt: true,
                })
            }
        },
    }
}

pub struct LoadedCatalog {
    pub catalog: CatalogFile,
    pub missing: bool,
    pub recovered_from_corrupt: bool,
}

pub fn save_catalog(dir: &Path, catalog: &CatalogFile) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|error| format!("スキャン結果の保存先を作れません: {error}"))?;
    let path = dir.join(FILE_NAME);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = dir.join(format!(".{FILE_NAME}.{}.{nanos}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(catalog).map_err(|error| error.to_string())?;
    let result = (|| -> std::io::Result<()> {
        let mut file = File::create(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error| format!("スキャン結果を保存できません: {error}"))
}

fn import_blacklist(
    dir: &Path,
    catalog: &mut CatalogFile,
    now: &str,
    format_version: u32,
) -> usize {
    let blacklist = Blacklist::new(&dir.to_path_buf());
    let mut imported = 0;
    for raw in blacklist.paths {
        let Some(entry) = legacy_entry(&raw, now, format_version) else {
            continue;
        };
        if catalog
            .entries
            .iter()
            .any(|existing| existing.path == entry.path)
        {
            continue;
        }
        catalog.entries.push(entry);
        imported += 1;
    }
    imported
}

fn legacy_entry(raw: &str, now: &str, format_version: u32) -> Option<Entry> {
    let path = PathBuf::from(raw);
    if !path.is_file() {
        return None;
    }
    Some(Entry {
        path: normalize_path(&path),
        bundle_path: None,
        file_id: file_id(&path)?,
        scanner_format_version: format_version,
        scanned_at: now.to_string(),
        outcome: Outcome::Failed {
            kind: FailureKind::LegacyBlacklisted,
            detail: None,
            attempts: 1,
        },
    })
}

fn same_identity(entry: &Entry, candidate: &Candidate, format_version: u32) -> bool {
    entry.path == candidate.path
        && entry.file_id == candidate.file_id
        && entry.scanner_format_version == format_version
}

fn keep_cached(entry: &Entry, mode: ScanMode) -> bool {
    match mode {
        ScanMode::Incremental => true,
        ScanMode::Full { retry_failed } => {
            matches!(entry.outcome, Outcome::Failed { .. }) && !retry_failed
        }
    }
}

fn entry_from(
    candidate: &Candidate,
    previous: Option<&Outcome>,
    effect: ProbeEffect,
    format_version: u32,
    now: &str,
) -> Entry {
    let outcome = match effect {
        ProbeEffect::Classes {
            classes,
            factory_vendor,
        } => Outcome::Ok {
            classes,
            factory_vendor,
            legacy: None,
        },
        ProbeEffect::Legacy { plugin } => Outcome::Ok {
            classes: Vec::new(),
            factory_vendor: None,
            legacy: Some(plugin),
        },
        ProbeEffect::NoEffects => Outcome::NoEffects,
        ProbeEffect::Failed { kind, detail } => Outcome::Failed {
            kind,
            detail: clip_detail(detail),
            attempts: match previous {
                Some(Outcome::Failed { attempts, .. }) => attempts.saturating_add(1),
                _ => 1,
            },
        },
    };
    Entry {
        path: candidate.path.clone(),
        bundle_path: candidate.bundle_path.clone(),
        file_id: candidate.file_id,
        scanner_format_version: format_version,
        scanned_at: now.to_string(),
        outcome,
    }
}

fn upsert(entries: &mut Vec<Entry>, entry: Entry) {
    if let Some(slot) = entries
        .iter_mut()
        .find(|existing| existing.path == entry.path)
    {
        *slot = entry;
    } else {
        entries.push(entry);
    }
}

fn remove_paths(entries: &mut Vec<Entry>, paths: &[String]) -> u32 {
    let before = entries.len();
    entries.retain(|entry| !paths.iter().any(|path| path == &entry.path));
    u32::try_from(before - entries.len()).unwrap_or(u32::MAX)
}

fn remember(slot: &mut Option<String>, result: Result<(), String>) {
    if let Err(error) = result {
        if slot.is_none() {
            *slot = Some(error);
        }
    }
}

fn clip_detail(detail: Option<String>) -> Option<String> {
    let text = detail?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    let mut chars = text.chars();
    let clipped: String = chars.by_ref().take(400).collect();
    if chars.next().is_some() {
        Some(format!("{clipped}…"))
    } else {
        Some(clipped)
    }
}

fn quarantine(path: &Path) -> Result<(), String> {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let mut dest = PathBuf::from(format!("{}.corrupt-{secs}", path.display()));
    if dest.exists() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        dest = PathBuf::from(format!("{}.corrupt-{nanos}", path.display()));
    }
    fs::rename(path, &dest).map_err(|error| format!("壊れたスキャン結果を退避できません: {error}"))
}

fn strip_verbatim(path: &Path) -> String {
    let text = path.to_string_lossy();
    let stripped = text.strip_prefix(r"\\?\").unwrap_or(text.as_ref());
    if let Some(unc) = stripped.strip_prefix(r"UNC\") {
        format!(r"\\{unc}")
    } else {
        stripped.to_string()
    }
}

fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let encode = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>()
    };
    let from_w = encode(from);
    let to_w = encode(to);
    // SAFETY: どちらも NUL 終端のパスで、MoveFileExW が戻るまでこのベクタが生きている。
    unsafe {
        MoveFileExW(
            PCWSTR(from_w.as_ptr()),
            PCWSTR(to_w.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| std::io::Error::other(error.to_string()))
}

/// Howard Hinnant の civil_from_days。1970-01-01 を 0 とする。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vst_host::class_listing::ClassInfoSource;
    use std::sync::atomic::{AtomicU64, Ordering};

    const FORMAT: u32 = 2;

    fn id(size: u64, modified_ns: u64) -> FileId {
        FileId { size, modified_ns }
    }

    fn class(name: &str) -> ClassEntry {
        ClassEntry {
            class_id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            name: Some(name.into()),
            vendor: Some("Vendor".into()),
            version: Some("1".into()),
            sub_categories: Some("Fx".into()),
            info_source: ClassInfoSource::ClassInfo2,
            kind_known: true,
        }
    }

    fn candidate(path: &str, size: u64) -> Candidate {
        Candidate {
            path: path.into(),
            bundle_path: None,
            file_id: id(size, 10),
        }
    }

    fn failed(path: &str, size: u64, attempts: u32) -> Entry {
        Entry {
            path: path.into(),
            bundle_path: None,
            file_id: id(size, 10),
            scanner_format_version: FORMAT,
            scanned_at: "2026-01-01T00:00:00Z".into(),
            outcome: Outcome::Failed {
                kind: FailureKind::Crashed,
                detail: Some("gone".into()),
                attempts,
            },
        }
    }

    fn ok_entry(path: &str, size: u64) -> Entry {
        Entry {
            path: path.into(),
            bundle_path: None,
            file_id: id(size, 10),
            scanner_format_version: FORMAT,
            scanned_at: "2026-01-01T00:00:00Z".into(),
            outcome: Outcome::Ok {
                classes: vec![class("Delay")],
                factory_vendor: None,
                legacy: None,
            },
        }
    }

    fn catalog(entries: Vec<Entry>) -> CatalogFile {
        CatalogFile {
            schema_version: SCHEMA_VERSION,
            entries,
        }
    }

    fn run(
        entries: Vec<Entry>,
        candidates: Vec<Candidate>,
        mode: ScanMode,
        mut probe: impl FnMut(&Candidate) -> ProbeEffect,
        current: impl FnMut() -> bool,
    ) -> ReconcileOutput {
        let plan = plan_scan(&entries, &candidates, mode, FORMAT);
        reconcile(
            catalog(entries),
            &plan,
            &mut probe,
            |_| Ok(()),
            "2026-11-08T00:00:00Z",
            current,
            FORMAT,
        )
    }

    #[test]
    fn epoch_is_utc() {
        assert_eq!(format_unix_secs(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn first_scan_checks_every_candidate_and_keeps_failures() {
        let mut scanned = Vec::new();
        let output = run(
            vec![],
            vec![candidate("a.vst3", 1), candidate("b.vst3", 2)],
            ScanMode::Incremental,
            |candidate| {
                scanned.push(candidate.path.clone());
                if candidate.path == "b.vst3" {
                    ProbeEffect::Failed {
                        kind: FailureKind::LoadFailed,
                        detail: Some("dll".into()),
                    }
                } else {
                    ProbeEffect::Classes {
                        classes: vec![class("A")],
                        factory_vendor: None,
                    }
                }
            },
            || true,
        );
        assert_eq!(scanned, ["a.vst3", "b.vst3"]);
        assert_eq!(
            output.stats,
            ScanStats {
                reused: 0,
                scanned: 2,
                removed: 0
            }
        );
        assert!(matches!(
            output.catalog.entries[1].outcome,
            Outcome::Failed {
                attempts: 1,
                kind: FailureKind::LoadFailed,
                ..
            }
        ));
    }

    #[test]
    fn unchanged_files_are_not_scanned() {
        let output = run(
            vec![ok_entry("a.vst3", 1), failed("b.vst3", 2, 3)],
            vec![candidate("a.vst3", 1), candidate("b.vst3", 2)],
            ScanMode::Incremental,
            |_| panic!("スキャンしない"),
            || true,
        );
        assert_eq!(output.stats.reused, 2);
        assert_eq!(output.stats.scanned, 0);
        assert!(matches!(
            output.catalog.entries[1].outcome,
            Outcome::Failed { attempts: 3, .. }
        ));
    }

    #[test]
    fn only_the_changed_file_is_scanned_and_replaced() {
        let mut scanned = Vec::new();
        let output = run(
            vec![ok_entry("a.vst3", 1), ok_entry("b.vst3", 2)],
            vec![candidate("a.vst3", 1), candidate("b.vst3", 9)],
            ScanMode::Incremental,
            |candidate| {
                scanned.push(candidate.path.clone());
                ProbeEffect::Classes {
                    classes: vec![class("Next")],
                    factory_vendor: Some("Factory".into()),
                }
            },
            || true,
        );
        assert_eq!(scanned, ["b.vst3"]);
        assert_eq!(
            output.stats,
            ScanStats {
                reused: 1,
                scanned: 1,
                removed: 0
            }
        );
        match &output.catalog.entries[1].outcome {
            Outcome::Ok {
                classes,
                factory_vendor,
                ..
            } => {
                assert_eq!(classes[0].name.as_deref(), Some("Next"));
                assert_eq!(factory_vendor.as_deref(), Some("Factory"));
            }
            other => panic!("置換されていない: {other:?}"),
        }
        assert_eq!(output.catalog.entries[1].file_id.size, 9);
    }

    #[test]
    fn missing_candidates_are_removed_without_a_scan() {
        let output = run(
            vec![ok_entry("a.vst3", 1), ok_entry("gone.vst3", 2)],
            vec![candidate("a.vst3", 1)],
            ScanMode::Incremental,
            |_| panic!("スキャンしない"),
            || true,
        );
        assert_eq!(output.stats.removed, 1);
        assert_eq!(output.catalog.entries.len(), 1);
        assert_eq!(output.catalog.entries[0].path, "a.vst3");
    }

    #[test]
    fn format_change_rescans_everything_including_failures() {
        let mut entry = failed("a.vst3", 1, 2);
        entry.scanner_format_version = 1;
        let mut scanned = 0;
        let output = run(
            vec![entry],
            vec![candidate("a.vst3", 1)],
            ScanMode::Incremental,
            |_| {
                scanned += 1;
                ProbeEffect::NoEffects
            },
            || true,
        );
        assert_eq!(scanned, 1);
        assert!(matches!(
            output.catalog.entries[0].outcome,
            Outcome::NoEffects
        ));
        assert_eq!(output.catalog.entries[0].scanner_format_version, FORMAT);
    }

    #[test]
    fn full_scan_keeps_failures_unless_requested() {
        let entries = vec![ok_entry("a.vst3", 1), failed("b.vst3", 2, 4)];
        let mut scanned = Vec::new();
        let output = run(
            entries.clone(),
            vec![candidate("a.vst3", 1), candidate("b.vst3", 2)],
            ScanMode::Full {
                retry_failed: false,
            },
            |candidate| {
                scanned.push(candidate.path.clone());
                ProbeEffect::NoEffects
            },
            || true,
        );
        assert_eq!(scanned, ["a.vst3"]);
        assert!(matches!(
            output.catalog.entries[1].outcome,
            Outcome::Failed { attempts: 4, .. }
        ));

        let mut scanned = Vec::new();
        let output = run(
            entries,
            vec![candidate("a.vst3", 1), candidate("b.vst3", 2)],
            ScanMode::Full { retry_failed: true },
            |candidate| {
                scanned.push(candidate.path.clone());
                ProbeEffect::NoEffects
            },
            || true,
        );
        assert_eq!(scanned, ["a.vst3", "b.vst3"]);
        assert!(matches!(
            output.catalog.entries[1].outcome,
            Outcome::NoEffects
        ));
    }

    #[test]
    fn retry_updates_one_failure_and_keeps_the_other() {
        let entries = vec![failed("a.vst3", 1, 1), failed("b.vst3", 2, 2)];
        let plan = plan_retry(candidate("a.vst3", 1));
        let failed_again = reconcile(
            catalog(entries.clone()),
            &plan,
            |_| ProbeEffect::Failed {
                kind: FailureKind::TimedOut,
                detail: Some("timeout".into()),
            },
            |_| Ok(()),
            "2026-11-08T00:00:01Z",
            || true,
            FORMAT,
        );
        match &failed_again.catalog.entries[0].outcome {
            Outcome::Failed { kind, attempts, .. } => {
                assert_eq!(*kind, FailureKind::TimedOut);
                assert_eq!(*attempts, 2);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            failed_again.catalog.entries[1].outcome,
            Outcome::Failed {
                attempts: 2,
                kind: FailureKind::Crashed,
                ..
            }
        ));

        let recovered = reconcile(
            catalog(entries),
            &plan,
            |_| ProbeEffect::Classes {
                classes: vec![class("Back")],
                factory_vendor: None,
            },
            |_| Ok(()),
            "2026-11-08T00:00:02Z",
            || true,
            FORMAT,
        );
        assert!(matches!(
            recovered.catalog.entries[0].outcome,
            Outcome::Ok { .. }
        ));
        assert!(matches!(
            recovered.catalog.entries[1].outcome,
            Outcome::Failed { .. }
        ));
        assert_eq!(recovered.stats.scanned, 1);
        assert_eq!(recovered.stats.removed, 0);
    }

    #[test]
    fn stale_generation_does_not_store_the_late_result() {
        let live = AtomicU64::new(1);
        let output = run(
            vec![ok_entry("a.vst3", 1), ok_entry("b.vst3", 2)],
            vec![candidate("a.vst3", 8), candidate("b.vst3", 9)],
            ScanMode::Incremental,
            |candidate| {
                if candidate.path == "b.vst3" {
                    live.store(2, Ordering::Relaxed);
                }
                ProbeEffect::Classes {
                    classes: vec![class("New")],
                    factory_vendor: None,
                }
            },
            || live.load(Ordering::Relaxed) == 1,
        );
        assert!(output.stopped_for_stale);
        assert!(matches!(
            output.catalog.entries[0].outcome,
            Outcome::Ok { .. }
        ));
        assert_eq!(output.catalog.entries[0].file_id.size, 8);
        assert_eq!(output.catalog.entries[1].file_id.size, 2);
        assert_eq!(output.catalog.entries[1].scanned_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn a_generation_that_is_already_old_does_not_change_the_catalog() {
        let output = run(
            vec![ok_entry("a.vst3", 1)],
            vec![candidate("a.vst3", 4)],
            ScanMode::Incremental,
            |_| panic!("古い世代は調べない"),
            || false,
        );
        assert!(output.stopped_for_stale);
        assert_eq!(output.catalog.entries[0].file_id.size, 1);
        assert_eq!(output.stats.scanned, 0);
    }

    #[test]
    fn a_second_scan_is_rejected_while_one_is_running() {
        let mut gate = ScanGate::default();
        let first = gate.try_begin().unwrap();
        assert!(gate.try_begin().is_none());
        assert_eq!(gate.current(), first);
        gate.finish(first);
        let second = gate.try_begin().unwrap();
        assert_ne!(first, second);
        gate.finish(first);
        assert!(gate.try_begin().is_none());
        gate.finish(second);
        assert!(gate.try_begin().is_some());
    }

    #[test]
    fn save_failure_keeps_the_in_memory_result() {
        let plan = plan_scan(
            &[],
            &[candidate("a.vst3", 1)],
            ScanMode::Incremental,
            FORMAT,
        );
        let output = reconcile(
            CatalogFile::default(),
            &plan,
            |_| ProbeEffect::NoEffects,
            |_| Err("disk".into()),
            "2026-11-08T00:00:00Z",
            || true,
            FORMAT,
        );
        assert_eq!(output.save_error.as_deref(), Some("disk"));
        assert!(matches!(
            output.catalog.entries[0].outcome,
            Outcome::NoEffects
        ));
    }

    #[test]
    fn unknown_error_kind_is_not_guessed() {
        assert_eq!(FailureKind::parse("load_failed"), FailureKind::LoadFailed);
        assert_eq!(FailureKind::parse("DLL crashed"), FailureKind::Unknown);
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "auralyn-catalog-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn legacy_blacklist_is_imported_once_and_the_old_file_stays() {
        let dir = temp_dir("migrate");
        let plugin = dir.join("Old.vst3");
        fs::write(&plugin, b"vst").unwrap();
        let blacklist = dir.join("vst_blacklist.json");
        let body = format!(
            r#"{{"paths":["{}","C:\\missing\\Gone.vst3"]}}"#,
            plugin.display().to_string().replace('\\', "\\\\")
        );
        fs::write(&blacklist, &body).unwrap();
        let prepared = prepare_catalog(&dir, "2026-11-08T00:00:00Z", FORMAT).unwrap();
        assert_eq!(prepared.catalog.entries.len(), 1);
        assert!(matches!(
            prepared.catalog.entries[0].outcome,
            Outcome::Failed {
                kind: FailureKind::LegacyBlacklisted,
                attempts: 1,
                ..
            }
        ));
        assert_eq!(fs::read_to_string(&blacklist).unwrap(), body);
        let again = prepare_catalog(&dir, "2026-11-08T00:00:01Z", FORMAT).unwrap();
        assert_eq!(again.catalog.entries.len(), 1);
        assert!(!again.recovered_from_corrupt);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_catalog_is_quarantined_and_does_not_reimport_the_blacklist() {
        let dir = temp_dir("corrupt");
        let plugin = dir.join("Old.vst3");
        fs::write(&plugin, b"vst").unwrap();
        fs::write(
            dir.join("vst_blacklist.json"),
            format!(
                r#"{{"paths":["{}"]}}"#,
                plugin.display().to_string().replace('\\', "\\\\")
            ),
        )
        .unwrap();
        fs::write(dir.join(FILE_NAME), b"{not json").unwrap();
        let prepared = prepare_catalog(&dir, "2026-11-08T00:00:00Z", FORMAT).unwrap();
        assert!(prepared.recovered_from_corrupt);
        assert!(prepared.catalog.entries.is_empty());
        assert!(!dir.join(FILE_NAME).exists());
        let quarantined = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"));
        assert!(quarantined);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_replace_keeps_a_complete_file_when_the_source_is_missing() {
        let dir = temp_dir("atomic");
        let original = CatalogFile {
            schema_version: SCHEMA_VERSION,
            entries: vec![ok_entry("a.vst3", 1)],
        };
        save_catalog(&dir, &original).unwrap();
        let path = dir.join(FILE_NAME);
        assert!(replace_file(&dir.join("missing.tmp"), &path).is_err());
        let loaded = load_catalog(&dir).unwrap();
        assert_eq!(loaded.catalog, original);
        let replacement = CatalogFile::default();
        save_catalog(&dir, &replacement).unwrap();
        let loaded = load_catalog(&dir).unwrap();
        assert_eq!(loaded.catalog.entries.len(), 0);
        let temps = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".tmp"));
        assert!(!temps);
        let blocker = dir.join("blocked");
        fs::write(&blocker, b"file").unwrap();
        assert!(save_catalog(&blocker, &original).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clearing_failures_leaves_successful_entries() {
        let mut file = catalog(vec![ok_entry("a.vst3", 1), failed("b.vst3", 2, 1)]);
        assert_eq!(clear_failures(&mut file), 1);
        assert_eq!(file.entries.len(), 1);
    }
}
