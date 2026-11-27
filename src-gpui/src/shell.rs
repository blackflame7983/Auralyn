//! 窓の外枠。左のレール（行き先）と、中央の先頭の帯（音声の状態と、開始・停止）。
//! Tauri 版の `AppRail.tsx`・`StatusBand.tsx` に当たる。ヘルプの入口と経過時間・経路の表示は、それぞれの画面を作るときに足す。

use std::rc::Rc;

use auralyn_ui_model::session::Phase;
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Disableable as _, Icon, Selectable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::i18n::{core, keys, Lang};
use crate::part::{REVEAL, REVEAL_RISE};

/// レールの幅（`AppRail.tsx` の `w-[76px]`）。
const RAIL_WIDTH: f32 = 76.;
/// レールの1項目の高さ（`h-14`）。
const RAIL_ITEM_HEIGHT: f32 = 56.;
/// 子の列の幅と、1項目の高さ。
const SUBNAV_WIDTH: f32 = 168.;
const SUBNAV_ITEM_HEIGHT: f32 = 34.;
/// 帯の高さ（`h-12`）。
const BAND_HEIGHT: f32 = 48.;

/// 行き先。並びはレールの上からの順。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Home,
    Sound,
    Vst,
    Connect,
    Settings,
}

impl Page {
    const ALL: [Page; 5] = [
        Page::Home,
        Page::Sound,
        Page::Vst,
        Page::Connect,
        Page::Settings,
    ];

    fn id(self) -> &'static str {
        match self {
            Page::Home => "rail-home",
            Page::Sound => "rail-sound",
            Page::Vst => "rail-vst",
            Page::Connect => "rail-connect",
            Page::Settings => "rail-settings",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Page::Home => IconName::House,
            Page::Sound => IconName::AudioLines,
            Page::Vst => IconName::Puzzle,
            Page::Connect => IconName::Cable,
            Page::Settings => IconName::Settings,
        }
    }

    /// レールに出す短い名前。
    pub fn label(self, lang: Lang) -> &'static str {
        core(
            lang,
            match self {
                Page::Home => keys::RAIL_HOME,
                Page::Sound => keys::RAIL_SOUND,
                Page::Vst => keys::RAIL_VST,
                Page::Connect => keys::RAIL_CONNECT,
                Page::Settings => keys::RAIL_SETTINGS,
            },
        )
    }

    /// 読み上げとツールチップの名前。接続だけ、短い名前では中身が伝わらないので補う。
    fn name(self, lang: Lang) -> &'static str {
        match self {
            Page::Connect => core(lang, keys::RAIL_CONNECT_NAME),
            page => page.label(lang),
        }
    }
}

/// 左のレール。窓の高さいっぱいで、縦にはスクロールしない。
pub fn rail(
    current: Page,
    lang: Lang,
    on_select: impl Fn(Page, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_select = Rc::new(on_select);
    div()
        .id("rail")
        .role(Role::Navigation)
        .aria_label(core(lang, keys::RAIL_LABEL))
        .w(px(RAIL_WIDTH))
        .flex_none()
        .h_full()
        .flex()
        .flex_col()
        .py_2()
        .px_1()
        .gap_1()
        .border_r_1()
        .border_color(color::border())
        .bg(color::card())
        .children(Page::ALL.map(|page| {
            let active = page == current;
            let on_select = on_select.clone();
            Button::new(page.id())
                .ghost()
                .selected(active)
                .accessibility_label(page.name(lang))
                .when(page.name(lang) != page.label(lang), |this| {
                    this.tooltip(page.name(lang))
                })
                .w_full()
                .h(px(RAIL_ITEM_HEIGHT))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap_0p5()
                        .text_xs()
                        .when(active, |this| this.font_weight(FontWeight::BOLD))
                        .text_color(if active {
                            color::foreground()
                        } else {
                            color::muted()
                        })
                        // 今の行き先は塗り・太字・アイコンの色で示す（色だけで伝えない）。
                        .child(
                            Icon::new(page.icon())
                                .size_6()
                                .when(active, |this| this.text_color(color::primary())),
                        )
                        .child(page.label(lang)),
                )
                .on_click(move |_, window, cx| on_select(page, window, cx))
        }))
}

/// 今の行き先の中の子（音づくり・設定）。名前は訳したもの。
pub struct Children {
    pub labels: Vec<&'static str>,
    pub selected: usize,
}

