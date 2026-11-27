//! 音づくりの画面：ノイズ低減（ON/OFF・弱／強・抑制の強さ・声を守る）と「声を整える」（ON/OFF・種類・整え具合、歌向けは3つの値）と残響と歯擦音の抑制。
//! 値の読み方は `auralyn-ui-model` の `sound`。変えるたびにエンジンへ送り、エンジンが受け付けた結果で描き直す。
//! 「大きな音を抑える」と「配信用 true-peak 制限」は `limiter`。周囲の音の測定は `measure`。

use auralyn_ui_model::peak::Limit;
use auralyn_ui_model::sound::{self, Change, Knob, NoiseMode, Preset, Sound};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::slider::{Slider, SliderState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, core_with, keys, Lang};
use crate::limiter::LimiterPanel;
use crate::measure::MeasurePanel;
use crate::part::{choices, note, paragraphs, with_hint, Card, Fold, OnCommand};

const NOISE_MODES: [(NoiseMode, &str); 2] = [
    (NoiseMode::Low, keys::NOISE_LOW),
    (NoiseMode::High, keys::NOISE_HIGH),
];
const ADAPTIVE_MODES: [(NoiseMode, &str); 2] = [
    (NoiseMode::Measured, keys::NOISE_MEASURED),
    (NoiseMode::Venue, keys::NOISE_VENUE),
];
const PRESETS: [(Preset, &str); 4] = [
    (Preset::Broadcast, keys::PRESET_BROADCAST),
    (Preset::Warm, keys::PRESET_WARM),
    (Preset::Bright, keys::PRESET_BRIGHT),
    (Preset::Singing, keys::SINGING_PRESET),
];

/// 音づくりの中の行き先（左のレールの子）。1つずつ1画面に出す。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Part {
    #[default]
    Noise,
    Voice,
    Peak,
    Modes,
    Check,
}

impl Part {
    pub const ALL: [Part; 5] = [
        Part::Noise,
        Part::Voice,
        Part::Peak,
        Part::Modes,
        Part::Check,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Part::Noise => keys::NOISE,
            Part::Voice => keys::EFFECTS,
            Part::Peak => keys::PEAK_TITLE,
            Part::Modes => keys::MODES_TITLE,
            Part::Check => keys::VOICE_TITLE,
        }
    }
}

pub struct SoundPage {
    /// エンジンから読んだ今の設定。まだ読めていなければ `None`（操作させない）。
    current: Option<Sound>,
    /// 整え具合（0〜100）。離したときに送る（`MainView` が購読する）。
    pub amount: Entity<SliderState>,
    /// 抑制の強さ（25〜125）。離したときに送る。
    pub strength: Entity<SliderState>,
    /// 歌向け・残響・歯擦音のスライダー（`Knob::ALL` の順）。離したときに送る。
    pub knobs: [Entity<SliderState>; 7],
    /// 大きな音を抑える（ピーク保護）と、配信用 true-peak 制限。
    pub peak: LimiterPanel,
    pub true_peak: LimiterPanel,
    /// 周囲の音の測定。
    pub measure: MeasurePanel,
    /// 残響と歯擦音の区画は、普段は畳んで ON/OFF だけを出す。
    reverb_fold: Fold,
    deesser_fold: Fold,
}

impl SoundPage {
    pub fn new<V: 'static>(cx: &mut Context<V>) -> Self {
        Self {
            current: None,
            amount: cx.new(|_| SliderState::new().min(0.).max(100.).step(1.)),
            strength: cx.new(|_| SliderState::new().min(25.).max(125.).step(5.)),
            knobs: Knob::ALL.map(|knob| range(cx, knob.range())),
            peak: LimiterPanel::new(Limit::Sample, cx),
            true_peak: LimiterPanel::new(Limit::TruePeak, cx),
            measure: MeasurePanel::default(),
            reverb_fold: Fold::default(),
            deesser_fold: Fold::default(),
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
        for (knob, slider) in Knob::ALL.iter().zip(&self.knobs) {
            slider.update(cx, |state, cx| {
                state.set_value(knob.shown(&sound), window, cx)
            });
        }
    }

