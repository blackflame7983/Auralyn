//! 設定の画面：表示言語と、Windows との連携（トレイ・グローバルショートカット）の状態と、版。診断（稼働統計）と、読み込みを止めた VST のリセット。
//! 困ったとき（症状ごとの次の1手と、公式サイトのドキュメントへのリンク）。
//! 自動起動・更新・音声処理の調整・再起動は、まだこの画面に無い。数え方の規則は `auralyn-ui-model` の `diagnostics`。

use auralyn_ui_model::diagnostics::Stats;
use auralyn_ui_model::docs::{self, Trouble};
use auralyn_ui_model::shortcuts::{self, Action};
use gpui_kit::component::button::{Button, ButtonGroup, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::{Selectable as _, WindowExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::desktop::Registered;
use crate::engine::Command;
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note, OnCommand};

const LANGS: [(Lang, &str); 2] = [(Lang::Ja, "日本語"), (Lang::En, "English")];

/// `tray` は、使えないときの理由。
pub fn render(
    lang: Lang,
    tray: Option<&str>,
    on_lang: impl Fn(Lang, &mut Window, &mut App) + 'static,
    more: impl IntoElement,
) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_6()
        .max_w(px(560.))
        .child(card(
            core(lang, keys::LANGUAGE),
            div(),
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(
                    ButtonGroup::new("language")
                        .outline()
                        .children(LANGS.iter().map(|(value, label)| {
                            Button::new(*label).label(*label).selected(*value == lang)
                        }))
                        .on_click(move |clicked, window, cx| {
                            if let Some((value, _)) = clicked.first().and_then(|i| LANGS.get(*i)) {
                                on_lang(*value, window, cx);
                            }
                        }),
                )
                .child(note(core(lang, keys::LANGUAGE_PARTIAL))),
        ))
        .child(card(
            core(lang, keys::DESKTOP),
            div(),
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(status(lang, keys::TRAY, tray))
                .when(tray.is_none(), |this| {
                    this.child(note(core(lang, keys::QUIT_HELP)))
                }),
        ))
        .child(more)
        .child(note(format!(
            "{} {}",
            core(lang, keys::VERSION).trim(),
            env!("CARGO_PKG_VERSION")
        )))
}

/// 1行：名前と、使えるか（使えないなら理由）。
fn status(lang: Lang, name: &'static str, error: Option<&str>) -> impl IntoElement {
    div()
        .flex()
        .justify_between()
        .gap_3()
        .text_sm()
        .child(div().flex_none().child(core(lang, name)))
        .child(
            div()
                .min_w_0()
                .when(error.is_some(), |this| this.text_color(color::warning()))
                .child(match error {
                    Some(error) => format!("{}: {error}", core(lang, keys::UNAVAILABLE)),
                    None => core(lang, keys::READY).to_owned(),
                }),
        )
}

/// グローバルショートカット：保存した組合せと、使えるか。`error` は保存を読めなかった理由（このときは1つも登録していない）。
pub fn shortcuts(lang: Lang, saved: &[Registered], error: Option<&str>) -> impl IntoElement {
    card(
        core(lang, keys::SHORTCUTS_TITLE),
        div(),
        div()
            .flex()
            .flex_col()
            .gap_2()
            .when_some(error, |this, error| {
                this.child(div().text_sm().text_color(color::warning()).child(format!(
                    "{}: {error}",
                    core(lang, keys::SHORTCUTS_UNREADABLE)
                )))
            })
            .when(error.is_none() && saved.is_empty(), |this| {
                this.child(note(core(lang, keys::SHORTCUTS_EMPTY)))
            })
            .children(saved.iter().map(|saved| {
                let state = if !saved.binding.action.supported() {
                    Some(core(lang, keys::SHORTCUT_UNSUPPORTED).to_owned())
                } else {
                    saved
                        .error
                        .as_ref()
                        .map(|e| format!("{}: {e}", core(lang, keys::UNAVAILABLE)))
                };
                div()
                    .flex()
                    .justify_between()
                    .gap_3()
                    .text_sm()
                    .child(
                        div()
                            .flex_none()
                            .child(core(lang, action_label(saved.binding.action))),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .items_end()
                            .child(shortcuts::label(&saved.binding.shortcut))
                            .when_some(state, |this, state| {
                                this.child(div().text_color(color::warning()).child(state))
                            }),
                    )
            }))
            .child(note(core(lang, keys::SHORTCUTS_EDIT_IN_TAURI))),
    )
}

