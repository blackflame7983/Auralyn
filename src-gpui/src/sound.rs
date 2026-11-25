//! 音づくりの画面：ノイズ低減（ON/OFF・弱／強・抑制の強さ・声を守る）と「声を整える」（ON/OFF・種類・整え具合）。
//! 値の読み方は `auralyn-ui-model` の `sound`。変えるたびにエンジンへ送り、エンジンが受け付けた結果で描き直す。
//! 測定・歯擦音・ピーク保護・歌向け・本番モードは、まだこの画面に無い。

use auralyn_ui_model::sound::{self, Change, NoiseMode, Preset, Sound};
use gpui_kit::component::button::{Button, ButtonGroup};
use gpui_kit::component::slider::{Slider, SliderState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Selectable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, core_with, keys, Lang};
use crate::vst::Send;

const NOISE_MODES: [(NoiseMode, &str); 2] = [
    (NoiseMode::Low, keys::NOISE_LOW),
    (NoiseMode::High, keys::NOISE_HIGH),
];
const PRESETS: [(Preset, &str); 3] = [
    (Preset::Broadcast, keys::PRESET_BROADCAST),
    (Preset::Warm, keys::PRESET_WARM),
    (Preset::Bright, keys::PRESET_BRIGHT),
];

pub struct SoundPage {
    /// エンジンから読んだ今の設定。まだ読めていなければ `None`（操作させない）。
    current: Option<Sound>,
    /// 整え具合（0〜100）。離したときに送る（`MainView` が購読する）。
    pub amount: Entity<SliderState>,
    /// 抑制の強さ（25〜125）。離したときに送る。
    pub strength: Entity<SliderState>,
}

impl SoundPage {
    pub fn new<V: 'static>(cx: &mut Context<V>) -> Self {
        Self {
            current: None,
            amount: cx.new(|_| SliderState::new().min(0.).max(100.).step(1.)),
            strength: cx.new(|_| SliderState::new().min(25.).max(125.).step(5.)),
        }
    }

    pub fn set(&mut self, sound: Sound, window: &mut Window, cx: &mut App) {
        self.current = Some(sound);
        self.amount.update(cx, |state, cx| {
            state.set_value(sound::percent(sound.amount), window, cx)
        });
        self.strength.update(cx, |state, cx| {
            state.set_value(sound::strength_percent(sound.strength), window, cx)
        });
    }

    pub fn render(&self, lang: Lang, send: Send) -> impl IntoElement {
        let Some(current) = self.current else {
            return div()
                .text_sm()
                .text_color(color::muted())
                .child(core(lang, keys::SOUND_UNREAD));
        };
        let set = move |change: Change, cx: &mut App| send(Command::SetSound(change), cx);
        div()
            .flex()
            .flex_col()
            .gap_6()
            .max_w(px(560.))
            .child(
                div()
                    .text_sm()
                    .text_color(color::muted())
                    .child(core(lang, keys::OFF_UNTIL_ON)),
            )
            .child(section(
                lang,
                keys::NOISE,
                keys::NOISE_LEAD,
                Switch::new("noise-on")
                    .checked(current.noise_on)
                    .accessibility_label(core(lang, keys::NOISE))
                    .on_click({
                        let set = set.clone();
                        move |on, _, cx| set(Change::NoiseOn(*on), cx)
                    }),
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(choices(
                        "noise-mode",
                        lang,
                        &NOISE_MODES,
                        current.noise_mode,
                        {
                            let set = set.clone();
                            move |mode, cx| set(Change::NoiseMode(mode), cx)
                        },
                    ))
                    .when_some(
                        current.noise_mode.and_then(|mode| match mode {
                            NoiseMode::Measured => Some(keys::NOISE_MEASURED),
                            NoiseMode::Venue => Some(keys::NOISE_VENUE),
                            NoiseMode::Low | NoiseMode::High => None,
                        }),
                        |this, mode| {
                            this.child(note(core_with(
                                lang,
                                keys::NOISE_ADVANCED,
                                &[("mode", &core(lang, mode))],
                            )))
                        },
                    )
                    .child(note(core(lang, keys::NOISE_MIX)))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_2()
                            .pt_3()
                            .border_t_1()
                            .border_color(color::border())
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(core(lang, keys::NOISE_DETAILS)),
                            )
                            .child(slider_row(
                                lang,
                                keys::STRENGTH,
                                keys::STRENGTH_NAMED,
                                &self.strength,
                                sound::strength_percent(current.strength),
                            ))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .gap_3()
                                    .child(div().text_sm().child(core(lang, keys::VOICE_GUARD)))
                                    .child(
                                        Switch::new("voice-guard")
                                            .checked(current.voice_guard)
                                            .accessibility_label(core(lang, keys::VOICE_GUARD))
                                            .on_click({
                                                let set = set.clone();
                                                move |on, _, cx| set(Change::VoiceGuard(*on), cx)
                                            }),
                                    ),
                            )
                            .child(note(core(lang, keys::VOICE_GUARD_MEANS))),
                    ),
            ))
            .child(section(
                lang,
                keys::EFFECTS,
                keys::EFFECTS_LEAD,
                Switch::new("effects-on")
                    .checked(current.effects_on)
                    .accessibility_label(core(lang, keys::EFFECTS))
                    .disabled(!current.effects_editable())
                    .on_click({
                        let set = set.clone();
                        move |on, _, cx| set(Change::EffectsOn(*on), cx)
                    }),
                if current.effects_editable() {
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(choices(
                            "effects-preset",
                            lang,
                            &PRESETS,
                            current.preset,
                            move |preset, cx| set(Change::Preset(preset), cx),
                        ))
                        .child(slider_row(
                            lang,
                            keys::EFFECTS_AMOUNT,
                            keys::EFFECTS_AMOUNT,
                            &self.amount,
                            sound::percent(current.amount),
                        ))
                        .child(note(core(lang, keys::EFFECTS_AMOUNT_MEANS)))
                } else {
                    div().child(note(core(lang, keys::SINGING_NOT_YET)))
                },
            ))
    }
}

