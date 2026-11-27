//! トレイとグローバルショートカット。GPUI には無いので、Tauri が内部で使うのと同じ crate（tray-icon・global-hotkey）を
//! GPUI の主スレッドで作る。Windows の主スレッドのメッセージループを GPUI と共有できるかを確かめる。
//! 窓の × ではトレイへ隠す（Tauri 版と同じ。音は止めない）。GPUI に窓を隠す手段が無いので、Win32 の ShowWindow を使う。

use std::path::Path;

use auralyn_ui_model::shortcuts::{self, Binding};

use crate::i18n::Lang;

pub enum Action {
    Shortcut(shortcuts::Action),
    Show,
    Quit,
}

/// 保存したショートカット1つと、登録できなかった理由。
pub struct Registered {
    pub binding: Binding,
    pub error: Option<String>,
}

/// Tauri 版と同じ `shortcuts.json` を読む。無ければ既定。書き換えは Tauri 版の設定で行う（GPUI 版は読むだけ）。
/// `key` はキーを読む（[`shortcuts::check`]）。余分な項目がある組は、Tauri 版と同じく読めないものとする。
fn load<K: PartialEq>(
    config_dir: &Path,
    key: impl Fn(&str) -> Option<K>,
) -> Result<Vec<Binding>, String> {
    let bytes = match std::fs::read(config_dir.join("shortcuts.json")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(shortcuts::defaults()),
        Err(e) => return Err(e.to_string()),
    };
    let entries: Vec<serde_json::Map<String, serde_json::Value>> =
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let pairs = entries
        .iter()
        .map(|entry| {
            let field = |name| entry.get(name).and_then(|v| v.as_str()).map(str::to_owned);
            field("action")
                .zip(field("shortcut"))
                .filter(|_| entry.len() == 2)
                .ok_or_else(|| serde_json::Value::Object(entry.clone()).to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    shortcuts::check(pairs, key).map_err(|issue| issue.detail())
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::i18n::{core, keys};
    use global_hotkey::hotkey::HotKey;
    use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tray_icon::menu::{Menu, MenuEvent, MenuItem};
    use tray_icon::{
        Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOW};

    /// build.rs で実行ファイルに入れたアイコン（GPUI も窓とタスクバーに同じ番号を使う）。
    const APP_ICON: u16 = 1;

    /// 窓を隠す（トレイへ）・出す。窓の取っ手が取れなければ何もしない。
    pub fn set_shown(window: &gpui_kit::Window, shown: bool) {
        let Ok(handle) = HasWindowHandle::window_handle(window) else {
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
        _manager: Option<GlobalHotKeyManager>,
        /// 登録したキーの ID と操作。
        hotkeys: Vec<(u32, shortcuts::Action)>,
        pub shortcuts: Vec<Registered>,
        /// 保存を読めなかった理由。このときは1つも登録しない。
        pub shortcuts_error: Option<String>,
        pub tray_error: Option<String>,
    }

    impl Desktop {
        pub fn new(lang: Lang, config_dir: &Path) -> Self {
            let show = MenuItem::new(core(lang, keys::TRAY_SHOW), true, None);
            let mute = MenuItem::new(core(lang, keys::EMERGENCY), true, None);
            let quit = MenuItem::new(core(lang, keys::TRAY_QUIT), true, None);
            let menu = Menu::new();
            let tray = menu
                .append_items(&[&show, &mute, &quit])
                .map_err(|e| e.to_string())
                .and_then(|()| {
                    Icon::from_resource(APP_ICON, Some((32, 32))).map_err(|e| e.to_string())
                })
                .and_then(|icon| {
                    TrayIconBuilder::new()
                        .with_menu(Box::new(menu))
                        .with_tooltip("Auralyn")
                        .with_icon(icon)
                        .build()
                        .map_err(|e| e.to_string())
                });
            let (tray, tray_error) = split(tray);
            let loaded = load(config_dir, |s| s.parse::<HotKey>().ok().map(|k| k.id()));
            // 登録の仕組みを作れなければ、どの組も同じ理由で登録できない。
            let manager = GlobalHotKeyManager::new().map_err(|e| e.to_string());
            let mut hotkeys = Vec::new();
            let mut registered = Vec::new();
            let shortcuts_error = match loaded {
                Ok(bindings) => {
                    for binding in bindings {
                        let error = manager
                            .as_ref()
                            .map_err(Clone::clone)
                            .and_then(|manager| register(manager, &binding.shortcut))
                            .map(|id| hotkeys.push((id, binding.action)))
                            .err();
                        registered.push(Registered { binding, error });
                    }
                    None
                }
                Err(e) => Some(e),
            };
            Self {
                _tray: tray,
                show,
                mute,
                quit,
                _manager: manager.ok(),
                hotkeys,
                shortcuts: registered,
                shortcuts_error,
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
                if event.state != HotKeyState::Pressed {
                    continue;
                }
                if let Some(&(_, action)) = self.hotkeys.iter().find(|(id, _)| *id == event.id) {
                    actions.push(Action::Shortcut(action));
                }
            }
            while let Ok(event) = MenuEvent::receiver().try_recv() {
                if event.id == *self.show.id() {
                    actions.push(Action::Show);
                } else if event.id == *self.mute.id() {
                    actions.push(Action::Shortcut(shortcuts::Action::MuteToggle));
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

    /// 1つ登録し、その ID を返す。
    fn register(manager: &GlobalHotKeyManager, shortcut: &str) -> Result<u32, String> {
        let hotkey: HotKey = shortcut.parse().map_err(|e| format!("{e}"))?;
        manager.register(hotkey).map_err(|e| e.to_string())?;
        Ok(hotkey.id())
    }

    fn split<T>(result: Result<T, String>) -> (Option<T>, Option<String>) {
        match result {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    /// Windows 以外では作らない（対象は Windows だけ）。保存は読んで、登録できない理由を付けて見せる。
    pub struct Desktop {
        pub shortcuts: Vec<Registered>,
        pub shortcuts_error: Option<String>,
        pub tray_error: Option<String>,
    }

    impl Desktop {
        pub fn new(_lang: Lang, config_dir: &Path) -> Self {
            let (shortcuts, shortcuts_error) = match load(config_dir, |s| Some(s.to_owned())) {
                Ok(bindings) => (
                    bindings
                        .into_iter()
                        .map(|binding| Registered {
                            binding,
                            error: Some("Windows only".into()),
                        })
                        .collect(),
                    None,
                ),
                Err(e) => (Vec::new(), Some(e)),
            };
            Self {
                shortcuts,
                shortcuts_error,
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

impl Desktop {
    /// 登録できなかったショートカットがあるか。
    pub fn shortcut_failed(&self) -> bool {
        self.shortcuts.iter().any(|s| s.error.is_some())
    }
}
