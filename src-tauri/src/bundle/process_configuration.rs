//! プロセス入力の永続設定だけを保持する。PID・生成時刻は適用権限として保存しない。
use super::*;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessConfiguration {
    pub version: u8,
    pub source: crate::input_source::ProcessConfig,
    pub output_id: String,
}
impl ProcessConfiguration {
    pub(crate) fn validate(&self) -> Result<(), String> {
        crate::input_source::Config::ProcessLoopback(self.source.clone()).validate()?;
        if self.version != 1
            || !self.output_id.starts_with("wasapi:")
            || self.output_id.len() <= "wasapi:".len()
            || self.output_id.len() > 4096
            || self.output_id.chars().any(char::is_control)
            || self.output_id == format!("wasapi:{}", self.source.raw_endpoint_id)
        {
            return Err(
                "プロセス入力の返し先を、原音用とは別のWASAPI出力へ設定してください".into(),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(crate) fn sample() -> ProcessConfiguration {
        ProcessConfiguration {
            version: 1,
            source: crate::input_source::ProcessConfig {
                app_key: "a".repeat(64),
                app_name: "player.exe".into(),
                raw_endpoint_id: "raw-id".into(),
                purpose: crate::input_source::Purpose::Voice,
            },
            output_id: "wasapi:monitor-id".into(),
        }
    }
    #[test]
    fn process_snapshot_excludes_runtime_authority_and_rejects_injected_target_and_shared_output() {
        let value = sample();
        value.validate().unwrap();
        let mut json = serde_json::to_value(&value).unwrap();
        assert!(!json.to_string().contains("pid"));
        json["target"] = serde_json::json!({"pid":123,"created":456});
        assert!(serde_json::from_value::<ProcessConfiguration>(json).is_err());
        let mut invalid = value.clone();
        invalid.output_id = "wasapi:raw-id".into();
        assert!(invalid.validate().is_err());
        invalid = value.clone();
        invalid.output_id = "wasapi:".into();
        assert!(invalid.validate().is_err());
        invalid = value;
        invalid.source.purpose = crate::input_source::Purpose::Music;
        invalid.validate().unwrap();
    }
}
