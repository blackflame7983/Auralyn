//! 保存する入力設定と、その起動時だけ有効なプロセス識別を分ける。
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    #[default]
    Voice,
    Music,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessConfig {
    pub app_key: String,
    pub app_name: String,
    pub raw_endpoint_id: String,
    pub purpose: Purpose,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "config",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Config {
    Device {
        #[serde(default)]
        purpose: Purpose,
    },
    ProcessLoopback(ProcessConfig),
}
impl Default for Config {
    fn default() -> Self {
        Self::Device {
            purpose: Purpose::Voice,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub pid: u32,
    pub created: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    pub source: Config,
    pub target: Option<Target>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub source: Config,
    pub candidate_id: Option<String>,
}

impl Config {
    pub(crate) fn supports_bundle_capture(&self) -> bool {
        matches!(
            self,
            Self::Device {
                purpose: Purpose::Voice
            } | Self::ProcessLoopback(_)
        )
    }
    pub fn validate(&self) -> Result<(), String> {
        if let Self::ProcessLoopback(c) = self {
            if c.app_key.len() != 64 || !c.app_key.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("アプリの識別情報が不正です。選び直してください".into());
            }
            if c.app_name.is_empty()
                || c.app_name.len() > 260
                || c.app_name
                    .chars()
                    .any(|c| c.is_control() || c == '/' || c == '\\')
                || c.raw_endpoint_id.is_empty()
                || c.raw_endpoint_id.len() > 4096
                || c.raw_endpoint_id.chars().any(char::is_control)
            {
                return Err("アプリ入力の設定が不正です".into());
            }
        }
        Ok(())
    }

    pub fn purpose(&self) -> Purpose {
        match self {
            Self::Device { purpose } => *purpose,
            Self::ProcessLoopback(c) => c.purpose,
        }
    }
}

impl Start {
    pub fn validate(&self) -> Result<(), String> {
        self.source.validate()?;
        match (&self.source, &self.target) {
            (Config::Device { .. }, None) => Ok(()),
            (Config::ProcessLoopback(_), Some(t)) if t.pid > 0 && t.created > 0 => Ok(()),
            _ => Err("アプリの実行状態を確認できません。選び直してください".into()),
        }
    }
}

pub(crate) fn require_capability(
    send: impl FnOnce(crate::ipc::Command) -> anyhow::Result<crate::ipc::Response>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(
            send(crate::ipc::Command::ProcessInputCapability)?,
            crate::ipc::Response::ProcessInputCapability { version: 1 }
        ),
        "音声エンジンがこの入力形式に対応していません。更新して再起動してください"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_capture_support_does_not_enable_unsupported_music_device_restore() {
        assert!(Config::default().supports_bundle_capture());
        assert!(!Config::Device {
            purpose: Purpose::Music
        }
        .supports_bundle_capture());
        for purpose in [Purpose::Voice, Purpose::Music] {
            assert!(Config::ProcessLoopback(ProcessConfig {
                app_key: "a".repeat(64),
                app_name: "player.exe".into(),
                raw_endpoint_id: "raw".into(),
                purpose
            })
            .supports_bundle_capture());
        }
    }

    #[test]
    fn old_engine_cannot_ignore_process_selection_and_start_a_microphone() {
        use crate::ipc::{Command, Response};
        assert!(require_capability(|command| {
            assert!(matches!(command, Command::ProcessInputCapability));
            Ok(Response::Success)
        })
        .is_err());
        assert!(require_capability(|_| Ok(Response::Error("unknown command".into()))).is_err());
        assert!(
            require_capability(|_| Ok(Response::ProcessInputCapability { version: 2 })).is_err()
        );
        assert!(
            require_capability(|_| Ok(Response::ProcessInputCapability { version: 1 })).is_ok()
        );
    }

    #[test]
    fn saved_config_cannot_contain_a_pid_or_silently_change_unknown_source_to_device() {
        let config = Config::ProcessLoopback(ProcessConfig {
            app_key: "a".repeat(64),
            app_name: "player.exe".into(),
            raw_endpoint_id: "endpoint".into(),
            purpose: Purpose::Music,
        });
        let value = serde_json::to_value(&config).unwrap();
        assert!(config.validate().is_ok());
        assert!(!value.to_string().contains("pid"));
        let mut invalid = value;
        invalid["config"]["pid"] = 42.into();
        assert!(serde_json::from_value::<Config>(invalid).is_err());
        assert!(serde_json::from_str::<Config>(r#"{"kind":"future_source"}"#).is_err());
        assert!(Start {
            source: config,
            target: None
        }
        .validate()
        .is_err());
        assert!(Start {
            source: Config::default(),
            target: Some(Target { pid: 1, created: 1 })
        }
        .validate()
        .is_err());
    }
}
