//! 保存した構成（Tauri 版と同じ `presets/` のファイル）：選んで適用する・直前の状態に戻す・今の設定を名前を付けて保存する・
//! 削除する・ファイルへ書き出す・ファイルから読み込む。
//! VST の画面の下に出す。読み書きするのは VST の並び・ノイズ低減・声を整える設定だけで、接続は変えない。
//! 一覧に出すものと保存する名前の規則は `auralyn-ui-model` の `profile`。

use auralyn_ui_model::profile::{self, Entry, ImportIssue, NameIssue};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::component::{Disableable as _, WindowExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::{Command, ProfileFile};
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note, open_file, paragraphs, save_as, OnCommand};

type Names = SelectState<Vec<SharedString>>;

pub struct SetupsPanel {
    entries: Vec<Entry>,
    chosen: Entity<Names>,
    /// 保存する名前。書き換えるたびに描き直し、Enter で保存する（`MainView` が購読する）。
    pub name: Entity<InputState>,
    /// 直前の書き出し・読み込みの結果。
    done: Option<ProfileFile>,
}

impl SetupsPanel {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            entries: Vec::new(),
            chosen: cx.new(|cx| SelectState::new(Vec::new(), None, window, cx)),
            name: cx.new(|cx| InputState::new(window, cx)),
            done: None,
        }
    }

    /// 一覧を替える。保存した名前が一覧に入ったら、名前の欄を空にする。前の書き出し・読み込みの結果は消す
    /// （読み込みの結果は、このあとに届く）。
    pub fn set(&mut self, entries: Vec<Entry>, window: &mut Window, cx: &mut App) {
        self.done = None;
        let names: Vec<SharedString> = profile::choices(&entries)
            .into_iter()
            .map(SharedString::from)
            .collect();
        // 選んでいた構成が一覧に残っていれば、`set_items` が選んだままにする。
        self.chosen
            .update(cx, |state, cx| state.set_items(names, window, cx));
        let typed = self.name.read(cx).value();
        if profile::save_name(&typed, &entries) == Err(NameIssue::Exists) {
            self.name
                .update(cx, |state, cx| state.set_value("", window, cx));
        }
        self.entries = entries;
    }

    /// 書き出し・読み込みの結果を出す。読み込んだ構成は、そのまま適用できるように選んでおく。
    pub fn set_done(&mut self, done: ProfileFile, window: &mut Window, cx: &mut App) {
        if let ProfileFile::Imported(name) = &done {
            let name = SharedString::from(name.clone());
            self.chosen
                .update(cx, |state, cx| state.set_selected_value(&name, window, cx));
        }
        self.done = Some(done);
    }

    /// 命令が失敗したら、前の結果は出さない（成功したように読めるので）。
    pub fn forget_done(&mut self) {
        self.done = None;
    }

    /// 保存の命令。名前が空か、同じ名前があれば作らない。
    pub fn save(&self, cx: &App) -> Option<Command> {
        let typed = self.name.read(cx).value();
        profile::save_name(&typed, &self.entries)
            .ok()
            .map(Command::SaveProfile)
    }

    /// 音楽鑑賞のホームに置く、構成の切り替えだけの区画（Tauri 版の `MusicHomeDesk`）。構成が無ければ出さない。
    /// 選択は VST の画面の区画と同じものを使う。
    pub fn render_music(&self, lang: Lang, cx: &App, send: OnCommand) -> Option<impl IntoElement> {
        if profile::choices(&self.entries).is_empty() {
            return None;
        }
        let chosen = self.chosen.read(cx).selected_value().cloned();
        Some(
            card(
                core(lang, keys::MUSIC_PLAYBACK),
                div(),
                div().flex().flex_col().gap_2().child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child(
                            div().flex_1().min_w(px(200.)).child(
                                Select::new(&self.chosen)
                                    .placeholder(core(lang, keys::MUSIC_PRESET_CHOOSE))
                                    .accessibility_label(core(lang, keys::MUSIC_PRESET_LABEL)),
                            ),
                        )
                        .child(
                            Button::new("music-setup-apply")
                                .label(core(lang, keys::SETUPS_APPLY))
                                .outline()
                                .disabled(chosen.is_none())
                                .on_click(move |_, _, cx| {
                                    if let Some(name) = chosen.clone() {
                                        send(
                                            Command::ApplyProfile {
                                                name: name.to_string(),
                                                restore: false,
                                            },
                                            cx,
                                        );
                                    }
                                }),
                        ),
                ),
            )
            .icon(IconName::ListMusic)
            .hint(lang, core(lang, keys::MUSIC_SOUND_HINT)),
        )
    }

    pub fn render(&self, lang: Lang, cx: &App, send: OnCommand) -> impl IntoElement {
        let chosen = self.chosen.read(cx).selected_value().cloned();
        let backup = profile::backup_name(&self.entries).map(str::to_owned);
        let typed = self.name.read(cx).value();
        // 何も書いていないうちは何も出さない（保存のボタンが押せないだけ）。
        let exists = profile::save_name(&typed, &self.entries) == Err(NameIssue::Exists);
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
                            let chosen = chosen.clone();
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
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child({
                            let chosen = chosen.clone();
                            let send = send.clone();
                            Button::new("setup-export")
                                .label(core(lang, keys::SETUPS_EXPORT))
                                .ghost()
                                .disabled(chosen.is_none())
                                .on_click(move |_, _, cx| {
                                    if let Some(name) = chosen.clone() {
                                        let name = name.to_string();
                                        let send = send.clone();
                                        let file = format!("{name}.auralyn-preset.json");
                                        save_as(file, cx, move |path, cx| {
                                            send(Command::ExportProfile { name, path }, cx)
                                        });
                                    }
                                })
                        })
                        .child({
                            let send = send.clone();
                            Button::new("setup-import")
                                .label(core(lang, keys::SETUPS_IMPORT))
                                .ghost()
                                .on_click(move |_, _, cx| {
                                    let send = send.clone();
                                    open_file(cx, move |path, cx| {
                                        send(Command::ImportProfile(path), cx)
                                    });
                                })
                        })
                        .child({
                            let chosen = chosen.clone();
                            let send = send.clone();
                            Button::new("setup-delete")
                                .label(core(lang, keys::SETUPS_DELETE))
                                .ghost()
                                .disabled(chosen.is_none())
                                .on_click(move |_, window, cx| {
                                    if let Some(name) = chosen.clone() {
                                        confirm_delete(
                                            name.to_string(),
                                            lang,
                                            send.clone(),
                                            window,
                                            cx,
                                        );
                                    }
                                })
                        }),
                )
                .when_some(self.done.as_ref(), |this, done| {
                    this.child(note(done_text(done, lang)))
                })
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
                        .when(exists, |this| {
                            this.child(note(core(lang, keys::SETUPS_EXISTS)))
                        }),
                ),
        )
        .icon(IconName::Layers)
        .hint(
            lang,
            paragraphs(
                lang,
                &[
                    keys::SETUPS_LEAD,
                    keys::SETUPS_SCOPE,
                    keys::SETUPS_BACKED_UP,
                ],
            ),
        )
    }
}

