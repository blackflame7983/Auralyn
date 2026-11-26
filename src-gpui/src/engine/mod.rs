//! 実エンジンとのつなぎ。`AudioHost`（Tauri と同じ親の処理）を、画面とは別のスレッドで動かす。
//!
//! - 命令は1本のスレッドが受付順に実行する。`AudioHost` の命令は応答を待つので、画面のスレッドでは呼ばない。
//! - 通知は `AudioHost::set_event_sink`（中核 API の `EventSink`）で、Tauri と同じ順序のまま受ける。
//! - メーターは届くたびに画面へ送らず、最新の値だけを置く。画面が描画の周期で読む。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use auralyn_core::event::{EmitError, Event, EventSink};
use auralyn_ui_model::connect::{AppSource, Device, Input, Output, Purpose, Routing, Saved};
use auralyn_ui_model::diagnostics::{self, Health, Stats};
use auralyn_ui_model::measurement::{self, Measurement, Quality, Take};
use auralyn_ui_model::peak::{Limit, Lookahead, Peak};
use auralyn_ui_model::profile::{import_name, Entry as ProfileEntry, ImportIssue};
use auralyn_ui_model::rack::{self, Candidate};
use auralyn_ui_model::recovery::Hold;
use auralyn_ui_model::sound::{Change, DeEsser, NoiseMode, Preset, Reverb, Singing, Sound};
use auralyn_ui_model::voice_check::{
    Device as ListenDevice, Listening, Playback, Recording, Source as VoiceSource,
    State as VoiceState, MAX_MS,
};
use vst_host_lib::audio::{ActiveAudioConfig, AudioHost};
use vst_host_lib::audio_engine::builtin::Request as BuiltinRequest;
use vst_host_lib::audio_engine::core::noise_learning::{Request as MeasureRequest, Snapshot};
use vst_host_lib::audio_engine::deesser::DeEsserParams;
use vst_host_lib::audio_engine::peak_protection::Config as PeakConfig;
use vst_host_lib::audio_engine::reverb::ReverbParams;
use vst_host_lib::audio_engine::singing::SingingParams;
use vst_host_lib::audio_engine::true_peak_limiter::Config as TruePeakConfig;
use vst_host_lib::input;
use vst_host_lib::ipc::{ChannelRouting, OutputRouting, RestorePluginRequest};
use vst_host_lib::obs::{self, ReachReceipt};
use vst_host_lib::vst_host::{presets, scanner};

use crate::store;

mod events;
mod live;
mod mix;
mod modes;
mod post_mix;
mod profile;
mod slots;
mod sound;
mod voice;

use events::on_event;
pub use mix::MixAction;
pub use modes::ModeAction;
pub use post_mix::{PostAction, Witness};