    /// つまみの1行。
    fn knob(&self, knob: Knob, lang: Lang, cx: &App) -> impl IntoElement {
        let (label, named, show): (&'static str, Option<&'static str>, fn(f32) -> String) =
            match knob {
                Knob::LowCut => (keys::SINGING_LOW_CUT, None, whole),
                Knob::Dynamics => (keys::SINGING_DYNAMICS, None, whole),
                Knob::Brightness => (keys::SINGING_BRIGHTNESS, None, tenth),
                Knob::ReverbMix => (keys::REVERB_MIX, None, whole),
                Knob::ReverbDecay => (keys::REVERB_DECAY, None, tenth),
                Knob::ReverbDamping => (keys::REVERB_DAMPING, None, whole),
                Knob::DeEsser => (keys::DEESSER_AMOUNT, Some(keys::DEESSER), percent),
            };
        let name = match named {
            Some(card) => format!("{} {}", core(lang, card), core(lang, label)),
            None => core(lang, label).to_owned(),
        };
        // `knobs` は `Knob::ALL` の順（宣言の順と同じ）。
        slider_row(
            lang,
            label,
            name,
            &self.knobs[knob as usize],
            show,
            false,
            cx,
        )
    }

    pub fn limiter(&mut self, limit: Limit) -> &mut LimiterPanel {
        match limit {
            Limit::Sample => &mut self.peak,
            Limit::TruePeak => &mut self.true_peak,
        }
    }

    /// 測定の欄を出しているか（ノイズ低減が測定値・会場のとき）。出している間は 500ms ごとに読み直す。
    /// 測定は、音量・チャンネルの変更や期限でも古くなるので、測っている間だけ読むのでは足りない。
    pub fn shows_measurement(&self) -> bool {
        self.current.is_some_and(|sound| {
            matches!(
                sound.noise_mode,
                Some(NoiseMode::Measured | NoiseMode::Venue)
            )
        })
    }

