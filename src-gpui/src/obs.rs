//! 設定の画面の「OBS への接続」：接続先（ホスト名・ポート・パスワード）と接続・切断。
//! 接続とパスワードの保存は `obs_link`（Tauri 版と同じ処理・同じ保存先）。入力の規則は `auralyn-ui-model` の `obs`。

use std::cell::Cell;
use std::path::Path;
use std::rc::Rc;

use auralyn_ui_model::obs::{self, State, Target, DEFAULT_HOST, DEFAULT_PORT};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::Disableable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{core, core_with, keys, Lang};
use crate::obs_link::{ObsLink, Order, Reply};
use crate::part::{card, note};

/// 画面からの OBS の命令の送り口（`MainView` が受けて描き直す）。
pub type OnOrder = Rc<dyn Fn(Order, &mut App)>;

pub struct ObsPanel {
    link: ObsLink,
    host: Entity<InputState>,
    port: Entity<InputState>,
    password: Entity<InputState>,
    connected: Option<bool>,
    /// 接続の命令を送り、まだ結果が届いていない（届くまで接続のボタンは押せない）。
    connecting: bool,
    /// OBS を扱うスレッドを動かせない理由。画面を開き直しても消さない。
    unavailable: Option<String>,
    saved: Result<Option<Target>, String>,
    use_saved: Rc<Cell<bool>>,
    /// 接続先の欄を、保存した接続先（無ければ既定）で埋めたか。埋めるのは最初の1回だけ。
    filled: bool,
    /// 直前の失敗。`bool` は接続の失敗か（接続の失敗だけ「接続に失敗しました」を前に付ける）。
    error: Option<(bool, String)>,
}

