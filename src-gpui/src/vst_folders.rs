//! VST の画面の「探すフォルダー」（Tauri 版の `ScanFolders`）。標準の2つに足すフォルダーを選び、変えたら探し直す。
//! 規則は `auralyn-ui-model` の `scan_folders`、保存は `scan_file`。使えなかったフォルダーはスキャンの結果で届く。

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use auralyn_ui_model::scan_folders::{self, Reject, STANDARD};
use gpui_kit::assets::IconName;
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

/// 一覧の状態と保存先。クリックと Enter の両方から使うので、まとめて渡す。
#[derive(Clone)]
struct Store {
    config_dir: Rc<PathBuf>,
    folders: Rc<RefCell<Folders>>,
    draft: Entity<InputState>,
}

impl Store {
    /// 保存できたら一覧を替えて `true`（このあと探し直す）。断られたら理由を残す。
    fn commit(&self, next: Result<Vec<String>, Reject>) -> bool {
        let mut folders = self.folders.borrow_mut();
        let next = match next {
            Ok(next) => next,
            Err(reject) => {
                folders.error = Some(reject_key(reject));
                return false;
            }
        };
        if let Err(error) = crate::scan_file::save(&self.config_dir, &next) {
            log::warn!("探すフォルダーを保存できません: {error}");
            folders.error = Some(keys::SCAN_FOLDER_SAVE_FAILED);
            return false;
        }
        folders.list = next;
        folders.error = None;
        true
    }

    fn add(&self, window: &mut Window, cx: &mut App) -> bool {
        let raw = self.draft.read(cx).value().to_string();
        let next = scan_folders::add(&self.folders.borrow().list, &raw);
        let added = self.commit(next);
        if added {
            self.draft
                .update(cx, |input, cx| input.set_value("", window, cx));
        }
        window.refresh();
        added
    }

    fn remove(&self, path: &str) -> bool {
        let next = scan_folders::remove(&self.folders.borrow().list, path);
        self.commit(Ok(next))
    }
}

pub struct ScanFolders {
    store: Store,
    /// 前のスキャンで探さなかった追加のフォルダー。
    skipped: Vec<SkippedScanRoot>,
}

impl ScanFolders {
    pub fn new<V: 'static>(config_dir: &Path, window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            store: Store {
                config_dir: Rc::new(config_dir.to_path_buf()),
                folders: Rc::new(RefCell::new(Folders {
                    list: crate::scan_file::load(config_dir),
                    ..Folders::default()
                })),
                draft: cx.new(|cx| InputState::new(window, cx)),
            },
            skipped: Vec::new(),
        }
    }

    pub fn draft(&self) -> &Entity<InputState> {
        &self.store.draft
    }

    /// 入力欄のフォルダーを足す。足せたら `true`（探し直す）。
    pub fn add(&self, window: &mut Window, cx: &mut App) -> bool {
        self.store.add(window, cx)
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
        let folders = self.store.folders.borrow();
        let has_issue = folders.list.iter().any(|path| self.issue(path).is_some());
        let open = folders.open.unwrap_or(has_issue);
        let count = STANDARD.len() + folders.list.len();
        let toggle = {
            let state = self.store.folders.clone();
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
        .icon(IconName::FolderSearch)
        .hint(lang, core(lang, keys::SCAN_FOLDERS_HINT))
    }

    fn render_body(
        &self,
        lang: Lang,
        busy: bool,
        folders: &Folders,
        send: OnCommand,
    ) -> impl IntoElement {
        let add = {
            let store = self.store.clone();
            let send = send.clone();
            move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                if store.add(window, cx) {
                    send(Command::ScanPlugins, cx);
                }
            }
        };
        let path_label = core(lang, keys::SCAN_FOLDER_PATH);
        div()
            .flex()
            .flex_col()
            .gap_2()
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
                    let store = self.store.clone();
                    let send = send.clone();
                    let path = path.clone();
                    move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                        if store.remove(&path) {
                            send(Command::ScanPlugins, cx);
                        }
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
                            .disabled(busy)
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
                                Input::new(&self.store.draft)
                                    .aria_label(path_label)
                                    .disabled(busy),
                            ),
                    )
                    .child(
                        Button::new("scan-folder-add")
                            .label(core(lang, keys::SCAN_FOLDER_ADD))
                            .outline()
                            .disabled(busy)
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
