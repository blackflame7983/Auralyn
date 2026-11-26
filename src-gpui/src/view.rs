//! 窓の中身。左にレール（行き先）、中央に先頭の帯と行き先の画面、右に本番中の操作の列（DESIGN.md 10.3）。
//! 右の列は DESIGN.md 10.3・10.6 の並びと規則に合わせる。
//! 上から、緊急ミュート、入力（見出し・機器名・横メーター・マイク音量）、出力（一言・ミュートの札・機器名・ピーク・出力音量）、
//! VSTを外して比較。

use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use std::time::{Duration, Instant};

use gpui_kit::component::alert::Alert;
use gpui_kit::component::button::Button;
use gpui_kit::component::input::InputEvent;
use gpui_kit::component::select::SelectEvent;
use gpui_kit::component::slider::{Slider, SliderEvent, SliderState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::color;
use crate::connect::ConnectPage;
use crate::desktop::{self, Action, Desktop};
use crate::engine::{Command, Engine, Listen, Notice};
use crate::home;
use crate::i18n::{core, keys, Lang};
use crate::live::LivePanel;
use crate::locale_file;
use crate::part::OnCommand;
use crate::settings;
use crate::setups::SetupsPanel;
use crate::shell::{self, Page};
use crate::sound::SoundPage;
use crate::voice::VoicePanel;
use crate::vst::VstPage;
use auralyn_ui_model::diagnostics::Stats;
use auralyn_ui_model::flow::Flow;
use auralyn_ui_model::measurement;
use auralyn_ui_model::meter::{self, Meter, OutputTag, State as MeterState, Verdict};
use auralyn_ui_model::session::{Event as SessionEvent, Phase};
use auralyn_ui_model::shortcuts;
use auralyn_ui_model::sound::Change;

mod safety;

/// 描画の周期。全メーターで1つを共有する（10.6 の最後の項）。
const FRAME: Duration = Duration::from_millis(16);
/// ピーク保護の反映待ちを読み直す間隔（Tauri 版の `usePeakProtectionSync` と同じ）。
const PEAK_POLL: Duration = Duration::from_millis(500);
/// 配信用の出力の状態を読み直す間隔（Tauri 版の `LiveOutputPanel` と同じ）。
const LIVE_POLL: Duration = Duration::from_secs(1);
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
    /// 配信用の出力を最後に読み直した時刻。
    live_polled: Instant,
    /// 窓をトレイへ隠している。隠れている間はメーターを計算しない（DESIGN.md 10.6）。
    hidden: Rc<Cell<bool>>,
    input_gain: Entity<SliderState>,
    output_gain: Entity<SliderState>,
    /// 表示言語を保存するフォルダ。
    config_dir: PathBuf,
    connect: ConnectPage,
    vst: VstPage,
    setups: SetupsPanel,
    voice: VoicePanel,
    live: LivePanel,
    /// 設定の画面の稼働統計。`None` は読めていない・読めなかった。
    stats: Option<Stats>,
    /// 読み込みを止めた VST のリセットの直前の結果（失敗なら理由。スキャン中は断られる）。
    cleared: Option<Result<(), String>>,
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
        let connect = ConnectPage::new(lang, window, cx);
        let vst = VstPage::new(window, cx);
        let setups = SetupsPanel::new(window, cx);
        cx.subscribe(&setups.name, |this, _, event: &InputEvent, cx| {
            if let InputEvent::PressEnter { .. } = event {
                if let Some(command) = this.setups.save(cx) {
                    this.send(command);
                }
            }
            cx.notify();
        })
        .detach();
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
        for limit in [&sound.ceiling, &sound.release] {
            cx.subscribe(limit, |this, _, event: &SliderEvent, cx| {
                if let SliderEvent::Release(_) = event {
                    let command = this.sound.peak_limits(cx);
                    this.send(command);
                }
            })
            .detach();
        }
        cx.subscribe_in(
            &connect.host,
            window,
            |this, _, _: &SelectEvent<Vec<SharedString>>, window, cx| {
                this.connect.fill(window, cx);
                cx.notify();
            },
        )
        .detach();
        for state in [&connect.input, &connect.output] {
            cx.subscribe_in(
                state,
                window,
                |this, _, _: &SelectEvent<Vec<SharedString>>, window, cx| {
                    this.connect.devices_changed(window, cx);
                    cx.notify();
                },
            )
            .detach();
        }
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
        let desktop = Desktop::new(lang, &config_dir);
        // 窓の × ではトレイへ隠し、音は止めない（Tauri 版と同じ）。トレイが無ければ戻す手段が無いので、閉じて終わる。
        let hidden = Rc::new(Cell::new(false));
        if desktop.tray_error.is_none() {
            let hidden = hidden.clone();
            window.on_window_should_close(cx, move |window, _| {
                desktop::set_shown(window, false);
                hidden.set(true);
                false
            });
        }
        if let Some(error) = &desktop.tray_error {
            log::warn!("トレイを作れません: {error}");
        }
        if let Some(error) = &desktop.shortcuts_error {
            log::warn!("ショートカットを登録できません: {error}");
        }
        for failed in &desktop.shortcuts {
            if let Some(error) = &failed.error {
                log::warn!("{} を登録できません: {error}", failed.binding.shortcut);
            }
        }
        let message = match &desktop.shortcuts_error {
            Some(error) => Some(format!(
                "{}: {error}",
                core(lang, keys::SHORTCUTS_UNREADABLE)
            )),
            None => desktop
                .shortcut_failed()
                .then(|| core(lang, keys::HOTKEY_FAILED).to_owned()),
        };
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
            live_polled: now,
            hidden,
            input_gain,
            output_gain,
            config_dir,
            connect,
            vst,
            setups,
            voice: VoicePanel::new(window, cx),
            live: LivePanel::new(window, cx),
            stats: None,
            cleared: None,
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
        // 接続の画面を出している間は、配信用の出力が届いているかを読み直す。
        if self.page == Page::Connect
            && !self.hidden.get()
            && self.live_polled.elapsed() >= LIVE_POLL
        {
            self.live_polled = Instant::now();
            self.engine.send(Command::LiveOutput(None));
        }
        // 反映待ちのあいだだけ、Tauri 版と同じ 500ms ごとに読み直す（返事が来るまで「反映待ち」が残らないように）。
        if self.page == Page::Sound && self.peak_polled.elapsed() >= PEAK_POLL {
            if self.sound.peak_pending() {
                self.peak_polled = Instant::now();
                self.engine.send(Command::ReadPeak);
            }
            let open = self
                .voice
                .open(self.phase == Phase::Running && !self.hidden.get());
            if let Some(command) = open {
                self.engine.send(command);
            }
            if self.voice.polls() {
                self.peak_polled = Instant::now();
                self.engine.send(Command::Listen(Listen::Status));
            }
            if self.sound.shows_measurement() {
                self.peak_polled = Instant::now();
                self.engine
                    .send(Command::Measure(measurement::Action::Read));
            }
        }
        for action in self.desktop.poll() {
            match action {
                Action::Shortcut(action) => self.shortcut(action, window, cx),
                Action::Show => {
                    desktop::set_shown(window, true);
                    self.hidden.set(false);
                    window.activate_window()
                }
                Action::Quit => cx.quit(),
            }
            changed = true;
        }
        // 隠れている間は録らない（Tauri 版と同じ）。
        if self.hidden.get() {
            for command in self.voice.leave() {
                self.engine.send(command);
            }
        }
        // 隠れている間は読まない。出し直したら、最新の値と経った時間から続ける。
        if !self.hidden.get() {
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

    fn apply(&mut self, notice: Notice, window: &mut Window, cx: &mut Context<Self>) {
        match notice {
            Notice::Started { input, output } => {
                self.input_name = input;
                self.output_name = output;
                self.advance(SessionEvent::Started);
                self.reread_peak();
            }
            Notice::Stopped => {
                self.advance(SessionEvent::Stopped);
                self.voice.audio_stopped();
                self.reread_peak();
            }
            Notice::StreamError(message) => {
                self.advance(SessionEvent::Stopped);
                self.voice.audio_stopped();
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
            Notice::Rack(rack) => self.vst.set_rack(rack, window, cx, Self::send),
            Notice::Sound(sound) => self.sound.set(sound, window, cx),
            Notice::Peak(peak) => self.sound.set_peak(peak, window, cx),
            Notice::Measurement(reading) => self.sound.measure.set(reading),
            Notice::Catalog(Ok(candidates)) => self.vst.set_catalog(candidates, window, cx),
            Notice::Profiles(entries) => self.setups.set(entries, window, cx),
            Notice::ProfileFile(done) => self.setups.set_done(done, window, cx),
            Notice::Recording(recording) => self.voice.set(recording),
            Notice::Listening(result) => {
                self.voice.set_listening(result, window, cx);
                // 開くのを待つ間に画面を離れた・窓を隠したなら、開いたものをすぐ閉じる。
                if self.page != Page::Sound || self.hidden.get() {
                    for command in self.voice.leave() {
                        self.engine.send(command);
                    }
                }
            }
            Notice::RecordingSaved => self.voice.saved(),
            Notice::Stats(stats) => self.stats = stats,
            Notice::ExclusionsCleared(result) => {
                if let Err(e) = &result {
                    log::warn!("読み込みを止めた VST をリセットできません: {e}");
                }
                self.cleared = Some(result);
            }
            Notice::Catalog(Err(message)) => {
                self.vst.scan_failed();
                self.message = Some(format!("scan_plugins: {message}"));
            }
            Notice::Devices { devices, saved } => {
                self.live.set_devices(&devices, self.lang, window, cx);
                self.connect
                    .set_devices(devices, saved, self.lang, window, cx)
            }
            Notice::Live(result) => self.live.set(result, self.lang, window, cx),
            Notice::Failed { command, message } => {
                // 並び・音づくり・ピーク保護は、エンジンが送り直す状態で表示が戻る。入出力の音量のスライダーは戻さない
                // （出力は反映を確かめきれなかっただけで、子には新しい値が入っていることが多い）。
                self.setups.forget_done();
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
            _ => return,
        }
        // 音が流れ始めた・止まったら、見えている統計を読み直す（前の値を出し続けない）。
        if self.page == Page::Settings {
            self.engine.send(Command::ReadStats);
        }
    }

    fn fail(&mut self, event: SessionEvent, key: &'static str, detail: String) {
        self.advance(event);
        self.message = Some(format!("{} {detail}", core(self.lang, key)));
    }

    /// ピーク保護と測定は音声が動いているときだけ読めるので、開始・停止のあと、音づくりの画面を見ていれば読み直す。
    fn reread_peak(&self) {
        if self.page == Page::Sound {
            self.engine.send(Command::ReadPeak);
            self.engine
                .send(Command::Measure(measurement::Action::Read));
        }
    }

    fn open(&mut self, page: Page) {
        if self.page == Page::Sound && page != Page::Sound {
            self.leave_sound();
        }
        self.page = page;
        // 開くたびに頼む。2回目からはエンジンが覚えた一覧を返すので軽い。前回の失敗と、開始で変わった保存した設定も、これで読み直す。
        if page == Page::Connect {
            self.engine.send(Command::ListDevices);
            self.live_polled = Instant::now();
            self.engine.send(Command::LiveOutput(None));
        }
        if page == Page::Sound {
            self.engine.send(Command::ReadSound);
            self.reread_peak();
        }
        if page == Page::Vst {
            self.engine.send(Command::ListProfiles);
        }
        if page == Page::Settings {
            self.cleared = None;
            self.engine.send(Command::ReadStats);
        }
        if page == Page::Vst && self.vst.needs_scan() {
            self.send(Command::ScanPlugins);
        }
    }

    /// 音づくりの画面を離れるとき。この画面で始めた測定は中止する（見ていない間に測り終えて置き去りにしない）。
    fn leave_sound(&mut self) {
        let leaving = self
            .sound
            .measure
            .leave()
            .into_iter()
            .chain(self.voice.leave());
        for command in leaving {
            self.engine.send(command);
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
        let (sample_rate, buffer_size) = self.connect.values(cx);
        if !matches!(self.phase, Phase::Stopped | Phase::Unconfigured) {
            return;
        }
        self.advance(SessionEvent::StartRequested);
        self.message = None;
        self.engine.send(Command::StartWith {
            input,
            output,
            sample_rate,
            buffer_size,
        });
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

    /// グローバルショートカットの操作（Tauri 版と同じ動き）。比較は音声が動いているときだけ切り替える。
    fn shortcut(&mut self, action: shortcuts::Action, window: &mut Window, cx: &mut App) {
        use shortcuts::Action as A;
        match action {
            A::MuteToggle => self.toggle_mute(),
            A::MuteOn | A::MuteOff => self.engine.send(Command::SetMute(action == A::MuteOn)),
            A::BypassToggle | A::BypassOn | A::BypassOff => {
                if self.phase == Phase::Running {
                    self.engine.send(Command::SetBypass(match action {
                        A::BypassOn => true,
                        A::BypassOff => false,
                        _ => !self.bypassed,
                    }));
                }
            }
            A::GainUp | A::GainDown => {
                let current = self.output_gain.read(cx).value().end() / 100.0;
                let next = shortcuts::gain_step(current, action == A::GainUp);
                self.output_gain
                    .update(cx, |state, cx| state.set_value(next * 100.0, window, cx));
                self.engine.send(Command::SetOutputGain(next));
            }
            A::NoiseToggle => self.engine.send(Command::ToggleNoise),
            A::SingingOn | A::TalkOn => {}
        }
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
        let send: OnCommand = {
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
                                    {
                                        let entity = entity.clone();
                                        move |lang, _, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.set_lang(lang);
                                                cx.notify();
                                            })
                                        }
                                    },
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap_6()
                                        .child(settings::shortcuts(
                                            lang,
                                            &self.desktop.shortcuts,
                                            self.desktop.shortcuts_error.as_deref(),
                                        ))
                                        .child(settings::diagnostics(
                                            lang,
                                            self.stats.as_ref(),
                                            send.clone(),
                                        ))
                                        .child(settings::plugins(
                                            lang,
                                            self.cleared.as_ref(),
                                            send,
                                        )),
                                )),
                                Page::Vst => this
                                    .child(self.vst.render(lang, cx, send.clone()))
                                    .child(self.setups.render(lang, cx, send)),
                                Page::Sound => this
                                    .child(self.sound.render(lang, cx, send.clone()))
                                    .child(self.voice.render(
                                        lang,
                                        self.phase == Phase::Running,
                                        cx,
                                        send,
                                    )),
                                Page::Connect => this
                                    .child(self.connect.render(
                                        self.phase,
                                        lang,
                                        cx,
                                        move |_, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.start_chosen(cx);
                                                cx.notify();
                                            })
                                        },
                                    ))
                                    .child(
                                        div().max_w(px(560.)).child(self.live.render(lang, send)),
                                    ),
                            }),
                    ),
            )
            .child(self.render_safety_column(cx))
    }
}