#[derive(Debug, Clone)]
pub enum Command {
    /// 保存した入出力の設定で開始する。
    Start,
    /// 選んだ機器で開始する。開始できると、その設定が保存される（Tauri 版と同じ `last_audio_config.json`）。
    StartWith(StartWith),
    /// 音声エンジンが落ちたあと、保存した入出力で始め直す。`Some` の VST は読まずに並びへ残す。
    Recover(Option<Hold>),
    /// 機器の一覧と保存した設定を読む。
    ListDevices,
    Stop,
    SetMute(bool),
    SetBypass(bool),
    SetInputGain(f32),
    SetOutputGain(f32),
    /// 追加の候補を探す（スキャン）。命令のスレッドとは別のスレッドで行う。
    ScanPlugins,
    /// 並びの末尾に足す。
    AddPlugin(Candidate),
    RemovePlugin(String),
    /// 読めていない VST を、並びの同じ位置でもう一度読む。
    ReloadMissing,
    MovePlugin {
        id: String,
        up: bool,
    },
    SetPluginEnabled {
        id: String,
        enabled: bool,
    },
    SetPluginMuted {
        id: String,
        muted: bool,
    },
    /// VST ごとの音量（倍率、0〜2）。スライダーを離したとき（キーでは1歩ごと）に送る。
    SetPluginGain {
        id: String,
        gain: f32,
    },
    OpenEditor(String),
    /// 音づくりの今の設定を読む。
    ReadSound,
    /// 音づくりの1つの操作。エンジンが持つ今の設定に重ね、変わった区画（ノイズ低減・声を整える）だけを送って保存する。
    SetSound(Change),
    /// ノイズ低減の ON/OFF を、いまのエンジンの値から反転する（ショートカット）。
    ToggleNoise,
    /// 大きな音を抑える（ピーク保護）か、配信用 true-peak 制限の今の状態を読む。
    ReadPeak(Limit),
    /// 周囲の音の測定を読む・始める・止める・採用する。結果は `Notice::Measurement`。
    Measure(measurement::Action),
    /// 保存した構成（Tauri 版と同じ `presets/`）の一覧を読む。結果は `Notice::Profiles`。
    ListProfiles,
    /// 今の VST の並び・ノイズ低減・声を整える設定を、構成として保存する（接続は含めない）。
    SaveProfile(String),
    /// 構成の VST の並び・ノイズ低減・声を整える設定を読む（接続は変えない）。
    /// 読む前の状態は退避へ保存する。`restore` は退避から戻すとき（戻すときは退避し直さない）。
    ApplyProfile {
        name: String,
        restore: bool,
    },
    /// ボイスチェックの録音を始める（最大 `voice_check::MAX_MS`）。状態は `Notice::Recording`。
    Record,
    StopRecording,
    /// 録った音を WAV で保存する。保存できたら `Notice::RecordingSaved`。
    SaveRecording {
        source: VoiceSource,
        path: PathBuf,
    },
    /// 試聴（配信に乗らない別の出力先での再生）。結果は `Notice::Listening`。
    Listen(Listen),
    /// 音声処理の稼働統計を読む。結果は `Notice::Stats`。
    ReadStats,
    /// 配信用の出力（`live.rs`）。`None` は読むだけ、`Some` は保存・反映。
    LiveOutput(Option<auralyn_ui_model::live_output::Draft>),
    /// 配信ミックス（`mix.rs`）。
    Mix(MixAction),
    /// 歌・雑談モード（`modes.rs`）。
    Modes(ModeAction),
    /// ミックス後の VST（`post_mix.rs`）。変える操作には、画面が見た世代を付ける（`MainView::send` が付ける）。
    PostMix(PostAction, Option<Witness>),
    /// 読み込めなかった VST の記録を消す（次のスキャンで確かめ直す）。結果は `Notice::ExclusionsCleared`。
    ClearExclusions,
    /// 構成のファイルを消す。
    DeleteProfile(String),
    /// 構成をファイルへ書き出す。接続は含めない（Tauri 版の書き出しの既定と同じ）。結果は `Notice::ProfileFile`。
    ExportProfile {
        name: String,
        path: PathBuf,
    },
    /// ファイルの構成を、ファイルの中の名前で取り込む。同じ名前があれば上書きせず、取り込まない。結果は `Notice::ProfileFile`。
    ImportProfile(PathBuf),
    /// 制限の ON/OFF。天井と復帰時間は今の値のまま。音声が動いているときだけ受け付けられる。
    SetPeak(Limit, bool),
    /// 制限の天井（dBFS）と復帰時間（ms）。ON/OFF は今のまま。音声が動いているときだけ受け付けられる。
    SetPeakLimits {
        limit: Limit,
        ceiling_db: f32,
        release_ms: f32,
    },
    /// 並びと各 VST の中の設定を保存する。VST の窓を閉じたときはエンジンが自分で送る。
    /// 終了の前は、保存し終えたことを返事で受ける。
    SaveRack(Option<flume::Sender<()>>),
    /// OBS のシーン連動：同じ名前の構成があれば読む（無ければ何もしない）。
    SceneProfile(String),
    /// OBS への到達確認のテスト音（`obs_link`）。結果は `Notice` でなく、渡された口へ返す。
    ReachTone(ToneStep, flume::Sender<Result<ReachReceipt, String>>),
}

#[derive(Debug, Clone)]
pub enum ToneStep {
    Play(u32),
    Stop(Box<ReachReceipt>),
}

impl Command {
    /// 続けて届いた同じ種類の音量は、最後の値だけを送る（スライダーを動かしている間の詰まりを防ぐ）。
    fn supersedes(&self, earlier: &Command) -> bool {
        matches!(
            (self, earlier),
            (Command::SetInputGain(_), Command::SetInputGain(_))
                | (Command::SetOutputGain(_), Command::SetOutputGain(_))
        ) || matches!(
            (self, earlier),
            (Command::SetPluginGain { id, .. }, Command::SetPluginGain { id: other, .. }) if id == other
        ) || matches!(
            (self, earlier),
            (Command::SetPeakLimits { limit, .. }, Command::SetPeakLimits { limit: other, .. }) if limit == other
        ) || matches!(
            (self, earlier),
            (
                    Command::Measure(measurement::Action::Read),
                    Command::Measure(measurement::Action::Read)
                )
                | (
                    Command::Listen(Listen::Status),
                    Command::Listen(Listen::Status)
                )
                | (Command::LiveOutput(None), Command::LiveOutput(None))
                | (
                    Command::Modes(ModeAction::Read),
                    Command::Modes(ModeAction::Read)
                )
                // 連打したショートカットは最後の押下だけ（Tauri 版と同じ）。
                | (
                    Command::Modes(ModeAction::Shortcut(_)),
                    Command::Modes(ModeAction::Shortcut(_))
                )
                // OBS のシーンが続けて替わったら、最後のシーンの分だけ（途中のシーンの VST を読み込まない）。
                | (
                    Command::SceneProfile(_) | Command::Modes(ModeAction::Scene(_)),
                    Command::SceneProfile(_) | Command::Modes(ModeAction::Scene(_))
                )
                | (
                    Command::PostMix(PostAction::Read, _),
                    Command::PostMix(PostAction::Read, _)
                )
        ) || matches!(
            (self, earlier),
            (
                Command::PostMix(PostAction::Gain { id, .. }, _),
                Command::PostMix(PostAction::Gain { id: other, .. }, _)
            ) if id == other
        ) || {
            use auralyn_ui_model::mix::Change::{MusicGain, VoiceGain};
            matches!(
                (self, earlier),
                (
                    Command::Mix(MixAction::Levels(VoiceGain(_))),
                    Command::Mix(MixAction::Levels(VoiceGain(_)))
                ) | (
                    Command::Mix(MixAction::Levels(MusicGain(_))),
                    Command::Mix(MixAction::Levels(MusicGain(_)))
                )
            )
        }
    }
}

