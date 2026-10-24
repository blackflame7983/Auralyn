//! エディタのHWND、サイズ、登録状態。VSTインスタンスのロード処理から分離する。
use crate::vst_host::c_api::ViewRect;
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    AdjustWindowRectEx, EnumChildWindows, FindWindowExW, GetAncestor, GetClassNameW, GetClientRect,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextW, SetWindowPos, GA_ROOT, GWL_EXSTYLE,
    GWL_STYLE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, WINDOW_EX_STYLE, WINDOW_STYLE,
};

#[derive(Clone, Copy, Debug)]
pub(super) struct EditorViewState {
    pub(super) top_hwnd: isize,
    pub(super) container_hwnd: isize,
    pub(super) plugin_hwnd: isize,
    pub(super) last_good_w: i32,
    pub(super) last_good_h: i32,
}

fn editor_view_state_map() -> &'static Mutex<HashMap<usize, EditorViewState>> {
    static MAP: OnceLock<Mutex<HashMap<usize, EditorViewState>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn debug_dump_hwnd_children(root: HWND, max: usize) {
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

pub(super) fn register_editor_view(view: *mut c_void, container_hwnd: isize) {
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
pub(super) fn update_editor_view_plugin_hwnd(view: *mut c_void, plugin_hwnd: isize) {
    let mut map = editor_view_state_map().lock().unwrap();
    if let Some(state) = map.get_mut(&(view as usize)) {
        state.plugin_hwnd = plugin_hwnd;
    }
}

pub(super) fn update_editor_view_last_size(view: *mut c_void, w: i32, h: i32) {
    let mut map = editor_view_state_map().lock().unwrap();
    if let Some(state) = map.get_mut(&(view as usize)) {
        state.last_good_w = w;
        state.last_good_h = h;
    }
}

pub(super) fn unregister_editor_view(view: *mut c_void) {
    let mut map = editor_view_state_map().lock().unwrap();
    map.remove(&(view as usize));
}

pub(super) fn get_editor_view_state(view: *mut c_void) -> Option<EditorViewState> {
    let map = editor_view_state_map().lock().unwrap();
    map.get(&(view as usize)).copied()
}

pub(super) unsafe fn resize_hwnd_client(hwnd: isize, client_w: i32, client_h: i32) -> bool {
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

    // クライアント寸法が正でも、枠の加算後はi32の範囲を超え得る。
    let Some((outer_w, outer_h)) = (ViewRect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    })
    .checked_size() else {
        return false;
    };

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

pub(super) unsafe fn resize_child_hwnd(client_hwnd: isize, client_w: i32, client_h: i32) -> bool {
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

pub(super) unsafe fn move_resize_child_hwnd(
    child_hwnd: isize,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> bool {
    if w <= 0 || h <= 0 {
        return false;
    }
    let hwnd = HWND(child_hwnd as *mut c_void);
    SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE).is_ok()
}

pub(super) fn hwnd_class_name(hwnd: HWND) -> String {
    let mut class_buf = [0u16; 128];
    let class_len = unsafe { GetClassNameW(hwnd, &mut class_buf) };
    if class_len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&class_buf[..class_len as usize])
}

#[allow(dead_code)]
pub(super) fn find_primary_plugin_child_hwnd(container: HWND) -> Option<HWND> {
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
