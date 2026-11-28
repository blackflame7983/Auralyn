//! 本番モードと関連VSTの内容。通常プロファイルを置換せず、復帰専用の内容参照を使う。
use super::*;
use crate::audio_engine::{
    live_modes::{Definitions, Mode, ProfileBinding},
    split_monitor,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveConfiguration {
    pub version: u8,
    pub definitions: Definitions,
    pub target: Option<Mode>,
    pub monitor: Option<split_monitor::State>,
    pub singing_plugins: Option<Vec<PresetPlugin>>,
    pub talk_plugins: Option<Vec<PresetPlugin>>,
}

pub(crate) fn plugin_revision(plugins: &[PresetPlugin]) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(true, plugins)).map_err(|e| e.to_string())?)
    ))
}
pub(crate) fn snapshot_path(root: &Path, revision: &str) -> Result<PathBuf, String> {
    if revision.len() != 64 || !revision.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("関連VSTの内容識別子が不正です".into());
    }
    Ok(root
        .join("mode-profile-snapshots")
        .join(format!("{revision}.json")))
}
pub(crate) fn read_snapshot(
    root: &Path,
    binding: &ProfileBinding,
) -> Result<Vec<PresetPlugin>, String> {
    let path = snapshot_path(
        root,
        binding
            .snapshot
            .as_deref()
            .ok_or("関連VSTの保存先がありません")?,
    )?;
    let file = std::fs::File::open(path).map_err(|_| "復帰した関連VSTの保存内容を読めません")?;
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take((MAX_BUNDLE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err("関連VSTの保存内容が大きすぎます".into());
    }
    let plugins: Vec<PresetPlugin> =
        serde_json::from_slice(&bytes).map_err(|_| "関連VSTの保存形式を確認してください")?;
    validate_plugins(binding, &plugins)?;
    Ok(plugins)
}
fn validate_plugins(binding: &ProfileBinding, plugins: &[PresetPlugin]) -> Result<(), String> {
    if plugins.len() > crate::audio_engine::plugins::MAX_PLUGINS
        || plugin_revision(plugins)? != binding.revision
    {
        return Err("関連VSTの保存内容が登録時と異なります".into());
    }
    for plugin in plugins {
        crate::ipc::RestorePluginRequest {
            path: plugin.path.clone(),
            state: plugin.state.clone(),
            bypassed: !plugin.enabled,
            muted: plugin.muted,
            gain: plugin.gain,
            class_id: plugin.class_id.clone(),
        }
        .validate()?;
    }
    Ok(())
}
impl LiveConfiguration {
    pub(crate) fn matches_builtin(
        &self,
        actual: &crate::vst_host::presets::ProfileBuiltinFx,
    ) -> bool {
        self.target.is_none_or(|mode| {
            self.definitions.config(mode).is_ok_and(|expected| {
                expected.active == actual.enabled
                    && expected.preset.as_str() == actual.preset
                    && expected.amount == actual.amount
                    && expected.singing.unwrap_or_default() == actual.singing.unwrap_or_default()
                    && expected.reverb.unwrap_or_default() == actual.reverb.unwrap_or_default()
            })
        })
    }
    pub(crate) fn validate(&self, output: &OutputConfiguration) -> Result<(), String> {
        if self.version != 1 || self.definitions.clone().validate()? != self.definitions {
            return Err("本番モードの保存形式を確認してください".into());
        }
        for (binding, plugins) in [
            (&self.definitions.profiles.singing, &self.singing_plugins),
            (&self.definitions.profiles.talk, &self.talk_plugins),
        ] {
            match (binding, plugins) {
                (Some(binding), Some(plugins)) if binding.snapshot.is_none() => {
                    validate_plugins(binding, plugins)?
                }
                (None, None) => {}
                _ => return Err("本番モードの参照とVST内容が一致しません".into()),
            }
        }
        for (binding, config) in [
            (
                &self.definitions.profiles.singing,
                &self.definitions.singing,
            ),
            (&self.definitions.profiles.talk, &self.definitions.talk),
        ] {
            if binding.is_some() && config.is_none() {
                return Err("関連VSTに対応する内蔵設定がありません".into());
            }
        }
        if self.monitor.is_some() != output.config.split_processing {
            return Err("自分用処理と出力構成が一致しません".into());
        }
        if let Some(monitor) = &self.monitor {
            monitor.validate().map_err(|e| e.to_string())?;
        }
        if let Some(mode) = self.target {
            self.definitions.config(mode)?;
            let expected = match mode {
                Mode::Singing => &output.config.monitor_singing,
                Mode::Talk => &output.config.monitor_talk,
            };
            if output.config.split_processing
                && self.monitor.as_ref()
                    != expected
                        .as_ref()
                        .map(|config| split_monitor::State {
                            mode,
                            config: config.clone(),
                        })
                        .as_ref()
            {
                return Err("選択中モードと自分用処理が異なります".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn output() -> OutputConfiguration {
        OutputConfiguration {
            version: 1,
            devices: RecoveryDevices {
                input_id: "mic".into(),
                output_id: "monitor".into(),
            },
            config: Default::default(),
        }
    }
    fn sample() -> LiveConfiguration {
        let mut definitions = Definitions {
            singing: Some(Default::default()),
            ..Default::default()
        };
        let plugins = Vec::new();
        definitions.profiles.singing = Some(ProfileBinding {
            name: "通常プロファイル".into(),
            revision: plugin_revision(&plugins).unwrap(),
            snapshot: None,
        });
        LiveConfiguration {
            version: 1,
            definitions,
            target: Some(Mode::Singing),
            monitor: None,
            singing_plugins: Some(plugins),
            talk_plugins: None,
        }
    }
    #[test]
    fn mode_snapshot_validates_empty_binding_selection_and_exact_monitor_state() {
        let value = sample();
        value.validate(&output()).unwrap();
        let mut invalid = value.clone();
        invalid.singing_plugins = None;
        assert!(invalid.validate(&output()).is_err());
        invalid = value.clone();
        invalid
            .definitions
            .profiles
            .singing
            .as_mut()
            .unwrap()
            .revision = "a".repeat(64);
        assert!(invalid.validate(&output()).is_err());
        invalid = value.clone();
        invalid.target = Some(Mode::Talk);
        assert!(invalid.validate(&output()).is_err());
        invalid = value.clone();
        invalid.monitor = Some(split_monitor::State {
            mode: Mode::Singing,
            config: Default::default(),
        });
        assert!(invalid.validate(&output()).is_err());
        let mut split = output();
        split.config.split_processing = true;
        split.config.monitor_singing = Some(Default::default());
        invalid.validate(&split).unwrap();
        invalid.monitor.as_mut().unwrap().config.amount = 0.25;
        assert!(invalid.validate(&split).is_err());
        // カスタム構成は、登録値と異なる実際の本人用処理も保存する。
        invalid.target = None;
        invalid.validate(&split).unwrap();
        let mut original: crate::vst_host::presets::ProfileBuiltinFx = serde_json::from_value(
            serde_json::json!({"preset":"broadcast","enabled":false,"amount":0.7}),
        )
        .unwrap();
        assert!(value.matches_builtin(&original));
        original.amount = 0.2;
        assert!(!value.matches_builtin(&original));
    }
}
