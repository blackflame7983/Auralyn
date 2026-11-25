//! 保存した構成（Tauri 版と同じ `presets/` のファイル）：選んで適用する・直前の状態に戻す・今の設定を名前を付けて保存する。
//! VST の画面の下に出す。読み書きするのは VST の並び・ノイズ低減・声を整える設定だけで、接続は変えない。
//! 一覧に出すものと保存する名前の規則は `auralyn-ui-model` の `profile`。

use auralyn_ui_model::profile::{self, Entry, NameIssue};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::component::{Disableable as _, IndexPath};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, keys, Lang};
use crate::part::{card, note};
use crate::vst::Send;

type Names = SelectState<Vec<SharedString>>;

pub struct SetupsPanel {
    entries: Vec<Entry>,
    chosen: Entity<Names>,
    /// 保存する名前。書き換えるたびに描き直し、Enter で保存する（`MainView` が購読する）。
    pub name: Entity<InputState>,
}

impl SetupsPanel {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            entries: Vec::new(),
            chosen: cx.new(|cx| SelectState::new(Vec::new(), None, window, cx)),
            name: cx.new(|cx| InputState::new(window, cx)),
        }
    }

    /// 一覧を替える。選んでいた構成が残っていれば選んだままにする。保存した名前が一覧に入ったら、名前の欄を空にする。
    pub fn set(&mut self, entries: Vec<Entry>, window: &mut Window, cx: &mut App) {
        let before = self.chosen.read(cx).selected_value().cloned();
        let names: Vec<SharedString> = profile::choices(&entries)
            .into_iter()
            .map(SharedString::from)
            .collect();
        let row = before.and_then(|name| names.iter().position(|n| *n == name));
        self.chosen.update(cx, |state, cx| {
            state.set_items(names, window, cx);
            state.set_selected_index(row.map(IndexPath::new), window, cx);
        });
        let typed = self.name.read(cx).value();
        if profile::save_name(&typed, &entries) == Err(NameIssue::Exists) {
            self.name
                .update(cx, |state, cx| state.set_value("", window, cx));
        }
        self.entries = entries;
    }

    /// 保存の命令。名前が空か、同じ名前があれば作らない。
    pub fn save(&self, cx: &App) -> Option<Command> {
        let typed = self.name.read(cx).value();
        profile::save_name(&typed, &self.entries)
            .ok()
            .map(Command::SaveProfile)
    }

    pub fn render(&self, lang: Lang, cx: &App, send: Send) -> impl IntoElement {
        let chosen = self.chosen.read(cx).selected_value().cloned();
        let backup = profile::backup_name(&self.entries).map(str::to_owned);
        let typed = self.name.read(cx).value();
        let issue = profile::save_name(&typed, &self.entries).err();
        let save = self.save(cx);
        let apply = {
            let send = send.clone();
            move |name: String, restore: bool, cx: &mut App| {
                send(Command::ApplyProfile { name, restore }, cx)
            }
        };
        card(
            core(lang, keys::SETUPS),
            div(),
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(note(core(lang, keys::SETUPS_LEAD)))
                .child(note(core(lang, keys::SETUPS_SCOPE)))
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child(
                            div().flex_1().min_w(px(200.)).child(
                                Select::new(&self.chosen)
                                    .placeholder(core(lang, keys::SETUPS_CHOOSE))
                                    .empty(move |_, _| {
                                        div().p_2().text_sm().child(core(lang, keys::SETUPS_EMPTY))
                                    })
                                    .accessibility_label(core(lang, keys::SETUPS)),
                            ),
                        )
                        .child({
                            let apply = apply.clone();
                            Button::new("setup-apply")
                                .label(core(lang, keys::SETUPS_APPLY))
                                .outline()
                                .disabled(chosen.is_none())
                                .on_click(move |_, _, cx| {
                                    if let Some(name) = chosen.clone() {
                                        apply(name.to_string(), false, cx);
                                    }
                                })
                        })
                        .when_some(backup, |this, name| {
                            this.child(
                                Button::new("setup-restore")
                                    .label(core(lang, keys::SETUPS_RESTORE))
                                    .ghost()
                                    .on_click(move |_, _, cx| apply(name.clone(), true, cx)),
                            )
                        }),
                )
                .child(note(core(lang, keys::SETUPS_BACKED_UP)))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1p5()
                        .pt_3()
                        .border_t_1()
                        .border_color(color::border())
                        .child(
                            div()
                                .text_sm()
                                .font_weight(FontWeight::MEDIUM)
                                .child(core(lang, keys::SETUPS_NAME)),
                        )
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(div().flex_1().child(Input::new(&self.name)))
                                .child(
                                    Button::new("setup-save")
                                        .label(core(lang, keys::SETUPS_SAVE))
                                        .outline()
                                        .disabled(save.is_none())
                                        .on_click(move |_, _, cx| {
                                            if let Some(command) = save.clone() {
                                                send(command, cx);
                                            }
                                        }),
                                ),
                        )
                        .when_some(issue, |this, issue| {
                            this.child(note(core(
                                lang,
                                match issue {
                                    NameIssue::Empty => keys::SETUPS_NAME_NEEDED,
                                    NameIssue::Exists => keys::SETUPS_EXISTS,
                                },
                            )))
                        }),
                ),
        )
    }
}
