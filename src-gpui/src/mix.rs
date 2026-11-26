//! ホームの「配信ミックス」：声に、別の入力機器（仮想ケーブルなど）の音（オケ）を混ぜて、配信用の出力へ送る。
//! 規則は `auralyn-ui-model` の `mix`、エンジン側は `engine/mix.rs`。アプリの音・時間合わせ・ミックス後の VST はまだ無い。

use std::cell::Cell;
use std::rc::Rc;

use auralyn_ui_model::connect::{self, Device};
use auralyn_ui_model::mix::{self, Change, Mix, Source};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::select::{Select, SelectEvent, SelectState};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::{Disableable as _, IndexPath};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::{Command, MixAction};
use crate::i18n::{core, keys, Lang};
use crate::part::{card, note, OnCommand};

type Names = SelectState<Vec<SharedString>>;

/// オケに選べる機器（ID・表示名・チャンネル数）。
struct Choice {
    id: String,
    label: String,
    channels: u16,
}

pub struct MixPanel {
    /// 最後に読めた状態。`None` はまだ読めていない。
    mix: Option<Mix>,
    /// 最後に読めなかった理由（次に読めたら消す）。
    read_failed: Option<String>,
    /// 最後の操作が断られた理由（次の操作が通るまで残す）。
    failed: Option<String>,
    choices: Vec<Choice>,
    source: Entity<Names>,
    pair: Entity<Names>,
    /// 「二重再生や循環が起きないよう設定した」。機器かチャンネルを選び直すと外れる。
    confirmed: Rc<Cell<bool>>,
    voice_gain: Entity<SliderState>,
    music_gain: Entity<SliderState>,
    _subscriptions: Vec<Subscription>,
}