/// 試聴の操作。
#[derive(Debug, Clone)]
pub enum Listen {
    /// 試聴を用意し、出力先の一覧を読む。前のセッションは閉じたものとして扱う。
    Open,
    Devices,
    Status,
    Play {
        recording_id: u64,
        device_id: String,
        source: VoiceSource,
        looped: bool,
    },
    /// 鳴らしている音（加工前・加工後）とループを替える。
    Change {
        source: VoiceSource,
        looped: bool,
    },
    Stop,
    Close,
}

/// 構成の書き出し・読み込みの結果。名前は構成の名前。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileFile {
    Exported(String),
    Imported(String),
    NotImported(ImportIssue),
}

#[derive(Debug, Clone)]
pub enum Notice {
    Started {
        input: Option<String>,
        output: Option<String>,
    },
    Stopped,
    /// 子の異常・ストリームの異常。音声は止まっている。
    StreamError(String),
    Muted(bool),
    Bypassed(bool),
    /// VST の並び（上から音が通る順）。変わるたびに全体を送る。
    Rack(Vec<Slot>),
    /// 音づくりの今の設定（エンジンが受け付けた結果）。
    Sound(Sound),
    /// 制限の状態。`None` は読めない（音声が止まっているときも読めない）。
    /// `answered` は変えた命令への返事（断られたときを含む）。読み直しだけなら `false`。
    Peak {
        limit: Limit,
        peak: Option<Peak>,
        answered: bool,
    },
    /// 周囲の音の測定。`None` は読めない（音声が止まっているときも読めない）。
    Measurement(Option<Measurement>),
    /// 保存した構成の一覧。
    Profiles(Vec<ProfileEntry>),
    /// ボイスチェックの録音の状態。
    Recording(Recording),
    RecordingSaved,
    /// 試聴の様子。失敗したときは理由。
    Listening(Result<Listening, String>),
    /// 稼働統計。`stats` が `None` は読めなかった（音声が止まっているときは、すべて 0 で届く）。
    /// `mix` は配信ミックスの診断で、読めた項目だけ入る。
    Stats {
        stats: Option<Stats>,
        mix: diagnostics::Mix,
    },
    ExclusionsCleared(Result<(), String>),
    /// 配信用の出力の状態。`Err` は読めない・断られた理由。
    Live(Result<auralyn_ui_model::live_output::Live, String>),
    /// 配信用の出力の保存の結果（`Err` は断られた理由）。このあと読んだ状態が `Live` で届く。
    LiveSaved(Result<(), String>),
    /// 配信ミックスの状態。`Err` は読めなかった理由。
    Mix(Result<auralyn_ui_model::mix::Mix, String>),
    /// 配信ミックスを変える操作の結果（`Err` は断られた理由）。このあと状態が `Mix` で届く。
    MixDone(Result<(), String>),
    /// 歌・雑談モードの状態。`Err` は読めなかった理由。
    Modes(Result<auralyn_ui_model::live_modes::LiveModes, String>),
    /// 歌・雑談モードを変える操作の結果（`Err` は断られた理由）。このあと状態が `Modes` で届く。
    ModesDone(Result<(), String>),
    /// 雑談の登録を、残響が ON のため止めた。切ってから登録するかを画面で聞く。
    ModesKeepsReverb,
    /// ミックス後の VST の状態と並び。`Err` は読めなかった理由。
    PostMix(Result<(auralyn_ui_model::post_mix::PostMix, Vec<Slot>), String>),
    /// ミックス後の VST を変える操作の結果（`Err` は断られた理由）。このあと状態が `PostMix` で届く。
    PostMixDone(Result<(), String>),
    /// オケに選べる起動中のアプリ。
    MixApps(Result<Vec<auralyn_ui_model::mix::App>, String>),
    /// 構成の書き出し・読み込みが終わった（失敗は `Failed`）。
    ProfileFile(ProfileFile),
    /// 追加の候補。失敗したときは理由。
    Catalog(Result<Vec<Candidate>, String>),
    /// 命令が失敗した。画面は直前の状態に戻す。
    Failed {
        command: &'static str,
        message: String,
    },
    /// 開始に失敗した。
    NotStarted(String),
    /// 音声エンジンが落ちた。音は止まっている。
    EngineExited(auralyn_ui_model::recovery::Exit),
    /// 保存した入力がアプリの音声なので、自動では開始しなかった（アプリの名前）。
    AppNotResumed(String),
    /// 保存した入出力の設定がない。
    Unconfigured,
    /// 停止に失敗した。音声は流れたまま。
    StopFailed(String),
    Devices {
        devices: Vec<Device>,
        saved: Option<Saved>,
    },
}

