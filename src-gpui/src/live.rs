//! 接続の画面の「自分用と配信用に分ける」：加工後の声を、自分用の出力とは別の WASAPI 出力へも送る（OBS はその出力を取り込む）。
//! 規則は `auralyn-ui-model` の `live_output`。処理を分けるときの自分用の歌・雑談の加工の値は、まだこの画面で変えない（無ければ既定で入れる）。

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use auralyn_ui_model::connect::{self, Device};
use auralyn_ui_model::live_output::{self, Change, Draft, Live, Verdict};
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::select::{Select, SelectEvent, SelectState};
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::component::Sizable as _;
use gpui_kit::component::{Disableable as _, IndexPath};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::engine::Command;
use crate::i18n::{core, keys, Lang};
use crate::part::{note, with_hint, Card, OnCommand};

type Names = SelectState<Vec<SharedString>>;

pub struct LivePanel {
    /// 最後に読めた状態。`None` はまだ読めていない。
    live: Option<Live>,
    /// 最後の読み込みが失敗した理由（次に読めたら消す）。
    failed: Option<String>,
    /// 保存を頼んで、結果を待っている。待っている間は変えさせない。
    saving: Rc<Cell<bool>>,
    /// 最後の保存が断られた理由（次の保存まで残す）。
    save_failed: Option<String>,
    /// 保存する前の下書き。読めた構成が変わるたびに、それに戻す。
    draft: Rc<RefCell<Option<Draft>>>,
    /// 「二重取り込みを確かめた」。下書きを変えると外れる。
    confirmed: Rc<Cell<bool>>,
    device: Entity<Names>,
    /// `device` の並びに対応する出力の ID（先頭は「分けない」の `None`）。
    ids: Rc<RefCell<Vec<Option<String>>>>,
    /// 選べる出力（ID と表示名）。
    outputs: Vec<(String, String)>,
    monitor_trim: Entity<SliderState>,
    broadcast_trim: Entity<SliderState>,
    _subscriptions: Vec<Subscription>,
}

