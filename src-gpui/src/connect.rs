//! 接続の画面：接続方式・マイク・出力先を選び、その機器で開始する。
//! 周波数とバッファは、選んだ機器が受け付ける値と「自動」から選ぶ。
//! 最初に選んでおく項目は `auralyn-ui-model` の `connect` で決める。チャンネルの割り当ては、まだこの画面に無い。

use auralyn_ui_model::connect::{self, Device, Saved};
use auralyn_ui_model::session::Phase;
use gpui_kit::component::button::Button;
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::component::{Disableable as _, IndexPath};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;

const WASAPI: &str = "WASAPI";
use crate::i18n::{core, keys, Lang};

type Choices = SelectState<Vec<SharedString>>;

pub struct ConnectPage {
    devices: Vec<Device>,
    saved: Option<Saved>,
    lang: Lang,
    /// 接続方式。選び直したら `fill` で機器を選び直す（`MainView` が購読する）。
    pub host: Entity<Choices>,
    /// マイクと出力先。選び直したら `fill_values` で周波数とバッファの候補を作り直す（`MainView` が購読する）。
    pub input: Entity<Choices>,
    pub output: Entity<Choices>,
    rate: Entity<Choices>,
    buffer: Entity<Choices>,
    /// 周波数とバッファの選択肢の値。選択肢の先頭は「自動」で、ここには入れない。
    rates: Vec<u32>,
    buffers: Vec<u32>,
}

impl ConnectPage {
    pub fn new<V: 'static>(lang: Lang, window: &mut Window, cx: &mut Context<V>) -> Self {
        let mut choices =
            |cx: &mut Context<V>| cx.new(|cx| SelectState::new(Vec::new(), None, window, cx));
        Self {
            devices: Vec::new(),
            saved: None,
            lang,
            host: choices(cx),
            input: choices(cx),
            output: choices(cx),
            rate: choices(cx),
            buffer: choices(cx),
            rates: Vec::new(),
            buffers: Vec::new(),
        }
    }

    pub fn set_devices(
        &mut self,
        devices: Vec<Device>,
        saved: Option<Saved>,
        lang: Lang,
        window: &mut Window,
        cx: &mut App,
    ) {
        let hosts = connect::hosts(&devices);
        let selected = connect::initial_host(&hosts, saved.as_ref());
        self.devices = devices;
        self.saved = saved;
        self.lang = lang;
        let names = hosts.into_iter().map(SharedString::from).collect();
        set(&self.host, names, selected, window, cx);
        self.fill(window, cx);
    }

    /// 選んでいる接続方式の機器を、マイクと出力先の選択肢に入れる。周波数とバッファは保存した値から選び直す。
    pub fn fill(&mut self, window: &mut Window, cx: &mut App) {
        let host = self.host_name(cx);
        for (state, is_input) in [(&self.input, true), (&self.output, false)] {
            let choices = connect::of_host(&self.devices, &host, is_input);
            let selected = connect::initial_device(&choices, self.saved.as_ref(), is_input);
            let names = connect::labels(&choices)
                .into_iter()
                .map(SharedString::from)
                .collect();
            set(state, names, selected, window, cx);
        }
        let saved = self.saved.as_ref();
        let rate = connect::saved_value(saved, &host, |s| s.sample_rate);
        let buffer = connect::saved_value(saved, &host, |s| s.buffer_size);
        self.fill_values(rate, buffer, window, cx);
    }

    /// 選んでいる機器が受け付ける周波数とバッファを選択肢に入れる。`rate`・`buffer` が候補にあれば選び、無ければ「自動」。
    fn fill_values(
        &mut self,
        rate: Option<u32>,
        buffer: Option<u32>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (rates, buffers) = match self.chosen(cx) {
            Some((input, output)) => {
                let asio = connect::shares_device(&input.host);
                (
                    connect::rates(&input, &output, asio, rate),
                    connect::buffers(&input, buffer),
                )
            }
            None => (Vec::new(), Vec::new()),
        };
        let lang = self.lang;
        let samples = core(lang, keys::SAMPLES).trim();
        set_values(&self.rate, &rates, rate, lang, khz, window, cx);
        set_values(
            &self.buffer,
            &buffers,
            buffer,
            lang,
            |size| format!("{size} {samples}"),
            window,
            cx,
        );
        self.rates = rates;
        self.buffers = buffers;
    }

    /// マイクか出力先を選び直したとき。選んでいた周波数とバッファは、新しい機器でも候補にあれば残す。
    pub fn devices_changed(&mut self, window: &mut Window, cx: &mut App) {
        let (rate, buffer) = self.values(cx);
        self.fill_values(rate, buffer, window, cx);
    }

    /// 選んでいる周波数とバッファ。`None` は「自動」。
    pub fn values(&self, cx: &App) -> (Option<u32>, Option<u32>) {
        let value = |state: &Entity<Choices>, values: &[u32]| {
            let row = state.read(cx).selected_index(cx)?.row;
            values.get(row.checked_sub(1)?).copied()
        };
        (
            value(&self.rate, &self.rates),
            value(&self.buffer, &self.buffers),
        )
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
            let label = state.read(cx).selected_value()?.clone();
            let choices = connect::of_host(&self.devices, &host, is_input);
            let row = connect::labels(&choices)
                .iter()
                .position(|l| l.as_str() == label.as_ref())?;
            choices.get(row).copied()
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
        let host = self.host_name(cx);
        let shared = connect::shares_device(&host);
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
            .child(field(
                core(lang, keys::SAMPLE_RATE),
                Select::new(&self.rate),
            ))
            .when(host == WASAPI, |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(color::muted())
                        .child(core(lang, keys::WASAPI_RATE)),
                )
            })
            .child(field(
                core(lang, keys::BUFFER_SIZE),
                Select::new(&self.buffer),
            ))
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

/// 先頭に「自動」を置き、`value` が候補にあればそれを、無ければ「自動」を選ぶ。
fn set_values(
    state: &Entity<Choices>,
    values: &[u32],
    value: Option<u32>,
    lang: Lang,
    label: impl Fn(u32) -> String,
    window: &mut Window,
    cx: &mut App,
) {
    let names = std::iter::once(SharedString::from(core(lang, keys::AUTO)))
        .chain(values.iter().map(|&v| SharedString::from(label(v))))
        .collect();
    let row = value
        .and_then(|value| values.iter().position(|&v| v == value))
        .map_or(0, |row| row + 1);
    set(state, names, Some(row), window, cx);
}

/// 48000 → "48 kHz"、44100 → "44.1 kHz"。
fn khz(rate: u32) -> String {
    let text = format!("{:.3}", f64::from(rate) / 1000.0);
    format!("{} kHz", text.trim_end_matches('0').trim_end_matches('.'))
}

fn field(label: &'static str, select: Select<Vec<SharedString>>) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_1p5()
        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(label))
        .child(select.accessibility_label(label))
}
