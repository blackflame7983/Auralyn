//! VST の画面：並び（上から音が通る順）と、追加。
//! 1つずつ ON/OFF・音量・ミュート・上下の入れ替え・編集（VST の窓）・削除ができる。候補の検索と音量の範囲は `auralyn-ui-model` の `rack`。
//! 並びと VST の中の設定は、エンジンが変わるたびに保存する（`engine/slots.rs`）。保存した構成は `setups`。テンプレートは、まだこの画面に無い。

use std::collections::HashMap;

use auralyn_ui_model::rack::{self, Candidate};
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::empty::{Empty, EmptyDescription, EmptyHeader, EmptyTitle};
use gpui_kit::component::select::{SearchableVec, Select, SelectItem, SelectState};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Selectable as _, Sizable as _, WindowExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::{Command, Slot};
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{with_hint, OnCommand};

/// 追加の候補の1行。検索は [`Candidate::matches`] に任せる。
#[derive(Clone)]
pub struct Choice(Candidate);

impl SelectItem for Choice {
    type Value = Candidate;

    fn title(&self) -> SharedString {
        self.0.title().into()
    }

    fn value(&self) -> &Candidate {
        &self.0
    }

    fn matches(&self, query: &str) -> bool {
        self.0.matches(query)
    }
}

pub type Choices = SelectState<SearchableVec<Choice>>;

/// 並びへの操作を、どの並びへの命令にするか（声用の並びと、ミックス後の VST で同じ部品を使う）。
#[derive(Clone, Copy)]
pub struct Ops {
    /// 部品の ID の頭（同じ窓に2つの並びがあっても重ならないように）。
    pub prefix: &'static str,
    pub enable: fn(String, bool) -> Command,
    pub shift: fn(String, bool) -> Command,
    pub edit: fn(String) -> Command,
    pub remove: fn(String) -> Command,
    pub mute: fn(String, bool) -> Command,
    pub gain: fn(String, f32) -> Command,
}

/// 声用の並び。
const VOICE: Ops = Ops {
    prefix: "vst",
    enable: |id, enabled| Command::SetPluginEnabled { id, enabled },
    shift: |id, up| Command::MovePlugin { id, up },
    edit: Command::OpenEditor,
    remove: Command::RemovePlugin,
    mute: |id, muted| Command::SetPluginMuted { id, muted },
    gain: |id, gain| Command::SetPluginGain { id, gain },
};

/// 並びの描き方：どの並びか、追加・削除・並べ替えを止めるか（ミックス後の VST は音声を止めてから）、表示言語。
#[derive(Clone, Copy)]
pub struct Look {
    pub ops: Ops,
    pub locked: bool,
    pub lang: Lang,
}

/// 読めている VST ごとの音量のスライダー（ID で引く）。離したときに音量を送る。
#[derive(Default)]
pub struct Gains(HashMap<String, (Entity<SliderState>, Subscription)>);

impl Gains {
    /// 並びに合わせてスライダーを作り直し、値をエンジンの値に合わせる。`send` はスライダーを離したときの送り先。
    pub fn sync<V: 'static>(
        &mut self,
        rack: &[Slot],
        ops: Ops,
        window: &mut Window,
        cx: &mut Context<V>,
        send: fn(&mut V, Command),
    ) {
        let mut old = std::mem::take(&mut self.0);
        for slot in rack.iter().filter(|slot| slot.loaded) {
            let (state, subscription) = old.remove(&slot.id).unwrap_or_else(|| {
                let state = cx.new(|_| SliderState::new().min(0.).max(200.).step(1.));
                let id = slot.id.clone();
                let subscription = cx.subscribe(&state, move |this, _, event: &SliderEvent, _| {
                    let SliderEvent::Release(value) = event else {
                        return;
                    };
                    send(
                        this,
                        (ops.gain)(id.clone(), rack::gain_from_percent(value.end())),
                    );
                });
                (state, subscription)
            });
            let percent = rack::gain_percent(slot.gain);
            state.update(cx, |state, cx| state.set_value(percent, window, cx));
            self.0.insert(slot.id.clone(), (state, subscription));
        }
    }

    /// スライダーと、その値（動かしている間もついてくる）。
    fn get<'a>(&'a self, id: &str, cx: &App) -> Option<(&'a Entity<SliderState>, f32)> {
        self.0
            .get(id)
            .map(|(state, _)| (state, state.read(cx).value().end()))
    }
}

