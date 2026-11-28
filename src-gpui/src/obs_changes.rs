//! OBS のカードの「OBS の変更確認と復元」：変更予定を確かめてから適用し、履歴から元に戻す。
//! 変更そのものと履歴はホストの `obs_setup`（アプリを終えるまで保持）。説明文は `obs_text`。

use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::{Disableable as _, WindowExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use vst_host_lib::obs_setup::{Change, History, Plan};

use crate::i18n::{core, core_with, keys, Lang};
use crate::obs::OnOrder;
use crate::obs_link::{Order, Setup, SetupDone};
use crate::obs_text;
use crate::obs_timing;
use crate::part::note;

#[derive(Clone, Copy)]
enum Op {
    Preview,
    Apply,
    Undo,
    Forget,
}

#[derive(Default)]
pub struct Changes {
    plan: Option<Plan>,
    history: Vec<History>,
    /// 送って、まだ結果が届いていない命令の数（作業スレッドは受けた順に1つずつ返す）。
    pending: u32,
    error: Option<(Op, String)>,
}

impl Changes {
    /// 変更予定を捨てる（ホストへは送らない）。切断したときも捨てる（別の接続で適用しない。ホストも断る）。
    pub fn discard(&mut self) {
        self.plan = None;
    }

    /// 入力が変わった同期の変更予定を捨てる（ほかの変更予定は残す）。
    pub fn discard_timing(&mut self) {
        if self.plan.as_ref().is_some_and(|plan| plan.timing.is_some()) {
            self.plan = None;
        }
    }

    /// `done` へ渡さない返事（同期調整の対象）が届いた。
    pub fn settled(&mut self) {
        self.pending = self.pending.saturating_sub(1);
    }

    pub fn busy(&self) -> bool {
        self.pending > 0
    }

    pub fn sent(&mut self) {
        self.pending += 1;
        self.error = None;
    }

    pub fn done(&mut self, done: SetupDone) {
        self.settled();
        match done {
            SetupDone::Plan(result) => match result {
                Ok(plan) => self.plan = Some(plan),
                Err(e) => {
                    self.plan = None;
                    self.error = Some((Op::Preview, e));
                }
            },
            SetupDone::Applied(result) => match result {
                Ok(history) => {
                    self.plan = None;
                    self.history.push(history);
                }
                Err(e) => self.error = Some((Op::Apply, e)),
            },
            // 読み直し・元に戻すでホストは変更予定を捨てる。
            SetupDone::History(history) => {
                self.plan = None;
                self.history = history;
            }
            SetupDone::Restored(result) => match result {
                Ok(restored) => {
                    self.plan = None;
                    if let Some(item) = self.history.iter_mut().find(|h| h.id == restored.id) {
                        *item = restored;
                    }
                }
                Err(e) => self.error = Some((Op::Undo, e)),
            },
            SetupDone::Forgot(result) => match result {
                Ok(id) => self.history.retain(|h| h.id != id),
                Err(e) => self.error = Some((Op::Forget, e)),
            },
        }
    }

    /// `reaching` は到達確認の最中（OBS への命令が後ろに積まれて待たされる）。
    pub fn render(
        &self,
        lang: Lang,
        connected: bool,
        reaching: bool,
        on: OnOrder,
    ) -> impl IntoElement {
        let send = |setup: Setup| {
            let on = on.clone();
            move |_: &ClickEvent, _: &mut Window, cx: &mut App| on(Order::Setup(setup.clone()), cx)
        };
        let blocked = self.busy() || reaching || !connected;
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(crate::color::border())
            .child(
                div()
                    .font_weight(FontWeight::MEDIUM)
                    .child(core(lang, keys::OBS_SETUP_TITLE)),
            )
            .child(note(core(lang, keys::OBS_SETUP_STOP_FIRST)))
            .child(
                div().child(
                    Button::new("obs-preview")
                        .label(core(lang, keys::OBS_SETUP_PREVIEW))
                        .outline()
                        .disabled(blocked)
                        .on_click(send(Setup::Preview(None))),
                ),
            )
            .when(self.busy() || reaching, |this| {
                this.child(note(core(lang, keys::OBS_SETUP_BUSY)))
            })
            .when(!connected && !self.busy() && !reaching, |this| {
                this.child(note(core(lang, keys::OBS_SETUP_NEEDS_OBS)))
            })
            .when_some(self.error.as_ref(), |this, (op, message)| {
                this.child(note(failure(lang, *op, message)))
            })
            .when_some(self.plan.as_ref(), |this, plan| {
                this.child(self.render_plan(lang, plan, blocked, &on))
            })
            .child(self.render_history(lang, blocked, &on))
    }

    fn render_plan(
        &self,
        lang: Lang,
        plan: &Plan,
        blocked: bool,
        on: &OnOrder,
    ) -> impl IntoElement {
        let message = (!plan.message.is_empty()).then(|| match &plan.message_text {
            Some(ui) => obs_text::render(lang, ui),
            None => plan.message.clone(),
        });
        let id = plan.id;
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_3()
            .rounded(px(crate::color::radius("sm")))
            .border_1()
            .border_color(crate::color::border())
            .when_some(message, |this, message| {
                this.child(div().text_sm().child(message))
            })
            .when_some(plan.timing.as_ref(), |this, timing| {
                this.child(div().text_sm().child(obs_timing::timing_line(lang, timing)))
            })
            .map(|this| {
                if plan.changes.is_empty() {
                    this.when(plan.supported, |this| {
                        this.child(div().text_sm().child(core(lang, keys::OBS_SETUP_NOTHING)))
                    })
                } else {
                    this.children(plan.changes.iter().map(|c| change(lang, c, None)))
                }
            })
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .when(plan.supported && !plan.changes.is_empty(), |this| {
                        let on = on.clone();
                        this.child(
                            Button::new("obs-apply")
                                .label(core(lang, keys::OBS_SETUP_APPLY))
                                .primary()
                                .disabled(blocked)
                                .on_click(move |_, _, cx| on(Order::Setup(Setup::Apply(id)), cx)),
                        )
                    })
                    .child({
                        let on = on.clone();
                        Button::new("obs-plan-cancel")
                            .label(core(lang, keys::OBS_SETUP_CANCEL))
                            .outline()
                            .disabled(self.busy())
                            .on_click(move |_, _, cx| on(Order::Setup(Setup::Discard), cx))
                    }),
            )
            .when(
                plan.supported && !plan.duplicate_mic_sources.is_empty(),
                |this| {
                    this.child(note(core(lang, keys::OBS_SETUP_DUPLICATE_MIC)))
                        .children(plan.duplicate_mic_sources.iter().enumerate().map(
                            |(i, source)| {
                                let on = on.clone();
                                let source = source.clone();
                                Button::new(SharedString::from(format!("obs-mute-{i}")))
                                    .label(core_with(
                                        lang,
                                        keys::OBS_SETUP_MUTE_PREVIEW,
                                        &[("source", &source)],
                                    ))
                                    .outline()
                                    .disabled(blocked)
                                    .on_click(move |_, _, cx| {
                                        on(Order::Setup(Setup::Preview(Some(source.clone()))), cx)
                                    })
                            },
                        ))
                },
            )
    }

    fn render_history(&self, lang: Lang, blocked: bool, on: &OnOrder) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(core(lang, keys::OBS_SETUP_HISTORY)),
            )
            .child(note(core(lang, keys::OBS_SETUP_HISTORY_LEAD)))
            .child(div().child({
                let on = on.clone();
                Button::new("obs-history")
                    .label(core(lang, keys::OBS_SETUP_REFRESH))
                    .outline()
                    .disabled(self.busy())
                    .on_click(move |_, _, cx| on(Order::Setup(Setup::History), cx))
            }))
            .children(self.history.iter().rev().map(|h| {
                let id = h.id;
                let results = h.results.len() == h.changes.len();
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .p_3()
                    .rounded(px(crate::color::radius("sm")))
                    .border_1()
                    .border_color(crate::color::border())
                    .child(div().text_sm().child(format!(
                        "{} #{id} {}",
                        core(
                            lang,
                            if h.timing.is_some() {
                                keys::OBS_SETUP_TIMING_CHANGE
                            } else {
                                keys::OBS_SETUP_CHANGE
                            }
                        ),
                        h.connection_label
                    )))
                    .when_some(h.timing.as_ref(), |this, timing| {
                        this.child(note(obs_timing::timing_line(lang, timing)))
                    })
                    .when(!h.restorable, |this| {
                        this.child(note(core(lang, keys::OBS_SETUP_NOT_RESTORABLE)))
                    })
                    .children(h.changes.iter().enumerate().map(|(i, c)| {
                        let result = results.then(|| {
                            match h
                                .result_entries
                                .as_ref()
                                .filter(|entries| entries.len() == h.results.len())
                                .and_then(|entries| entries.get(i))
                            {
                                Some(entry) => obs_text::render(lang, &entry.text),
                                None => h.results[i].clone(),
                            }
                        });
                        change(lang, c, result)
                    }))
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap_2()
                            .child({
                                let on = on.clone();
                                Button::new(SharedString::from(format!("obs-undo-{id}")))
                                    .label(core(lang, keys::UNDO_SHORT))
                                    .accessibility_label(core_with(
                                        lang,
                                        keys::OBS_SETUP_UNDO,
                                        &[("id", &id)],
                                    ))
                                    .outline()
                                    .disabled(blocked || !h.restorable)
                                    .on_click(move |_, _, cx| {
                                        on(Order::Setup(Setup::Restore(id)), cx)
                                    })
                            })
                            .child({
                                let on = on.clone();
                                Button::new(SharedString::from(format!("obs-forget-{id}")))
                                    .label(core(lang, keys::FORGET_SHORT))
                                    .accessibility_label(core_with(
                                        lang,
                                        keys::OBS_SETUP_FORGET,
                                        &[("id", &id)],
                                    ))
                                    .outline()
                                    .disabled(self.busy())
                                    .on_click(move |_, window, cx| {
                                        let on = on.clone();
                                        window.open_alert_dialog(cx, move |alert, _, _| {
                                            let on = on.clone();
                                            alert
                                                .title(core_with(
                                                    lang,
                                                    keys::OBS_SETUP_FORGET,
                                                    &[("id", &id)],
                                                ))
                                                .description(core(
                                                    lang,
                                                    keys::OBS_SETUP_FORGET_TEXT,
                                                ))
                                                .ok_text(core(lang, keys::OBS_SETUP_FORGET_OK))
                                                .ok_variant(ButtonVariant::Danger)
                                                .cancel_text(core(
                                                    lang,
                                                    keys::OBS_SETUP_FORGET_CANCEL,
                                                ))
                                                .show_cancel(true)
                                                .on_ok(move |_, _, cx| {
                                                    on(Order::Setup(Setup::Forget(id)), cx);
                                                    true
                                                })
                                        });
                                    })
                            }),
                    )
            }))
    }
}

