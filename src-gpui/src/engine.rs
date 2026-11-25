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
use auralyn_ui_model::connect::{Device, Saved};
use auralyn_ui_model::peak::Peak;
use auralyn_ui_model::rack::{self, Candidate};
use auralyn_ui_model::sound::{Change, NoiseMode, Preset, Sound};
use vst_host_lib::audio::{ActiveAudioConfig, AudioHost};
use vst_host_lib::audio_engine::peak_protection::Config as PeakConfig;
use vst_host_lib::ipc::RestorePluginRequest;
use vst_host_lib::vst_host::scanner;

use crate::store;

#[derive(Debug, Clone)]
pub enum Command {
    /// 保存した入出力の設定で開始する。
    Start,
    /// 選んだ機器で開始する。開始できると、その設定が保存される（Tauri 版と同じ `last_audio_config.json`）。
    StartWith {
        input: Device,
        output: Device,
    },
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
    /// 大きな音を抑える（ピーク保護）の今の状態を読む。
    ReadPeak,
    /// ピーク保護の ON/OFF。天井と復帰時間は今の値のまま。音声が動いているときだけ受け付けられる。
    SetPeak(bool),
    /// ピーク保護の天井（dBFS）と復帰時間（ms）。ON/OFF は今のまま。音声が動いているときだけ受け付けられる。
    SetPeakLimits {
        ceiling_db: f32,
        release_ms: f32,
    },
    /// 並びと各 VST の中の設定を保存する。VST の窓を閉じたときはエンジンが自分で送る。
    /// 終了の前は、保存し終えたことを返事で受ける。
    SaveRack(Option<flume::Sender<()>>),
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
            (Command::SetPeakLimits { .. }, Command::SetPeakLimits { .. })
        )
    }
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
    /// ピーク保護の状態。`None` は読めない（音声が止まっているときも読めない）。
    Peak(Option<Peak>),
    /// 追加の候補。失敗したときは理由。
    Catalog(Result<Vec<Candidate>, String>),
    /// 命令が失敗した。画面は直前の状態に戻す。
    Failed {
        command: &'static str,
        message: String,
    },
    /// 開始に失敗した。
    NotStarted(String),
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
        std::thread::Builder::new()
            .name("gpui-control".into())
            .spawn(move || {
                let mut host = AudioHost::new(config_dir.clone());
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
                    sound: None,
                    read_only: false,
                    exited,
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
        }
    }

    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
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

