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

use auralyn_core::design::Theme;

use crate::color;
use crate::connect::ConnectPage;
use crate::desktop::{self, Action, Desktop};
use crate::engine::{
    Command, Engine, Listen, MixAction, ModeAction, Notice, PostAction, StartWith,
};
use crate::home;
use crate::i18n::{core, core_with, keys, Lang};
use crate::live::LivePanel;
use crate::locale_file;
use crate::mix::MixPanel;
use crate::modes::ModesPanel;
use crate::obs::ObsPanel;
use crate::part::OnCommand;
use crate::post_mix::PostMixPanel;
use crate::prep::{Goto, PrepPanel};
use crate::recovery;
use crate::scenes::ScenePanel;
use crate::settings;
use crate::setup::SetupPanel;
use crate::setups::SetupsPanel;
use crate::shell::{self, Page};
use crate::sound::SoundPage;
use crate::theme_file;
use crate::voice::VoicePanel;
use crate::vst::VstPage;
use auralyn_ui_model::connect::{Input, Purpose, SYSTEM_ROUTING};
use auralyn_ui_model::diagnostics::{self, Stats};
use auralyn_ui_model::flow::Flow;
use auralyn_ui_model::live_modes::Mode as LiveMode;
use auralyn_ui_model::measurement;
use auralyn_ui_model::meter::{self, Meter, OutputTag, State as MeterState, Verdict};
use auralyn_ui_model::peak::Limit;
use auralyn_ui_model::recovery::{Choice, Exit};
use auralyn_ui_model::scene_routing::Action as SceneAction;
use auralyn_ui_model::session::{Event as SessionEvent, Phase};
use auralyn_ui_model::shortcuts;
use auralyn_ui_model::sound::{Change, Knob};

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
    /// 歌・雑談の状態を最後に読み直した時刻（上の帯に出すので、どの画面でも読む）。
    modes_polled: Instant,
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
    scan_folders: crate::vst_folders::ScanFolders,
    setups: SetupsPanel,
    voice: VoicePanel,
    live: LivePanel,
    mix: MixPanel,
    post: PostMixPanel,
    modes: ModesPanel,
    /// 保存した入出力が無いと分かってから、まだ一度も始まっていない。ホームに「はじめての設定」を出す。
    first_run: bool,
    setup: SetupPanel,
    /// 音声エンジンが落ちて、まだ始め直していない。ホームに復旧のカードを出す。
    recovery: Option<Exit>,
    /// 設定の画面の稼働統計。`None` は読めていない・読めなかった。
    stats: Option<Stats>,
    mix_stats: diagnostics::Mix,
    /// 読み込みを止めた VST のリセットの直前の結果（失敗なら理由。スキャン中は断られる）。
    cleared: Option<Result<(), String>>,
    sound: SoundPage,
    obs: ObsPanel,
    scenes: ScenePanel,
    prep: PrepPanel,
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
        let setup = SetupPanel::new(window, cx);
        for state in [&setup.microphone, &setup.output, &connect.output_mode] {
            cx.subscribe(state, |_, _, _: &SelectEvent<Vec<SharedString>>, cx| {
                cx.notify()
            })
            .detach();
        }
        let vst = VstPage::new(window, cx);
        let scan_folders = crate::vst_folders::ScanFolders::new(&config_dir, window, cx);
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
        for (knob, slider) in Knob::ALL.into_iter().zip(&sound.knobs) {
            cx.subscribe(slider, move |this, _, event: &SliderEvent, _| {
                if let SliderEvent::Release(value) = event {
                    this.send(Command::SetSound(knob.change(value.end())));
                }
            })
            .detach();
        }
        for (limit, panel) in [
            (Limit::Sample, &sound.peak),
            (Limit::TruePeak, &sound.true_peak),
        ] {
            for slider in [&panel.ceiling, &panel.release] {
                cx.subscribe(slider, move |this, _, event: &SliderEvent, cx| {
                    if let SliderEvent::Release(_) = event {
                        let command = this.sound.limiter(limit).limits(cx);
                        this.send(command);
                    }
                })
                .detach();
            }
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
        cx.subscribe_in(
            &connect.source,
            window,
            |this, _, _: &SelectEvent<Vec<SharedString>>, window, cx| {
                this.connect.devices_changed(window, cx);
                // アプリの音声を選んだら、一覧をすぐ読む（Tauri 版と同じ）。
                if this.connect.uses_app(cx) {
                    this.send(Command::Mix(MixAction::Apps));
                }
                cx.notify();
            },
        )
        .detach();
        cx.subscribe_in(
            &connect.app,
            window,
            |this, _, _: &SelectEvent<Vec<SharedString>>, window, cx| {
                this.connect.app_changed(window, cx);
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
        let mix = MixPanel::new(window, cx, Self::send);
        let post = PostMixPanel::new(window, cx);
        cx.subscribe_in(
            mix.source_state(),
            window,
            |this, _, _: &SelectEvent<Vec<SharedString>>, window, cx| {
                this.mix.source_changed(this.lang, window, cx);
                cx.notify();
            },
        )
        .detach();
        // 最初はホームを出すので、配信ミックスに要るもの（機器・配信用の出力・ミックスとミックス後の VST の状態）を読んでおく。
        for command in [
            Command::ListDevices,
            Command::LiveOutput(None),
            Command::Mix(MixAction::Read),
            Command::PostMix(PostAction::Read, None),
            Command::Modes(ModeAction::Read),
        ] {
            engine.send(command);
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
        let obs = ObsPanel::new(
            &config_dir,
            engine.sender(),
            engine.timing.clone(),
            window,
            cx,
        );
        let scenes = ScenePanel::new(&config_dir, window, cx);
        let prep = PrepPanel::new(&config_dir, window, cx);
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
            modes_polled: now,
            live_polled: now,
            hidden,
            input_gain,
            output_gain,
            config_dir,
            connect,
            vst,
            scan_folders,
            setups,
            voice: VoicePanel::new(window, cx),
            live: LivePanel::new(window, cx),
            mix,
            post,
            modes: ModesPanel::default(),
            first_run: false,
            setup,
            recovery: None,
            stats: None,
            mix_stats: diagnostics::Mix::default(),
            cleared: None,
            sound,
            obs,
            scenes,
            prep,
            _ticker: ticker,
        }
    }

    fn tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changed = false;
        for notice in self.engine.notices.try_iter().collect::<Vec<_>>() {
            self.apply(notice, window, cx);
            changed = true;
        }
        changed |= self.obs.poll(window, cx);
        if let Some(scene) = self.obs.take_scene() {
            match self.scenes.action(&scene) {
                Some(SceneAction::Profile(name)) => self.engine.send(Command::SceneProfile(name)),
                Some(SceneAction::Mode(mode)) => {
                    self.engine.send(Command::Modes(ModeAction::Scene(mode)))
                }
                None => {}
            }
        }
        if self.page == Page::Settings && !self.hidden.get() {
            self.obs.recheck();
        }
        self.prep.set_hidden(self.hidden.get());
        if self.page == Page::Home && !self.hidden.get() {
            if let Some(command) = self.prep.tick(window, cx) {
                self.engine.send(command);
            }
        }
        // 接続の画面を出している間は、配信用の出力が届いているかを読み直す。
        if self.page == Page::Connect
            && !self.hidden.get()
            && self.live_polled.elapsed() >= LIVE_POLL
        {
            self.live_polled = Instant::now();
            self.engine.send(Command::LiveOutput(None));
        }
        // 歌・雑談と操作ロックは上の帯に出すので、窓が見えている間は Tauri 版と同じ 500ms ごとに読み直す
        // （手で音を変えていまの調整になったときや、ショートカットでの切り替えも追う）。登録が無ければ読まない。
        if !self.hidden.get() && self.modes.polls() && self.modes_polled.elapsed() >= PEAK_POLL {
            self.modes_polled = Instant::now();
            self.engine.send(Command::Modes(ModeAction::Read));
        }
        // 反映待ちのあいだと ON の true-peak 制限は、Tauri 版と同じ 500ms ごとに読み直す（`peak::polls`）。
        if self.page == Page::Sound && self.peak_polled.elapsed() >= PEAK_POLL {
            for limit in Limit::ALL {
                if !self.hidden.get() && self.sound.limiter(limit).polls() {
                    self.peak_polled = Instant::now();
                    self.engine.send(Command::ReadPeak(limit));
                }
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
                    self.engine.send(Command::Modes(ModeAction::Read));
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
            Notice::Preparation {
                observation,
                confirm,
            } => self.prep.apply(observation, confirm),
            // 落ちたあと、まだ始め直していないのに届いた開始は、落ちる前の開始の知らせ（落ちた知らせと別のスレッドから届く）。
            Notice::Started { .. }
                if self.recovery.is_some() && !matches!(self.phase, Phase::Starting) => {}
            Notice::Started { input, output } => {
                self.input_name = input;
                self.output_name = output;
                self.first_run = false;
                self.recovery = None;
                self.prep.audio_changed();
                self.advance(SessionEvent::Started);
                self.reread_peak();
                self.reread_mix();
            }
            Notice::Stopped => {
                self.audio_stopped();
            }
            Notice::StreamError(message) => {
                self.audio_stopped();
                self.message = Some(message);
            }
            Notice::EngineExited(exit) => {
                self.audio_stopped();
                self.recovery = Some(exit);
                self.open(Page::Home);
            }
            Notice::AppNotResumed(name) => {
                self.advance(SessionEvent::StartFailed);
                self.message = Some(core_with(
                    self.lang,
                    keys::APP_RESELECT_HELP,
                    &[("name", &name)],
                ));
            }
            // 開始・停止に失敗したときも、ホストがミックス後の VST を止めて捨てていることがあるので読み直す。
            Notice::NotStarted(message) => {
                self.fail(SessionEvent::StartFailed, keys::START_FAILED, message);
                self.reread_mix();
            }
            Notice::StopFailed(message) => {
                self.fail(SessionEvent::StopFailed, keys::STOP_FAILED, message);
                self.reread_mix();
            }
            Notice::Unconfigured => {
                self.first_run = true;
                self.advance(SessionEvent::NoSavedConfig);
            }
            Notice::Muted(muted) => self.muted = muted,
            Notice::Bypassed(bypassed) => self.bypassed = bypassed,
            Notice::Rack(rack) => self.vst.set_rack(rack, window, cx, Self::send),
            Notice::Sound(sound) => self.sound.set(sound, window, cx),
            Notice::Peak {
                limit,
                peak,
                answered,
            } => self.sound.limiter(limit).set(peak, answered, window, cx),
            Notice::Measurement(reading) => self.sound.measure.set(reading),
            Notice::Catalog(Ok((candidates, skipped))) => {
                self.vst.set_catalog(&candidates, window, cx);
                self.scan_folders.set_skipped(skipped);
                self.post.set_catalog(&candidates, window, cx);
            }
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
            Notice::Stats { stats, mix } => {
                self.stats = stats;
                self.mix_stats = mix;
            }
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
                self.setup.set_devices(&devices, window, cx);
                self.live.set_devices(&devices, self.lang, window, cx);
                self.connect
                    .set_devices(devices.clone(), saved, self.lang, window, cx);
                let voice = self.connect.chosen(cx).and_then(|(input, _)| input.id);
                self.mix
                    .set_devices(&devices, voice.as_deref(), self.lang, window, cx);
            }
            Notice::Mix(result) => self.mix.set(result, self.lang, window, cx),
            Notice::MixDone(result) => self.mix.done(result),
            Notice::Modes(result) => {
                if self.modes.set(result) {
                    self.engine.send(Command::ReadSound);
                }
            }
            Notice::ModesDone(result) => self.modes.done(result),
            Notice::ModesKeepsReverb => self.modes.keeps_reverb(),
            Notice::PostMix(result) => self.post.set(result, window, cx, Self::send),
            Notice::PostMixDone(result) => self.post.done(result),
            Notice::MixApps(result) => {
                // 配信ミックスのオケと接続の画面のアプリ入力は、同じ一覧（候補の id は読み直すまで有効）を使う。
                self.connect.set_apps(result.clone(), window, cx);
                self.mix.set_apps(result, self.lang, window, cx);
            }
            Notice::Live(result) => self.live.set(result, self.lang, window, cx),
            Notice::LiveSaved(result) => self.live.saved(result),
            Notice::Failed { command, message } => {
                // 並び・音づくり・ピーク保護は、エンジンが送り直す状態で表示が戻る。入出力の音量のスライダーは戻さない
                // （出力は反映を確かめきれなかっただけで、子には新しい値が入っていることが多い）。
                self.setups.forget_done();
                self.message = Some(if self.modes.armed() {
                    core(self.lang, keys::MODES_LOCKED).to_owned()
                } else {
                    format!("{command}: {message}")
                });
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

    /// ピーク保護・測定・歌と雑談のモードは開始・停止で変わるので、音づくりの画面を見ていれば読み直す。
    fn reread_peak(&self) {
        if self.page == Page::Sound {
            for limit in Limit::ALL {
                self.engine.send(Command::ReadPeak(limit));
            }
            self.engine
                .send(Command::Measure(measurement::Action::Read));
        }
        // 操作ロックは、ほかの画面の操作が断られた理由を出すのに使うので、どの画面でも読み直す。
        self.engine.send(Command::Modes(ModeAction::Read));
    }

    /// 音が止まった（止めた・途切れた・エンジンが落ちた）。
    fn audio_stopped(&mut self) {
        self.prep.audio_changed();
        self.advance(SessionEvent::Stopped);
        self.voice.audio_stopped();
        self.reread_peak();
        self.reread_mix();
    }

    /// 復旧のカードで選んだ方法。始め直す方法は、止まっているときだけ受ける。
    fn recover(&mut self, choice: Choice) {
        match choice.restart() {
            Some(hold) => {
                if !self.phase.can_start() {
                    return;
                }
                self.advance(SessionEvent::StartRequested);
                self.message = None;
                self.engine.send(Command::Recover(hold));
            }
            None => {
                self.recovery = None;
                if choice == Choice::ChooseDevice {
                    self.open(Page::Connect);
                }
            }
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
        if page == Page::Home {
            self.engine.send(Command::ListDevices);
            self.engine.send(Command::LiveOutput(None));
            self.engine.send(Command::Mix(MixAction::Read));
            self.engine.send(Command::PostMix(PostAction::Read, None));
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
            self.obs.open();
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

    /// ホームを出しているなら、配信ミックスとミックス後の VST の状態を読み直す（音声の開始・停止で、流れているかが変わる）。
    fn reread_mix(&mut self) {
        if self.page == Page::Home {
            self.engine.send(Command::Mix(MixAction::Read));
            self.engine.send(Command::PostMix(PostAction::Read, None));
        }
    }

    /// 画面からの命令。候補を探し始めたら、終わるまで探し直しのボタンを止める。
    fn send(&mut self, command: Command) {
        if matches!(command, Command::ScanPlugins) {
            self.vst.scan_started();
        }
        // ピーク保護・true-peak 制限は「接続の確認」の鍵に出ないので、変えたら確認をやり直す（Tauri 版と同じ）。
        if matches!(
            command,
            Command::SetPeak(..) | Command::SetPeakLimits { .. }
        ) {
            self.prep.external();
        }
        // ミックス後の VST を変える操作には、画面が見た世代を付ける（見た後に変わっていればホストが断る）。
        let command = match command {
            Command::PostMix(action, None) => Command::PostMix(action, self.post.seen()),
            other => other,
        };
        self.engine.send(command);
    }

    /// 接続の画面で選んだ入力・出力先で開始する。
    fn start_chosen(&mut self, cx: &App) {
        let Some((input, purpose, output)) = self.connect.start_choice(cx) else {
            return;
        };
        let (sample_rate, buffer_size) = self.connect.values(cx);
        self.start_with(StartWith {
            input,
            purpose,
            output,
            sample_rate,
            buffer_size,
            routing: self.connect.routing(cx),
        });
    }

    /// 選んだ入力・出力先で開始する。押せるのは止まっているときだけ。
    fn start_with(&mut self, start: StartWith) {
        if !self.phase.can_start() {
            return;
        }
        self.advance(SessionEvent::StartRequested);
        self.message = None;
        self.engine.send(Command::StartWith(start));
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
            // 選べるかはエンジンが読み直した状態で決め、断られたら上の帯に出す。
            A::SingingOn => self
                .engine
                .send(Command::Modes(ModeAction::Shortcut(LiveMode::Singing))),
            A::TalkOn => self
                .engine
                .send(Command::Modes(ModeAction::Shortcut(LiveMode::Talk))),
        }
    }

    /// テーマを替えて保存する。保存できなくても、この起動の間は替えたままにする。
    fn set_theme(&mut self, theme: Theme, cx: &mut App) {
        if theme == color::theme() {
            return;
        }
        color::set_theme(theme, cx);
        let result = theme_file::save(&self.config_dir, theme);
        self.report_save(keys::THEME_SAVE_FAILED, result);
    }

    /// 保存の結果を帯に出す。失敗は `failed` の文言で出し、成功したら同じ保存の前の警告だけを消す（ほかの警告は残す）。
    fn report_save(&mut self, failed: &'static str, result: std::io::Result<()>) {
        match result {
            Ok(()) => {
                let earlier = |m: &String| {
                    [Lang::Ja, Lang::En]
                        .into_iter()
                        .any(|l| m.starts_with(core(l, failed)))
                };
                if self.message.as_ref().is_some_and(earlier) {
                    self.message = None;
                }
            }
            Err(e) => {
                log::warn!("{failed}: {e}");
                self.message = Some(format!("{} {e}", core(self.lang, failed)));
            }
        }
    }

    fn set_lang(&mut self, lang: Lang, window: &mut Window, cx: &mut App) {
        if lang == self.lang {
            return;
        }
        self.lang = lang;
        self.desktop.set_lang(lang);
        self.mix.relabel(lang, window, cx);
        self.connect.set_lang(lang, window, cx);
        let result = locale_file::save(&self.config_dir, lang);
        self.report_save(keys::LANGUAGE_SAVE_FAILED, result);
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
        let band = shell::band(self.phase, self.modes.badges(lang), route, lang, {
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
                                Page::Home => this
                                    .when_some(self.recovery.as_ref(), |this, exit| {
                                        this.child(div().max_w(px(560.)).child(recovery::render(
                                            exit,
                                            lang,
                                            self.phase.can_start(),
                                            {
                                                let entity = entity.clone();
                                                move |choice, _, cx| {
                                                    entity.update(cx, |this, cx| {
                                                        this.recover(choice);
                                                        cx.notify();
                                                    })
                                                }
                                            },
                                        )))
                                    })
                                    .when(self.first_run, |this| {
                                        this.child(div().max_w(px(560.)).child(self.setup.render(
                                            lang,
                                            self.phase.can_start(),
                                            cx,
                                            {
                                                let entity = entity.clone();
                                                move |goal, window, cx| {
                                                    entity.update(cx, |this, cx| {
                                                        this.setup.set_goal(goal, window, cx);
                                                        cx.notify();
                                                    })
                                                }
                                            },
                                            {
                                                let entity = entity.clone();
                                                move |_, cx| {
                                                    entity.update(cx, |this, cx| {
                                                        if let Some((input, output)) =
                                                            this.setup.chosen(cx)
                                                        {
                                                            let usage = this.setup.goal().into();
                                                            if let Some(command) = this.prep.act(
                                                                crate::prep::Action::Usage(usage),
                                                            ) {
                                                                this.engine.send(command);
                                                            }
                                                            this.start_with(StartWith {
                                                                input: Input::Device(input),
                                                                purpose: Purpose::Voice,
                                                                output,
                                                                sample_rate: None,
                                                                buffer_size: None,
                                                                routing: SYSTEM_ROUTING,
                                                            });
                                                        }
                                                        cx.notify();
                                                    })
                                                }
                                            },
                                            {
                                                let entity = entity.clone();
                                                move |_, cx| {
                                                    entity.update(cx, |this, cx| {
                                                        this.open(Page::Connect);
                                                        cx.notify();
                                                    })
                                                }
                                            },
                                        )))
                                    })
                                    .children(home::sound_flow(&self.flow, lang))
                                    .child(div().max_w(px(560.)).child(self.prep.render(
                                        lang,
                                        {
                                            let entity = entity.clone();
                                            Rc::new(move |action, _, cx| {
                                                entity.update(cx, |this, cx| {
                                                    if let Some(command) = this.prep.act(action) {
                                                        this.engine.send(command);
                                                    }
                                                    cx.notify();
                                                })
                                            })
                                        },
                                        {
                                            let entity = entity.clone();
                                            Rc::new(move |goto, _, cx| {
                                                entity.update(cx, |this, cx| {
                                                    this.open(match goto {
                                                        Goto::Connect => Page::Connect,
                                                        Goto::Sound => Page::Sound,
                                                        Goto::Settings => Page::Settings,
                                                    });
                                                    cx.notify();
                                                })
                                            })
                                        },
                                    )))
                                    .child(div().max_w(px(560.)).child(self.mix.render(
                                        lang,
                                        self.live.ready(),
                                        cx,
                                        send.clone(),
                                    )))
                                    .child(div().max_w(px(560.)).child(self.post.render(
                                        lang,
                                        self.mix.active(),
                                        !self.phase.can_start(),
                                        self.vst.scanning(),
                                        cx,
                                        send,
                                    ))),
                                Page::Settings => this.child(settings::render(
                                    lang,
                                    self.desktop.tray_error.as_deref(),
                                    {
                                        let entity = entity.clone();
                                        move |lang, window, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.set_lang(lang, window, cx);
                                                cx.notify();
                                            })
                                        }
                                    },
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap_6()
                                        .child(settings::appearance(lang, color::theme(), {
                                            let entity = entity.clone();
                                            move |theme, _, cx| {
                                                entity.update(cx, |this, cx| {
                                                    this.set_theme(theme, cx);
                                                    cx.notify();
                                                })
                                            }
                                        }))
                                        .child(self.obs.render(lang, cx, {
                                            let entity = entity.clone();
                                            Rc::new(move |order, cx| {
                                                entity.update(cx, |this, cx| {
                                                    this.obs.order(order);
                                                    cx.notify();
                                                })
                                            })
                                        }))
                                        .child(self.scenes.render(lang, {
                                            let entity = entity.clone();
                                            Rc::new(move |edit, window, cx| {
                                                entity.update(cx, |this, cx| {
                                                    this.scenes.edit(edit, window, cx);
                                                    cx.notify();
                                                })
                                            })
                                        }))
                                        .child(settings::trouble(
                                            lang,
                                            self.desktop.tray_error.is_none(),
                                        ))
                                        .child(settings::glossary(lang))
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
                                        .child(settings::mix_diagnostics(lang, &self.mix_stats))
                                        .child(settings::plugins(
                                            lang,
                                            self.cleared.as_ref(),
                                            send,
                                        )),
                                )),
                                Page::Vst => this
                                    .child(self.vst.render(lang, cx, send.clone()))
                                    .child(self.scan_folders.render(
                                        lang,
                                        self.vst.scanning(),
                                        send.clone(),
                                    ))
                                    .child(self.setups.render(lang, cx, send)),
                                Page::Sound => this
                                    .child(self.sound.render(
                                        lang,
                                        self.modes.armed(),
                                        cx,
                                        send.clone(),
                                    ))
                                    .child(self.modes.render(lang, send.clone()))
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
                                        {
                                            let entity = entity.clone();
                                            move |_, cx| {
                                                entity.update(cx, |this, cx| {
                                                    this.start_chosen(cx);
                                                    cx.notify();
                                                })
                                            }
                                        },
                                        move |_, cx| {
                                            entity.update(cx, |this, cx| {
                                                this.send(Command::Mix(MixAction::Apps));
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