    /// ホームに置く日常の音調整：ノイズ低減と声を整えるの ON/OFF と今の種類。細かい調整は音づくりへ（`on_open`）。
    /// まだ読めていなければ出さない。
    pub fn render_quick(
        &self,
        lang: Lang,
        send: OnCommand,
        on_open: impl Fn(Part, &mut Window, &mut App) + 'static,
    ) -> Option<Card> {
        let current = self.current?;
        let on_open = std::rc::Rc::new(on_open);
        let set = move |change: Change, cx: &mut App| send(Command::SetSound(change), cx);
        let noise_kind = current.noise_mode.map(|mode| {
            core(
                lang,
                match mode {
                    NoiseMode::Low => keys::NOISE_LOW,
                    NoiseMode::High => keys::NOISE_HIGH,
                    NoiseMode::Measured => keys::NOISE_MEASURED,
                    NoiseMode::Venue => keys::NOISE_VENUE,
                },
            )
        });
        let preset = current.preset.and_then(|preset| {
            PRESETS
                .iter()
                .find(|(p, _)| *p == preset)
                .map(|(_, key)| core(lang, key))
        });
        let row = |id: &'static str,
                   icon: IconName,
                   title: &'static str,
                   kind: Option<&'static str>,
                   part: Part,
                   switch: Switch| {
            let on_open = on_open.clone();
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(Icon::new(icon).text_color(color::primary()))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().text_sm().font_weight(FontWeight::MEDIUM).child(title))
                        .when_some(kind, |this, kind| {
                            this.child(
                                div()
                                    .text_xs()
                                    .text_color(color::muted())
                                    .truncate()
                                    .child(kind),
                            )
                        }),
                )
                .child(switch)
                .child(
                    Button::new(SharedString::from(format!("{id}-open")))
                        .icon(IconName::ChevronRight)
                        .ghost()
                        .small()
                        .tooltip(core_with(lang, keys::QUICK_ADJUST, &[("name", &title)]))
                        .accessibility_label(core_with(
                            lang,
                            keys::QUICK_ADJUST,
                            &[("name", &title)],
                        ))
                        .on_click(move |_, window, cx| on_open(part, window, cx)),
                )
        };
        let noise = core(lang, keys::NOISE);
        let effects = core(lang, keys::EFFECTS);
        Some(
            Card::new(
                core(lang, keys::SHELL_SOUND),
                div()
                    .flex()
                    .flex_col()
                    .gap_3()
                    .child(row(
                        "quick-noise",
                        IconName::Wind,
                        noise,
                        noise_kind,
                        Part::Noise,
                        Switch::new("quick-noise-on")
                            .checked(current.noise_on)
                            .accessibility_label(noise)
                            .disabled(current.noise_mode.is_none())
                            .on_click({
                                let set = set.clone();
                                move |on, _, cx| set(Change::NoiseOn(*on), cx)
                            }),
                    ))
                    .child(row(
                        "quick-effects",
                        IconName::WandSparkles,
                        effects,
                        preset,
                        Part::Voice,
                        Switch::new("quick-effects-on")
                            .checked(current.effects_on)
                            .accessibility_label(effects)
                            .on_click(move |on, _, cx| set(Change::EffectsOn(*on), cx)),
                    )),
            )
            .icon(IconName::AudioLines),
        )
    }

    /// `locked` は操作ロック中（制限を変えさせない）。
    pub fn render(
        &self,
        lang: Lang,
        part: Part,
        locked: bool,
        cx: &App,
        send: OnCommand,
    ) -> impl IntoElement {
        let Some(current) = self.current else {
            return div()
                .text_sm()
                .text_color(color::muted())
                .child(core(lang, keys::SOUND_UNREAD));
        };
        let set = {
            let send = send.clone();
            move |change: Change, cx: &mut App| send(Command::SetSound(change), cx)
        };
        div()
            .flex()
            .flex_col()
            .gap_6()
            .max_w(px(560.))
            // ON/OFF のある区画（ノイズ低減・声を整える）だけの補足。
            .when(matches!(part, Part::Noise | Part::Voice), |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(color::muted())
                        .child(core(lang, keys::OFF_UNTIL_ON)),
                )
            })
            .when(part == Part::Noise, |this| {
                this.child(section(
                    lang,
                    IconName::Wind,
                    None,
                    keys::NOISE,
                    &[keys::NOISE_LEAD, keys::NOISE_MIX],
                    Switch::new("noise-on")
                        .checked(current.noise_on)
                        .accessibility_label(core(lang, keys::NOISE))
                        .disabled(current.noise_mode.is_none())
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
                                move |mode, _, cx| set(Change::NoiseMode(mode), cx)
                            },
                        ))
                        .when(current.noise_mode.is_none(), |this| {
                            this.child(note(core(lang, keys::NOISE_MODE_FIRST)))
                        })
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
                                .child(div().text_sm().child(core(lang, keys::NOISE_ADAPTIVE)))
                                .child(choices(
                                    "noise-adaptive",
                                    lang,
                                    &ADAPTIVE_MODES,
                                    current.noise_mode,
                                    {
                                        let set = set.clone();
                                        move |mode, _, cx| set(Change::NoiseMode(mode), cx)
                                    },
                                ))
                                .when_some(
                                    current.noise_mode.and_then(|mode| match mode {
                                        NoiseMode::Measured => Some(keys::NOISE_MEASURED_MEANS),
                                        NoiseMode::Venue => Some(keys::NOISE_VENUE_MEANS),
                                        NoiseMode::Low | NoiseMode::High => None,
                                    }),
                                    |this, means| {
                                        this.child(note(core(lang, means)))
                                            .child(self.measure.render(lang, send.clone()))
                                    },
                                )
                                .child(slider_row(
                                    lang,
                                    keys::STRENGTH,
                                    core(lang, keys::STRENGTH_NAMED),
                                    &self.strength,
                                    percent,
                                    current.noise_mode.is_none(),
                                    cx,
                                ))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .justify_between()
                                        .gap_3()
                                        .child(
                                            with_hint(
                                                "voice-guard-hint",
                                                lang,
                                                core(lang, keys::VOICE_GUARD_MEANS),
                                                core(lang, keys::VOICE_GUARD),
                                            )
                                            .text_sm(),
                                        )
                                        .child(
                                            Switch::new("voice-guard")
                                                .checked(current.voice_guard)
                                                .accessibility_label(core(lang, keys::VOICE_GUARD))
                                                .disabled(current.noise_mode.is_none())
                                                .on_click({
                                                    let set = set.clone();
                                                    move |on, _, cx| {
                                                        set(Change::VoiceGuard(*on), cx)
                                                    }
                                                }),
                                        ),
                                ),
                        ),
                ))
            })
            .when(part == Part::Voice, |this| {
                this.child(section(
                    lang,
                    IconName::WandSparkles,
                    None,
                    keys::EFFECTS,
                    &[keys::EFFECTS_LEAD, keys::EFFECTS_AMOUNT_MEANS],
                    Switch::new("effects-on")
                        .checked(current.effects_on)
                        .accessibility_label(core(lang, keys::EFFECTS))
                        .on_click({
                            let set = set.clone();
                            move |on, _, cx| set(Change::EffectsOn(*on), cx)
                        }),
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(choices("effects-preset", lang, &PRESETS, current.preset, {
                            let set = set.clone();
                            move |preset, _, cx| set(Change::Preset(preset), cx)
                        }))
                        .map(|this| {
                            if current.preset == Some(Preset::Singing) {
                                this.children(
                                    [Knob::LowCut, Knob::Dynamics, Knob::Brightness]
                                        .map(|knob| self.knob(knob, lang, cx)),
                                )
                            } else {
                                this.child(slider_row(
                                    lang,
                                    keys::EFFECTS_AMOUNT,
                                    core(lang, keys::EFFECTS_AMOUNT),
                                    &self.amount,
                                    percent,
                                    false,
                                    cx,
                                ))
                            }
                        }),
                ))
            })
            .when(part == Part::Voice, |this| {
                this.child(section(
                    lang,
                    IconName::Orbit,
                    Some(&self.reverb_fold),
                    keys::REVERB,
                    &[keys::REVERB_LEAD],
                    Switch::new("reverb-on")
                        .checked(current.reverb.enabled)
                        .accessibility_label(core(lang, keys::REVERB_ON))
                        .on_click({
                            let set = set.clone();
                            move |on, _, cx| set(Change::ReverbOn(*on), cx)
                        }),
                    div().flex().flex_col().gap_2().children(
                        [Knob::ReverbMix, Knob::ReverbDecay, Knob::ReverbDamping]
                            .map(|knob| self.knob(knob, lang, cx)),
                    ),
                ))
            })
            .when(part == Part::Voice, |this| {
                this.child(section(
                    lang,
                    IconName::Speech,
                    Some(&self.deesser_fold),
                    keys::DEESSER,
                    &[keys::DEESSER_HINT],
                    Switch::new("deesser-on")
                        .checked(current.deesser.on)
                        .accessibility_label(core(lang, keys::DEESSER))
                        .on_click(move |on, _, cx| set(Change::DeEsserOn(*on), cx)),
                    self.knob(Knob::DeEsser, lang, cx),
                ))
            })
            .when(part == Part::Peak, |this| {
                this.child(self.peak.render(lang, locked, cx, send.clone()))
                    .child(self.true_peak.render(lang, locked, cx, send))
            })
    }
}

