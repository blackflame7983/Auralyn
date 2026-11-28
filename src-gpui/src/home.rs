//! ホームの区画（DESIGN.md 10.5）。今は音の流れの帯だけ。

use auralyn_ui_model::flow::{Flow, Mode, Sample};
use auralyn_ui_model::meter;
use gpui_kit::assets::IconName;
use gpui_kit::component::Icon;
use gpui_kit::*;

use crate::color;
use crate::i18n::{core, keys, Lang};

/// 帯の波形の段の高さ。凡例の段（20px）と合わせて 72px（`SoundFlow.tsx`）。
const WAVE_HEIGHT: f32 = 52.;
/// 加工前の包絡線の太さと不透明度。凡例の線と揃える（#582）。
const BEFORE_LINE_WIDTH: f32 = 1.5;
const BEFORE_LINE_ALPHA: f32 = 0.7;
/// 加工後の塗りの不透明度（`soundFlowDraw.ts` の 0.95）。
const AFTER_ALPHA: f32 = 0.95;
/// 話し声のちょうど良い大きさの帯の不透明度。波形より目立たせない。
const BAND_ALPHA: f32 = 0.08;
/// 波形の片側の高さの上限（段の半分に対する割合）。
const WAVE_SPAN: f32 = 0.92;

/// 音の流れの帯。停止中と、まだ値が届いていないあいだは区画ごと出さない。
pub fn sound_flow(flow: &Flow, lang: Lang) -> Option<impl IntoElement> {
    let mode = flow.mode();
    if mode == Mode::Hidden {
        return None;
    }
    let samples: Vec<Sample> = flow.samples().collect();
    let title = core(lang, keys::FLOW_VOICE);
    Some(
        div()
            .id("sound-flow")
            .role(Role::Region)
            .aria_label(title)
            .flex()
            .flex_col()
            .gap_1()
            .px_4()
            .py_2()
            .rounded(px(color::radius("card")))
            .bg(color::card())
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x_2()
                    .child(Icon::new(IconName::AudioWaveform).text_color(color::primary()))
                    .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title)),
            )
            .child(
                div()
                    .id("sound-flow-graph")
                    .role(Role::Image)
                    .aria_label(core(lang, keys::FLOW_GRAPH))
                    .w_full()
                    .h(px(WAVE_HEIGHT))
                    .child(
                        canvas(
                            |_, _, _| {},
                            move |bounds, _, window, _| paint_wave(bounds, &samples, mode, window),
                        )
                        .size_full(),
                    ),
            )
            .child(legend(lang)),
    )
}

fn legend(lang: Lang) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_3()
        .h(px(20.))
        .text_xs()
        .text_color(color::muted())
        .child(
            div()
                .flex()
                .items_center()
                .gap_1p5()
                .child(
                    div()
                        .w(px(16.))
                        .h(px(BEFORE_LINE_WIDTH))
                        .bg(color::foreground().opacity(BEFORE_LINE_ALPHA)),
                )
                .child(core(lang, keys::FLOW_BEFORE)),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap_1p5()
                .child(
                    div()
                        .w(px(16.))
                        .h(px(8.))
                        .rounded_full()
                        .bg(color::aurora_fill(AFTER_ALPHA)),
                )
                .child(core(lang, keys::FLOW_AFTER)),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap_1p5()
                .child(
                    div()
                        .w(px(16.))
                        .h(px(8.))
                        .bg(color::primary().opacity(BAND_ALPHA * 2.)),
                )
                .child(core(lang, keys::FLOW_COMFORT)),
        )
}

/// 加工後をオーロラ色で塗り、その上に加工前の上下の包絡を線で重ねる（`soundFlowDraw.ts` の `drawFlowWave`）。
/// 塗りは横の緑→青緑で、Tauri 版の縦の青緑→緑→青緑とは違う（GPUI の `linear_gradient` は2色まで。docs/gpui/decisions.md）。
/// サンプルが1つのときは、加工後を長方形、加工前を横の直線2本にする。
fn paint_wave(bounds: Bounds<Pixels>, samples: &[Sample], mode: Mode, window: &mut Window) {
    let Some(first) = samples.first() else {
        return;
    };
    let width = bounds.size.width;
    let mid = bounds.size.height / 2.;
    let center = bounds.origin.y + mid;
    let n = samples.len();
    let x_at = |i: usize| {
        let step = if n <= 1 {
            width
        } else {
            width / (n - 1) as f32
        };
        bounds.origin.x + step * i as f32
    };
    let y_at = |level: f32, sign: f32| center + mid * (sign * meter::position(level) * WAVE_SPAN);
    let points = |pick: fn(&Sample) -> f32, sign: f32| -> Vec<Point<Pixels>> {
        if n == 1 {
            let y = y_at(pick(first), sign);
            vec![point(bounds.origin.x, y), point(bounds.origin.x + width, y)]
        } else {
            samples
                .iter()
                .enumerate()
                .map(|(i, s)| point(x_at(i), y_at(pick(s), sign)))
                .collect()
        }
    };
    let after = |s: &Sample| s.after;
    let before = |s: &Sample| s.before;
    window.with_content_mask(Some(ContentMask { bounds }), |window| {
        let (low, high) = meter::comfortable_band();
        for sign in [-1., 1.] {
            let edges = [low, high].map(|at| center + mid * (sign * at * WAVE_SPAN));
            let top = edges[0].min(edges[1]);
            window.paint_quad(fill(
                Bounds::new(
                    point(bounds.origin.x, top),
                    size(width, (edges[0] - edges[1]).abs()),
                ),
                color::primary().opacity(BAND_ALPHA),
            ));
        }
        let mut fill = PathBuilder::fill();
        let mut outline = points(after, -1.);
        outline.extend(points(after, 1.).into_iter().rev());
        fill.add_polygon(&outline, true);
        if let Ok(path) = fill.build() {
            window.paint_path(path, color::aurora_fill(AFTER_ALPHA));
        }
        for sign in [-1., 1.] {
            let mut line = PathBuilder::stroke(px(BEFORE_LINE_WIDTH));
            line.add_polygon(&points(before, sign), false);
            if let Ok(path) = line.build() {
                window.paint_path(path, color::foreground().opacity(BEFORE_LINE_ALPHA));
            }
        }
        if mode == Mode::Flowing {
            window.paint_quad(fill_quad(bounds));
        }
    });
}

/// 右端の今の位置の線。
fn fill_quad(bounds: Bounds<Pixels>) -> PaintQuad {
    fill(
        Bounds::new(
            point(
                bounds.origin.x + bounds.size.width - px(1.),
                bounds.origin.y,
            ),
            size(px(1.), bounds.size.height),
        ),
        color::foreground(),
    )
}
