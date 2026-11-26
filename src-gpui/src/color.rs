//! 色は `design/tokens.json`（`auralyn-core` が埋め込んで読む）の、選んでいるテーマから取る。値をここで書かない。

use std::sync::atomic::{AtomicU8, Ordering};

use auralyn_core::design::{tokens, Theme};
use gpui_kit::{linear_color_stop, linear_gradient, rgb, App, Background, Hsla};

/// 選んでいるテーマ（`Theme::ALL` の位置）。描くたびに読むので、変えたら窓を描き直す。
static THEME: AtomicU8 = AtomicU8::new(1);

pub fn theme() -> Theme {
    Theme::ALL[usize::from(THEME.load(Ordering::Relaxed))]
}

fn store(theme: Theme) {
    let index = match theme {
        Theme::Light => 0,
        Theme::Dark => 1,
        Theme::Gaming => 2,
    };
    THEME.store(index, Ordering::Relaxed);
}

/// テーマを替える。部品（gpui-kit）の明暗も合わせ、窓を描き直す。ゲーミングは暗い地。
pub fn set_theme(theme: Theme, cx: &mut App) {
    store(theme);
    let mode = match theme {
        Theme::Light => gpui_kit::component::ThemeMode::Light,
        Theme::Dark | Theme::Gaming => gpui_kit::component::ThemeMode::Dark,
    };
    gpui_kit::component::Theme::change(mode, None, cx);
    cx.refresh_windows();
}

fn token(name: &str) -> Hsla {
    let color = tokens()
        .color(name, theme())
        .unwrap_or_else(|| panic!("design/tokens.json に色 {name} がありません"));
    rgb(u32::from_be_bytes([0, color.r, color.g, color.b])).into()
}

pub fn background() -> Hsla {
    token("background")
}
pub fn card() -> Hsla {
    token("card")
}
pub fn foreground() -> Hsla {
    token("foreground")
}
pub fn muted() -> Hsla {
    token("muted-foreground")
}
pub fn border() -> Hsla {
    token("border")
}
pub fn track() -> Hsla {
    token("muted")
}
pub fn destructive_text() -> Hsla {
    token("destructive-text")
}
/// 緊急ミュート中の塗り。`destructive` は塗り専用（DESIGN.md 5.1）。
pub fn destructive_soft() -> Hsla {
    token("destructive").alpha(0.35)
}
pub fn warning() -> Hsla {
    token("warning")
}
pub fn meter_warning() -> Hsla {
    token("meter-warning")
}
pub fn meter_danger() -> Hsla {
    token("meter-danger")
}
pub fn success() -> Hsla {
    token("success")
}
pub fn aurora_green() -> Hsla {
    token("aurora-green")
}
pub fn aurora_teal() -> Hsla {
    token("aurora-teal")
}
pub fn primary() -> Hsla {
    token("primary")
}
/// 音の表示の塗り（DESIGN.md 10.7）。緑から青緑へ横に。メーターの正常域（`opacity` 1）と、音の流れの帯の加工後（0.95）に使う。
pub fn aurora_fill(opacity: f32) -> Background {
    linear_gradient(
        90.,
        linear_color_stop(aurora_green().opacity(opacity), 0.),
        linear_color_stop(aurora_teal().opacity(opacity), 1.),
    )
}

/// 角丸（px）。値は `design/tokens.json` の `radius` から取る。
pub fn radius(name: &str) -> f32 {
    tokens()
        .radius(name)
        .unwrap_or_else(|| panic!("design/tokens.json に角丸 {name} がありません"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_color_is_in_the_tokens_of_every_theme() {
        for theme in auralyn_core::design::Theme::ALL {
            super::store(theme);
            assert_eq!(super::theme(), theme);
            every_color_is_in_the_tokens();
        }
        super::store(auralyn_core::design::Theme::Dark);
    }

    fn every_color_is_in_the_tokens() {
        for color in [
            super::background,
            super::card,
            super::foreground,
            super::muted,
            super::border,
            super::track,
            super::destructive_text,
            super::destructive_soft,
            super::warning,
            super::meter_warning,
            super::meter_danger,
            super::success,
            super::aurora_green,
            super::aurora_teal,
            super::primary,
        ] {
            assert!(color().a > 0.0);
        }
        assert!(super::radius("card") > 0.0);
    }
}