impl ObsPanel {
    pub fn new<V: 'static>(config_dir: &Path, window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            link: ObsLink::start(config_dir),
            host: cx.new(|cx| InputState::new(window, cx)),
            port: cx.new(|cx| InputState::new(window, cx)),
            password: cx.new(|cx| InputState::new(window, cx).masked(true)),
            connected: None,
            connecting: false,
            unavailable: None,
            saved: Ok(None),
            use_saved: Rc::new(Cell::new(true)),
            filled: false,
            error: None,
        }
    }

    /// 設定の画面を開いたとき。いまの状態を読み直す。
    pub fn open(&mut self) {
        self.error = None;
        self.link.send(Order::Read);
    }

    pub fn order(&mut self, order: Order) {
        self.error = None;
        if matches!(order, Order::Connect(_)) {
            self.connecting = true;
        }
        self.link.send(order);
    }

    /// 届いた返事を反映する。何か届いたら `true`。
    pub fn poll(&mut self, window: &mut Window, cx: &mut App) -> bool {
        let replies: Vec<Reply> = self.link.replies.try_iter().collect();
        let any = !replies.is_empty();
        for reply in replies {
            match reply {
                Reply::State {
                    connected,
                    saved,
                    after_connect,
                } => {
                    if after_connect {
                        self.connecting = false;
                        if connected {
                            self.password
                                .update(cx, |state, cx| state.set_value("", window, cx));
                        }
                    }
                    self.connected = Some(connected);
                    self.fill(saved.as_ref().ok().cloned().flatten(), window, cx);
                    self.saved = saved;
                }
                Reply::Failed { connect, message } => self.error = Some((connect, message)),
                Reply::Lost => self.link.send(Order::Read),
                Reply::Unavailable(message) => self.unavailable = Some(message),
            }
        }
        any
    }

    fn fill(&mut self, saved: Option<Target>, window: &mut Window, cx: &mut App) {
        if std::mem::replace(&mut self.filled, true) {
            return;
        }
        let (host, port) = saved.map_or((DEFAULT_HOST.to_string(), DEFAULT_PORT), |t| {
            (t.host, t.port)
        });
        self.host
            .update(cx, |state, cx| state.set_value(host, window, cx));
        self.port.update(cx, |state, cx| {
            state.set_value(port.to_string(), window, cx)
        });
    }

    fn state(&self) -> State {
        match self.connected {
            _ if self.connecting => State::Connecting,
            None => State::Checking,
            Some(true) => State::Connected,
            Some(false) => State::Disconnected,
        }
    }

    pub fn render(&self, lang: Lang, cx: &App, on: OnOrder) -> impl IntoElement {
        let state = self.state();
        let editable = state.editable();
        let host = self.host.read(cx).value();
        let port_text = self.port.read(cx).value();
        let saved = self.saved.as_ref().ok().and_then(Option::as_ref);
        let matches =
            obs::port(&port_text).is_some_and(|port| obs::saved_matches(saved, &host, port));
        let use_saved = matches && self.use_saved.get();
        let password = self.password.read(cx).value();
        let request = obs::request(&host, &port_text, &password, use_saved, saved);
        let status = match state {
            State::Checking => core(lang, keys::OBS_CHECKING).to_string(),
            State::Connecting => core(lang, keys::OBS_CONNECTING).to_string(),
            State::Disconnected => core(lang, keys::OBS_DISCONNECTED).to_string(),
            State::Connected => format!(
                "{} — {}",
                core(lang, keys::OBS_CONNECTED),
                core_with(
                    lang,
                    keys::OBS_TARGET,
                    &[("host", &host.trim()), ("port", &port_text.trim())]
                )
            ),
        };
        let field = |label: &'static str, input: &Entity<InputState>, disabled: bool| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(div().text_sm().child(core(lang, label)))
                .child(
                    Input::new(input)
                        .disabled(disabled)
                        .aria_label(core(lang, label)),
                )
        };
        card(
            core(lang, keys::OBS_TITLE),
            div().text_sm().child(status),
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_3()
                        .child(div().flex_1().min_w(px(200.)).child(field(
                            keys::OBS_HOST,
                            &self.host,
                            !editable,
                        )))
                        .child(div().w(px(120.)).child(field(
                            keys::OBS_PORT,
                            &self.port,
                            !editable,
                        ))),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(field(
                            keys::OBS_PASSWORD,
                            &self.password,
                            !editable || use_saved,
                        ))
                        .when(matches, |this| {
                            this.child(
                                Checkbox::new("obs-use-saved")
                                    .checked(use_saved)
                                    .disabled(!editable)
                                    .label(core(lang, keys::OBS_USE_SAVED))
                                    .on_click({
                                        let flag = self.use_saved.clone();
                                        move |checked, window, _| {
                                            flag.set(*checked);
                                            window.refresh();
                                        }
                                    }),
                            )
                        })
                        .child(note(core(lang, keys::OBS_PASSWORD_SCOPE))),
                )
                .when(self.saved.is_err(), |this| {
                    this.child(note(core(lang, keys::OBS_SAVED_UNREADABLE)))
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .map(|this| {
                            let on = on.clone();
                            if state == State::Connected {
                                this.child(
                                    Button::new("obs-disconnect")
                                        .label(core(lang, keys::OBS_DISCONNECT))
                                        .outline()
                                        .on_click(move |_, _, cx| on(Order::Disconnect, cx)),
                                )
                            } else {
                                this.child(
                                    Button::new("obs-connect")
                                        .label(core(lang, keys::OBS_CONNECT))
                                        .primary()
                                        .disabled(!editable || request.is_none())
                                        .on_click(move |_, _, cx| {
                                            if let Some(request) = request.clone() {
                                                on(Order::Connect(request), cx);
                                            }
                                        }),
                                )
                            }
                        })
                        .when(saved.is_some() || self.saved.is_err(), |this| {
                            this.child(
                                Button::new("obs-forget")
                                    .label(core(lang, keys::OBS_FORGET))
                                    .ghost()
                                    .disabled(!editable)
                                    .on_click(move |_, _, cx| on(Order::Forget, cx)),
                            )
                        }),
                )
                .when(state == State::Connected, |this| {
                    this.child(note(core(lang, keys::OBS_EDIT_HINT)))
                })
                .when_some(self.unavailable.as_ref(), |this, message| {
                    this.child(note(format!("{} {message}", core(lang, keys::OBS_FAILED))))
                })
                .when_some(self.error.as_ref(), |this, (connect, message)| {
                    this.child(note(if *connect {
                        format!("{} {message}", core(lang, keys::OBS_FAILED))
                    } else {
                        message.clone()
                    }))
                })
                .child(note(core(lang, keys::OBS_NEEDS)))
                .child(note(core(lang, keys::OBS_SERVER))),
        )
    }
}
