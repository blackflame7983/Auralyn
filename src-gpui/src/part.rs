//! 画面どうしで同じ形の部品：見出しつきの区画と、補足の文、ファイルの窓。画面からエンジンへの命令の送り口。

use std::path::{Path, PathBuf};
use std::rc::Rc;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{Icon, Selectable as _, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, Lang};

/// 画面の操作は、エンジンへの命令としてそのまま送る。
pub type OnCommand = Rc<dyn Fn(Command, &mut App)>;

/// 見出し（と右の部品）・中身の区画。`title` は訳した文言。右に何も置かないときは `div()` を渡す。
pub fn card(title: &'static str, trailing: impl IntoElement, body: impl IntoElement) -> Card {
    Card::new(title, body).trailing(trailing)
}

/// 見出しつきの区画。見出しの前にアイコン、後ろに補足（ⓘ）を置ける。
#[derive(IntoElement)]
pub struct Card {
    icon: Option<IconName>,
    title: &'static str,
    hint: Option<SharedString>,
    trailing: Option<AnyElement>,
    body: AnyElement,
}

impl Card {
    pub fn new(title: &'static str, body: impl IntoElement) -> Self {
        Self {
            icon: None,
            title,
            hint: None,
            trailing: None,
            body: body.into_any_element(),
        }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// 見出しの横の ⓘ に出す説明（画面には文を並べない）。
    pub fn hint(mut self, text: impl Into<SharedString>) -> Self {
        self.hint = Some(text.into());
        self
    }

    pub fn trailing(mut self, trailing: impl IntoElement) -> Self {
        self.trailing = Some(trailing.into_any_element());
        self
    }
}

impl RenderOnce for Card {
    fn render(self, _: &mut Window, _: &mut App) -> impl IntoElement {
        let title = self.title;
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
                            .flex()
                            .items_center()
                            .gap_2()
                            .when_some(self.icon, |this, icon| {
                                this.child(Icon::new(icon).text_color(color::primary()))
                            })
                            .child(
                                div()
                                    .id(SharedString::new_static(title))
                                    .role(Role::Heading)
                                    .aria_level(2)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(title),
                            )
                            .when_some(self.hint, |this, text| {
                                this.child(hint(format!("{title}-hint"), text))
                            }),
                    )
                    .children(self.trailing),
            )
            .child(self.body)
    }
}

/// 補足の説明。文を画面に並べず、ⓘ に指を置くと出す（読み上げにも渡す）。
pub fn hint(id: impl Into<ElementId>, text: impl Into<SharedString>) -> impl IntoElement {
    let text = text.into();
    Button::new(id)
        .ghost()
        .xsmall()
        .icon(IconName::Info)
        .accessibility_label(text.clone())
        .tooltip(text)
}

/// 広い窓では2列、狭くなると1列に折り返す（各列は 320〜560px）。左に主な情報、右に補助を置く。
pub fn columns(left: impl IntoElement, right: impl IntoElement) -> impl IntoElement {
    let column = |content: AnyElement| {
        div()
            .flex_1()
            .min_w(px(320.))
            .max_w(px(560.))
            .child(content)
    };
    div()
        .flex()
        .flex_wrap()
        .items_start()
        .gap_3()
        .child(column(left.into_any_element()))
        .child(column(right.into_any_element()))
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

/// どれか1つを選ぶボタンの組（幅が足りなければ折り返す）。今の値が無い（分からない）ときは、どれも選ばない。
pub fn choices<T: Copy + PartialEq + 'static>(
    id: impl Into<SharedString>,
    lang: Lang,
    options: &[(T, &'static str)],
    current: Option<T>,
    on_pick: impl Fn(T, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let id: SharedString = id.into();
    let on_pick = Rc::new(on_pick);
    div()
        .flex()
        .flex_wrap()
        .gap_1()
        .children(options.iter().enumerate().map(|(index, (value, label))| {
            let value = *value;
            let on_pick = on_pick.clone();
            Button::new(SharedString::from(format!("{id}-{index}")))
                .outline()
                .label(core(lang, label))
                .selected(current == Some(value))
                .toggled(current == Some(value))
                .on_click(move |_, window, cx| on_pick(value, window, cx))
        }))
}
