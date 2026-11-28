//! 右の列：緊急ミュート・入力・出力・聴き比べのメーターと操作。

use super::*;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::Disableable as _;

impl MainView {
    fn render_mute(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        let muted = self.muted;
        div()
            .id("emergency-mute")
            .role(Role::Button)
            .aria_label(core(lang, keys::EMERGENCY))
            .aria_toggled(if muted { Toggled::True } else { Toggled::False })
            .when(muted, |this| {
                this.aria_description(core(lang, keys::MUTE_ON))
            })
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
            .child(core(lang, keys::EMERGENCY))
            .when(muted, |this| {
                this.child(
                    // 赤い地に赤い字は明るい外観で読みにくいので、字は本文の色にする（赤は枠と地で伝える）。
                    div()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(color::foreground())
                        .child(core(lang, keys::MUTED_SHORT)),
                )
            })
    }

    fn render_input(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        section()
            .child(heading(core(lang, keys::MIC)))
            .when_some(self.input_name.clone(), |this, name| {
                this.child(device(name))
            })
            .child(meter_bar("input-meter", &self.input, lang))
            .child(slider_row(
                "input-gain",
                core(lang, keys::MIC_VOLUME),
                &self.input_gain,
                Command::SetInputGain,
                lang,
                cx,
            ))
    }

    fn render_output(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        let stopped = self.output.state() == MeterState::Stopped;
        let volume_zero = self.output_gain.read(cx).value().end() == 0.0;
        let tag = meter::output_tag(self.muted, volume_zero, &self.output);
        let hint = core(
            lang,
            if self.muted {
                keys::UNMUTE
            } else {
                keys::RESET_TO_100
            },
        );
        section()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x_2()
                    .min_h(px(22.))
                    .child(heading(core(lang, keys::OUTPUT_HEADING)))
                    .map(|this| match tag {
                        Some(OutputTag::Muted) => this.child(
                            // 押すと音を戻す入口：ミュート中なら解除し、音量 0 なら 100% に戻す（両方なら両方）。
                            div()
                                .id("output-muted")
                                .role(Role::Button)
                                .aria_label(hint)
                                .focusable()
                                .tab_stop(true)
                                .cursor_pointer()
                                .tooltip(move |window, cx| Tooltip::new(hint).build(window, cx))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if this.muted {
                                        this.toggle_mute();
                                    }
                                    if volume_zero {
                                        this.output_gain.update(cx, |state, cx| {
                                            state.set_value(100.0, window, cx)
                                        });
                                        this.engine.send(Command::SetOutputGain(1.0));
                                    }
                                    cx.notify();
                                }))
                                .focus_visible(|style| style.border_color(color::primary()))
                                .hover(|style| style.bg(color::warning().opacity(0.2)))
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
                                .child(core(lang, keys::OUTPUT_MUTED)),
                        ),
                        Some(OutputTag::Verdict(verdict)) => {
                            let (text, dot) = match verdict {
                                Verdict::High => (core(lang, keys::LEVEL_HIGH), color::warning()),
                                Verdict::Low => (core(lang, keys::LEVEL_LOW), color::muted()),
                                Verdict::Ok => (core(lang, keys::LEVEL_OK), color::success()),
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
                        }
                        None => this,
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
                        core(lang, keys::OUTPUT_PEAK_STOPPED).to_string()
                    } else {
                        format!(
                            "{} {} dBFS",
                            core(lang, keys::OUTPUT_PEAK),
                            meter::format_peak(self.output.peak())
                        )
                    })
                    .flex()
                    .justify_end()
                    .items_baseline()
                    .gap_1p5()
                    .text_xs()
                    .text_color(color::muted())
                    .child(core(lang, keys::PEAK))
                    .child(div().font_family("Consolas").child(if stopped {
                        "—".to_string()
                    } else {
                        format!("{} dBFS", meter::format_peak(self.output.peak()))
                    })),
            )
            .child(slider_row(
                "output-gain",
                core(lang, keys::OUTPUT_VOLUME),
                &self.output_gain,
                Command::SetOutputGain,
                lang,
                cx,
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
                    .label(core(lang, keys::COMPARE))
                    .outline()
                    .toggled(bypassed)
                    .disabled(!bypassed && self.phase != Phase::Running)
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
                        .child(core(lang, keys::COMPARE_ON)),
                )
            })
    }

    pub(super) fn render_safety_column(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        div()
            .id("safety-column")
            .role(Role::Complementary)
            .aria_label(core(lang, keys::SAFETY_COLUMN))
            .w(px(SAFETY_COLUMN_WIDTH))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .gap_3()
            .p_3()
            .border_l_1()
            .border_color(color::border())
            .bg(color::card())
            .child(self.render_mute(cx))
            .child(self.render_input(cx))
            .child(self.render_output(cx))
            .child(self.render_compare(cx))
            .children(self.modes.render_lock(lang, {
                let entity = cx.entity();
                Rc::new(move |command, cx| {
                    entity.update(cx, |this, cx| {
                        this.send(command);
                        cx.notify();
                    })
                })
            }))
            .overflow_y_scrollbar()
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

/// 周波数の札（「 [44/48/96kHz]」）は欄に収まらず機器名が切れるので外す（上の帯と同じ）。
fn device(name: String) -> impl IntoElement {
    div()
        .text_xs()
        .text_color(color::muted())
        .truncate()
        .child(auralyn_ui_model::music::without_rate(&name).to_owned())
}

fn state_text(state: MeterState, lang: Lang) -> &'static str {
    match state {
        MeterState::Stopped => core(lang, keys::STATE_STOPPED),
        MeterState::Waiting | MeterState::Stale => core(lang, keys::STATE_WAITING),
        MeterState::Silent => core(lang, keys::STATE_SILENT),
        MeterState::Live => core(lang, keys::STATE_ACTIVE),
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
        .aria_label(core(lang, keys::INPUT_LEVEL))
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
                .bg(color::aurora_fill(1.)),
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
                        color::meter_danger()
                    } else {
                        color::meter_warning()
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

/// 音量のスライダー。上の行に名前と今の値（%）、100% でないときは 100% に戻すボタン。下の行にスライダーを幅いっぱいに置く。
/// 戻すときはスライダーの値を替えて、変わった知らせ（`SliderEvent`）と同じ命令をエンジンへ送る。
fn slider_row(
    id: &'static str,
    label: &'static str,
    state: &Entity<SliderState>,
    gain: fn(f32) -> Command,
    lang: Lang,
    cx: &mut Context<MainView>,
) -> impl IntoElement {
    let percent = state.read(cx).value().end().round();
    let reset = state.clone();
    div()
        .id(id)
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .flex()
                .items_center()
                .gap_1()
                .text_xs()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(color::muted())
                        .child(label),
                )
                .when(percent != 100.0, |this| {
                    this.child(
                        Button::new(SharedString::from(format!("{id}-reset")))
                            .icon(IconName::Undo2)
                            .ghost()
                            .xsmall()
                            .tooltip(core(lang, keys::RESET_TO_100))
                            .accessibility_label(core_with(
                                lang,
                                keys::RESET_NAMED,
                                &[("name", &label)],
                            ))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                reset.update(cx, |state, cx| state.set_value(100.0, window, cx));
                                this.engine.send(gain(1.0));
                                cx.notify();
                            })),
                    )
                })
                .child(
                    div()
                        .flex_none()
                        .font_weight(FontWeight::MEDIUM)
                        .child(format!("{percent}%")),
                ),
        )
        .child(Slider::new(state).horizontal().accessibility_label(label))
}
