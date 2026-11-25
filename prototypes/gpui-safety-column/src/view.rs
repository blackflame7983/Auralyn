//! 右の列（本番中の操作）。DESIGN.md 10.3・10.6 の並びと規則に合わせる。
//! 上から、緊急ミュート、入力（見出し・機器名・横メーター・マイク音量）、出力（一言・ミュートの札・機器名・ピーク・出力音量）、
//! VSTを外して比較。その下に、試作の合否判定のための欄（IME・VSTのエディタ・トレイとホットキーの状態）を置く。

use std::time::{Duration, Instant};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::desktop::{Action, Desktop};
use crate::engine::{Command, Engine, Notice};
use crate::i18n::{t, Key, Lang};
use auralyn_ui_model::meter::{self, Meter, State as MeterState, Verdict};

/// 描画の周期。全メーターで1つを共有する（10.6 の最後の項）。
const FRAME: Duration = Duration::from_millis(16);

mod color {
    use gpui_kit::{hsla, Hsla};

    fn hsl(h: f32, s: f32, l: f32) -> Hsla {
        hsla(h / 360.0, s / 100.0, l / 100.0, 1.0)
    }
    // 既定のダークテーマ「オーロラ（標準）」の値（src/index.css）。
    pub fn background() -> Hsla {
        hsl(222.0, 12.0, 7.0)
    }
    pub fn card() -> Hsla {
        hsl(222.0, 10.0, 10.0)
    }
    pub fn foreground() -> Hsla {
        hsl(220.0, 20.0, 94.0)
    }
    pub fn muted() -> Hsla {
        hsl(222.0, 8.0, 70.0)
    }
    pub fn border() -> Hsla {
        hsl(222.0, 8.0, 21.0)
    }
    pub fn track() -> Hsla {
        hsl(222.0, 10.0, 16.0)
    }
    pub fn destructive_text() -> Hsla {
        hsl(0.0, 94.0, 82.0)
    }
    pub fn destructive_soft() -> Hsla {
        hsla(0.0, 0.628, 0.306, 0.35)
    }
    pub fn warning() -> Hsla {
        hsl(43.0, 96.0, 65.0)
    }
    pub fn danger() -> Hsla {
        hsl(0.0, 90.0, 72.0)
    }
    pub fn success() -> Hsla {
        hsl(158.0, 64.0, 65.0)
    }
    pub fn aurora_green() -> Hsla {
        hsl(150.0, 70.0, 48.0)
    }
    pub fn aurora_teal() -> Hsla {
        hsl(176.0, 70.0, 48.0)
    }
    pub fn primary() -> Hsla {
        hsl(166.0, 58.0, 56.0)
    }
}

pub struct SafetyColumn {
    engine: Engine,
    desktop: Desktop,
    lang: Lang,
    running: bool,
    muted: bool,
    bypassed: bool,
    input_name: Option<String>,
    output_name: Option<String>,
    plugin: Option<String>,
    message: Option<String>,
    input: Meter,
    output: Meter,
    level_seq: u64,
    input_gain: Entity<SliderState>,
    output_gain: Entity<SliderState>,
    ime: Entity<InputState>,
    _ticker: Task<()>,
}

