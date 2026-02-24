use anyhow::{anyhow, Context, Result};
use libloading::{Library, Symbol};
use std::ffi::{c_char, c_void};
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::{collections::HashMap, ffi::CStr};
use vst3::Interface;

use std::os::windows::ffi::OsStrExt;
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    RedrawWindow, UpdateWindow, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME, RDW_INVALIDATE,
};
use windows::Win32::System::LibraryLoader::{GetDllDirectoryW, SetDllDirectoryW};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, EnumChildWindows, FindWindowExW, GetAncestor, GetClassNameW, GetClientRect,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, SetClassLongPtrW, SetWindowLongPtrW,
    SetWindowPos, GA_ROOT, GCLP_HMODULE, GWLP_HINSTANCE, GWL_EXSTYLE, GWL_STYLE, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOZORDER, WINDOW_EX_STYLE, WINDOW_STYLE,
};

use crate::vst_host::c_api::{
    AudioBusBuffers, FUnknownVtbl, IAudioProcessorVtbl, IBStreamVtbl, IComponentHandler2Vtbl,
    IComponentVtbl, IConnectionPointVtbl, IEditControllerVtbl, IHostApplicationVtbl,
    IPlugFrameVtbl, IPlugViewVtbl, IPluginFactoryVtbl, ITimerHandlerVtbl, PClassInfo, ProcessData,
    TResult, ViewRect, K_REALTIME, K_RESULT_OK, K_SAMPLE_32, TUID,
};

const K_NO_INTERFACE: TResult = -2147467262;
const K_INVALID_ARGUMENT: TResult = -2147467261;
const K_RESULT_FALSE: TResult = 1;

fn vst_trace_enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("AURALYN_VST_TRACE").is_some())
}

// `println!` in this module must never write to stdout (stdout is reserved for IPC framing in `audio_engine`).
// Also, VST3 callbacks can be invoked from real-time contexts; default is "quiet" unless explicitly enabled.
#[allow(unused_macros)]
macro_rules! println {
    ($($tt:tt)*) => {{
        if vst_trace_enabled() {
            eprintln!($($tt)*);
        }
    }};
}

fn env_flag(name: &str) -> bool {
    let Some(v) = std::env::var_os(name) else {
        return false;
    };
    let v = v.to_string_lossy().to_ascii_lowercase();
    v == "1" || v == "true" || v == "yes" || v == "on"
}

const HOST_NAME_MAX_U16: usize = 128;

fn encode_host_name_u16(name: &str) -> [u16; HOST_NAME_MAX_U16] {
    let mut buf = [0u16; HOST_NAME_MAX_U16];
    let mut i = 0usize;
    for ch in name.encode_utf16() {
        if i + 1 >= HOST_NAME_MAX_U16 {
            break;
        }
        buf[i] = ch;
        i += 1;
    }
    buf[i] = 0;
    buf
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConnectionOrder {
    ComponentFirst,
    ControllerFirst,
}

unsafe fn link_connection_points(
    component_ptr: *mut c_void,
    controller_ptr: *mut c_void,
    order: ConnectionOrder,
    log_prefix: &str,
) {
    if component_ptr.is_null() || controller_ptr.is_null() {
        return;
    }

    let (prefix, sep) = if log_prefix.is_empty() {
        ("", "")
    } else {
        (log_prefix, " ")
    };

    let iid_cp = vst3::Steinberg::Vst::IConnectionPoint::IID;

    let mut comp_cp: *mut c_void = std::ptr::null_mut();
    let mut ctrl_cp: *mut c_void = std::ptr::null_mut();

    let comp_unknown = get_vtbl::<FUnknownVtbl>(component_ptr);
    let ctrl_unknown = get_vtbl::<FUnknownVtbl>(controller_ptr);

    let res_comp = (comp_unknown.query_interface)(
        component_ptr,
        &iid_cp as *const _ as *const TUID,
        &mut comp_cp,
    );
    let res_ctrl = (ctrl_unknown.query_interface)(
        controller_ptr,
        &iid_cp as *const _ as *const TUID,
        &mut ctrl_cp,
    );

    println!(
        "{prefix}{sep}IConnectionPoint QI res_comp={res_comp} res_ctrl={res_ctrl} comp_cp={comp_cp:p} ctrl_cp={ctrl_cp:p}"
    );

    if res_comp != K_RESULT_OK || comp_cp.is_null() || res_ctrl != K_RESULT_OK || ctrl_cp.is_null()
    {
        // Release partial success to avoid leaking references.
        if res_comp == K_RESULT_OK && !comp_cp.is_null() {
            let vtbl = get_vtbl::<IConnectionPointVtbl>(comp_cp);
            (vtbl.base.release)(comp_cp);
        }
        if res_ctrl == K_RESULT_OK && !ctrl_cp.is_null() {
            let vtbl = get_vtbl::<IConnectionPointVtbl>(ctrl_cp);
            (vtbl.base.release)(ctrl_cp);
        }

        println!("{prefix}{sep}IConnectionPoint Link Skipped (Comp={res_comp}, Ctrl={res_ctrl})");
        return;
    }

    println!("{prefix}{sep}Linking Component and Controller via IConnectionPoint...");

    let comp_cp_vtbl = get_vtbl::<IConnectionPointVtbl>(comp_cp);
    let ctrl_cp_vtbl = get_vtbl::<IConnectionPointVtbl>(ctrl_cp);

    match order {
        ConnectionOrder::ControllerFirst => {
            println!("{prefix}{sep}Order: Controller->Component, then Component->Controller");
            let r2 = (ctrl_cp_vtbl.connect)(ctrl_cp, comp_cp);
            let r1 = (comp_cp_vtbl.connect)(comp_cp, ctrl_cp);
            println!("{prefix}{sep}Controller->Component: {r2}");
            println!("{prefix}{sep}Component->Controller: {r1}");
        }
        ConnectionOrder::ComponentFirst => {
            println!("{prefix}{sep}Order: Component->Controller, then Controller->Component");
            let r1 = (comp_cp_vtbl.connect)(comp_cp, ctrl_cp);
            let r2 = (ctrl_cp_vtbl.connect)(ctrl_cp, comp_cp);
            println!("{prefix}{sep}Component->Controller: {r1}");
            println!("{prefix}{sep}Controller->Component: {r2}");
        }
    }

    (comp_cp_vtbl.base.release)(comp_cp);
    (ctrl_cp_vtbl.base.release)(ctrl_cp);
}

unsafe fn unlink_connection_points(component_ptr: *mut c_void, controller_ptr: *mut c_void) {
    if component_ptr.is_null() || controller_ptr.is_null() {
        return;
    }

    let iid_cp = vst3::Steinberg::Vst::IConnectionPoint::IID;
    let mut comp_cp: *mut c_void = std::ptr::null_mut();
    let mut ctrl_cp: *mut c_void = std::ptr::null_mut();
    let comp_unknown = get_vtbl::<FUnknownVtbl>(component_ptr);
    let ctrl_unknown = get_vtbl::<FUnknownVtbl>(controller_ptr);

    let res_comp = (comp_unknown.query_interface)(
        component_ptr,
        &iid_cp as *const _ as *const TUID,
        &mut comp_cp,
    );
    let res_ctrl = (ctrl_unknown.query_interface)(
        controller_ptr,
        &iid_cp as *const _ as *const TUID,
        &mut ctrl_cp,
    );

    if res_comp != K_RESULT_OK || comp_cp.is_null() || res_ctrl != K_RESULT_OK || ctrl_cp.is_null()
    {
        if res_comp == K_RESULT_OK && !comp_cp.is_null() {
            (get_vtbl::<IConnectionPointVtbl>(comp_cp).base.release)(comp_cp);
        }
        if res_ctrl == K_RESULT_OK && !ctrl_cp.is_null() {
            (get_vtbl::<IConnectionPointVtbl>(ctrl_cp).base.release)(ctrl_cp);
        }
        return;
    }

    eprintln!("BP: Unlinking Connection Points...");
    let comp_cp_vtbl = get_vtbl::<IConnectionPointVtbl>(comp_cp);
    let ctrl_cp_vtbl = get_vtbl::<IConnectionPointVtbl>(ctrl_cp);

    // Disconnect both directions
    (comp_cp_vtbl.disconnect)(comp_cp, ctrl_cp);
    (ctrl_cp_vtbl.disconnect)(ctrl_cp, comp_cp);

    (comp_cp_vtbl.base.release)(comp_cp);
    (ctrl_cp_vtbl.base.release)(ctrl_cp);
}

#[derive(Debug)]
struct EditorEnvGuard {
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
        let (id, cwd_apply, dll_apply) = {
            let mut mgr = editor_env_manager().lock().unwrap();

            if mgr.stack.is_empty() {
                mgr.baseline_cwd = std::env::current_dir().ok();
                mgr.baseline_dll_dir = unsafe { get_dll_directory_wide() };
            }

            mgr.next_id = mgr.next_id.wrapping_add(1);
            let id = mgr.next_id;
            mgr.stack
                .push((id, cwd_dir.to_path_buf(), dll_dir.to_path_buf()));
            (id, cwd_dir.to_path_buf(), dll_dir.to_path_buf())
        };

        apply_editor_env(&cwd_apply, &dll_apply);
        Self { id }
    }

    fn enter_for_module(module_path: &Path) -> Option<Self> {
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
        let (next_dir, baseline) = {
            let mut mgr = editor_env_manager().lock().unwrap();
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
                        .map(|x| x.path().extension().map_or(false, |ext| ext == "vst3"))
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

#[derive(Clone, Copy, Debug)]
struct EditorViewState {
    top_hwnd: isize,
    container_hwnd: isize,
    plugin_hwnd: isize,
    last_good_w: i32,
    last_good_h: i32,
}

fn editor_view_state_map() -> &'static Mutex<HashMap<usize, EditorViewState>> {
    static MAP: OnceLock<Mutex<HashMap<usize, EditorViewState>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn debug_dump_hwnd_children(root: HWND, max: usize) {
    #[derive(Clone, Copy)]
    struct Ctx {
        count: usize,
        max: usize,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);
        if ctx.count >= ctx.max {
            return BOOL(0);
        }
        ctx.count += 1;

        let mut class_buf = [0u16; 128];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);

        let mut text_buf = [0u16; 256];
        let text_len = GetWindowTextW(hwnd, &mut text_buf);
        let title = if text_len > 0 {
            String::from_utf16_lossy(&text_buf[..text_len as usize])
        } else {
            String::new()
        };

        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);

        println!(
            "[HWND] child#{:02} hwnd={:?} class='{}' title='{}' rect=({},{} {}x{})",
            ctx.count,
            hwnd,
            class_name,
            title,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top
        );

        BOOL(1)
    }

    unsafe {
        let mut client = RECT::default();
        let _ = GetClientRect(root, &mut client);
        println!(
            "[HWND] root={:?} client={}x{}",
            root,
            client.right - client.left,
            client.bottom - client.top
        );

        let mut ctx = Ctx { count: 0, max };
        let _ = EnumChildWindows(
            Some(root),
            Some(enum_proc),
            LPARAM((&mut ctx as *mut Ctx) as isize),
        );
    }
}

fn register_editor_view(view: *mut c_void, container_hwnd: isize) {
    let top_hwnd = unsafe {
        let container = HWND(container_hwnd as *mut c_void);
        let top = GetAncestor(container, GA_ROOT);
        if top.0.is_null() {
            container_hwnd
        } else {
            top.0 as isize
        }
    };

    let mut map = editor_view_state_map().lock().unwrap();
    map.insert(
        view as usize,
        EditorViewState {
            top_hwnd,
            container_hwnd,
            plugin_hwnd: 0,
            last_good_w: 0,
            last_good_h: 0,
        },
    );
}

#[allow(dead_code)]
fn update_editor_view_plugin_hwnd(view: *mut c_void, plugin_hwnd: isize) {
    let mut map = editor_view_state_map().lock().unwrap();
    if let Some(state) = map.get_mut(&(view as usize)) {
        state.plugin_hwnd = plugin_hwnd;
    }
}

fn update_editor_view_last_size(view: *mut c_void, w: i32, h: i32) {
    let mut map = editor_view_state_map().lock().unwrap();
    if let Some(state) = map.get_mut(&(view as usize)) {
        state.last_good_w = w;
        state.last_good_h = h;
    }
}

fn unregister_editor_view(view: *mut c_void) {
    let mut map = editor_view_state_map().lock().unwrap();
    map.remove(&(view as usize));
}

fn get_editor_view_state(view: *mut c_void) -> Option<EditorViewState> {
    let map = editor_view_state_map().lock().unwrap();
    map.get(&(view as usize)).copied()
}

unsafe fn resize_hwnd_client(hwnd: isize, client_w: i32, client_h: i32) -> bool {
    if client_w <= 0 || client_h <= 0 {
        return false;
    }

    let hwnd = HWND(hwnd as *mut c_void);
    let style = WINDOW_STYLE(GetWindowLongPtrW(hwnd, GWL_STYLE) as u32);
    let ex_style = WINDOW_EX_STYLE(GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32);

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: client_w,
        bottom: client_h,
    };

    // 非クライアント領域を足して「外側サイズ」に変換
    let ok = AdjustWindowRectEx(&mut rect, style, false, ex_style).is_ok();
    if !ok {
        return false;
    }

    let outer_w = rect.right - rect.left;
    let outer_h = rect.bottom - rect.top;

    SetWindowPos(
        hwnd,
        None,
        0,
        0,
        outer_w,
        outer_h,
        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
    )
    .is_ok()
}

unsafe fn resize_child_hwnd(client_hwnd: isize, client_w: i32, client_h: i32) -> bool {
    if client_w <= 0 || client_h <= 0 {
        return false;
    }

    let hwnd = HWND(client_hwnd as *mut c_void);
    SetWindowPos(
        hwnd,
        None,
        0,
        0,
        client_w,
        client_h,
        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
    )
    .is_ok()
}

unsafe fn move_resize_child_hwnd(child_hwnd: isize, x: i32, y: i32, w: i32, h: i32) -> bool {
    if w <= 0 || h <= 0 {
        return false;
    }
    let hwnd = HWND(child_hwnd as *mut c_void);
    SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE).is_ok()
}

fn hwnd_class_name(hwnd: HWND) -> String {
    let mut class_buf = [0u16; 128];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    if class_len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&class_buf[..class_len as usize])
}

#[allow(dead_code)]
fn find_primary_plugin_child_hwnd(container: HWND) -> Option<HWND> {
    unsafe {
        let mut current: HWND =
            FindWindowExW(Some(container), None, PCWSTR::null(), PCWSTR::null())
                .unwrap_or(HWND(std::ptr::null_mut()));
        let mut first: Option<HWND> = None;
        let mut best: Option<HWND> = None;

        for _ in 0..64 {
            if current.0.is_null() {
                break;
            }
            if first.is_none() {
                first = Some(current);
            }

            let class_name = hwnd_class_name(current);
            if class_name.starts_with("VSTGUI") || class_name.starts_with("JUCE") {
                best = Some(current);
                break;
            }

            current = FindWindowExW(
                Some(container),
                Some(current),
                PCWSTR::null(),
                PCWSTR::null(),
            )
            .unwrap_or(HWND(std::ptr::null_mut()));
        }

        best.or(first)
    }
}

// Constants for IIDs (Little Endian bytes from VST3 SDK)
// Helper to cast
unsafe fn get_vtbl<T>(ptr: *mut c_void) -> &'static T {
    &**(ptr as *mut *mut T)
}

// Type alias for the entry point
type GetPluginFactory = unsafe extern "C" fn() -> *mut c_void;

// Imports cleaned up in main block
// use crate::vst_host::c_api::{IEditControllerVtbl, IPlugViewVtbl, ViewRect, IComponentHandlerVtbl, IComponentHandler2Vtbl};