/// 見出し（と右の ON/OFF）・中身の区画。説明は見出しの ⓘ に出す。
fn section(
    lang: Lang,
    icon: IconName,
    fold: Option<&Fold>,
    title: &'static str,
    lead: &[&'static str],
    switch: Switch,
    body: impl IntoElement,
) -> impl IntoElement {
    Card::new(core(lang, title), body)
        .icon(icon)
        .hint(lang, paragraphs(lang, lead))
        .trailing(switch)
        .when_some(fold, |card, fold| card.fold(fold, false))
}

/// 範囲と刻み（`peak` の定数の形）のスライダー。
pub(crate) fn range<V: 'static>(
    cx: &mut Context<V>,
    (min, max, step): (f32, f32, f32),
) -> Entity<SliderState> {
    cx.new(|_| SliderState::new().min(min).max(max).step(step))
}

/// まだ読めていない値（スライダーは既定の 0 のままで、範囲の外）。
pub(crate) fn unknown(_: f32) -> String {
    "—".into()
}

fn percent(value: f32) -> String {
    format!("{value:.0}%")
}

/// 単位は名前に書いてあるので、数だけ出す。
fn whole(value: f32) -> String {
    format!("{value:.0}")
}

fn tenth(value: f32) -> String {
    format!("{value:.1}")
}

/// 名前・スライダー・値の1行。値はスライダーのもので、動かしている間もついてくる。`named` は読み上げの名前。
pub(crate) fn slider_row(
    lang: Lang,
    label: &'static str,
    named: impl Into<SharedString>,
    state: &Entity<SliderState>,
    show: fn(f32) -> String,
    disabled: bool,
    cx: &App,
) -> impl IntoElement {
    let value = show(state.read(cx).value().end());
    div()
        .flex()
        .items_center()
        .gap_3()
        .child(div().flex_none().text_sm().child(core(lang, label)))
        .child(
            div().flex_1().child(
                Slider::new(state)
                    .horizontal()
                    .disabled(disabled)
                    .accessibility_label(named),
            ),
        )
        .child(div().flex_none().w(px(48.)).text_sm().child(value))
}
