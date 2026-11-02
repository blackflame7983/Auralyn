//! 二系統出力を含むbundleの範囲。旧形式を全構成の保存へ読み替えない。
use super::*;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutputConfiguration {
    pub version: u8,
    pub devices: RecoveryDevices,
    pub config: crate::audio_engine::live_output::Config,
}
impl OutputConfiguration {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.devices.input_id.is_empty()
            || self.devices.output_id.is_empty()
            || self.devices.input_id.len() > 4096
            || self.devices.output_id.len() > 4096
            || self.config.device_id.as_ref() == Some(&self.devices.output_id)
        {
            return Err("分離出力の保存形式または機器IDを確認してください".into());
        }
        self.config.validate().map_err(|e| e.to_string())
    }
}

/// 現在の自分用処理を落として標準の枝別設定へ戻したことを、復帰成功と呼ばない。
pub(crate) fn validate_custom_monitor(
    config: &crate::audio_engine::live_output::Config,
    snapshot: &crate::audio_engine::split_monitor::StateSnapshot,
) -> Result<(), String> {
    let expected =
        config
            .monitor_singing
            .clone()
            .map(|config| crate::audio_engine::split_monitor::State {
                mode: crate::audio_engine::live_modes::Mode::Singing,
                config,
            });
    if snapshot.pending || snapshot.failed || snapshot.state != expected {
        return Err("現在の自分用処理が登録済みの歌向け設定と異なるか反映待ちです。この構成の保存・復帰は未対応のため、設定を確認してください".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_monitor_does_not_drop_retained_talk_or_individually_restored_processing() {
        use crate::audio_engine::{
            builtin,
            live_modes::Mode,
            split_monitor::{State, StateSnapshot},
        };
        let voice = builtin::Config::default();
        let config = crate::audio_engine::live_output::Config {
            split_processing: true,
            monitor_singing: Some(voice.clone()),
            ..Default::default()
        };
        let mut current = StateSnapshot {
            epoch: "1".into(),
            state: Some(State {
                mode: Mode::Singing,
                config: voice,
            }),
            revision: "2".into(),
            completed_revision: "2".into(),
            pending: false,
            failed: false,
        };
        validate_custom_monitor(&config, &current).unwrap();
        current.state.as_mut().unwrap().mode = Mode::Talk;
        assert!(validate_custom_monitor(&config, &current).is_err());
        current.state.as_mut().unwrap().mode = Mode::Singing;
        current.state.as_mut().unwrap().config.amount = 0.3;
        assert!(validate_custom_monitor(&config, &current).is_err());
        current.state.as_mut().unwrap().config = config.monitor_singing.clone().unwrap();
        current.pending = true;
        assert!(validate_custom_monitor(&config, &current).is_err());
    }
}
