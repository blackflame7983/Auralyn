//! 音づくりの画面：ノイズ低減（ON/OFF・弱／強・抑制の強さ・声を守る）と「声を整える」（ON/OFF・種類・整え具合）。
//! 値の読み方は `auralyn-ui-model` の `sound`。変えるたびにエンジンへ送り、エンジンが受け付けた結果で描き直す。
//! 「大きな音を抑える」（ピーク保護）は ON/OFF・天井・復帰時間。周囲の音の測定は `measure`。歯擦音・歌向け・本番モードは、まだこの画面に無い。

use auralyn_ui_model::peak::{self, Peak};
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
use crate::measure::MeasurePanel;
use crate::part::{card, note};
use crate::vst::Send;

const NOISE_MODES: [(NoiseMode, &str); 2] = [
    (NoiseMode::Low, keys::NOISE_LOW),
    (NoiseMode::High, keys::NOISE_HIGH),
];
const ADAPTIVE_MODES: [(NoiseMode, &str); 2] = [
    (NoiseMode::Measured, keys::NOISE_MEASURED),
    (NoiseMode::Venue, keys::NOISE_VENUE),
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
    /// ピーク保護の天井（dBFS）と復帰時間（ms）。離したときに送る。
    pub ceiling: Entity<SliderState>,
    pub release: Entity<SliderState>,
    /// 大きな音を抑える（ピーク保護）。`None` は読めていない。
    peak: Option<Peak>,
    /// 最後に読めた ON/OFF。止まっていて読めない間も、スイッチはこれを示す（次の開始で付け直される）。
    peak_enabled: bool,
    /// 周囲の音の測定。
    pub measure: MeasurePanel,
}

impl SoundPage {
    pub fn new<V: 'static>(cx: &mut Context<V>) -> Self {
        Self {
            current: None,
            amount: cx.new(|_| SliderState::new().min(0.).max(100.).step(1.)),
            strength: cx.new(|_| SliderState::new().min(25.).max(125.).step(5.)),
            ceiling: range(cx, peak::CEILING_DB),
            release: range(cx, peak::RELEASE_MS),
            peak: None,
            peak_enabled: false,
            measure: MeasurePanel::default(),
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

    pub fn set_peak(&mut self, peak: Option<Peak>, window: &mut Window, cx: &mut App) {
        let before = self.peak.map(|peak| (peak.ceiling_db, peak.release_ms));
        // 反映待ちの間の読み直し（500ms ごと）では、値が変わったときだけ動かす（動かしている途中のつまみを戻さない）。
        // それ以外の返事（断られたときを含む）では、エンジンの値に合わせる。
        if let Some(peak) =
            peak.filter(|peak| !peak.pending || before != Some((peak.ceiling_db, peak.release_ms)))
        {
            self.ceiling
                .update(cx, |state, cx| state.set_value(peak.ceiling_db, window, cx));
            self.release
                .update(cx, |state, cx| state.set_value(peak.release_ms, window, cx));
        }
        if let Some(peak) = peak {
            self.peak_enabled = peak.enabled;
        }
        self.peak = peak;
    }

    /// 送る天井と復帰時間（スライダーの値を刻みにそろえる）。
    pub fn peak_limits(&self, cx: &App) -> Command {
        Command::SetPeakLimits {
            ceiling_db: peak::snap(peak::CEILING_DB, self.ceiling.read(cx).value().end()),
            release_ms: peak::snap(peak::RELEASE_MS, self.release.read(cx).value().end()),
        }
    }

    pub fn peak_pending(&self) -> bool {
        self.peak.is_some_and(|peak| peak.pending)
    }

    pub fn render(&self, lang: Lang, cx: &App, send: Send) -> impl IntoElement {
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
                            move |mode, cx| set(Change::NoiseMode(mode), cx)
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
                            .child(div().text_sm().child(core(lang, keys::NOISE_ADAPTIVE)))
                            .child(choices(
                                "noise-adaptive",
                                lang,
                                &ADAPTIVE_MODES,
                                current.noise_mode,
                                {
                                    let set = set.clone();
                                    move |mode, cx| set(Change::NoiseMode(mode), cx)
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
                                keys::STRENGTH_NAMED,
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
                                    .child(div().text_sm().child(core(lang, keys::VOICE_GUARD)))
                                    .child(
                                        Switch::new("voice-guard")
                                            .checked(current.voice_guard)
                                            .accessibility_label(core(lang, keys::VOICE_GUARD))
                                            .disabled(current.noise_mode.is_none())
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
                            percent,
                            false,
                            cx,
                        ))
                        .child(note(core(lang, keys::EFFECTS_AMOUNT_MEANS)))
                } else {
                    div().child(note(core(lang, keys::SINGING_NOT_YET)))
                },
            ))
            .child(self.render_peak(lang, cx, send))
    }

