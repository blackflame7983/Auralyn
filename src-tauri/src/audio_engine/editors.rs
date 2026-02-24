use crate::vst_host::instance::VstInstance;
use anyhow::{anyhow, Result};
use log;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use std::collections::HashMap;
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrA, RegisterClassExW,
    SetWindowLongPtrA, SetWindowPos, CS_HREDRAW, CS_OWNDC, CS_VREDRAW, GWL_STYLE, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOZORDER, WINDOW_EX_STYLE, WM_ERASEBKGND, WNDCLASSEXW, WS_CHILD,
    WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
};
use winit::event_loop::EventLoopWindowTarget;
use winit::window::{Window, WindowBuilder, WindowId};

pub struct EditorManager {
    editor_windows: HashMap<String, Window>,
    editor_children: HashMap<String, HWND>,
    window_id_to_plugin: HashMap<WindowId, String>,
}

impl EditorManager {
    pub fn new() -> Self {
        Self {
            editor_windows: HashMap::new(),
            editor_children: HashMap::new(),
            window_id_to_plugin: HashMap::new(),
        }
    }

    fn ensure_container_class(hinstance: HINSTANCE) -> Result<()> {
        unsafe extern "system" fn wnd_proc(
            hwnd: HWND,
            msg: u32,
            wparam: WPARAM,
            lparam: LPARAM,
        ) -> LRESULT {
            // 重要: 背景消去を抑制（白塗り→プラグインの描画が間に合わず白が見えるのを減らす）
            if msg == WM_ERASEBKGND {
                return LRESULT(1);
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }

        unsafe {
            log::debug!(
                "[EditorManager] ensure_container_class: Checking registration for hinstance={:?}",
                hinstance
            );

            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_HREDRAW | CS_VREDRAW | CS_OWNDC,
                lpfnWndProc: Some(wnd_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance,
                hIcon: Default::default(),
                hCursor: Default::default(),
                hbrBackground: Default::default(),
                lpszMenuName: w!(""),
                lpszClassName: w!("AuralynVstContainer"),
                hIconSm: Default::default(),
            };

            let atom = RegisterClassExW(&wc);
            if atom == 0 {
                let err_code = GetLastError();
                if err_code == windows::Win32::Foundation::ERROR_CLASS_ALREADY_EXISTS {
                    // This is expected if already registered
                    // println!("[EditorManager] Window class 'AuralynVstContainer' already registered.");
                    return Ok(());
                } else {
                    // Real error
                    let err_msg = format!(
                        "[EditorManager] RegisterClassExW failed. GetLastError={:?}",
                        err_code
                    );
                    log::error!("{}", err_msg);
                    return Err(anyhow!(err_msg));
                }
            }
            log::info!("[EditorManager] Window class 'AuralynVstContainer' registered successfully. Atom={}", atom);

            Ok(())
        }
    }

    fn create_container_hwnd(parent: HWND, width: i32, height: i32) -> Result<HWND> {
        unsafe {
            let hinstance = GetModuleHandleW(None)
                .map(|m| HINSTANCE(m.0))
                .map_err(|e| anyhow!("GetModuleHandleW: {e:?}"))?;

            Self::ensure_container_class(hinstance)?;

            // NOTE: 専用の子ウィンドウ（コンテナ）を作り、そこに IPlugView::attached する。
            // これが一般的なVSTホストの構成で、描画/クリッピングの互換性が高い。
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("AuralynVstContainer"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                width,
                height,
                Some(parent),
                None,
                Some(hinstance),
                None,
            )
            .map_err(|e| anyhow!("CreateWindowExW: {e:?}"))?;

            if hwnd.0.is_null() {
                return Err(anyhow!("Failed to create editor container HWND"));
            }

            Ok(hwnd)
        }
    }

    pub fn open_editor<T>(
        &mut self,
        instance: &mut VstInstance,
        target: &EventLoopWindowTarget<T>,
    ) -> Result<()> {
        let id = instance.id.clone();

        // Prevent opening duplicate windows (optional, logic wasn't explicit in core.rs but good practice)
        if self.editor_windows.contains_key(&id) {
            // Already open, maybe focus it?
            if let Some(win) = self.editor_windows.get(&id) {
                win.focus_window();
            }
            return Ok(());
        }

        let win = WindowBuilder::new()
            .with_title(format!("Editor: {}", instance.name))
            .with_inner_size({
                log::debug!(
                    "[EditorManager] Using 800x600 default (plugin negotiates later). Name='{}'",
                    instance.name
                );
                winit::dpi::LogicalSize::new(800.0, 600.0)
            })
            .build(target)
            .map_err(|e| anyhow!("Failed to create window: {}", e))?;

        log::debug!(
            "[EditorManager] Window created. Inner Size: {:?}",
            win.inner_size()
        );

        // Set Always on Top
        win.set_window_level(winit::window::WindowLevel::AlwaysOnTop);

        let rect_opt = {
            let raw_handle = win
                .window_handle()
                .map_err(|e| anyhow!("Failed to get raw window handle: {}", e))?;
            match raw_handle.as_raw() {
                RawWindowHandle::Win32(handle) => {
                    let parent_hwnd = HWND(handle.hwnd.get() as _);

                    // [Win32 Fix] Enforce WS_CLIPCHILDREN | WS_CLIPSIBLINGS
                    // This is CRITICAL for preventing black screens where the child (VST) is not clipped/painted correctly.
                    unsafe {
                        let current_style = GetWindowLongPtrA(parent_hwnd, GWL_STYLE) as u32;
                        let new_style = current_style | WS_CLIPCHILDREN.0 | WS_CLIPSIBLINGS.0;
                        if current_style != new_style {
                            SetWindowLongPtrA(parent_hwnd, GWL_STYLE, new_style as isize);
                            log::debug!("[EditorManager] Applied WS_CLIPCHILDREN | WS_CLIPSIBLINGS (Style: {:X} -> {:X})", current_style, new_style);
                        }
                    }

                    let size = win.inner_size();
                    let container_hwnd = Self::create_container_hwnd(
                        parent_hwnd,
                        size.width as i32,
                        size.height as i32,
                    )?;
                    self.editor_children.insert(id.clone(), container_hwnd);

                    let hwnd_ptr = container_hwnd.0 as *mut std::ffi::c_void;
                    instance.open_editor(hwnd_ptr)?
                }
                _ => {
                    return Err(anyhow!(
                        "Unsupported platform for VST Editor (Win32 required)"
                    ))
                }
            }
        };

        if let Some(rect) = rect_opt {
            let width = (rect.right - rect.left).abs() as u32; // Use u32 for PhysicalSize
            let height = (rect.bottom - rect.top).abs() as u32;
            if width > 0 && height > 0 {
                log::debug!(
                    "[EditorManager] Enforcing window size from plugin negotiation: {}x{}",
                    width, height
                );
                // Use PhysicalSize to ensure exact pixel mapping for VSTs
                let _ = win.request_inner_size(winit::dpi::PhysicalSize::new(width, height));

                // 子ウィンドウ（コンテナ）も即座に追従させる（winitイベントが来る前のチラつき防止）
                if let Some(child) = self.editor_children.get(&id) {
                    unsafe {
                        let _ = SetWindowPos(
                            *child,
                            None,
                            0,
                            0,
                            width as i32,
                            height as i32,
                            SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                }
            }
        }

        let win_id = win.id();
        self.editor_windows.insert(id.clone(), win);
        self.window_id_to_plugin.insert(win_id, id);

        Ok(())
    }

    // Returns the plugin ID if a window was closed, so the caller can notify the plugin instance
    pub fn handle_close_requested(&mut self, window_id: WindowId) -> Option<String> {
        if let Some(plugin_id) = self.window_id_to_plugin.remove(&window_id) {
            if let Some(child) = self.editor_children.remove(&plugin_id) {
                unsafe {
                    let _ = DestroyWindow(child);
                }
            }
            self.editor_windows.remove(&plugin_id);
            Some(plugin_id)
        } else {
            None
        }
    }

    pub fn handle_resized(&mut self, window_id: WindowId, size: winit::dpi::PhysicalSize<u32>) {
        let Some(plugin_id) = self.window_id_to_plugin.get(&window_id) else {
            return;
        };
        let Some(child) = self.editor_children.get(plugin_id) else {
            return;
        };

        unsafe {
            let _ = SetWindowPos(
                *child,
                None,
                0,
                0,
                size.width as i32,
                size.height as i32,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    // Explicit close (e.g. unload plugin)
    pub fn close_editor(&mut self, plugin_id: &str) {
        if let Some(child) = self.editor_children.remove(plugin_id) {
            unsafe {
                let _ = DestroyWindow(child);
            }
        }
        if let Some(win) = self.editor_windows.remove(plugin_id) {
            let win_id = win.id();
            self.window_id_to_plugin.remove(&win_id);
            // Window dropped here
        }
    }

    pub fn get_plugin_id(&self, window_id: WindowId) -> Option<String> {
        self.window_id_to_plugin.get(&window_id).cloned()
    }
}
