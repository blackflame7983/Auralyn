//! プラグイン互換用のCWD・DLL検索ディレクトリをエディタの寿命に合わせて管理する。
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use windows::core::PCWSTR;
use windows::Win32::System::LibraryLoader::{GetDllDirectoryW, SetDllDirectoryW};

#[derive(Debug)]
pub(super) struct EditorEnvGuard {
    id: u64,
}

#[derive(Debug, Default)]
struct EditorEnvManager {
    baseline_cwd: Option<PathBuf>,
    baseline_dll_dir: Option<Vec<u16>>,
    stack: Vec<(u64, PathBuf, PathBuf)>, // (id, cwd_dir, dll_dir)
    next_id: u64,
}

fn editor_env_manager() -> &'static Mutex<EditorEnvManager> {
    static MGR: OnceLock<Mutex<EditorEnvManager>> = OnceLock::new();
    MGR.get_or_init(|| Mutex::new(EditorEnvManager::default()))
}

fn apply_editor_env(cwd_dir: &Path, dll_dir: &Path) {
    // 重要: 一部のプラグインは相対パスでリソース/補助DLLをロードする。
    // エディタ表示中だけ、CWD と DllDirectory を適切な場所に寄せて互換性を上げる。
    // - CWD: Bundle型では Contents/Resources を相対参照するケースがあるため、Contents を優先
    // - DllDirectory: 依存DLLはバイナリ配置ディレクトリ（例: Contents/x86_64-win）にあることが多い
    let _ = std::env::set_current_dir(cwd_dir);
    unsafe {
        let wide = path_to_wide_null(dll_dir);
        let _ = SetDllDirectoryW(PCWSTR(wide.as_ptr()));
    }
}

fn restore_editor_env(baseline_cwd: Option<PathBuf>, baseline_dll_dir: Option<Vec<u16>>) {
    if let Some(prev) = baseline_cwd {
        let _ = std::env::set_current_dir(prev);
    }

    unsafe {
        match baseline_dll_dir {
            Some(wide) => {
                let _ = SetDllDirectoryW(PCWSTR(wide.as_ptr()));
            }
            None => {
                // 空 = リセット
                let _ = SetDllDirectoryW(PCWSTR::null());
            }
        }
    }
}

impl EditorEnvGuard {
    fn enter(cwd_dir: &Path, dll_dir: &Path) -> Self {
        let mut mgr = editor_env_manager()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if mgr.stack.is_empty() {
            mgr.baseline_cwd = std::env::current_dir().ok();
            mgr.baseline_dll_dir = unsafe { get_dll_directory_wide() };
        }
        mgr.next_id = mgr.next_id.wrapping_add(1);
        let id = mgr.next_id;
        mgr.stack
            .push((id, cwd_dir.to_path_buf(), dll_dir.to_path_buf()));
        apply_editor_env(cwd_dir, dll_dir);
        Self { id }
    }

    pub(super) fn enter_for_module(module_path: &Path) -> Option<Self> {
        let (cwd_dir, dll_dir) = compute_plugin_env_dirs(module_path)?;
        println!(
            "[EditorEnv] module={:?} cwd={:?} dll_dir={:?}",
            module_path, cwd_dir, dll_dir
        );
        Some(Self::enter(&cwd_dir, &dll_dir))
    }
}

impl Drop for EditorEnvGuard {
    fn drop(&mut self) {
        let mut mgr = editor_env_manager()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let (next_dir, baseline) = {
            mgr.stack.retain(|(id, _, _)| *id != self.id);

            let next_dir = mgr
                .stack
                .last()
                .map(|(_, cwd, dll)| (cwd.clone(), dll.clone()));
            let baseline = if next_dir.is_none() {
                Some((mgr.baseline_cwd.take(), mgr.baseline_dll_dir.take()))
            } else {
                None
            };
            (next_dir, baseline)
        };

        if let Some((cwd_dir, dll_dir)) = next_dir {
            apply_editor_env(&cwd_dir, &dll_dir);
        } else if let Some((baseline_cwd, baseline_dll_dir)) = baseline {
            restore_editor_env(baseline_cwd, baseline_dll_dir);
        }
    }
}

