//! トレイとグローバルホットキー。GPUI には無いので、Tauri が内部で使うのと同じ crate（tray-icon・global-hotkey）を
//! GPUI の主スレッドで作る。Windows の主スレッドのメッセージループを GPUI と共有できるかを確かめる。
//! 窓の × ではトレイへ隠す（Tauri 版と同じ。音は止めない）。GPUI に窓を隠す手段が無いので、Win32 の ShowWindow を使う。

use crate::i18n::Lang;

pub enum Action {
    ToggleMute,
    Show,
    Quit,
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::i18n::{core, keys};
    use global_hotkey::hotkey::{Code, HotKey, Modifiers};
    use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
    use raw_window_handle::{HasWindowHandle as _, RawWindowHandle};
    use tray_icon::menu::{Menu, MenuEvent, MenuItem};
    use tray_icon::{
        Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOW};

    /// 窓を隠す（トレイへ）・出す。窓の取っ手が取れなければ何もしない。
    pub fn set_shown(window: &gpui_kit::Window, shown: bool) {
        let Ok(handle) = window.window_handle() else {
            return;
        };
        let RawWindowHandle::Win32(handle) = handle.as_raw() else {
            return;
        };
        // SAFETY: `handle` は GPUI がいま持っている生きた窓のもので、この呼び出しは GPUI と同じ主スレッドで行う。
        // ShowWindow は窓の表示の状態を変えるだけで、メモリを渡さない。
        unsafe {
            ShowWindow(
                handle.hwnd.get() as windows_sys::Win32::Foundation::HWND,
                if shown { SW_SHOW } else { SW_HIDE },
            );
        }
    }

    pub struct Desktop {
        _tray: Option<TrayIcon>,
        show: MenuItem,
        mute: MenuItem,
        quit: MenuItem,
        _hotkeys: Option<GlobalHotKeyManager>,
        mute_hotkey: u32,
        pub hotkey_error: Option<String>,
        pub tray_error: Option<String>,
    }

    impl Desktop {
        pub fn new(lang: Lang) -> Self {
            let show = MenuItem::new(core(lang, keys::TRAY_SHOW), true, None);
            let mute = MenuItem::new(core(lang, keys::EMERGENCY), true, None);
            let quit = MenuItem::new(core(lang, keys::TRAY_QUIT), true, None);
            let menu = Menu::new();
            let tray = menu
                .append_items(&[&show, &mute, &quit])
                .map_err(|e| e.to_string())
                .and_then(|()| Icon::from_rgba(icon_rgba(), 32, 32).map_err(|e| e.to_string()))
                .and_then(|icon| {
                    TrayIconBuilder::new()
                        .with_menu(Box::new(menu))
                        .with_tooltip("Auralyn GPUI")
                        .with_icon(icon)
                        .build()
                        .map_err(|e| e.to_string())
                });
            let hotkey = HotKey::new(Some(Modifiers::ALT), Code::KeyM);
            let hotkeys = GlobalHotKeyManager::new()
                .map_err(|e| e.to_string())
                .and_then(|manager| {
                    manager
                        .register(hotkey)
                        .map(|()| manager)
                        .map_err(|e| e.to_string())
                });
            let (tray, tray_error) = split(tray);
            let (hotkeys, hotkey_error) = split(hotkeys);
            Self {
                _tray: tray,
                show,
                mute,
                quit,
                _hotkeys: hotkeys,
                mute_hotkey: hotkey.id(),
                hotkey_error,
                tray_error,
            }
        }

        pub fn set_lang(&self, lang: Lang) {
            self.show.set_text(core(lang, keys::TRAY_SHOW));
            self.mute.set_text(core(lang, keys::EMERGENCY));
            self.quit.set_text(core(lang, keys::TRAY_QUIT));
        }

        /// 描画の周期で呼ぶ。届いている操作を全部返す。
        pub fn poll(&self) -> Vec<Action> {
            let mut actions = Vec::new();
            while let Ok(event) = GlobalHotKeyEvent::receiver().try_recv() {
                if event.id == self.mute_hotkey && event.state == HotKeyState::Pressed {
                    actions.push(Action::ToggleMute);
                }
            }
            while let Ok(event) = MenuEvent::receiver().try_recv() {
                if event.id == *self.show.id() {
                    actions.push(Action::Show);
                } else if event.id == *self.mute.id() {
                    actions.push(Action::ToggleMute);
                } else if event.id == *self.quit.id() {
                    actions.push(Action::Quit);
                }
            }
            while let Ok(event) = TrayIconEvent::receiver().try_recv() {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    actions.push(Action::Show);
                }
            }
            actions
        }
    }

    fn split<T>(result: Result<T, String>) -> (Option<T>, Option<String>) {
        match result {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        }
    }

    /// オーロラの緑から青緑の丸。アイコンの画像ファイルは、配布の形を決めるときに用意する。
    fn icon_rgba() -> Vec<u8> {
        let mut rgba = Vec::with_capacity(32 * 32 * 4);
        for y in 0..32 {
            for x in 0..32 {
                let (dx, dy) = (x as f32 - 15.5, y as f32 - 15.5);
                let inside = dx * dx + dy * dy <= 15.0 * 15.0;
                let mix = x as f32 / 31.0;
                rgba.extend_from_slice(&[
                    (0x2f as f32 * (1.0 - mix) + 0x26 as f32 * mix) as u8,
                    (0xd0 as f32 * (1.0 - mix) + 0xc6 as f32 * mix) as u8,
                    (0x8a as f32 * (1.0 - mix) + 0xc2 as f32 * mix) as u8,
                    if inside { 255 } else { 0 },
                ]);
            }
        }
        rgba
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    /// Windows 以外では作らない（対象は Windows だけ）。
    pub struct Desktop {
        pub hotkey_error: Option<String>,
        pub tray_error: Option<String>,
    }

    impl Desktop {
        pub fn new(_lang: Lang) -> Self {
            Self {
                hotkey_error: None,
                tray_error: Some("Windows only".into()),
            }
        }

        pub fn set_lang(&self, _lang: Lang) {}

        pub fn poll(&self) -> Vec<Action> {
            Vec::new()
        }
    }

    pub fn set_shown(_window: &gpui_kit::Window, _shown: bool) {}
}

pub use imp::{set_shown, Desktop};