// --- Mock Component Handler ---
// --- Mock IContextMenu & IParameterFinder ---
unsafe extern "system" fn context_menu_query_interface(
    _this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> i32 {
    let iid_slice = *iid;
    if iid_slice == crate::vst_host::c_api::IID_IUNKNOWN
        || iid_slice == crate::vst_host::c_api::IID_ICONTEXTMENU
    {
        *obj = _this;
        return K_RESULT_OK;
    }
    K_NO_INTERFACE
}
unsafe extern "system" fn context_menu_add_ref(_this: *mut c_void) -> u32 {
    1
}
unsafe extern "system" fn context_menu_release(_this: *mut c_void) -> u32 {
    1
}
unsafe extern "system" fn context_menu_get_item_count(
    _this: *mut c_void,
    _param_id: *const u32,
) -> i32 {
    0
}
unsafe extern "system" fn context_menu_get_context_item(
    _this: *mut c_void,
    _param_id: *const u32,
    _tag: i32,
    _item: *mut c_void,
) -> i32 {
    K_RESULT_FALSE
}
unsafe extern "system" fn context_menu_add_item(
    _this: *mut c_void,
    _item: *const c_void,
    _target: *mut c_void,
) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn context_menu_remove_item(
    _this: *mut c_void,
    _item: *const c_void,
    _target: *mut c_void,
) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn context_menu_popup(_this: *mut c_void, _x: i32, _y: i32) -> i32 {
    K_RESULT_OK
}

static mut MOCK_CONTEXT_MENU_VTBL: crate::vst_host::c_api::IContextMenuVtbl =
    crate::vst_host::c_api::IContextMenuVtbl {
        base: FUnknownVtbl {
            query_interface: context_menu_query_interface,
            add_ref: context_menu_add_ref,
            release: context_menu_release,
        },
        get_item_count: context_menu_get_item_count,
        get_context_menu_item: context_menu_get_context_item,
        add_item: context_menu_add_item,
        remove_item: context_menu_remove_item,
        popup: context_menu_popup,
    };

#[repr(C)]
struct MockContextMenu {
    vtbl: *const crate::vst_host::c_api::IContextMenuVtbl,
}
static mut GLOBAL_MOCK_CONTEXT_MENU: MockContextMenu = MockContextMenu {
    vtbl: std::ptr::null(),
};

fn get_mock_context_menu_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_MOCK_CONTEXT_MENU.vtbl.is_null() {
            GLOBAL_MOCK_CONTEXT_MENU.vtbl = &raw const MOCK_CONTEXT_MENU_VTBL;
        }
        &raw mut GLOBAL_MOCK_CONTEXT_MENU as *mut c_void
    }
}

// --- Mock IParameterFinder ---
unsafe extern "system" fn param_finder_query_interface(
    _this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> i32 {
    let iid_slice = *iid;
    if iid_slice == crate::vst_host::c_api::IID_IUNKNOWN
        || iid_slice == crate::vst_host::c_api::IID_IPARAMETERFINDER
    {
        *obj = _this;
        return K_RESULT_OK;
    }
    K_NO_INTERFACE
}
unsafe extern "system" fn param_finder_add_ref(_this: *mut c_void) -> u32 {
    1
}
unsafe extern "system" fn param_finder_release(_this: *mut c_void) -> u32 {
    1
}
unsafe extern "system" fn param_finder_find_parameter(
    _this: *mut c_void,
    _x: i32,
    _y: i32,
    _result_tag: *mut u32,
) -> i32 {
    K_RESULT_FALSE
}

static mut MOCK_PARAM_FINDER_VTBL: crate::vst_host::c_api::IParameterFinderVtbl =
    crate::vst_host::c_api::IParameterFinderVtbl {
        base: FUnknownVtbl {
            query_interface: param_finder_query_interface,
            add_ref: param_finder_add_ref,
            release: param_finder_release,
        },
        find_parameter: param_finder_find_parameter,
    };

#[repr(C)]
struct MockParameterFinder {
    vtbl: *const crate::vst_host::c_api::IParameterFinderVtbl,
}
static mut GLOBAL_MOCK_PARAM_FINDER: MockParameterFinder = MockParameterFinder {
    vtbl: std::ptr::null(),
};

fn get_mock_param_finder_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_MOCK_PARAM_FINDER.vtbl.is_null() {
            GLOBAL_MOCK_PARAM_FINDER.vtbl = &raw const MOCK_PARAM_FINDER_VTBL;
        }
        &raw mut GLOBAL_MOCK_PARAM_FINDER as *mut c_void
    }
}

unsafe extern "system" fn host_query_interface(
    _this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> i32 {
    println!("Host::query_interface called");
    if iid.is_null() || obj.is_null() {
        return K_INVALID_ARGUMENT;
    }

    // Default to null unless we match something.
    *obj = std::ptr::null_mut();

    let iid_slice = unsafe { *iid };

    use vst3::Interface;
    use vst3::Steinberg::FUnknown;
    use vst3::Steinberg::Vst::IComponentHandler;
    use vst3::Steinberg::Vst::IComponentHandler2; // Use this

    let i_u = FUnknown::IID;
    let i_ch = IComponentHandler::IID;
    let i_ch2 = IComponentHandler2::IID;
    let i_al = vst3::Steinberg::Vst::IAttributeList::IID;

    let i_pf = vst3::Steinberg::IPlugFrame::IID;
    let i_ha = vst3::Steinberg::Vst::IHostApplication::IID;
    let i_ps = crate::vst_host::c_api::IID_IPLUGINTERFACESUPPORT;

    // Helper to format GUID for logging (only when tracing is enabled)
    let guid_debug = if vst_trace_enabled() {
        Some(format!(
            "{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
            iid_slice[0], iid_slice[1], iid_slice[2], iid_slice[3],
            iid_slice[4], iid_slice[5],
            iid_slice[6], iid_slice[7],
            iid_slice[8], iid_slice[9],
            iid_slice[10], iid_slice[11], iid_slice[12], iid_slice[13], iid_slice[14], iid_slice[15]
        ))
    } else {
        None
    };

    if let Some(ref g) = guid_debug {
        println!("Host::query_interface: {}", g);
    }

    if iid_slice == i_u {
        *obj = _this;
        return K_RESULT_OK;
    }

    if iid_slice == i_ch {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IComponentHandler ({})", g);
        }
        *obj = get_mock_handler_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == i_ch2 {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IComponentHandler2 ({})", g);
        }
        *obj = get_mock_handler_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == i_pf {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IPlugFrame ({})", g);
        }
        *obj = get_mock_plug_frame_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == crate::vst_host::c_api::IID_ICONTEXTMENU {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IContextMenu ({})", g);
        }
        *obj = get_mock_context_menu_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == crate::vst_host::c_api::IID_IPARAMETERFINDER {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IParameterFinder ({})", g);
        }
        *obj = get_mock_param_finder_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == i_ha {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IHostApplication ({})", g);
        }
        *obj = get_mock_host_app_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == i_al {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IAttributeList ({})", g);
        }
        *obj = new_mock_attribute_list();
        return K_RESULT_OK;
    }

    if iid_slice == i_ps {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IPlugInterfaceSupport ({})", g);
        }
        *obj = get_mock_plug_interface_support_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == crate::vst_host::c_api::IID_IUNITHANDLER {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IUnitHandler ({})", g);
        }
        *obj = get_mock_unit_handler_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == crate::vst_host::c_api::IID_ICOMPONENTHANDLER {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched IComponentHandler (v1) ({})", g);
        }
        *obj = get_mock_handler_ptr();
        return K_RESULT_OK;
    }

    if iid_slice == crate::vst_host::c_api::IID_ITIMERHANDLER {
        if let Some(ref g) = guid_debug {
            println!("  -> Matched ITimerHandler ({})", g);
        }
        *obj = get_mock_timer_handler_ptr();
        return K_RESULT_OK;
    }

    // Known other interfaces to check against?
    // e.g. IParamValueQueue? IUnitInfo?

    if let Some(ref g) = guid_debug {
        println!(
            "  -> Interface NOT SUPPORTED: {}. Returning kNoInterface.",
            g
        );
    }
    K_NO_INTERFACE
}

unsafe extern "system" fn host_add_ref(_this: *mut c_void) -> u32 {
    1
}
unsafe extern "system" fn host_release(_this: *mut c_void) -> u32 {
    1
}
// [Removed unused host functions]

// --- ITimerHandler Implementation ---
unsafe extern "system" fn timer_on_timer(_this: *mut c_void, _id: *mut c_void) -> TResult {
    // We don't need to do anything, just acknowledge the call so the plugin
    // knows the message processing hook is alive.
    0 // kResultOk
}

static mut MOCK_TIMER_HANDLER_VTBL: ITimerHandlerVtbl = ITimerHandlerVtbl {
    base: FUnknownVtbl {
        query_interface: host_query_interface,
        add_ref: host_add_ref,
        release: host_release,
    },
    on_timer: timer_on_timer,
};

#[repr(C)]
struct MockTimerHandler {
    vtbl: *const ITimerHandlerVtbl,
}
static mut GLOBAL_MOCK_TIMER_HANDLER: MockTimerHandler = MockTimerHandler {
    vtbl: std::ptr::null(),
};
fn get_mock_timer_handler_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_MOCK_TIMER_HANDLER.vtbl.is_null() {
            GLOBAL_MOCK_TIMER_HANDLER.vtbl = &raw const MOCK_TIMER_HANDLER_VTBL;
        }
        std::ptr::addr_of_mut!(GLOBAL_MOCK_TIMER_HANDLER) as *mut c_void
    }
}

// --- Memory Stream ---
#[repr(C)]
struct MemoryStream {
    vtbl: *const IBStreamVtbl,
    data: Vec<u8>,
    cursor: usize,
    ref_count: u32,
}

impl MemoryStream {
    fn new() -> Self {
        Self {
            vtbl: &raw const MEMORY_STREAM_VTBL,
            data: Vec::new(),
            cursor: 0,
            ref_count: 1,
        }
    }
}