fn compute_plugin_env_dirs(plugin_path: &Path) -> Option<(PathBuf, PathBuf)> {
    // 入力は「実体DLL(.vst3)」または「Bundleディレクトリ(.vst3)」のどちらでも来うる。
    // Bundle型の場合は .../<Plugin>.vst3/Contents/<arch>/*.vst3 を探して実体DLLへ解決する。
    let mut module_path = plugin_path.to_path_buf();

    // 1) Bundleディレクトリを実体DLLへ解決
    if plugin_path.is_dir()
        && plugin_path
            .extension()
            .map(|e| e.to_string_lossy().eq_ignore_ascii_case("vst3"))
            .unwrap_or(false)
    {
        let contents = plugin_path.join("Contents");
        let candidates = [
            contents.join("x86_64-win"),
            contents.join("x86-win"),
            contents.join("win"),
        ];

        let mut found: Option<PathBuf> = None;
        for arch_dir in candidates {
            if !arch_dir.exists() {
                continue;
            }
            if let Ok(mut it) = std::fs::read_dir(&arch_dir) {
                if let Some(Ok(entry)) = it.find(|e| {
                    e.as_ref()
                        .ok()
                        .map(|x| x.path().extension().is_some_and(|ext| ext == "vst3"))
                        .unwrap_or(false)
                }) {
                    found = Some(entry.path());
                    break;
                }
            }
        }

        if let Some(p) = found {
            module_path = p;
        }
    }

    // 2) CWD/DLLDir 推定
    // - dll_dir: 実体DLLがあるディレクトリ
    // - cwd_dir: Bundleなら Contents（Resources相対参照の互換性が高い）、単体なら dll_dir
    let module_dir = module_path.parent()?;
    let dll_dir = module_dir.to_path_buf();

    // For VST3 bundles, we need to find the Contents directory
    // Structure: <Bundle>.vst3/Contents/<arch>/<plugin>.vst3
    // We want cwd_dir = <Bundle>.vst3/Contents
    let mut cwd_dir = dll_dir.clone();
    let mut bundle_root: Option<PathBuf> = None;

    // Walk up to find the .vst3 bundle root
    let mut current = module_dir;
    while let Some(parent) = current.parent() {
        if let Some(name) = current.file_name() {
            let name_str = name.to_string_lossy();
            if name_str.to_lowercase().ends_with(".vst3") && current.is_dir() {
                bundle_root = Some(current.to_path_buf());
                break;
            }
        }
        current = parent;
    }

    // If we found a bundle root, set cwd_dir to Contents
    if let Some(ref root) = bundle_root {
        let contents = root.join("Contents");
        if contents.exists() {
            cwd_dir = contents;
        }
    }

    // 3) 参考ログ（Resourcesの存在確認）
    // Check multiple possible locations for resources
    let resources_candidates = [
        cwd_dir.join("Resources"), // <bundle>/Contents/Resources
        bundle_root
            .as_ref()
            .map(|r| r.join("Contents").join("Resources"))
            .unwrap_or_default(),
        dll_dir.join("Resources"), // Fallback
    ];

    let mut resources_dir = cwd_dir.join("Resources");
    for candidate in &resources_candidates {
        if candidate.exists() && candidate.is_dir() {
            resources_dir = candidate.clone();
            break;
        }
    }

    println!(
        "[EditorEnv] resolved_module={:?} resources_exists={} (resources={:?}) bundle_root={:?}",
        module_path,
        resources_dir.exists(),
        resources_dir,
        bundle_root
    );

    Some((cwd_dir, dll_dir))
}

fn path_to_wide_null(path: &Path) -> Vec<u16> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    wide
}

unsafe fn get_dll_directory_wide() -> Option<Vec<u16>> {
    // GetDllDirectoryW は終端NULを含まない文字数を返す
    let len = GetDllDirectoryW(None);
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u16; (len as usize) + 1];
    let copied = GetDllDirectoryW(Some(buf.as_mut_slice()));
    if copied == 0 {
        None
    } else {
        // 念のため終端NULを保証
        if buf.last().copied().unwrap_or(0) != 0 {
            buf.push(0);
        }
        Some(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_environment_restores_baseline_in_isolated_process() {
        const CHILD: &str = "AURALYN_EDITOR_ENV_TEST_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let name = format!(
                "{}::nested_environment_restores_baseline_in_isolated_process",
                module_path!().split_once("::").unwrap().1
            );
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--test-threads=1"])
                .env(CHILD, "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        // CWDはプロセス全体に作用するため、他のテストと同じプロセスでは変更しない。
        let baseline_cwd = std::env::current_dir().unwrap();
        let baseline_dll = unsafe { get_dll_directory_wide() };
        let root = std::env::temp_dir().join(format!("auralyn-editor-env-{}", std::process::id()));
        let first_dir = root.join("first");
        let second_dir = root.join("second");
        std::fs::create_dir_all(&first_dir).unwrap();
        std::fs::create_dir(&second_dir).unwrap();
        let first = EditorEnvGuard::enter(&first_dir, &first_dir);
        let second = EditorEnvGuard::enter(&second_dir, &second_dir);
        drop(first);
        assert_eq!(std::env::current_dir().unwrap(), second_dir);
        drop(second);
        assert_eq!(std::env::current_dir().unwrap(), baseline_cwd);
        assert_eq!(unsafe { get_dll_directory_wide() }, baseline_dll);
        std::fs::remove_dir(first_dir).unwrap();
        std::fs::remove_dir(second_dir).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