impl SafetyColumn {
    pub fn new(engine: Engine, lang: Lang, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input_gain = cx.new(|_| {
            SliderState::new()
                .min(0.0)
                .max(200.0)
                .step(1.0)
                .default_value(100.0)
        });
        let output_gain = cx.new(|_| {
            SliderState::new()
                .min(0.0)
                .max(200.0)
                .step(1.0)
                .default_value(100.0)
        });
        cx.subscribe(&input_gain, |this, _, event: &SliderEvent, _| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            this.engine
                .send(Command::SetInputGain(value.start() / 100.0));
        })
        .detach();
        cx.subscribe(&output_gain, |this, _, event: &SliderEvent, _| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            this.engine
                .send(Command::SetOutputGain(value.end() / 100.0));
        })
        .detach();
        let ime =
            cx.new(|cx| InputState::new(window, cx).placeholder(t(lang, Key::ImePlaceholder)));
        let ticker = cx.spawn_in(window, async move |this, cx| loop {
            cx.background_executor().timer(FRAME).await;
            if this
                .update_in(cx, |this, window, cx| this.tick(window, cx))
                .is_err()
            {
                break;
            }
        });
        let now = Instant::now();
        let desktop = Desktop::new(lang);
        if let Some(error) = &desktop.tray_error {
            log::warn!("トレイを作れません: {error}");
        }
        if let Some(error) = &desktop.hotkey_error {
            log::warn!("Alt+M を登録できません: {error}");
        }
        log::info!(
            "トレイ: {} / Alt+M: {}",
            if desktop.tray_error.is_none() {
                "登録"
            } else {
                "失敗"
            },
            if desktop.hotkey_error.is_none() {
                "登録"
            } else {
                "失敗"
            }
        );
        let message = desktop
            .hotkey_error
            .as_ref()
            .map(|e| format!("{}: {e}", t(lang, Key::HotkeyFailed)));
        Self {
            engine,
            desktop,
            lang,
            running: false,
            muted: false,
            bypassed: false,
            input_name: None,
            output_name: None,
            plugin: None,
            message,
            input: Meter::stopped(now),
            output: Meter::stopped(now),
            level_seq: 0,
            input_gain,
            output_gain,
            ime,
            _ticker: ticker,
        }
    }

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changed = false;
        for notice in self.engine.notices.try_iter().collect::<Vec<_>>() {
            self.apply(notice);
            changed = true;
        }
        for action in self.desktop.poll() {
            match action {
                Action::ToggleMute => self.toggle_mute(),
                Action::Show => window.activate_window(),
                Action::Quit => cx.quit(),
            }
            changed = true;
        }
        // 10.6 は「窓が隠れている間は止める」。GPUI 0.3.14 には窓が見えているかを知る API がないので、試作では止めない。
        {
            let slot = *self.engine.levels.lock().unwrap_or_else(|e| e.into_inner());
            if slot.seq != self.level_seq {
                self.level_seq = slot.seq;
                let at = slot.received_at.unwrap_or_else(Instant::now);
                self.input.receive(slot.input, at);
                self.output.receive(slot.output, at);
            }
            let now = Instant::now();
            changed |= self.input.tick(now);
            changed |= self.output.tick(now);
        }
        if changed {
            cx.notify();
        }
    }

    fn apply(&mut self, notice: Notice) {
        match notice {
            Notice::Started { input, output } => {
                self.running = true;
                self.input_name = input;
                self.output_name = output;
                self.input.start();
                self.output.start();
            }
            Notice::Stopped => self.stop(None),
            Notice::StreamError(message) => self.stop(Some(message)),
            Notice::NotStarted(message) => {
                self.message = Some(format!("{}: {message}", t(self.lang, Key::NotStarted)))
            }
            Notice::Muted(muted) => self.muted = muted,
            Notice::Bypassed(bypassed) => self.bypassed = bypassed,
            Notice::PluginLoaded(name) => self.plugin = Some(name),
            Notice::Failed { command, message } => {
                // 楽観的に変えた表示を、通知で確定した状態へ戻す。ミュートと比較は通知で決まる。
                self.message = Some(format!("{command}: {message}"));
            }
        }
    }

    fn stop(&mut self, message: Option<String>) {
        self.running = false;
        self.input.stop();
        self.output.stop();
        if message.is_some() {
            self.message = message;
        }
    }

    fn toggle_mute(&mut self) {
        self.engine.send(Command::SetMute(!self.muted));
    }

    fn set_lang(&mut self, lang: Lang, window: &mut Window, cx: &mut Context<Self>) {
        self.lang = lang;
        self.desktop.set_lang(lang);
        self.ime.update(cx, |state, cx| {
            state.set_placeholder(t(lang, Key::ImePlaceholder), window, cx)
        });
        cx.notify();
    }

    fn render_mute(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        let muted = self.muted;
        div()
            .id("emergency-mute")
            .role(Role::Button)
            .aria_label(t(lang, Key::Emergency))
            .aria_toggled(if muted { Toggled::True } else { Toggled::False })
            .when(muted, |this| this.aria_description(t(lang, Key::MuteOn)))
            .focusable()
            .tab_stop(true)
            .flex()
            .flex_col()
            .gap_0p5()
            .w_full()
            .px_3()
            .py_1p5()
            .rounded_full()
            .border_1()
            .border_color(color::destructive_text())
            .text_sm()
            .font_weight(FontWeight::MEDIUM)
            .text_color(color::foreground())
            .cursor_pointer()
            .map(|this| {
                if muted {
                    this.bg(color::destructive_soft()).shadow(vec![BoxShadow {
                        color: color::destructive_text(),
                        offset: point(px(0.), px(0.)),
                        blur_radius: px(0.),
                        spread_radius: px(2.),
                        inset: false,
                    }])
                } else {
                    this.bg(color::background())
                        .hover(|style| style.bg(color::destructive_soft()))
                }
            })
            .focus_visible(|style| style.border_2().border_color(color::primary()))
            .on_click(cx.listener(|this, _, _, _| this.toggle_mute()))
            .child(t(lang, Key::Emergency))
            .when(muted, |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(color::destructive_text())
                        .child(t(lang, Key::MutedShort)),
                )
            })
    }

    fn render_input(&self) -> impl IntoElement {
        let lang = self.lang;
        section()
            .child(heading(t(lang, Key::Mic)))
            .when_some(self.input_name.clone(), |this, name| {
                this.child(device(name))
            })
            .child(meter_bar("input-meter", &self.input, lang))
            .child(slider_row(
                "input-gain",
                t(lang, Key::MicVolume),
                &self.input_gain,
            ))
    }

    fn render_output(&self, cx: &App) -> impl IntoElement {
        let lang = self.lang;
        let stopped = self.output.state() == MeterState::Stopped;
        let verdict = (!self.muted).then(|| self.output.verdict()).flatten();
        let volume_zero = self.output_gain.read(cx).value().end() == 0.0;
        section()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x_2()
                    .min_h(px(22.))
                    .child(heading(t(lang, Key::Output)))
                    .map(|this| {
                        if self.muted || volume_zero {
                            this.child(
                                div()
                                    .ml_auto()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_full()
                                    .border_1()
                                    .border_color(color::warning().opacity(0.5))
                                    .bg(color::warning().opacity(0.1))
                                    .text_xs()
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(color::warning())
                                    .child(t(lang, Key::Muted)),
                            )
                        } else if let Some(verdict) = verdict {
                            let (text, dot) = match verdict {
                                Verdict::High => (t(lang, Key::LevelHigh), color::warning()),
                                Verdict::Low => (t(lang, Key::LevelLow), color::muted()),
                                Verdict::Ok => (t(lang, Key::LevelOk), color::success()),
                            };
                            this.child(
                                div()
                                    .ml_auto()
                                    .flex()
                                    .items_center()
                                    .gap_1()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(div().w(px(16.)).h(px(8.)).rounded_full().bg(dot))
                                    .child(text),
                            )
                        } else {
                            this
                        }
                    }),
            )
            .when_some(self.output_name.clone(), |this, name| {
                this.child(device(name))
            })
            .child(
                div()
                    .id("output-peak")
                    .role(Role::Label)
                    .aria_label(if stopped {
                        t(lang, Key::OutputPeakStopped).to_string()
                    } else {
                        format!(
                            "{} {} dBFS",
                            t(lang, Key::OutputPeak),
                            meter::format_peak(self.output.peak())
                        )
                    })
                    .flex()
                    .justify_end()
                    .items_baseline()
                    .gap_1p5()
                    .text_xs()
                    .text_color(color::muted())
                    .child(t(lang, Key::Peak))
                    .child(div().font_family("Consolas").child(if stopped {
                        "—".to_string()
                    } else {
                        format!("{} dBFS", meter::format_peak(self.output.peak()))
                    })),
            )
            .child(slider_row(
                "output-gain",
                t(lang, Key::OutputVolume),
                &self.output_gain,
            ))
    }

    fn render_compare(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        let bypassed = self.bypassed;
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                Button::new("compare")
                    .label(t(lang, Key::Compare))
                    .outline()
                    .toggled(bypassed)
                    .w_full()
                    .on_click(cx.listener(move |this, _, _, _| {
                        this.engine.send(Command::SetBypass(!bypassed));
                    })),
            )
            .when(bypassed, |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(color::muted())
                        .child(t(lang, Key::CompareOn)),
                )
            })
    }

    fn render_checks(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        let status = format!(
            "tray: {} / Alt+M: {}{}",
            self.desktop.tray_error.as_deref().unwrap_or("OK"),
            self.desktop.hotkey_error.as_deref().unwrap_or("OK"),
            self.plugin
                .as_deref()
                .map(|name| format!(" / VST: {name}"))
                .unwrap_or_default(),
        );
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(color::border())
            .child(
                div()
                    .text_xs()
                    .text_color(color::muted())
                    .child(t(lang, Key::Checks)),
            )
            .when_some(self.message.clone(), |this, message| {
                this.child(div().text_xs().text_color(color::warning()).child(message))
            })
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().text_xs().child(t(lang, Key::ImeField)))
                    .child(Input::new(&self.ime).aria_label(t(lang, Key::ImeField))),
            )
            .when(self.plugin.is_some(), |this| {
                this.child(
                    Button::new("open-editor")
                        .label(t(lang, Key::OpenEditor))
                        .ghost()
                        .on_click(
                            cx.listener(|this, _, _, _| this.engine.send(Command::OpenEditor)),
                        ),
                )
            })
            .child(
                Button::new("language")
                    .label(t(lang, Key::Language))
                    .ghost()
                    .on_click(cx.listener(|this, _, window, cx| {
                        let lang = this.lang.toggled();
                        this.set_lang(lang, window, cx);
                    })),
            )
            .child(div().text_xs().text_color(color::muted()).child(status))
    }
}