/// 並びの1つの VST。
#[derive(Debug, Clone)]
pub struct Slot {
    /// 子が付けた ID。読めていない枠では、画面で見分けるためだけの仮の ID。
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub muted: bool,
    /// 音量の倍率（0〜2）。
    pub gain: f32,
    /// 保存にはあるが、子に読めていない（ファイルが無いなど）。画面では削除だけができる。
    pub loaded: bool,
    path: String,
    class_id: Option<String>,
    /// 最後に保存した VST の中の設定。子が落ちたあとの読み直しに使う。
    state: Option<String>,
}

impl Slot {
    fn request(&self) -> RestorePluginRequest {
        RestorePluginRequest {
            path: self.path.clone(),
            state: self.state.clone(),
            bypassed: !self.enabled,
            muted: self.muted,
            gain: self.gain,
            class_id: self.class_id.clone(),
        }
    }
}

/// 並びの保存先（設定のフォルダの中）。Tauri 版の保存（webview の localStorage）とは別。
const RACK_FILE: &str = "gpui_rack.json";
/// 音づくりの保存先。
const SOUND_FILE: &str = "gpui_sound.json";

/// 最新のメーターの値。`seq` が進んだときだけ画面が読む。
#[derive(Default, Clone, Copy)]
pub struct LevelSlot {
    pub seq: u64,
    pub input: [f32; 2],
    pub output: [f32; 2],
    /// 出力音量・ピーク保護・ミュートの前の値。テスト音などで子が送らないときは無い。
    pub processed: Option<[f32; 2]>,
    pub received_at: Option<Instant>,
}

pub struct Engine {
    commands: flume::Sender<Command>,
    pub notices: flume::Receiver<Notice>,
    pub levels: Arc<Mutex<LevelSlot>>,
    /// OBS の同期調整で、対象を読んだときの音声の条件を確かめる手がかり。
    pub timing: vst_host_lib::obs_timing::Conditions,
}

impl Engine {
    pub fn start(config_dir: PathBuf) -> Self {
        let (commands, command_rx) = flume::unbounded();
        let listener_commands = commands.downgrade();
        let (notice_tx, notices) = flume::unbounded();
        let levels = Arc::new(Mutex::new(LevelSlot::default()));
        let listener_levels = levels.clone();
        let listener_notices = notice_tx.clone();
        let exited = Arc::new(AtomicBool::new(false));
        let listener_exited = exited.clone();
        let mut host = AudioHost::new(config_dir.clone());
        let timing = vst_host_lib::obs_timing::conditions(&host);
        std::thread::Builder::new()
            .name("gpui-control".into())
            .spawn(move || {
                host.set_event_sink(Arc::new(Sink {
                    levels: listener_levels,
                    notices: listener_notices,
                    exited: listener_exited,
                    commands: listener_commands,
                }));
                Control {
                    host,
                    notices: notice_tx,
                    config_dir,
                    rack: Vec::new(),
                    renamed: Vec::new(),
                    listen: voice::Session::default(),
                    mixed: None,
                    modes_sequence: 0,
                    posted: None,
                    sound: None,
                    read_only: false,
                    exited,
                    hold: None,
                    placeholders: 0,
                    input_gain: None,
                    output_gain: None,
                }
                .run(command_rx);
            })
            .expect("制御のスレッドを起動できません");
        Self {
            commands,
            notices,
            levels,
            timing,
        }
    }

    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    /// 別のスレッドから命令を送る口（OBS の到達確認のテスト音）。弱い口なので、画面が閉じればエンジンは終わる。
    pub fn sender(&self) -> flume::WeakSender<Command> {
        self.commands.downgrade()
    }

    /// 終了の前に、並びと VST の中の設定を保存し終えるのを待つ。エンジンが応えなければ数秒で諦める。
    pub fn save_before_quit(&self) {
        let (done, saved) = flume::bounded(1);
        self.send(Command::SaveRack(Some(done)));
        let _ = saved.recv_timeout(Duration::from_secs(5));
    }
}

/// 中核の出来事の受け口（`auralyn_core::event::EventSink`）。名前・本文・順序は Tauri の emit と同じ。
/// reader などのスレッドから同期で呼ばれるので、待たずに戻る。
struct Sink {
    levels: Arc<Mutex<LevelSlot>>,
    notices: flume::Sender<Notice>,
    /// 子が落ちた。次の開始は空の子で始まるので、VST を読み直す。
    exited: Arc<AtomicBool>,
    /// VST の窓を閉じたら保存を頼む。弱い参照にして、画面が閉じたら命令のスレッドが終わるようにする。
    commands: flume::WeakSender<Command>,
}

