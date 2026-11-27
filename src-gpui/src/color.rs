//! 色は `design/tokens.json`（`auralyn-core` が埋め込んで読む）の、選んでいるテーマから取る。値をここで書かない。

use std::sync::atomic::{AtomicUsize, Ordering};

use auralyn_core::design::{tokens, Theme};
use gpui_kit::component::ThemeColor;
use gpui_kit::{linear_color_stop, linear_gradient, px, rgb, App, Background, Hsla};

/// 選んでいるテーマ（`Theme::ALL` の位置）。描くたびに読むので、変えたら窓を描き直す。
static THEME: AtomicUsize = AtomicUsize::new(1);

pub fn theme() -> Theme {
    Theme::ALL[THEME.load(Ordering::Relaxed)]
}

fn store(theme: Theme) {
    let index = Theme::ALL.iter().position(|t| *t == theme).unwrap_or(1);
    THEME.store(index, Ordering::Relaxed);
}

/// テーマを替える。部品（gpui-kit）の明暗・色・角丸も合わせ、窓を描き直す（`Theme::update` が描き直す）。ゲーミングは暗い地。
pub fn set_theme(theme: Theme, cx: &mut App) {
    store(theme);
    let mode = match theme {
        Theme::Light => gpui_kit::component::ThemeMode::Light,
        Theme::Dark | Theme::Gaming => gpui_kit::component::ThemeMode::Dark,
    };
    gpui_kit::component::Theme::change(mode, None, cx);
    gpui_kit::component::Theme::update(cx, |kit| {
        paint_parts(&mut kit.colors);
        kit.radius = px(radius("control"));
        kit.radius_lg = px(radius("lg"));
    });
}

/// 部品（gpui-kit）の色も同じトークンから塗る。既定の灰色・青のままだと、選んだ印やスイッチにブランドの色が出ない。
fn paint_parts(kit: &mut ThemeColor) {
    let primary = primary();
    let tint = primary.opacity(0.16);
    let destructive = token("destructive");
    kit.background = background();
    kit.foreground = foreground();
    kit.border = border();
    kit.window_border = border();
    // 部品は input を枠だけでなく欄の地（30%）にも使うので、枠の色を渡す（Tauri 版の欄の地は background）。
    kit.input = border();
    kit.ring = token("ring");
    kit.caret = primary;
    kit.selection = primary.opacity(0.35);
    kit.popover = token("popover");
    kit.popover_foreground = token("popover-foreground");
    kit.group_box = card();
    kit.group_box_foreground = foreground();
    kit.muted = track();
    kit.muted_foreground = muted();
    kit.accent = token("accent");
    kit.accent_foreground = token("accent-foreground");
    kit.secondary = token("secondary");
    kit.secondary_foreground = token("secondary-foreground");
    kit.secondary_hover = token("accent");
    kit.button_active = token("accent");
    kit.secondary_active = tint;
    kit.list_active = tint;
    kit.link = primary;
    kit.link_hover = primary.opacity(0.85);
    kit.link_active = primary.opacity(0.7);
    kit.slider_bar = primary;
    kit.progress_bar = primary;
    kit.switch = token("input").opacity(0.55);
    // 暗い地では、地と同じ色のつまみが OFF の溝に沈むので、文字の色にする。
    kit.switch_thumb = foreground();
    for (fill, text, hover, active, color, on) in [
        (
            &mut kit.primary,
            &mut kit.primary_foreground,
            &mut kit.primary_hover,
            &mut kit.primary_active,
            primary,
            token("primary-foreground"),
        ),
        (
            &mut kit.button_primary,
            &mut kit.button_primary_foreground,
            &mut kit.button_primary_hover,
            &mut kit.button_primary_active,
            primary,
            token("primary-foreground"),
        ),
        (
            &mut kit.danger,
            &mut kit.danger_foreground,
            &mut kit.danger_hover,
            &mut kit.danger_active,
            destructive,
            token("destructive-foreground"),
        ),
        (
            &mut kit.button_danger,
            &mut kit.button_danger_foreground,
            &mut kit.button_danger_hover,
            &mut kit.button_danger_active,
            destructive,
            token("destructive-foreground"),
        ),
        (
            &mut kit.warning,
            &mut kit.warning_foreground,
            &mut kit.warning_hover,
            &mut kit.warning_active,
            warning(),
            token("warning-foreground"),
        ),
        (
            &mut kit.success,
            &mut kit.success_foreground,
            &mut kit.success_hover,
            &mut kit.success_active,
            success(),
            token("success-foreground"),
        ),
        (
            &mut kit.info,
            &mut kit.info_foreground,
            &mut kit.info_hover,
            &mut kit.info_active,
            token("info"),
            token("info-foreground"),
        ),
    ] {
        *fill = color;
        *text = on;
        *hover = color.opacity(0.88);
        *active = color.opacity(0.76);
    }
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
        super::paint_parts(&mut gpui_kit::component::ThemeColor::default());
        assert!(super::radius("control") > 0.0 && super::radius("lg") > 0.0);
    }
}
