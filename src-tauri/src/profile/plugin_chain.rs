//! VSTチェーンの復元。設定まで成功したインスタンスだけを適用結果へ含める。
use crate::audio::AudioHost;
use crate::vst_host::presets::{LoadedPluginInstance, MissingPlugin, PresetPlugin};

pub(super) enum Setting<'a> {
    Bypass,
    Mute,
    Gain(f32),
    State(&'a str),
}

// IPC境界を狭く保ち、実VSTなしでも途中失敗と後片付けを検証できるようにする。
pub(super) trait ChainHost {
    fn load(&mut self, path: &str) -> Result<String, String>;
    fn configure(&mut self, id: &str, setting: Setting<'_>) -> Result<(), String>;
    fn unload(&mut self, id: &str) -> Result<(), String>;
}

impl ChainHost for AudioHost {
    fn load(&mut self, path: &str) -> Result<String, String> {
        self.load_plugin(path).map_err(|e| e.to_string())
    }
    fn configure(&mut self, id: &str, setting: Setting<'_>) -> Result<(), String> {
        match setting {
            Setting::Bypass => self.set_bypass(id, true),
            Setting::Mute => self.set_mute(id, true),
            Setting::Gain(gain) => self.set_gain(id, gain),
            Setting::State(state) => self.set_plugin_state(id, state),
        }
        .map_err(|e| e.to_string())
    }
    fn unload(&mut self, id: &str) -> Result<(), String> {
        self.remove_plugin(id).map_err(|e| e.to_string())
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
        let Ok(id) = host.load(&plugin.path) else {
            missing.push(unavailable());
            continue;
        };
        let applied = (|| -> Result<(), String> {
            if !plugin.enabled {
                host.configure(&id, Setting::Bypass)?;
            }
            if plugin.muted {
                host.configure(&id, Setting::Mute)?;
            }
            if (plugin.gain - 1.0).abs() > f32::EPSILON {
                host.configure(&id, Setting::Gain(plugin.gain))?;
            }
            if let Some(state) = &plugin.state {
                host.configure(&id, Setting::State(state))?;
            }
            Ok(())
        })();
        if applied.is_err() {
            // 不完全な設定のVSTを、成功したラック構成として返さない。
            host.unload(&id).map_err(|error| {
                format!(
                    "{} の設定適用と後片付けに失敗しました: {error}",
                    plugin.name
                )
            })?;
            missing.push(unavailable());
            continue;
        }
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
        fail: &'static str,
        calls: Vec<String>,
    }
    impl ChainHost for Host {
        fn load(&mut self, path: &str) -> Result<String, String> {
            self.calls.push(path.into());
            Ok(path.into())
        }
        fn configure(&mut self, _: &str, setting: Setting<'_>) -> Result<(), String> {
            let step = match setting {
                Setting::Bypass => "bypass",
                Setting::Mute => "mute",
                Setting::Gain(_) => "gain",
                Setting::State(_) => "state",
            };
            self.calls.push(step.into());
            if self.fail == step {
                Err("failed".into())
            } else {
                Ok(())
            }
        }
        fn unload(&mut self, id: &str) -> Result<(), String> {
            self.calls.push(format!("unload:{id}"));
            Ok(())
        }
    }
    #[test]
    fn failed_settings_unload_the_instance_and_are_never_reported_as_applied() {
        let plugin = PresetPlugin {
            path: "plugin".into(),
            name: "Plugin".into(),
            vendor: "".into(),
            version: "".into(),
            enabled: false,
            muted: true,
            gain: 0.5,
            state: Some("saved".into()),
        };
        for fail in ["bypass", "mute", "gain", "state"] {
            let mut host = Host {
                fail,
                calls: Vec::new(),
            };
            let (loaded, missing) =
                load_plugin_chain(&mut host, std::slice::from_ref(&plugin)).unwrap();
            assert!(loaded.is_empty());
            assert_eq!(missing.len(), 1);
            assert_eq!(host.calls.last().unwrap(), "unload:plugin");
        }
        let mut host = Host {
            fail: "",
            calls: Vec::new(),
        };
        let (loaded, missing) = load_plugin_chain(&mut host, &[plugin]).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(missing.is_empty());
        assert_eq!(host.calls, ["plugin", "bypass", "mute", "gain", "state"]);
    }
}
