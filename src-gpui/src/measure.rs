//! 周囲の音の測定：3秒測る・中止・確かめて採用する。ノイズ低減を「測定値で調整」「会場」にしたとき、音づくりの画面の詳細に出す。
//! 状態とボタンの規則は `auralyn-ui-model` の `measurement`。

use std::cell::Cell;
use std::rc::Rc;

use auralyn_ui_model::measurement::{Action, Measurement, Quality, State};
use gpui_kit::component::button::Button;
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::Disableable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, keys, Lang};
use crate::part::{note, paragraphs, with_hint, OnCommand};

#[derive(Default)]
pub struct MeasurePanel {
    /// 最後に読めた測定。`None` は読めない（音声が止まっているときも読めない）。
    reading: Option<Measurement>,
    /// 画面を開いてから返事が来たか。来るまでは「確認中」と出す。
    answered: bool,
    /// 「話していないと確かめた」の印。別の測定に移ったら外す。
    quiet: Rc<Cell<bool>>,
}

impl MeasurePanel {
    pub fn set(&mut self, reading: Option<Measurement>) {
        let before = self.reading.as_ref().map(|m| &m.take);
        let take = reading.as_ref().map(|m| &m.take);
        if take.is_none() || before != take {
            self.quiet.set(false);
        }
        self.reading = reading;
        self.answered = true;
    }

    /// 音づくりの画面を離れるとき。測っている途中なら、中止の命令を返す（測定はこの画面からしか始めない）。
    pub fn leave(&mut self) -> Option<Command> {
        self.answered = false;
        self.quiet.set(false);
        self.reading
            .as_ref()
            .filter(|m| m.state == State::Capturing)
            .map(|m| Command::Measure(Action::Cancel(m.take.clone())))
    }

    pub fn render(&self, lang: Lang, send: OnCommand) -> impl IntoElement {
        let reading = self.reading.as_ref();
        let status = match reading {
            Some(m) => {
                let text = core(lang, state_key(m.state));
                match m.percent() {
                    Some(percent) => format!("{text} {percent}%"),
                    None => text.to_string(),
                }
            }
            None if self.answered => core(lang, keys::MEASURE_ERROR).to_string(),
            None => core(lang, keys::MEASURE_CHECKING).to_string(),
        };
        let button = |id: &'static str, label: &'static str, action: Option<Action>| {
            let send = send.clone();
            Button::new(id)
                .label(core(lang, label))
                .outline()
                .disabled(action.is_none())
                .on_click(move |_, _, cx| {
                    if let Some(action) = action.clone() {
                        send(Command::Measure(action), cx);
                    }
                })
        };
        let take = |allowed: bool| reading.filter(|_| allowed).map(|m| m.take.clone());
        let start = take(reading.is_some_and(Measurement::can_start)).map(Action::Start);
        let cancel = take(reading.is_some_and(Measurement::can_cancel)).map(Action::Cancel);
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                with_hint(
                    "measure-hint",
                    lang,
                    paragraphs(lang, &[keys::MEASURE_LIMITS, keys::MEASURE_SCOPE]),
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .child(core(lang, keys::MEASURE_TITLE)),
                )
                .text_sm(),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .child(button("measure-start", keys::MEASURE_START, start))
                    .child(button("measure-cancel", keys::MEASURE_CANCEL, cancel))
                    .child(button(
                        "measure-read",
                        keys::MEASURE_REFRESH,
                        Some(Action::Read),
                    )),
            )
            .child(div().text_sm().child(status))
            .children(reading.into_iter().flat_map(|m| &m.quality).map(|&q| {
                div()
                    .text_sm()
                    .text_color(color::warning())
                    .child(core(lang, quality_key(q)))
            }))
            .when_some(reading.filter(|m| m.state == State::Review), |this, m| {
                let quiet = self.quiet.get();
                let approve = m
                    .can_approve(quiet)
                    .then(|| Action::Approve(m.take.clone()));
                this.child(
                    Checkbox::new("measure-quiet")
                        .checked(quiet)
                        .label(core(lang, keys::MEASURE_QUIET))
                        .on_click({
                            let flag = self.quiet.clone();
                            move |checked, window, _| {
                                flag.set(*checked);
                                window.refresh();
                            }
                        }),
                )
                .child(button("measure-use", keys::MEASURE_USE, approve))
            })
            .when(reading.is_some_and(Measurement::shows_previous), |this| {
                this.child(note(core(lang, keys::MEASURE_PREVIOUS)))
            })
    }
}

fn state_key(state: State) -> &'static str {
    match state {
        State::Idle => keys::MEASURE_IDLE,
        State::Capturing => keys::MEASURE_CAPTURING,
        State::Review => keys::MEASURE_REVIEW,
        State::Approved => keys::MEASURE_APPROVED,
        State::Invalid => keys::MEASURE_INVALID,
        State::Stale => keys::MEASURE_STALE,
    }
}

fn quality_key(quality: Quality) -> &'static str {
    match quality {
        Quality::NonFinite => keys::MEASURE_NON_FINITE,
        Quality::Silent => keys::MEASURE_SILENT,
        Quality::Clipped => keys::MEASURE_CLIPPED,
        Quality::Short => keys::MEASURE_SHORT,
        Quality::Variable => keys::MEASURE_VARIABLE,
        Quality::Uncertain => keys::MEASURE_UNCERTAIN,
    }
}