/// レールの右に出す、今の行き先の中の子の列。行き先を開くたびに横からふわっと出す（`epoch`）。
pub fn subnav(
    title: &'static str,
    children: Children,
    epoch: u64,
    on_child: impl Fn(usize, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let on_child = Rc::new(on_child);
    div()
        .id("subnav")
        .role(Role::Navigation)
        .aria_label(title)
        .w(px(SUBNAV_WIDTH))
        .flex_none()
        .h_full()
        .border_r_1()
        .border_color(color::border())
        .child(
            div()
                .flex()
                .flex_col()
                .gap_0p5()
                .px_2()
                .py_3()
                .child(
                    div()
                        .px_2()
                        .pb_2()
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(color::muted())
                        .child(title),
                )
                .children(
                    children
                        .labels
                        .into_iter()
                        .enumerate()
                        .map(|(index, label)| {
                            let chosen = index == children.selected;
                            let on_child = on_child.clone();
                            Button::new(("subnav", index))
                                .ghost()
                                .selected(chosen)
                                .accessibility_label(label)
                                .w_full()
                                .h(px(SUBNAV_ITEM_HEIGHT))
                                .child(
                                    div()
                                        .w_full()
                                        .truncate()
                                        .text_sm()
                                        .when(chosen, |this| {
                                            this.font_weight(FontWeight::SEMIBOLD)
                                                .text_color(color::foreground())
                                        })
                                        .when(!chosen, |this| this.text_color(color::muted()))
                                        .child(label),
                                )
                                .on_click(move |_, window, cx| on_child(index, window, cx))
                        }),
                )
                .with_animation(
                    ElementId::NamedInteger("subnav".into(), epoch),
                    Animation::new(REVEAL).with_easing(ease_out_quint()),
                    |this, delta| {
                        this.opacity(delta)
                            .relative()
                            .left(px(-REVEAL_RISE * (1. - delta)))
                    },
                ),
        )
}

/// 中央の先頭の帯。状態の札、歌・雑談や操作ロックの札、入出力の機器名（音が流れているときだけ渡す）、開始・停止のボタン。
/// ボタンは今の状態で決まる（未設定・停止中なら開始、実行中なら停止）。
pub fn band(
    phase: Phase,
    badges: Vec<SharedString>,
    route: Option<SharedString>,
    lang: Lang,
    on_press: impl Fn(&mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id("band")
        .role(Role::Region)
        .aria_label(core(lang, keys::BAND_LABEL))
        .h(px(BAND_HEIGHT))
        .flex_none()
        .flex()
        .items_center()
        .gap_3()
        .px_3()
        .border_b_1()
        .border_color(color::border())
        .child(status_chip(phase, lang))
        .children(badges.into_iter().map(badge))
        .child(
            div()
                .id("band-route")
                .flex_1()
                .min_w_0()
                .truncate()
                .text_sm()
                .text_color(color::muted())
                // 細い窓では切れるので、ツールチップで全部を出す。
                .when_some(route, |this, route| {
                    let full = route.clone();
                    this.child(route)
                        .tooltip(move |window, cx| Tooltip::new(full.clone()).build(window, cx))
                }),
        )
        .child(
            // 止まっているときの開始は主な操作なので目立たせる。止めるボタンは短い札にし、説明はツールチップへ。
            Button::new("band-control")
                .label(button_label(phase, lang))
                .when(phase.can_start(), |this| this.primary())
                .when(!phase.can_start(), |this| this.outline())
                .when(phase == Phase::Running, |this| {
                    this.tooltip(core(lang, keys::STOP))
                })
                .loading(phase.busy())
                .disabled(phase.busy())
                .on_click(move |_, window, cx| on_press(window, cx)),
        )
}

fn badge(text: SharedString) -> impl IntoElement {
    div()
        .flex_none()
        .px_2()
        .rounded_full()
        .border_1()
        .border_color(color::border())
        .text_xs()
        .child(text)
}

/// 状態の札。動いているかを、色の点と文字の両方で示す。
fn status_chip(phase: Phase, lang: Lang) -> impl IntoElement {
    let dot = match phase {
        Phase::Running => color::success(),
        Phase::Unconfigured => color::warning(),
        _ => color::muted(),
    };
    let text = core(
        lang,
        match phase {
            Phase::Unconfigured => keys::STATUS_UNCONFIGURED,
            Phase::Stopped => keys::STATUS_STOPPED,
            Phase::Starting => keys::STARTING,
            Phase::Running => keys::STATUS_RUNNING,
            Phase::Stopping => keys::STOPPING,
        },
    );
    div()
        .id("status")
        .role(Role::Status)
        .flex_none()
        .flex()
        .items_center()
        .gap_1p5()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .aria_label(text)
        .child(div().size_2().rounded_full().bg(dot))
        .child(text)
}

fn button_label(phase: Phase, lang: Lang) -> &'static str {
    core(
        lang,
        match phase {
            Phase::Unconfigured | Phase::Stopped => keys::START,
            Phase::Starting => keys::STARTING,
            Phase::Running => keys::STOP_SHORT,
            Phase::Stopping => keys::STOPPING,
        },
    )
}
