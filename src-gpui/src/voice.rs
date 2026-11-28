//! ボイスチェック：声を最大 10 秒録り、加工前・加工後を WAV で保存し、配信に乗らない別の出力先で聴き比べる。
//! 音づくりの画面の下に出す。状態とボタンの規則は `auralyn-ui-model` の `voice_check`。波形・解析・候補の比較は、まだ無い。

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use auralyn_ui_model::voice_check::{self, Listening, Playback, Recording, Source, State};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::select::{Select, SelectState};
use gpui_kit::component::{Disableable as _, Selectable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::{Command, Listen};
use crate::i18n::{core, core_with, keys, Lang};
use crate::part::{card, note, paragraphs, save_as, shift, with_hint, OnCommand};

type Names = SelectState<Vec<SharedString>>;

pub struct VoicePanel {
    recording: Recording,
    /// 今の録音を WAV で保存できた。録り直したら消す。
    saved: bool,
    /// 試聴のいまの様子。`None` は試聴を開いていない。
    listening: Option<Listening>,
    /// 試聴の操作が失敗した理由（次の答えが届いたら消す）。
    listen_failed: Option<String>,
    devices: Entity<Names>,
    /// 試聴を開くよう頼んで、答えを待っている。
    opening: bool,
    /// 「開き直す」が押された。
    retry: Rc<Cell<bool>>,
    /// 「試聴先を配信・通話が取り込んでいないと確かめた」出力先の名前。ほかの出力先を選ぶと外れる。
    checked: Rc<RefCell<Option<SharedString>>>,
    source: Rc<Cell<Source>>,
    looped: Rc<Cell<bool>>,
}

impl VoicePanel {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        Self {
            recording: Recording::default(),
            saved: false,
            listening: None,
            listen_failed: None,
            devices: cx.new(|cx| SelectState::new(Vec::new(), None, window, cx)),
            opening: false,
            retry: Rc::default(),
            checked: Rc::default(),
            source: Rc::new(Cell::new(Source::Processed)),
            looped: Rc::new(Cell::new(true)),
        }
    }

    pub fn set(&mut self, recording: Recording) {
        if recording.state == State::Recording {
            self.saved = false;
            self.listen_failed = None;
        }
        self.recording = recording;
    }

    /// 試聴を開く命令（音づくりの画面を出しているときに毎回聞く）。録り終えていて、まだ開いておらず、
    /// 開くのに失敗したままでなければ返す。
    pub fn open(&mut self, running: bool) -> Option<Command> {
        if self.retry.take() {
            self.listen_failed = None;
        }
        let wanted = self.recording.can_save(running)
            && self.listening.is_none()
            && !self.opening
            && self.listen_failed.is_none();
        self.opening |= wanted;
        wanted.then_some(Command::Listen(Listen::Open))
    }

    pub fn set_listening(
        &mut self,
        result: Result<Listening, String>,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.opening = false;
        match result {
            // 閉じた答え（一覧は空）は、開いていないのと同じ。出力先の選択はそのまま残す。
            Ok(listening) if listening.playback == Playback::Closed => self.listening = None,
            Ok(listening) => {
                let listed =
                    |l: &Listening| l.devices.iter().map(|d| d.name.clone()).collect::<Vec<_>>();
                if self.listening.as_ref().map(listed) != Some(listed(&listening)) {
                    self.checked.replace(None);
                    let names = listed(&listening)
                        .into_iter()
                        .map(SharedString::from)
                        .collect();
                    self.devices
                        .update(cx, |state, cx| state.set_items(names, window, cx));
                }
                self.listen_failed = None;
                self.listening = Some(listening);
            }
            // セッションが失効したかもしれないので、開いていないものとして扱う（「開き直す」で開ける）。
            Err(message) => {
                self.listening = None;
                self.listen_failed = Some(message);
            }
        }
    }

    /// 鳴らしている・止めている間は、位置と止まったことを読み直す。
    pub fn polls(&self) -> bool {
        self.listening.as_ref().is_some_and(Listening::polls)
    }

    /// 音声が止まった・異常で止まった。試聴のセッションも子と一緒に終わる。
    pub fn audio_stopped(&mut self) {
        self.listening = None;
        self.listen_failed = None;
        self.opening = false;
    }

    pub fn saved(&mut self) {
        self.saved = true;
    }

    /// 音づくりの画面を離れる・窓を隠すとき。録っている途中なら止め、試聴は閉じる（どちらも1度だけ）。
    /// 録音はこの画面からしか始めない。録音の止まった状態は、あとでエンジンから届く。
    pub fn leave(&mut self) -> Vec<Command> {
        let mut commands = Vec::new();
        if self.recording.can_stop() {
            self.recording.state = State::Idle;
            commands.push(Command::StopRecording);
        }
        if self.listening.take().is_some() {
            commands.push(Command::Listen(Listen::Close));
        }
        commands
    }

    pub fn render(&self, lang: Lang, running: bool, cx: &App, send: OnCommand) -> impl IntoElement {
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
                    .on_click({
                        // 録り直す前に試聴を閉じる（鳴っている録音を差し替えない）。
                        let open = self.listening.is_some();
                        move |_, _, cx| {
                            if open {
                                send(Command::Listen(Listen::Close), cx);
                            }
                            send(Command::Record, cx)
                        }
                    })
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
                .when(recording.can_save(running), |this| {
                    this.child(shift(
                        ElementId::NamedInteger(
                            "voice-save".into(),
                            u64::from(recording.duration_ms),
                        ),
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
                    ))
                })
                .when(self.saved, |this| {
                    this.child(note(core(lang, keys::VOICE_SAVED)))
                })
                .when_some(
                    self.listening
                        .as_ref()
                        .filter(|_| recording.can_save(running)),
                    |this, listening| {
                        this.child(shift(
                            ElementId::NamedInteger(
                                "voice-listen".into(),
                                u64::from(recording.duration_ms),
                            ),
                            div().child(self.render_listen(listening, lang, cx, send.clone())),
                        ))
                    },
                )
                .when_some(
                    self.listen_failed
                        .as_ref()
                        .filter(|_| recording.can_save(running)),
                    |this, message| {
                        let retry = self.retry.clone();
                        this.child(
                            div()
                                .text_sm()
                                .text_color(color::warning())
                                .child(message.clone()),
                        )
                        .child(
                            Button::new("listen-retry")
                                .label(core(lang, keys::LISTEN_RETRY))
                                .outline()
                                .on_click(move |_, window, _| {
                                    retry.set(true);
                                    window.refresh();
                                }),
                        )
                    },
                ),
        )
        .icon(IconName::Headphones)
        .hint(
            lang,
            paragraphs(lang, &[keys::VOICE_LEAD, keys::VOICE_SCOPE]),
        )
    }

    fn render_listen(
        &self,
        listening: &Listening,
        lang: Lang,
        cx: &App,
        send: OnCommand,
    ) -> impl IntoElement {
        let chosen = self.devices.read(cx).selected_value().cloned();
        let device_id = chosen.as_ref().and_then(|name| {
            listening
                .devices
                .iter()
                .find(|d| d.name == name.as_ref())
                .map(|d| d.id.clone())
        });
        let safe = chosen.is_some() && *self.checked.borrow() == chosen;
        let play = listening
            .recording_id
            .filter(|_| listening.can_play(device_id.is_some(), safe));
        let playing = listening.can_stop();
        let source_button = |id: &'static str, label: &'static str, source: Source| {
            let send = send.clone();
            let chosen = self.source.clone();
            let looped = self.looped.clone();
            Button::new(id)
                .label(core(lang, label))
                .outline()
                .selected(self.source.get() == source)
                .on_click(move |_, window, cx| {
                    chosen.set(source);
                    if playing {
                        send(
                            Command::Listen(Listen::Change {
                                source,
                                looped: looped.get(),
                            }),
                            cx,
                        );
                    }
                    window.refresh();
                })
        };
        let status = if playing {
            format!(
                "{} {} / {}",
                core(lang, keys::LISTEN_PLAYING),
                voice_check::seconds(listening.position_ms),
                voice_check::seconds(listening.duration_ms)
            )
        } else if play.is_none() && !safe {
            core(lang, keys::REASON_LISTEN_PICK).to_owned()
        } else {
            core(lang, keys::LISTEN_STOPPED).to_owned()
        };
        let failed = listening.error.clone();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(color::border())
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(core(lang, keys::LISTEN_TITLE)),
            )
            .child(with_hint(
                "listen-lead-hint",
                lang,
                core(lang, keys::LISTEN_LEAD),
                note(core(lang, keys::LISTEN_SHORT)),
            ))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(
                        div().flex_1().min_w(px(200.)).child(
                            Select::new(&self.devices)
                                .placeholder(core(lang, keys::LISTEN_CHOOSE))
                                .accessibility_label(core(lang, keys::LISTEN_DEVICE)),
                        ),
                    )
                    .child({
                        let send = send.clone();
                        Button::new("listen-devices")
                            .label(core(lang, keys::LISTEN_REFRESH))
                            .accessibility_label(core(lang, keys::LISTEN_REFRESH_NAMED))
                            .outline()
                            .disabled(playing)
                            .on_click(move |_, _, cx| send(Command::Listen(Listen::Devices), cx))
                    }),
            )
            .child(
                Checkbox::new("listen-safe")
                    .checked(safe)
                    .label(core(lang, keys::LISTEN_SAFE))
                    .on_click({
                        let mark = self.checked.clone();
                        let chosen = chosen.clone();
                        move |checked, window, _| {
                            mark.replace(chosen.clone().filter(|_| *checked));
                            window.refresh();
                        }
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_2()
                    .child(source_button("listen-raw", keys::VOICE_BEFORE, Source::Raw))
                    .child(source_button(
                        "listen-processed",
                        keys::VOICE_AFTER,
                        Source::Processed,
                    ))
                    .child(
                        Checkbox::new("listen-loop")
                            .checked(self.looped.get())
                            .label(core(lang, keys::LISTEN_LOOP))
                            .on_click({
                                let send = send.clone();
                                let looped = self.looped.clone();
                                let source = self.source.clone();
                                move |checked, window, cx| {
                                    looped.set(*checked);
                                    if playing {
                                        send(
                                            Command::Listen(Listen::Change {
                                                source: source.get(),
                                                looped: *checked,
                                            }),
                                            cx,
                                        );
                                    }
                                    window.refresh();
                                }
                            }),
                    ),
            )
            .child({
                let send = send.clone();
                if playing {
                    Button::new("listen-stop")
                        .label(core(lang, keys::LISTEN_STOP))
                        .outline()
                        .on_click(move |_, _, cx| send(Command::Listen(Listen::Stop), cx))
                } else {
                    let source = self.source.get();
                    let looped = self.looped.get();
                    Button::new("listen-play")
                        .label(core(lang, keys::LISTEN_PLAY))
                        .accessibility_label(core(lang, keys::LISTEN_PLAY_NAMED))
                        .primary()
                        .disabled(play.is_none())
                        .on_click(move |_, _, cx| {
                            if let (Some(recording_id), Some(device_id)) = (play, device_id.clone())
                            {
                                send(
                                    Command::Listen(Listen::Play {
                                        recording_id,
                                        device_id,
                                        source,
                                        looped,
                                    }),
                                    cx,
                                );
                            }
                        })
                }
            })
            .child(div().text_sm().child(status))
            .when_some(failed, |this, message| {
                this.child(div().text_sm().text_color(color::warning()).child(message))
            })
    }
}
