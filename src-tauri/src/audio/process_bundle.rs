//! 明示選択した現在のプロセスだけを、配信状態の復帰中に再開する。
use super::*;
use crate::bundle::ProcessConfiguration;
use crate::input_source::{Config, Start, Target};

impl AudioHost {
    pub(crate) fn capture_bundle_process(&self) -> Result<Option<(ProcessConfiguration, Target)>> {
        let Some(active) = &self.active_config else {
            return Ok(None);
        };
        let Some(Config::ProcessLoopback(source)) = &active.input_source else {
            return Ok(None);
        };
        let selected = self
            .process_inputs
            .selected
            .as_ref()
            .ok_or_else(|| anyhow!("起動中のアプリを明示選択してください"))?;
        anyhow::ensure!(
            selected.source == Config::ProcessLoopback(source.clone()),
            "現在のプロセス選択を確認できません"
        );
        selected.validate().map_err(anyhow::Error::msg)?;
        let target = selected
            .target
            .clone()
            .ok_or_else(|| anyhow!("現在のアプリの実行状態を確認できません"))?;
        let value = ProcessConfiguration {
            version: 1,
            source: source.clone(),
            output_id: active
                .output_id
                .clone()
                .ok_or_else(|| anyhow!("返し先の機器IDを確認できません"))?,
        };
        value.validate().map_err(anyhow::Error::msg)?;
        Ok(Some((value, target)))
    }
    pub(crate) fn process_snapshot_supported(&mut self) -> Result<()> {
        self.preflight_live_changes()?;
        anyhow::ensure!(
            self.capture_bundle_process()?.is_some(),
            "現在の入力はプロセス入力ではありません。音声設定でアプリを選んでください"
        );
        anyhow::ensure!(
            self.live_modes.target.is_none()
                && self.live_output(None)?.config == Default::default(),
            "プロセス入力の保存・復帰は、単独出力・カスタム構成だけが対象です"
        );
        Ok(())
    }
    pub(crate) fn start_bundle_process(
        &mut self,
        saved: &ProcessConfiguration,
        audio: &crate::vst_host::presets::ProfileAudioConfig,
        intent: crate::profile::StartIntent,
    ) -> Result<()> {
        self.process_snapshot_supported()?;
        let (current, _) = self
            .capture_bundle_process()?
            .ok_or_else(|| anyhow!("プロセス入力を選び直してください"))?;
        anyhow::ensure!(
            current == *saved,
            "保存したアプリ・用途・原音用出力・返し先と現在の明示選択が異なります"
        );
        let source: Start = self
            .resolve_input_source(Some(crate::input_source::Request {
                source: Config::ProcessLoopback(saved.source.clone()),
                candidate_id: None,
            }))?
            .ok_or_else(|| anyhow!("現在のアプリを確認できません"))?;
        intent.validate().map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            intent.muted && self.is_global_muted,
            "プロセス入力の復帰前に全体ミュートしてください"
        );
        self.validate_bundle_connection()?;
        self.preserve_live_changes_for_restart();
        self.kill_engine();
        self.start_internal_with_source(
            Some(audio.host.clone()),
            None,
            audio.output_device.clone(),
            Some(audio.buffer_size),
            Some(audio.sample_rate),
            Some(intent),
            None,
            None,
            Some(saved.output_id.clone()),
            None,
            Some(source),
        )?;
        Ok(())
    }
    pub(crate) fn process_bundle_scope<T>(
        &mut self,
        expected_output_revision: &str,
        operation: impl FnOnce(&mut Self) -> std::result::Result<T, String>,
    ) -> std::result::Result<T, String> {
        let (config, revision) = self
            .capture_bundle_output(true)
            .map_err(|e| e.to_string())?;
        if config != Default::default() || revision != expected_output_revision {
            return Err("出力構成が変わりました。単独出力を確認し差分を取り直してください".into());
        }
        let result = operation(self).and_then(|value| {
            self.validate_bundle_connection()
                .map_err(|e| e.to_string())?;
            let (config, revision) = self
                .capture_bundle_output(true)
                .map_err(|e| e.to_string())?;
            if config != Default::default() || revision != expected_output_revision {
                return Err("適用中に出力構成が変わりました。原本を保持しています".into());
            }
            Ok(value)
        });
        if result.is_err() && self.stop().is_err() {
            self.kill_engine();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_preferences_are_not_a_runtime_selection_in_a_new_host() {
        let source = crate::input_source::ProcessConfig {
            app_key: "a".repeat(64),
            app_name: "player.exe".into(),
            raw_endpoint_id: "raw-id".into(),
            purpose: crate::input_source::Purpose::Music,
        };
        let mut host = AudioHost::new(std::env::temp_dir().join("auralyn-process-bundle-choice"));
        host.active_config = Some(ActiveAudioConfig {
            input_source: Some(Config::ProcessLoopback(source.clone())),
            host: "Wasapi".into(),
            output_id: Some("wasapi:monitor-id".into()),
            ..Default::default()
        });
        assert!(host.capture_bundle_process().is_err());
        host.process_inputs.selected = Some(Start {
            source: Config::ProcessLoopback(source),
            target: Some(Target {
                pid: 42,
                created: 123,
            }),
        });
        let (config, target) = host.capture_bundle_process().unwrap().unwrap();
        assert_eq!(target.pid, 42);
        assert_eq!(config.output_id, "wasapi:monitor-id");
        assert!(!serde_json::to_string(&config).unwrap().contains("pid"));
        if let Config::ProcessLoopback(config) =
            &mut host.process_inputs.selected.as_mut().unwrap().source
        {
            config.purpose = crate::input_source::Purpose::Voice;
        }
        assert!(host.capture_bundle_process().is_err());
        assert!(host.child.is_none());
    }
}