impl EventSink for Sink {
    fn send(&self, event: Event) -> Result<(), EmitError> {
        let payload = event
            .payload::<serde_json::Value>()
            .map_err(EmitError::Serialize)?;
        if event.name() == "audio-engine-exited" {
            self.exited.store(true, Ordering::SeqCst);
        }
        if event.name() == "plugin-editor-closed" {
            if let Some(commands) = self.commands.upgrade() {
                let _ = commands.send(Command::SaveRack(None));
            }
        }
        on_event(event.name(), payload, &self.levels, &self.notices);
        Ok(())
    }
}

struct Control {
    host: AudioHost,
    notices: flume::Sender<Notice>,
    config_dir: PathBuf,
    rack: Vec<Slot>,
    /// 最後に読み直す前の ID（位置の順）。画面がまだ古い ID で送ってきた命令を、同じ位置の枠に当てる。
    renamed: Vec<String>,
    /// 最後にエンジンから読んだ音づくりの設定。まだ読んでいなければ `None`。
    sound: Option<Sound>,
    /// 保存を読めず、脇へ移せもしなかった。上書きして消さないよう、この起動の間は保存しない。
    read_only: bool,
    exited: Arc<AtomicBool>,
    /// 子が落ちたあとの読み直しで、読まずに残す VST（`Command::Recover` の間だけ）。
    hold: Option<Hold>,
    /// 「読めていない」枠に付けた仮の ID の数。仮の ID が本物や前の仮の ID と重ならないよう、数え続ける。
    placeholders: u64,
    /// 画面のスライダーが最後に頼んだ音量。開始のたびに送り直す。
    input_gain: Option<f32>,
    output_gain: Option<f32>,
    /// 試聴のセッション（`voice.rs`）。
    listen: voice::Session,
    /// 最後に読んだ配信ミックスの状態（世代と音量）。
    mixed: Option<vst_host_lib::mixing::Snapshot>,
    /// 歌・雑談モードの操作の通し番号（ホストが同じ窓の古い操作を断るのに使う）。
    modes_sequence: u64,
    /// 最後に読んだミックス後の VST の状態（世代）。
    posted: Option<vst_host_lib::post_mix::Snapshot>,
}

/// まとめて届いた命令を実行する順。後の同じ種類の命令で置き換わるものは飛ばし、ミュートは先に行う
/// （同じまとまりの音量の反映待ちに、緊急ミュートを待たせない）。
// shortcut: すでに実行中の命令（出力音量の反映待ち・子が落ちたあとの読み直し）の後ろでは、ミュートも待つ。
// 待ちが問題になったら、ミュートを命令のスレッドの外（子への直接の送信）で行う。
fn order(pending: &[Command]) -> Vec<&Command> {
    let kept = pending.iter().enumerate().filter(|(i, command)| {
        !pending[i + 1..]
            .iter()
            .any(|later| later.supersedes(command))
    });
    let (mute, rest): (Vec<_>, Vec<_>) = kept
        .map(|(_, command)| command)
        .partition(|command| matches!(command, Command::SetMute(_)));
    mute.into_iter().chain(rest).collect()
}

impl Control {
    fn run(mut self, commands: flume::Receiver<Command>) {
        // 並びを先に読む。開始の前に VST を入れておけば、加工されない声が流れない。
        self.restore_saved();
        self.restore_sound();
        self.start_saved();
        while let Ok(first) = commands.recv() {
            let mut pending = vec![first];
            pending.extend(commands.try_iter());
            for command in order(&pending) {
                self.execute(command);
            }
        }
    }

    fn start_saved(&mut self) {
        let config = match self.host.read_saved_audio_config() {
            Ok(Some(config)) => config,
            Ok(None) => {
                let _ = self.notices.send(Notice::Unconfigured);
                return;
            }
            Err(e) => {
                let _ = self.notices.send(Notice::NotStarted(e.to_string()));
                return;
            }
        };
        let app = match &config.input_source {
            Some(input::Config::ProcessLoopback(app)) => Some(app.app_name.clone()),
            _ => None,
        };
        let input = app.clone().or(config.input.clone());
        let output = config.output.clone();
        let result = input::start(&mut self.host, config, None);
        // アプリの音声は、この起動の中で選んだアプリならホストが覚えている同じアプリで再開する（Tauri 版と同じ）。
        // 起動し直したあとは候補が無いので、選び直してもらう（既定のマイクにも替えない）。
        if let (Some(name), Err(e)) = (app, &result) {
            log::warn!("保存したアプリの音声で再開できません: {e}");
            let _ = self.notices.send(Notice::AppNotResumed(name));
            return;
        }
        self.started(result, input, output);
    }

