//! ホームの「配信音を仕上げる VST」：声とオケを混ぜた後の配信音だけに掛ける、声用とは別の並び。
//! 規則は `auralyn-ui-model` の `post_mix`、エンジン側は `engine/post_mix.rs`。並びの部品は VST の画面（`vst.rs`）と同じ。
//! 追加・削除・並べ替え・有効の切り替えは音声を止めてから。ON/OFF・ミュート・音量・編集は動かしたままできる。
//! 並びと VST の中の設定は「保存」で保存する（起動し直したあとは「保存した VST を復元」で読み込む）。
//! 保存が読めないときは「保存設定を復旧する」で、今の保存を脇へ保管して無効にする。

use auralyn_ui_model::post_mix::{Block, PostMix};
use auralyn_ui_model::rack::Candidate;
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::select::Select;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Sizable as _, WindowExt as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::{Command, PostAction, Slot, Witness};
use crate::i18n::{core, keys, Lang};
use crate::part::{card, note, Fold, OnCommand};
use crate::vst::{self, Choices, Gains, Look, Ops};

const OPS: Ops = Ops {
    prefix: "post",
    enable: |id, enabled| Command::PostMix(PostAction::Enabled { id, enabled }, None),
    shift: |id, up| Command::PostMix(PostAction::Move { id, up }, None),
    edit: |id| Command::PostMix(PostAction::Editor(id), None),
    remove: |id| Command::PostMix(PostAction::Remove(id), None),
    mute: |id, muted| Command::PostMix(PostAction::Muted { id, muted }, None),
    gain: |id, gain| Command::PostMix(PostAction::Gain { id, gain }, None),
};

pub struct PostMixPanel {
    /// 最後に読めた状態。`None` はまだ読めていない。
    post: Option<PostMix>,
    rack: Vec<Slot>,
    /// 最後に読めなかった理由（次に読めたら消す）。
    read_failed: Option<String>,
    /// 最後の操作が断られた理由（次の操作が通るまで残す）。
    failed: Option<String>,
    gains: Gains,
    catalog: Entity<Choices>,
    /// 普段は畳んでおき、配信 VST を有効にしたら開く。
    fold: Fold,
}

