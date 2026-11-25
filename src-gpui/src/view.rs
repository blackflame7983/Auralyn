//! 窓の中身。左にレール（行き先）、中央に先頭の帯と行き先の画面、右に本番中の操作の列（DESIGN.md 10.3）。
//! 右の列は DESIGN.md 10.3・10.6 の並びと規則に合わせる。
//! 上から、緊急ミュート、入力（見出し・機器名・横メーター・マイク音量）、出力（一言・ミュートの札・機器名・ピーク・出力音量）、
//! VSTを外して比較。

use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::alert::Alert;
use gpui_kit::component::button::Button;
use gpui_kit::component::select::SelectEvent;
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::connect::ConnectPage;
use crate::desktop::{Action, Desktop};
use crate::engine::{Command, Engine, Notice};
use crate::home;
use crate::i18n::{core, keys, Lang};
use crate::locale_file;
use crate::settings;
use crate::shell::{self, Page};
use crate::sound::SoundPage;
use crate::vst::{Send, VstPage};
use auralyn_ui_model::flow::Flow;
use auralyn_ui_model::meter::{self, Meter, State as MeterState, Verdict};
use auralyn_ui_model::session::{Event as SessionEvent, Phase};
use auralyn_ui_model::sound::Change;

/// 描画の周期。全メーターで1つを共有する（10.6 の最後の項）。
const FRAME: Duration = Duration::from_millis(16);
/// ピーク保護の反映待ちを読み直す間隔（Tauri 版の `usePeakProtectionSync` と同じ）。
const PEAK_POLL: Duration = Duration::from_millis(500);
/// 右の列の幅（`src/index.css` の `--safety-column-width`）。
const SAFETY_COLUMN_WIDTH: f32 = 212.;

pub struct MainView {
    engine: Engine,
    desktop: Desktop,
    lang: Lang,
    page: Page,
    phase: Phase,
    muted: bool,
    bypassed: bool,
    input_name: Option<String>,
    output_name: Option<String>,
    message: Option<String>,
    input: Meter,
    output: Meter,
    /// 加工後（出力音量・ピーク保護・ミュートの前）。音の流れの帯だけが使う。
    processed: Meter,
    flow: Flow,
    level_seq: u64,
    /// ピーク保護の反映待ちを最後に読み直した時刻。
    peak_polled: Instant,
    input_gain: Entity<SliderState>,
    output_gain: Entity<SliderState>,
    /// 表示言語を保存するフォルダ。
    config_dir: PathBuf,
    connect: ConnectPage,
    vst: VstPage,
    sound: SoundPage,
    _ticker: Task<()>,
}