/// 候補を選ぶ欄（検索できる）。
pub fn new_catalog<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Entity<Choices> {
    cx.new(|cx| SelectState::new(SearchableVec::new(Vec::new()), None, window, cx).searchable(true))
}

/// 候補を入れ替える（選択は外す）。
pub fn fill_catalog(
    catalog: &Entity<Choices>,
    candidates: &[Candidate],
    window: &mut Window,
    cx: &mut App,
) {
    let choices = SearchableVec::new(candidates.iter().cloned().map(Choice).collect::<Vec<_>>());
    catalog.update(cx, |state, cx| {
        state.set_items(choices, window, cx);
        state.set_selected_index(None, window, cx);
    });
}

/// 並びの一覧。
pub fn list(
    rack: &[Slot],
    gains: &Gains,
    look: Look,
    cx: &App,
    send: OnCommand,
) -> impl IntoElement {
    let last = rack.len().saturating_sub(1);
    div()
        .id(SharedString::from(format!("{}-rack", look.ops.prefix)))
        .role(Role::List)
        .flex()
        .flex_col()
        .gap_2()
        .children(rack.iter().enumerate().map(|(index, slot)| {
            row(
                slot,
                gains.get(&slot.id, cx),
                index,
                index == last,
                look,
                send.clone(),
            )
        }))
}

pub struct VstPage {
    rack: Vec<Slot>,
    gains: Gains,
    catalog: Entity<Choices>,
    /// 候補を探している。`None` はまだ一度も探していない。
    scanning: Option<bool>,
}

impl VstPage {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            rack: Vec::new(),
            gains: Gains::default(),
            catalog: new_catalog(window, cx),
            scanning: None,
        }
    }

    /// 開いたとき、まだ探していなければ候補を探す。
    pub fn needs_scan(&self) -> bool {
        self.scanning.is_none()
    }

    pub fn scan_started(&mut self) {
        self.scanning = Some(true);
    }

    /// 並びを替え、音量のスライダーをエンジンの値に合わせる。`send` はスライダーを離したときの送り先。
    pub fn set_rack<V: 'static>(
        &mut self,
        rack: Vec<Slot>,
        window: &mut Window,
        cx: &mut Context<V>,
        send: fn(&mut V, Command),
    ) {
        self.gains.sync(&rack, VOICE, window, cx, send);
        self.rack = rack;
    }

    pub fn set_catalog(&mut self, candidates: &[Candidate], window: &mut Window, cx: &mut App) {
        self.scanning = Some(false);
        fill_catalog(&self.catalog, candidates, window, cx);
    }

    pub fn scanning(&self) -> bool {
        self.scanning == Some(true)
    }

    pub fn scan_failed(&mut self) {
        self.scanning = Some(false);
    }

    pub fn render(&self, lang: Lang, cx: &App, send: OnCommand) -> impl IntoElement {
        let scanning = self.scanning == Some(true);
        let chosen = self.catalog.read(cx).selected_value().cloned();
        div()
            .flex()
            .flex_col()
            .gap_4()
            .max_w(px(640.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(
                        div().flex_1().min_w(px(240.)).child(
                            Select::new(&self.catalog)
                                .placeholder(core(lang, keys::VST_SEARCH))
                                .search_placeholder(core(lang, keys::VST_SEARCH))
                                .accessibility_label(core(lang, keys::VST_ADD))
                                .disabled(scanning),
                        ),
                    )
                    .child({
                        let send = send.clone();
                        Button::new("vst-add")
                            .label(core(lang, keys::VST_ADD))
                            .primary()
                            .disabled(chosen.is_none())
                            .on_click(move |_, _, cx| {
                                if let Some(candidate) = chosen.clone() {
                                    send(Command::AddPlugin(candidate), cx);
                                }
                            })
                    })
                    .child({
                        let send = send.clone();
                        Button::new("vst-refresh")
                            .label(core(lang, keys::VST_REFRESH))
                            .ghost()
                            .loading(scanning)
                            .disabled(scanning)
                            .on_click(move |_, _, cx| send(Command::ScanPlugins, cx))
                    }),
            )
            .when(scanning, |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(color::muted())
                        .child(core(lang, keys::VST_SCANNING)),
                )
            })
            .map(|this| {
                if self.rack.is_empty() {
                    this.child(
                        Empty::new().header(
                            EmptyHeader::new()
                                .title(EmptyTitle::new().child(core(lang, keys::VST_EMPTY)))
                                .description(
                                    EmptyDescription::new()
                                        .child(core(lang, keys::VST_EMPTY_SCOPE)),
                                ),
                        ),
                    )
                } else {
                    let look = Look {
                        ops: VOICE,
                        locked: false,
                        lang,
                    };
                    this.child(list(&self.rack, &self.gains, look, cx, send.clone()))
                }
            })
            .when(self.rack.iter().any(|slot| !slot.loaded), |this| {
                this.child(
                    div()
                        .flex()
                        .flex_col()
                        .items_start()
                        .gap_1p5()
                        .child(with_hint(
                            "vst-reload-missing-hint",
                            lang,
                            core(lang, keys::VST_RELOAD_MISSING_HINT),
                            Button::new("vst-reload-missing")
                                .label(core(lang, keys::VST_RELOAD_MISSING))
                                .outline()
                                .small()
                                .on_click(move |_, _, cx| send(Command::ReloadMissing, cx)),
                        )),
                )
            })
    }
}