/// 見出し（と右の ON/OFF）・説明・中身の区画。
fn section(
    lang: Lang,
    title: &'static str,
    lead: &'static str,
    switch: Switch,
    body: impl IntoElement,
) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_2()
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
                        .child(core(lang, title)),
                )
                .child(switch),
        )
        .child(note(core(lang, lead)))
        .child(body)
}

/// 名前・スライダー・百分率の1行。`named` は読み上げの名前。
fn slider_row(
    lang: Lang,
    label: &'static str,
    named: &'static str,
    state: &Entity<SliderState>,
    percent: f32,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_3()
        .child(div().flex_none().text_sm().child(core(lang, label)))
        .child(
            div().flex_1().child(
                Slider::new(state)
                    .horizontal()
                    .accessibility_label(core(lang, named)),
            ),
        )
        .child(
            div()
                .flex_none()
                .w(px(48.))
                .text_sm()
                .child(format!("{percent}%")),
        )
}

/// どれか1つを選ぶボタンの組。今の値が無い（分からない）ときは、どれも選ばない。
fn choices<T: Copy + PartialEq + 'static>(
    id: &'static str,
    lang: Lang,
    options: &[(T, &'static str)],
    current: Option<T>,
    on_pick: impl Fn(T, &mut App) + 'static,
) -> impl IntoElement {
    let values: Vec<T> = options.iter().map(|(value, _)| *value).collect();
    ButtonGroup::new(id)
        .outline()
        .children(options.iter().enumerate().map(|(index, (value, label))| {
            Button::new(SharedString::from(format!("{id}-{index}")))
                .label(core(lang, label))
                .selected(current == Some(*value))
        }))
        .on_click(move |clicked, _, cx| {
            if let Some(value) = clicked.first().and_then(|index| values.get(*index)) {
                on_pick(*value, cx);
            }
        })
}

fn note(text: impl Into<SharedString>) -> impl IntoElement {
    div()
        .text_sm()
        .text_color(color::muted())
        .child(text.into())
}
