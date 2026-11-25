//! 設定の画面：表示言語と、Windows との連携（トレイ・Alt+M）の状態と、版。
//! 自動起動・更新・音声処理の調整・再起動・診断は、まだこの画面に無い。

use gpui_kit::component::button::{Button, ButtonGroup};
use gpui_kit::component::Selectable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::i18n::{core, keys, Lang};

const LANGS: [(Lang, &str); 2] = [(Lang::Ja, "日本語"), (Lang::En, "English")];

/// `tray`・`hotkey` は、使えないときの理由。
pub fn render(
    lang: Lang,
    tray: Option<&str>,
    hotkey: Option<&str>,
    on_lang: impl Fn(Lang, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_6()
        .max_w(px(560.))
        .child(card(
            core(lang, keys::LANGUAGE),
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
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(status(lang, keys::TRAY, tray))
                .child(status(lang, keys::HOTKEY, hotkey)),
        ))
        .child(note(format!(
            "{} {}",
            core(lang, keys::VERSION).trim(),
            env!("CARGO_PKG_VERSION")
        )))
}

/// 見出しと中身の区画。
fn card(title: &'static str, body: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_3()
        .p_4()
        .rounded(px(8.))
        .border_1()
        .border_color(color::border())
        .bg(color::card())
        .child(
            div()
                .id(SharedString::new_static(title))
                .role(Role::Heading)
                .aria_level(2)
                .font_weight(FontWeight::SEMIBOLD)
                .child(title),
        )
        .child(body)
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

fn note(text: impl Into<SharedString>) -> impl IntoElement {
    div()
        .text_sm()
        .text_color(color::muted())
        .child(text.into())
}
