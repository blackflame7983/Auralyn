//! ミックス設定と配信ミックス後ラックの保存内容。
use crate::vst_host::presets::PresetPlugin;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MixingConfiguration {
    pub version: u8,
    pub input: Option<crate::audio_engine::mixing::Config>,
    pub post_mix: PostMixPreset,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PostMixPreset {
    pub schema_version: u32,
    pub role: String,
    pub enabled: bool,
    pub plugins: Vec<PresetPlugin>,
}
impl MixingConfiguration {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version != 1 || (self.post_mix.enabled && self.input.is_none()) {
            return Err("ミックス設定の保存形式を確認してください".into());
        }
        if let Some(input) = &self.input {
            input.validate()?;
        }
        self.post_mix.validate()
    }
}
impl PostMixPreset {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || self.role != "post_mix"
            || self.plugins.len() > crate::audio_engine::plugins::MAX_PLUGINS
        {
            return Err("ミックス後VSTの保存形式を確認してください".into());
        }
        for plugin in &self.plugins {
            crate::ipc::RestorePluginRequest {
                path: plugin.path.clone(),
                state: plugin.state.clone(),
                bypassed: !plugin.enabled,
                muted: plugin.muted,
                gain: plugin.gain,
                class_id: plugin.class_id.clone(),
            }
            .validate()?;
            if plugin.gain > 2.0 {
                return Err("ミックス後VSTのゲインが不正です".into());
            }
        }
        Ok(())
    }
}