/// 1つの変更：「ソース：項目（— 結果）」と「前 → 後」。
fn change(lang: Lang, c: &Change, result: Option<String>) -> impl IntoElement {
    let label = c
        .label_text
        .as_ref()
        .map_or_else(|| c.label.clone(), |ui| obs_text::render(lang, ui));
    let before = obs_text::value(
        lang,
        c.before_text.as_ref(),
        c.before_display.as_deref(),
        &c.before,
    );
    let after = obs_text::value(
        lang,
        c.after_text.as_ref(),
        c.after_display.as_deref(),
        &c.after,
    );
    div()
        .flex()
        .flex_col()
        .text_sm()
        .child(div().font_weight(FontWeight::MEDIUM).child(match result {
            Some(result) => format!("{}：{label} — {result}", c.source),
            None => format!("{}：{label}", c.source),
        }))
        .child(
            div()
                .text_color(crate::color::muted())
                .child(format!("{before} → {after}")),
        )
}

/// 失敗の表示。ホストの文は訳さず、原文として後ろに付ける。
fn failure(lang: Lang, op: Op, message: &str) -> String {
    if message == vst_host_lib::obs_setup::HISTORY_FULL {
        return core(lang, keys::OBS_SETUP_HISTORY_FULL).to_string();
    }
    let (failed, next) = match op {
        Op::Preview => (keys::OBS_SETUP_PREVIEW_FAILED, keys::OBS_SETUP_PREVIEW_NEXT),
        Op::Apply => (keys::OBS_SETUP_APPLY_FAILED, keys::OBS_SETUP_ERROR_NEXT),
        Op::Undo => (keys::OBS_SETUP_UNDO_FAILED, keys::OBS_SETUP_ERROR_NEXT),
        Op::Forget => (keys::OBS_SETUP_FORGET_FAILED, keys::OBS_SETUP_FORGET_NEXT),
    };
    let next = core_with(
        lang,
        next,
        &[
            ("preview", &core(lang, keys::OBS_SETUP_PREVIEW)),
            ("history", &core(lang, keys::OBS_SETUP_HISTORY)),
            ("refresh", &core(lang, keys::OBS_SETUP_REFRESH)),
        ],
    );
    let original = obs_text::original(lang, message);
    format!("{} {next} {original}", core(lang, failed))
}
