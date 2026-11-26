//! ホームの「接続の確認」（Tauri 版の `PreparationPanel`）。音づくり・ボイスチェック・送り先を利用者が確かめたことを記録し、
//! 音声の条件が変わったら「設定が変わりました」に戻す。規則は `auralyn-ui-model` の `preparation`、状態はエンジンの `preparation`。

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use auralyn_ui_model::preparation::{
    self, normalize_receiver, Availability, Context as PrepContext, Keys, Location, Next, Records,
    Signal, Stage, State, Usage,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{Disableable as _, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::engine::{Command, Observation};
use crate::i18n::{core, keys, Lang};
use crate::part::{choices, note};

/// Tauri 版と同じ、見ている間の読み直しの間隔。
const POLL: Duration = Duration::from_secs(2);

pub type OnAction = Rc<dyn Fn(Action, &mut Window, &mut App)>;
pub type OnGoto = Rc<dyn Fn(Goto, &mut Window, &mut App)>;

/// 「接続の確認」から開く先。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Goto {
    Connect,
    Sound,
    /// 設定の OBS連携 のタブ。
    Obs,
}

#[derive(Clone, Copy, Debug)]
pub enum Action {
    Location(Location),
    Signal(Signal),
    Usage(Usage),
    Confirm(Stage),
    Unconfirm(Stage),
    /// VST の画面や機器のつまみで音を変えた：確認をやり直す。
    Reset,
    Refresh,
    Toggle,
}

pub struct PrepPanel {
    config_dir: PathBuf,
    context: PrepContext,
    receiver: Entity<InputState>,
    receiver_edited: Rc<Cell<bool>>,
    /// 最後に読んだ状態。`None` は読めていない。
    observation: Option<Observation>,
    records: Records,
    /// 読むのを頼んで、まだ届いていない。
    asking: bool,
    polled: Instant,
    /// 確認の記録を頼んだ印・確かめること・頼んだときの鍵。読み直した鍵が同じときだけ記録する。
    confirming: Option<(u64, Stage, String)>,
    sequence: u64,
    /// 窓を隠していた（隠している間の外での変更は鍵に出ないので、出し直したら確認をやり直す）。
    hidden: bool,
    /// 送り先の種類を替えたので、名前の欄を空にする（欄を書き換えるには窓が要るので次の `tick` で）。
    clear_receiver: bool,
    /// 利用者が開閉を選んだ。`None` の間は、問題があるときだけ開く。
    open: Option<bool>,
    _subscription: Subscription,
}

impl PrepPanel {
    pub fn new<V: 'static>(config_dir: &Path, window: &mut Window, cx: &mut Context<V>) -> Self {
        let context = crate::prep_file::load(config_dir);
        let receiver = cx.new(|cx| InputState::new(window, cx));
        let initial = context.receiver.clone();
        receiver.update(cx, |state, cx| state.set_value(initial, window, cx));
        let receiver_edited = Rc::new(Cell::new(false));
        let _subscription = cx.subscribe(&receiver, {
            let edited = receiver_edited.clone();
            move |_, _, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    edited.set(true);
                    cx.notify();
                }
            }
        });
        Self {
            config_dir: config_dir.to_path_buf(),
            context,
            receiver,
            receiver_edited,
            observation: None,
            records: Records::default(),
            asking: false,
            // 出したらすぐ読む。
            polled: Instant::now()
                .checked_sub(POLL)
                .unwrap_or_else(Instant::now),
            confirming: None,
            sequence: 0,
            hidden: false,
            clear_receiver: false,
            open: None,
            _subscription,
        }
    }

    fn availability(&self) -> Availability {
        self.observation
            .as_ref()
            .map_or(Availability::Unknown, |o| o.availability)
    }

    fn keys(&self) -> Option<Keys> {
        let observation = self.observation.as_ref()?;
        let (sound, output) = observation.keys.as_ref()?;
        Some(Keys::new(sound, output, &self.context))
    }

    /// 窓を隠した・出した。隠したらすべての確認を失効にする（Tauri 版と同じ）。
    pub fn set_hidden(&mut self, hidden: bool) {
        if hidden && !self.hidden {
            self.external();
        }
        self.hidden = hidden;
    }

    /// 鍵に出ない変更（ピーク保護・true-peak 制限、設定の外での変更）。確認をやり直す。
    pub fn external(&mut self) {
        self.records.expire_all();
        self.confirming = None;
    }

    /// ホームを見ている間に呼ぶ。読み直す時期なら命令を返す。
    pub fn tick(&mut self, window: &mut Window, cx: &mut App) -> Option<Command> {
        if std::mem::take(&mut self.clear_receiver) {
            self.receiver
                .update(cx, |state, cx| state.set_value("", window, cx));
            self.receiver_edited.set(false);
        }
        if self.receiver_edited.take() {
            let receiver = normalize_receiver(&self.receiver.read(cx).value());
            if receiver != self.context.receiver {
                self.change(PrepContext {
                    receiver,
                    ..self.context.clone()
                });
            }
        }
        // 返事が来ないまま（エンジンが落ちたときなど）でも、しばらくしたら読み直す。
        let waited = self.polled.elapsed();
        (waited >= POLL && (!self.asking || waited >= POLL * 5)).then(|| self.read(None))
    }

    fn read(&mut self, confirm: Option<u64>) -> Command {
        self.asking = true;
        self.polled = Instant::now();
        Command::ReadPreparation(confirm)
    }

    /// 音声が始まった・止まった・落ちた。前の確認はすべて今のものではない。
    pub fn audio_changed(&mut self) {
        self.external();
        self.polled = Instant::now()
            .checked_sub(POLL)
            .unwrap_or_else(Instant::now);
    }

    pub fn apply(&mut self, observation: Option<Observation>, confirm: Option<u64>) {
        self.asking = false;
        self.observation = observation;
        let keys = self.keys();
        self.records.expire_changed(keys.as_ref());
        let Some((_, stage, expected)) = self.confirming.take_if(|(s, _, _)| Some(*s) == confirm)
        else {
            return;
        };
        let (input, output) = self
            .observation
            .as_ref()
            .map_or(("", ""), |o| (o.input.as_str(), o.output.as_str()));
        let target = preparation::target(stage, &self.context, input, output);
        self.records.confirm(
            stage,
            &expected,
            keys.as_ref(),
            self.availability(),
            &self.context,
            target,
        );
    }

    fn change(&mut self, next: PrepContext) {
        for stage in self.context.expires(&next) {
            self.records.expire(*stage);
        }
        self.context = next;
        if let Err(error) = crate::prep_file::save(&self.config_dir, &self.context) {
            log::warn!("接続の確認の設定を保存できません: {error}");
        }
    }

    /// 画面の操作。読み直しが要れば命令を返す。
    pub fn act(&mut self, action: Action) -> Option<Command> {
        match action {
            Action::Location(location) => self.change(PrepContext {
                location,
                ..self.context.clone()
            }),
            Action::Signal(signal) => self.change(PrepContext {
                signal,
                ..self.context.clone()
            }),
            Action::Usage(usage) => {
                let next = self.context.with_usage(usage);
                self.clear_receiver = next.receiver != self.context.receiver;
                self.change(next);
            }
            Action::Confirm(stage) => {
                let expected = self.keys()?.get(stage).to_string();
                self.sequence += 1;
                self.confirming = Some((self.sequence, stage, expected));
                return Some(self.read(Some(self.sequence)));
            }
            Action::Unconfirm(stage) => {
                self.records.expire(stage);
                return None;
            }
            Action::Reset => {
                self.external();
                return None;
            }
            Action::Toggle => {
                self.open = Some(!self.is_open());
                return None;
            }
            Action::Refresh => {}
        }
        Some(self.read(None))
    }

    fn problem(&self) -> bool {
        !self.availability().usable() || self.context.usage.is_none()
    }

    fn is_open(&self) -> bool {
        self.open.unwrap_or_else(|| self.problem())
    }

    /// `on` は操作、`goto` はほかの画面を開く。
    pub fn render(&self, lang: Lang, on: OnAction, goto: OnGoto) -> impl IntoElement {
        let availability = self.availability();
        let next = preparation::next(availability, &self.records, &self.context);
        let status = match next {
            Next::Done => core(lang, keys::PREP_SESSION_CHECKED),
            _ if self.asking && self.observation.is_none() => core(lang, keys::PREP_CHECKING),
            _ => core(lang, availability_label(availability)),
        };
        let act = |action: Action| {
            let on = on.clone();
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| on(action, window, cx)
        };
        let open_page = |page: Goto| {
            let goto = goto.clone();
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| goto(page, window, cx)
        };
        let open = self.is_open();
        crate::part::card(
            core(lang, keys::PREP_TITLE),
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(div().text_sm().child(status))
                .child(
                    Button::new("prep-toggle")
                        .label(core(lang, keys::PREP_STEPS))
                        .icon(if open {
                            IconName::ChevronUp
                        } else {
                            IconName::ChevronDown
                        })
                        .outline()
                        .small()
                        .on_click(act(Action::Toggle)),
                ),
            div().when(open, |this| {
                this.child(self.render_body(lang, availability, next, &on, act, open_page))
            }),
        )
        .icon(IconName::ListChecks)
        .hint(lang, core(lang, keys::PREP_ACK_PURPOSE))
    }

    fn render_body<A, G>(
        &self,
        lang: Lang,
        availability: Availability,
        next: Next,
        on: &OnAction,
        act: impl Fn(Action) -> A,
        open_page: impl Fn(Goto) -> G,
    ) -> impl IntoElement
    where
        A: Fn(&ClickEvent, &mut Window, &mut App) + 'static,
        G: Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    {
        let usage = self.context.usage;
        let fix = match availability {
            Availability::Unknown => Some((keys::PREP_REFRESH, None)),
            Availability::Unconfigured | Availability::Failed | Availability::Stopped => {
                Some((keys::SHELL_CONFIGURE, Some(Goto::Connect)))
            }
            _ => None,
        };
        let stage = match next {
            Next::Stage(stage) => Some(stage),
            _ => None,
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .when(self.context.location == Location::Venue, |this| {
                this.child(note(core(lang, keys::PREP_VENUE_WARNING)))
            })
            .when(self.context.signal == Signal::Mixed, |this| {
                this.child(note(core(lang, keys::PREP_MIXED_WARNING)))
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(
                        Button::new("prep-devices")
                            .label(core(lang, keys::HOME_CHANGE_DEVICES))
                            .outline()
                            .on_click(open_page(Goto::Connect)),
                    )
                    .when_some(fix, |this, (label, page)| {
                        let button = Button::new("prep-fix").label(core(lang, label)).primary();
                        this.child(match page {
                            Some(page) => button.on_click(open_page(page)),
                            None => button.on_click(act(Action::Refresh)),
                        })
                    }),
            )
            .child(div().text_sm().child(core(lang, keys::SETUP_GOAL)))
            .child(div().child(choices(
                "prep-usage",
                lang,
                &[
                    (Usage::Obs, keys::PREP_OBS),
                    (Usage::Discord, keys::PREP_CALL),
                    (Usage::Other, keys::PREP_OTHER),
                    (Usage::Listening, keys::PREP_LOCAL),
                ],
                usage,
                pick(on, Action::Usage),
            )))
            .when_some(stage, |this, stage| {
                let (label, page, ack) = match stage {
                    Stage::Sound => (keys::SHELL_SOUND, Goto::Sound, keys::PREP_ACK_SOUND),
                    Stage::Listen => (keys::HOME_VOICE_CHECK, Goto::Sound, keys::PREP_ACK_LISTEN),
                    Stage::Receiver if usage == Some(Usage::Listening) => {
                        (keys::PREP_LOCAL_RECEIVER, Goto::Sound, keys::PREP_ACK_LOCAL)
                    }
                    Stage::Receiver => (
                        keys::PREP_CHECK_RECEIVER,
                        Goto::Obs,
                        keys::PREP_ACK_RECEIVER,
                    ),
                };
                this.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(
                            div().child(
                                Button::new("prep-step")
                                    .label(core(lang, label))
                                    .outline()
                                    .on_click(open_page(page)),
                            ),
                        )
                        .child({
                            let on = on.clone();
                            Checkbox::new(SharedString::from(format!("prep-ack-{stage:?}")))
                                .checked(false)
                                .disabled(
                                    self.confirming.is_some()
                                        || availability != Availability::Ready,
                                )
                                .label(core(lang, ack))
                                .on_click(move |checked, window, cx| {
                                    if *checked {
                                        on(Action::Confirm(stage), window, cx);
                                    }
                                })
                        }),
                )
            })
            .child(div().text_sm().child(core(lang, keys::PREP_LOCATION)))
            .child(div().child(choices(
                "prep-location",
                lang,
                &[
                    (Location::Home, keys::PREP_HOME),
                    (Location::Venue, keys::PREP_VENUE),
                ],
                Some(self.context.location),
                pick(on, Action::Location),
            )))
            .child(div().text_sm().child(core(lang, keys::PREP_SIGNAL)))
            .child(div().child(choices(
                "prep-signal",
                lang,
                &[
                    (Signal::Unknown, keys::PREP_SIGNAL_UNKNOWN),
                    (Signal::Separate, keys::PREP_SEPARATE),
                    (Signal::Mixed, keys::PREP_MIXED),
                ],
                Some(self.context.signal),
                pick(on, Action::Signal),
            )))
            .when(
                usage.is_some_and(|usage| usage != Usage::Listening),
                |this| {
                    let label = if usage == Some(Usage::Obs) {
                        keys::PREP_OBS_TARGET
                    } else {
                        keys::PREP_TARGET
                    };
                    this.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().text_sm().child(core(lang, label)))
                            .child(Input::new(&self.receiver).aria_label(core(lang, label))),
                    )
                },
            )
            // 記録する前にすること（送り先・試聴先での確かめ方）なので、手順の前に文のまま出す。
            .child(note(core(
                lang,
                match usage {
                    Some(Usage::Discord) => keys::PREP_CALL_SCOPE,
                    Some(Usage::Listening) => keys::PREP_LOCAL_SCOPE,
                    _ => keys::PREP_MANUAL_SCOPE,
                },
            )))
            .children(
                Stage::ALL
                    .map(|stage| self.render_stage(lang, stage, act(Action::Unconfirm(stage)))),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_1()
                    .child(
                        Button::new("prep-reset")
                            .label(core(lang, keys::PREP_EXTERNAL_CHANGED))
                            .icon(IconName::RotateCw)
                            .outline()
                            .small()
                            .on_click(act(Action::Reset)),
                    )
                    .child(crate::part::hint(
                        "prep-scope",
                        lang,
                        core(lang, keys::PREP_EXTERNAL_SCOPE),
                    )),
            )
    }

    fn render_stage(
        &self,
        lang: Lang,
        stage: Stage,
        unconfirm: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let label = match stage {
            Stage::Sound => keys::SHELL_SOUND,
            Stage::Listen => keys::SHELL_LISTEN,
            Stage::Receiver if self.context.usage == Some(Usage::Listening) => {
                keys::PREP_LOCAL_RECEIVER
            }
            Stage::Receiver => keys::PREP_RECEIVER,
        };
        let state = self.records.state(stage);
        let shown = match (stage, state) {
            (_, State::Stale) => keys::PREP_STALE,
            (Stage::Sound, State::Confirmed) => keys::PREP_USER_CONFIRMED,
            (Stage::Sound, State::Unconfirmed) => keys::PREP_UNCONFIRMED,
            (_, State::Confirmed) => keys::PREP_LISTEN_CONFIRMED,
            (_, State::Unconfirmed) => keys::PREP_LISTEN_UNCONFIRMED,
        };
        let target = self.records.get(stage).map(|c| {
            if c.target.is_empty() {
                core(lang, keys::PREP_LOCAL).to_string()
            } else {
                c.target.clone()
            }
        });
        div()
            .flex()
            .flex_col()
            .gap_1()
            .pt_2()
            .border_t_1()
            .border_color(crate::color::border())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .justify_between()
                    .gap_2()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(core(lang, label)),
                    )
                    .child(note(core(lang, shown))),
            )
            .when_some(target, |this, target| this.child(note(target)))
            .when(state == State::Confirmed, |this| {
                this.child(
                    div().child(
                        Button::new(SharedString::from(format!("prep-unconfirm-{stage:?}")))
                            .label(core(lang, keys::PREP_UNCONFIRM))
                            .ghost()
                            .on_click(unconfirm),
                    ),
                )
            })
    }
}

/// 選び直したときの操作。
fn pick<T: 'static>(
    on: &OnAction,
    make: fn(T) -> Action,
) -> impl Fn(T, &mut Window, &mut App) + 'static {
    let on = on.clone();
    move |value, window, cx| on(make(value), window, cx)
}

fn availability_label(availability: Availability) -> &'static str {
    match availability {
        Availability::Ready => keys::PREP_RUNNING,
        Availability::Unknown => keys::SHELL_UNKNOWN,
        Availability::Unconfigured => keys::SHELL_UNCONFIGURED,
        Availability::Stopped => keys::SHELL_STOPPED,
        Availability::Failed => keys::PREP_FAILED,
        Availability::Pending => keys::PREP_PENDING,
        Availability::Muted => keys::PREP_MUTED,
    }
}
