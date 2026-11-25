//! VST の画面：並び（上から音が通る順）と、追加。
//! 1つずつ ON/OFF・上下の入れ替え・編集（VST の窓）・削除ができる。候補の検索は `auralyn-ui-model` の `rack`。
//! 並びと VST の中の設定は、エンジンが変わるたびに保存する（`engine.rs`）。音量・ミュート・プロファイル・テンプレートは、まだこの画面に無い。

use std::rc::Rc;

use auralyn_ui_model::rack::Candidate;
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::empty::{Empty, EmptyDescription, EmptyHeader, EmptyTitle};
use gpui_kit::component::select::{SearchableVec, Select, SelectItem, SelectState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Sizable as _, WindowExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::{Command, Slot};
use crate::i18n::{core, core_with, keys, Lang};

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

type Choices = SelectState<SearchableVec<Choice>>;

/// 画面の操作は、エンジンへの命令としてそのまま送る。
pub type Send = Rc<dyn Fn(Command, &mut App)>;

pub struct VstPage {
    rack: Vec<Slot>,
    catalog: Entity<Choices>,
    /// 候補を探している。`None` はまだ一度も探していない。
    scanning: Option<bool>,
}

impl VstPage {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            rack: Vec::new(),
            catalog: cx.new(|cx| {
                SelectState::new(SearchableVec::new(Vec::new()), None, window, cx).searchable(true)
            }),
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

    pub fn set_rack(&mut self, rack: Vec<Slot>) {
        self.rack = rack;
    }

    pub fn set_catalog(&mut self, candidates: Vec<Candidate>, window: &mut Window, cx: &mut App) {
        self.scanning = Some(false);
        let choices = SearchableVec::new(candidates.into_iter().map(Choice).collect::<Vec<_>>());
        self.catalog.update(cx, |state, cx| {
            state.set_items(choices, window, cx);
            state.set_selected_index(None, window, cx);
        });
    }

    pub fn scan_failed(&mut self) {
        self.scanning = Some(false);
    }

    pub fn render(&self, lang: Lang, cx: &App, send: Send) -> impl IntoElement {
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
                    let last = self.rack.len() - 1;
                    this.child(
                        div()
                            .id("vst-rack")
                            .role(Role::List)
                            .flex()
                            .flex_col()
                            .gap_2()
                            .children(self.rack.iter().enumerate().map(|(index, slot)| {
                                row(slot, index, index == last, lang, send.clone())
                            })),
                    )
                }
            })
    }
}

/// 並びの1行。番号・名前（OFF の札）・ON/OFF・上へ・下へ・編集・削除。
fn row(slot: &Slot, index: usize, last: bool, lang: Lang, send: Send) -> impl IntoElement {
    let name = slot.name.as_str();
    let named = |key| core_with(lang, key, &[("arg0", &name)]);
    let button = |suffix: &str, label: &'static str, command: Command| {
        let send = send.clone();
        Button::new(SharedString::from(format!("vst-{suffix}-{}", slot.id)))
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
    } else {
        None
    };
    div()
        .id(SharedString::from(format!("vst-slot-{}", slot.id)))
        .role(Role::ListItem)
        .aria_label(name.to_owned())
        .flex()
        .items_center()
        .gap_2()
        .px_3()
        .py_2()
        .rounded(px(6.))
        .border_1()
        .border_color(color::border())
        .bg(color::card())
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
                Switch::new(SharedString::from(format!("vst-enable-{}", slot.id)))
                    .checked(enabled)
                    .accessibility_label(named(keys::VST_ENABLE))
                    .on_click(move |checked, _, cx| {
                        send(
                            Command::SetPluginEnabled {
                                id: id.clone(),
                                enabled: *checked,
                            },
                            cx,
                        )
                    })
            })
            .child(
                button(
                    "up",
                    core(lang, keys::VST_UP),
                    Command::MovePlugin {
                        id: slot.id.clone(),
                        up: true,
                    },
                )
                .accessibility_label(format!("{name} {}", core(lang, keys::VST_UP)))
                .disabled(index == 0),
            )
            .child(
                button(
                    "down",
                    core(lang, keys::VST_DOWN),
                    Command::MovePlugin {
                        id: slot.id.clone(),
                        up: false,
                    },
                )
                .accessibility_label(format!("{name} {}", core(lang, keys::VST_DOWN)))
                .disabled(last),
            )
            .child(
                button(
                    "edit",
                    core(lang, keys::VST_EDIT),
                    Command::OpenEditor(slot.id.clone()),
                )
                .accessibility_label(named(keys::VST_EDIT_NAMED)),
            )
        })
        .child(
            Button::new(SharedString::from(format!("vst-remove-{}", slot.id)))
                .label(core(lang, keys::VST_REMOVE))
                .ghost()
                .small()
                .accessibility_label(named(keys::VST_REMOVE_NAMED))
                .on_click({
                    let title = named(keys::VST_REMOVE_TITLE);
                    let id = slot.id.clone();
                    move |_, window, cx| confirm_remove(&title, &id, lang, send.clone(), window, cx)
                }),
        )
}

/// 削除の前に確かめる。VST の中の設定は戻せないので、押し間違いで消さない。
fn confirm_remove(
    title: &str,
    id: &str,
    lang: Lang,
    send: Send,
    window: &mut Window,
    cx: &mut App,
) {
    let title = SharedString::from(title.to_owned());
    let id = id.to_owned();
    window.open_alert_dialog(cx, move |alert, _, _| {
        let send = send.clone();
        let id = id.clone();
        alert
            .title(title.clone())
            .description(core(lang, keys::VST_REMOVE_WARNING))
            .ok_text(core(lang, keys::VST_CONFIRM_REMOVE))
            .ok_variant(ButtonVariant::Danger)
            .cancel_text(core(lang, keys::CANCEL))
            .show_cancel(true)
            .on_ok(move |_, _, cx| {
                send(Command::RemovePlugin(id.clone()), cx);
                true
            })
    });
}