impl LivePanel {
    pub fn new<V: 'static>(window: &mut Window, cx: &mut Context<V>) -> Self {
        let draft: Rc<RefCell<Option<Draft>>> = Rc::default();
        let confirmed: Rc<Cell<bool>> = Rc::default();
        let ids: Rc<RefCell<Vec<Option<String>>>> = Rc::default();
        let device = cx.new(|cx| SelectState::new(Vec::new(), None, window, cx));
        let trim = |cx: &mut Context<V>| cx.new(|_| SliderState::new().min(0.).max(100.).step(1.));
        let monitor_trim = trim(cx);
        let broadcast_trim = trim(cx);
        let edit = {
            let draft = draft.clone();
            let confirmed = confirmed.clone();
            move |change: Change| {
                let mut draft = draft.borrow_mut();
                if let Some(current) = draft.take() {
                    *draft = Some(current.with(change));
                    confirmed.set(false);
                }
            }
        };
        let subscriptions = vec![
            cx.subscribe(&device, {
                let edit = edit.clone();
                let ids = ids.clone();
                move |_, state, _: &SelectEvent<Vec<SharedString>>, cx| {
                    let row = state.read(cx).selected_index(cx).map(|ix| ix.row);
                    if let Some(id) = row.and_then(|row| ids.borrow().get(row).cloned()) {
                        edit(Change::Device(id));
                    }
                    cx.notify();
                }
            }),
            cx.subscribe(&monitor_trim, {
                let edit = edit.clone();
                move |_, _, event: &SliderEvent, cx| {
                    let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
                    edit(Change::MonitorTrim(value.end() / 100.));
                    cx.notify();
                }
            }),
            cx.subscribe(&broadcast_trim, move |_, _, event: &SliderEvent, cx| {
                let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
                edit(Change::BroadcastTrim(value.end() / 100.));
                cx.notify();
            }),
        ];
        Self {
            live: None,
            failed: None,
            saving: Rc::default(),
            save_failed: None,
            draft,
            confirmed,
            device,
            ids,
            outputs: Vec::new(),
            monitor_trim,
            broadcast_trim,
            _subscriptions: subscriptions,
        }
    }

    /// 機器の一覧が届いた。選べる出力を入れ直す。
    pub fn set_devices(
        &mut self,
        devices: &[Device],
        lang: Lang,
        window: &mut Window,
        cx: &mut App,
    ) {
        let outputs = live_output::outputs(devices);
        let labels = connect::labels(&outputs);
        self.outputs = outputs
            .iter()
            .zip(labels)
            .filter_map(|(d, label)| Some((d.id.clone()?, label)))
            .collect();
        self.fill(lang, window, cx);
    }

    /// 読めた状態・断られた理由。保存してある構成が変わったら、下書きと確認の印をそれに戻す。
    pub fn set(
        &mut self,
        result: Result<Live, String>,
        lang: Lang,
        window: &mut Window,
        cx: &mut App,
    ) {
        match result {
            Ok(live) => {
                let changed = self.live.as_ref().map(|l| &l.saved) != Some(&live.saved);
                self.failed = None;
                self.live = Some(live);
                if changed || self.draft.borrow().is_none() {
                    self.reset(lang, window, cx);
                }
            }
            Err(message) => self.failed = Some(message),
        }
    }

    /// 伴奏を混ぜられる構成か（配信用の出力を選び、処理を分けてある）。`None` はまだ読めていない。
    pub fn ready(&self) -> Option<bool> {
        self.live
            .as_ref()
            .map(|l| l.saved.device_id.is_some() && l.saved.split)
    }

    /// 保存の結果。
    pub fn saved(&mut self, result: Result<(), String>) {
        self.saving.set(false);
        self.save_failed = result.err();
    }

    /// 下書きを保存してある構成に戻す。
    fn reset(&mut self, lang: Lang, window: &mut Window, cx: &mut App) {
        let Some(saved) = self.live.as_ref().map(|l| l.saved.clone()) else {
            return;
        };
        self.monitor_trim.update(cx, |s, cx| {
            s.set_value(saved.monitor_trim * 100., window, cx)
        });
        self.broadcast_trim.update(cx, |s, cx| {
            s.set_value(saved.broadcast_trim * 100., window, cx)
        });
        self.draft.replace(Some(saved));
        self.confirmed.set(false);
        self.fill(lang, window, cx);
    }

    /// 出力の選択肢を入れ、下書きの出力を選ぶ。保存した出力が見つからなければ、その旨の行を足す。
    fn fill(&mut self, lang: Lang, window: &mut Window, cx: &mut App) {
        let chosen = self
            .draft
            .borrow()
            .as_ref()
            .and_then(|d| d.device_id.clone());
        let mut ids = vec![None];
        let mut names = vec![SharedString::from(core(lang, keys::LIVE_OFF))];
        for (id, label) in &self.outputs {
            ids.push(Some(id.clone()));
            names.push(label.clone().into());
        }
        if let Some(missing) = chosen
            .as_ref()
            .filter(|id| !self.outputs.iter().any(|(o, _)| o == *id))
        {
            ids.push(Some(missing.clone()));
            names.push(core(lang, keys::LIVE_MISSING).into());
        }
        let row = ids.iter().position(|id| *id == chosen);
        self.ids.replace(ids);
        self.device.update(cx, |state, cx| {
            state.set_items(names, window, cx);
            state.set_selected_index(row.map(IndexPath::new), window, cx);
        });
    }

    /// 印のボックスで下書きを変える。変えたら確認の印は外れる。
    fn on_change(
        &self,
        change: fn(bool) -> Change,
    ) -> impl Fn(&bool, &mut Window, &mut App) + 'static {
        let draft = self.draft.clone();
        let confirmed = self.confirmed.clone();
        move |checked, window, _| {
            let mut draft = draft.borrow_mut();
            if let Some(current) = draft.take() {
                *draft = Some(current.with(change(*checked)));
                confirmed.set(false);
            }
            window.refresh();
        }
    }

    pub fn render(&self, lang: Lang, send: OnCommand) -> impl IntoElement {
        let draft = self.draft.borrow().clone();
        let saved = self.live.as_ref().map(|l| &l.saved);
        let confirmed = self.confirmed.get();
        let saving = self.saving.get();
        let can_save = draft
            .as_ref()
            .zip(saved)
            .is_some_and(|(draft, saved)| live_output::can_save(draft, saved, confirmed));
        let verdict = self.live.as_ref().map(Live::verdict);
        let refresh = {
            let send = send.clone();
            Button::new("live-refresh")
                .icon(IconName::RefreshCw)
                .tooltip(core(lang, keys::LIVE_REFRESH))
                .accessibility_label(core(lang, keys::LIVE_REFRESH))
                .outline()
                .small()
                .on_click(move |_, _, cx| send(Command::LiveOutput(None), cx))
        };
        Card::new(
            core(lang, keys::LIVE_TITLE),
            div()
                .flex()
                .flex_col()
                .gap_3()
                .when_some(verdict, |this, verdict| {
                    let (text, warn) = match verdict {
                        Verdict::Off => (keys::LIVE_OFF, false),
                        Verdict::Active => (keys::LIVE_ACTIVE, false),
                        Verdict::Inactive => (keys::LIVE_INACTIVE, false),
                        Verdict::Failed => (keys::LIVE_FAILED, true),
                    };
                    this.child(
                        div()
                            .text_sm()
                            .when(warn, |this| this.text_color(color::warning()))
                            .child(core(lang, text)),
                    )
                })
                .children(
                    [
                        self.failed.clone(),
                        self.save_failed.clone(),
                        self.live.as_ref().and_then(|l| l.error.clone()),
                    ]
                    .into_iter()
                    .flatten()
                    .map(|message| div().text_sm().text_color(color::warning()).child(message)),
                )
                .when_some(draft, |this, draft| {
                    let monitor_muted = draft.monitor_muted;
                    this.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap_1()
                            .child(div().text_sm().child(core(lang, keys::LIVE_DEVICE)))
                            .child(Select::new(&self.device).disabled(saving)),
                    )
                    .child(with_hint(
                        "live-split-hint",
                        lang,
                        core(lang, keys::LIVE_SPLIT_KEPT),
                        Checkbox::new("live-split")
                            .checked(draft.split)
                            .disabled(saving || draft.device_id.is_none())
                            .label(core(lang, keys::LIVE_SPLIT))
                            .on_click(self.on_change(Change::Split)),
                    ))
                    .when(draft.split, |this| {
                        this.child(note(core(lang, keys::LIVE_SPLIT_SCOPE)))
                    })
                    .child(trim_row(
                        lang,
                        keys::LIVE_MONITOR_TRIM,
                        &self.monitor_trim,
                        draft.monitor_trim,
                        saving,
                    ))
                    .child(trim_row(
                        lang,
                        keys::LIVE_BROADCAST_TRIM,
                        &self.broadcast_trim,
                        draft.broadcast_trim,
                        saving,
                    ))
                    .child(
                        Checkbox::new("live-monitor-muted")
                            .checked(monitor_muted)
                            .disabled(saving)
                            .label(core(lang, keys::LIVE_MONITOR_MUTED))
                            .on_click(self.on_change(Change::MonitorMuted)),
                    )
                    .child(
                        Checkbox::new("live-confirm")
                            .checked(confirmed)
                            .disabled(saving)
                            .label(core(lang, keys::LIVE_CONFIRM))
                            .on_click({
                                let confirmed = self.confirmed.clone();
                                move |checked, window, _| {
                                    confirmed.set(*checked);
                                    window.refresh();
                                }
                            }),
                    )
                    .child(
                        Button::new("live-save")
                            .label(core(lang, keys::LIVE_SAVE))
                            .primary()
                            .disabled(!can_save || saving)
                            .on_click({
                                let saving = self.saving.clone();
                                move |_, window, cx| {
                                    saving.set(true);
                                    send(Command::LiveOutput(Some(draft.clone())), cx);
                                    window.refresh();
                                }
                            }),
                    )
                }),
        )
        .icon(IconName::Radio)
        .hint(lang, core(lang, keys::LIVE_SCOPE))
        .trailing(refresh)
    }
}

/// 名前・スライダー・値（%）の1行。値は下書きのもの。
fn trim_row(
    lang: Lang,
    label: &'static str,
    state: &Entity<SliderState>,
    value: f32,
    disabled: bool,
) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .gap_3()
        .child(div().flex_none().text_sm().child(core(lang, label)))
        .child(
            div().flex_1().child(
                Slider::new(state)
                    .horizontal()
                    .disabled(disabled)
                    .accessibility_label(core(lang, label)),
            ),
        )
        .child(
            div()
                .flex_none()
                .w(px(48.))
                .text_sm()
                .child(format!("{:.0}%", value * 100.)),
        )
}