impl MainView {
    pub fn new(
        engine: Engine,
        lang: Lang,
        config_dir: PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input_gain = cx.new(|_| {
            SliderState::new()
                .min(0.0)
                .max(200.0)
                .step(1.0)
                .default_value(100.0)
        });
        let output_gain = cx.new(|_| {
            SliderState::new()
                .min(0.0)
                .max(200.0)
                .step(1.0)
                .default_value(100.0)
        });
        cx.subscribe(&input_gain, |this, _, event: &SliderEvent, _| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            this.engine
                .send(Command::SetInputGain(value.start() / 100.0));
        })
        .detach();
        cx.subscribe(&output_gain, |this, _, event: &SliderEvent, _| {
            let (SliderEvent::Change(value) | SliderEvent::Release(value)) = event;
            this.engine
                .send(Command::SetOutputGain(value.end() / 100.0));
        })
        .detach();
        let connect = ConnectPage::new(window, cx);
        let vst = VstPage::new(window, cx);
        let sound = SoundPage::new(cx);
        cx.subscribe(&sound.amount, |this, _, event: &SliderEvent, _| {
            let SliderEvent::Release(value) = event else {
                return;
            };
            this.send(Command::SetSound(Change::Amount(value.end() / 100.0)));
        })
        .detach();
        cx.subscribe(&sound.strength, |this, _, event: &SliderEvent, _| {
            let SliderEvent::Release(value) = event else {
                return;
            };
            this.send(Command::SetSound(Change::Strength(value.end() / 100.0)));
        })
        .detach();
        cx.subscribe_in(
            &connect.host,
            window,
            |this, _, _: &SelectEvent<Vec<SharedString>>, window, cx| {
                this.connect.fill(window, cx);
                cx.notify();
            },
        )
        .detach();
        let ticker = cx.spawn_in(window, async move |this, cx| loop {
            cx.background_executor().timer(FRAME).await;
            if this
                .update_in(cx, |this, window, cx| this.tick(window, cx))
                .is_err()
            {
                break;
            }
        });
        let now = Instant::now();
        let desktop = Desktop::new(lang);
        if let Some(error) = &desktop.tray_error {
            log::warn!("トレイを作れません: {error}");
        }
        if let Some(error) = &desktop.hotkey_error {
            log::warn!("Alt+M を登録できません: {error}");
        }
        let message = desktop
            .hotkey_error
            .as_ref()
            .map(|e| format!("{}: {e}", core(lang, keys::HOTKEY_FAILED)));
        Self {
            engine,
            desktop,
            lang,
            page: Page::Home,
            phase: Phase::LAUNCH,
            muted: false,
            bypassed: false,
            input_name: None,
            output_name: None,
            message,
            input: Meter::stopped(now),
            output: Meter::stopped(now),
            processed: Meter::stopped(now),
            flow: Flow::default(),
            level_seq: 0,
            peak_polled: now,
            input_gain,
            output_gain,
            config_dir,
            connect,
            vst,
            sound,
            _ticker: ticker,
        }
    }

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changed = false;
        for notice in self.engine.notices.try_iter().collect::<Vec<_>>() {
            self.apply(notice, window, cx);
            changed = true;
        }
        // 反映待ちのあいだだけ、Tauri 版と同じ 500ms ごとに読み直す（返事が来るまで「反映待ち」が残らないように）。
        if self.page == Page::Sound
            && self.sound.peak_pending()
            && self.peak_polled.elapsed() >= PEAK_POLL
        {
            self.peak_polled = Instant::now();
            self.engine.send(Command::ReadPeak);
        }
        for action in self.desktop.poll() {
            match action {
                Action::ToggleMute => self.toggle_mute(),
                Action::Show => window.activate_window(),
                Action::Quit => {
                    self.engine.save_before_quit();
                    cx.quit()
                }
            }
            changed = true;
        }
        // 10.6 は「窓が隠れている間は止める」。GPUI 0.3.14 には窓が見えているかを知る API がないので、まだ止めない。
        {
            let slot = *self.engine.levels.lock().unwrap_or_else(|e| e.into_inner());
            if slot.seq != self.level_seq {
                self.level_seq = slot.seq;
                let at = slot.received_at.unwrap_or_else(Instant::now);
                self.input.receive(slot.input, at);
                self.output.receive(slot.output, at);
                // テスト音などで子が加工後を送らないあいだは、出力で代える。
                self.processed
                    .receive(slot.processed.unwrap_or(slot.output), at);
            }
            let now = Instant::now();
            changed |= self.input.tick(now);
            changed |= self.output.tick(now);
            changed |= self.processed.tick(now);
        }
        if changed {
            self.flow.update(
                self.phase.running(),
                &self.input,
                &self.processed,
                cx.reduce_motion(),
            );
            // shortcut: メーターのために窓全体（レール・帯・画面）を 16ms ごとに組み直す。重くなったらメーターの部分を別の Entity に分け、そこだけ notify する。
            cx.notify();
        }
    }

    fn apply(&mut self, notice: Notice, window: &mut Window, cx: &mut App) {
        match notice {
            Notice::Started { input, output } => {
                self.input_name = input;
                self.output_name = output;
                self.advance(SessionEvent::Started);
                self.reread_peak();
            }
            Notice::Stopped => {
                self.advance(SessionEvent::Stopped);
                self.reread_peak();
            }
            Notice::StreamError(message) => {
                self.advance(SessionEvent::Stopped);
                self.reread_peak();
                self.message = Some(message);
            }
            Notice::NotStarted(message) => {
                self.fail(SessionEvent::StartFailed, keys::START_FAILED, message)
            }
            Notice::StopFailed(message) => {
                self.fail(SessionEvent::StopFailed, keys::STOP_FAILED, message)
            }
            Notice::Unconfigured => self.advance(SessionEvent::NoSavedConfig),
            Notice::Muted(muted) => self.muted = muted,
            Notice::Bypassed(bypassed) => self.bypassed = bypassed,
            Notice::Rack(rack) => self.vst.set_rack(rack),
            Notice::Sound(sound) => self.sound.set(sound, window, cx),
            Notice::Peak(peak) => self.sound.set_peak(peak),
            Notice::Catalog(Ok(candidates)) => self.vst.set_catalog(candidates, window, cx),
            Notice::Catalog(Err(message)) => {
                self.vst.scan_failed();
                self.message = Some(format!("scan_plugins: {message}"));
            }
            Notice::Devices { devices, saved } => {
                self.connect.set_devices(devices, saved, window, cx)
            }
            Notice::Failed { command, message } => {
                // 楽観的に変えた表示を、通知で確定した状態へ戻す。ミュートと比較は通知で決まる。
                self.message = Some(format!("{command}: {message}"));
            }
        }
    }

    /// 状態を進め、音が流れ始めた・止まったときだけメーターを合わせる（停止の失敗で実行中に戻ったときも含む）。
    fn advance(&mut self, event: SessionEvent) {
        let was_running = self.phase.running();
        self.phase = self.phase.next(event);
        match (was_running, self.phase.running()) {
            (false, true) => [&mut self.input, &mut self.output, &mut self.processed]
                .into_iter()
                .for_each(Meter::start),
            (true, false) => [&mut self.input, &mut self.output, &mut self.processed]
                .into_iter()
                .for_each(Meter::stop),
            _ => {}
        }
    }

    fn fail(&mut self, event: SessionEvent, key: &'static str, detail: String) {
        self.advance(event);
        self.message = Some(format!("{} {detail}", core(self.lang, key)));
    }

    /// ピーク保護は音声が動いているときだけ読めるので、開始・停止のあと、音づくりの画面を見ていれば読み直す。
    fn reread_peak(&self) {
        if self.page == Page::Sound {
            self.engine.send(Command::ReadPeak);
        }
    }

    fn open(&mut self, page: Page) {
        self.page = page;
        // 開くたびに頼む。2回目からはエンジンが覚えた一覧を返すので軽い。前回の失敗と、開始で変わった保存した設定も、これで読み直す。
        if page == Page::Connect {
            self.engine.send(Command::ListDevices);
        }
        if page == Page::Sound {
            self.engine.send(Command::ReadSound);
            self.engine.send(Command::ReadPeak);
        }
        if page == Page::Vst && self.vst.needs_scan() {
            self.send(Command::ScanPlugins);
        }
    }

    /// 画面からの命令。候補を探し始めたら、終わるまで探し直しのボタンを止める。
    fn send(&mut self, command: Command) {
        if matches!(command, Command::ScanPlugins) {
            self.vst.scan_started();
        }
        self.engine.send(command);
    }

    /// 接続の画面で選んだ機器で開始する。押せるのは止まっているときだけ。
    fn start_chosen(&mut self, cx: &App) {
        let Some((input, output)) = self.connect.chosen(cx) else {
            return;
        };
        if !matches!(self.phase, Phase::Stopped | Phase::Unconfigured) {
            return;
        }
        self.advance(SessionEvent::StartRequested);
        self.message = None;
        self.engine.send(Command::StartWith { input, output });
    }

    /// 帯のボタン。押せるのは結果を待っていないときだけ（`Phase::busy`）。
    fn press_band(&mut self) {
        let (event, command) = match self.phase {
            Phase::Unconfigured | Phase::Stopped => (SessionEvent::StartRequested, Command::Start),
            Phase::Running => (SessionEvent::StopRequested, Command::Stop),
            Phase::Starting | Phase::Stopping => return,
        };
        self.advance(event);
        self.message = None;
        self.engine.send(command);
    }

    /// 窓を閉じて終了する前に呼ぶ。
    pub fn save_before_quit(&self) {
        self.engine.save_before_quit();
    }

    fn toggle_mute(&mut self) {
        self.engine.send(Command::SetMute(!self.muted));
    }

    fn set_lang(&mut self, lang: Lang) {
        if lang == self.lang {
            return;
        }
        self.lang = lang;
        self.desktop.set_lang(lang);
        let failed = |lang| core(lang, keys::LANGUAGE_SAVE_FAILED);
        match locale_file::save(&self.config_dir, lang) {
            Ok(()) => {
                // 前に失敗した警告だけを消す（ほかの警告は残す）。
                if self.message.as_deref().is_some_and(|m| {
                    [Lang::Ja, Lang::En]
                        .into_iter()
                        .any(|l| m.starts_with(failed(l)))
                }) {
                    self.message = None;
                }
            }
            Err(e) => {
                log::warn!("表示言語を保存できません: {e}");
                self.message = Some(format!("{} {e}", failed(lang)));
            }
        }
    }

    fn render_mute(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        let muted = self.muted;
        div()
            .id("emergency-mute")
            .role(Role::Button)
            .aria_label(core(lang, keys::EMERGENCY))
            .aria_toggled(if muted { Toggled::True } else { Toggled::False })
            .when(muted, |this| {
                this.aria_description(core(lang, keys::MUTE_ON))
            })
            .focusable()
            .tab_stop(true)
            .flex()
            .flex_col()
            .gap_0p5()
            .w_full()
            .px_3()
            .py_1p5()
            .rounded_full()
            .border_1()
            .border_color(color::destructive_text())
            .text_sm()
            .font_weight(FontWeight::MEDIUM)
            .text_color(color::foreground())
            .cursor_pointer()
            .map(|this| {
                if muted {
                    this.bg(color::destructive_soft()).shadow(vec![BoxShadow {
                        color: color::destructive_text(),
                        offset: point(px(0.), px(0.)),
                        blur_radius: px(0.),
                        spread_radius: px(2.),
                        inset: false,
                    }])
                } else {
                    this.bg(color::background())
                        .hover(|style| style.bg(color::destructive_soft()))
                }
            })
            .focus_visible(|style| style.border_2().border_color(color::primary()))
            .on_click(cx.listener(|this, _, _, _| this.toggle_mute()))
            .child(core(lang, keys::EMERGENCY))
            .when(muted, |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(color::destructive_text())
                        .child(core(lang, keys::MUTED_SHORT)),
                )
            })
    }

    fn render_input(&self) -> impl IntoElement {
        let lang = self.lang;
        section()
            .child(heading(core(lang, keys::MIC)))
            .when_some(self.input_name.clone(), |this, name| {
                this.child(device(name))
            })
            .child(meter_bar("input-meter", &self.input, lang))
            .child(slider_row(
                "input-gain",
                core(lang, keys::MIC_VOLUME),
                &self.input_gain,
            ))
    }

    fn render_output(&self, cx: &App) -> impl IntoElement {
        let lang = self.lang;
        let stopped = self.output.state() == MeterState::Stopped;
        let verdict = (!self.muted).then(|| self.output.verdict()).flatten();
        let volume_zero = self.output_gain.read(cx).value().end() == 0.0;
        section()
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_x_2()
                    .min_h(px(22.))
                    .child(heading(core(lang, keys::OUTPUT_HEADING)))
                    .map(|this| {
                        if self.muted || volume_zero {
                            this.child(
                                div()
                                    .ml_auto()
                                    .px_1p5()
                                    .py_0p5()
                                    .rounded_full()
                                    .border_1()
                                    .border_color(color::warning().opacity(0.5))
                                    .bg(color::warning().opacity(0.1))
                                    .text_xs()
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(color::warning())
                                    .child(core(lang, keys::OUTPUT_MUTED)),
                            )
                        } else if let Some(verdict) = verdict {
                            let (text, dot) = match verdict {
                                Verdict::High => (core(lang, keys::LEVEL_HIGH), color::warning()),
                                Verdict::Low => (core(lang, keys::LEVEL_LOW), color::muted()),
                                Verdict::Ok => (core(lang, keys::LEVEL_OK), color::success()),
                            };
                            this.child(
                                div()
                                    .ml_auto()
                                    .flex()
                                    .items_center()
                                    .gap_1()
                                    .text_xs()
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(div().w(px(16.)).h(px(8.)).rounded_full().bg(dot))
                                    .child(text),
                            )
                        } else {
                            this
                        }
                    }),
            )
            .when_some(self.output_name.clone(), |this, name| {
                this.child(device(name))
            })
            .child(
                div()
                    .id("output-peak")
                    .role(Role::Label)
                    .aria_label(if stopped {
                        core(lang, keys::OUTPUT_PEAK_STOPPED).to_string()
                    } else {
                        format!(
                            "{} {} dBFS",
                            core(lang, keys::OUTPUT_PEAK),
                            meter::format_peak(self.output.peak())
                        )
                    })
                    .flex()
                    .justify_end()
                    .items_baseline()
                    .gap_1p5()
                    .text_xs()
                    .text_color(color::muted())
                    .child(core(lang, keys::PEAK))
                    .child(div().font_family("Consolas").child(if stopped {
                        "—".to_string()
                    } else {
                        format!("{} dBFS", meter::format_peak(self.output.peak()))
                    })),
            )
            .child(slider_row(
                "output-gain",
                core(lang, keys::OUTPUT_VOLUME),
                &self.output_gain,
            ))
    }

    fn render_compare(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        let bypassed = self.bypassed;
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                Button::new("compare")
                    .label(core(lang, keys::COMPARE))
                    .outline()
                    .toggled(bypassed)
                    .w_full()
                    .on_click(cx.listener(move |this, _, _, _| {
                        this.engine.send(Command::SetBypass(!bypassed));
                    })),
            )
            .when(bypassed, |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(color::muted())
                        .child(core(lang, keys::COMPARE_ON)),
                )
            })
    }
}

