//! 音づくりの画面の「歌・雑談モード」：今の音づくりを歌・雑談として登録し、本番中に切り替える。操作ロックもここ。
//! 判断の規則は `auralyn-ui-model` の `live_modes`（Tauri 版と同じ）。VST を一緒に切り替える組み合わせは、まだ扱わない。

use std::cell::Cell;
use std::rc::Rc;

use auralyn_ui_model::live_modes::{self, LiveModes, Mode};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::Button;
use gpui_kit::component::{Disableable as _, Selectable as _, Sizable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::{Command, ModeAction};
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note, with_hint, OnCommand};

#[derive(Default)]
pub struct ModesPanel {
    /// 最後に読めた状態。読めなかったときも消さない（上の帯の札やロックの表示が点滅しないように）。
    state: Option<LiveModes>,
    /// 最後の読み込みが失敗した理由。次に読めたら消す。
    read_error: Option<String>,
    /// 直前の操作が断られた理由。
    failed: Option<String>,
    /// 雑談の登録が、残響が ON のため止まった。切ってから登録するかを聞く（取り消しはボタンから直接外す）。
    keeps_reverb: Rc<Cell<bool>>,
}

impl ModesPanel {
    /// 状態を入れ替える。`true` なら音づくりを読み直す（`live_modes::reload_after`）。
    pub fn set(&mut self, state: Result<LiveModes, String>) -> bool {
        let state = match state {
            Ok(state) => state,
            Err(error) => {
                self.read_error = Some(error);
                return false;
            }
        };
        self.read_error = None;
        let reload = live_modes::reload_after(self.state.as_ref(), &state);
        self.state = Some(state);
        reload
    }

    fn current(&self) -> Option<&LiveModes> {
        self.state.as_ref()
    }

    /// 定期的に読み直すか。まだ読めていなければ読めるまで。
    pub fn polls(&self) -> bool {
        self.current().is_none_or(LiveModes::polls)
    }

    /// 操作ロック中（最後に読んだ状態で）。
    pub fn armed(&self) -> bool {
        self.current().is_some_and(|m| m.armed)
    }

    /// 上の帯に出す札：かかっている（切り替え中なら切り替え先の）モードと、操作ロック中か。停止中もロックは出す。
    pub fn badges(&self, lang: Lang) -> Vec<SharedString> {
        let Some(modes) = self.current() else {
            return Vec::new();
        };
        let mode = modes.shown_mode().map(|(mode, switching)| {
            let name = core(lang, mode_name(mode));
            if switching {
                core_with(lang, keys::MODES_SWITCHING, &[("mode", &name)])
            } else {
                name.to_string()
            }
        });
        let lock = modes
            .armed
            .then(|| core(lang, keys::MODES_PROTECTING).to_string());
        mode.into_iter()
            .chain(lock)
            .map(SharedString::from)
            .collect()
    }

    /// 変える操作の結果。
    pub fn done(&mut self, result: Result<(), String>) {
        self.failed = result.err();
        self.keeps_reverb.set(false);
    }

    pub fn keeps_reverb(&mut self) {
        self.failed = None;
        self.keeps_reverb.set(true);
    }

    pub fn render(&self, lang: Lang, send: OnCommand) -> impl IntoElement {
        let body = div().flex().flex_col().gap_3();
        let body = match &self.read_error {
            Some(error) => body
                .child(warning(format!(
                    "{} {error}",
                    core(lang, keys::MODES_STATE_FAILED)
                )))
                .child(refresh(lang, send.clone())),
            None => body,
        };
        let body = match &self.state {
            None if self.read_error.is_none() => body.child(note(core(lang, keys::MODES_UNREAD))),
            None => body,
            Some(modes) => self.render_modes(modes, body, lang, send.clone()),
        };
        card(core(lang, keys::MODES_TITLE), div(), body)
            .icon(IconName::MicVocal)
            .hint(lang, core(lang, keys::MODES_HINT))
    }

    fn render_modes(&self, modes: &LiveModes, body: Div, lang: Lang, send: OnCommand) -> Div {
        let name = |mode| core(lang, mode_name(mode));
        let status = if modes.switching() {
            Some(core_with(
                lang,
                keys::MODES_SWITCHING,
                &[("mode", &modes.target.map(name).unwrap_or_default())],
            ))
        } else if !modes.singing_saved && !modes.talk_saved {
            Some(core(lang, keys::MODES_FIRST).to_owned())
        } else if modes.phase == "partial" {
            Some(core(lang, keys::MODES_PARTIAL).to_owned())
        } else if !modes.running && (modes.singing_saved || modes.talk_saved) {
            Some(core(lang, keys::MODES_STOPPED).to_owned())
        } else if modes.phase == "custom" && (modes.singing_saved || modes.talk_saved) {
            Some(core(lang, keys::MODES_CUSTOM).to_owned())
        } else {
            None
        };
        let selected = modes.selected();
        body.child(
            div()
                .flex()
                .flex_wrap()
                .gap_2()
                .children(Mode::ALL.map(|mode| {
                    let send = send.clone();
                    Button::new(SharedString::from(format!("mode-{mode:?}")))
                        .label(name(mode))
                        .outline()
                        .selected(selected == Some(mode))
                        .disabled(!modes.can_select(mode))
                        .on_click(move |_, _, cx| {
                            send(Command::Modes(ModeAction::Select(mode)), cx)
                        })
                })),
        )
        .when_some(status, |this, status| this.child(note(status)))
        .when(modes.singing_linked || modes.talk_linked, |this| {
            this.child(note(core(lang, keys::MODES_LINKED)))
        })
        .when_some(modes.transaction.as_ref(), |this, transaction| {
            this.child(warning(core(
                lang,
                if transaction.busy() {
                    keys::MODES_TRANSACTION_RUNNING
                } else {
                    keys::MODES_TRANSACTION_FAILED
                },
            )))
            .when_some(transaction.error.clone(), |this, error| {
                this.child(note(error))
            })
        })
        .when(modes.recoverable(), |this| {
            let send = send.clone();
            this.child(
                div().child(
                    Button::new("mode-recover")
                        .label(core(lang, keys::MODES_RECOVER))
                        .outline()
                        .on_click(move |_, _, cx| send(Command::Modes(ModeAction::Recover), cx)),
                ),
            )
        })
        .when_some(modes.error.clone(), |this, error| {
            this.child(warning(error))
        })
        .when_some(self.failed.clone(), |this, error| {
            this.child(warning(format!(
                "{} {error}",
                core(lang, keys::MODES_FAILED)
            )))
            .child(refresh(lang, send.clone()))
        })
        .child(self.render_save(modes, lang, send))
    }

