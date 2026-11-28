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
