//! VSTチェーンの復元。設定まで成功したインスタンスだけを適用結果へ含める。
use crate::audio::AudioHost;
use crate::vst_host::presets::{LoadedPluginInstance, MissingPlugin, PresetPlugin};

// 原子的な復元だけを使い、初期設定の未適用期間を作らない。
pub(super) trait ChainHost {
    fn restore(&mut self, plugin: &PresetPlugin) -> Result<String, String>;
}

impl ChainHost for AudioHost {
    fn restore(&mut self, plugin: &PresetPlugin) -> Result<String, String> {
        self.restore_plugin(crate::ipc::RestorePluginRequest {
            path: plugin.path.clone(),
            state: plugin.state.clone(),
            bypassed: !plugin.enabled,
            muted: plugin.muted,
            gain: plugin.gain,
        })
        .map(|restored| restored.id)
        .map_err(|error| error.to_string())
    }
}

pub(super) fn load_plugin_chain(
    host: &mut impl ChainHost,
    chain: &[PresetPlugin],
) -> Result<(Vec<LoadedPluginInstance>, Vec<MissingPlugin>), String> {
    let mut loaded = Vec::new();
    let mut missing = Vec::new();
    for plugin in chain {
        let unavailable = || MissingPlugin {
            name: plugin.name.clone(),
            path: plugin.path.clone(),
        };
        let Ok(id) = host.restore(plugin) else {
            missing.push(unavailable());
            continue;
        };
        loaded.push(LoadedPluginInstance {
            id,
            path: plugin.path.clone(),
            name: plugin.name.clone(),
            vendor: plugin.vendor.clone(),
            version: plugin.version.clone(),
            enabled: plugin.enabled,
            muted: plugin.muted,
            gain: plugin.gain,
        });
    }
    Ok((loaded, missing))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Host {
        fail: bool,
        requests: Vec<PresetPlugin>,
    }
    impl ChainHost for Host {
        fn restore(&mut self, plugin: &PresetPlugin) -> Result<String, String> {
            self.requests.push(plugin.clone());
            if self.fail {
                Err("state/prepare failed; backend cleaned up".into())
            } else {
                Ok("restored-id".into())
            }
        }
    }
    #[test]
    fn restoration_sends_complete_initial_state_once_and_partial_failure_is_missing() {
        let plugin = PresetPlugin {
            path: "plugin".into(),
            name: "Plugin".into(),
            vendor: "".into(),
            version: "".into(),
            enabled: false,
            muted: true,
            gain: 0.5,
            state: Some(String::new()),
        };
        for fail in [false, true] {
            let mut host = Host {
                fail,
                requests: vec![],
            };
            let (loaded, missing) =
                load_plugin_chain(&mut host, std::slice::from_ref(&plugin)).unwrap();
            assert_eq!(host.requests.len(), 1);
            let request = &host.requests[0];
            assert!(!request.enabled && request.muted);
            assert_eq!(request.gain, 0.5);
            assert_eq!(request.state.as_deref(), Some(""));
            assert_eq!(loaded.len(), usize::from(!fail));
            assert_eq!(missing.len(), usize::from(fail));
        }
    }
}