unsafe extern "system" fn stream_query_interface(
    this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> TResult {
    let iid_slice = *iid;
    let i_u = vst3::Steinberg::FUnknown::IID;
    let i_s = vst3::Steinberg::IBStream::IID;

    if iid_slice == i_u || iid_slice == i_s {
        println!("Stream::query_interface matched IBStream/FUnknown");
        stream_add_ref(this);
        *obj = this;
        return 0;
    }

    println!("Stream::query_interface unmatched IID: {:02X?}{:02X?}{:02X?}{:02X?}-{:02X?}{:02X?}-{:02X?}{:02X?}-{:02X?}{:02X?}-{:02X?}{:02X?}{:02X?}{:02X?}{:02X?}{:02X?}",
        iid_slice[0], iid_slice[1], iid_slice[2], iid_slice[3],
        iid_slice[4], iid_slice[5],
        iid_slice[6], iid_slice[7],
        iid_slice[8], iid_slice[9],
        iid_slice[10], iid_slice[11], iid_slice[12], iid_slice[13], iid_slice[14], iid_slice[15]
    );

    if !obj.is_null() {
        *obj = std::ptr::null_mut();
    }
    -2147467262 // kNoInterface
}

unsafe extern "system" fn stream_add_ref(this: *mut c_void) -> u32 {
    let stream = &mut *(this as *mut MemoryStream);
    stream.ref_count += 1;
    println!("Stream::add_ref -> {}", stream.ref_count);
    stream.ref_count
}
unsafe extern "system" fn stream_release(this: *mut c_void) -> u32 {
    let stream = &mut *(this as *mut MemoryStream);
    stream.ref_count -= 1;
    println!("Stream::release -> {}", stream.ref_count);
    stream.ref_count
}
unsafe extern "system" fn stream_read(
    this: *mut c_void,
    buffer: *mut c_void,
    num_bytes: i32,
    num_bytes_read: *mut i32,
) -> TResult {
    let stream = &mut *(this as *mut MemoryStream);
    let available = if stream.cursor < stream.data.len() {
        stream.data.len() - stream.cursor
    } else {
        0
    };
    let to_read = std::cmp::min(available, num_bytes as usize);

    println!(
        "Stream::read req={} avail={} actual={}",
        num_bytes, available, to_read
    );

    if to_read > 0 {
        std::ptr::copy_nonoverlapping(
            stream.data.as_ptr().add(stream.cursor),
            buffer as *mut u8,
            to_read,
        );
        stream.cursor += to_read;
    }

    if !num_bytes_read.is_null() {
        *num_bytes_read = to_read as i32;
    }
    0 // kResultOk
}
unsafe extern "system" fn stream_write(
    this: *mut c_void,
    buffer: *const c_void,
    num_bytes: i32,
    num_bytes_written: *mut i32,
) -> TResult {
    let stream = &mut *(this as *mut MemoryStream);
    println!("Stream::write req={}", num_bytes);
    let bytes = std::slice::from_raw_parts(buffer as *const u8, num_bytes as usize);

    // Write at cursor position
    let end_pos = stream.cursor + bytes.len();
    if end_pos > stream.data.len() {
        stream.data.resize(end_pos, 0);
    }
    stream.data[stream.cursor..end_pos].copy_from_slice(bytes);
    stream.cursor += bytes.len();

    if !num_bytes_written.is_null() {
        *num_bytes_written = num_bytes as i32;
    }
    0 // kResultOk
}
unsafe extern "system" fn stream_seek(
    this: *mut c_void,
    pos: i64,
    mode: i32,
    result_pos: *mut i64,
) -> TResult {
    let stream = &mut *(this as *mut MemoryStream);
    println!("Stream::seek pos={} mode={}", pos, mode);
    let new_pos = match mode {
        0 => pos,                            // kIBSeekSet
        1 => stream.cursor as i64 + pos,     // kIBSeekCur
        2 => stream.data.len() as i64 + pos, // kIBSeekEnd
        _ => stream.cursor as i64,
    };

    if new_pos < 0 {
        return -1;
    }
    stream.cursor = new_pos as usize;

    if !result_pos.is_null() {
        *result_pos = new_pos;
    }
    0
}
unsafe extern "system" fn stream_tell(this: *mut c_void, pos: *mut i64) -> TResult {
    let stream = &mut *(this as *mut MemoryStream);
    if !pos.is_null() {
        *pos = stream.cursor as i64;
    }
    // println!("Stream::tell -> {}", stream.cursor);
    0
}

static mut MEMORY_STREAM_VTBL: IBStreamVtbl = IBStreamVtbl {
    base: FUnknownVtbl {
        query_interface: stream_query_interface,
        add_ref: stream_add_ref,
        release: stream_release,
    },
    read: stream_read,
    write: stream_write,
    seek: stream_seek,
    tell: stream_tell,
};

// --- Host Created Objects (IMessage / IAttributeList) ---
// Insight 2 requests IMessage instances from IHostApplication::create_instance during connect/init.
// If we return kNoInterface, the plugin may crash. Provide minimal working objects.

type AttrID = *const c_char;
type FIDString = *const c_char;
type TChar = u16; // VST3: UTF-16 on Windows

#[repr(C)]
struct IAttributeListVtbl {
    base: FUnknownVtbl,
    set_int: unsafe extern "system" fn(this: *mut c_void, id: AttrID, value: i64) -> TResult,
    get_int: unsafe extern "system" fn(this: *mut c_void, id: AttrID, value: *mut i64) -> TResult,
    set_float: unsafe extern "system" fn(this: *mut c_void, id: AttrID, value: f64) -> TResult,
    get_float: unsafe extern "system" fn(this: *mut c_void, id: AttrID, value: *mut f64) -> TResult,
    set_string:
        unsafe extern "system" fn(this: *mut c_void, id: AttrID, string: *const TChar) -> TResult,
    get_string: unsafe extern "system" fn(
        this: *mut c_void,
        id: AttrID,
        string: *mut TChar,
        size_in_bytes: u32,
    ) -> TResult,
    set_binary: unsafe extern "system" fn(
        this: *mut c_void,
        id: AttrID,
        data: *const c_void,
        size_in_bytes: u32,
    ) -> TResult,
    get_binary: unsafe extern "system" fn(
        this: *mut c_void,
        id: AttrID,
        data: *mut *const c_void,
        size_in_bytes: *mut u32,
    ) -> TResult,
}

#[derive(Clone, Debug)]
enum AttrValue {
    Int(i64),
    Float(f64),
    String(Vec<u16>),
    Binary(Vec<u8>),
}

#[repr(C)]
struct MockAttributeList {
    vtbl: *const IAttributeListVtbl,
    ref_count: AtomicU32,
    map: Mutex<HashMap<String, AttrValue>>,
}

unsafe impl Send for MockAttributeList {}
unsafe impl Sync for MockAttributeList {}

unsafe fn attr_key(id: AttrID) -> Option<String> {
    if id.is_null() {
        return None;
    }
    let s = CStr::from_ptr(id).to_string_lossy().into_owned();
    Some(s)
}

unsafe extern "system" fn attr_query_interface(
    this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> TResult {
    if obj.is_null() {
        return K_INVALID_ARGUMENT;
    }
    *obj = std::ptr::null_mut();
    if iid.is_null() {
        return K_INVALID_ARGUMENT;
    }

    use vst3::Steinberg::FUnknown;
    use vst3::Steinberg::Vst::IAttributeList as VstIAttributeList;

    let iid_slice = *iid;
    if iid_slice == FUnknown::IID || iid_slice == VstIAttributeList::IID {
        *obj = this;
        // add_ref
        let me = this as *mut MockAttributeList;
        (*me).ref_count.fetch_add(1, Ordering::Relaxed);
        return K_RESULT_OK;
    }

    K_NO_INTERFACE
}

unsafe extern "system" fn attr_add_ref(this: *mut c_void) -> u32 {
    let me = this as *mut MockAttributeList;
    (*me).ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn attr_release(this: *mut c_void) -> u32 {
    let me = this as *mut MockAttributeList;
    let prev = (*me).ref_count.fetch_sub(1, Ordering::Release);
    let next = prev.saturating_sub(1);
    if next == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(me));
    }
    next
}

unsafe extern "system" fn attr_set_int(this: *mut c_void, id: AttrID, value: i64) -> TResult {
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    let me = this as *mut MockAttributeList;
    if let Ok(mut m) = (*me).map.lock() {
        m.insert(k, AttrValue::Int(value));
        return K_RESULT_OK;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_get_int(this: *mut c_void, id: AttrID, value: *mut i64) -> TResult {
    if value.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    println!("[IAttributeList] get_int key=\"{}\"", k);
    let me = this as *mut MockAttributeList;
    if let Ok(m) = (*me).map.lock() {
        if let Some(AttrValue::Int(v)) = m.get(&k) {
            println!("[IAttributeList]   -> found: {}", v);
            *value = *v;
            return K_RESULT_OK;
        }
        println!("[IAttributeList]   -> NOT FOUND");
        return K_RESULT_FALSE;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_set_float(this: *mut c_void, id: AttrID, value: f64) -> TResult {
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    let me = this as *mut MockAttributeList;
    if let Ok(mut m) = (*me).map.lock() {
        m.insert(k, AttrValue::Float(value));
        return K_RESULT_OK;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_get_float(
    this: *mut c_void,
    id: AttrID,
    value: *mut f64,
) -> TResult {
    if value.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    println!("[IAttributeList] get_float key=\"{}\"", k);
    let me = this as *mut MockAttributeList;
    if let Ok(m) = (*me).map.lock() {
        if let Some(AttrValue::Float(v)) = m.get(&k) {
            println!("[IAttributeList]   -> found: {}", v);
            *value = *v;
            return K_RESULT_OK;
        }
        println!("[IAttributeList]   -> NOT FOUND");
        return K_RESULT_FALSE;
    }
    K_RESULT_FALSE
}

unsafe fn read_tchar_z(ptr: *const TChar) -> Vec<u16> {
    if ptr.is_null() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 0usize;
    loop {
        let ch = *ptr.add(i);
        if ch == 0 {
            break;
        }
        out.push(ch);
        i += 1;
        if i > 16 * 1024 {
            break;
        }
    }
    out
}

unsafe extern "system" fn attr_set_string(
    this: *mut c_void,
    id: AttrID,
    string: *const TChar,
) -> TResult {
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    let me = this as *mut MockAttributeList;
    let v = read_tchar_z(string);
    if let Ok(mut m) = (*me).map.lock() {
        m.insert(k, AttrValue::String(v));
        return K_RESULT_OK;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_get_string(
    this: *mut c_void,
    id: AttrID,
    string: *mut TChar,
    size_in_bytes: u32,
) -> TResult {
    if string.is_null() || size_in_bytes < 2 {
        return K_INVALID_ARGUMENT;
    }
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    println!("[IAttributeList] get_string key=\"{}\"", k);
    let max_u16 = (size_in_bytes as usize / 2).saturating_sub(1);
    let me = this as *mut MockAttributeList;
    if let Ok(m) = (*me).map.lock() {
        if let Some(AttrValue::String(v)) = m.get(&k) {
            println!("[IAttributeList]   -> found (len={})", v.len());
            let n = v.len().min(max_u16);
            std::ptr::copy_nonoverlapping(v.as_ptr(), string, n);
            *string.add(n) = 0;
            return K_RESULT_OK;
        }
        *string = 0;
        return K_RESULT_FALSE;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_set_binary(
    this: *mut c_void,
    id: AttrID,
    data: *const c_void,
    size_in_bytes: u32,
) -> TResult {
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    let me = this as *mut MockAttributeList;
    let slice = if data.is_null() || size_in_bytes == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(data as *const u8, size_in_bytes as usize)
    };
    if let Ok(mut m) = (*me).map.lock() {
        m.insert(k, AttrValue::Binary(slice.to_vec()));
        return K_RESULT_OK;
    }
    K_RESULT_FALSE
}

unsafe extern "system" fn attr_get_binary(
    this: *mut c_void,
    id: AttrID,
    data: *mut *const c_void,
    size_in_bytes: *mut u32,
) -> TResult {
    if data.is_null() || size_in_bytes.is_null() {
        return K_INVALID_ARGUMENT;
    }
    *data = std::ptr::null();
    *size_in_bytes = 0;
    let Some(k) = attr_key(id) else {
        return K_INVALID_ARGUMENT;
    };
    println!("[IAttributeList] get_binary key=\"{}\"", k);
    let me = this as *mut MockAttributeList;
    if let Ok(m) = (*me).map.lock() {
        if let Some(AttrValue::Binary(v)) = m.get(&k) {
            println!("[IAttributeList]   -> found (len={})", v.len());
            *data = v.as_ptr() as *const c_void;
            *size_in_bytes = v.len() as u32;
            return K_RESULT_OK;
        }
        println!("[IAttributeList]   -> NOT FOUND");
        return K_RESULT_FALSE;
    }
    K_RESULT_FALSE
}

static mut MOCK_ATTR_LIST_VTBL: IAttributeListVtbl = IAttributeListVtbl {
    base: FUnknownVtbl {
        query_interface: attr_query_interface,
        add_ref: attr_add_ref,
        release: attr_release,
    },
    set_int: attr_set_int,
    get_int: attr_get_int,
    set_float: attr_set_float,
    get_float: attr_get_float,
    set_string: attr_set_string,
    get_string: attr_get_string,
    set_binary: attr_set_binary,
    get_binary: attr_get_binary,
};

fn new_mock_attribute_list() -> *mut c_void {
    let obj = Box::new(MockAttributeList {
        vtbl: &raw const MOCK_ATTR_LIST_VTBL,
        ref_count: AtomicU32::new(1),
        map: Mutex::new(HashMap::new()),
    });
    Box::into_raw(obj) as *mut c_void
}

#[repr(C)]
struct IMessageVtbl {
    base: FUnknownVtbl,
    get_message_id: unsafe extern "system" fn(this: *mut c_void) -> FIDString,
    set_message_id: unsafe extern "system" fn(this: *mut c_void, id: FIDString),
    get_attributes: unsafe extern "system" fn(this: *mut c_void) -> *mut c_void,
}

#[repr(C)]
struct MockMessage {
    vtbl: *const IMessageVtbl,
    ref_count: AtomicU32,
    message_id: Mutex<Option<Vec<u8>>>, // CString bytes including NUL
    attrs: *mut c_void,                 // MockAttributeList
}

unsafe impl Send for MockMessage {}
unsafe impl Sync for MockMessage {}

unsafe extern "system" fn msg_query_interface(
    this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> TResult {
    if obj.is_null() {
        return K_INVALID_ARGUMENT;
    }
    *obj = std::ptr::null_mut();
    if iid.is_null() {
        return K_INVALID_ARGUMENT;
    }

    use vst3::Steinberg::FUnknown;
    use vst3::Steinberg::Vst::IMessage as VstIMessage;

    let iid_slice = *iid;
    if iid_slice == FUnknown::IID || iid_slice == VstIMessage::IID {
        *obj = this;
        let me = this as *mut MockMessage;
        (*me).ref_count.fetch_add(1, Ordering::Relaxed);
        return K_RESULT_OK;
    }

    K_NO_INTERFACE
}

unsafe extern "system" fn msg_add_ref(this: *mut c_void) -> u32 {
    let me = this as *mut MockMessage;
    (*me).ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn msg_release(this: *mut c_void) -> u32 {
    let me = this as *mut MockMessage;
    let prev = (*me).ref_count.fetch_sub(1, Ordering::Release);
    let next = prev.saturating_sub(1);
    if next == 0 {
        std::sync::atomic::fence(Ordering::Acquire);
        // Release attributes
        if !(*me).attrs.is_null() {
            let attr_obj = (*me).attrs;
            let _ = attr_release(attr_obj);
        }
        drop(Box::from_raw(me));
    }
    next
}

unsafe extern "system" fn msg_get_message_id(this: *mut c_void) -> FIDString {
    let me = this as *mut MockMessage;
    if let Ok(guard) = (*me).message_id.lock() {
        if let Some(bytes) = guard.as_ref() {
            return bytes.as_ptr() as *const c_char;
        }
    }
    std::ptr::null()
}

unsafe extern "system" fn msg_set_message_id(this: *mut c_void, id: FIDString) {
    let me = this as *mut MockMessage;
    let mut out: Option<Vec<u8>> = None;
    if !id.is_null() {
        out = Some(CStr::from_ptr(id).to_bytes_with_nul().to_vec());
    }
    if let Ok(mut guard) = (*me).message_id.lock() {
        *guard = out;
    }
}

unsafe extern "system" fn msg_get_attributes(this: *mut c_void) -> *mut c_void {
    let me = this as *mut MockMessage;
    if (*me).attrs.is_null() {
        return std::ptr::null_mut();
    }
    // add_ref before returning
    let attr_obj = (*me).attrs;
    let _ = attr_add_ref(attr_obj);
    attr_obj
}

static mut MOCK_MESSAGE_VTBL: IMessageVtbl = IMessageVtbl {
    base: FUnknownVtbl {
        query_interface: msg_query_interface,
        add_ref: msg_add_ref,
        release: msg_release,
    },
    get_message_id: msg_get_message_id,
    set_message_id: msg_set_message_id,
    get_attributes: msg_get_attributes,
};

fn new_mock_message() -> *mut c_void {
    let attrs = new_mock_attribute_list();
    let obj = Box::new(MockMessage {
        vtbl: &raw const MOCK_MESSAGE_VTBL,
        ref_count: AtomicU32::new(1),
        message_id: Mutex::new(None),
        attrs,
    });
    Box::into_raw(obj) as *mut c_void
}

// --- Mock Host Application ---
unsafe extern "system" fn host_get_name(_this: *mut c_void, name: *mut c_char) -> i32 {
    if name.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let name_u16_ptr = name as *mut u16;

    let host = _this as *mut MockHostApplication;
    if host.is_null() {
        let fallback = encode_host_name_u16("Auralyn");
        std::ptr::copy_nonoverlapping(fallback.as_ptr(), name_u16_ptr, fallback.len());
        return K_RESULT_OK;
    }

    let name_buf = unsafe { &(*host).name_u16 };
    std::ptr::copy_nonoverlapping(name_buf.as_ptr(), name_u16_ptr, name_buf.len());
    K_RESULT_OK
}

unsafe extern "system" fn host_create_instance(
    _this: *mut c_void,
    cid: *const TUID,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> i32 {
    // Force log for debugging
    // if debug_hostobj() {
    println!("Host::create_instance called");
    if !cid.is_null() {
        let cid_slice = *cid;
        println!(
                "  CID: {:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
                cid_slice[0], cid_slice[1], cid_slice[2], cid_slice[3],
                cid_slice[4], cid_slice[5],
                cid_slice[6], cid_slice[7],
                cid_slice[8], cid_slice[9],
                cid_slice[10], cid_slice[11], cid_slice[12], cid_slice[13], cid_slice[14], cid_slice[15]
            );
    }
    if !iid.is_null() {
        let iid_slice = *iid;
        println!(
                "  IID: {:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
                iid_slice[0], iid_slice[1], iid_slice[2], iid_slice[3],
                iid_slice[4], iid_slice[5],
                iid_slice[6], iid_slice[7],
                iid_slice[8], iid_slice[9],
                iid_slice[10], iid_slice[11], iid_slice[12], iid_slice[13], iid_slice[14], iid_slice[15]
            );
    }
    // }
    if !obj.is_null() {
        *obj = std::ptr::null_mut();
    }

    if cid.is_null() || iid.is_null() || obj.is_null() {
        return K_INVALID_ARGUMENT;
    }

    use vst3::Steinberg::Vst::{IAttributeList, IMessage};

    let cid_slice = unsafe { *cid };
    let iid_slice = unsafe { *iid };

    // IMessage factory (Some plugins request CID=kBHostMessage, IID=IMessage)
    // OTT might be doing this.
    // CID_HOSTMESSAGE matches VST3 spec.
    if (cid_slice == crate::vst_host::c_api::CID_HOSTMESSAGE || cid_slice == IMessage::IID)
        && iid_slice == IMessage::IID
    {
        println!("Host::create_instance -> Matched IMessage (Creating MockMessage)");
        let msg = new_mock_message();
        *obj = msg;
        return K_RESULT_OK;
    }

    // Some plugins request IAttributeList directly.
    if cid_slice == IAttributeList::IID && iid_slice == IAttributeList::IID {
        let attrs = new_mock_attribute_list();
        *obj = attrs;
        return K_RESULT_OK;
    }

    // [Fix] Handle IPlugInterfaceSupport
    if cid_slice == crate::vst_host::c_api::IID_IPLUGINTERFACESUPPORT
        && iid_slice == crate::vst_host::c_api::IID_IPLUGINTERFACESUPPORT
    {
        *obj = get_mock_plug_interface_support_ptr();
        return K_RESULT_OK;
    }

    // [Fix] Handle IPlugFrame QI
    if cid_slice == crate::vst_host::c_api::IID_IPLUGFRAME
        && iid_slice == crate::vst_host::c_api::IID_IPLUGFRAME
    {
        *obj = get_mock_plug_frame_ptr();
        return K_RESULT_OK;
    }

    if cid_slice == crate::vst_host::c_api::IID_ITIMERHANDLER
        && iid_slice == crate::vst_host::c_api::IID_ITIMERHANDLER
    {
        *obj = get_mock_timer_handler_ptr();
        return K_RESULT_OK;
    }

    K_NO_INTERFACE
}

unsafe extern "system" fn host_create_host_attribute(
    _this: *mut c_void,
    attr_list: *mut *mut c_void,
) -> i32 {
    println!("Host::create_host_attribute called");
    if attr_list.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let attrs = new_mock_attribute_list();
    *attr_list = attrs;

    // Some plugins use this to check kIBundlePathKey?
    // We should populate it if possible?
    if let Ok(guard) = GLOBAL_CURRENT_PLUGIN_PATH.lock() {
        if let Some(path_str) = guard.as_ref() {
            println!(
                "  -> host_create_host_attribute: Injecting vst3.ibundlepath = {}",
                path_str
            );
            let me = attrs as *mut MockAttributeList;
            // Convert path to UTF-16
            let path_u16: Vec<u16> = path_str.encode_utf16().chain(std::iter::once(0)).collect();
            if let Ok(mut m) = unsafe { (*me).map.lock() } {
                m.insert("vst3.ibundlepath".to_string(), AttrValue::String(path_u16));
            }
        }
    }

    K_RESULT_OK
}

// --- Mock Plug Interface Support ---
#[repr(C)]
struct IPlugInterfaceSupportVtbl {
    base: FUnknownVtbl,
    is_plug_interface_supported:
        unsafe extern "system" fn(this: *mut c_void, iid: *const TUID) -> TResult,
}

unsafe extern "system" fn support_is_supported(_this: *mut c_void, iid: *const TUID) -> TResult {
    if iid.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let id = *iid;
    // We support IComponentHandler (v1/v2) and IConnectionPoint
    if id == crate::vst_host::c_api::IID_ICOMPONENTHANDLER
        || id == crate::vst_host::c_api::IID_ICOMPONENTHANDLER2
        || id == crate::vst_host::c_api::IID_ICONNECTIONPOINT
    {
        return K_RESULT_OK;
    }
    // Default to OK for now to be permissive
    K_RESULT_OK
}

static mut MOCK_INTERFACE_SUPPORT_VTBL: IPlugInterfaceSupportVtbl = IPlugInterfaceSupportVtbl {
    base: FUnknownVtbl {
        query_interface: host_query_interface,
        add_ref: host_add_ref,
        release: host_release,
    },
    is_plug_interface_supported: support_is_supported,
};

#[repr(C)]
struct MockPlugInterfaceSupport {
    vtbl: *const IPlugInterfaceSupportVtbl,
}
static mut GLOBAL_MOCK_INTERFACE_SUPPORT: MockPlugInterfaceSupport = MockPlugInterfaceSupport {
    vtbl: std::ptr::null(),
};
fn get_mock_plug_interface_support_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_MOCK_INTERFACE_SUPPORT.vtbl.is_null() {
            GLOBAL_MOCK_INTERFACE_SUPPORT.vtbl = &raw const MOCK_INTERFACE_SUPPORT_VTBL;
        }
        std::ptr::addr_of_mut!(GLOBAL_MOCK_INTERFACE_SUPPORT) as *mut c_void
    }
}

pub static GLOBAL_CURRENT_PLUGIN_PATH: Mutex<Option<String>> = Mutex::new(None);

// use crate::vst_host::c_api::IHostApplicationVtbl; // Moved to top imports
static mut MOCK_HOST_APP_VTBL: IHostApplicationVtbl = IHostApplicationVtbl {
    base: FUnknownVtbl {
        query_interface: host_query_interface,
        add_ref: host_add_ref,
        release: host_release,
    },
    get_name: host_get_name,
    create_instance: host_create_instance,
    create_host_attribute: host_create_host_attribute,
};

// --- Helper for finding ALL plugin windows ---
unsafe extern "system" fn enum_all_child_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<HWND>);
    list.push(hwnd);
    BOOL(1)
}

fn find_all_plugin_child_hwnds(parent: HWND) -> Vec<HWND> {
    let mut children = Vec::new();
    unsafe {
        let lparam = LPARAM(&mut children as *mut _ as isize);
        let _ = EnumChildWindows(Some(parent), Some(enum_all_child_proc), lparam);
    }
    children
}

#[repr(C)]
pub struct MockHostApplication {
    pub vtbl: *const IHostApplicationVtbl,
    pub name_u16: [u16; HOST_NAME_MAX_U16],
}
static mut GLOBAL_MOCK_HOST_APP: MockHostApplication = MockHostApplication {
    vtbl: std::ptr::null(),
    name_u16: [0u16; HOST_NAME_MAX_U16],
};

fn get_mock_host_app_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_MOCK_HOST_APP.vtbl.is_null() {
            GLOBAL_MOCK_HOST_APP.vtbl = &raw const MOCK_HOST_APP_VTBL;
            GLOBAL_MOCK_HOST_APP.name_u16 = encode_host_name_u16("Auralyn");
        }
        std::ptr::addr_of_mut!(GLOBAL_MOCK_HOST_APP) as *mut c_void
    }
}

// Owned host application (per-plugin quirk support)
unsafe extern "system" fn host_app_query_interface(
    this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> i32 {
    if iid.is_null() || obj.is_null() {
        return K_INVALID_ARGUMENT;
    }

    use vst3::Steinberg::FUnknown;
    let iid_slice = unsafe { *iid };
    if iid_slice == FUnknown::IID || iid_slice == vst3::Steinberg::Vst::IHostApplication::IID {
        unsafe {
            *obj = this;
        }
        return K_RESULT_OK;
    }

    unsafe { host_query_interface(this, iid, obj) }
}

static HOST_APP_OWNED_VTBL: IHostApplicationVtbl = IHostApplicationVtbl {
    base: FUnknownVtbl {
        query_interface: host_app_query_interface,
        add_ref: host_add_ref,
        release: host_release,
    },
    get_name: host_get_name,
    create_instance: host_create_instance,
    create_host_attribute: host_create_host_attribute,
};

fn new_mock_host_app_ptr(name: &str) -> *mut c_void {
    let obj = Box::new(MockHostApplication {
        vtbl: &HOST_APP_OWNED_VTBL,
        name_u16: encode_host_name_u16(name),
    });
    Box::into_raw(obj) as *mut c_void
}

unsafe fn is_owned_host_app_ptr(ptr: *mut c_void) -> bool {
    if ptr.is_null() {
        return false;
    }
    let app = ptr as *mut MockHostApplication;
    unsafe { (*app).vtbl == (&raw const HOST_APP_OWNED_VTBL) }
}

unsafe fn drop_owned_host_app_ptr(ptr: *mut c_void) {
    if !is_owned_host_app_ptr(ptr) {
        return;
    }
    drop(unsafe { Box::from_raw(ptr as *mut MockHostApplication) });
}

struct HostAppGuard(*mut c_void);
impl HostAppGuard {
    fn new(name: &str) -> Self {
        Self(new_mock_host_app_ptr(name))
    }

    fn as_ptr(&self) -> *mut c_void {
        self.0
    }

    fn into_raw(self) -> *mut c_void {
        let ptr = self.0;
        std::mem::forget(self);
        ptr
    }
}

impl Drop for HostAppGuard {
    fn drop(&mut self) {
        unsafe { drop_owned_host_app_ptr(self.0) }
    }
}

// --- Mock Plug Frame ---
unsafe extern "system" fn host_resize_view(
    _this: *mut c_void,
    _view: *mut c_void,
    new_size: *mut ViewRect,
) -> i32 {
    if new_size.is_null() {
        return K_INVALID_ARGUMENT;
    }

    let requested_w = (*new_size).right - (*new_size).left;
    let requested_h = (*new_size).bottom - (*new_size).top;

    println!(
        "Host::resize_view called. Request: {}x{} (Rect: {:?})",
        requested_w, requested_h, *new_size
    );

    let Some(state) = get_editor_view_state(_view) else {
        println!("Host::resize_view ignored: view is not registered.");
        return K_RESULT_FALSE;
    };

    // プラグインが 4x4 等を要求するケースがあるが、ここで勝手に別サイズへ誘導すると
    // 逆にレイアウトが壊れることがある。疑わしい要求は無視して再試行に任せる。
    if requested_w < 50 || requested_h < 50 {
        println!(
            "Host::resize_view soft-accept: suspicious request {}x{}",
            requested_w, requested_h
        );

        // 重要:
        // 一部プラグインは「試験的に 4x4 を要求」→ホストがOKを返すことを前提に初期化を進める。
        // ここで kResultFalse を返すと初期化が止まる可能性があるため、
        // リサイズ自体は行わず kResultOk を返す（Element等の寛容な挙動に寄せる）。
        if state.last_good_w >= 50 && state.last_good_h >= 50 {
            let view_vtbl = crate::vst_host::instance::get_vtbl::<IPlugViewVtbl>(_view);
            let mut applied = ViewRect {
                left: 0,
                top: 0,
                right: state.last_good_w,
                bottom: state.last_good_h,
            };
            let _ = (view_vtbl.on_size)(_view, &mut applied);
        }

        return K_RESULT_OK;
    }

    let target_w = requested_w;
    let target_h = requested_h;

    // 実際にホスト（トップレベル）ウィンドウをリサイズし、コンテナも追従させる
    if resize_hwnd_client(state.top_hwnd, target_w, target_h) {
        let _ = resize_child_hwnd(state.container_hwnd, target_w, target_h);

        // 一部GUI（OTT/VSTGUI等）は子HWNDがホストのon_sizeに追従しないことがあるため、
        // 可能なら「プラグインが作った子HWND」を強制的にコンテナいっぱいへ合わせる。
        if state.plugin_hwnd != 0 {
            let _ = move_resize_child_hwnd(state.plugin_hwnd, 0, 0, target_w, target_h);
        }

        update_editor_view_last_size(_view, target_w, target_h);

        // ベストエフォートで on_size も呼ぶ（プラグインの再レイアウト/再描画を促す）
        let view_vtbl = crate::vst_host::instance::get_vtbl::<IPlugViewVtbl>(_view);
        let mut applied = ViewRect {
            left: 0,
            top: 0,
            right: target_w,
            bottom: target_h,
        };
        let _ = (view_vtbl.on_size)(_view, &mut applied);

        K_RESULT_OK
    } else {
        println!("Host::resize_view failed: window resize was not applied.");
        K_RESULT_FALSE
    }
}

// use crate::vst_host::c_api::IPlugFrameVtbl; // Moved to top imports

static mut MOCK_PLUG_FRAME_VTBL: IPlugFrameVtbl = IPlugFrameVtbl {
    base: FUnknownVtbl {
        query_interface: host_query_interface, // Share same QI logic? careful. Frame QI might need to return Frame or Handler.
        add_ref: host_add_ref,
        release: host_release,
    },
    resize_view: host_resize_view,
};

#[repr(C)]
pub struct MockPlugFrame {
    pub vtbl: *const IPlugFrameVtbl,
}

static mut GLOBAL_MOCK_PLUG_FRAME: MockPlugFrame = MockPlugFrame {
    vtbl: std::ptr::null(),
};

fn get_mock_plug_frame_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_MOCK_PLUG_FRAME.vtbl.is_null() {
            GLOBAL_MOCK_PLUG_FRAME.vtbl = &raw const MOCK_PLUG_FRAME_VTBL;
        }
        std::ptr::addr_of_mut!(GLOBAL_MOCK_PLUG_FRAME) as *mut c_void
    }
}

#[repr(C)]
pub struct MockComponentHandler {
    pub vtbl: *const IComponentHandler2Vtbl,
}

unsafe impl Sync for MockComponentHandler {}

static mut GLOBAL_MOCK_HANDLER: MockComponentHandler = MockComponentHandler {
    vtbl: std::ptr::null(), // Initialized at runtime
};

fn get_mock_handler_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_MOCK_HANDLER.vtbl.is_null() {
            GLOBAL_MOCK_HANDLER.vtbl = &raw const MOCK_CONNECTION_HANDLER_VTBL;
        }
        std::ptr::addr_of_mut!(GLOBAL_MOCK_HANDLER) as *mut c_void
    }
}

// --- Mock Connection Point ---
unsafe extern "system" fn connection_connect(_this: *mut c_void, _other: *mut c_void) -> i32 {
    println!("IConnectionPoint::connect called");
    K_RESULT_OK
}
unsafe extern "system" fn connection_disconnect(_this: *mut c_void, _other: *mut c_void) -> i32 {
    println!("IConnectionPoint::connect disconnected");
    K_RESULT_OK
}
unsafe extern "system" fn connection_notify(_this: *mut c_void, message: *mut c_void) -> i32 {
    // If message is IMessage, we could log it?
    // IMessageVtbl is needed to read it.
    println!(
        "IConnectionPoint::notify called (message ptr: {:p})",
        message
    );
    K_RESULT_OK
}

static mut MOCK_CONNECTION_POINT_VTBL: crate::vst_host::c_api::IConnectionPointVtbl =
    crate::vst_host::c_api::IConnectionPointVtbl {
        base: FUnknownVtbl {
            query_interface: host_query_interface, // Share host QI? Maybe fine if we don't query via CP.
            add_ref: host_add_ref,
            release: host_release,
        },
        connect: connection_connect,
        disconnect: connection_disconnect,
        notify: connection_notify,
    };

#[repr(C)]
pub struct MockConnectionPoint {
    pub vtbl: *const crate::vst_host::c_api::IConnectionPointVtbl,
}
static mut GLOBAL_CONNECTION_POINT: MockConnectionPoint = MockConnectionPoint {
    vtbl: std::ptr::null(),
};
fn get_connection_point_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_CONNECTION_POINT.vtbl.is_null() {
            GLOBAL_CONNECTION_POINT.vtbl = &raw const MOCK_CONNECTION_POINT_VTBL;
        }
        std::ptr::addr_of_mut!(GLOBAL_CONNECTION_POINT) as *mut c_void
    }
}

// --- Specialized Query Interface for Handler ---
unsafe extern "system" fn handler_query_interface(
    _this: *mut c_void,
    iid: *const TUID,
    obj: *mut *mut c_void,
) -> i32 {
    if iid.is_null() || obj.is_null() {
        return K_INVALID_ARGUMENT;
    }
    let iid_slice = *iid;

    // Check IUnknown
    if iid_slice == crate::vst_host::c_api::IID_IUNKNOWN {
        *obj = _this;
        return K_RESULT_OK;
    }

    // Check IComponentHandler / IComponentHandler2
    if iid_slice == crate::vst_host::c_api::IID_ICOMPONENTHANDLER
        || iid_slice == crate::vst_host::c_api::IID_ICOMPONENTHANDLER2
        || iid_slice == crate::vst_host::c_api::IID_ICOMPONENTHANDLER2_BE
    {
        println!("MockComponentHandler::query_interface -> IComponentHandler/2 (BE/LE) matched!");
        *obj = _this;
        return K_RESULT_OK;
    }

    // Check IConnectionPoint
    if iid_slice == crate::vst_host::c_api::IID_ICONNECTIONPOINT {
        println!("MockComponentHandler::query_interface -> IConnectionPoint matched!");
        *obj = get_connection_point_ptr();
        return K_RESULT_OK;
    }

    // Check IPlugInterfaceSupport (Sometimes queried on Handler)
    if iid_slice == crate::vst_host::c_api::IID_IPLUGINTERFACESUPPORT
        || iid_slice == crate::vst_host::c_api::IID_IPLUGINTERFACESUPPORT_BE
    {
        println!("MockComponentHandler::query_interface -> IPlugInterfaceSupport matched!");
        *obj = get_mock_plug_interface_support_ptr();
        return K_RESULT_OK;
    }

    // Fallback
    println!(
        "MockComponentHandler::query_interface -> Unknown IID: {:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
        iid_slice[0], iid_slice[1], iid_slice[2], iid_slice[3],
        iid_slice[4], iid_slice[5],
        iid_slice[6], iid_slice[7],
        iid_slice[8], iid_slice[9],
        iid_slice[10], iid_slice[11], iid_slice[12], iid_slice[13], iid_slice[14], iid_slice[15]
    );

    K_NO_INTERFACE
}

// Specialized VTable using our CUSTOM QI
static mut MOCK_CONNECTION_HANDLER_VTBL: IComponentHandler2Vtbl = IComponentHandler2Vtbl {
    base: FUnknownVtbl {
        query_interface: handler_query_interface,
        add_ref: host_add_ref,
        release: host_release,
    },
    begin_edit: mock_begin_edit,
    perform_edit: mock_perform_edit,
    end_edit: mock_end_edit,
    restart_component: mock_restart_component,
    set_dirty: mock_set_dirty,
    request_open_editor: mock_request_open_editor,
    start_group_edit: mock_start_group_edit,
    finish_group_edit: mock_finish_group_edit,
};

// Dummy implementations for new references
unsafe extern "system" fn mock_begin_edit(_this: *mut c_void, _id: u32) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn mock_perform_edit(_this: *mut c_void, _id: u32, _val: f64) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn mock_end_edit(_this: *mut c_void, _id: u32) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn mock_restart_component(_this: *mut c_void, _flags: i32) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn mock_set_dirty(_this: *mut c_void, _state: i32) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn mock_request_open_editor(
    _this: *mut c_void,
    _name: *const c_char,
) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn mock_start_group_edit(_this: *mut c_void) -> i32 {
    K_RESULT_OK
}
unsafe extern "system" fn mock_finish_group_edit(_this: *mut c_void) -> i32 {
    K_RESULT_OK
}
// --- Mock Unit Handler ---
unsafe extern "system" fn host_notify_unit_selection(_this: *mut c_void, _unit_id: i32) -> i32 {
    // println!("Host::notify_unit_selection unit_id={}", unit_id);
    0
}
unsafe extern "system" fn host_notify_program_list_change(
    _this: *mut c_void,
    _list_id: i32,
    _program_index: i32,
) -> i32 {
    // println!("Host::notify_program_list_change list_id={} ptr={}", list_id, program_index);
    0
}

static mut MOCK_UNIT_HANDLER_VTBL: crate::vst_host::c_api::IUnitHandlerVtbl =
    crate::vst_host::c_api::IUnitHandlerVtbl {
        base: FUnknownVtbl {
            query_interface: host_query_interface, // Share base QI
            add_ref: host_add_ref,
            release: host_release,
        },
        notify_unit_selection: host_notify_unit_selection,
        notify_program_list_change: host_notify_program_list_change,
    };

#[repr(C)]
pub struct MockUnitHandler {
    pub vtbl: *const crate::vst_host::c_api::IUnitHandlerVtbl,
}
static mut GLOBAL_MOCK_UNIT_HANDLER: MockUnitHandler = MockUnitHandler {
    vtbl: std::ptr::null(),
};
fn get_mock_unit_handler_ptr() -> *mut c_void {
    unsafe {
        if GLOBAL_MOCK_UNIT_HANDLER.vtbl.is_null() {
            GLOBAL_MOCK_UNIT_HANDLER.vtbl = &raw const MOCK_UNIT_HANDLER_VTBL;
        }
        std::ptr::addr_of_mut!(GLOBAL_MOCK_UNIT_HANDLER) as *mut c_void
    }
}
// --- End Mock ---

pub struct VstInstance {
    pub id: String, // Unique ID for management
    pub name: String,
    pub _library: Arc<Library>,
    component: *mut c_void,
    processor: *mut c_void,
    pub controller: *mut c_void,
    pub active_view: *mut c_void,
    pub active_flag: Arc<AtomicBool>,
    editor_env: Option<EditorEnvGuard>,
    channels: usize,         // Stored from prepare_processing for create_processor
    max_block_size: usize,   // Stored from prepare_processing for create_processor
    host_app: *mut c_void,   // IHostApplication context (per-plugin quirks)
    pub path: String,        // Stored for CWD switching during editor open
    module_hmodule: HMODULE, // Plugin DLL module handle (for UI/resource quirks)
}

unsafe impl Send for VstInstance {}

pub struct VstProcessor {
    ptr: *mut c_void,
    _library: Arc<Library>,
    scratch_inputs: Vec<Vec<f32>>,
    scratch_outputs: Vec<Vec<f32>>,

    // Persistent buffers to avoid allocation in process()
    input_ptrs: Vec<*mut f32>,
    output_ptrs: Vec<*mut f32>,
    bus_inputs: Vec<AudioBusBuffers>,
    bus_outputs: Vec<AudioBusBuffers>,

    active_flag: Arc<AtomicBool>, // Kill switch

    // Safety constants
    max_block_size: usize,
    _num_channels: usize,
}

unsafe impl Send for VstProcessor {}

impl VstInstance {
    pub fn load(path: &str) -> Result<Self> {
        let path_obj = Path::new(path);
        let plugin_name = path_obj.file_stem().unwrap().to_string_lossy().to_string();
        let is_insight2 = plugin_name.contains("Insight 2");

        // --- Quirk Management ---
        #[derive(PartialEq)]
        #[allow(dead_code)]
        pub enum QuirkConnectionStrategy {
            // Renamed for clarity, public for use in verify
            Default,
            ControllerFirst,
            DoNotConnect, // For very broken plugins
            Deferred,     // Insight 2: Connect after event loop spins
        }

        fn get_plugin_quirks(name: &str) -> QuirkConnectionStrategy {
            if name.contains("Insight 2") {
                // Insight 2: connect() before activation has been observed to crash this host.
                // Defer connection to the engine event loop after activation.
                return QuirkConnectionStrategy::Deferred;
            }
            QuirkConnectionStrategy::Default
        }
        // ------------------------

        let quirk = get_plugin_quirks(&plugin_name);
        match quirk {
            QuirkConnectionStrategy::ControllerFirst => println!(
                "[Quirk] Applying Strategy::ControllerFirst for '{}'",
                plugin_name
            ),
            QuirkConnectionStrategy::DoNotConnect => println!(
                "[Quirk] Applying Strategy::DoNotConnect for '{}'",
                plugin_name
            ),
            QuirkConnectionStrategy::Deferred => println!(
                "[Quirk] Applying Strategy::Deferred (Connect later) for '{}'",
                plugin_name
            ),
            _ => {}
        }

        unsafe {
            let lib = Arc::new(
                Library::new(path)
                    .map_err(|e| {
                        println!("Error loading DLL '{}': {}", path, e);
                        e
                    })
                    .context("Failed to load VST3 library")?,
            );

            let factory_proc: Symbol<GetPluginFactory> = lib
                .get(b"GetPluginFactory")
                .context("GetPluginFactory symbol not found")?;

            // Resolve HMODULE for resource loading quirks (VSTGUI etc.)
            // Some plugins rely on a module handle associated with their UI window class.
            let mut module_hmodule = HMODULE(std::ptr::null_mut());
            {
                use windows::Win32::System::LibraryLoader::{
                    GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                };

                let factory_fn: GetPluginFactory = *factory_proc;
                let addr = factory_fn as *const c_void;
                let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                    | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT;
                let res =
                    GetModuleHandleExW(flags, PCWSTR(addr as *const u16), &mut module_hmodule);
                println!(
                    "[Module] GetModuleHandleExW(from_address) res={:?} hmodule={:p}",
                    res, module_hmodule.0
                );
            }

            let factory_ptr = factory_proc();
            if factory_ptr.is_null() {
                return Err(anyhow!("GetPluginFactory returned null"));
            }

            // Wrap Factory
            let factory_vtbl = get_vtbl::<IPluginFactoryVtbl>(factory_ptr);

            // Find class
            let count = (factory_vtbl.count_classes)(factory_ptr);
            let mut class_info: PClassInfo = std::mem::zeroed();
            let mut component_ptr: *mut c_void = std::ptr::null_mut();

            for i in 0..count {
                if (factory_vtbl.get_class_info)(factory_ptr, i, &mut class_info) == K_RESULT_OK {
                    // Helper to convert C-string buffer
                    let read_cstr = |buf: &[i8]| -> String {
                        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                        let slice = std::slice::from_raw_parts(buf.as_ptr() as *const u8, len);
                        String::from_utf8_lossy(slice).into_owned()
                    };

                    let category = read_cstr(&class_info.category);
                    let class_name = read_cstr(&class_info.name);
                    let category_lower = category.to_lowercase();

                    println!("Found class: '{}', Category: '{}'", class_name, category);

                    // VST3 "Audio Module Class"
                    if category_lower.contains("audio module") || category_lower.contains("fx") {
                        let mut obj: *mut c_void = std::ptr::null_mut();

                        // Use IID from crate
                        use vst3::Interface;
                        use vst3::Steinberg::{FUnknown, Vst::IComponent};

                        // 1. Try creating IComponent directly (Standard VST3 approach)
                        //
                        // Quirk: Insight 2 appears to return an unstable pointer when instantiated
                        // directly as IComponent in this host. Instantiating via FUnknown and keeping
                        // that reference alive (see below) is significantly more stable.
                        // Quirk: Insight 2 is sensitive to instantiation + refcount behavior.
                        // We prefer the FUnknown + keepalive strategy for stability.
                        let force_funknown = is_insight2;
                        let mut res_direct = -1;
                        if !force_funknown {
                            res_direct = (factory_vtbl.create_instance)(
                                factory_ptr,
                                &class_info.cid as *const _,
                                &<IComponent as Interface>::IID as *const _ as *const TUID,
                                &mut obj as *mut _,
                            );

                            if res_direct == K_RESULT_OK && !obj.is_null() {
                                println!(
                                    "Created instance via IComponent directly for '{}'",
                                    class_name
                                );
                                component_ptr = obj;
                                break;
                            }

                            println!(
                                "Direct IComponent creation failed (res={}). Falling back to FUnknown.",
                                res_direct
                            );
                        } else {
                            println!(
                                "[Quirk] '{}' -> Skipping direct IComponent instantiation; using FUnknown + leak strategy.",
                                plugin_name
                            );
                        }

                        // 2. Fallback: Try creating with FUNKNOWN
                        let res_unknown = (factory_vtbl.create_instance)(
                            factory_ptr,
                            &class_info.cid as *const _,
                            &<FUnknown as Interface>::IID as *const _ as *const TUID,
                            &mut obj as *mut _,
                        );

                        if res_unknown == K_RESULT_OK && !obj.is_null() {
                            println!("Created instance via FUnknown for '{}'", class_name);

                            // Now QueryInterface for IComponent
                            let unknown_vtbl = get_vtbl::<FUnknownVtbl>(obj);
                            let mut comp_ptr: *mut c_void = std::ptr::null_mut();

                            let query_res = (unknown_vtbl.query_interface)(
                                obj,
                                &<IComponent as Interface>::IID as *const _ as *const TUID,
                                &mut comp_ptr as *mut *mut c_void,
                            );

                            if query_res == K_RESULT_OK && !comp_ptr.is_null() {
                                println!("Successfully queried IComponent for '{}'", class_name);
                                component_ptr = comp_ptr;

                                // INTENTIONAL LEAK STRATEGY (Stability Fix):
                                // We intentionally DO NOT release 'obj' (the FUnknown interface).
                                // Detailed analysis suggests that for some plugins (like Insight 2),
                                // releasing this initial interface causes the underlying object to be destroyed
                                // or invalidated, even if we hold a valid IComponent pointer obtained via QI.
                                //
                                // To guarantee stability, we sacrifice a tiny amount of memory (one object per plugin instance)
                                // and keep the FUnknown reference alive for the duration of the plugin's life.
                                //
                                // println!("Skipping release of FUnknown to ensure object survival.");
                                // (unknown_vtbl.release)(obj); <--- COMMENTED OUT
                                break;
                            } else {
                                println!(
                                    "Failed to query IComponent from FUnknown (res={})",
                                    query_res
                                );
                                (unknown_vtbl.release)(obj);
                            }
                        } else {
                            println!(
                                "Failed to create instance for '{}' (Tried IComponent: {}, FUnknown: {})",
                                class_name, res_direct, res_unknown
                            );
                        }
                    }
                }
            }

            if component_ptr.is_null() {
                return Err(anyhow!(
                    "No valid Audio Module class found or failed to instantiate"
                ));
            }

            // Initialize
            let component_vtbl = get_vtbl::<IComponentVtbl>(component_ptr);
            println!("Initializing component...");
            // VST3 spec: initialize() should receive an IHostApplication context.
            // Insight 2 needs a valid host context for stable Component<->Controller messaging.
            // NOTE: If this regresses, implement IHostApplication::create_instance for IMessage/IAttributeList.

            // [Fix] Set GLOBAL_CURRENT_PLUGIN_PATH for IAttributeList (vst3.ibundlepath)
            // [Fix] Set GLOBAL_CURRENT_PLUGIN_PATH for IAttributeList (vst3.ibundlepath)
            if let Ok(mut guard) = GLOBAL_CURRENT_PLUGIN_PATH.lock() {
                *guard = Some(path.to_string());
            }

            let host_name = if let Ok(v) = std::env::var("AURALYN_VST_HOST_NAME") {
                v
            } else if env_flag("AURALYN_VST_SPOOF_CUBASE") || is_insight2 {
                // Compatibility fallback for plugins that assume Steinberg hosts.
                "Cubase 12.0.0".to_string()
            } else {
                "Auralyn".to_string()
            };
            let host_app = HostAppGuard::new(&host_name);
            let host_ctx = host_app.as_ptr();

            // [Resource Fix] Relative paths / helper DLLs compatibility
            let _env_guard = EditorEnvGuard::enter_for_module(std::path::Path::new(&path));
            let init_res = (component_vtbl.initialize)(component_ptr, host_ctx);

            if init_res != K_RESULT_OK {
                (component_vtbl.base.release)(component_ptr);
                return Err(anyhow!("Failed to initialize component"));
            }

            // Query processor
            println!("Querying IAudioProcessor...");
            let mut processor_ptr: *mut c_void = std::ptr::null_mut();

            use vst3::Steinberg::Vst::IAudioProcessor;
            // use Interface already imported? It is in the inner scope above. Import here just in case or scope it.
            use vst3::Interface;

            let query_res = (component_vtbl.base.query_interface)(
                component_ptr,
                &<IAudioProcessor as Interface>::IID as *const _ as *const TUID,
                &mut processor_ptr as *mut *mut c_void,
            );

            if query_res != K_RESULT_OK || processor_ptr.is_null() {
                println!(
                    "Warning: Could not query IAudioProcessor interface. Processing disabled."
                );
            } else {
                println!("Got processor interface: {:p}", processor_ptr);
            }

            // Query Edit Controller
            println!("Querying IEditController...");
            let mut controller_ptr: *mut c_void = std::ptr::null_mut();
            use vst3::Steinberg::Vst::IEditController;

            let query_res_ctrl = (component_vtbl.base.query_interface)(
                component_ptr,
                &<IEditController as Interface>::IID as *const _ as *const TUID,
                &mut controller_ptr as *mut *mut c_void,
            );

            if query_res_ctrl != K_RESULT_OK || controller_ptr.is_null() {
                println!("Info: Could not query IEditController from Component. Attempting to create separate Controller...");

                let mut controller_cid: TUID = [0; 16];
                if (component_vtbl.get_controller_class_id)(component_ptr, &mut controller_cid)
                    == K_RESULT_OK
                {
                    println!(
                        "Got Controller Class ID: {:?}. Creating instance...",
                        controller_cid
                    );
                    println!("Factory Ptr: {:p}", factory_ptr);

                    let mut raw_ctrl_ptr: *mut c_void = std::ptr::null_mut();
                    let res_create = (factory_vtbl.create_instance)(
                        factory_ptr,
                        &controller_cid as *const _,
                        &<IEditController as Interface>::IID as *const _ as *const TUID,
                        &mut raw_ctrl_ptr as *mut *mut c_void,
                    );

                    println!(
                        "create_instance result: {}, ptr: {:p}",
                        res_create, raw_ctrl_ptr
                    );

                    if res_create == K_RESULT_OK && !raw_ctrl_ptr.is_null() {
                        if (raw_ctrl_ptr as usize) < 0x1000 {
                            eprintln!(
                                "Critical: create_instance returned invalid pointer {:p}",
                                raw_ctrl_ptr
                            );
                        } else {
                            println!("Successfully created separate Controller instance. Initializing...");

                            // Initialize Controller
                            let ctrl_vtbl = get_vtbl::<IEditControllerVtbl>(raw_ctrl_ptr);

                            let controller_ctx = host_ctx;

                            // [Resource Fix] Relative paths / helper DLLs compatibility
                            let _env_guard =
                                EditorEnvGuard::enter_for_module(std::path::Path::new(&path));
                            let init_res_ctrl =
                                (ctrl_vtbl.initialize)(raw_ctrl_ptr, controller_ctx);

                            if init_res_ctrl == K_RESULT_OK {
                                println!("Controller initialized.");

                                // Essential: Set Component Handler
                                let handler = get_mock_handler_ptr();
                                println!("Setting Component Handler: {:p}", handler);
                                let handler_res =
                                    (ctrl_vtbl.set_component_handler)(raw_ctrl_ptr, handler);
                                println!("  -> Result: {}", handler_res);

                                // Synchronize State
                                let mut stream = MemoryStream::new();
                                let stream_ptr = &mut stream as *mut MemoryStream as *mut c_void;

                                println!("Synchronizing state to controller...");
                                let get_res = (component_vtbl.get_state)(component_ptr, stream_ptr);
                                if get_res == K_RESULT_OK {
                                    println!(
                                        "  Got state from component: {} bytes",
                                        stream.data.len()
                                    );
                                    stream.cursor = 0; // Rewind
                                    let set_res =
                                        (ctrl_vtbl.set_component_state)(raw_ctrl_ptr, stream_ptr);
                                    if set_res == K_RESULT_OK {
                                        println!("  Set component state success.");
                                    } else {
                                        println!(
                                            "  Set component state failed. Result: {}",
                                            set_res
                                        );
                                    }
                                } else {
                                    println!("  Get state from component failed (or not supported). Result: {}", get_res);
                                }

                                controller_ptr = raw_ctrl_ptr;

                                // --- IConnectionPoint Connection ---
                                match quirk {
                                    QuirkConnectionStrategy::DoNotConnect => {
                                        println!(
                                            "  -> [Quirk] Skipping IConnectionPoint connection entirely."
                                        );
                                    }
                                    QuirkConnectionStrategy::Deferred => {
                                        println!("  -> [Quirk] Deferred connection selected. Skipping now, will connect later in event loop.");
                                    }
                                    QuirkConnectionStrategy::ControllerFirst => {
                                        link_connection_points(
                                            component_ptr,
                                            raw_ctrl_ptr,
                                            ConnectionOrder::ControllerFirst,
                                            "[Quirk]",
                                        );
                                    }
                                    _ => {
                                        link_connection_points(
                                            component_ptr,
                                            raw_ctrl_ptr,
                                            ConnectionOrder::ComponentFirst,
                                            "",
                                        );
                                    }
                                }
                            } else {
                                eprintln!("Failed to initialize Controller.");
                                (ctrl_vtbl.base.release)(raw_ctrl_ptr);
                            }
                        }
                    } else {
                        eprintln!("Failed to create Controller instance (res={})", res_create);
                    }
                } else {
                    eprintln!("Component has no associated Controller Class ID within fallback.");
                }
            } else {
                println!(
                    "Got controller interface from Component: {:p}",
                    controller_ptr
                );

                // --- Quirk: OTT は Component が IEditController を返すが、GUIが不完全なケースがある。
                // Element等の挙動に合わせ、Controller Class ID が取れるなら「別コントローラ」を優先する。
                let is_ott = plugin_name == "OTT" || plugin_name.contains("OTT");
                let mut controller_already_initialized = false;
                if is_ott {
                    println!("[Quirk] OTT: controller interface from Component detected. Probing Controller Class ID...");

                    let mut controller_cid: TUID = [0; 16];
                    let cid_res = (component_vtbl.get_controller_class_id)(
                        component_ptr,
                        &mut controller_cid,
                    );
                    println!(
                        "[Quirk] OTT: get_controller_class_id res={} cid={:?}",
                        cid_res, controller_cid
                    );

                    let has_nonzero_cid = controller_cid.iter().any(|b| *b != 0);
                    if cid_res == K_RESULT_OK || has_nonzero_cid {
                        println!("[Quirk] OTT: Trying separate controller instance via factory...");

                        let mut raw_ctrl_ptr: *mut c_void = std::ptr::null_mut();
                        let res_create = (factory_vtbl.create_instance)(
                            factory_ptr,
                            &controller_cid as *const _,
                            &<IEditController as Interface>::IID as *const _ as *const TUID,
                            &mut raw_ctrl_ptr as *mut *mut c_void,
                        );

                        println!(
                            "[Quirk] OTT: create_instance result: {}, ptr: {:p}",
                            res_create, raw_ctrl_ptr
                        );

                        if res_create == K_RESULT_OK && !raw_ctrl_ptr.is_null() {
                            let ctrl_vtbl = get_vtbl::<IEditControllerVtbl>(raw_ctrl_ptr);
                            let _env_guard =
                                EditorEnvGuard::enter_for_module(std::path::Path::new(&path));

                            let init_res = (ctrl_vtbl.initialize)(raw_ctrl_ptr, host_ctx);
                            println!(
                                "[Quirk] OTT: separate controller initialize returned: {}",
                                init_res
                            );

                            if init_res == K_RESULT_OK {
                                controller_already_initialized = true;

                                let handler = get_mock_handler_ptr();
                                let handler_res =
                                    (ctrl_vtbl.set_component_handler)(raw_ctrl_ptr, handler);
                                println!(
                                    "[Quirk] OTT: set_component_handler returned: {}",
                                    handler_res
                                );

                                // Synchronize State (best-effort)
                                let mut stream = MemoryStream::new();
                                let stream_ptr = &mut stream as *mut MemoryStream as *mut c_void;
                                let get_res = (component_vtbl.get_state)(component_ptr, stream_ptr);
                                println!("[Quirk] OTT: component.get_state returned: {}", get_res);
                                if get_res == K_RESULT_OK {
                                    stream.cursor = 0;
                                    let set_res =
                                        (ctrl_vtbl.set_component_state)(raw_ctrl_ptr, stream_ptr);
                                    println!(
                                        "[Quirk] OTT: set_component_state returned: {}",
                                        set_res
                                    );
                                }

                                // IConnectionPoint (best-effort)
                                link_connection_points(
                                    component_ptr,
                                    raw_ctrl_ptr,
                                    ConnectionOrder::ComponentFirst,
                                    "[Quirk] OTT",
                                );

                                // IMPORTANT: Prefer the separate controller for GUI
                                // NOTE: keepalive safety -> do NOT release the component-provided controller here.
                                controller_ptr = raw_ctrl_ptr;
                                println!(
                                    "[Quirk] OTT: switched to separate controller {:p}",
                                    controller_ptr
                                );
                            } else {
                                eprintln!(
                                    "[Quirk] OTT: separate controller initialize failed: {}",
                                    init_res
                                );
                                (ctrl_vtbl.base.release)(raw_ctrl_ptr);
                            }
                        }
                    } else {
                        eprintln!(
                            "[Quirk] OTT: get_controller_class_id did not provide a usable CID (res={})",
                            cid_res
                        );
                    }
                }

                // Even when the controller is provided by the component, we should still
                // initialize it and provide a component handler for UI automation.
                if !controller_ptr.is_null() {
                    let ctrl_vtbl = get_vtbl::<IEditControllerVtbl>(controller_ptr);

                    // COM Identity Rule: QueryInterface(IUnknown) must return the same pointer
                    // if the objects are the same.
                    unsafe fn get_iunknown(ptr: *mut c_void) -> Option<*mut c_void> {
                        if ptr.is_null() {
                            return None;
                        }
                        let vtbl = get_vtbl::<FUnknownVtbl>(ptr);
                        let mut unknown_ptr: *mut c_void = std::ptr::null_mut();
                        let res = (vtbl.query_interface)(
                            ptr,
                            &crate::vst_host::c_api::IID_IUNKNOWN,
                            &mut unknown_ptr,
                        );
                        if res == K_RESULT_OK && !unknown_ptr.is_null() {
                            // We must release this immediately as QI adds a ref
                            let unknown_vtbl = get_vtbl::<FUnknownVtbl>(unknown_ptr);
                            (unknown_vtbl.release)(unknown_ptr);
                            Some(unknown_ptr)
                        } else {
                            None
                        }
                    }

                    let comp_identity = get_iunknown(component_ptr);
                    let ctrl_identity = get_iunknown(controller_ptr);

                    let is_same_object = match (comp_identity, ctrl_identity) {
                        (Some(a), Some(b)) => a == b,
                        _ => component_ptr == controller_ptr, // Fallback
                    };

                    // NOTE:
                    // COM的に同一オブジェクト（Identity Match）であっても、
                    // component.initialize() と controller.initialize() は別物。
                    // 一部プラグイン（OTT含む）は controller.initialize() を呼ばないと create_view() が不完全になる。
                    // そのため、同一判定でも controller.initialize() は常に呼ぶ。

                    let controller_ctx = host_ctx;

                    let _env_guard = EditorEnvGuard::enter_for_module(std::path::Path::new(&path));

                    if !controller_already_initialized {
                        let init_res = (ctrl_vtbl.initialize)(controller_ptr, controller_ctx);
                        println!(
                            "Controller initialize (from Component) returned: {} (same_object={})",
                            init_res, is_same_object
                        );

                        // [Fix] If same_object, treat '1' (kResultFalse) as success/already-init
                        let treat_as_success = is_same_object && init_res == 1;

                        if init_res != K_RESULT_OK && !treat_as_success {
                            eprintln!(
                                "Warning: Controller initialize (from Component) failed: {}",
                                init_res
                            );
                        } else if treat_as_success {
                            println!("[Quirk] OTT: Ignoring Controller initialize failure (same_object=true). Treating as success.");
                        }
                    }
                    let handler = get_mock_handler_ptr();
                    let handler_res = (ctrl_vtbl.set_component_handler)(controller_ptr, handler);
                    if handler_res != K_RESULT_OK {
                        eprintln!(
                            "Warning: set_component_handler (from Component) failed: {}",
                            handler_res
                        );
                    }

                    // IMPORTANT: Controller provided by Component でも、state同期を行う。
                    // これが無いと GUI が 4x4 のままになるプラグインがある（OTTで再現）。
                    // [Refinement] If same_object is true, state sync implies copying state to itself.
                    // OTT returns E_FAIL (-2147467263) for this.
                    // We should probably SKIP this if same_object is true, OR if set_component_state fail is harmless.
                    if !is_same_object {
                        let mut stream = MemoryStream::new();
                        let stream_ptr = &mut stream as *mut MemoryStream as *mut c_void;
                        let get_res = (component_vtbl.get_state)(component_ptr, stream_ptr);
                        println!(
                            "Controller sync (from Component): component.get_state returned: {}",
                            get_res
                        );
                        if get_res == K_RESULT_OK {
                            stream.cursor = 0;
                            let set_res =
                                (ctrl_vtbl.set_component_state)(controller_ptr, stream_ptr);
                            println!(
                                "Controller sync (from Component): set_component_state returned: {}",
                                set_res
                            );
                        }
                    } else {
                        println!("[Quirk] OTT: Skipping set_component_state (same_object=true) to avoid E_FAIL.");
                    }
                }
            }
            println!("Loaded plugin: {}", plugin_name);

            // Generate a simple unique ID
            use std::time::{SystemTime, UNIX_EPOCH};
            let start = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
            let id = format!("{}-{}", plugin_name, start.as_nanos());

            Ok(VstInstance {
                id, // Use the 'id' variable created above (plugin_name-nanos)
                name: plugin_name.to_string(),
                _library: lib,
                component: component_ptr,
                processor: processor_ptr,
                controller: controller_ptr,
                active_view: std::ptr::null_mut(),
                active_flag: Arc::new(AtomicBool::new(true)),
                editor_env: None,
                channels: 2,
                max_block_size: 0,
                host_app: host_app.into_raw(),
                path: path.to_string(),
                module_hmodule,
            })
        } // Close unsafe
    } // Close load

    pub fn finalize_connection(&self) -> Result<()> {
        println!("[Deferred] Finalizing connection for {}", self.name);

        unsafe {
            if self.component.is_null() || self.controller.is_null() {
                return Err(anyhow!(
                    "Cannot finalize connection: Component or Controller is null"
                ));
            }
            link_connection_points(
                self.component,
                self.controller,
                ConnectionOrder::ControllerFirst,
                "[Deferred]",
            );
        }
        Ok(())
    }

    pub fn needs_deferred_connection(&self) -> bool {
        // Quick check for now, ideally reuse get_plugin_quirks logic
        if self.name.contains("Insight 2") {
            return true;
        }
        false
    }

    // Create a processor handle to be moved to audio thread
    pub fn create_processor(&self) -> Option<VstProcessor> {
        if self.processor.is_null() {
            return None;
        }
        unsafe {
            let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.processor);
            (vtbl.base.add_ref)(self.processor);
        }

        let channels = self.channels.max(1);
        let cap = self.max_block_size.max(1024);
        let mut ins = Vec::with_capacity(channels);
        let mut outs = Vec::with_capacity(channels);
        for _ in 0..channels {
            ins.push(vec![0.0; cap]);
            outs.push(vec![0.0; cap]);
        }

        Some(VstProcessor {
            ptr: self.processor,
            _library: self._library.clone(),
            scratch_inputs: ins,
            scratch_outputs: outs,
            // Pre-allocate pointer vectors
            input_ptrs: Vec::with_capacity(channels),
            output_ptrs: Vec::with_capacity(channels),
            // Pre-allocate bus buffers
            bus_inputs: Vec::with_capacity(2),
            bus_outputs: Vec::with_capacity(2),
            active_flag: self.active_flag.clone(),
            max_block_size: cap,
            _num_channels: channels,
        })
    }

    pub fn prepare_processing(
        &mut self,
        sample_rate: f64,
        block_size: i32,
        channels: i32,
    ) -> Result<()> {
        unsafe {
            if self.component.is_null() || self.processor.is_null() {
                return Ok(());
            }

            let proc_vtbl = get_vtbl::<IAudioProcessorVtbl>(self.processor);
            let comp_vtbl = get_vtbl::<IComponentVtbl>(self.component);

            // 1. Setup Processing
            let mut setup = crate::vst_host::c_api::ProcessSetup {
                process_mode: crate::vst_host::c_api::K_REALTIME,
                symbolic_sample_size: crate::vst_host::c_api::K_SAMPLE_32,
                max_samples_per_block: block_size,
                sample_rate: sample_rate,
            };

            if (proc_vtbl.setup_processing)(self.processor, &mut setup as *mut _ as *mut c_void)
                != K_RESULT_OK
            {
                eprintln!("Warning: setup_processing failed");
            }

            // 2. Set Bus Arrangements (Stereo -> Stereo usually)
            // We verify if plugin supports it?
            // Just try to set what we have.
            // We need pointers to SpeakerArrangement (u64 bitmask?)
            // Wait, set_bus_arrangements takes *mut c_void for definitions?
            // Wrapper in vst3-sys implies SpeakerArrangement is needed.
            // But my definitions used c_void. Let's look at `set_bus_arrangements` signature in `c_api.rs`.
            // `inputs: *mut c_void, num_ins: i32, ...`
            // These void pointers are actually pointers to `SpeakerArrangement` (u64).

            // SpeakerArrangement: kStereo = 3 (bits 0 and 1 set)
            // NOTE: 初期実装は Stereo/Mono のみサポート。
            // 多chデバイス(ASIO 8ch等)でも、プラグインに渡すバスは基本Stereo(2ch)に固定する。
            let plugin_channels: i32 = if channels == 1 { 1 } else { 2 };

            let mut speaker_arr: u64 = if plugin_channels == 1 { 1 } else { 3 };

            // We pass pointers to valid arrangements
            // Check how many buses the plugin has.
            // For MVP assuming 1 input 1 output bus.
            let res = (proc_vtbl.set_bus_arrangements)(
                self.processor,
                &mut speaker_arr as *mut _ as *mut c_void,
                1, // num inputs
                &mut speaker_arr as *mut _ as *mut c_void,
                1, // num outputs
            );

            if res != K_RESULT_OK {
                eprintln!("Warning: set_bus_arrangements failed");
            }

            // 3. Activate Component
            if (comp_vtbl.set_active)(self.component, 1) != K_RESULT_OK {
                // 1 = true
                return Err(anyhow!("Failed to set component active"));
            }

            // 4. Set Processing Active
            let _ = (proc_vtbl.set_processing)(self.processor, 1);

            // eprintln!(
            //     "Plugin processing prepared: {}Hz, Block={}, Ch={}",
            //     sample_rate, block_size, channels
            // );

            // Store for create_processor
            self.channels = plugin_channels as usize;
            self.max_block_size = block_size.max(0) as usize;
        }
        Ok(())
    }

    pub fn latency_samples(&self) -> u32 {
        unsafe {
            if self.processor.is_null() {
                return 0;
            }
            let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.processor);
            (vtbl.get_latency_samples)(self.processor)
        }
    }

    pub fn open_editor(&mut self, parent_window: *mut c_void) -> Result<Option<ViewRect>> {
        unsafe {
            if self.controller.is_null() {
                // If controller null, maybe use component?
                // But we initialized controller in load().
                return Err(anyhow!("Plugin has no Edit Controller"));
            }

            // 既存があれば先に閉じる（環境復元/登録解除もここで行う）
            self.close_editor();

            // エディタ表示中の互換性向上（相対パス/補助DLL）
            let env_guard = EditorEnvGuard::enter_for_module(std::path::Path::new(&self.path))
                .ok_or_else(|| anyhow!("Invalid plugin path (no parent): {}", self.path))?;

            // Best-effort: state sync just before create_view().
            // OTTはロード時の controller.initialize/state同期が不安定なケースがあるため、
            // エディタを開くタイミングでも再同期しておく。
            if !self.component.is_null() && (self.name == "OTT" || self.name.contains("OTT")) {
                let comp_vtbl = get_vtbl::<IComponentVtbl>(self.component);
                let ctrl_vtbl = get_vtbl::<IEditControllerVtbl>(self.controller);

                let mut stream = MemoryStream::new();
                let stream_ptr = &mut stream as *mut MemoryStream as *mut c_void;

                let get_res = (comp_vtbl.get_state)(self.component, stream_ptr);
                println!(
                    "BP: pre-editor sync get_state res={} bytes={}",
                    get_res,
                    stream.data.len()
                );
                if get_res == K_RESULT_OK {
                    stream.cursor = 0;
                    let set_res = (ctrl_vtbl.set_component_state)(self.controller, stream_ptr);
                    println!("BP: pre-editor sync set_component_state res={}", set_res);
                }
            }

            let ctrl_vtbl = get_vtbl::<IEditControllerVtbl>(self.controller);

            // Try creating view with robust fallback strategy
            let mut view_ptr: *mut c_void = std::ptr::null_mut();
            let mut view_kind: &'static str = "<none>";

            let is_ott = self.name == "OTT" || self.name.contains("OTT");

            // 1. Try standard "editor"
            if view_ptr.is_null() {
                if let Ok(name) = std::ffi::CString::new("editor") {
                    view_ptr = (ctrl_vtbl.create_view)(self.controller, name.as_ptr());
                    if !view_ptr.is_null() {
                        view_kind = "\"editor\"";
                    }
                }
            }
            // Quirk: OTT はホスト/ビルドによって create_view("editor") がNULLになることがあるため、
            // NULL も試す（Element等の互換寄せ）。
            if is_ott && view_ptr.is_null() {
                view_ptr = (ctrl_vtbl.create_view)(self.controller, std::ptr::null());
                if !view_ptr.is_null() {
                    view_kind = "NULL(ott)";
                }
            }
            // 2. Try NULL (some plugins expect this)
            if view_ptr.is_null() {
                view_ptr = (ctrl_vtbl.create_view)(self.controller, std::ptr::null());
                if !view_ptr.is_null() {
                    view_kind = "NULL";
                }
            }
            // 3. Try empty string
            if view_ptr.is_null() {
                if let Ok(name) = std::ffi::CString::new("") {
                    view_ptr = (ctrl_vtbl.create_view)(self.controller, name.as_ptr());
                    if !view_ptr.is_null() {
                        view_kind = "\"\"";
                    }
                }
            }

            if view_ptr.is_null() {
                return Err(anyhow!(
                    "Failed to create editor view (returned null after all attempts)"
                ));
            }
            println!(
                "BP: create_view succeeded. kind={} ptr={:p}",
                view_kind, view_ptr
            );

            let view_vtbl = get_vtbl::<IPlugViewVtbl>(view_ptr);

            // resizeView() が呼ばれても正しくウィンドウサイズを変えられるよう、view->HWND を登録する
            let hwnd_raw = parent_window as isize;
            register_editor_view(view_ptr, hwnd_raw);
            let hwnd = HWND(parent_window);

            // Provide IPlugFrame so the plugin can request resize via resize_view().
            let frame = get_mock_plug_frame_ptr();
            let frame_res = (view_vtbl.set_frame)(view_ptr, frame);
            println!("BP: set_frame returned: {}", frame_res);

            let platform = std::ffi::CString::new("HWND").unwrap();

            // Check support
            if (view_vtbl.is_platform_type_supported)(view_ptr, platform.as_ptr()) != K_RESULT_OK {
                (view_vtbl.base.release)(view_ptr);
                unregister_editor_view(view_ptr);
                return Err(anyhow!("Plugin does not natively support HWND (Windows)"));
            }

            // [HiDPI Fix] Try to set content scale factor
            // Many modern VST3 plugins (e.g. OTT) default to HiDPI logic which might conflict
            // with our raw HWND if not explicitly set.
            // 実際のDPI倍率をプラグインへ通知（固定1.0はOTT等でレイアウト/描画が崩れることがある）
            use crate::vst_host::c_api::IPlugViewContentScaleSupportVtbl;
            // GUID for IPlugViewContentScaleSupport: 65ED9690-8AC4-45C5-8AAD-EF7D72695D34
            let iid_scale_support: [u8; 16] = [
                0x90, 0x96, 0xED, 0x65, 0xC4, 0x8A, 0xC5, 0x45, 0x8A, 0xAD, 0xEF, 0x7D, 0x72, 0x69,
                0x5D, 0x34,
            ];

            let mut scale_support_obj: *mut c_void = std::ptr::null_mut();
            let qi_res = (view_vtbl.base.query_interface)(
                view_ptr,
                &iid_scale_support,
                &mut scale_support_obj,
            );

            if qi_res == K_RESULT_OK && !scale_support_obj.is_null() {
                let dpi = GetDpiForWindow(hwnd);
                let mut scale = (dpi as f32) / 96.0;
                if !scale.is_finite() || scale < 1.0 {
                    scale = 1.0;
                }
                if scale > 4.0 {
                    scale = 4.0;
                }

                println!(
                    "BP: IPlugViewContentScaleSupport supported. Setting scale to {:.2} BEFORE ATTACH (dpi={})",
                    scale, dpi
                );
                let scale_vtbl = get_vtbl::<IPlugViewContentScaleSupportVtbl>(scale_support_obj);
                let set_res = (scale_vtbl.set_scale_factor)(scale_support_obj, scale);
                println!("BP: set_scale_factor({:.2}) returned: {}", scale, set_res);
                (scale_vtbl.base.release)(scale_support_obj);
            } else {
                println!("BP: IPlugViewContentScaleSupport NOT supported.");
            }

            // NOTE:
            // 一部プラグインは attach 前の get_size/on_size に弱い（初期化順序依存）ため、
            // サイズ交渉は attach 後に行う。
            let mut rect = ViewRect {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };

            // --- Size Probe (Pre-Attach) ---
            let mut pre_rect = rect;
            let pre_get_res = (view_vtbl.get_size)(view_ptr, &mut pre_rect);
            if pre_get_res == K_RESULT_OK {
                let w = pre_rect.right - pre_rect.left;
                let h = pre_rect.bottom - pre_rect.top;
                println!("Plugin initial size (pre-attach): {}x{}", w, h);
            } else {
                println!("Plugin get_size failed (pre-attach): {}", pre_get_res);
            }

            println!(
                "BP: Attempting attach. View={:p}, Parent={:p}",
                view_ptr, parent_window
            );

            // [HMODULE SPOOFING]
            // Swap Parent Window's HINSTANCE to Plugin's HMODULE *before* VSTGUI creates its child.
            // This tricks VSTGUI (via GetWindowLong(Parent, GWLP_HINSTANCE)) into thinking it's in the plugin context.
            let mut original_hinstance = 0isize;
            // let mut original_class_hmodule = 0isize;
            let _original_class_hmodule = 0isize;
            if !self.module_hmodule.0.is_null() {
                original_hinstance = GetWindowLongPtrW(HWND(parent_window as _), GWLP_HINSTANCE);
                // original_class_hmodule =
                //    GetClassLongPtrW(HWND(parent_window as _), GCLP_HMODULE) as isize;

                let plugin_hinst = self.module_hmodule.0 as isize;
                println!(
                    "BP: Spoofing Parent GWLP_HINSTANCE: {:#x} -> {:#x}",
                    original_hinstance, plugin_hinst
                );
                SetWindowLongPtrW(HWND(parent_window as _), GWLP_HINSTANCE, plugin_hinst);

                // println!(
                //    "BP: Spoofing Parent GCLP_HMODULE: {:#x} -> {:#x}",
                //    original_class_hmodule, plugin_hinst
                // );
                SetClassLongPtrW(HWND(parent_window as _), GCLP_HMODULE, plugin_hinst);
            }

            let res = (view_vtbl.attached)(view_ptr, parent_window, platform.as_ptr());

            // Restore Original HINSTANCE and GCLP_HMODULE
            // [CODEX ROUND 3 FIX] For OTT, do NOT restore GWLP_HINSTANCE.
            // VSTGUI does delayed resource lookups after attach, and restoring
            // the host's HINSTANCE causes "partial UI" (some elements missing).
            if !self.module_hmodule.0.is_null() {
                let is_ott = self.name == "OTT" || self.name.contains("OTT");
                if original_hinstance != 0 && !is_ott {
                    println!(
                        "BP: Restoring Parent GWLP_HINSTANCE -> {:#x}",
                        original_hinstance
                    );
                    SetWindowLongPtrW(HWND(parent_window as _), GWLP_HINSTANCE, original_hinstance);
                } else if is_ott {
                    println!(
                        "BP: [OTT Quirk] NOT restoring GWLP_HINSTANCE - keeping plugin HMODULE for delayed resource loading"
                    );
                }
                // [EXPERIMENTAL] Do NOT restore GCLP_HMODULE.
                // VSTGUI might lazy-load resources using GetClassLongPtr(Parent, GCLP_HMODULE).
                // If we restore it, it gets the Host EXE handle (no resources).
                /*
                if original_class_hmodule != 0 {
                    println!(
                        "BP: Restoring Parent GCLP_HMODULE -> {:#x}",
                        original_class_hmodule
                    );
                    SetClassLongPtrW(
                        HWND(parent_window as _),
                        GCLP_HMODULE,
                        original_class_hmodule,
                    );
                }
                */
            }

            println!("BP: Attach returned: {}", res);

            if res != K_RESULT_OK {
                (view_vtbl.base.release)(view_ptr);
                unregister_editor_view(view_ptr);
                return Err(anyhow!("Failed to attach view: {}", res));
            }

            // OTT/VSTGUI Fix: Patch GCLP_HMODULE for ALL child windows.
            // Some plugins create a container window, then a view window.
            // We must ensure the actual painting window gets the DLL HMODULE.
            if self.name == "OTT" || self.name.contains("OTT") {
                let children = find_all_plugin_child_hwnds(hwnd);
                if !children.is_empty() {
                    for child in children {
                        // Skip if child is same as parent (shouldn't happen with EnumChildWindows but safety check)
                        if child == hwnd {
                            continue;
                        }

                        // Patch GCLP_HMODULE (Removed due to safety concerns and ineffectiveness)
                        // If VSTGUI registers the class with the Host HMODULE, it's a plugin bug,
                        // but patching the global class affects all windows of that class.
                        // We rely on SetWindowLongPtrW (Instance) and kIBundlePathKey.

                        if !self.module_hmodule.0.is_null() {
                            // Apply HINSTANCE (Window)
                            let prev_inst = SetWindowLongPtrW(
                                child,
                                GWLP_HINSTANCE,
                                self.module_hmodule.0 as isize,
                            );

                            println!(
                                "BP: OTT Patching Child HWND {:?}: GWLP_HINSTANCE={:#x}->{:p}",
                                child, prev_inst, self.module_hmodule.0
                            );

                            // Force Redraw
                            // Note: InvalidateRect takes Option<HWND>, RedrawWindow might too via some bindings,
                            // but usually it takes HWND. If this fails to compile, I will check.
                            // Actually, previous log said "expected Option<HWND>".
                            let _ = RedrawWindow(
                                Some(child),
                                None,
                                None,
                                RDW_ERASE | RDW_FRAME | RDW_INVALIDATE | RDW_ALLCHILDREN,
                            );
                            let _ = UpdateWindow(child);
                        }
                    }
                } else {
                    println!("BP: OTT could not find ANY plugin child HWNDs.");
                }
            }

            // Explicitly set focus to the view to ensure event loop is active
            let _ = (view_vtbl.on_focus)(view_ptr, 1);
            println!("BP: Called on_focus(1)");

            // --- Size Negotiation (Post-Attach) ---
            let mut wants_default = true;
            if (view_vtbl.get_size)(view_ptr, &mut rect) == K_RESULT_OK {
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;
                println!("Plugin initial size (post-attach): {}x{}", w, h);
                if w >= 50 && h >= 50 {
                    wants_default = false;
                }
            } else {
                println!("Warning: get_size returned error post-attach.");
            }

            if wants_default {
                // まず大きめを投げ、プラグイン側に「正しい固定サイズ」へ丸めてもらう。
                // ただし OTT のように get_size が 4x4 を返す場合、attach 後だけだと間に合わないことがある。
                // そのため、ここでは (1) 可能なら pre-attach の値を採用し、それも小さいなら (2) check_size_constraint に委ねる。
                let pre_w = pre_rect.right - pre_rect.left;
                let pre_h = pre_rect.bottom - pre_rect.top;

                if pre_get_res == K_RESULT_OK && pre_w >= 50 && pre_h >= 50 {
                    rect = pre_rect;
                    println!("Using pre-attach size as baseline: {:?}", rect);
                } else {
                    rect = ViewRect {
                        left: 0,
                        top: 0,
                        right: 4096,
                        bottom: 4096,
                    };

                    let chk_res = (view_vtbl.check_size_constraint)(view_ptr, &mut rect);
                    println!(
                        "check_size_constraint returned: {} rect={:?}",
                        chk_res, rect
                    );

                    if chk_res != K_RESULT_OK {
                        // 未実装/失敗時は汎用の安全値へ
                        rect = ViewRect {
                            left: 0,
                            top: 0,
                            right: 800,
                            bottom: 600,
                        };
                    }
                }
            }

            // サイズ通知 + 再描画促進
            // 先にコンテナを合わせてから on_size を呼ぶ（サイズ不整合による描画欠けを避ける）
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            let _ = resize_child_hwnd(parent_window as isize, w, h);

            let on_size_res = (view_vtbl.on_size)(view_ptr, &mut rect);
            println!("on_size returned: {} rect={:?}", on_size_res, rect);

            // 念のため、on_size後の get_size をログ（OTTがここで正しい値になる場合がある）
            let mut after_rect = rect;
            let after_res = (view_vtbl.get_size)(view_ptr, &mut after_rect);
            println!(
                "get_size after on_size: res={} rect={:?}",
                after_res, after_rect
            );

            // attach後に正しいサイズが確定するプラグインがあるため、再取得して反映/返却する
            let mut final_rect = rect;
            if (view_vtbl.get_size)(view_ptr, &mut final_rect) == K_RESULT_OK {
                let w = final_rect.right - final_rect.left;
                let h = final_rect.bottom - final_rect.top;
                if w >= 50 && h >= 50 {
                    rect = final_rect;
                }
            }

            // OTT: VSTGUIの子HWNDがコンテナに追従しないケースがあるため、
            // attach直後に子HWNDを検出して 0,0 に move+resize する（白い余白/左上だけ描画の対策）。
            // OTT: VSTGUIの子HWNDがコンテナに追従しないケースがあるため、
            // attach直後に子HWNDを検出して 0,0 に move+resize する（白い余白/左上だけ描画の対策）。
            if self.name == "OTT" || self.name.contains("OTT") {
                // Use the robust find_all implementation
                let children = find_all_plugin_child_hwnds(hwnd);
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;

                for child in children {
                    if child == hwnd {
                        continue;
                    }
                    let class_name = hwnd_class_name(child);
                    println!(
                        "BP: Force-Move Child HWND {:?} class='{}' -> 0,0 {}x{}",
                        child, class_name, w, h
                    );

                    // SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS
                    // Force 0,0 relative to parent (container)
                    let _ = SetWindowPos(child, None, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
                }

                // Phase 4: JUCE-like IPlugViewContentScaleSupport initialization
                let mut obj_ptr: *mut c_void = std::ptr::null_mut();
                // Use view_vtbl valid in this scope
                let mut status = (view_vtbl.base.query_interface)(
                    view_ptr as *mut c_void,
                    &crate::vst_host::c_api::IID_IPLUGVIEWCONTENTSCALESUPPORT,
                    &mut obj_ptr,
                );

                if status != 0 {
                    // Try BE
                    status = (view_vtbl.base.query_interface)(
                        view_ptr as *mut c_void,
                        &crate::vst_host::c_api::IID_IPLUGVIEWCONTENTSCALESUPPORT_BE,
                        &mut obj_ptr,
                    );
                }

                if status == 0 && !obj_ptr.is_null() {
                    println!("BP: IPlugViewContentScaleSupport matched! Calling set_scale_factor(1.0) ...");
                    let scale_vtbl = obj_ptr
                        as *mut *mut crate::vst_host::c_api::IPlugViewContentScaleSupportVtbl;
                    let res = ((*(*scale_vtbl)).set_scale_factor)(obj_ptr, 1.0f32);
                    println!("BP: set_scale_factor(1.0) returned: {}", res);

                    // Release interface
                    let _ = ((*(*scale_vtbl)).base.release)(obj_ptr);
                } else {
                    println!("BP: IPlugViewContentScaleSupport NOT supported (tried LE and BE).");
                }
            }

            // Debug: OTTは「左上だけ描画される」事象があるので、子HWND/サイズを出す
            {
                let hwnd = HWND(parent_window);
                let dpi = GetDpiForWindow(hwnd);
                let mut client = RECT::default();
                let _ = GetClientRect(hwnd, &mut client);
                println!(
                    "BP: editor parent client={}x{} dpi={}",
                    client.right - client.left,
                    client.bottom - client.top,
                    dpi
                );

                // Codex Approach B: Log GWL_EXSTYLE for DirectComposition diagnostic
                let parent_exstyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                println!(
                    "BP: Parent HWND {:?} GWL_EXSTYLE={:#x}",
                    hwnd, parent_exstyle
                );

                // Check for problematic flags
                const WS_EX_NOREDIRECTIONBITMAP: isize = 0x00200000;
                const WS_EX_COMPOSITED: isize = 0x02000000;
                if parent_exstyle & WS_EX_NOREDIRECTIONBITMAP != 0 {
                    println!("  WARNING: Parent has WS_EX_NOREDIRECTIONBITMAP (may affect DComp)");
                }
                if parent_exstyle & WS_EX_COMPOSITED != 0 {
                    println!("  WARNING: Parent has WS_EX_COMPOSITED (may affect DComp)");
                }

                if self.name == "OTT" || self.name.contains("OTT") {
                    // Log child window styles too
                    let children = find_all_plugin_child_hwnds(hwnd);
                    for child in children {
                        let child_exstyle = GetWindowLongPtrW(child, GWL_EXSTYLE);
                        println!(
                            "BP: Child HWND {:?} GWL_EXSTYLE={:#x}",
                            child, child_exstyle
                        );
                        if child_exstyle & WS_EX_NOREDIRECTIONBITMAP != 0 {
                            println!("  WARNING: Child has WS_EX_NOREDIRECTIONBITMAP");
                        }
                        if child_exstyle & WS_EX_COMPOSITED != 0 {
                            println!("  WARNING: Child has WS_EX_COMPOSITED");
                        }
                    }
                    debug_dump_hwnd_children(hwnd, 20);
                }
            }

            self.active_view = view_ptr;
            let _ = (view_vtbl.on_focus)(view_ptr, 1);

            // close_editor まで環境を維持
            self.editor_env = Some(env_guard);
            update_editor_view_last_size(view_ptr, rect.right - rect.left, rect.bottom - rect.top);

            Ok(Some(rect))
        }
    }

    pub fn close_editor(&mut self) {
        unsafe {
            if !self.active_view.is_null() {
                println!("Closing editor for {}", self.name);
                let vtbl = get_vtbl::<IPlugViewVtbl>(self.active_view);

                // ベストエフォートでフレームを解除してから remove する（一部プラグインの後処理が安定する）
                let _ = (vtbl.set_frame)(self.active_view, std::ptr::null_mut());
                (vtbl.removed)(self.active_view);
                (vtbl.base.release)(self.active_view as *mut _);
                unregister_editor_view(self.active_view);
                self.active_view = std::ptr::null_mut();
            }

            // エディタを閉じたら環境も戻す
            self.editor_env = None;
        }
    }

    pub fn on_window_resized(&mut self, width: u32, height: u32) -> Result<()> {
        unsafe {
            if self.active_view.is_null() {
                return Ok(());
            }

            println!("[VstInstance] on_window_resized: {}x{}", width, height);

            let vtbl = get_vtbl::<IPlugViewVtbl>(self.active_view);
            let mut rect = ViewRect {
                left: 0,
                top: 0,
                right: width as i32,
                bottom: height as i32,
            };

            // Call on_size
            let res = (vtbl.on_size)(self.active_view, &mut rect);
            if res != K_RESULT_OK {
                eprintln!("[VstInstance] on_size failed: {}", res);
            } else {
                let mut check_rect = rect;
                let _ = (vtbl.get_size)(self.active_view, &mut check_rect);
                println!("[VstInstance] Plugin size after resize: {:?}", check_rect);
            }
            Ok(())
        }
    }
    pub fn get_state(&self) -> Result<String> {
        if self.component.is_null() {
            return Err(anyhow!("Component is null"));
        }
        unsafe {
            let component_vtbl = get_vtbl::<IComponentVtbl>(self.component);
            let mut stream = MemoryStream::new();
            let stream_ptr = &mut stream as *mut MemoryStream as *mut c_void;

            let res = (component_vtbl.get_state)(self.component, stream_ptr);
            if res != K_RESULT_OK {
                return Err(anyhow!("Failed to get state from component: {}", res));
            }

            // Encode to Base64
            use base64::{engine::general_purpose, Engine as _};
            let b64 = general_purpose::STANDARD.encode(&stream.data);
            Ok(b64)
        }
    }

    pub fn set_state(&self, state_b64: &str) -> Result<()> {
        if self.component.is_null() {
            return Err(anyhow!("Component is null"));
        }

        // Decode Base64
        use base64::{engine::general_purpose, Engine as _};
        let data = general_purpose::STANDARD
            .decode(state_b64)
            .context("mvn failed to decode state base64")?;

        unsafe {
            let mut stream = MemoryStream::new();
            stream.data = data;
            let stream_ptr = &mut stream as *mut MemoryStream as *mut c_void;

            let component_vtbl = get_vtbl::<IComponentVtbl>(self.component);
            let res = (component_vtbl.set_state)(self.component, stream_ptr);
            if res != K_RESULT_OK {
                eprintln!("Warning: Failed to set component state: {}", res);
                // We don't error out hard here, we try to sync controller too
            }

            // Sync Controller if exists
            if !self.controller.is_null() {
                let ctrl_vtbl = get_vtbl::<IEditControllerVtbl>(self.controller);
                stream.cursor = 0; // Rewind
                let res_ctrl = (ctrl_vtbl.set_component_state)(self.controller, stream_ptr);
                if res_ctrl != K_RESULT_OK {
                    eprintln!("Warning: Failed to sync controller state: {}", res_ctrl);
                } else {
                    println!("Controller state synchronized.");
                }
            }
        }
        Ok(())
    }
}

impl VstProcessor {
    pub fn process(
        &mut self,
        input_buffer: &[f32],
        output_buffer: &mut [f32],
        channels: usize,
        num_samples: usize,
    ) {
        unsafe {
            // KILL SWITCH check
            if !self.active_flag.load(Ordering::SeqCst) {
                output_buffer.fill(0.0);
                return;
            }

            if self.ptr.is_null() {
                return;
            }
            let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.ptr);

            // 1. スクラッチバッファの整合性チェック (Consistency check)
            if num_samples > self.max_block_size {
                output_buffer.fill(0.0);
                return;
            }

            // --- STABILITY GUARD: Channel Clamping ---
            // Device channels can be 8, but we only have scratch buffers for 2 (or whatever the plugin setup).
            // We must process only min(device, plugin) channels to avoid panic.
            let active_input_channels = std::cmp::min(channels, self.scratch_inputs.len());
            let active_output_channels = std::cmp::min(channels, self.scratch_outputs.len());
            let active_channels = std::cmp::min(active_input_channels, active_output_channels);

            // 2. 入力データのデインターリーブ (De-interleave)
            for ch in 0..active_channels {
                // Bounds check is implicit by using min() above, but we double check for safety
                if ch < self.scratch_inputs.len() {
                    let scratch_slice = &mut self.scratch_inputs[ch][..num_samples];
                    for i in 0..num_samples {
                        // Input buffer bounds check
                        let input_idx = i * channels + ch;
                        let val = if input_idx < input_buffer.len() {
                            input_buffer[input_idx]
                        } else {
                            0.0
                        };
                        scratch_slice[i] = val;
                    }
                }
            }

            // 2.5 Clear Output Buffers
            for ch in 0..active_channels {
                if ch < self.scratch_outputs.len() {
                    if num_samples <= self.scratch_outputs[ch].len() {
                        self.scratch_outputs[ch][..num_samples].fill(0.0);
                    }
                }
            }

            // 3. ポインタ配列の準備 (Prepare Pointers)
            self.input_ptrs.clear();
            self.output_ptrs.clear();

            // Only push pointers for active channels
            for ch in 0..active_channels {
                self.input_ptrs.push(self.scratch_inputs[ch].as_mut_ptr());
                self.output_ptrs.push(self.scratch_outputs[ch].as_mut_ptr());
            }

            // AudioBusBuffers の構築
            self.bus_inputs.clear();
            self.bus_outputs.clear();

            // Bus 0: メイン (Main) - Tell plugin the actual processed count
            self.bus_inputs.push(AudioBusBuffers {
                num_channels: active_channels as i32,
                silence_flags: 0, // TODO: calculate silence
                channel_buffers32: self.input_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: active_channels as i32,
                silence_flags: 0,
                channel_buffers32: self.output_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });

            // Bus 1: ダミー (Dummy)
            self.bus_inputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });

            let mut data = ProcessData {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                num_samples: num_samples as i32,
                num_inputs: 1, // Only main bus
                num_outputs: 1,
                inputs: self.bus_inputs.as_mut_ptr(),
                outputs: self.bus_outputs.as_mut_ptr(),
                input_events: std::ptr::null_mut(),
                output_events: std::ptr::null_mut(),
                input_param_changes: std::ptr::null_mut(),
                output_param_changes: std::ptr::null_mut(),
                process_context: std::ptr::null_mut(),
            };

            // 4. プラグイン処理実行
            let res = (vtbl.process)(self.ptr, &mut data as *mut _ as *mut c_void);

            // 5. 出力データのインターリーブ (Interleave Output)
            if res == K_RESULT_OK {
                for i in 0..num_samples {
                    // Process Active Channels
                    for ch in 0..active_channels {
                        let out_idx = i * channels + ch;
                        if out_idx < output_buffer.len() {
                            let val = self.scratch_outputs[ch][i];
                            output_buffer[out_idx] = val;
                        }
                    }
                    // Handle Remaining Channels (Silence Guard)
                    // If device has 8 channels but we only processed 2, silence 3-8 to prevent noise/garbage
                    for ch in active_channels..channels {
                        let out_idx = i * channels + ch;
                        if out_idx < output_buffer.len() {
                            output_buffer[out_idx] = 0.0;
                        }
                    }
                }
            } else {
                output_buffer.fill(0.0);
            }
        }
    }

    pub fn process_planar(
        &mut self,
        inputs: &[Vec<f32>],
        outputs: &mut [Vec<f32>],
        num_samples: usize,
    ) {
        unsafe {
            // KILL SWITCH check
            if !self.active_flag.load(Ordering::SeqCst) {
                // Silence outputs
                for ch_buf in outputs.iter_mut() {
                    if num_samples <= ch_buf.len() {
                        ch_buf[..num_samples].fill(0.0);
                    }
                }
                return;
            }

            if self.ptr.is_null() {
                return;
            }
            let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.ptr);

            // Safety Checks
            if num_samples > self.max_block_size {
                eprintln!("VstProcessor: num_samples > max_block_size");
                return;
            }

            // Determine active channels (min of provided inputs, provided outputs, and plugin caps)
            // Plugin caps are implicitly handled by how many pointers we push,
            // but we should respect what the plugin expects (setup in prepare).
            // here we assume inputs/outputs match the configured plugin channel count roughly.

            let ch_count = inputs
                .len()
                .min(outputs.len())
                .min(self.scratch_inputs.len()); // Clamp to initialized channel count

            // Prepare Pointers directly from arguments
            self.input_ptrs.clear();
            self.output_ptrs.clear();

            for i in 0..ch_count {
                // We trust the caller that vectors are large enough for num_samples
                self.input_ptrs.push(inputs[i].as_ptr() as *mut f32);
                self.output_ptrs.push(outputs[i].as_mut_ptr());
            }

            // AudioBusBuffers
            self.bus_inputs.clear();
            self.bus_outputs.clear();

            self.bus_inputs.push(AudioBusBuffers {
                num_channels: ch_count as i32,
                silence_flags: 0,
                channel_buffers32: self.input_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: ch_count as i32,
                silence_flags: 0,
                channel_buffers32: self.output_ptrs.as_mut_ptr(),
                channel_buffers64: std::ptr::null_mut(),
            });

            // Dummy Bus
            self.bus_inputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });
            self.bus_outputs.push(AudioBusBuffers {
                num_channels: 0,
                silence_flags: 0xffffffffffffffff,
                channel_buffers32: std::ptr::null_mut(),
                channel_buffers64: std::ptr::null_mut(),
            });

            let mut data = ProcessData {
                process_mode: K_REALTIME,
                symbolic_sample_size: K_SAMPLE_32,
                num_samples: num_samples as i32,
                num_inputs: 1,
                num_outputs: 1,
                inputs: self.bus_inputs.as_mut_ptr(),
                outputs: self.bus_outputs.as_mut_ptr(),
                input_events: std::ptr::null_mut(),
                output_events: std::ptr::null_mut(),
                input_param_changes: std::ptr::null_mut(),
                output_param_changes: std::ptr::null_mut(),
                process_context: std::ptr::null_mut(),
            };

            let res = (vtbl.process)(self.ptr, &mut data as *mut _ as *mut c_void);

            // 5. Clean up unused channels
            // (process_planar implies we write directly to outputs, but if outputs has more channels
            // than we processed, we MUST silence them to avoid garbage from previous frames in ring buffer)
            if res == K_RESULT_OK {
                for i in ch_count..outputs.len() {
                    // Safety check: Don't panic if outputs is weirdly sized
                    let buf = &mut outputs[i];
                    if num_samples <= buf.len() {
                        buf[..num_samples].fill(0.0);
                    }
                }
            } else {
                // If failed, silence valid channels too?
                // VST3 spec says if process returns error, outputs are undefined. Best to silence everything.
                for buf in outputs.iter_mut() {
                    if num_samples <= buf.len() {
                        buf[..num_samples].fill(0.0);
                    }
                }
            }
        }
    }
}