    /// 選んだ入力・出力・周波数・バッファ・チャンネルの割り当てで開始する（Tauri 版の開始と同じく入力の元を明示する）。
    fn start_with(&mut self, start: StartWith) {
        let (input, input_name, source, candidate_id) = match start.input {
            Input::Device(device) => {
                let purpose = start.purpose;
                let name = device.name.clone();
                let source = input::Config::Device {
                    purpose: host_purpose(purpose),
                };
                (Some(device), name, source, None)
            }
            Input::App {
                candidate_id,
                source,
            } => {
                let name = source.name.clone();
                let source = input::Config::ProcessLoopback(input::ProcessConfig {
                    app_key: source.key,
                    app_name: source.name,
                    raw_endpoint_id: source.route,
                    purpose: host_purpose(start.purpose),
                });
                (None, name, source, Some(candidate_id))
            }
        };
        let config = ActiveAudioConfig {
            input_source: Some(source),
            host: start.output.host.clone(),
            input: input.as_ref().map(|d| d.name.clone()),
            output: Some(start.output.name.clone()),
            input_id: input.and_then(|d| d.id),
            output_id: start.output.id.clone(),
            buffer_size: start.buffer_size,
            sample_rate: start.sample_rate,
            routing: Some(channel_routing(start.routing)),
        };
        let result = input::start(&mut self.host, config, candidate_id);
        self.started(result, Some(input_name), Some(start.output.name));
    }

    /// 開始の結果を画面へ送り、始まったら子に並びと音量を送り直す。
    fn started(
        &mut self,
        result: anyhow::Result<()>,
        input: Option<String>,
        output: Option<String>,
    ) {
        if let Err(e) = result {
            let _ = self.notices.send(Notice::NotStarted(
                vst_host_lib::audio::localize_audio_error(e.to_string()),
            ));
            return;
        }
        let _ = self.notices.send(Notice::Started { input, output });
        self.recover();
        // 子が替わっていると音量は 100% に戻っているので、画面のスライダーの値を送り直す（同じ子なら同じ値を送るだけ）。
        // 出力音量は反映を待つので、始めた直後は確かめきれずに失敗を返すことがある。音は始まっているので、帯の警告にせずログに残す。
        if let Some(value) = self.input_gain {
            if let Err(e) = self.host.set_input_gain(value) {
                log::warn!("開始のあとに入力音量を送り直せません: {e}");
            }
        }
        if let Some(value) = self.output_gain {
            if let Err(e) = self.host.set_output_gain(value) {
                log::warn!("開始のあとに出力音量を送り直せません: {e}");
            }
        }
    }

