//! 窓の外枠。左のレール（行き先）と、中央の先頭の帯（音声の状態と、開始・停止）。
//! Tauri 版の `AppRail.tsx`・`StatusBand.tsx` に当たる。ヘルプの入口と経過時間・経路の表示は、それぞれの画面を作るときに足す。

use std::rc::Rc;

use auralyn_ui_model::session::Phase;
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::empty::{Empty, EmptyDescription, EmptyHeader, EmptyTitle};
use gpui_kit::component::{Disableable as _, Icon, Selectable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::i18n::{core, keys, Lang};

/// レールの幅（`AppRail.tsx` の `w-[76px]`）。
const RAIL_WIDTH: f32 = 76.;
/// レールの1項目の高さ（`h-14`）。
const RAIL_ITEM_HEIGHT: f32 = 56.;
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
                .rounded_none()
                // 今の行き先は左の縦線でも示す（選択の色だけで伝えない）。
                .border_l_2()
                .border_color(if active {
                    color::primary()
                } else {
                    gpui_kit::transparent_black()
                })
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
                        .child(Icon::new(page.icon()).size_6())
                        .child(page.label(lang)),
                )
                .on_click(move |_, window, cx| on_select(page, window, cx))
        }))
}

/// 中央の先頭の帯。状態の札、入出力の機器名（音が流れているときだけ渡す）、開始・停止のボタン。
/// ボタンは今の状態で決まる（未設定なら接続の設定へ、停止中なら開始、実行中なら停止）。
pub fn band(
    phase: Phase,
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
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_sm()
                .text_color(color::muted())
                .children(route),
        )
        .child(
            Button::new("band-control")
                .label(button_label(phase, lang))
                .outline()
                .loading(phase.busy())
                .disabled(phase.busy())
                .on_click(move |_, window, cx| on_press(window, cx)),
        )
}

/// 状態の札。動いているかを、色の点と文字の両方で示す。
fn status_chip(phase: Phase, lang: Lang) -> impl IntoElement {
    let dot = match phase {
        Phase::Running => color::success(),
        Phase::Unconfigured => color::warning(),
        _ => color::muted(),
    };
    div()
        .id("status")
        .role(Role::Status)
        .flex_none()
        .flex()
        .items_center()
        .gap_1p5()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .child(div().size_2().rounded_full().bg(dot))
        .child(core(
            lang,
            match phase {
                Phase::Unconfigured => keys::STATUS_UNCONFIGURED,
                Phase::Stopped => keys::STATUS_STOPPED,
                Phase::Starting => keys::STARTING,
                Phase::Running => keys::STATUS_RUNNING,
                Phase::Stopping => keys::STOPPING,
            },
        ))
}

fn button_label(phase: Phase, lang: Lang) -> &'static str {
    core(
        lang,
        match phase {
            Phase::Unconfigured => keys::CONFIGURE,
            Phase::Stopped => keys::START,
            Phase::Starting => keys::STARTING,
            Phase::Running => keys::STOP,
            Phase::Stopping => keys::STOPPING,
        },
    )
}

/// まだ GPUI 版に無い画面。行き先の名前と、今までの版で設定するよう伝える。
pub fn not_yet(page: Page, lang: Lang) -> impl IntoElement {
    Empty::new().header(
        EmptyHeader::new()
            .title(EmptyTitle::new().child(page.name(lang)))
            .description(EmptyDescription::new().child(core(lang, keys::NOT_YET))),
    )
}
