//! 画面どうしで同じ形の部品：見出しつきの区画と、補足の文、ファイルの窓。画面からエンジンへの命令の送り口。

use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonGroup};
use gpui_kit::component::Selectable as _;
use gpui_kit::*;

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, Lang};

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

/// 保存先を聞いてから `then` を呼ぶ。やめたときは何もしない。
pub fn save_as(suggested: String, cx: &mut App, then: impl FnOnce(PathBuf, &mut App) + 'static) {
    let chosen = cx.prompt_for_new_path(Path::new(""), Some(&suggested));
    cx.spawn(async move |cx| {
        if let Some(path) = picked(chosen.await) {
            cx.update(|cx| then(path, cx));
        }
    })
    .detach();
}

/// 開くファイルを1つ聞いてから `then` を呼ぶ。やめたときは何もしない。
pub fn open_file(cx: &mut App, then: impl FnOnce(PathBuf, &mut App) + 'static) {
    let chosen = cx.prompt_for_paths(PathPromptOptions {
        files: true,
        directories: false,
        multiple: false,
        prompt: None,
    });
    cx.spawn(async move |cx| {
        let path = picked(chosen.await).and_then(|paths| paths.into_iter().next());
        if let Some(path) = path {
            cx.update(|cx| then(path, cx));
        }
    })
    .detach();
}

/// ファイルの窓の答え。やめた・窓を開けなかったときは `None`（開けなかったときは記録に残す）。
fn picked<T, E>(answer: Result<anyhow::Result<Option<T>>, E>) -> Option<T> {
    match answer {
        Ok(Ok(chosen)) => chosen,
        Ok(Err(e)) => {
            log::warn!("ファイルの窓を開けません: {e}");
            None
        }
        Err(_) => None,
    }
}

/// どれか1つを選ぶボタンの組。今の値が無い（分からない）ときは、どれも選ばない。
pub fn choices<T: Copy + PartialEq + 'static>(
    id: impl Into<SharedString>,
    lang: Lang,
    options: &[(T, &'static str)],
    current: Option<T>,
    on_pick: impl Fn(T, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let id: SharedString = id.into();
    let values: Vec<T> = options.iter().map(|(value, _)| *value).collect();
    ButtonGroup::new(id.clone())
        .outline()
        .children(options.iter().enumerate().map(|(index, (value, label))| {
            Button::new(SharedString::from(format!("{id}-{index}")))
                .label(core(lang, label))
                .selected(current == Some(*value))
        }))
        .on_click(move |clicked, window, cx| {
            if let Some(value) = clicked.first().and_then(|index| values.get(*index)) {
                on_pick(*value, window, cx);
            }
        })
}