impl Drop for VstProcessor {
    fn drop(&mut self) {
        // println!("BP: VstProcessor Drop Start {:p}", self.ptr);
        unsafe {
            if !self.ptr.is_null() {
                let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.ptr);
                (vtbl.base.release)(self.ptr);
                // println!("BP: VstProcessor Release Called");
            }
        }
        // println!("BP: VstProcessor Drop End");
    }
}

// Ensure Drop handling cleans up VST objects safely
impl Drop for VstInstance {
    fn drop(&mut self) {
        // KILL SWITCH: Signal audio thread to stop ASAP
        self.active_flag.store(false, Ordering::SeqCst);

        unsafe {
            // Unlink explicitly to prevent circular references / messaging dead objects
            if !self.component.is_null() && !self.controller.is_null() {
                unlink_connection_points(self.component, self.controller);
            }
        }

        // 先にエディタ関連を確実に後始末（環境復元/登録解除含む）
        self.close_editor();

        unsafe {
            if !self.controller.is_null() {
                let vtbl = get_vtbl::<IEditControllerVtbl>(self.controller);
                (vtbl.terminate)(self.controller as *mut _);
                (vtbl.base.release)(self.controller as *mut _);
            }

            if !self.processor.is_null() {
                let vtbl = get_vtbl::<IAudioProcessorVtbl>(self.processor);
                (vtbl.set_processing)(self.processor as *mut _, 0);
                (vtbl.base.release)(self.processor as *mut _);
            }

            if !self.component.is_null() {
                let vtbl = get_vtbl::<IComponentVtbl>(self.component);
                (vtbl.set_active)(self.component as *mut _, 0);
                (vtbl.terminate)(self.component as *mut _);
                (vtbl.base.release)(self.component as *mut _);
            }

            // Release per-plugin host context last
            if is_owned_host_app_ptr(self.host_app) {
                drop_owned_host_app_ptr(self.host_app);
            }
            self.host_app = std::ptr::null_mut();
        }
    }
}
