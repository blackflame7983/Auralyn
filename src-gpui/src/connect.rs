//! 接続の画面：接続方式・マイク・出力先を選び、その機器で開始する。
//! 最初に選んでおく項目は `auralyn-ui-model` の `connect` で決める。周波数・バッファ・チャンネルの割り当ては、まだこの画面に無い。

use auralyn_ui_model::connect::{self, Device, Saved};
use auralyn_ui_model::session::Phase;
use gpui_kit::component::button::Button;
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::component::{Disableable as _, IndexPath};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::i18n::{core, keys, Lang};

type Choices = SelectState<Vec<SharedString>>;

pub struct ConnectPage {
    devices: Vec<Device>,
    saved: Option<Saved>,
    /// 一覧を頼んだ（画面を初めて開いたときに1回）。
    pub requested: bool,
    /// 接続方式。選び直したら `fill` で機器を選び直す（`MainView` が購読する）。
    pub host: Entity<Choices>,
    input: Entity<Choices>,
    output: Entity<Choices>,
}

impl ConnectPage {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        let mut choices =
            |cx: &mut Context<V>| cx.new(|cx| SelectState::new(Vec::new(), None, window, cx));
        Self {
            devices: Vec::new(),
            saved: None,
            requested: false,
            host: choices(cx),
            input: choices(cx),
            output: choices(cx),
        }
    }

    pub fn set_devices(
        &mut self,
        devices: Vec<Device>,
        saved: Option<Saved>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let hosts = connect::hosts(&devices);
        let selected = connect::initial_host(&hosts, saved.as_ref());
        self.devices = devices;
        self.saved = saved;
        let names = hosts.into_iter().map(SharedString::from).collect();
        set(&self.host, names, selected, window, cx);
        self.fill(window, cx);
    }

    /// 選んでいる接続方式の機器を、マイクと出力先の選択肢に入れる。
    pub fn fill(&self, window: &mut Window, cx: &mut App) {
        let host = self.host_name(cx);
        for (state, is_input) in [(&self.input, true), (&self.output, false)] {
            let choices = connect::of_host(&self.devices, &host, is_input);
            let selected = connect::initial_device(&choices, self.saved.as_ref(), is_input);
            let names = choices
                .iter()
                .map(|d| SharedString::from(d.name.clone()))
                .collect();
            set(state, names, selected, window, cx);
        }
    }

    fn host_name(&self, cx: &App) -> String {
        self.host
            .read(cx)
            .selected_value()
            .map(|v| v.to_string())
            .unwrap_or_default()
    }

    /// 選んでいるマイクと出力先。ASIO では、出力はマイクと同じドライバー。
    pub fn chosen(&self, cx: &App) -> Option<(Device, Device)> {
        let host = self.host_name(cx);
        let pick = |state: &Entity<Choices>, is_input: bool| {
            let name = state.read(cx).selected_value()?.clone();
            connect::of_host(&self.devices, &host, is_input)
                .into_iter()
                .find(|d| d.name == name.as_ref())
        };
        let input = pick(&self.input, true)?;
        let output = if connect::shares_device(&host) {
            connect::shared_output(&connect::of_host(&self.devices, &host, false), input)?
        } else {
            pick(&self.output, false)?
        };
        Some((input.clone(), output.clone()))
    }

    /// 開始のボタンは止まっているときだけ押せる（動いている機器を替える手順は、まだ無い）。
    pub fn render(
        &self,
        phase: Phase,
        lang: Lang,
        cx: &App,
        on_start: impl Fn(&mut Window, &mut App) + 'static,
    ) -> impl IntoElement {
        let shared = connect::shares_device(&self.host_name(cx));
        let stopped = matches!(phase, Phase::Stopped | Phase::Unconfigured);
        let empty = core(lang, keys::NO_DEVICES);
        div()
            .flex()
            .flex_col()
            .gap_4()
            .max_w(px(480.))
            .child(field(
                core(lang, keys::CONNECTION_METHOD),
                Select::new(&self.host).placeholder(empty),
            ))
            .child(field(
                core(
                    lang,
                    if shared {
                        keys::DEVICE
                    } else {
                        keys::MICROPHONE
                    },
                ),
                Select::new(&self.input).placeholder(empty),
            ))
            .map(|this| {
                if shared {
                    this.child(
                        div()
                            .text_sm()
                            .text_color(color::muted())
                            .child(core(lang, keys::ASIO_SHARED)),
                    )
                } else {
                    this.child(field(
                        core(lang, keys::OUTPUT),
                        Select::new(&self.output).placeholder(empty),
                    ))
                }
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1p5()
                    .child(
                        Button::new("connect-start")
                            .label(core(lang, keys::START))
                            .outline()
                            .disabled(!stopped || self.chosen(cx).is_none())
                            .on_click(move |_, window, cx| on_start(window, cx)),
                    )
                    .child(div().text_sm().text_color(color::muted()).child(core(
                        lang,
                        if stopped {
                            keys::FIRST_START_HINT
                        } else {
                            keys::STOP_TO_CHANGE
                        },
                    ))),
            )
    }
}

fn set(
    state: &Entity<Choices>,
    names: Vec<SharedString>,
    selected: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) {
    state.update(cx, |state, cx| {
        state.set_items(names, window, cx);
        state.set_selected_index(selected.map(IndexPath::new), window, cx);
    });
}

fn field(label: &'static str, select: Select<Vec<SharedString>>) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(label))
        .child(select.accessibility_label(label))
}
