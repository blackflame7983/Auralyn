//! 設定の画面の「OBS への接続」：接続先（ホスト名・ポート・パスワード）と接続・切断。
//! 接続とパスワードの保存は `obs_link`（Tauri 版と同じ処理・同じ保存先）。入力の規則は `auralyn-ui-model` の `obs`。

use std::cell::Cell;
use std::path::Path;
use std::rc::Rc;
use std::time::{Duration, Instant};

use auralyn_ui_model::obs::{
    self, Reach, State, Target, Verdict, DEFAULT_HOST, DEFAULT_PORT, RECHECK_MS,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::Disableable as _;
use gpui_kit::component::WindowExt as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{core, core_with, keys, Lang};
use crate::obs_changes::Changes;
use crate::obs_link::{ObsLink, Order, Reply, Setup, SetupDone};
use crate::obs_timing::TimingPanel;
use crate::part::{card, note, paragraphs, with_hint};

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
    /// 最後のテスト音での到達確認。
    reach: Option<Reach>,
    /// テスト音の確認を送って、まだ結果が届いていない。
    reaching: bool,
    reach_error: Option<String>,
    rechecked: Instant,
    /// 読み直しの答えを待っている（OBS の返事が遅いとき、読み直しを重ねて接続・切断を待たせない）。
    asking: bool,
    /// まだ連動に渡していない、最後に替わったシーン。続けて替わったら最後だけを使う。
    scene: Option<String>,
    changes: Changes,
    timing: TimingPanel,
}

