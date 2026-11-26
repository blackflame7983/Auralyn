//! ボイスチェック：声を最大 10 秒録り、加工前・加工後を WAV で保存する。音づくりの画面の下に出す。
//! 状態とボタンの規則は `auralyn-ui-model` の `voice_check`。試聴（配信に乗らない別の出力先での再生）と波形・解析は、まだ無い。

use auralyn_ui_model::voice_check::{self, Recording, Source, State};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::Disableable as _;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::engine::Command;
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note, save_as, OnCommand};

#[derive(Default)]
pub struct VoicePanel {
    recording: Recording,
    /// 今の録音を WAV で保存できた。録り直したら消す。
    saved: bool,
}

impl VoicePanel {
    pub fn set(&mut self, recording: Recording) {
        if recording.state == State::Recording {
            self.saved = false;
        }
        self.recording = recording;
    }

    pub fn saved(&mut self) {
        self.saved = true;
    }

    /// 音声が止まった。録った音は子と一緒に消えることがあるので、無いものとして扱う。
    pub fn stopped(&mut self) {
        *self = Self::default();
    }

    /// 音づくりの画面を離れるとき。録っている途中なら止める命令を返す（録音はこの画面からしか始めない）。
    pub fn leave(&self) -> Option<Command> {
        self.recording.can_stop().then_some(Command::StopRecording)
    }

    pub fn render(&self, lang: Lang, running: bool, send: OnCommand) -> impl IntoElement {
        let recording = self.recording;
        let max = voice_check::MAX_MS / 1000;
        let record = {
            let send = send.clone();
            if recording.can_stop() {
                Button::new("voice-stop")
                    .label(core(lang, keys::VOICE_STOP))
                    .danger()
                    .on_click(move |_, _, cx| send(Command::StopRecording, cx))
            } else {
                Button::new("voice-record")
                    .label(core_with(lang, keys::VOICE_RECORD, &[("seconds", &max)]))
                    .primary()
                    .disabled(!recording.can_record(running))
                    .on_click(move |_, _, cx| send(Command::Record, cx))
            }
        };
        let save = |id: &'static str, label: &'static str, source: Source| {
            let send = send.clone();
            Button::new(id)
                .label(core(lang, label))
                .outline()
                .on_click(move |_, _, cx| {
                    let send = send.clone();
                    let file = format!("voice-check-{}.wav", source.as_str());
                    save_as(file, cx, move |path, cx| {
                        send(Command::SaveRecording { source, path }, cx)
                    });
                })
        };
        card(
            core(lang, keys::VOICE_TITLE),
            div(),
            div()
                .flex()
                .flex_col()
                .gap_3()
                .child(note(core(lang, keys::VOICE_LEAD)))
                .child(note(core(lang, keys::VOICE_SCOPE)))
                .when(!running, |this| {
                    this.child(note(core(lang, keys::VOICE_NEEDS_AUDIO)))
                })
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap_3()
                        .child(record)
                        .when(recording.can_stop(), |this| {
                            this.child(div().text_sm().child(format!(
                                "REC {} {}{}",
                                voice_check::seconds(recording.position_ms),
                                core(lang, keys::VOICE_REMAINING),
                                voice_check::seconds(recording.remaining_ms()),
                            )))
                        }),
                )
                .when(recording.can_save(), |this| {
                    this.child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_2()
                            .child(
                                div()
                                    .text_sm()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(format!(
                                        "{} ({})",
                                        core(lang, keys::VOICE_SAVE),
                                        voice_check::seconds(recording.duration_ms)
                                    )),
                            )
                            .child(save("voice-save-raw", keys::VOICE_BEFORE, Source::Raw))
                            .child(save(
                                "voice-save-processed",
                                keys::VOICE_AFTER,
                                Source::Processed,
                            )),
                    )
                })
                .when(self.saved, |this| {
                    this.child(note(core(lang, keys::VOICE_SAVED)))
                }),
        )
    }
}