    /// 右の列に置く操作ロック。どの画面からでも1手でロック・解除できる。状態をまだ読めていなければ出さない。
    pub fn render_lock(&self, lang: Lang, send: OnCommand) -> Option<impl IntoElement> {
        self.current().map(|modes| protect(modes, lang, send))
    }

    /// 今の音づくりを歌・雑談として登録する。雑談で残響が ON なら、切ってから登録するかを聞く。
    fn render_save(&self, modes: &LiveModes, lang: Lang, send: OnCommand) -> impl IntoElement {
        let saved = |mode| {
            core(
                lang,
                if modes.saved(mode) {
                    keys::MODES_SAVED
                } else {
                    keys::MODES_UNSAVED
                },
            )
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                with_hint(
                    "modes-register-hint",
                    lang,
                    core(lang, keys::MODES_REGISTER_NOTE),
                    div()
                        .font_weight(FontWeight::MEDIUM)
                        .child(core(lang, keys::MODES_REGISTER)),
                )
                .text_sm(),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_2()
                    .children(Mode::ALL.map(|mode| {
                        let send = send.clone();
                        Button::new(SharedString::from(format!("mode-save-{mode:?}")))
                            .label(format!(
                                "{}（{}）",
                                core(lang, save_label(mode)),
                                saved(mode)
                            ))
                            .outline()
                            .small()
                            .disabled(!modes.can_save())
                            .on_click(move |_, _, cx| {
                                send(
                                    Command::Modes(ModeAction::Save {
                                        mode,
                                        drop_reverb: false,
                                    }),
                                    cx,
                                )
                            })
                    })),
            )
            .when(self.keeps_reverb.get(), |this| {
                let asking = self.keeps_reverb.clone();
                this.child(note(core(lang, keys::MODES_REVERB_CONFIRM)))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .child(
                                Button::new("mode-save-without-reverb")
                                    .label(core(lang, keys::MODES_WITHOUT_REVERB))
                                    .outline()
                                    .small()
                                    .disabled(!modes.can_save())
                                    .on_click(move |_, _, cx| {
                                        send(
                                            Command::Modes(ModeAction::Save {
                                                mode: Mode::Talk,
                                                drop_reverb: true,
                                            }),
                                            cx,
                                        )
                                    }),
                            )
                            .child(
                                Button::new("mode-save-cancel")
                                    .label(core(lang, keys::MODES_CANCEL))
                                    .outline()
                                    .small()
                                    .on_click(move |_, _, _| asking.set(false)),
                            ),
                    )
            })
    }
}

/// 操作ロック。ロック中は機器や VST の構成を変えられない（停止・緊急ミュートは使える）。説明はツールチップに出す。
fn protect(modes: &LiveModes, lang: Lang, send: OnCommand) -> impl IntoElement {
    let armed = modes.armed;
    let hint = core(
        lang,
        if armed {
            keys::MODES_UNLOCK_HINT
        } else if modes.running {
            keys::MODES_PROTECT_HINT
        } else {
            keys::MODES_PROTECT_NEEDS_AUDIO
        },
    );
    let usable = modes.can_protect();
    let button = Button::new("mode-protect")
        .label(core(
            lang,
            if armed {
                keys::MODES_PROTECTING
            } else {
                keys::MODES_PROTECT
            },
        ))
        .icon(if armed {
            IconName::Lock
        } else {
            IconName::LockOpen
        })
        .outline()
        .w_full()
        .selected(armed)
        .disabled(!usable)
        .tooltip(hint)
        .on_click(move |_, _, cx| send(Command::Modes(ModeAction::Protect(!armed)), cx));
    // 押せないときはフォーカスが届かずツールチップも読めないので、理由を文で残す。
    div()
        .flex()
        .flex_col()
        .gap_1()
        .child(button)
        .when(!usable, |this| {
            this.child(div().text_xs().text_color(color::muted()).child(hint))
        })
}

fn refresh(lang: Lang, send: OnCommand) -> impl IntoElement {
    div().child(
        Button::new("mode-refresh")
            .label(core(lang, keys::MODES_REFRESH))
            .outline()
            .small()
            .on_click(move |_, _, cx| send(Command::Modes(ModeAction::Read), cx)),
    )
}

fn warning(text: impl Into<SharedString>) -> impl IntoElement {
    div()
        .text_sm()
        .text_color(color::warning())
        .child(text.into())
}

fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::Singing => keys::MODES_SINGING,
        Mode::Talk => keys::MODES_TALK,
    }
}

fn save_label(mode: Mode) -> &'static str {
    match mode {
        Mode::Singing => keys::MODES_SAVE_SINGING,
        Mode::Talk => keys::MODES_SAVE_TALK,
    }
}
