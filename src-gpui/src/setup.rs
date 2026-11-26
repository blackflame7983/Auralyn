//! ホームの「はじめての設定」：まだ一度も開始していないときだけ出す。使い道を選ぶと、マイクと出力先を勧めて、そのまま開始できる。
//! 勧め方は `auralyn-ui-model` の `setup`（Tauri 版のセットアップと同じ）。ここでは WASAPI だけを扱い、ASIO などは接続の画面へ案内する。

use std::cell::Cell;
use std::rc::Rc;

use auralyn_ui_model::connect::{self, Device};
use auralyn_ui_model::setup::{self, Goal};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::component::{Disableable as _, IndexPath, Selectable as _, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{core, keys, Lang};
use crate::part::{card, note};

type Names = SelectState<Vec<SharedString>>;

pub struct SetupPanel {
    goal: Rc<Cell<Goal>>,
    microphones: Vec<Device>,
    outputs: Vec<Device>,
    /// 選び直したら開始のボタンを描き直す（`MainView` が購読する）。
    pub microphone: Entity<Names>,
    pub output: Entity<Names>,
}

impl SetupPanel {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        let mut select =
            |cx: &mut Context<V>| cx.new(|cx| SelectState::new(Vec::new(), None, window, cx));
        Self {
            goal: Rc::new(Cell::new(Goal::Obs)),
            microphones: Vec::new(),
            outputs: Vec::new(),
            microphone: select(cx),
            output: select(cx),
        }
    }

    /// 機器の一覧が届いた。候補を入れ直し、勧めるものを選ぶ。
    pub fn set_devices(&mut self, devices: &[Device], window: &mut Window, cx: &mut App) {
        let microphones = setup::microphones(devices);
        let outputs = setup::outputs(devices);
        let names = |choices: &[&Device]| -> Vec<SharedString> {
            connect::labels(choices)
                .into_iter()
                .map(Into::into)
                .collect()
        };
        let (mic_names, out_names) = (names(&microphones), names(&outputs));
        let mic = setup::recommend_microphone(&microphones);
        self.microphones = microphones.into_iter().cloned().collect();
        self.outputs = outputs.into_iter().cloned().collect();
        self.microphone.update(cx, |state, cx| {
            state.set_items(mic_names, window, cx);
            state.set_selected_index(mic.map(IndexPath::new), window, cx);
        });
        self.output
            .update(cx, |state, cx| state.set_items(out_names, window, cx));
        self.recommend_output(window, cx);
    }

    /// 使い道に合わせて、勧める出力先を選び直す（勧められなければ選択を外す）。
    fn recommend_output(&self, window: &mut Window, cx: &mut App) {
        let outputs: Vec<&Device> = self.outputs.iter().collect();
        let row = setup::recommend_output(self.goal.get(), &outputs);
        self.output.update(cx, |state, cx| {
            state.set_selected_index(row.map(IndexPath::new), window, cx)
        });
    }

    /// 選んでいるマイクと出力先。
    pub fn chosen(&self, cx: &App) -> Option<(Device, Device)> {
        let mic = self.microphone.read(cx).selected_index(cx)?.row;
        let out = self.output.read(cx).selected_index(cx)?.row;
        Some((
            self.microphones.get(mic)?.clone(),
            self.outputs.get(out)?.clone(),
        ))
    }

    /// `on_goal` は使い道を選び直したとき（出力先を勧め直す）、`on_start` は開始、`on_connect` は接続の画面を開く。
    pub fn render(
        &self,
        lang: Lang,
        cx: &App,
        on_goal: impl Fn(Goal, &mut Window, &mut App) + 'static,
        on_start: impl Fn(&mut Window, &mut App) + 'static,
        on_connect: impl Fn(&mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let goal = self.goal.get();
        let on_goal = Rc::new(on_goal);
        let ready = self.chosen(cx).is_some();
        card(
            core(lang, keys::SETUP_TITLE),
            div(),
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(note(core(lang, keys::SETUP_LEAD)))
                .child(field(
                    lang,
                    keys::SETUP_GOAL,
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .children(Goal::ALL.map(|choice| {
                            let on_goal = on_goal.clone();
                            let state = self.goal.clone();
                            Button::new(SharedString::from(format!("setup-goal-{choice:?}")))
                                .label(core(lang, goal_label(choice)))
                                .outline()
                                .small()
                                .selected(goal == choice)
                                .on_click(move |_, window, cx| {
                                    state.set(choice);
                                    on_goal(choice, window, cx);
                                })
                        })),
                ))
                .child(field(
                    lang,
                    keys::SETUP_MICROPHONE,
                    Select::new(&self.microphone).placeholder(core(lang, keys::NO_DEVICES)),
                ))
                .child(field(
                    lang,
                    keys::SETUP_OUTPUT,
                    Select::new(&self.output).placeholder(core(lang, keys::NO_DEVICES)),
                ))
                .map(|this| {
                    if goal.sends_to_cable() {
                        this.child(note(format!(
                            "{}{}{}",
                            core(lang, keys::SETUP_CABLE_BEFORE),
                            core(lang, keys::SETUP_CABLE),
                            core(lang, keys::SETUP_CABLE_AFTER)
                        )))
                    } else {
                        this.child(note(core(lang, keys::SETUP_LISTEN_HINT)))
                    }
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(
                            Button::new("setup-start")
                                .label(core(lang, keys::SETUP_START))
                                .primary()
                                .disabled(!ready)
                                .on_click(move |_, window, cx| on_start(window, cx)),
                        )
                        .child(
                            Button::new("setup-connect")
                                .label(core(lang, keys::SETUP_OTHER))
                                .ghost()
                                .on_click(move |_, window, cx| on_connect(window, cx)),
                        ),
                ),
        )
    }

    /// 使い道を選び直した（`render` の `on_goal` から呼ぶ）。
    pub fn goal_changed(&self, window: &mut Window, cx: &mut App) {
        self.recommend_output(window, cx);
    }
}

fn goal_label(goal: Goal) -> &'static str {
    match goal {
        Goal::Obs => keys::SETUP_GOAL_OBS,
        Goal::Chat => keys::SETUP_GOAL_CHAT,
        Goal::Listen => keys::SETUP_GOAL_LISTEN,
    }
}

fn field(lang: Lang, label: &'static str, control: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_1()
        .child(div().text_sm().child(core(lang, label)))
        .child(control)
}
