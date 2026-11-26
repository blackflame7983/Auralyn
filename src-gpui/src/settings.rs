//! 設定の画面（外観・OBS連携・ホットキー・システム・困ったときのタブ）：表示言語・外観（テーマ）と、Windows との連携（トレイ・グローバルショートカット）の状態と、版。診断（稼働統計）と、読み込みを止めた VST のリセット。
//! 困ったとき（症状ごとの次の1手と、公式サイトのドキュメントへのリンク）と、言葉の意味（user-docs の用語集から）。
//! 自動起動・更新・音声処理の調整・再起動は、まだこの画面に無い。数え方の規則は `auralyn-ui-model` の `diagnostics`。

use auralyn_core::design::Theme;
use auralyn_ui_model::diagnostics::{self, Stats};
use std::sync::LazyLock;

use auralyn_ui_model::docs::{self, Guide, Term, Trouble};
use auralyn_ui_model::shortcuts::{self, Action};
use gpui_kit::component::button::{Button, ButtonGroup, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::{Selectable as _, WindowExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::desktop::Registered;
use crate::engine::Command;
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note, OnCommand};

const LANGS: [(Lang, &str); 2] = [(Lang::Ja, "日本語"), (Lang::En, "English")];

/// 設定の画面の区切り（Tauri 版の設定と同じ名前を使う）。
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum Section {
    #[default]
    Appearance,
    Obs,
    Shortcuts,
    System,
    Help,
}

impl Section {
    const ALL: [Section; 5] = [
        Section::Appearance,
        Section::Obs,
        Section::Shortcuts,
        Section::System,
        Section::Help,
    ];

    fn label(self) -> &'static str {
        match self {
            Section::Appearance => keys::APPEARANCE,
            Section::Obs => keys::SETTINGS_OBS,
            Section::Shortcuts => keys::SETTINGS_SHORTCUTS,
            Section::System => keys::SETTINGS_SYSTEM,
            Section::Help => keys::HELP_TROUBLE,
        }
    }
}

/// 区切りのタブと、選んだ区切りの中身と、版。
pub fn render(
    lang: Lang,
    section: Section,
    on_section: impl Fn(Section, &mut Window, &mut App) + 'static,
    body: impl IntoElement,
) -> impl IntoElement {
    let selected = Section::ALL.iter().position(|s| *s == section).unwrap_or(0);
    div()
        .flex()
        .flex_col()
        .gap_6()
        .max_w(px(560.))
        .child(
            TabBar::new("settings-sections")
                .underline()
                .selected_index(selected)
                .children(
                    Section::ALL
                        .iter()
                        .map(|s| Tab::new().label(core(lang, s.label()))),
                )
                .on_click(move |index, window, cx| {
                    if let Some(section) = Section::ALL.get(*index) {
                        on_section(*section, window, cx);
                    }
                }),
        )
        .child(body)
        .child(note(format!(
            "{} {}",
            core(lang, keys::VERSION).trim(),
            env!("CARGO_PKG_VERSION")
        )))
}

