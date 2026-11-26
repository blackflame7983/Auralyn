//! 使い道（声・音楽）ごとに、最後に始めた接続を残す（Tauri 版の `usageDevices`）。
//! GPUI 版は自分のファイル（`gpui_usage_devices.json`）に書く（Tauri 版は画面（WebView）の中に保存していて読めない）。

use std::path::Path;

use vst_host_lib::audio::ActiveAudioConfig;
use vst_host_lib::input_source::{Config as InputSource, Purpose};

const FILE: &str = "gpui_usage_devices.json";

fn key(purpose: Purpose) -> &'static str {
    match purpose {
        Purpose::Voice => "voice",
        Purpose::Music => "music",
    }
}

pub fn purpose_of(config: &ActiveAudioConfig) -> Purpose {
    match &config.input_source {
        Some(InputSource::Device { purpose }) => *purpose,
        Some(InputSource::ProcessLoopback(app)) => app.purpose,
        None => Purpose::Voice,
    }
}

/// まだ無ければ空。読めなければ `Err`（上書きして、もう一方の記録を消さないように）。
fn read(config_dir: &Path) -> anyhow::Result<serde_json::Map<String, serde_json::Value>> {
    match std::fs::read_to_string(config_dir.join(FILE)) {
        Ok(text) => Ok(serde_json::from_str(&text)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(e) => Err(e.into()),
    }
}

/// 残した接続。読めないものは飛ばす。
pub fn load(config_dir: &Path) -> Vec<ActiveAudioConfig> {
    read(config_dir).map(parse).unwrap_or_default()
}

fn parse(map: serde_json::Map<String, serde_json::Value>) -> Vec<ActiveAudioConfig> {
    [Purpose::Voice, Purpose::Music]
        .into_iter()
        .filter_map(|purpose| {
            let config: ActiveAudioConfig =
                serde_json::from_value(map.get(key(purpose))?.clone()).ok()?;
            (purpose_of(&config) == purpose && !config.host.trim().is_empty()).then_some(config)
        })
        .collect()
}

/// 始められた接続を、その入力の使い道の記録として残す。
pub fn remember(config_dir: &Path, config: &ActiveAudioConfig) -> anyhow::Result<()> {
    let mut map = read(config_dir)?;
    map.insert(
        key(purpose_of(config)).into(),
        serde_json::to_value(config)?,
    );
    crate::store::write_atomic(
        &config_dir.join(FILE),
        serde_json::Value::Object(map).to_string().as_bytes(),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(host: &str, purpose: Purpose) -> ActiveAudioConfig {
        ActiveAudioConfig {
            host: host.into(),
            input_source: Some(InputSource::Device { purpose }),
            ..ActiveAudioConfig::default()
        }
    }

    #[test]
    fn records_are_kept_per_purpose_and_mismatches_are_skipped() {
        let mut map = serde_json::Map::new();
        map.insert(
            "voice".into(),
            serde_json::to_value(config("WASAPI", Purpose::Voice)).unwrap(),
        );
        map.insert(
            "music".into(),
            serde_json::to_value(config("ASIO", Purpose::Voice)).unwrap(),
        );
        let records = parse(map);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].host, "WASAPI");
        assert!(parse(serde_json::Map::new()).is_empty());
    }
}