impl Render for SafetyColumn {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        div()
            .id("safety-column")
            .role(Role::Complementary)
            .aria_label(t(lang, Key::SafetyColumn))
            .size_full()
            .flex()
            .flex_col()
            .gap_3()
            .p_3()
            .bg(color::card())
            .text_color(color::foreground())
            .font_family("Yu Gothic UI")
            .child(self.render_mute(cx))
            .child(self.render_input())
            .child(self.render_output(cx))
            .child(self.render_compare(cx))
            // 本番中の操作は動かさず、試作の確認用の欄だけを、残りの高さの中でスクロールさせる。
            .child(
                div()
                    .id("prototype-checks")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(self.render_checks(cx)),
            )
    }
}

fn section() -> Div {
    div().flex().flex_col().gap_1p5()
}

fn heading(text: &'static str) -> impl IntoElement {
    div()
        .id(SharedString::new_static(text))
        .role(Role::Heading)
        .aria_level(3)
        .aria_label(text)
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .child(text)
}

fn device(name: String) -> impl IntoElement {
    div()
        .text_xs()
        .text_color(color::muted())
        .truncate()
        .child(name)
}

fn state_text(state: MeterState, lang: Lang) -> &'static str {
    match state {
        MeterState::Stopped => t(lang, Key::StateStopped),
        MeterState::Waiting | MeterState::Stale => t(lang, Key::StateWaiting),
        MeterState::Silent => t(lang, Key::StateSilent),
        MeterState::Live => t(lang, Key::StateActive),
    }
}