impl PostMixPanel {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            post: None,
            rack: Vec::new(),
            read_failed: None,
            failed: None,
            gains: Gains::default(),
            catalog: vst::new_catalog(window, cx),
            fold: Fold::default(),
        }
    }

    /// 読めた状態・読めなかった理由。`send` は音量のスライダーを離したときの送り先。
    pub fn set<V: 'static>(
        &mut self,
        result: Result<(PostMix, Vec<Slot>), String>,
        window: &mut Window,
        cx: &mut Context<V>,
        send: fn(&mut V, Command),
    ) {
        match result {
            Ok((post, rack)) => {
                self.read_failed = None;
                self.gains.sync(&rack, OPS, window, cx, send);
                if post.enabled && !self.post.as_ref().is_some_and(|p| p.enabled) {
                    self.fold.set(true);
                }
                self.post = Some(post);
                self.rack = rack;
            }
            Err(message) => self.read_failed = Some(message),
        }
    }

    /// 最後に読んだ世代（変える操作に付ける）。まだ読めていなければ `None`。
    pub fn seen(&self) -> Option<Witness> {
        self.post.as_ref().map(|post| post.seen.clone())
    }

    /// 変える操作の結果。
    pub fn done(&mut self, result: Result<(), String>) {
        self.failed = result.err();
    }

    pub fn set_catalog(&self, candidates: &[Candidate], window: &mut Window, cx: &mut App) {
        vst::fill_catalog(&self.catalog, candidates, window, cx);
    }

    /// `mix_active` はオケを適用中、`audio_running` は音声が止まっていない、`scanning` は VST の候補を探している。
    pub fn render(
        &self,
        lang: Lang,
        mix_active: bool,
        audio_running: bool,
        scanning: bool,
        cx: &App,
        send: OnCommand,
    ) -> impl IntoElement {
        let warning = |text: String| div().text_sm().text_color(color::warning()).child(text);
        let warnings = [self.read_failed.clone(), self.failed.clone()]
            .into_iter()
            .flatten()
            .map(warning);
        let Some(post) = self.post.as_ref() else {
            return card(
                core(lang, keys::POST_TITLE),
                div(),
                div().flex().flex_col().gap_2().children(warnings),
            )
            .icon(IconName::SlidersHorizontal)
            .hint(lang, core(lang, keys::POST_SCOPE))
            .into_any_element();
        };
        let block = post.enable_block(mix_active, audio_running);
        let action = |id: &'static str, label: &'static str, action: PostAction, disabled: bool| {
            let send = send.clone();
            Button::new(id)
                .label(core(lang, label))
                .outline()
                .small()
                .disabled(disabled)
                .on_click(move |_, _, cx| send(Command::PostMix(action.clone(), None), cx))
        };
        let chosen = self.catalog.read(cx).selected_value().cloned();
        let saved = if post.saved.is_empty() {
            core(lang, keys::POST_NONE).to_owned()
        } else {
            post.saved.join(", ")
        };
        card(
            core(lang, keys::POST_TITLE),
            // 畳んでいても、掛けているかは見出しの横で分かる。
            div().text_sm().text_color(color::muted()).child(core(
                lang,
                if post.enabled {
                    keys::POST_ON
                } else {
                    keys::POST_OFF
                },
            )),
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(
                    div()
                        .flex()
                        .justify_between()
                        .gap_3()
                        .text_sm()
                        .child(
                            div()
                                .text_color(color::muted())
                                .child(core(lang, keys::POST_SAVED)),
                        )
                        .child(div().min_w_0().child(saved)),
                )
                .children(warnings)
                .when(post.failed || post.error.is_some(), |this| {
                    this.child(warning(core(lang, keys::POST_ERROR).to_owned()))
                        .when_some(post.error.clone(), |this, error| this.child(note(error)))
                })
                // 保存が読めないと、読み直しも保存もできない。今の保存を脇へ保管して無効にする。
                .when(post.error.is_some(), |this| {
                    let send = send.clone();
                    this.child(
                        div().child(
                            Button::new("post-reset")
                                .label(core(lang, keys::POST_RECOVERY))
                                .danger()
                                .small()
                                .disabled(audio_running)
                                .on_click(move |_, window, cx| {
                                    confirm_reset(lang, send.clone(), window, cx)
                                }),
                        ),
                    )
                })
                .when(!post.restored, |this| {
                    this.child(note(core(lang, keys::POST_RESTORE_NEEDED)))
                        .child(div().child(action(
                            "post-restore",
                            keys::POST_RESTORE,
                            PostAction::Restore,
                            audio_running,
                        )))
                })
                .when(audio_running, |this| {
                    this.child(note(core(lang, keys::POST_STOP)))
                })
                .child({
                    let send = send.clone();
                    let enabled = post.enabled;
                    Switch::new("post-enabled")
                        .checked(enabled)
                        .label(core(lang, keys::POST_ENABLED))
                        .disabled(audio_running || (!enabled && block.is_some()))
                        .on_click(move |checked, _, cx| {
                            send(Command::PostMix(PostAction::Enable(*checked), None), cx)
                        })
                })
                .when(block == Some(Block::NeedsMix) && !post.enabled, |this| {
                    this.child(note(core(lang, keys::POST_NEEDS_MIX)))
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child(
                            div().flex_1().min_w(px(200.)).child(
                                Select::new(&self.catalog)
                                    .placeholder(core(lang, keys::POST_CHOOSE))
                                    .search_placeholder(core(lang, keys::POST_CHOOSE))
                                    .accessibility_label(core(lang, keys::POST_CHOOSE))
                                    .disabled(scanning || audio_running),
                            ),
                        )
                        .child({
                            let send = send.clone();
                            Button::new("post-add")
                                .label(core(lang, keys::POST_ADD))
                                .primary()
                                .small()
                                .disabled(audio_running || chosen.is_none())
                                .on_click(move |_, _, cx| {
                                    if let Some(candidate) = chosen.clone() {
                                        send(
                                            Command::PostMix(PostAction::Add(candidate), None),
                                            cx,
                                        );
                                    }
                                })
                        })
                        .child({
                            let send = send.clone();
                            Button::new("post-scan")
                                .label(core(lang, keys::POST_SCAN))
                                .outline()
                                .small()
                                .loading(scanning)
                                .disabled(scanning || audio_running)
                                .on_click(move |_, _, cx| send(Command::ScanPlugins, cx))
                        }),
                )
                .when(!self.rack.is_empty(), |this| {
                    let look = Look {
                        ops: OPS,
                        locked: audio_running,
                        lang,
                    };
                    this.child(vst::list(&self.rack, &self.gains, look, cx, send.clone()))
                })
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(action(
                            "post-save",
                            keys::POST_SAVE,
                            PostAction::Save,
                            !post.restored || post.error.is_some(),
                        ))
                        .child(action(
                            "post-reload",
                            keys::POST_RELOAD,
                            PostAction::Reload,
                            audio_running,
                        )),
                ),
        )
        .icon(IconName::SlidersHorizontal)
        .hint(lang, core(lang, keys::POST_SCOPE))
        // 失敗の間は畳まない（見えないと気づけない）。
        .fold(
            &self.fold,
            self.read_failed.is_some()
                || self.failed.is_some()
                || post.failed
                || post.error.is_some(),
        )
        .into_any_element()
    }
}

/// 復旧の前に確かめる（今の保存は脇へ保管されるが、配信 VST は無効になる）。
fn confirm_reset(lang: Lang, send: OnCommand, window: &mut Window, cx: &mut App) {
    window.open_alert_dialog(cx, move |alert, _, _| {
        let send = send.clone();
        alert
            .title(core(lang, keys::POST_RECOVERY))
            .description(core(lang, keys::POST_RECOVERY_HELP))
            .ok_text(core(lang, keys::POST_RESET))
            .ok_variant(ButtonVariant::Danger)
            .cancel_text(core(lang, keys::CANCEL))
            .show_cancel(true)
            .on_ok(move |_, _, cx| {
                send(Command::PostMix(PostAction::Reset, None), cx);
                true
            })
    });
}
