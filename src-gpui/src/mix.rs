//! ホームの「配信ミックス」：声に、別の入力機器（仮想ケーブルなど）かアプリの音（オケ）を混ぜて、配信用の出力へ送る。
//! 規則は `auralyn-ui-model` の `mix`、エンジン側は `engine/mix.rs`。配信用の手動の時間差も変えられる（合わせたときの機材を一緒に記録する）。

use std::cell::Cell;
use std::rc::Rc;

use auralyn_ui_model::connect::{self, Device};
use auralyn_ui_model::mix::{self, Change, Field, Mix, OffsetStatus, Source};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::select::{Select, SelectEvent, SelectState};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::{Disableable as _, IndexPath, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::{Command, MixAction};
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note, OnCommand};

type Names = SelectState<Vec<SharedString>>;

/// オケに選べる機器（ID・表示名・チャンネル数）。
struct DeviceChoice {
    id: String,
    label: String,
    channels: u16,
}

/// 入力元の一覧の1行。機器のあとにアプリが並ぶ。
enum Choice<'a> {
    Device(&'a DeviceChoice),
    App(&'a mix::App),
}

/// 一覧を入れ直しても残したい選択。
enum Pick {
    Device {
        id: String,
        channels: Option<[usize; 2]>,
    },
    App {
        id: Option<String>,
        key: String,
        route: Option<String>,
    },
}

pub struct MixPanel {
    /// 最後に読めた状態。`None` はまだ読めていない。
    mix: Option<Mix>,
    /// 最後に読めなかった理由（次に読めたら消す）。
    read_failed: Option<String>,
    /// 最後の操作が断られた理由（次の操作が通るまで残す）。
    failed: Option<String>,
    devices: Vec<DeviceChoice>,
    apps: Vec<mix::App>,
    /// アプリの一覧が読めなかった理由（次に読めたら消す）。
    apps_failed: Option<String>,
    source: Entity<Names>,
    /// 機器ならチャンネルの組、アプリなら音を出している出力先。
    pair: Entity<Names>,
    /// 「二重再生や循環が起きないよう設定した」。入力元か2つ目の選択を選び直すと外れる。
    confirmed: Rc<Cell<bool>>,
    voice_gain: Entity<SliderState>,
    music_gain: Entity<SliderState>,
    /// 時間差（ms）の入力欄と、最後にエンジンの値を入れたときの値（入力中の文字を、同じ値の読み直しで消さない）。
    offset: Entity<InputState>,
    shown_offset: Option<i32>,
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
        let offset = cx.new(|cx| InputState::new(window, cx));
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
            // 入力に合わせて「適用」を使えるかを描き直す。Enter でも適用する。
            cx.subscribe(&offset, move |this, state, event: &InputEvent, cx| {
                if let InputEvent::PressEnter { .. } = event {
                    if let Some(ms) = mix::parse_offset(&state.read(cx).value()) {
                        send(this, Command::Mix(MixAction::Levels(Change::OffsetMs(ms))));
                    }
                }
                cx.notify();
            }),
        ];
        Self {
            mix: None,
            read_failed: None,
            failed: None,
            devices: Vec::new(),
            apps: Vec::new(),
            apps_failed: None,
            source,
            pair,
            confirmed,
            voice_gain,
            music_gain,
            offset,
            shown_offset: None,
            _subscriptions: subscriptions,
        }
    }

    /// 機器の一覧が届いた。声に使っている機器を除いて、オケの候補を入れ直す。
    pub fn set_devices(
        &mut self,
        devices: &[Device],
        voice_input: Option<&str>,
        lang: Lang,
        window: &mut Window,
        cx: &mut App,
    ) {
        let pick = self.picked(cx);
        let sources = mix::sources(devices, voice_input);
        let labels = connect::labels(&sources);
        self.devices = sources
            .iter()
            .zip(labels)
            .filter_map(|(d, label)| {
                Some(DeviceChoice {
                    id: d.id.clone()?,
                    label,
                    channels: d.channels,
                })
            })
            .collect();
        self.fill(pick, lang, window, cx);
    }

    /// アプリの一覧が届いた。
    pub fn set_apps(
        &mut self,
        result: Result<Vec<mix::App>, String>,
        lang: Lang,
        window: &mut Window,
        cx: &mut App,
    ) {
        match result {
            Ok(apps) => {
                let pick = self.picked(cx);
                self.apps_failed = None;
                self.apps = apps;
                self.fill(pick, lang, window, cx);
            }
            Err(message) => self.apps_failed = Some(message),
        }
    }

    /// オケを適用中か（ミックス後の VST を有効にする前提）。
    pub fn active(&self) -> bool {
        self.mix.as_ref().is_some_and(|m| m.active.is_some())
    }

    /// 変える操作の結果。
    pub fn done(&mut self, result: Result<(), String>) {
        self.failed = result.err();
    }

    /// 読めた状態・読めなかった理由。
    pub fn set(
        &mut self,
        result: Result<Mix, String>,
        lang: Lang,
        window: &mut Window,
        cx: &mut App,
    ) {
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
                    if self.shown_offset != Some(levels.offset_ms) {
                        self.shown_offset = Some(levels.offset_ms);
                        self.offset.update(cx, |s, cx| {
                            s.set_value(levels.offset_ms.to_string(), window, cx)
                        });
                    }
                }
                let first = self.mix.is_none();
                self.mix = Some(mix);
                if first {
                    self.fill(None, lang, window, cx);
                }
            }
            Err(message) => self.read_failed = Some(message),
        }
    }

    /// 入力元の行。
    fn choice(&self, row: usize) -> Option<Choice<'_>> {
        match self.devices.get(row) {
            Some(device) => Some(Choice::Device(device)),
            None => self.apps.get(row - self.devices.len()).map(Choice::App),
        }
    }

    fn selected(&self, cx: &App) -> Option<Choice<'_>> {
        self.choice(self.source.read(cx).selected_index(cx)?.row)
    }

    /// 今の選択（一覧を入れ直すときに残す）。
    fn picked(&self, cx: &App) -> Option<Pick> {
        let detail = self.pair.read(cx).selected_index(cx).map(|ix| ix.row);
        Some(match self.selected(cx)? {
            Choice::Device(device) => Pick::Device {
                id: device.id.clone(),
                channels: detail.and_then(|row| mix::pairs(device.channels).get(row).copied()),
            },
            Choice::App(app) => Pick::App {
                id: Some(app.id.clone()),
                key: app.key.clone(),
                route: detail.and_then(|row| Some(app.routes.get(row)?.id.clone())),
            },
        })
    }

    /// 入力元の選択肢を入れ、`pick`（無ければ適用中、それも無ければ保存）を選ぶ。
    fn fill(&mut self, pick: Option<Pick>, lang: Lang, window: &mut Window, cx: &mut App) {
        let pick = pick.or_else(|| {
            let mix = self.mix.as_ref()?;
            Some(match mix.active.clone().or(mix.saved.clone())? {
                Source::Device { input_id, channels } => Pick::Device {
                    id: input_id,
                    channels: Some(channels),
                },
                Source::App { key, route, .. } => Pick::App {
                    id: None,
                    key,
                    route: Some(route),
                },
            })
        });
        let names = self
            .devices
            .iter()
            .map(|d| SharedString::from(d.label.clone()))
            .chain(
                self.apps
                    .iter()
                    .map(|a| SharedString::from(app_label(lang, &a.name))),
            )
            .collect();
        let row = match &pick {
            Some(Pick::Device { id, .. }) => self.devices.iter().position(|d| d.id == *id),
            Some(Pick::App { id, key, route }) => {
                mix::find_app(&self.apps, id.as_deref(), key, route.as_deref())
                    .map(|row| row + self.devices.len())
            }
            None => None,
        };
        let before = self.chosen(cx).map(|(action, _)| action);
        self.source.update(cx, |state, cx| {
            state.set_items(names, window, cx);
            state.set_selected_index(row.map(IndexPath::new), window, cx);
        });
        self.fill_detail(row, pick, lang, window, cx);
        // 入れ直して選ぶものが変わったら、確かめ直すまで適用させない（選択を入れ直してもイベントは出ない）。
        if self.chosen(cx).map(|(action, _)| action) != before {
            self.confirmed.set(false);
        }
    }

    /// 2つ目の選択（機器ならチャンネルの組、アプリなら出力先）を入れ、`chosen`（無ければ先頭、アプリならミュート済みの先頭）を選ぶ。
    fn fill_detail(
        &self,
        row: Option<usize>,
        chosen: Option<Pick>,
        lang: Lang,
        window: &mut Window,
        cx: &mut App,
    ) {
        let (names, selected): (Vec<SharedString>, Option<usize>) =
            match row.and_then(|row| self.choice(row)) {
                Some(Choice::Device(device)) => {
                    let pairs = mix::pairs(device.channels);
                    let selected = match chosen {
                        Some(Pick::Device {
                            channels: Some(c), ..
                        }) => pairs.iter().position(|p| *p == c),
                        _ => None,
                    }
                    .or((!pairs.is_empty()).then_some(0));
                    let names = pairs.iter().map(|p| mix::pair_label(*p).into()).collect();
                    (names, selected)
                }
                Some(Choice::App(app)) => {
                    let selected = match chosen {
                        Some(Pick::App { route: Some(r), .. }) => {
                            app.routes.iter().position(|route| route.id == r)
                        }
                        _ => None,
                    }
                    .or((!app.routes.is_empty()).then_some(0));
                    let names = app
                        .routes
                        .iter()
                        .map(|r| route_label(lang, r).into())
                        .collect();
                    (names, selected)
                }
                None => (Vec::new(), None),
            };
        self.pair.update(cx, |state, cx| {
            state.set_items(names, window, cx);
            state.set_selected_index(selected.map(IndexPath::new), window, cx);
        });
    }

    /// 表示言語が変わった。選択欄の「(アプリ)」などを書き直す（選択と確認はそのまま）。
    pub fn relabel(&mut self, lang: Lang, window: &mut Window, cx: &mut App) {
        let pick = self.picked(cx);
        self.fill(pick, lang, window, cx);
    }

    /// 入力元を選び直したら、2つ目の選択を入れ直す（描画の前に呼ぶ）。
    pub fn source_changed(&self, lang: Lang, window: &mut Window, cx: &mut App) {
        let row = self.source.read(cx).selected_index(cx).map(|ix| ix.row);
        self.fill_detail(row, None, lang, window, cx);
    }

    pub fn source_state(&self) -> &Entity<Names> {
        &self.source
    }

    /// 選んでいるものを適用する操作と、そのまま適用できるか（アプリは出力先をミュートしてあること）。
    fn chosen(&self, cx: &App) -> Option<(MixAction, bool)> {
        let detail = self.pair.read(cx).selected_index(cx)?.row;
        Some(match self.selected(cx)? {
            Choice::Device(device) => (
                MixAction::Apply {
                    input_id: device.id.clone(),
                    channels: *mix::pairs(device.channels).get(detail)?,
                },
                true,
            ),
            Choice::App(app) => {
                let route = app.routes.get(detail)?;
                (
                    MixAction::ApplyApp {
                        candidate_id: app.id.clone(),
                        key: app.key.clone(),
                        name: app.name.clone(),
                        route: route.id.clone(),
                    },
                    app.usable_route()
                        .is_some_and(|usable| usable.id == route.id),
                )
            }
        })
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
        let app_chosen = matches!(self.selected(cx), Some(Choice::App(_)));
        let route_unmuted = app_chosen && !matches!(chosen, Some((_, true)));
        let confirmed = self.confirmed.get();
        let ready = output_ready == Some(true);
        let can_apply = ready
            && !mix.running
            && mix.error.is_none()
            && matches!(chosen, Some((_, true)))
            && confirmed;
        let current = |source: &Option<Source>| match source {
            Some(Source::Device { input_id, channels }) => format!(
                "{} ({})",
                self.devices
                    .iter()
                    .find(|d| d.id == *input_id)
                    .map_or(input_id.as_str(), |d| d.label.as_str()),
                mix::pair_label(*channels)
            ),
            Some(Source::App { name, .. }) => app_label(lang, name),
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
                .when(mix.failed, |this| {
                    this.child(warning(core(lang, keys::MIX_INPUT_FAILED).to_owned()))
                })
                .children(
                    [
                        self.read_failed.clone(),
                        self.failed.clone(),
                        mix.error.clone(),
                        self.apps_failed.clone(),
                    ]
                    .into_iter()
                    .flatten()
                    .map(warning),
                )
                // 保存が読めない・書き換えられたときは、読み直すまで変えられない（Tauri 版の「読み直す」）。
                .when(mix.error.is_some(), |this| {
                    let send = send.clone();
                    this.child(
                        Button::new("mix-reload")
                            .label(core(lang, keys::MIX_RELOAD))
                            .outline()
                            .disabled(mix.running)
                            .on_click(move |_, _, cx| send(Command::Mix(MixAction::Reload), cx)),
                    )
                })
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
                        .child({
                            let send = send.clone();
                            div().child(
                                Button::new("mix-apps")
                                    .label(core(lang, keys::MIX_REFRESH_APPS))
                                    .outline()
                                    .small()
                                    .disabled(mix.running)
                                    .on_click(move |_, _, cx| {
                                        send(Command::Mix(MixAction::Apps), cx)
                                    }),
                            )
                        })
                        .child(field(
                            lang,
                            if app_chosen {
                                keys::MIX_ROUTE
                            } else {
                                keys::MIX_CHANNELS
                            },
                            Select::new(&self.pair).disabled(mix.running),
                        ))
                        .when(app_chosen, |this| {
                            this.child(note(core(lang, keys::MIX_ROUTE_HELP)))
                        })
                        .when(route_unmuted, |this| {
                            this.child(warning(core(lang, keys::MIX_ROUTE_MUTE_FIRST).to_owned()))
                        })
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
                                                if let Some((action, true)) = chosen.clone() {
                                                    send(Command::Mix(action), cx);
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
                                ))
                                .child(self.offset_row(lang, &mix.offset, cx, send.clone())),
                        )
                    },
                ),
        )
        .into_any_element()
    }
}