/// 並びの1枠。上の行は番号・名前（OFF・ミュートの札）・ON/OFF・上へ・下へ・編集・削除、下の行は音量とミュート。
fn row(
    slot: &Slot,
    gain: Option<(&Entity<SliderState>, f32)>,
    index: usize,
    last: bool,
    look: Look,
    send: OnCommand,
) -> impl IntoElement {
    let Look { ops, locked, lang } = look;
    let prefix = ops.prefix;
    let name = slot.name.as_str();
    let named = |key| core_with(lang, key, &[("arg0", &name)]);
    let button = |suffix: &str, label: &'static str, command: Command| {
        let send = send.clone();
        Button::new(SharedString::from(format!("{prefix}-{suffix}-{}", slot.id)))
            .label(label)
            .ghost()
            .small()
            .on_click(move |_, _, cx| send(command.clone(), cx))
    };
    let id = slot.id.clone();
    let enabled = slot.enabled;
    let loaded = slot.loaded;
    // 読めていない VST は、削除だけを出す（ほかの操作は子に届かない）。
    let tag = if !loaded {
        Some(keys::VST_NOT_LOADED)
    } else if !enabled {
        Some(keys::VST_OFF)
    } else if slot.muted {
        Some(keys::VST_MUTED)
    } else {
        None
    };
    let top = div()
        .flex()
        .items_center()
        .gap_2()
        .child(
            div()
                .flex_none()
                .w(px(20.))
                .text_sm()
                .text_color(color::muted())
                .child(format!("{}", index + 1)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .truncate()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .when(tag.is_some(), |this| this.text_color(color::muted()))
                        .child(name.to_owned()),
                )
                .when_some(tag, |this, tag| {
                    this.child(
                        div()
                            .flex_none()
                            .px_1()
                            .rounded(px(4.))
                            .border_1()
                            .border_color(color::border())
                            .text_xs()
                            .child(core(lang, tag)),
                    )
                }),
        )
        .when(loaded, |this| {
            this.child({
                let send = send.clone();
                Switch::new(SharedString::from(format!("{prefix}-enable-{}", slot.id)))
                    .checked(enabled)
                    .accessibility_label(named(keys::VST_ENABLE))
                    .on_click(move |checked, _, cx| send((ops.enable)(id.clone(), *checked), cx))
            })
            .child(
                button(
                    "up",
                    core(lang, keys::VST_UP),
                    (ops.shift)(slot.id.clone(), true),
                )
                .accessibility_label(format!("{name} {}", core(lang, keys::VST_UP)))
                .disabled(locked || index == 0),
            )
            .child(
                button(
                    "down",
                    core(lang, keys::VST_DOWN),
                    (ops.shift)(slot.id.clone(), false),
                )
                .accessibility_label(format!("{name} {}", core(lang, keys::VST_DOWN)))
                .disabled(locked || last),
            )
            .child(
                button(
                    "edit",
                    core(lang, keys::VST_EDIT),
                    (ops.edit)(slot.id.clone()),
                )
                .accessibility_label(named(keys::VST_EDIT_NAMED)),
            )
        })
        .child(
            Button::new(SharedString::from(format!("{prefix}-remove-{}", slot.id)))
                .label(core(lang, keys::VST_REMOVE))
                .ghost()
                .small()
                .disabled(locked)
                .accessibility_label(named(keys::VST_REMOVE_NAMED))
                .on_click({
                    let title = named(keys::VST_REMOVE_TITLE);
                    let command = (ops.remove)(slot.id.clone());
                    let send = send.clone();
                    move |_, window, cx| {
                        confirm_remove(&title, command.clone(), lang, send.clone(), window, cx)
                    }
                }),
        );
    div()
        .id(SharedString::from(format!("{prefix}-slot-{}", slot.id)))
        .role(Role::ListItem)
        .aria_label(name.to_owned())
        .flex()
        .flex_col()
        .gap_2()
        .px_3()
        .py_2()
        .rounded(px(6.))
        .border_1()
        .border_color(color::border())
        .bg(color::card())
        .child(top)
        .when_some(gain, |this, (gain, percent)| {
            this.child(volume(slot, gain, percent, look, send))
        })
}

