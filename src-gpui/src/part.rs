//! 画面どうしで同じ形の部品：見出しつきの区画と、補足の文、ファイルの窓。画面からエンジンへの命令の送り口。

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, Selectable as _, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, keys, Lang};

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
    hint: Option<(Lang, SharedString)>,
    trailing: Option<AnyElement>,
    fold: Option<Fold>,
    body: AnyElement,
}

/// 区画を畳んでいるか。区画を持つ画面が覚え、見出しの ∨/∧ で切り替える。
/// `opened` は開いた回数で、開くたびに中身をふわっと出すのに使う。
#[derive(Clone, Default)]
pub struct Fold {
    open: Rc<Cell<bool>>,
    opened: Rc<Cell<u64>>,
}

impl Fold {
    pub fn is_open(&self) -> bool {
        self.open.get()
    }

    pub fn set(&self, open: bool) {
        if open && !self.open.get() {
            self.opened.set(self.opened.get() + 1);
        }
        self.open.set(open);
    }
}

/// 開いた区画の中身が出てくる時間と、下から上がる量。画面を開いたときも同じ動きにする。
pub const REVEAL: Duration = Duration::from_millis(220);
pub const REVEAL_RISE: f32 = 8.;

/// 画面の中で切り替わる部分（入力の種類・開いた欄）の動き。画面を開くときより短く、小さくする。
const SHIFT: Duration = Duration::from_millis(160);
const SHIFT_RISE: f32 = 4.;

/// 中身を下からふわっと出す。`id` が変わるたびに動き直す。
pub fn reveal<E: IntoElement + Styled + 'static>(id: ElementId, element: E) -> impl IntoElement {
    rise(id, element, REVEAL, REVEAL_RISE)
}

/// 画面の中で切り替わった部分を、控えめにふわっと出す。`id` に今の選択を含めると、選び直すたびに動く。
pub fn shift<E: IntoElement + Styled + 'static>(id: ElementId, element: E) -> impl IntoElement {
    rise(id, element, SHIFT, SHIFT_RISE)
}

fn rise<E: IntoElement + Styled + 'static>(
    id: ElementId,
    element: E,
    duration: Duration,
    distance: f32,
) -> impl IntoElement {
    element.with_animation(
        id,
        Animation::new(duration).with_easing(ease_out_quint()),
        move |this, delta| {
            this.opacity(delta)
                .relative()
                .top(px(distance * (1. - delta)))
        },
    )
}

impl Card {
    pub fn new(title: &'static str, body: impl IntoElement) -> Self {
        Self {
            icon: None,
            title,
            hint: None,
            trailing: None,
            fold: None,
            body: body.into_any_element(),
        }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// 見出しの横の ⓘ に出す説明（画面には文を並べない）。
    pub fn hint(mut self, lang: Lang, text: impl Into<SharedString>) -> Self {
        self.hint = Some((lang, text.into()));
        self
    }

    /// 見出しの ∨/∧ で中身を畳めるようにする。畳んでいる間も見出しと右の部品は出す。
    /// `attention`（注意・失敗が出ている）の間は畳まずに開いたままにし、∨/∧ も出さない。
    pub fn fold(mut self, fold: &Fold, attention: bool) -> Self {
        self.fold = (!attention).then(|| fold.clone());
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
            .rounded(px(color::radius("card")))
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
                            .flex_none()
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
                                    .aria_label(title)
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(title),
                            )
                            .when_some(self.hint, |this, (lang, text)| {
                                this.child(hint(format!("{title}-hint"), lang, text))
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .children(self.trailing)
                            .min_w_0()
                            .when_some(self.fold.clone(), |this, fold| {
                                let open = fold.is_open();
                                this.child(
                                    Button::new(SharedString::from(format!("{title}-fold")))
                                        .ghost()
                                        .xsmall()
                                        .icon(if open {
                                            IconName::ChevronUp
                                        } else {
                                            IconName::ChevronDown
                                        })
                                        .accessibility_label(title)
                                        .aria_expanded(open)
                                        .on_click(move |_, window, _| {
                                            fold.set(!fold.is_open());
                                            window.refresh();
                                        }),
                                )
                            }),
                    ),
            )
            .map(|this| match &self.fold {
                None => this.child(self.body),
                Some(fold) if fold.is_open() => this.child(reveal(
                    ElementId::NamedInteger(
                        SharedString::from(format!("{title}-body")),
                        fold.opened.get(),
                    ),
                    div().child(self.body),
                )),
                Some(_) => this,
            })
    }
}

/// 補足の説明。文を画面に並べず、ⓘ を押す（Enter・Space でも）と小さな窓に出す。
pub fn hint(
    id: impl Into<SharedString>,
    lang: Lang,
    text: impl Into<SharedString>,
) -> impl IntoElement {
    let id = id.into();
    let text = text.into();
    Popover::new(id.clone())
        .trigger(
            Button::new(SharedString::from(format!("{id}-button")))
                .ghost()
                .xsmall()
                .icon(IconName::Info)
                .accessibility_label(core(lang, keys::HELP_MORE)),
        )
        .child(div().max_w(px(HINT_WIDTH)).text_sm().child(text))
}

/// 項目名などの後ろに ⓘ を置いた行。
pub fn with_hint(
    id: impl Into<SharedString>,
    lang: Lang,
    text: impl Into<SharedString>,
    label: impl IntoElement,
) -> Div {
    div()
        .flex()
        .items_center()
        .gap_1()
        .child(label)
        .child(hint(id, lang, text))
}

/// ⓘ に出す説明をつなげる（段落の間は空行）。
pub fn paragraphs(lang: Lang, keys: &[&'static str]) -> String {
    keys.iter()
        .map(|key| core(lang, key))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// ⓘ の窓の幅の上限。長い説明も窓に収まるよう折り返す。
const HINT_WIDTH: f32 = 320.;

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

/// ボタンと、押せないときの理由（何をすれば押せるか）。理由はボタンの横に1行で出し、収まらなければ省いて全文をツールチップに出す（下の行を押し下げない）。
pub fn action<R: Into<SharedString>>(
    button: impl IntoElement,
    reason: Option<R>,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_3()
        .child(div().flex_none().child(button))
        .when_some(reason, |this, reason| {
            let reason: SharedString = reason.into();
            this.child(
                div()
                    .id(ElementId::Name(reason.clone()))
                    .flex_1()
                    .min_w_0()
                    .text_sm()
                    .text_color(color::muted())
                    .truncate()
                    .tooltip({
                        let reason = reason.clone();
                        move |window, cx| Tooltip::new(reason.clone()).build(window, cx)
                    })
                    .child(reason),
            )
        })
}