fn done_text(done: &ProfileFile, lang: Lang) -> String {
    match done {
        ProfileFile::Exported(name) => core_with(lang, keys::SETUPS_EXPORTED, &[("arg0", name)]),
        ProfileFile::Imported(name) => core_with(lang, keys::SETUPS_IMPORTED, &[("arg0", name)]),
        ProfileFile::NotImported(ImportIssue::Exists(name)) => {
            core_with(lang, keys::SETUPS_IMPORT_EXISTS, &[("arg0", name)])
        }
        ProfileFile::NotImported(ImportIssue::NothingToApply) => {
            core(lang, keys::SETUPS_IMPORT_NOTHING).to_owned()
        }
        ProfileFile::NotImported(ImportIssue::Invalid) => {
            core(lang, keys::SETUPS_IMPORT_INVALID).to_owned()
        }
    }
}

/// 削除の前に確かめる。構成のファイルは戻せないので、押し間違いで消さない。
fn confirm_delete(name: String, lang: Lang, send: OnCommand, window: &mut Window, cx: &mut App) {
    let title = SharedString::from(core_with(
        lang,
        keys::SETUPS_DELETE_TITLE,
        &[("arg0", &name)],
    ));
    window.open_alert_dialog(cx, move |alert, _, _| {
        let send = send.clone();
        let name = name.clone();
        alert
            .title(title.clone())
            .description(core(lang, keys::SETUPS_DELETE_WARNING))
            .ok_text(core(lang, keys::SETUPS_CONFIRM_DELETE))
            .ok_variant(ButtonVariant::Danger)
            .cancel_text(core(lang, keys::CANCEL))
            .show_cancel(true)
            .on_ok(move |_, _, cx| {
                send(Command::DeleteProfile(name.clone()), cx);
                true
            })
    });
}