    /// 大きな音を抑える。ON/OFF と、詳しい設定（天井・復帰時間）。読めない（止まっている）間は操作させない。
    fn render_peak(&self, lang: Lang, cx: &App, send: Send) -> impl IntoElement {
        let unread = self.peak.is_none();
        let notes: Vec<&str> = peak::notes(self.peak)
            .into_iter()
            .map(|note| {
                core(
                    lang,
                    match note {
                        peak::Note::Unknown => keys::PEAK_UNKNOWN,
                        peak::Note::Pending => keys::PEAK_PENDING,
                        peak::Note::Stopped => keys::PEAK_STOPPED,
                    },
                )
            })
            .collect();
        card(
            core(lang, keys::PEAK_TITLE),
            Switch::new("peak-on")
                .checked(self.peak_enabled)
                .disabled(unread)
                .accessibility_label(core(lang, keys::PEAK_TITLE))
                .on_click(move |on, _, cx| send(Command::SetPeak(*on), cx)),
            div()
                .flex()
                .flex_col()
                .gap_2()
                .child(note(core(lang, keys::PEAK_LEAD)))
                .child(note(core(lang, keys::PEAK_SCOPE)))
                .child(note(core(lang, keys::PEAK_RESETS)))
                .when(!notes.is_empty(), |this| {
                    this.child(div().text_sm().child(notes.join(" · ")))
                })
                .child(
                    div()
                        .pt_2()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .child(core(lang, keys::PEAK_DETAILS)),
                )
                .child(slider_row(
                    lang,
                    keys::PEAK_CEILING,
                    keys::PEAK_CEILING,
                    &self.ceiling,
                    if unread {
                        unknown
                    } else {
                        |v| format!("{v:.1}")
                    },
                    unread,
                    cx,
                ))
                .child(slider_row(
                    lang,
                    keys::PEAK_RELEASE,
                    keys::PEAK_RELEASE,
                    &self.release,
                    if unread {
                        unknown
                    } else {
                        |v| format!("{v:.0}")
                    },
                    unread,
                    cx,
                )),
        )
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
    card(
        core(lang, title),
        switch,
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(note(core(lang, lead)))
            .child(body),
    )
}

/// 範囲と刻み（`peak` の定数の形）のスライダー。
fn range<V: 'static>(
    cx: &mut Context<V>,
    (min, max, step): (f32, f32, f32),
) -> Entity<SliderState> {
    cx.new(|_| SliderState::new().min(min).max(max).step(step))
}

/// まだ読めていない値（スライダーは既定の 0 のままで、範囲の外）。
fn unknown(_: f32) -> String {
    "—".into()
}

fn percent(value: f32) -> String {
    format!("{value:.0}%")
}

/// 名前・スライダー・値の1行。値はスライダーのもので、動かしている間もついてくる。`named` は読み上げの名前。
fn slider_row(
    lang: Lang,
    label: &'static str,
    named: &'static str,
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
                    .accessibility_label(core(lang, named)),
            ),
        )
        .child(div().flex_none().w(px(48.)).text_sm().child(value))
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