    fn execute(&mut self, command: &Command) {
        let (name, result) = match *command {
            Command::Start => return self.start_saved(),
            Command::Recover(ref hold) => {
                // 落ちたあとの並びをもう読み直していたら（選ぶ前に別の操作で子が起きた）、先に外す。
                match hold {
                    Some(hold) if !self.exited.load(Ordering::SeqCst) => self.hold_loaded(hold),
                    _ => self.hold = hold.clone(),
                }
                self.start_saved();
                self.hold = None;
                return;
            }
            Command::StartWith(ref start) => return self.start_with(start.clone()),
            Command::ReachTone(ref step, ref reply) => {
                let result = match step {
                    ToneStep::Play(ms) => obs::begin_reach_tone(&mut self.host, *ms),
                    ToneStep::Stop(receipt) => obs::finish_reach_tone(&mut self.host, receipt),
                };
                let _ = reply.send(result);
                return;
            }
            Command::ListDevices => return self.list_devices(),
            Command::Stop => return self.stop(),
            Command::SetMute(active) => ("set_global_mute", self.host.set_global_mute(active)),
            Command::SetBypass(active) => {
                ("set_global_bypass", self.host.set_global_bypass(active))
            }
            Command::SetInputGain(value) => {
                self.input_gain = Some(value);
                ("set_input_gain", self.host.set_input_gain(value))
            }
            Command::SetOutputGain(value) => {
                self.output_gain = Some(value);
                ("set_output_gain", self.host.set_output_gain(value))
            }
            Command::ScanPlugins => return self.scan(),
            Command::AddPlugin(ref candidate) => {
                return self.add(&candidate.path, candidate.class_id.as_deref())
            }
            Command::RemovePlugin(ref id) => return self.remove(id),
            Command::ReloadMissing => return self.reload_missing(),
            Command::MovePlugin { ref id, up } => return self.shift(id, up),
            Command::SetPluginEnabled { ref id, enabled } => {
                return self.edit(
                    id,
                    "set_bypass",
                    |host, id| host.set_bypass(id, !enabled),
                    |slot| slot.enabled = enabled,
                )
            }
            Command::SetPluginMuted { ref id, muted } => {
                return self.edit(
                    id,
                    "set_mute",
                    |host, id| host.set_mute(id, muted),
                    |slot| slot.muted = muted,
                )
            }
            Command::SetPluginGain { ref id, gain } => {
                return self.edit(
                    id,
                    "set_gain",
                    |host, id| host.set_gain(id, gain),
                    |slot| slot.gain = gain,
                )
            }
            Command::OpenEditor(ref id) => match self.live(id) {
                Some((_, id)) => ("open_editor", self.host.open_editor(&id)),
                None => return,
            },
            Command::ReadSound => return self.read_sound(),
            Command::ReadPeak(limit) => return self.peak(limit, None),
            Command::Measure(ref action) => return self.measure(action),
            Command::ListProfiles => return self.list_profiles(),
            Command::SaveProfile(ref name) => return self.save_profile(name),
            Command::SceneProfile(ref name) => return self.scene_profile(name),
            Command::ApplyProfile { ref name, restore } => {
                return self.apply_profile(name, restore)
            }
            Command::Record => ("start_voice_check", self.host.start_voice_check(MAX_MS)),
            Command::StopRecording => ("stop_voice_check", self.host.stop_voice_check()),
            Command::SaveRecording { source, ref path } => {
                let saved = self.host.export_voice_check(
                    path.to_string_lossy().into_owned(),
                    source.as_str().to_owned(),
                );
                if saved.is_ok() {
                    let _ = self.notices.send(Notice::RecordingSaved);
                }
                ("export_voice_check", saved)
            }
            Command::Listen(ref listen) => return self.listen(listen.clone()),
            Command::LiveOutput(ref draft) => return self.live_output(draft.clone()),
            Command::Mix(ref action) => return self.mix(action.clone()),
            Command::Modes(ref action) => return self.live_modes(action.clone()),
            Command::PostMix(ref action, ref seen) => {
                return self.post_mix(action.clone(), seen.clone())
            }
            Command::ReadStats => {
                let stats = self.host.get_engine_runtime_stats().ok().map(|s| Stats {
                    loaded: s.active_plugin_count,
                    enabled: s.enabled_plugin_count,
                    pending_unload: s.pending_unload_count,
                    burned: s.burned_library_count,
                    max_jitter_us: s.max_jitter_us,
                    glitches: s.glitch_count,
                    health: s.processing_health.map(|h| Health {
                        recent_late: h.recent_late,
                        recent_underflow: h.recent_underflow,
                        window_secs: h.window_secs,
                    }),
                });
                let mix = self.mix_stats();
                let _ = self.notices.send(Notice::Stats { stats, mix });
                return;
            }
            Command::ClearExclusions => {
                let cleared = scanner::clear_scan_exclusions(&self.config_dir);
                let _ = self.notices.send(Notice::ExclusionsCleared(cleared));
                return;
            }
            Command::DeleteProfile(ref name) => return self.delete_profile(name),
            Command::ExportProfile { ref name, ref path } => {
                return self.export_profile(name, path)
            }
            Command::ImportProfile(ref path) => return self.import_profile(path),
            Command::SetPeak(limit, enabled) => {
                return self.set_peak(limit, |config| PeakConfig { enabled, ..config })
            }
            Command::SetPeakLimits {
                limit,
                ceiling_db,
                release_ms,
            } => {
                return self.set_peak(limit, |config| PeakConfig {
                    ceiling_db,
                    release_ms,
                    ..config
                })
            }
            Command::SetSound(change) => return self.set_sound(change),
            Command::ToggleNoise => return self.toggle_noise(),
            Command::SaveRack(ref done) => {
                self.save(true);
                if let Some(done) = done {
                    let _ = done.send(());
                }
                return;
            }
        };
        if let Err(e) = result {
            self.fail(name, e);
        }
    }

    // shortcut: 一覧の取得（初回は子への GetDevices）を命令のスレッドで待つので、その間は緊急ミュートも待たされる。数秒を超えるなら Tauri 版の begin/poll の走査を pub にして使う。
    fn list_devices(&mut self) {
        let devices = match self.host.enumerate_devices(false) {
            Ok(list) => list
                .inputs
                .into_iter()
                .chain(list.outputs)
                .map(|d| Device {
                    host: d.host,
                    name: d.name,
                    id: d.id,
                    is_input: d.is_input,
                    is_default: d.is_default,
                    channels: d.channels,
                    rates: d.sample_rate_ranges,
                    buffers: d.buffer_size_range,
                })
                .collect(),
            Err(e) => return self.fail("enumerate_devices", e),
        };
        let saved = self
            .host
            .read_saved_audio_config()
            .ok()
            .flatten()
            .map(|c| Saved {
                host: c.host,
                input: c.input,
                input_id: c.input_id,
                output: c.output,
                output_id: c.output_id,
                sample_rate: c.sample_rate,
                buffer_size: c.buffer_size,
                routing: c.routing.map(|r| Routing {
                    input: r.input_channels,
                    output: match r.output_routing {
                        OutputRouting::Legacy => Output::Legacy,
                        OutputRouting::Independent { channels } => Output::Independent(channels),
                        OutputRouting::Insert => Output::Insert,
                    },
                }),
                purpose: c
                    .input_source
                    .as_ref()
                    .map(|s| match s {
                        input::Config::Device { purpose } => *purpose,
                        input::Config::ProcessLoopback(app) => app.purpose,
                    })
                    .map(ui_purpose)
                    .unwrap_or_default(),
                app: match c.input_source {
                    Some(input::Config::ProcessLoopback(app)) => Some(AppSource {
                        key: app.app_key,
                        name: app.app_name,
                        route: app.raw_endpoint_id,
                    }),
                    _ => None,
                },
            });
        let _ = self.notices.send(Notice::Devices { devices, saved });
    }