pub fn language(
    lang: Lang,
    on_lang: impl Fn(Lang, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    card(
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
    )
}

/// `tray` は、使えないときの理由。
pub fn desktop(lang: Lang, tray: Option<&str>) -> impl IntoElement {
    card(
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
    )
}

const THEMES: [(Theme, &str, &str); 3] = [
    (Theme::Light, keys::THEME_LIGHT, keys::THEME_LIGHT_BODY),
    (Theme::Dark, keys::THEME_DARK, keys::THEME_DARK_BODY),
    (Theme::Gaming, keys::THEME_GAMING, keys::THEME_GAMING_BODY),
];

/// 外観：テーマを選ぶ（Tauri 版と同じ3つ）。この版は色だけを替える。
pub fn appearance(
    lang: Lang,
    theme: Theme,
    on_theme: impl Fn(Theme, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let body = THEMES
        .iter()
        .find(|(value, _, _)| *value == theme)
        .map(|(_, _, body)| core(lang, body));
    card(
        core(lang, keys::APPEARANCE),
        div(),
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(core(lang, keys::THEME_TITLE)),
            )
            .child(
                ButtonGroup::new("theme")
                    .outline()
                    .children(THEMES.iter().map(|(value, label, _)| {
                        Button::new(*label)
                            .label(core(lang, label))
                            .selected(*value == theme)
                    }))
                    .on_click(move |clicked, window, cx| {
                        if let Some((value, _, _)) = clicked.first().and_then(|i| THEMES.get(*i)) {
                            on_theme(*value, window, cx);
                        }
                    }),
            )
            .children(body.map(note))
            .child(note(core(lang, keys::THEME_NOTE)))
            .child(div().child(doc_link(
                "help-appearance".into(),
                core(lang, keys::HELP_MORE),
                docs::APPEARANCE,
                lang == Lang::En,
            ))),
    )
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
                let state = saved
                    .error
                    .as_ref()
                    .map(|e| format!("{}: {e}", core(lang, keys::UNAVAILABLE)));
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

/// 配信ミックスの診断。診断と一緒に読む（「読み直す」で両方）。読めない項目は「-」。
pub fn mix_diagnostics(lang: Lang, mix: &diagnostics::Mix) -> impl IntoElement {
    fn text(value: Option<impl ToString>) -> String {
        value.map_or_else(|| "-".to_owned(), |v| v.to_string())
    }
    let on_off = |v: Option<bool>| text(v.map(|on| if on { "ON" } else { "OFF" }));
    let rows = [
        (
            keys::MIX_DIAG_CAPTURE,
            text(mix.captured.map(|(all, heard)| format!("{all} / {heard}"))),
        ),
        (keys::MIX_DIAG_QUEUE, text(mix.queued)),
        (keys::MIX_DIAG_CORRECTION, text(mix.correction_ppm)),
        (keys::MIX_DIAG_DISCONTINUITIES, text(mix.discontinuities)),
        (keys::MIX_DIAG_TIMESTAMPS, text(mix.timestamp_errors)),
        (keys::MIX_DIAG_NONFINITE, text(mix.nonfinite)),
        (keys::MIX_DIAG_DISCARDED, text(mix.discarded)),
        (keys::MIX_DIAG_PRIMARY_QUEUE, text(mix.primary_queued)),
        (
            keys::MIX_DIAG_PRIMARY_CORRECTION,
            text(mix.primary_correction_ppm),
        ),
        (keys::MIX_DIAG_UNDERRUNS, text(mix.underruns)),
        (keys::MIX_DIAG_VOICE_FRAMES, text(mix.voice_frames)),
        (keys::MIX_DIAG_ATTACHED, on_off(mix.attached)),
        (keys::MIX_DIAG_READY, on_off(mix.ready)),
        (keys::MIX_DIAG_FAILED, on_off(mix.failed)),
        (keys::MIX_DIAG_PACKETS, text(mix.packets)),
        (keys::MIX_DIAG_RATE, text(mix.sample_rate)),
        (keys::MIX_DIAG_TRANSPORT, text(mix.transport_frames)),
        (keys::MIX_DIAG_DECLARED, text(mix.declared_frames)),
    ];
    card(
        core(lang, keys::MIX_DIAG_TITLE),
        div(),
        div()
            .flex()
            .flex_col()
            .gap_1()
            .children(rows.map(|(name, value)| row(lang, name, value))),
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
                            div()
                                .flex()
                                .flex_wrap()
                                .gap_3()
                                .child(doc_link(
                                    format!("help-{trouble:?}"),
                                    core(lang, keys::HELP_MORE),
                                    target,
                                    english,
                                ))
                                .when(trouble == Trouble::NotReceived, |this| {
                                    this.children(Guide::ALL.map(|guide| {
                                        doc_link(
                                            format!("help-{guide:?}"),
                                            core(lang, guide_label(guide)),
                                            guide.target(),
                                            english,
                                        )
                                    }))
                                }),
                        )
                }),
        ),
    )
}

/// 公式サイトのドキュメントを開くリンク。
fn doc_link(id: String, label: &'static str, target: &'static str, english: bool) -> Button {
    Button::new(SharedString::from(id))
        .label(label)
        .link()
        .on_click(move |_, _, cx| cx.open_url(&docs::url(target, english)))
}

fn guide_label(guide: Guide) -> &'static str {
    match guide {
        Guide::Obs => keys::GUIDE_OBS,
        Guide::Call => keys::GUIDE_CALL,
    }
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

/// 用語集（`user-docs` の原稿から作る。アプリ側に別の説明を書かない）。
static GLOSSARY: LazyLock<[Vec<Term>; 2]> = LazyLock::new(|| {
    [
        docs::glossary(include_str!("../../user-docs/ja/glossary.md")),
        docs::glossary(include_str!("../../user-docs/en/glossary.md")),
    ]
});

/// 言葉の意味：各用語の短い説明と、ドキュメントの該当箇所へのリンク。
pub fn glossary(lang: Lang) -> impl IntoElement {
    let english = lang == Lang::En;
    card(
        core(lang, keys::HELP_TERMS),
        div(),
        div()
            .flex()
            .flex_col()
            .gap_3()
            .children(GLOSSARY[usize::from(english)].iter().map(|term| {
                let target = format!("glossary#{}", term.anchor);
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .text_sm()
                            .font_weight(FontWeight::MEDIUM)
                            .child(term.title.clone()),
                    )
                    .child(note(term.summary.clone()))
                    .child(
                        div().child(
                            Button::new(SharedString::from(term.anchor.clone()))
                                .label(core(lang, keys::HELP_MORE))
                                .link()
                                .on_click(move |_, _, cx| {
                                    cx.open_url(&docs::url(&target, english))
                                }),
                        ),
                    )
            })),
    )
}