fn action_label(action: Action) -> &'static str {
    match action {
        Action::MuteToggle => keys::SHORTCUT_MUTE_TOGGLE,
        Action::MuteOn => keys::SHORTCUT_MUTE_ON,
        Action::MuteOff => keys::SHORTCUT_MUTE_OFF,
        Action::BypassToggle => keys::SHORTCUT_BYPASS_TOGGLE,
        Action::BypassOn => keys::SHORTCUT_BYPASS_ON,
        Action::BypassOff => keys::SHORTCUT_BYPASS_OFF,
        Action::GainUp => keys::SHORTCUT_GAIN_UP,
        Action::GainDown => keys::SHORTCUT_GAIN_DOWN,
        Action::SingingOn => keys::SHORTCUT_SINGING,
        Action::TalkOn => keys::SHORTCUT_TALK,
        Action::NoiseToggle => keys::SHORTCUT_NOISE,
    }
}

/// 診断：稼働統計。`stats` が `None` なら読めなかった（音声が止まっているときは、すべて 0 として読める）。
pub fn diagnostics(lang: Lang, stats: Option<&Stats>, send: OnCommand) -> impl IntoElement {
    let value = |read: fn(&Stats) -> String| stats.map_or_else(|| "-".to_owned(), read);
    let health = stats.and_then(|s| s.health);
    card(
        core(lang, keys::DIAG_TITLE),
        Button::new("diag-refresh")
            .label(core(lang, keys::DIAG_REFRESH))
            .outline()
            .on_click(move |_, _, cx| send(Command::ReadStats, cx)),
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(row(
                lang,
                keys::DIAG_LOADED,
                value(|s| s.loaded.to_string()),
            ))
            .child(row(
                lang,
                keys::DIAG_ENABLED,
                value(|s| s.enabled.to_string()),
            ))
            .child(row(
                lang,
                keys::DIAG_PENDING,
                value(|s| s.pending_unload.to_string()),
            ))
            .child(row(
                lang,
                keys::DIAG_BURNED,
                value(|s| s.burned.to_string()),
            ))
            .child(row(lang, keys::DIAG_JITTER, value(Stats::jitter)))
            .child(row(
                lang,
                keys::DIAG_GLITCHES,
                value(|s| s.glitches.to_string()),
            ))
            .child(row(
                lang,
                keys::DIAG_RECENT_LABEL,
                health.map_or_else(
                    || "-".to_owned(),
                    |h| {
                        core_with(
                            lang,
                            keys::DIAG_RECENT,
                            &[
                                ("window", &h.window_secs),
                                ("late", &h.recent_late),
                                ("underflow", &h.recent_underflow),
                            ],
                        )
                    },
                ),
            ))
            .when(health.is_some(), |this| {
                this.child(note(core(lang, keys::DIAG_RECENT_NOTE)))
            })
            .when(health.is_some_and(|h| h.warns()), |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(color::warning())
                        .child(core(lang, keys::DIAG_RECENT_HIGH)),
                )
            }),
    )
}

