//! ホームの「はじめての設定」：まだ一度も開始していないときだけ出す。使い道を選ぶと、マイクと出力先を勧めて、そのまま開始できる。
//! 勧め方は `auralyn-ui-model` の `setup`（Tauri 版のセットアップと同じ）。ここでは WASAPI だけを扱い、ASIO などは接続の画面へ案内する。

use std::rc::Rc;

use auralyn_ui_model::connect::{self, Device};
use auralyn_ui_model::setup::{self, Goal};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::component::{Disableable as _, IndexPath, Selectable as _, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::i18n::{core, keys, Lang};
use crate::part::{card, note};

type Names = SelectState<Vec<SharedString>>;

pub struct SetupPanel {
    goal: Goal,
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
            goal: Goal::Obs,
            microphones: Vec::new(),
            outputs: Vec::new(),
            microphone: select(cx),
            output: select(cx),
        }
    }

    /// 機器の一覧が届いた（ホームや接続の画面を開くたび）。選んでいた機器が残っていれば保ち、無ければ勧めるものを選ぶ。
    pub fn set_devices(&mut self, devices: &[Device], window: &mut Window, cx: &mut App) {
        let microphones = setup::microphones(devices);
        let outputs = setup::outputs(devices);
        let mic = setup::recommend_microphone(&microphones);
        let out = setup::recommend_output(self.goal, &outputs);
        fill(&self.microphone, &microphones, mic, window, cx);
        fill(&self.output, &outputs, out, window, cx);
        self.microphones = microphones.into_iter().cloned().collect();
        self.outputs = outputs.into_iter().cloned().collect();
    }

    /// 使い道を選んだ。出力先は勧め直す（勧められなければ選択を外す）。
    pub fn goal(&self) -> Goal {
        self.goal
    }

    pub fn set_goal(&mut self, goal: Goal, window: &mut Window, cx: &mut App) {
        self.goal = goal;
        let outputs: Vec<&Device> = self.outputs.iter().collect();
        let row = setup::recommend_output(goal, &outputs);
        self.output.update(cx, |state, cx| {
            state.set_selected_index(row.map(IndexPath::new), window, cx)
        });
    }

    /// 選んでいるマイクと出力先。
    pub fn chosen(&self, cx: &App) -> Option<(Device, Device)> {
        let pick = |state: &Entity<Names>, devices: &[Device]| {
            let label = state.read(cx).selected_value()?.clone();
            let choices: Vec<&Device> = devices.iter().collect();
            let row = connect::labels(&choices)
                .iter()
                .position(|l| l.as_str() == label.as_ref())?;
            devices.get(row).cloned()
        };
        Some((
            pick(&self.microphone, &self.microphones)?,
            pick(&self.output, &self.outputs)?,
        ))
    }

    /// `stopped` は開始できる状態か。`on_goal` は使い道を選んだとき、`on_start` は開始、`on_connect` は接続の画面を開く。
    pub fn render(
        &self,
        lang: Lang,
        stopped: bool,
        cx: &App,
        on_goal: impl Fn(Goal, &mut Window, &mut App) + 'static,
        on_start: impl Fn(&mut Window, &mut App) + 'static,
        on_connect: impl Fn(&mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let goal = self.goal;
        let on_goal = Rc::new(on_goal);
        let ready = stopped && self.chosen(cx).is_some();
        card(
            core(lang, keys::SETUP_TITLE),
            div(),
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(field(
                    lang,
                    keys::SETUP_GOAL,
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .children(Goal::ALL.map(|choice| {
                            let on_goal = on_goal.clone();
                            Button::new(SharedString::from(format!("setup-goal-{choice:?}")))
                                .label(core(lang, goal_label(choice)))
                                .outline()
                                .small()
                                .selected(goal == choice)
                                .on_click(move |_, window, cx| on_goal(choice, window, cx))
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
                                .outline()
                                .on_click(move |_, window, cx| on_connect(window, cx)),
                        ),
                ),
        )
        .icon(IconName::Sparkles)
        .hint(lang, core(lang, keys::SETUP_LEAD))
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

/// 一覧を入れ直す。選んでいた機器が残っていれば保ち、無ければ `recommended` を選ぶ。
fn fill(
    state: &Entity<Names>,
    devices: &[&Device],
    recommended: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) {
    let labels = connect::labels(devices);
    let kept = state.read(cx).selected_value().map(|v| v.to_string());
    let row = setup::keep_or(kept.as_deref(), &labels, recommended);
    let names = labels.into_iter().map(SharedString::from).collect();
    state.update(cx, |state, cx| {
        state.set_items(names, window, cx);
        state.set_selected_index(row.map(IndexPath::new), window, cx);
    });
}