fn on_event(
    event: &str,
    payload: serde_json::Value,
    levels: &Mutex<LevelSlot>,
    notices: &flume::Sender<Notice>,
) {
    let notice = match event {
        "audio-level" => {
            let pair = |key: &str| -> Option<[f32; 2]> {
                let values = payload.get(key)?.as_array()?;
                match values.as_slice() {
                    [l, r] => Some([l.as_f64()? as f32, r.as_f64()? as f32]),
                    _ => None,
                }
            };
            // 形が違う値は NaN にして、画面で「更新が止まった」として扱わせる。
            let input = pair("input").unwrap_or([f32::NAN; 2]);
            let output = pair("output").unwrap_or([f32::NAN; 2]);
            let processed = payload
                .get("processed")
                .filter(|value| !value.is_null())
                .map(|_| pair("processed").unwrap_or([f32::NAN; 2]));
            let mut slot = levels.lock().unwrap_or_else(|e| e.into_inner());
            slot.seq += 1;
            slot.input = input;
            slot.output = output;
            slot.processed = processed;
            slot.received_at = Some(Instant::now());
            return;
        }
        "audio-stopped" => Notice::Stopped,
        "audio-error" | "audio-stream-error" => Notice::StreamError(
            payload
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| payload.to_string()),
        ),
        "global-mute-changed" => Notice::Muted(payload.as_bool().unwrap_or(true)),
        "global-bypass-changed" => Notice::Bypassed(payload.as_bool().unwrap_or(false)),
        _ => return,
    };
    let _ = notices.send(notice);
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
    /// 画面のスライダーが最後に頼んだ音量。開始のたびに送り直す。
    input_gain: Option<f32>,
    output_gain: Option<f32>,
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
        if config.input_source.is_some() {
            log::warn!("入力の元（アプリの音声など）はまだ復元しない。機器の入力で開始する");
        }
        self.start(config);
    }

    /// 選んだ機器で開始する。周波数とバッファの大きさは、同じ接続方式なら保存した値を使う。
    /// チャンネルの割り当ては、同じ機器のときだけ引き継ぐ。
    fn start_with(&mut self, input: &Device, output: &Device) {
        let saved = self.host.read_saved_audio_config().ok().flatten();
        let same_host = saved.as_ref().filter(|s| s.host == input.host);
        let same_devices = same_host.filter(|s| s.input_id == input.id && s.output_id == output.id);
        self.start(ActiveAudioConfig {
            input_source: None,
            host: input.host.clone(),
            input: Some(input.name.clone()),
            output: Some(output.name.clone()),
            input_id: input.id.clone(),
            output_id: output.id.clone(),
            buffer_size: same_host.and_then(|s| s.buffer_size),
            sample_rate: same_host.and_then(|s| s.sample_rate),
            routing: same_devices.and_then(|s| s.routing),
        });
    }

    fn start(&mut self, config: ActiveAudioConfig) {
        let result = self.host.start_with_device_ids(
            Some(config.host.clone()),
            config.input.clone(),
            config.output.clone(),
            config.buffer_size,
            config.sample_rate,
            config.input_id.clone(),
            config.output_id.clone(),
            config.routing,
        );
        if let Err(e) = result {
            let _ = self.notices.send(Notice::NotStarted(
                vst_host_lib::audio::localize_audio_error(e.to_string()),
            ));
            return;
        }
        let _ = self.notices.send(Notice::Started {
            input: config.input,
            output: config.output,
        });
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

    /// 保存した並びを、同じ順・同じ ON/OFF・同じ VST の中の設定で読む。保存が無ければ何もしない。
    fn restore_saved(&mut self) {
        let text = match std::fs::read_to_string(self.config_dir.join(RACK_FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                self.fail("read_rack", e.into());
                return self.set_aside();
            }
        };
        match serde_json::from_str::<Vec<RestorePluginRequest>>(&text) {
            Ok(requests) => requests.into_iter().for_each(|r| self.restore(r)),
            Err(e) => {
                self.fail("read_rack", e.into());
                self.set_aside();
            }
        }
        self.send_rack();
    }

    /// 読めなかった保存を、次の保存で上書きしないよう `.bad` へ移す。移せなければ、この起動の間は保存しない。
    fn set_aside(&mut self) {
        let path = self.config_dir.join(RACK_FILE);
        if let Err(e) = std::fs::rename(&path, path.with_extension("json.bad")) {
            self.fail("read_rack", e.into());
            self.read_only = true;
        }
    }

    /// 子が落ちていたら、次の子（空で始まる）に並びを、最後に保存した VST の中の設定で読み直す。
    /// 開始のあとと、VST を足す前に呼ぶ（足すと子が起き、落ちる前の並びが消えたままになる）。
    fn recover(&mut self) {
        if !self.exited.swap(false, Ordering::SeqCst) {
            return;
        }
        let old = std::mem::take(&mut self.rack);
        self.renamed = old.iter().map(|slot| slot.id.clone()).collect();
        for slot in old {
            self.restore(slot.request());
        }
        // 新しい子の音づくりは既定値で始まるので、落ちる前の設定を送り直す。
        if let Some(sound) = self.sound {
            self.apply_sound(sound, None);
        }
        self.send_rack();
    }

    /// 1つ読んで並びの末尾に足す。読めなければ理由を出し、同じ位置に「読めていない」枠として残す（保存から消さず、順も変えない）。
    /// 並びを空から作り直すときだけ呼ぶので、仮の ID（位置）は重ならない。
    fn restore(&mut self, mut request: RestorePluginRequest) {
        // 手で書き換えた保存でも、画面に出せる範囲（0〜200%）で鳴らす。
        request.gain = rack::gain_from_percent(rack::gain_percent(request.gain));
        let (id, name, loaded, class_id) = match self.host.restore_plugin(request.clone()) {
            Ok(plugin) => (
                plugin.id,
                plugin.name,
                true,
                plugin.class_id.or(request.class_id),
            ),
            Err(e) => {
                self.fail("restore_plugin", e);
                let name = Path::new(&request.path).file_stem().map_or_else(
                    || request.path.clone(),
                    |s| s.to_string_lossy().into_owned(),
                );
                (
                    format!("missing-{}", self.rack.len()),
                    name,
                    false,
                    request.class_id,
                )
            }
        };
        self.rack.push(Slot {
            id,
            name,
            enabled: !request.bypassed,
            muted: request.muted,
            gain: request.gain,
            loaded,
            path: request.path,
            class_id,
            state: request.state,
        });
    }

    fn add(&mut self, path: &str, class_id: Option<&str>) {
        self.recover();
        if let Some((id, name, binary)) = self.load(path, class_id) {
            self.rack.push(Slot {
                id,
                name,
                enabled: true,
                muted: false,
                gain: 1.0,
                loaded: true,
                path: binary,
                class_id: class_id.map(str::to_owned),
                state: None,
            });
        }
        self.changed();
    }

    /// 並びを保存する。`fresh` なら各 VST の中の設定も取り直す（取れなかった VST は前の設定のまま）。
    fn save(&mut self, fresh: bool) {
        if self.read_only {
            return;
        }
        for slot in self.rack.iter_mut().filter(|slot| fresh && slot.loaded) {
            match self.host.get_plugin_state(&slot.id) {
                Ok(state) => slot.state = Some(state),
                Err(e) => log::warn!("{} の設定を取れません: {e}", slot.name),
            }
        }
        let requests: Vec<RestorePluginRequest> = self.rack.iter().map(Slot::request).collect();
        let path = self.config_dir.join(RACK_FILE);
        let result = serde_json::to_vec(&requests)
            .map_err(anyhow::Error::from)
            .and_then(|bytes| Ok(store::write_atomic(&path, &bytes)?));
        if let Err(e) = result {
            self.fail("save_rack", e);
        }
    }

    /// 並びを変えようとしたあと（成功でも失敗でも）。画面へ並び全体を送ってから保存する。
    /// 中の設定は取り直さない（変わるのは VST の窓の中だけで、窓を閉じたときと止めたときに取る）。
    fn changed(&mut self) {
        self.send_rack();
        self.save(false);
    }

    /// `.vst3` のバンドル（フォルダ）を渡されたら、Tauri 版のスキャンと同じく中の実体（Contents/x86_64-win）を探して読む。
    /// 読めたら、子が付けた ID と名前と、読んだ実体のパス。
    fn load(&mut self, path: &str, class_id: Option<&str>) -> Option<(String, String, String)> {
        let binary = scanner::resolve_binary(Path::new(path));
        let Some(binary) = binary.as_deref().and_then(Path::to_str) else {
            let _ = self.notices.send(Notice::Failed {
                command: "load_plugin",
                message: format!("VST3 の実体が見つかりません: {path}"),
            });
            return None;
        };
        log::info!("VST3 を読み込む: {binary}");
        match self.host.load_plugin(binary, class_id) {
            Ok(plugin) => Some((plugin.id, plugin.name, binary.to_owned())),
            Err(e) => {
                self.fail("load_plugin", e);
                None
            }
        }
    }

    fn send_rack(&self) {
        let _ = self.notices.send(Notice::Rack(self.rack.clone()));
    }

    fn position(&self, id: &str) -> Option<usize> {
        let index = self.rack.iter().position(|slot| slot.id == id);
        index.or_else(|| self.renamed.iter().position(|old| old == id))
    }

    fn remove(&mut self, id: &str) {
        let Some(index) = self.position(id) else {
            return;
        };
        // 子が落ちていたら、子に聞かずに並びから外す（落ちる原因の VST を、音を出さずに外せるように）。
        let result = if self.rack[index].loaded && !self.exited.load(Ordering::SeqCst) {
            self.host.remove_plugin(id)
        } else {
            Ok(())
        };
        match result {
            Ok(()) => {
                self.rack.remove(index);
                // 位置がずれるので、古い ID では当てない。
                self.renamed.clear();
            }
            Err(e) => self.fail("remove_plugin", e),
        }
        self.changed();
    }

    /// 並びの1つへの命令の前に、子が落ちていたら読み直す。読み直すと ID が変わるので、同じ位置の今の ID を返す。
    fn live(&mut self, id: &str) -> Option<(usize, String)> {
        let index = self.position(id)?;
        self.recover();
        Some((index, self.rack.get(index)?.id.clone()))
    }

    fn shift(&mut self, id: &str, up: bool) {
        let Some((index, _)) = self.live(id) else {
            return;
        };
        let items: Vec<(String, bool)> = self
            .rack
            .iter()
            .map(|slot| (slot.id.clone(), slot.loaded))
            .collect();
        let Some((other, order)) = rack::reordered(&items, index, up) else {
            return;
        };
        match self.host.reorder_plugins(order) {
            Ok(()) => {
                self.rack.swap(index, other);
                self.renamed.clear();
            }
            Err(e) => self.fail("reorder_plugins", e),
        }
        self.changed();
    }

    fn set_enabled(&mut self, id: &str, enabled: bool) {
        let Some((index, id)) = self.live(id) else {
            return;
        };
        match self.host.set_bypass(&id, !enabled) {
            Ok(()) => self.rack[index].enabled = enabled,
            Err(e) => self.fail("set_bypass", e),
        }
        self.changed();
    }

    fn set_muted(&mut self, id: &str, muted: bool) {
        let Some((index, id)) = self.live(id) else {
            return;
        };
        match self.host.set_mute(&id, muted) {
            Ok(()) => self.rack[index].muted = muted,
            Err(e) => self.fail("set_mute", e),
        }
        self.changed();
    }

    fn set_gain(&mut self, id: &str, gain: f32) {
        let Some((index, id)) = self.live(id) else {
            return;
        };
        match self.host.set_gain(&id, gain) {
            Ok(()) => self.rack[index].gain = gain,
            Err(e) => self.fail("set_gain", e),
        }
        self.changed();
    }

    /// エンジンの統計から音づくりの設定を読み、画面へ送る。子が落ちていたら、先に読み直す（落ちた子の既定値を読まない）。
    fn read_sound(&mut self) {
        self.recover();
        match self.host.get_engine_runtime_stats() {
            Ok(stats) => {
                let sound = Sound {
                    noise_on: stats.noise_reduction_enabled,
                    noise_mode: NoiseMode::parse(&stats.noise_reduction_mode),
                    strength: stats.noise_control_strength,
                    voice_guard: stats.noise_voice_guard,
                    effects_on: stats.built_in_effects_enabled,
                    preset: Preset::parse(&stats.built_in_effects_preset),
                    amount: stats.built_in_effects_amount,
                }
                .normalized();
                self.sound = Some(sound);
                let _ = self.notices.send(Notice::Sound(sound));
            }
            Err(e) => self.fail("get_engine_runtime_stats", e),
        }
    }

    /// ピーク保護を読む（`config` があれば変えてから読む）。読めなければ `None` を送る。
    /// 止まっているときは読めないのが普通なので、読むだけの失敗は帯に出さない。
    fn peak(&mut self, config: Option<PeakConfig>) {
        let peak = match self.host.peak_protection(config) {
            Ok(snapshot) => Some(Peak {
                enabled: snapshot.config.enabled,
                ceiling_db: snapshot.config.ceiling_db,
                release_ms: snapshot.config.release_ms,
                running: snapshot.running,
                pending: snapshot.pending,
            }),
            Err(e) if config.is_some() => {
                // 断られても状態は読めることがある（読めないなら、読み直しが `None` を送る）。
                self.fail("peak_protection", e);
                return self.peak(None);
            }
            Err(e) => {
                log::info!("ピーク保護の状態を読めません: {e}");
                None
            }
        };
        let _ = self.notices.send(Notice::Peak(peak));
    }

    /// 今の設定の一部だけを変える（ON/OFF だけ、または天井と復帰時間だけ）。
    fn set_peak(&mut self, change: impl FnOnce(PeakConfig) -> PeakConfig) {
        match self.host.peak_protection(None) {
            Ok(snapshot) => self.peak(Some(change(snapshot.config))),
            Err(e) => {
                self.fail("peak_protection", e);
                self.peak(None);
            }
        }
    }

    /// 変わった区画だけを送る。終わったら、エンジンが受け付けた結果を読み直して画面へ送り、保存する。
    fn set_sound(&mut self, change: Change) {
        if self.sound.is_none() {
            self.read_sound();
        }
        let Some(before) = self.sound else {
            return;
        };
        self.apply_sound(before.with(change), Some(before));
        self.read_sound();
        if let Some(sound) = self.sound {
            self.save_sound(sound);
        }
    }

    /// `before` が `None`（起動時の読み直しなど）なら、両方の区画を送る。歌向け・分からない種類など、この画面で変えない種類は送らない。
    fn apply_sound(&mut self, next: Sound, before: Option<Sound>) {
        // 種類が分からない（エンジンが知らない名前を返した）ときは送らない。種類を「弱」に書き換えないため。
        if let Some(mode) = next
            .noise_mode
            .filter(|_| before.is_none_or(|before| next.noise_differs(&before)))
        {
            if let Err(e) = self.host.set_noise_control_config(
                next.noise_on,
                mode.key().to_owned(),
                next.strength,
                next.voice_guard,
            ) {
                self.fail("set_noise_control_config", e);
            }
        }
        if next.effects_editable() && before.is_none_or(|before| next.effects_differ(&before)) {
            let preset = next.preset.map(|p| p.key().to_owned());
            if let Err(e) = self
                .host
                .set_built_in_effects(next.effects_on, preset, next.amount)
            {
                self.fail("set_built_in_effects", e);
            }
        }
    }

    /// 起動したら、音を始める前に、保存した音づくりをエンジンへ送る。
    fn restore_sound(&mut self) {
        let text = match std::fs::read_to_string(self.config_dir.join(SOUND_FILE)) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => return self.fail("read_sound", e.into()),
        };
        match serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|value| sound_from_json(&value))
        {
            Some(sound) => self.apply_sound(sound, None),
            None => self.fail("read_sound", anyhow::anyhow!("{SOUND_FILE} を読めません")),
        }
    }

    fn save_sound(&self, sound: Sound) {
        let path = self.config_dir.join(SOUND_FILE);
        if let Err(e) = store::write_atomic(&path, sound_to_json(sound).to_string().as_bytes()) {
            self.fail("save_sound", e.into());
        }
    }

    /// スキャンは VST ごとに別のプロセスで調べるので時間がかかる。命令のスレッドを塞がないよう、別のスレッドで行う。
    fn scan(&self) {
        let config_dir = self.config_dir.clone();
        let notices = self.notices.clone();
        let spawned = std::thread::Builder::new()
            .name("gpui-scan".into())
            .spawn(move || {
                let result = std::fs::create_dir_all(&config_dir)
                    .map_err(|e| e.to_string())
                    .and_then(|()| scanner::scan_system_vst3(&config_dir, &[]))
                    .map(|plugins| {
                        plugins
                            .into_iter()
                            .map(|p| Candidate {
                                name: p.name,
                                vendor: p.vendor,
                                category: p.sub_categories,
                                path: p.path,
                                class_id: p.class_id,
                            })
                            .collect()
                    });
                let _ = notices.send(Notice::Catalog(result));
            });
        if let Err(e) = spawned {
            let _ = self.notices.send(Notice::Catalog(Err(e.to_string())));
        }
    }

    fn execute(&mut self, command: &Command) {
        let (name, result) = match *command {
            Command::Start => return self.start_saved(),
            Command::StartWith {
                ref input,
                ref output,
            } => return self.start_with(input, output),
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
            Command::MovePlugin { ref id, up } => return self.shift(id, up),
            Command::SetPluginEnabled { ref id, enabled } => return self.set_enabled(id, enabled),
            Command::SetPluginMuted { ref id, muted } => return self.set_muted(id, muted),
            Command::SetPluginGain { ref id, gain } => return self.set_gain(id, gain),
            Command::OpenEditor(ref id) => match self.live(id) {
                Some((_, id)) => ("open_editor", self.host.open_editor(&id)),
                None => return,
            },
            Command::ReadSound => return self.read_sound(),
            Command::ReadPeak => return self.peak(None),
            Command::SetPeak(enabled) => {
                return self.set_peak(|config| PeakConfig { enabled, ..config })
            }
            Command::SetPeakLimits {
                ceiling_db,
                release_ms,
            } => {
                return self.set_peak(|config| PeakConfig {
                    ceiling_db,
                    release_ms,
                    ..config
                })
            }
            Command::SetSound(change) => return self.set_sound(change),
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

fn sound_to_json(sound: Sound) -> serde_json::Value {
    serde_json::json!({
        "noiseOn": sound.noise_on,
        "noiseMode": sound.noise_mode.map(NoiseMode::key),
        "strength": sound.strength,
        "voiceGuard": sound.voice_guard,
        "effectsOn": sound.effects_on,
        "preset": sound.preset.map(Preset::key),
        "amount": sound.amount,
    })
}

/// 形の違う保存は `None`（読めないと知らせ、上書きは次に変えたときだけ）。
fn sound_from_json(value: &serde_json::Value) -> Option<Sound> {
    let text = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
    let flag = |key: &str| value.get(key).and_then(serde_json::Value::as_bool);
    let number = |key: &str| value.get(key).and_then(serde_json::Value::as_f64);
    Some(
        Sound {
            noise_on: flag("noiseOn")?,
            noise_mode: text("noiseMode").and_then(NoiseMode::parse),
            strength: number("strength")? as f32,
            voice_guard: flag("voiceGuard")?,
            effects_on: flag("effectsOn")?,
            preset: text("preset").and_then(Preset::parse),
            amount: number("amount")? as f32,
        }
        .normalized(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sound_survives_the_save_file() {
        let sound = Sound {
            noise_on: true,
            noise_mode: Some(NoiseMode::High),
            strength: 0.8,
            voice_guard: false,
            effects_on: true,
            preset: Some(Preset::Warm),
            amount: 0.5,
        };
        assert_eq!(sound_from_json(&sound_to_json(sound)), Some(sound));
        assert_eq!(sound_from_json(&serde_json::json!({"noiseOn": true})), None);
    }

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
            ceiling_db,
            release_ms: 100.0,
        };
        assert!(limits(-1.0).supersedes(&limits(-2.0)));
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

    #[test]
    fn level_event_updates_slot_without_notice() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, rx) = flume::unbounded();
        on_event(
            "audio-level",
            serde_json::json!({"input": [0.25, 0.5], "output": [0.75, 1.0], "stream_generation": "1:3"}),
            &levels,
            &tx,
        );
        let slot = *levels.lock().unwrap();
        assert_eq!(slot.seq, 1);
        assert_eq!(slot.input, [0.25, 0.5]);
        assert_eq!(slot.output, [0.75, 1.0]);
        assert_eq!(slot.processed, None);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn level_event_reads_processed_beside_input_and_output() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, _rx) = flume::unbounded();
        on_event(
            "audio-level",
            serde_json::json!({"input": [0.25, 0.5], "output": [0.0, 0.0], "processed": [0.5, 0.4],
                "reduction_db": {"noise": -12.0}, "speech": true}),
            &levels,
            &tx,
        );
        assert_eq!(levels.lock().unwrap().processed, Some([0.5, 0.4]));

        on_event(
            "audio-level",
            serde_json::json!({"input": [0.1, 0.1], "output": [0.1, 0.1], "processed": "x"}),
            &levels,
            &tx,
        );
        assert!(levels.lock().unwrap().processed.unwrap()[0].is_nan());
    }

    #[test]
    fn malformed_level_becomes_nan() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, _rx) = flume::unbounded();
        on_event(
            "audio-level",
            serde_json::json!({"input": [0.1]}),
            &levels,
            &tx,
        );
        assert!(levels.lock().unwrap().input[0].is_nan());
    }

    #[test]
    fn mute_and_stop_events_become_notices() {
        let levels = Mutex::new(LevelSlot::default());
        let (tx, rx) = flume::unbounded();
        on_event("global-mute-changed", serde_json::json!(true), &levels, &tx);
        on_event("audio-stopped", serde_json::json!({}), &levels, &tx);
        on_event(
            "audio-conditions-changed",
            serde_json::json!(null),
            &levels,
            &tx,
        );
        assert!(matches!(rx.try_recv(), Ok(Notice::Muted(true))));
        assert!(matches!(rx.try_recv(), Ok(Notice::Stopped)));
        assert!(rx.try_recv().is_err());
    }
}