impl ObsPanel {
    pub fn new<V: 'static>(
        config_dir: &Path,
        engine: flume::WeakSender<crate::engine::Command>,
        timing: vst_host_lib::obs_timing::Conditions,
        window: &mut Window,
        cx: &mut Context<V>,
    ) -> Self {
        Self {
            link: ObsLink::start(config_dir, engine, timing),
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
            reach: None,
            reaching: false,
            reach_error: None,
            rechecked: Instant::now(),
            asking: false,
            scene: None,
            changes: Changes::default(),
            timing: TimingPanel::new(window, cx),
        }
    }

    /// 替わったシーン（シーンの連動へ渡す）。
    pub fn take_scene(&mut self) -> Option<String> {
        self.scene.take()
    }

    /// 設定の画面を出している間、到達確認の結果がまだ今の条件のものかを読み直す。
    pub fn recheck(&mut self) {
        if self.reaching
            || self.asking
            || self.rechecked.elapsed() < Duration::from_millis(RECHECK_MS)
        {
            return;
        }
        self.rechecked = Instant::now();
        if let Some(operation) = self.reach.as_ref().and_then(Reach::recheck) {
            self.asking = true;
            self.link.send(Order::ReachCurrent(operation.to_string()));
        }
    }

    /// 設定の画面を開いたとき。いまの状態を読み直す。
    pub fn open(&mut self) {
        self.error = None;
        self.link.send(Order::Read);
        self.order(Order::Setup(Setup::History));
        // 見ていない間に音声の条件が変わっているかもしれないので、すぐに読み直す。
        self.rechecked = Instant::now()
            .checked_sub(Duration::from_millis(RECHECK_MS))
            .unwrap_or_else(Instant::now);
    }

    pub fn order(&mut self, order: Order) {
        self.error = None;
        match order {
            Order::Setup(Setup::Discard) => return self.changes.discard(),
            // ホストは対象を読むとき、どの変更予定も捨てる。
            Order::Setup(Setup::Targets) => {
                self.timing.forget_targets();
                self.changes.discard();
                self.changes.sent();
            }
            Order::Setup(Setup::Timing(_)) => {
                self.timing.asked();
                self.changes.sent();
            }
            Order::Setup(_) => self.changes.sent(),
            Order::Connect(_) => self.connecting = true,
            // 確かめ始めたら、前の結果はもう今のものではない（ホストも無効にする）。
            Order::CheckReach => {
                self.reaching = true;
                self.reach = None;
                self.reach_error = None;
            }
            _ => {}
        }
        self.link.send(order);
    }

    /// 届いた返事を反映する。何か届いたら `true`。
    pub fn poll(&mut self, window: &mut Window, cx: &mut App) -> bool {
        let replies: Vec<Reply> = self.link.replies.try_iter().collect();
        let mut any = !replies.is_empty();
        if self.timing.take_edited() {
            self.changes.discard_timing();
            any = true;
        }
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
                            self.order(Order::Setup(Setup::History));
                            self.password
                                .update(cx, |state, cx| state.set_value("", window, cx));
                        }
                    }
                    // 接続が替われば、前の到達確認は今の接続のものではない。
                    if !connected {
                        self.reach = None;
                        self.reach_error = None;
                        self.changes.discard();
                        self.timing.reset();
                        // 切断中の履歴は「この接続では元に戻せない」に変わる。
                        if self.connected == Some(true) {
                            self.order(Order::Setup(Setup::History));
                        }
                    }
                    self.connected = Some(connected);
                    self.fill(saved.as_ref().ok().cloned().flatten(), window, cx);
                    self.saved = saved;
                }
                Reply::Failed { connect, message } => self.error = Some((connect, message)),
                // 切れる前に届いたシーンでは動かない（Tauri 版も動く直前に接続を確かめる）。
                Reply::Lost => {
                    self.scene = None;
                    self.link.send(Order::Read);
                }
                Reply::Scene(scene) => self.scene = Some(scene),
                Reply::Unavailable(message) => self.unavailable = Some(message),
                Reply::Targets(targets) => {
                    self.changes.settled();
                    // 切断のあとに届いた一覧は、もう今の接続のものではない。
                    if self.connected == Some(true) {
                        self.timing.set_targets(*targets);
                    }
                }
                Reply::Setup(done) => {
                    let done = *done;
                    // OBS のオフセットが変われば、読んだ対象の「現在」はもう今の値ではない。
                    let moved = matches!(
                        &done,
                        SetupDone::Applied(Ok(h)) | SetupDone::Restored(Ok(h)) if h.timing.is_some()
                    );
                    let stale = matches!(
                        &done,
                        SetupDone::Plan(Ok(plan)) if plan.timing.is_some() && !self.timing.plan_current()
                    );
                    self.changes.done(done);
                    if moved {
                        self.timing.reset();
                    }
                    // 頼んだあと入力を変えたなら、届いた予定は今の入力のものではない。
                    if stale {
                        self.changes.discard_timing();
                    }
                }
                Reply::Reach(result) => {
                    self.reaching = false;
                    match result {
                        Ok(reach) => self.reach = Some(reach),
                        Err(message) => self.reach_error = Some(message),
                    }
                }
                Reply::ReachCurrent { operation, current } => {
                    self.asking = false;
                    if let Some(reach) = self.reach.as_mut() {
                        reach.answer(&operation, current);
                    }
                }
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
        let connect_reason = match () {
            _ if !editable || state == State::Connected || request.is_some() => None,
            _ if host.trim().is_empty() => Some(keys::REASON_OBS_HOST),
            _ => Some(keys::REASON_OBS_PORT),
        };
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
                        }),
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
                                        .disabled(self.changes.busy())
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
                            let on = on.clone();
                            this.child(
                                Button::new("obs-forget")
                                    .label(core(lang, keys::OBS_FORGET))
                                    .outline()
                                    .disabled(!editable)
                                    .on_click(move |_, _, cx| on(Order::Forget, cx)),
                            )
                        })
                        .when_some(connect_reason, |this, key| {
                            this.child(note(core(lang, key)))
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
                .when(state == State::Connected, |this| {
                    this.child(self.render_reach(lang, on.clone()))
                })
                .child(self.timing.render(
                    lang,
                    cx,
                    state == State::Connected,
                    self.changes.busy() || self.reaching,
                    on.clone(),
                ))
                .child(
                    self.changes
                        .render(lang, state == State::Connected, self.reaching, on),
                )
                .child(note(core(lang, keys::OBS_NEEDS))),
        )
        .icon(IconName::Cast)
        .hint(
            lang,
            paragraphs(lang, &[keys::OBS_SERVER, keys::OBS_PASSWORD_SCOPE]),
        )
    }

    fn render_reach(&self, lang: Lang, on: OnOrder) -> impl IntoElement {
        let verdict = self.reach.as_ref().map(|reach| {
            let peak = reach
                .peak_db
                .map(|peak| core_with(lang, keys::OBS_PEAK, &[("peak", &format!("{peak:.1}"))]))
                .unwrap_or_default();
            match reach.verdict() {
                Verdict::Confirmed => format!("{}{peak}", core(lang, keys::OBS_REACHED)),
                Verdict::NotReached => format!(
                    "{}{peak} {}",
                    core(lang, keys::OBS_NOT_REACHED),
                    core(lang, keys::OBS_NOT_REACHED_HINT)
                ),
                Verdict::Unsupported => core(lang, keys::OBS_METER_UNSUPPORTED).to_string(),
                Verdict::Stale => core(lang, keys::OBS_REACH_STALE).to_string(),
            }
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(crate::color::border())
            .child(with_hint(
                "obs-reach-hint",
                lang,
                core(lang, keys::OBS_REACH_SCOPE),
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .child(core(lang, keys::OBS_REACH_TITLE)),
            ))
            .child(
                div().child(
                    Button::new("obs-reach")
                        .label(core(
                            lang,
                            if self.reaching {
                                keys::OBS_REACHING
                            } else {
                                keys::OBS_REACH_CHECK
                            },
                        ))
                        .outline()
                        .disabled(self.reaching || self.changes.busy())
                        .on_click(move |_, window, cx| {
                            let on = on.clone();
                            window.open_alert_dialog(cx, move |alert, _, _| {
                                let on = on.clone();
                                alert
                                    .title(core(lang, keys::OBS_REACH_CONFIRM_TITLE))
                                    .description(core(lang, keys::OBS_REACH_CONFIRM_TEXT))
                                    .ok_text(core(lang, keys::OBS_REACH_PLAY))
                                    .cancel_text(core(lang, keys::CANCEL))
                                    .show_cancel(true)
                                    .on_ok(move |_, _, cx| {
                                        on(Order::CheckReach, cx);
                                        true
                                    })
                            });
                        }),
                ),
            )
            .when_some(verdict, |this, verdict| {
                this.child(div().text_sm().child(verdict))
            })
            .when_some(self.reach_error.as_ref(), |this, message| {
                this.child(note(format!(
                    "{} {}",
                    core(lang, keys::OBS_REACH_FAILED),
                    crate::obs_text::original(lang, message)
                )))
            })
    }
}