/// 横メーター。オーロラの正常域、−6 dBFS からの黄色、クリップの赤。状態は文字でも出す（色だけで伝えない）。
fn meter_bar(id: &'static str, reading: &Meter, lang: Lang) -> impl IntoElement {
    let level = meter::position(reading.smoothed());
    let peak = meter::position(reading.peak());
    let warn = meter::warning_position();
    let state = reading.state();
    let normal = level.min(warn);
    let hot = (level - warn).max(0.0);
    div()
        .id(id)
        .role(Role::Meter)
        .aria_label(t(lang, Key::InputLevel))
        .aria_value(state_text(state, lang))
        .aria_min_numeric_value(0.0)
        .aria_max_numeric_value(1.0)
        .aria_numeric_value(level as f64)
        .relative()
        .w_full()
        .h(px(16.))
        .rounded(px(4.))
        .overflow_hidden()
        .bg(color::track())
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .w(relative(normal))
                .bg(linear_gradient(
                    90.,
                    linear_color_stop(color::aurora_green(), 0.),
                    linear_color_stop(color::aurora_teal(), 1.),
                )),
        )
        .when(hot > 0.0, |this| {
            this.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(relative(warn))
                    .w(relative(hot))
                    .bg(if reading.peak() >= 1.0 {
                        color::danger()
                    } else {
                        color::warning()
                    }),
            )
        })
        .when(peak > 0.0, |this| {
            this.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(relative(peak))
                    .w(px(2.))
                    .bg(color::foreground().opacity(0.8)),
            )
        })
        .when(!matches!(state, MeterState::Live), |this| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_xs()
                    .text_color(color::muted())
                    .child(state_text(state, lang)),
            )
        })
}

fn slider_row(
    id: &'static str,
    label: &'static str,
    state: &Entity<SliderState>,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .child(
            div()
                .text_xs()
                .text_color(color::muted())
                .flex_none()
                .child(label),
        )
        .child(
            div()
                .flex_1()
                .child(Slider::new(state).horizontal().accessibility_label(label)),
        )
}
