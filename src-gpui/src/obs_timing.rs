//! OBS のカードの「録画を基にタイミングを調整する」（Tauri 版の `ObsTimingCheck`）。
//! 利用者が OBS の録画で測った差から、早い側のソースの同期オフセットへ遅れを足す変更予定を作る。
//! 予定の適用・元に戻すは `obs_changes`（変更確認と同じ履歴）。入力の規則は `auralyn-ui-model` の `obs_timing`。

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use auralyn_ui_model::obs_timing::{
    result_offset, Blocked, Comparison, Direction, Form, Role, MAX_NOTE_CHARS,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::Button;
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{Disableable as _, Selectable as _};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use vst_host_lib::obs_setup::{TimingMetadata, TimingTargets};

use crate::i18n::{core, core_with, keys, Lang};
use crate::obs::OnOrder;
use crate::obs_link::{Order, Setup, Timing};
use crate::part::{choices, note};

/// ボタンで選ぶもの。入力欄の文字は `InputState` が持つ。
#[derive(Default)]
struct Picked {
    open: bool,
    comparison: Comparison,
    direction: Option<Direction>,
    mixed: bool,
    checked: bool,
    token: Option<String>,
    /// 入力を変えるたびに増える。
    revision: u64,
}

/// ボタンで選び直す。入力が変わったことも記録する。
fn edit(picked: &RefCell<Picked>, window: &mut Window, change: impl FnOnce(&mut Picked)) {
    let mut picked = picked.borrow_mut();
    change(&mut picked);
    picked.revision += 1;
    window.refresh();
}

pub struct TimingPanel {
    picked: Rc<RefCell<Picked>>,
    difference: Entity<InputState>,
    note: Entity<InputState>,
    fps: Entity<InputState>,
    track: Entity<InputState>,
    /// 最後に見た入力の番号（`Picked::revision`）。
    seen: Cell<u64>,
    /// 同期の変更予定を頼んだときの入力の番号。
    asked: Cell<Option<u64>>,
    targets: Option<Result<TimingTargets, String>>,
    _subscriptions: Vec<Subscription>,
}

impl TimingPanel {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        let picked: Rc<RefCell<Picked>> = Rc::default();
        let input =
            |window: &mut Window, cx: &mut Context<V>| cx.new(|cx| InputState::new(window, cx));
        let difference = input(window, cx);
        let note = input(window, cx);
        let fps = input(window, cx);
        let track = input(window, cx);
        let _subscriptions = [&difference, &note, &fps, &track]
            .into_iter()
            .map(|state| {
                let picked = picked.clone();
                cx.subscribe(state, move |_, _, event: &InputEvent, cx| {
                    if let InputEvent::Change = event {
                        picked.borrow_mut().revision += 1;
                        cx.notify();
                    }
                })
            })
            .collect();
        Self {
            picked,
            difference,
            note,
            fps,
            track,
            seen: Cell::new(0),
            asked: Cell::new(None),
            targets: None,
            _subscriptions,
        }
    }

    /// 前に聞いてから入力が変わったか。
    pub fn take_edited(&self) -> bool {
        let revision = self.picked.borrow().revision;
        self.seen.replace(revision) != revision
    }

    /// 同期の変更予定を頼んだ。
    pub fn asked(&self) {
        self.asked.set(Some(self.picked.borrow().revision));
    }

    /// 届いた同期の変更予定が、頼んだあと入力を変えていないものか。
    pub fn plan_current(&self) -> bool {
        self.asked.get() == Some(self.picked.borrow().revision)
    }

    pub fn set_targets(&mut self, targets: Result<TimingTargets, String>) {
        self.targets = Some(targets);
    }

    /// 対象を読み直すとき・OBS のオフセットを変えたとき。前の一覧と選んだ対象は今のものではない。
    pub fn forget_targets(&mut self) {
        self.targets = None;
        self.picked.borrow_mut().token = None;
    }

    /// 適用・元に戻す・切断のあと。もう一度測ってから確かめ直してもらう。
    pub fn reset(&mut self) {
        self.forget_targets();
        self.picked.borrow_mut().checked = false;
    }

    fn form(&self, cx: &App) -> Form {
        let picked = self.picked.borrow();
        let text = |input: &Entity<InputState>| input.read(cx).value().to_string();
        Form {
            comparison: picked.comparison,
            direction: picked.direction,
            mixed: picked.mixed,
            difference: text(&self.difference),
            note: text(&self.note),
            fps: text(&self.fps),
            track: text(&self.track),
            checked: picked.checked,
        }
    }

    /// `busy` は OBS への変更確認の命令が返事待ち。
    pub fn render(
        &self,
        lang: Lang,
        cx: &App,
        connected: bool,
        busy: bool,
        on: OnOrder,
    ) -> impl IntoElement {
        let open = self.picked.borrow().open;
        let toggle = {
            let picked = self.picked.clone();
            Button::new("obs-timing-open")
                .label(core(lang, keys::OBS_TIMING_TITLE))
                .icon(if open {
                    IconName::ChevronUp
                } else {
                    IconName::ChevronDown
                })
                .outline()
                .selected(open)
                .on_click(move |_, window, _| {
                    let mut picked = picked.borrow_mut();
                    picked.open = !picked.open;
                    window.refresh();
                })
        };
        div()
            .flex()
            .flex_col()
            .gap_2()
            .pt_3()
            .border_t_1()
            .border_color(crate::color::border())
            .child(div().child(toggle))
            .when(open, |this| {
                this.child(self.render_form(lang, cx, connected, busy, on))
            })
    }

    fn render_form(
        &self,
        lang: Lang,
        cx: &App,
        connected: bool,
        busy: bool,
        on: OnOrder,
    ) -> impl IntoElement {
        let form = self.form(cx);
        let measurement = form.measurement();
        let picked = self.picked.borrow();
        let av = form.comparison == Comparison::AudioVideo;
        let field = |label: &'static str, input: &Entity<InputState>| {
            div()
                .flex()
                .flex_col()
                .gap_1()
                .child(div().text_sm().child(core(lang, label)))
                .child(Input::new(input).aria_label(core(lang, label)))
        };
        let comparison = choices(
            "obs-timing-compare",
            lang,
            &[
                (Comparison::VoiceAccompaniment, keys::OBS_TIMING_VOICE_MUSIC),
                (Comparison::AudioVideo, keys::OBS_TIMING_AUDIO_VIDEO),
            ],
            Some(form.comparison),
            {
                let picked = self.picked.clone();
                move |value, window, _| {
                    edit(&picked, window, |p| {
                        p.comparison = value;
                        p.direction = None;
                        p.token = None;
                    })
                }
            },
        );
        let route = choices(
            "obs-timing-route",
            lang,
            &[
                (false, keys::OBS_TIMING_SEPARATE),
                (true, keys::OBS_TIMING_MIXED),
            ],
            Some(form.mixed),
            {
                let picked = self.picked.clone();
                move |value, window, _| {
                    edit(&picked, window, |p| {
                        p.mixed = value;
                        p.token = None;
                        p.checked = false;
                    })
                }
            },
        );
        let direction = choices(
            "obs-timing-direction",
            lang,
            &[
                (
                    Direction::Early,
                    if av {
                        keys::OBS_TIMING_AV_EARLY
                    } else {
                        keys::OBS_TIMING_VOICE_EARLY
                    },
                ),
                (
                    Direction::Late,
                    if av {
                        keys::OBS_TIMING_AV_LATE
                    } else {
                        keys::OBS_TIMING_VOICE_LATE
                    },
                ),
                (Direction::Unknown, keys::OBS_TIMING_UNKNOWN),
            ],
            form.direction,
            {
                let picked = self.picked.clone();
                move |value, window, _| {
                    edit(&picked, window, |p| {
                        p.direction = Some(value);
                        p.token = None;
                    })
                }
            },
        );
        let checked = Checkbox::new("obs-timing-checked")
            .checked(form.checked)
            .label(core(lang, keys::OBS_TIMING_CHECKED))
            .on_click({
                let picked = self.picked.clone();
                move |checked, window, _| edit(&picked, window, |p| p.checked = *checked)
            });
        let blocked = form.blocked().map(|blocked| match blocked {
            Blocked::Mixed => keys::OBS_TIMING_BLOCK_MIXED,
            Blocked::Unknown => keys::OBS_TIMING_BLOCK_UNKNOWN,
            Blocked::AudioLate => keys::OBS_TIMING_BLOCK_AUDIO_LATE,
        });
        let role = form.role().map(|role| {
            let role = core(
                lang,
                match role {
                    Role::Audio => keys::OBS_TIMING_ROLE_AUDIO,
                    Role::Accompaniment => keys::OBS_TIMING_ROLE_MUSIC,
                    Role::Voice => keys::OBS_TIMING_ROLE_VOICE,
                },
            );
            core_with(lang, keys::OBS_TIMING_ROLE, &[("role", &role)])
        });
        let ready = self.targets.as_ref().and_then(|t| t.as_ref().ok());
        let supported = ready.filter(|t| t.supported);
        let selected = supported.and_then(|t| {
            let token = picked.token.as_ref()?;
            t.targets
                .iter()
                .find(|target| &target.target_token == token)
        });
        let chosen = selected.zip(measurement.as_ref());
        let preview = chosen
            .filter(|(target, m)| result_offset(target.current_offset_ms, m.delay_ms).is_some())
            .map(|(target, m)| Timing {
                token: target.target_token.clone(),
                comparison: form.comparison,
                measurement: m.clone(),
            });
        let idle = connected && !busy;
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(note(core(lang, keys::OBS_TIMING_LEAD)))
            .child(note(core(lang, keys::OBS_TIMING_SCOPE)))
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .child(core(lang, keys::OBS_TIMING_STEP)),
            )
            .child(div().text_sm().child(core(lang, keys::OBS_TIMING_COMPARE)))
            .child(div().child(comparison))
            .when(!av, |this| this.child(div().child(route)))
            .child(div().text_sm().child(core(lang, keys::OBS_TIMING_WHEN)))
            .child(div().child(direction))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_3()
                    .child(
                        div()
                            .w(px(200.))
                            .child(field(keys::OBS_TIMING_DIFFERENCE, &self.difference)),
                    )
                    .child(
                        div()
                            .w(px(120.))
                            .child(field(keys::OBS_TIMING_FPS, &self.fps)),
                    )
                    .child(
                        div()
                            .w(px(120.))
                            .child(field(keys::OBS_TIMING_TRACK, &self.track)),
                    ),
            )
            .child(field(keys::OBS_TIMING_NOTE, &self.note))
            .child(note(core(lang, keys::OBS_TIMING_NOTE_HINT)))
            .map(|this| {
                let count = form.note.chars().count();
                this.when(count > MAX_NOTE_CHARS, |this| {
                    this.child(note(format!("{count} / {MAX_NOTE_CHARS}")))
                })
            })
            .child(checked)
            .when_some(blocked, |this, key| this.child(note(core(lang, key))))
            .when_some(role, |this, role| this.child(div().text_sm().child(role)))
            .child(div().child({
                let on = on.clone();
                Button::new("obs-timing-targets")
                    .label(core(lang, keys::OBS_TIMING_FETCH))
                    .outline()
                    .disabled(!idle || measurement.is_none())
                    .on_click(move |_, _, cx| on(Order::Setup(Setup::Targets), cx))
            }))
            .when_some(self.targets.as_ref(), |this, targets| {
                this.child(self.render_targets(lang, targets, picked.token.as_deref(), busy))
            })
            .when_some(chosen, |this, (target, m)| {
                let before = target.current_offset_ms;
                let mut line = offset_line(
                    lang,
                    &target.source,
                    before,
                    m.delay_ms,
                    before.saturating_add(m.delay_ms),
                );
                if result_offset(before, m.delay_ms).is_none() {
                    line.push_str(core(lang, keys::OBS_TIMING_OUT_OF_RANGE));
                }
                this.child(div().text_sm().child(line))
            })
            .child(div().child({
                let on = on.clone();
                Button::new("obs-timing-preview")
                    .label(core(lang, keys::OBS_TIMING_PREVIEW))
                    .outline()
                    .disabled(!idle || preview.is_none())
                    .on_click(move |_, _, cx| {
                        if let Some(timing) = preview.clone() {
                            on(Order::Setup(Setup::Timing(timing)), cx);
                        }
                    })
            }))
            .child(note(core(lang, keys::OBS_TIMING_FOOTER)))
    }

    fn render_targets(
        &self,
        lang: Lang,
        targets: &Result<TimingTargets, String>,
        token: Option<&str>,
        busy: bool,
    ) -> impl IntoElement {
        let targets = match targets {
            Ok(targets) => targets,
            Err(message) => {
                return div().child(note(format!(
                    "{} {}",
                    core(lang, keys::OBS_TIMING_FAILURE),
                    crate::obs_text::original(lang, message)
                )));
            }
        };
        let mut status = core(
            lang,
            if targets.supported {
                keys::OBS_TIMING_READY
            } else {
                keys::OBS_TIMING_UNAVAILABLE
            },
        )
        .to_string();
        if targets.supported && targets.targets.is_empty() {
            status.push_str(core(lang, keys::OBS_TIMING_NO_TARGETS));
        }
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(div().text_sm().child(status))
            .child(note(crate::obs_text::original(lang, &targets.message)))
            .when(targets.supported && !targets.targets.is_empty(), |this| {
                this.child(div().text_sm().child(core(lang, keys::OBS_TIMING_TARGET)))
                    .child(div().flex().flex_col().gap_1().children(
                        targets.targets.iter().enumerate().map(|(index, target)| {
                            let picked = self.picked.clone();
                            let chosen = token == Some(target.target_token.as_str());
                            let value = target.target_token.clone();
                            Button::new(SharedString::from(format!("obs-timing-target-{index}")))
                                .label(core_with(
                                    lang,
                                    keys::OBS_TIMING_SOURCE,
                                    &[
                                        ("source", &target.source),
                                        ("value", &target.current_offset_ms),
                                    ],
                                ))
                                .outline()
                                .selected(chosen)
                                .disabled(busy)
                                .on_click(move |_, window, _| {
                                    edit(&picked, window, |p| p.token = Some(value.clone()))
                                })
                        }),
                    ))
            })
    }
}

fn offset_line(lang: Lang, source: &str, before: i64, delay: i64, after: i64) -> String {
    core_with(
        lang,
        keys::OBS_TIMING_OFFSET,
        &[
            ("source", &source),
            ("before", &before),
            ("delay", &delay),
            ("after", &after),
        ],
    )
}

/// 同期の変更予定・履歴の1行（変更確認の側でも使う）。
pub fn timing_line(lang: Lang, timing: &TimingMetadata) -> String {
    core_with(
        lang,
        keys::OBS_TIMING_HISTORY,
        &[
            ("source", &timing.source),
            ("before", &timing.current_offset_ms),
            ("after", &timing.result_offset_ms),
            ("delay", &timing.additional_delay_ms),
            ("note", &timing.measurement.reference_note),
        ],
    )
}