impl MixPanel {
    /// 配信用の手動の時間差：入力欄と「適用」、説明、合わせたときと機材が違うときの知らせと「確認済みにする」。
    fn offset_row(
        &self,
        lang: Lang,
        status: &OffsetStatus,
        cx: &App,
        send: OnCommand,
    ) -> impl IntoElement {
        let typed = mix::parse_offset(&self.offset.read(cx).value());
        let changed = typed.is_some_and(|ms| Some(ms) != self.shown_offset);
        let label = |field: &Field| {
            core(
                lang,
                match field {
                    Field::VoiceInput => keys::MIX_OFFSET_VOICE_INPUT,
                    Field::VoiceChannels => keys::MIX_OFFSET_CHANNELS,
                    Field::Accompaniment => keys::MIX_MUSIC,
                    Field::Output => keys::MIX_OFFSET_OUTPUT,
                    Field::Broadcast => keys::MIX_OFFSET_BROADCAST,
                },
            )
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(field(
                lang,
                keys::MIX_OFFSET,
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div().w(px(120.)).child(
                            Input::new(&self.offset).aria_label(core(lang, keys::MIX_OFFSET)),
                        ),
                    )
                    .child({
                        let send = send.clone();
                        Button::new("mix-offset-apply")
                            .label(core(lang, keys::MIX_OFFSET_APPLY))
                            .outline()
                            .small()
                            .disabled(!changed)
                            .on_click(move |_, _, cx| {
                                if let Some(ms) = typed {
                                    send(Command::Mix(MixAction::Levels(Change::OffsetMs(ms))), cx);
                                }
                            })
                    }),
            ))
            .when(typed.is_none(), |this| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(color::warning())
                        .child(core(lang, keys::MIX_OFFSET_INVALID)),
                )
            })
            .child(note(core(lang, keys::MIX_OFFSET_HELP)))
            .map(|this| match status {
                OffsetStatus::Unconfirmed(fields) => {
                    let detail = if fields.is_empty() {
                        core(lang, keys::MIX_OFFSET_LEGACY).to_owned()
                    } else {
                        let names: Vec<&str> = fields.iter().map(label).collect();
                        core_with(
                            lang,
                            keys::MIX_OFFSET_CHANGED,
                            &[("fields", &names.join(" / "))],
                        )
                    };
                    this.child(note(format!(
                        "{} {detail}",
                        core(lang, keys::MIX_OFFSET_UNCONFIRMED)
                    )))
                    .child(
                        div().child(
                            Button::new("mix-offset-confirm")
                                .label(core(lang, keys::MIX_OFFSET_CONFIRM))
                                .outline()
                                .small()
                                .on_click(move |_, _, cx| {
                                    send(Command::Mix(MixAction::ConfirmOffset), cx)
                                }),
                        ),
                    )
                }
                OffsetStatus::Unknown => this.child(note(core(lang, keys::MIX_OFFSET_UNKNOWN))),
                OffsetStatus::None | OffsetStatus::Confirmed => this,
            })
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

/// アプリの行の表記：`名前 (アプリ)`。
fn app_label(lang: Lang, name: &str) -> String {
    format!("{name} ({})", core(lang, keys::MIX_APP))
}

/// 出力先の行の表記：`名前 (ミュート済み)`・`名前 (ミュートが必要)`。
fn route_label(lang: Lang, route: &mix::Route) -> String {
    let state = if route.muted {
        keys::MIX_ROUTE_MUTED
    } else {
        keys::MIX_ROUTE_NEEDS_MUTE
    };
    format!("{} ({})", route.name, core(lang, state))
}