impl Render for MainView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        let entity = cx.entity();
        let rail = shell::rail(self.page, lang, {
            let entity = entity.clone();
            move |page, _, cx| {
                entity.update(cx, |this, cx| {
                    this.open(page);
                    cx.notify();
                })
            }
        });
        let route = match (self.phase.running(), &self.input_name, &self.output_name) {
            (true, Some(input), Some(output)) => Some(format!("{input} → {output}").into()),
            _ => None,
        };
        let band = shell::band(self.phase, route, lang, {
            let entity = entity.clone();
            move |_, cx| {
                entity.update(cx, |this, cx| {
                    this.press_band();
                    cx.notify();
                })
            }
        });
        let send: Send = {
            let entity = entity.clone();
            Rc::new(move |command, cx| {
                entity.update(cx, |this, cx| {
                    this.send(command);
                    cx.notify();
                })
            })
        };
        div()
            .size_full()
            .flex()
            .bg(color::background())
            .text_color(color::foreground())
            .font_family("Yu Gothic UI")
            .child(rail)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .child(band)
                    .when_some(self.message.clone(), |this, message| {
                        this.child(Alert::warning("message", message).banner())
                    })
                    .child(
                        div()
                            .id("page")
                            .role(Role::Main)
                            .aria_label(self.page.label(lang))
                            .flex_1()
                            .min_h_0()
                            .flex()
                            .flex_col()
                            .gap_3()
                            .p_4()
                            .overflow_y_scroll()
                            .map(|this| match self.page {
                                Page::Home => this.children(home::sound_flow(&self.flow, lang)),
                                Page::Settings => this.child(settings::render(
                                    lang,
                                    self.desktop.tray_error.as_deref(),
                                    self.desktop.hotkey_error.as_deref(),
                                    {
                                        let entity = entity.clone();
                                        move |lang, _, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.set_lang(lang);
                                                cx.notify();
                                            })
                                        }
                                    },
                                )),
                                Page::Vst => this.child(self.vst.render(lang, cx, send)),
                                Page::Sound => this.child(self.sound.render(lang, send)),
                                Page::Connect => this.child(self.connect.render(
                                    self.phase,
                                    lang,
                                    cx,
                                    move |_, cx| {
                                        entity.update(cx, |this, cx| {
                                            this.start_chosen(cx);
                                            cx.notify();
                                        })
                                    },
                                )),
                            }),
                    ),
            )
            .child(self.render_safety_column(cx))
    }
}