/// 下の行：音量（0〜200%）と、ミュート。番号の幅だけ字下げして名前にそろえる。
fn volume(
    slot: &Slot,
    gain: &Entity<SliderState>,
    percent: f32,
    look: Look,
    send: OnCommand,
) -> impl IntoElement {
    let Look { ops, lang, .. } = look;
    let name = slot.name.as_str();
    let named = |key| core_with(lang, key, &[("arg0", &name)]);
    let command = (ops.mute)(slot.id.clone(), !slot.muted);
    div()
        .flex()
        .items_center()
        .gap_3()
        .pl(px(28.))
        .child(
            div().flex_1().child(
                Slider::new(gain)
                    .horizontal()
                    .accessibility_label(named(keys::VST_GAIN_NAMED)),
            ),
        )
        .child(
            div()
                .flex_none()
                .w(px(48.))
                .text_sm()
                .text_color(color::muted())
                .child(format!("{percent}%")),
        )
        .child(
            Button::new(SharedString::from(format!(
                "{}-mute-{}",
                ops.prefix, slot.id
            )))
            .label(core(lang, keys::VST_MUTE))
            .outline()
            .small()
            .selected(slot.muted)
            .accessibility_label(named(keys::VST_MUTE_NAMED))
            .on_click(move |_, _, cx| send(command.clone(), cx)),
        )
}

/// 削除の前に確かめる。VST の中の設定は戻せないので、押し間違いで消さない。
fn confirm_remove(
    title: &str,
    remove: Command,
    lang: Lang,
    send: OnCommand,
    window: &mut Window,
    cx: &mut App,
) {
    let title = SharedString::from(title.to_owned());
    window.open_alert_dialog(cx, move |alert, _, _| {
        let send = send.clone();
        let remove = remove.clone();
        alert
            .title(title.clone())
            .description(core(lang, keys::VST_REMOVE_WARNING))
            .ok_text(core(lang, keys::VST_CONFIRM_REMOVE))
            .ok_variant(ButtonVariant::Danger)
            .cancel_text(core(lang, keys::CANCEL))
            .show_cancel(true)
            .on_ok(move |_, _, cx| {
                send(remove.clone(), cx);
                true
            })
    });
}