impl MixPanel {
    /// `send` はスライダーを離したときの送り先。
    pub fn new<V: 'static>(
        window: &mut Window,
        cx: &mut Context<V>,
        send: fn(&mut V, Command),
    ) -> Self {
        let confirmed: Rc<Cell<bool>> = Rc::default();
        let mut select =
            |cx: &mut Context<V>| cx.new(|cx| SelectState::new(Vec::new(), None, window, cx));
        let source = select(cx);
        let pair = select(cx);
        let gain = |cx: &mut Context<V>| cx.new(|_| SliderState::new().min(0.).max(200.).step(1.));
        let voice_gain = gain(cx);
        let music_gain = gain(cx);
        let on_gain = |change: fn(f32) -> Change| {
            move |this: &mut V, _: Entity<SliderState>, event: &SliderEvent, _: &mut Context<V>| {
                if let SliderEvent::Release(value) = event {
                    send(
                        this,
                        Command::Mix(MixAction::Levels(change(value.end() / 100.))),
                    );
                }
            }
        };
        let unconfirm = |confirmed: Rc<Cell<bool>>| {
            move |_: &mut V,
                  _: Entity<Names>,
                  _: &SelectEvent<Vec<SharedString>>,
                  cx: &mut Context<V>| {
                confirmed.set(false);
                cx.notify();
            }
        };
        let subscriptions = vec![
            cx.subscribe(&voice_gain, on_gain(Change::VoiceGain)),
            cx.subscribe(&music_gain, on_gain(Change::MusicGain)),
            cx.subscribe(&source, unconfirm(confirmed.clone())),
            cx.subscribe(&pair, unconfirm(confirmed.clone())),
        ];
        Self {
            mix: None,
            read_failed: None,
            failed: None,
            choices: Vec::new(),
            source,
            pair,
            confirmed,
            voice_gain,
            music_gain,
            _subscriptions: subscriptions,
        }
    }

    /// 機器の一覧が届いた。声に使っている機器を除いて、オケの候補を入れ直す。
    pub fn set_devices(
        &mut self,
        devices: &[Device],
        voice_input: Option<&str>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let sources = mix::sources(devices, voice_input);
        let labels = connect::labels(&sources);
        self.choices = sources
            .iter()
            .zip(labels)
            .filter_map(|(d, label)| {
                Some(Choice {
                    id: d.id.clone()?,
                    label,
                    channels: d.channels,
                })
            })
            .collect();
        self.fill(window, cx);
    }

    /// 変える操作の結果。
    pub fn done(&mut self, result: Result<(), String>) {
        self.failed = result.err();
    }

    /// 読めた状態・読めなかった理由。
    pub fn set(&mut self, result: Result<Mix, String>, window: &mut Window, cx: &mut App) {
        match result {
            Ok(mix) => {
                self.read_failed = None;
                if let Some(levels) = mix.levels {
                    self.voice_gain.update(cx, |s, cx| {
                        s.set_value(levels.voice_gain * 100., window, cx)
                    });
                    self.music_gain.update(cx, |s, cx| {
                        s.set_value(levels.music_gain * 100., window, cx)
                    });
                }
                let first = self.mix.is_none();
                self.mix = Some(mix);
                if first {
                    self.fill(window, cx);
                }
            }
            Err(message) => self.read_failed = Some(message),
        }
    }

    /// 機器の選択肢を入れ、適用中（無ければ保存）の機器とチャンネルを選ぶ。
    fn fill(&mut self, window: &mut Window, cx: &mut App) {
        let current = self
            .mix
            .as_ref()
            .and_then(|m| m.active.clone().or(m.saved.clone()));
        let (id, channels) = match current {
            Some(Source::Device { input_id, channels }) => (Some(input_id), Some(channels)),
            _ => (None, None),
        };
        let names = self
            .choices
            .iter()
            .map(|c| SharedString::from(c.label.clone()))
            .collect();
        let row = id.and_then(|id| self.choices.iter().position(|c| c.id == id));
        self.source.update(cx, |state, cx| {
            state.set_items(names, window, cx);
            state.set_selected_index(row.map(IndexPath::new), window, cx);
        });
        self.fill_pairs(row, channels, window, cx);
    }

    fn fill_pairs(
        &self,
        row: Option<usize>,
        chosen: Option<[usize; 2]>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let pairs = row
            .and_then(|row| self.choices.get(row))
            .map(|c| mix::pairs(c.channels))
            .unwrap_or_default();
        let names = pairs
            .iter()
            .map(|p| SharedString::from(mix::pair_label(*p)))
            .collect();
        let selected = chosen
            .and_then(|c| pairs.iter().position(|p| *p == c))
            .or((!pairs.is_empty()).then_some(0));
        self.pair.update(cx, |state, cx| {
            state.set_items(names, window, cx);
            state.set_selected_index(selected.map(IndexPath::new), window, cx);
        });
    }

    /// 機器を選び直したら、チャンネルの組を入れ直す（描画の前に呼ぶ）。
    pub fn source_changed(&self, window: &mut Window, cx: &mut App) {
        let row = self.source.read(cx).selected_index(cx).map(|ix| ix.row);
        self.fill_pairs(row, None, window, cx);
    }

    pub fn source_state(&self) -> &Entity<Names> {
        &self.source
    }

    /// 選んでいる機器とチャンネル。
    fn chosen(&self, cx: &App) -> Option<(String, [usize; 2])> {
        let row = self.source.read(cx).selected_index(cx)?.row;
        let choice = self.choices.get(row)?;
        let pair = self.pair.read(cx).selected_index(cx)?.row;
        Some((choice.id.clone(), *mix::pairs(choice.channels).get(pair)?))
    }

    /// `output_ready` は配信用の出力を選び、処理を分けてあること（`None` はまだ読めていない）。
    pub fn render(
        &self,
        lang: Lang,
        output_ready: Option<bool>,
        cx: &App,
        send: OnCommand,
    ) -> impl IntoElement {
        let Some(mix) = self.mix.as_ref() else {
            return card(
                core(lang, keys::MIX_TITLE),
                div(),
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(note(core(lang, keys::MIX_LEAD)))
                    .when_some(self.read_failed.clone(), |this, message| {
                        this.child(div().text_sm().text_color(color::warning()).child(message))
                    }),
            )
            .into_any_element();
        };
        let chosen = self.chosen(cx);
        let confirmed = self.confirmed.get();
        let ready = output_ready == Some(true);
        let can_apply = ready && !mix.running && chosen.is_some() && confirmed;
        let current = |source: &Option<Source>| match source {
            Some(Source::Device { input_id, channels }) => format!(
                "{} ({})",
                self.choices
                    .iter()
                    .find(|c| c.id == *input_id)
                    .map_or(input_id.as_str(), |c| c.label.as_str()),
                mix::pair_label(*channels)
            ),
            Some(Source::App { name }) => name.clone(),
            None => core(lang, keys::MIX_NONE).to_owned(),
        };
        let warning = |text: String| div().text_sm().text_color(color::warning()).child(text);
        card(
            core(lang, keys::MIX_TITLE),
            div(),
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(note(core(lang, keys::MIX_LEAD)))
                .when(output_ready == Some(false), |this| {
                    this.child(warning(core(lang, keys::MIX_NEED_OUTPUT).to_owned()))
                })
                .child(row(lang, keys::MIX_CURRENT, current(&mix.active)))
                .when(mix.active.is_none() && mix.saved.is_some(), |this| {
                    this.child(row(lang, keys::MIX_SAVED, current(&mix.saved)))
                })
                .when(matches!(mix.saved, Some(Source::App { .. })), |this| {
                    this.child(note(core(lang, keys::MIX_APP_LATER)))
                })
                .when(mix.failed, |this| {
                    this.child(warning(core(lang, keys::MIX_INPUT_FAILED).to_owned()))
                })
                .children(
                    [
                        self.read_failed.clone(),
                        self.failed.clone(),
                        mix.error.clone(),
                    ]
                    .into_iter()
                    .flatten()
                    .map(warning),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .child(field(
                            lang,
                            keys::MIX_SOURCE,
                            Select::new(&self.source).disabled(mix.running),
                        ))
                        .child(field(
                            lang,
                            keys::MIX_CHANNELS,
                            Select::new(&self.pair).disabled(mix.running),
                        ))
                        .when(mix.running, |this| {
                            this.child(note(core(lang, keys::MIX_STOP_FIRST)))
                        })
                        .child(
                            Checkbox::new("mix-confirm")
                                .checked(confirmed)
                                .disabled(mix.running)
                                .label(core(lang, keys::MIX_CONFIRM))
                                .on_click({
                                    let confirmed = self.confirmed.clone();
                                    move |checked, window, _| {
                                        confirmed.set(*checked);
                                        window.refresh();
                                    }
                                }),
                        )
                        .child(
                            div()
                                .flex()
                                .gap_2()
                                .child(
                                    Button::new("mix-apply")
                                        .label(core(lang, keys::MIX_APPLY))
                                        .primary()
                                        .disabled(!can_apply)
                                        .on_click({
                                            let send = send.clone();
                                            move |_, _, cx| {
                                                if let Some((input_id, channels)) = chosen.clone() {
                                                    send(
                                                        Command::Mix(MixAction::Apply {
                                                            input_id,
                                                            channels,
                                                        }),
                                                        cx,
                                                    );
                                                }
                                            }
                                        }),
                                )
                                .when(mix.active.is_some() || mix.saved.is_some(), |this| {
                                    let send = send.clone();
                                    this.child(
                                        Button::new("mix-disable")
                                            .label(core(lang, keys::MIX_DISABLE))
                                            .outline()
                                            .disabled(mix.running)
                                            .on_click(move |_, _, cx| {
                                                send(Command::Mix(MixAction::Disable), cx)
                                            }),
                                    )
                                }),
                        ),
                )
                .when_some(
                    mix.levels.filter(|_| mix.can_change_levels()),
                    |this, levels| {
                        let toggle =
                            |id: &'static str,
                             label: &'static str,
                             checked: bool,
                             change: fn(bool) -> Change| {
                                let send = send.clone();
                                Checkbox::new(id)
                                    .checked(checked)
                                    .label(core(lang, label))
                                    .on_click(move |checked, _, cx| {
                                        send(Command::Mix(MixAction::Levels(change(*checked))), cx)
                                    })
                            };
                        this.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap_2()
                                .pt_3()
                                .border_t_1()
                                .border_color(color::border())
                                .child(gain_row(lang, keys::MIX_VOICE, &self.voice_gain, cx))
                                .child(toggle(
                                    "mix-voice-mute",
                                    keys::MIX_VOICE_MUTE,
                                    levels.voice_muted,
                                    Change::VoiceMuted,
                                ))
                                .child(gain_row(lang, keys::MIX_MUSIC, &self.music_gain, cx))
                                .child(toggle(
                                    "mix-music-mute",
                                    keys::MIX_MUSIC_MUTE,
                                    levels.music_muted,
                                    Change::MusicMuted,
                                ))
                                .child(toggle(
                                    "mix-monitor",
                                    keys::MIX_MONITOR,
                                    levels.monitor_music,
                                    Change::MonitorMusic,
                                )),
                        )
                    },
                ),
        )
        .into_any_element()
    }
}

fn field(lang: Lang, label: &'static str, control: impl IntoElement) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap_1()
        .child(div().text_sm().child(core(lang, label)))
        .child(control)
}

fn row(lang: Lang, label: &'static str, value: String) -> impl IntoElement {
    div()
        .flex()
        .justify_between()
        .gap_3()
        .text_sm()
        .child(div().text_color(color::muted()).child(core(lang, label)))
        .child(div().min_w_0().child(value))
}

/// 名前・スライダー・値（%）の1行。値はスライダーのもので、動かしている間もついてくる。
fn gain_row(
    lang: Lang,
    label: &'static str,
    state: &Entity<SliderState>,
    cx: &App,
) -> impl IntoElement {
    let value = state.read(cx).value().end();
    div()
        .flex()
        .items_center()
        .gap_3()
        .child(div().flex_none().text_sm().child(core(lang, label)))
        .child(
            div().flex_1().child(
                Slider::new(state)
                    .horizontal()
                    .accessibility_label(core(lang, label)),
            ),
        )
        .child(
            div()
                .flex_none()
                .w(px(48.))
                .text_sm()
                .child(format!("{value:.0}%")),
        )
}
