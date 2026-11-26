//! 画面どうしで同じ形の部品：見出しつきの区画と、補足の文。画面からエンジンへの命令の送り口。

use std::rc::Rc;

use gpui_kit::*;

use crate::color;
use crate::engine::Command;

/// 画面の操作は、エンジンへの命令としてそのまま送る。
pub type OnCommand = Rc<dyn Fn(Command, &mut App)>;

/// 見出し（と右の部品）・中身の区画。`title` は訳した文言。右に何も置かないときは `div()` を渡す。
pub fn card(
    title: &'static str,
    trailing: impl IntoElement,
    body: impl IntoElement,
) -> impl IntoElement {
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
                .flex()
                .items_center()
                .justify_between()
                .gap_3()
                .child(
                    div()
                        .id(SharedString::new_static(title))
                        .role(Role::Heading)
                        .aria_level(2)
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title),
                )
                .child(trailing),
        )
        .child(body)
}

/// 補足の文（小さく、薄い色）。
pub fn note(text: impl Into<SharedString>) -> impl IntoElement {
    div()
        .text_sm()
        .text_color(color::muted())
        .child(text.into())
}
