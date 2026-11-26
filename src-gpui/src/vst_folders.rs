//! VST の画面の「探すフォルダー」（Tauri 版の `ScanFolders`）。標準の2つに足すフォルダーを選び、変えたら探し直す。
//! 規則は `auralyn-ui-model` の `scan_folders`、保存は `scan_file`。使えなかったフォルダーはスキャンの結果で届く。

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use auralyn_ui_model::scan_folders::{self, Reject, STANDARD};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Disableable as _, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use vst_host_lib::vst_host::scanner::{SkippedScanRoot, SkippedScanRootReason};

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{note, OnCommand};

#[derive(Default)]
struct Folders {
    list: Vec<String>,
    /// 追加・外すのが断られた理由（文言の鍵）。
    error: Option<&'static str>,
    /// 利用者が開閉を選んだ。`None` の間は、追加したフォルダーが使えなかったときだけ開く。
    open: Option<bool>,
}

pub struct ScanFolders {
    config_dir: PathBuf,
    folders: Rc<RefCell<Folders>>,
    draft: Entity<InputState>,
    /// 前のスキャンで探さなかった追加のフォルダー。
    skipped: Vec<SkippedScanRoot>,
}

impl ScanFolders {
    pub fn new<V: 'static>(config_dir: &Path, window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            config_dir: config_dir.to_path_buf(),
            folders: Rc::new(RefCell::new(Folders {
                list: crate::scan_file::load(config_dir),
                ..Folders::default()
            })),
            draft: cx.new(|cx| InputState::new(window, cx)),
            skipped: Vec::new(),
        }
    }

    pub fn set_skipped(&mut self, skipped: Vec<SkippedScanRoot>) {
        self.skipped = skipped;
    }

    fn issue(&self, path: &str) -> Option<&'static str> {
        let key = scan_folders::key(path);
        self.skipped
            .iter()
            .find(|item| scan_folders::key(&item.path) == key)
            .map(|item| match item.reason {
                SkippedScanRootReason::Missing => keys::SCAN_FOLDER_MISSING,
                SkippedScanRootReason::NotDirectory => keys::SCAN_FOLDER_NOT_DIRECTORY,
                SkippedScanRootReason::Invalid => keys::SCAN_FOLDER_INVALID,
            })
    }

    /// `busy` はスキャン中（変えられない）。
    pub fn render(&self, lang: Lang, busy: bool, send: OnCommand) -> impl IntoElement {
        let folders = self.folders.borrow();
        let has_issue = folders.list.iter().any(|path| self.issue(path).is_some());
        let open = folders.open.unwrap_or(has_issue);
        let count = STANDARD.len() + folders.list.len();
        let toggle = {
            let state = self.folders.clone();
            move |_: &ClickEvent, window: &mut Window, _: &mut App| {
                state.borrow_mut().open = Some(!open);
                window.refresh();
            }
        };
        crate::part::card(
            core(lang, keys::SCAN_FOLDERS),
            Button::new("scan-folders-toggle")
                .label(core_with(
                    lang,
                    keys::SCAN_FOLDER_COUNT,
                    &[("count", &count)],
                ))
                .ghost()
                .small()
                .on_click(toggle),
            div().when(open, |this| {
                this.child(self.render_body(lang, busy, &folders, send))
            }),
        )
    }

    fn render_body(
        &self,
        lang: Lang,
        busy: bool,
        folders: &Folders,
        send: OnCommand,
    ) -> impl IntoElement {
        let commit = {
            let state = self.folders.clone();
            let config_dir = self.config_dir.clone();
            move |next: Result<Vec<String>, Reject>, cx: &mut App| -> bool {
                let mut folders = state.borrow_mut();
                let next = match next {
                    Ok(next) => next,
                    Err(reject) => {
                        folders.error = Some(reject_key(reject));
                        return false;
                    }
                };
                if let Err(error) = crate::scan_file::save(&config_dir, &next) {
                    log::warn!("探すフォルダーを保存できません: {error}");
                    folders.error = Some(keys::SCAN_FOLDER_SAVE_FAILED);
                    return false;
                }
                folders.list = next;
                folders.error = None;
                drop(folders);
                send(Command::ScanPlugins, cx);
                true
            }
        };
        let commit = Rc::new(commit);
        let add = {
            let commit = commit.clone();
            let state = self.folders.clone();
            let draft = self.draft.clone();
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                let raw = draft.read(cx).value().to_string();
                let next = scan_folders::add(&state.borrow().list, &raw);
                if commit(next, cx) {
                    draft.update(cx, |input, cx| input.set_value("", window, cx));
                }
                window.refresh();
            }
        };
        let path_label = core(lang, keys::SCAN_FOLDER_PATH);
        let disabled = busy;
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(note(core(lang, keys::SCAN_FOLDERS_HINT)))
            .children(STANDARD.iter().map(|path| {
                div()
                    .flex()
                    .justify_between()
                    .gap_2()
                    .text_sm()
                    .child(div().min_w_0().child(*path))
                    .child(note(core(lang, keys::SCAN_FOLDER_STANDARD)))
            }))
            .children(folders.list.iter().enumerate().map(|(index, path)| {
                let remove = {
                    let commit = commit.clone();
                    let state = self.folders.clone();
                    let path = path.clone();
                    move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                        let next = scan_folders::remove(&state.borrow().list, &path);
                        commit(Ok(next), cx);
                        window.refresh();
                    }
                };
                div()
                    .flex()
                    .items_start()
                    .justify_between()
                    .gap_2()
                    .text_sm()
                    .child(
                        div()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(path.clone())
                            .when_some(self.issue(path), |this, issue| {
                                this.child(
                                    div().text_color(color::warning()).child(core(lang, issue)),
                                )
                            }),
                    )
                    .child(
                        Button::new(SharedString::from(format!("scan-folder-remove-{index}")))
                            .label(core(lang, keys::SCAN_FOLDER_REMOVE))
                            .accessibility_label(core_with(
                                lang,
                                keys::SCAN_FOLDER_REMOVE_NAMED,
                                &[("path", path)],
                            ))
                            .outline()
                            .small()
                            .disabled(disabled)
                            .on_click(remove),
                    )
            }))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_end()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(192.))
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().text_sm().child(path_label))
                            .child(
                                Input::new(&self.draft)
                                    .aria_label(path_label)
                                    .disabled(disabled),
                            ),
                    )
                    .child(
                        Button::new("scan-folder-add")
                            .label(core(lang, keys::SCAN_FOLDER_ADD))
                            .outline()
                            .disabled(disabled)
                            .on_click(add),
                    ),
            )
            .when_some(folders.error, |this, error| {
                this.child(
                    div()
                        .text_sm()
                        .text_color(color::warning())
                        .child(core(lang, error)),
                )
            })
    }
}

fn reject_key(reject: Reject) -> &'static str {
    match reject {
        Reject::Empty => keys::SCAN_FOLDER_EMPTY,
        Reject::Duplicate => keys::SCAN_FOLDER_DUPLICATE,
        Reject::Invalid => keys::SCAN_FOLDER_INVALID,
        Reject::Full => keys::SCAN_FOLDER_FULL,
    }
}