impl MainView {
    fn render_safety_column(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = self.lang;
        div()
            .id("safety-column")
            .role(Role::Complementary)
            .aria_label(core(lang, keys::SAFETY_COLUMN))
            .w(px(SAFETY_COLUMN_WIDTH))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .gap_3()
            .p_3()
            .border_l_1()
            .border_color(color::border())
            .bg(color::card())
            .child(self.render_mute(cx))
            .child(self.render_input())
            .child(self.render_output(cx))
            .child(self.render_compare(cx))
    }
}

fn section() -> Div {
    div().flex().flex_col().gap_1p5()
}

fn heading(text: &'static str) -> impl IntoElement {
    div()
        .id(SharedString::new_static(text))
        .role(Role::Heading)
        .aria_level(3)
        .aria_label(text)
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .child(text)
}

fn device(name: String) -> impl IntoElement {
    div()
        .text_xs()
        .text_color(color::muted())
        .truncate()
        .child(name)
}

fn state_text(state: MeterState, lang: Lang) -> &'static str {
    match state {
        MeterState::Stopped => core(lang, keys::STATE_STOPPED),
        MeterState::Waiting | MeterState::Stale => core(lang, keys::STATE_WAITING),
        MeterState::Silent => core(lang, keys::STATE_SILENT),
        MeterState::Live => core(lang, keys::STATE_ACTIVE),
    }
}

