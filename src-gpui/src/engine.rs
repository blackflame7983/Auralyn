//! 実エンジンとのつなぎ。`AudioHost`（Tauri と同じ親の処理）を、画面とは別のスレッドで動かす。
//!
//! - 命令は1本のスレッドが受付順に実行する。`AudioHost` の命令は応答を待つので、画面のスレッドでは呼ばない。
//! - 通知は `AudioHost::set_event_sink`（中核 API の `EventSink`）で、Tauri と同じ順序のまま受ける。
//! - メーターは届くたびに画面へ送らず、最新の値だけを置く。画面が描画の周期で読む。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use auralyn_core::event::{EmitError, Event, EventSink};
use vst_host_lib::audio::AudioHost;
use vst_host_lib::vst_host::scanner;

#[derive(Debug)]
pub enum Command {
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
    /// 保存した設定がない、または開始に失敗した。
    NotStarted(String),
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
        std::thread::Builder::new()
            .name("gpui-control".into())
            .spawn(move || {
                let mut host = AudioHost::new(options.config_dir);
                host.set_event_sink(Arc::new(Sink {
                    levels: listener_levels,
                    notices: listener_notices,
                }));
                Control {
                    host,
                    notices: notice_tx,
                    plugin_id: None,
                }
                .run(options.plugin, command_rx);
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
}

impl EventSink for Sink {
    fn send(&self, event: Event) -> Result<(), EmitError> {
        let payload = event
            .payload::<serde_json::Value>()
            .map_err(EmitError::Serialize)?;
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
}

impl Control {
    fn run(mut self, plugin: Option<String>, commands: flume::Receiver<Command>) {
        self.start_saved();
        if let Some(path) = plugin {
            self.load_plugin(&path);
        }
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
                let _ = self.notices.send(Notice::NotStarted(
                    "保存した音声の設定がありません。Auralyn で一度音声を開始してください。".into(),
                ));
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
        let notice = match result {
            Ok(_) => Notice::Started {
                input: config.input,
                output: config.output,
            },
            Err(e) => Notice::NotStarted(vst_host_lib::audio::localize_audio_error(e.to_string())),
        };
        let _ = self.notices.send(notice);
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
