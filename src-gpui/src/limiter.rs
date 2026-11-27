//! 音づくりの画面の2つの制限：「大きな音を抑える」（ピーク保護）と「配信用 true-peak 制限」。
//! どちらも ON/OFF・天井・復帰時間で、値の範囲と注記の決め方は `auralyn-ui-model` の `peak`。読めない（止まっている）間は操作させない。

use auralyn_ui_model::peak::{self, Limit, Peak};
use gpui_kit::assets::IconName;
use gpui_kit::component::slider::SliderState;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::Disableable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::engine::Command;
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note, paragraphs, OnCommand};
use crate::sound::{range, slider_row, unknown};

pub struct LimiterPanel {
    limit: Limit,
    /// 天井（dBFS）と復帰時間（ms）。離したときに送る（`MainView` が購読する）。
    pub ceiling: Entity<SliderState>,
    pub release: Entity<SliderState>,
    /// `None` は読めていない。
    peak: Option<Peak>,
    /// 最後に読めた ON/OFF。止まっていて読めない間も、スイッチはこれを示す（次の開始で付け直される）。
    enabled: bool,
}

impl LimiterPanel {
    pub fn new<V: 'static>(limit: Limit, cx: &mut Context<V>) -> Self {
        Self {
            limit,
            ceiling: range(cx, peak::CEILING_DB),
            release: range(cx, peak::RELEASE_MS),
            peak: None,
            enabled: false,
        }
    }

    /// `answered` は変えた命令への返事（`peak::moves_sliders`）。
    pub fn set(&mut self, peak: Option<Peak>, answered: bool, window: &mut Window, cx: &mut App) {
        let before = self.peak;
        if let Some(peak) = peak.filter(|&peak| peak::moves_sliders(before, peak, answered)) {
            self.ceiling
                .update(cx, |state, cx| state.set_value(peak.ceiling_db, window, cx));
            self.release
                .update(cx, |state, cx| state.set_value(peak.release_ms, window, cx));
        }
        if let Some(peak) = peak {
            self.enabled = peak.enabled;
        }
        self.peak = peak;
    }

    /// 送る天井と復帰時間（スライダーの値を刻みにそろえる）。
    pub fn limits(&self, cx: &App) -> Command {
        Command::SetPeakLimits {
            limit: self.limit,
            ceiling_db: peak::snap(peak::CEILING_DB, self.ceiling.read(cx).value().end()),
            release_ms: peak::snap(peak::RELEASE_MS, self.release.read(cx).value().end()),
        }
    }

    /// 見ている間 500ms ごとに読み直すか（`peak::polls`）。
    pub fn polls(&self) -> bool {
        peak::polls(self.peak)
    }

    /// `locked` は操作ロック中。エンジンが断るので、先に操作を止めて理由を出す（Tauri 版と同じ）。
    pub fn render(&self, lang: Lang, locked: bool, cx: &App, send: OnCommand) -> impl IntoElement {
        let limit = self.limit;
        let true_peak = limit == Limit::TruePeak;
        let unread = self.peak.is_none();
        let disabled = unread || locked;
        let title = if true_peak {
            keys::TRUE_PEAK_TITLE
        } else {
            keys::PEAK_TITLE
        };
        let notes = peak::notes(self.peak);
        let notes: Vec<&str> = notes
            .into_iter()
            .map(|note| {
                core(
                    lang,
                    match note {
                        peak::Note::Unknown => keys::PEAK_UNKNOWN,
                        peak::Note::Pending => keys::PEAK_PENDING,
                        peak::Note::Stopped => keys::PEAK_STOPPED,
                        peak::Note::NotApplied => keys::TRUE_PEAK_NOT_APPLIED,
                    },
                )
            })
            .collect();
        let lookahead = self.peak.and_then(|peak| peak.lookahead);
        card(
            core(lang, title),
            Switch::new(if true_peak { "true-peak-on" } else { "peak-on" })
                .checked(self.enabled)
                .disabled(disabled)
                .accessibility_label(core(lang, title))
                .on_click(move |on, _, cx| send(Command::SetPeak(limit, *on), cx)),
            div()
                .flex()
                .flex_col()
                .gap_2()
                .when(locked, |this| {
                    this.child(note(core(lang, keys::PEAK_LOCKED)))
                })
                .when(!notes.is_empty(), |this| {
                    this.child(div().text_sm().child(notes.join(" · ")))
                })
                .when_some(lookahead, |this, lookahead| {
                    this.child(div().text_sm().child(core_with(
                        lang,
                        keys::TRUE_PEAK_LATENCY,
                        &[("samples", &lookahead.samples)],
                    )))
                    .child(div().text_sm().child(core_with(
                        lang,
                        keys::TRUE_PEAK_REDUCTION,
                        &[("db", &format!("{:.1}", lookahead.reduction_db))],
                    )))
                })
                .child(
                    div()
                        .pt_2()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child(core(lang, keys::PEAK_DETAILS)),
                )
                .child(slider_row(
                    lang,
                    keys::PEAK_CEILING,
                    format!("{} {}", core(lang, title), core(lang, keys::PEAK_CEILING)),
                    &self.ceiling,
                    if unread {
                        unknown
                    } else {
                        |v| format!("{v:.1}")
                    },
                    disabled,
                    cx,
                ))
                .child(slider_row(
                    lang,
                    keys::PEAK_RELEASE,
                    format!("{} {}", core(lang, title), core(lang, keys::PEAK_RELEASE)),
                    &self.release,
                    if unread {
                        unknown
                    } else {
                        |v| format!("{v:.0}")
                    },
                    disabled,
                    cx,
                )),
        )
        .icon(if true_peak {
            IconName::ShieldCheck
        } else {
            IconName::Shield
        })
        .hint(
            lang,
            paragraphs(
                lang,
                if true_peak {
                    &[
                        keys::TRUE_PEAK_LEAD,
                        keys::TRUE_PEAK_SCOPE,
                        keys::TRUE_PEAK_LIMITS,
                    ]
                } else {
                    &[keys::PEAK_LEAD, keys::PEAK_SCOPE, keys::PEAK_RESETS]
                },
            ),
        )
    }
}
