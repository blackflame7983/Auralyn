//! VSTチェーンの復元。設定まで成功したインスタンスだけを適用結果へ含める。
use crate::audio::AudioHost;
use crate::vst_host::presets::{LoadedPluginInstance, MissingPlugin, PresetPlugin};

/// 復元で実際に開いたインスタンス。要求した CID ではなく、応答の CID を画面へ返す。
pub(super) struct OpenedChainPlugin {
    id: String,
    class_id: Option<String>,
}

// 原子的な復元だけを使い、初期設定の未適用期間を作らない。
pub(super) trait ChainHost {
    fn restore(&mut self, plugin: &PresetPlugin) -> Result<OpenedChainPlugin, String>;
}

impl ChainHost for AudioHost {
    fn restore(&mut self, plugin: &PresetPlugin) -> Result<OpenedChainPlugin, String> {
        self.restore_plugin(crate::ipc::RestorePluginRequest {
            path: plugin.path.clone(),
            state: plugin.state.clone(),
            bypassed: !plugin.enabled,
            muted: plugin.muted,
            gain: plugin.gain,
            class_id: plugin.class_id.clone(),
        })
        .map(|restored| OpenedChainPlugin {
            id: restored.id,
            class_id: restored.class_id,
        })
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
        let Ok(opened) = host.restore(plugin) else {
            missing.push(unavailable());
            continue;
        };
        loaded.push(LoadedPluginInstance {
            id: opened.id,
            path: plugin.path.clone(),
            name: plugin.name.clone(),
            vendor: plugin.vendor.clone(),
            version: plugin.version.clone(),
            enabled: plugin.enabled,
            muted: plugin.muted,
            gain: plugin.gain,
            class_id: opened.class_id,
        });
    }
    Ok((loaded, missing))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Host {
        fail: bool,
        opened_class_id: Option<String>,
        requests: Vec<PresetPlugin>,
    }
    impl ChainHost for Host {
        fn restore(&mut self, plugin: &PresetPlugin) -> Result<OpenedChainPlugin, String> {
            self.requests.push(plugin.clone());
            if self.fail {
                Err("state/prepare failed; backend cleaned up".into())
            } else {
                Ok(OpenedChainPlugin {
                    id: "restored-id".into(),
                    class_id: self.opened_class_id.clone(),
                })
            }
        }
    }
    fn plugin(class_id: Option<&str>) -> PresetPlugin {
        PresetPlugin {
            path: "plugin".into(),
            name: "Plugin".into(),
            vendor: "".into(),
            version: "".into(),
            enabled: false,
            muted: true,
            gain: 0.5,
            state: Some(String::new()),
            class_id: class_id.map(str::to_string),
        }
    }
    #[test]
    fn restoration_sends_complete_initial_state_once_and_partial_failure_is_missing() {
        let plugin = plugin(None);
        for fail in [false, true] {
            let mut host = Host {
                fail,
                opened_class_id: None,
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

    #[test]
    fn restoration_keeps_the_opened_class_id_instead_of_dropping_it() {
        let requested = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let opened = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
        let plugin = plugin(Some(requested));
        let mut host = Host {
            fail: false,
            opened_class_id: Some(opened.into()),
            requests: vec![],
        };
        let (loaded, missing) =
            load_plugin_chain(&mut host, std::slice::from_ref(&plugin)).unwrap();
        assert!(missing.is_empty());
        assert_eq!(host.requests[0].class_id.as_deref(), Some(requested));
        assert_eq!(loaded[0].class_id.as_deref(), Some(opened));
        let mut legacy = plugin;
        legacy.class_id = None;
        let mut host = Host {
            fail: false,
            opened_class_id: Some(opened.into()),
            requests: vec![],
        };
        let (loaded, _) = load_plugin_chain(&mut host, std::slice::from_ref(&legacy)).unwrap();
        assert!(host.requests[0].class_id.is_none());
        assert_eq!(loaded[0].class_id.as_deref(), Some(opened));
    }
}