/// 横メーター。オーロラの正常域、−6 dBFS からの黄色、クリップの赤。状態は文字でも出す（色だけで伝えない）。
fn meter_bar(id: &'static str, reading: &Meter, lang: Lang) -> impl IntoElement {
    let level = meter::position(reading.smoothed());
    let peak = meter::position(reading.peak());
    let warn = meter::warning_position();
    let state = reading.state();
    let normal = level.min(warn);
    let hot = (level - warn).max(0.0);
    div()
        .id(id)
        .role(Role::Meter)
        .aria_label(core(lang, keys::INPUT_LEVEL))
        .aria_value(state_text(state, lang))
        .aria_min_numeric_value(0.0)
        .aria_max_numeric_value(1.0)
        .aria_numeric_value(level as f64)
        .relative()
        .w_full()
        .h(px(16.))
        .rounded(px(4.))
        .overflow_hidden()
        .bg(color::track())
        .child(
            div()
                .absolute()
                .top_0()
                .bottom_0()
                .left_0()
                .w(relative(normal))
                .bg(color::aurora_fill(1.)),
        )
        .when(hot > 0.0, |this| {
            this.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(relative(warn))
                    .w(relative(hot))
                    .bg(if reading.peak() >= 1.0 {
                        color::meter_danger()
                    } else {
                        color::meter_warning()
                    }),
            )
        })
        .when(peak > 0.0, |this| {
            this.child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(relative(peak))
                    .w(px(2.))
                    .bg(color::foreground().opacity(0.8)),
            )
        })
        .when(!matches!(state, MeterState::Live), |this| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_xs()
                    .text_color(color::muted())
                    .child(state_text(state, lang)),
            )
        })
}

fn slider_row(
    id: &'static str,
    label: &'static str,
    state: &Entity<SliderState>,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .gap_2()
        .child(
            div()
                .text_xs()
                .text_color(color::muted())
                .flex_none()
                .child(label),
        )
        .child(
            div()
                .flex_1()
                .child(Slider::new(state).horizontal().accessibility_label(label)),
        )
}
