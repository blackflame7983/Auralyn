use crate::input_source::{ProcessConfig, Purpose, Target};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Track {
    pub gain: f32,
    pub muted: bool,
}
impl Default for Track {
    fn default() -> Self {
        Self {
            gain: 1.0,
            muted: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Levels {
    pub voice: Track,
    pub accompaniment: Track,
    pub monitor_accompaniment: bool,
    /// 正はオケ、負は声を追加で待たせる。既知の処理待ちとは別に保持する。
    pub offset_ms: i32,
}
impl Default for Levels {
    fn default() -> Self {
        Self {
            voice: Default::default(),
            accompaniment: Default::default(),
            monitor_accompaniment: true,
            offset_ms: 0,
        }
    }
}
impl Levels {
    pub fn validate(&self) -> Result<(), String> {
        if !(-2000..=2000).contains(&self.offset_ms)
            || [&self.voice, &self.accompaniment]
                .iter()
                .any(|track| !track.gain.is_finite() || !(0.0..=2.0).contains(&track.gain))
        {
            return Err("ミックスの音量は0〜2倍、時間差は±2,000msで指定してください".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub host: String,
    pub input_id: String,
    pub input_channels: [usize; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "config",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Source {
    Device(Device),
    ProcessLoopback(ProcessConfig),
}
impl Source {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Device(device) => {
                // ASIO機器の二重openを避ける。オケ機器はWASAPIの仮想ケーブルを使う。
                if !device.host.eq_ignore_ascii_case("wasapi")
                    || device.input_id.is_empty()
                    || device.input_id.len() > 4096
                    || device.input_id.chars().any(char::is_control)
                    || device.input_channels.iter().any(|channel| *channel >= 256)
                {
                    return Err("オケ入力はWASAPI機器のIDと入力チャンネルを指定してください".into());
                }
            }
            Self::ProcessLoopback(config) => {
                crate::input_source::Config::ProcessLoopback(config.clone()).validate()?;
                if config.purpose != Purpose::Music {
                    return Err("オケのプロセス入力は音楽の用途を選んでください".into());
                }
            }
        }
        Ok(())
    }
    pub fn validate_primary(
        &self,
        input_id: Option<&str>,
        output_raw_id: &str,
    ) -> Result<(), String> {
        match self {
            Self::Device(device)
                if input_id.is_none() || input_id == Some(device.input_id.as_str()) =>
            {
                Err("マイクとオケに同じ入力機器を重複指定できません".into())
            }
            Self::ProcessLoopback(process) if output_raw_id == process.raw_endpoint_id => {
                Err("本人用とは別の原音用出力を指定してください".into())
            }
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u8,
    pub source: Source,
    pub levels: Levels,
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("対応していないミックス設定です".into());
        }
        self.source.validate()?;
        self.levels.validate()
    }
}

/// PIDは開始時の要求だけに含め、設定ファイルのConfigへは入れない。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Start {
    pub config: Config,
    pub target: Option<Target>,
}
impl Start {
    pub fn validate(&self) -> Result<(), String> {
        self.config.validate()?;
        match (&self.config.source, &self.target) {
            (Source::Device(_), None) => Ok(()),
            (Source::ProcessLoopback(_), Some(target)) if target.pid > 0 && target.created > 0 => {
                Ok(())
            }
            _ => Err("オケの入力元を明示選択し直してください".into()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Snapshot,
    Configure {
        expected_epoch: String,
        expected_revision: String,
        start: Option<Start>,
    },
    Levels {
        expected_epoch: String,
        expected_revision: String,
        levels: Levels,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub epoch: String,
    pub revision: String,
    pub config: Option<Config>,
    pub running: bool,
    pub accompaniment: Option<Box<crate::audio_engine::process_capture::Snapshot>>,
    pub voice_peak: [f32; 2],
    pub accompaniment_peak: [f32; 2],
    pub mix_peak: [f32; 2],
    pub known_voice_processing_frames: Option<u32>,
    pub pending: bool,
    pub failed: bool,
    pub primary_clock: Option<ClockSnapshot>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockSnapshot {
    pub adaptive: bool,
    pub input_rate_hz: u32,
    pub output_rate_hz: u32,
    pub queued_frames: u64,
    pub correction_ppm: i32,
    pub underruns: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_gain_offset_identity_and_saved_target_are_rejected() {
        let mut levels = Levels {
            offset_ms: 2001,
            ..Default::default()
        };
        assert!(levels.validate().is_err());
        levels.offset_ms = -2000;
        levels.voice.gain = f32::NAN;
        assert!(levels.validate().is_err());
        levels.voice.gain = 0.0;
        levels.accompaniment.gain = 2.0;
        levels.validate().unwrap();
        let source = Source::ProcessLoopback(ProcessConfig {
            app_key: "a".repeat(64),
            app_name: "player.exe".into(),
            raw_endpoint_id: "raw".into(),
            purpose: Purpose::Music,
        });
        let config = Config {
            version: 1,
            source,
            levels,
        };
        config.validate().unwrap();
        let mut value = serde_json::to_value(&config).unwrap();
        value["target"] = serde_json::json!({"pid":1,"created":1});
        assert!(serde_json::from_value::<Config>(value).is_err());
        assert!(Start {
            config: config.clone(),
            target: None
        }
        .validate()
        .is_err());
        Start {
            config,
            target: Some(Target { pid: 1, created: 1 }),
        }
        .validate()
        .unwrap();
    }
    #[test]
    fn resolved_primary_identity_rejects_duplicate_inputs_even_for_legacy_name_requests() {
        let source = Source::Device(Device {
            host: "WASAPI".into(),
            input_id: "wasapi:actual".into(),
            input_channels: [0, 1],
        });
        assert!(source
            .validate_primary(Some("wasapi:actual"), "output")
            .is_err());
        assert!(source.validate_primary(None, "output").is_err());
        source
            .validate_primary(Some("wasapi:different"), "output")
            .unwrap();
    }
}