    /// 停止の結果は通知（`audio-stopped`）を待たずに送る。止まったことの通知が重なっても、画面の状態は同じになる。
    fn stop(&mut self) {
        // VST の窓を開いたまま止めても、それまでの調整を残す。
        self.save(true);
        let notice = match self.host.stop() {
            Ok(()) => Notice::Stopped,
            Err(e) => Notice::StopFailed(e.to_string()),
        };
        let _ = self.notices.send(notice);
    }

    fn fail(&self, command: &'static str, error: anyhow::Error) {
        let _ = self.notices.send(Notice::Failed {
            command,
            message: error.to_string(),
        });
    }
}

/// 選んだ機器での開始。周波数とバッファは `None` なら自動（エンジンが機器に合わせて決める）。
#[derive(Debug, Clone)]
pub struct StartWith {
    /// マイク・仮想ケーブルか、アプリの音声。
    pub input: Input,
    pub purpose: Purpose,
    pub output: Device,
    pub sample_rate: Option<u32>,
    pub buffer_size: Option<u32>,
    /// チャンネルの割り当て。ASIO 以外は `connect::SYSTEM_ROUTING`。
    pub routing: Routing,
}

fn host_purpose(purpose: Purpose) -> input::Purpose {
    match purpose {
        Purpose::Voice => input::Purpose::Voice,
        Purpose::Music => input::Purpose::Music,
    }
}

fn ui_purpose(purpose: input::Purpose) -> Purpose {
    match purpose {
        input::Purpose::Voice => Purpose::Voice,
        input::Purpose::Music => Purpose::Music,
    }
}

/// 画面が選んだ割り当てを、ホストの形にする。
fn channel_routing(routing: Routing) -> ChannelRouting {
    ChannelRouting {
        input_channels: routing.input,
        output_routing: match routing.output {
            Output::Legacy => OutputRouting::Legacy,
            Output::Independent(channels) => OutputRouting::Independent { channels },
            Output::Insert => OutputRouting::Insert,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mute_runs_first_and_superseded_gains_are_skipped() {
        let pending = [
            Command::SetOutputGain(0.5),
            Command::SetInputGain(0.8),
            Command::SetOutputGain(0.2),
            Command::SetMute(true),
        ];
        let order: Vec<String> = order(&pending).iter().map(|c| format!("{c:?}")).collect();
        assert_eq!(
            order,
            ["SetMute(true)", "SetInputGain(0.8)", "SetOutputGain(0.2)"]
        );
    }

    #[test]
    fn later_gain_supersedes_earlier_gain_of_same_kind_only() {
        assert!(Command::SetInputGain(0.5).supersedes(&Command::SetInputGain(0.2)));
        assert!(!Command::SetOutputGain(0.5).supersedes(&Command::SetInputGain(0.2)));
        assert!(!Command::SetMute(true).supersedes(&Command::SetMute(false)));
        let gain = |id: &str| Command::SetPluginGain {
            id: id.into(),
            gain: 1.0,
        };
        assert!(gain("a").supersedes(&gain("a")));
        assert!(!gain("a").supersedes(&gain("b")));
        let limits = |ceiling_db| Command::SetPeakLimits {
            limit: Limit::Sample,
            ceiling_db,
            release_ms: 100.0,
        };
        assert!(limits(-1.0).supersedes(&limits(-2.0)));
        let true_peak = Command::SetPeakLimits {
            limit: Limit::TruePeak,
            ceiling_db: -1.0,
            release_ms: 100.0,
        };
        assert!(!true_peak.supersedes(&limits(-2.0)));
        let scene = Command::SceneProfile("B".into());
        assert!(scene.supersedes(&Command::SceneProfile("A".into())));
        assert!(!scene.supersedes(&Command::ApplyProfile {
            name: "A".into(),
            restore: false
        }));
    }

    #[test]
    fn saved_request_keeps_mute_and_gain() {
        let slot = Slot {
            id: "a".into(),
            name: "Comp".into(),
            enabled: true,
            muted: true,
            gain: 0.5,
            loaded: true,
            path: "C:/VST3/Comp.vst3".into(),
            class_id: None,
            state: None,
        };
        let request = slot.request();
        assert!(request.muted);
        assert_eq!(request.gain, 0.5);
    }
}