/// 読み込みを止めた VST のリセット。`cleared` は直前の結果（失敗なら理由）。
pub fn plugins(
    lang: Lang,
    cleared: Option<&Result<(), String>>,
    send: OnCommand,
) -> impl IntoElement {
    card(
        core(lang, keys::PLUGINS_TITLE),
        div(),
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(core(lang, keys::EXCL_TITLE)),
            )
            .child(note(core(lang, keys::EXCL_LEAD)))
            .child(
                div().child(
                    Button::new("exclusions-clear")
                        .label(core(lang, keys::EXCL_BUTTON))
                        .danger()
                        .on_click(move |_, window, cx| {
                            let send = send.clone();
                            window.open_alert_dialog(cx, move |alert, _, _| {
                                let send = send.clone();
                                alert
                                    .title(core(lang, keys::EXCL_CONFIRM_TITLE))
                                    .description(core(lang, keys::EXCL_CONFIRM_TEXT))
                                    .ok_text(core(lang, keys::EXCL_CONFIRM))
                                    .ok_variant(ButtonVariant::Danger)
                                    .cancel_text(core(lang, keys::CANCEL))
                                    .show_cancel(true)
                                    .on_ok(move |_, _, cx| {
                                        send(Command::ClearExclusions, cx);
                                        true
                                    })
                            });
                        }),
                ),
            )
            .when_some(cleared, |this, done| {
                this.child(note(match done {
                    Ok(()) => core(lang, keys::EXCL_DONE).to_owned(),
                    Err(e) => format!("{} {e}", core(lang, keys::EXCL_FAILED)),
                }))
            }),
    )
}

/// 統計の1行：名前と値。
fn row(lang: Lang, name: &'static str, value: String) -> impl IntoElement {
    div()
        .flex()
        .justify_between()
        .gap_3()
        .text_sm()
        .child(div().text_color(color::muted()).child(core(lang, name)))
        .child(div().min_w_0().child(value))
}

/// 困ったとき：症状ごとに次の1手と、ドキュメントの該当箇所へのリンク（Tauri 版の使い方の「困ったとき」）。
/// `tray` は通知領域のアイコンがあるか。無ければ × で終わるので「閉じても音が続く」は出さない。
pub fn trouble(lang: Lang, tray: bool) -> impl IntoElement {
    let english = lang == Lang::En;
    card(
        core(lang, keys::HELP_TROUBLE),
        Button::new("help-docs")
            .label(core(lang, keys::HELP_DOCS))
            .outline()
            .on_click(move |_, _, cx| cx.open_url(&docs::url(docs::INDEX, english))),
        div().flex().flex_col().gap_3().children(
            Trouble::ALL
                .into_iter()
                .filter(move |&t| tray || t != Trouble::KeepsRunning)
                .map(|trouble| {
                    let (title, body) = trouble_text(lang, trouble);
                    let target = trouble.target();
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title))
                        .child(note(body))
                        .child(
                            div().child(
                                Button::new(SharedString::from(format!("help-{trouble:?}")))
                                    .label(core(lang, keys::HELP_MORE))
                                    .link()
                                    .on_click(move |_, _, cx| {
                                        cx.open_url(&docs::url(target, english))
                                    }),
                            ),
                        )
                }),
        ),
    )
}

fn trouble_text(lang: Lang, trouble: Trouble) -> (&'static str, String) {
    match trouble {
        Trouble::Silent => (
            core(lang, keys::HELP_SILENT),
            core_with(
                lang,
                keys::HELP_SILENT_BODY,
                &[
                    ("emergency", &core(lang, keys::EMERGENCY)),
                    ("gain", &core(lang, keys::OUTPUT_VOLUME)),
                ],
            ),
        ),
        Trouble::NotReceived => (
            core(lang, keys::HELP_RECEIVER),
            core(lang, keys::HELP_RECEIVER_BODY).to_owned(),
        ),
        Trouble::Dropouts => (
            core(lang, keys::HELP_DROPOUTS),
            core_with(
                lang,
                keys::HELP_DROPOUTS_BODY,
                &[("diagnostics", &core(lang, keys::DIAG_TITLE))],
            ),
        ),
        Trouble::KeepsRunning => (
            core(lang, keys::HELP_KEEPS_RUNNING),
            core_with(
                lang,
                keys::HELP_KEEPS_RUNNING_BODY,
                &[
                    ("stop", &core(lang, keys::STOP)),
                    ("quit", &core(lang, keys::TRAY_QUIT)),
                ],
            ),
        ),
    }
}
