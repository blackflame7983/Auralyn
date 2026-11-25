//! 実エンジンとのつなぎ。`AudioHost`（Tauri と同じ親の処理）を、画面とは別のスレッドで動かす。
//!
//! - 命令は1本のスレッドが受付順に実行する。`AudioHost` の命令は応答を待つので、画面のスレッドでは呼ばない。
//! - 通知は `AudioHost::set_event_sink`（中核 API の `EventSink`）で、Tauri と同じ順序のまま受ける。
//! - メーターは届くたびに画面へ送らず、最新の値だけを置く。画面が描画の周期で読む。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use auralyn_core::event::{EmitError, Event, EventSink};
use auralyn_ui_model::connect::{Device, Saved};
use vst_host_lib::audio::{ActiveAudioConfig, AudioHost};
use vst_host_lib::vst_host::scanner;

#[derive(Debug)]
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
    OpenEditor,
}

impl Command {
    /// 続けて届いた同じ種類の音量は、最後の値だけを送る（スライダーを動かしている間の詰まりを防ぐ）。
    fn supersedes(&self, earlier: &Command) -> bool {
        matches!(
            (self, earlier),
            (Command::SetInputGain(_), Command::SetInputGain(_))
                | (Command::SetOutputGain(_), Command::SetOutputGain(_))
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
    PluginLoaded(String),
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

pub struct Options {
    pub config_dir: PathBuf,
    pub plugin: Option<String>,
}

impl Engine {
    pub fn start(options: Options) -> Self {
        let (commands, command_rx) = flume::unbounded();
        let (notice_tx, notices) = flume::unbounded();
        let levels = Arc::new(Mutex::new(LevelSlot::default()));
        let listener_levels = levels.clone();
        let listener_notices = notice_tx.clone();
        let exited = Arc::new(AtomicBool::new(false));
        let listener_exited = exited.clone();
        std::thread::Builder::new()
            .name("gpui-control".into())
            .spawn(move || {
                let mut host = AudioHost::new(options.config_dir);
                host.set_event_sink(Arc::new(Sink {
                    levels: listener_levels,
                    notices: listener_notices,
                    exited: listener_exited,
                }));
                Control {
                    host,
                    notices: notice_tx,
                    plugin_id: None,
                    plugin_path: options.plugin,
                    exited,
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
}

/// 中核の出来事の受け口（`auralyn_core::event::EventSink`）。名前・本文・順序は Tauri の emit と同じ。
/// reader などのスレッドから同期で呼ばれるので、待たずに戻る。
struct Sink {
    levels: Arc<Mutex<LevelSlot>>,
    notices: flume::Sender<Notice>,
    /// 子が落ちた。次の開始は空の子で始まるので、VST を読み直す。
    exited: Arc<AtomicBool>,
}

impl EventSink for Sink {
    fn send(&self, event: Event) -> Result<(), EmitError> {
        let payload = event
            .payload::<serde_json::Value>()
            .map_err(EmitError::Serialize)?;
        if event.name() == "audio-engine-exited" {
            self.exited.store(true, Ordering::SeqCst);
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
    plugin_id: Option<String>,
    /// `--plugin` の VST3。開始するたびに、子に無ければ読む。
    plugin_path: Option<String>,
    exited: Arc<AtomicBool>,
}

impl Control {
    fn run(mut self, commands: flume::Receiver<Command>) {
        self.start_saved();
        while let Ok(first) = commands.recv() {
            let mut pending = vec![first];
            pending.extend(commands.try_iter());
            for (i, command) in pending.iter().enumerate() {
                if pending[i + 1..]
                    .iter()
                    .any(|later| later.supersedes(command))
                {
                    continue;
                }
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
        if self.exited.swap(false, Ordering::SeqCst) {
            self.plugin_id = None;
        }
        if let (None, Some(path)) = (&self.plugin_id, self.plugin_path.clone()) {
            self.load_plugin(&path);
        }
    }

    /// `.vst3` のバンドル（フォルダ）を渡されたら、Tauri 版のスキャンと同じく中の実体（Contents/x86_64-win）を探して読む。
    fn load_plugin(&mut self, path: &str) {
        let binary = scanner::resolve_binary(Path::new(path));
        let Some(binary) = binary.as_deref().and_then(Path::to_str) else {
            let _ = self.notices.send(Notice::Failed {
                command: "load_plugin",
                message: format!("VST3 の実体が見つかりません: {path}"),
            });
            return;
        };
        log::info!("VST3 を読み込む: {binary}");
        match self.host.load_plugin(binary, None) {
            Ok(plugin) => {
                self.plugin_id = Some(plugin.id);
                let _ = self.notices.send(Notice::PluginLoaded(plugin.name));
            }
            Err(e) => self.fail("load_plugin", e),
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
            Command::SetInputGain(value) => ("set_input_gain", self.host.set_input_gain(value)),
            Command::SetOutputGain(value) => ("set_output_gain", self.host.set_output_gain(value)),
            Command::OpenEditor => match self.plugin_id.clone() {
                Some(id) => ("open_editor", self.host.open_editor(&id)),
                None => return,
            },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn later_gain_supersedes_earlier_gain_of_same_kind_only() {
        assert!(Command::SetInputGain(0.5).supersedes(&Command::SetInputGain(0.2)));
        assert!(!Command::SetOutputGain(0.5).supersedes(&Command::SetInputGain(0.2)));
        assert!(!Command::SetMute(true).supersedes(&Command::SetMute(false)));
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
