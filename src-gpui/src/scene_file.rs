//! シーンの連動の保存。GPUI 版は自分のファイル（`gpui_scene_routing.json`）に書く
//! （Tauri 版は画面（WebView）の中に保存していて読めない）。

use std::path::Path;

use auralyn_ui_model::scene_routing::{mode_from_key, mode_key, Routing, Strategy};

const FILE: &str = "gpui_scene_routing.json";

pub fn load(config_dir: &Path) -> Routing {
    std::fs::read_to_string(config_dir.join(FILE))
        .ok()
        .and_then(|text| parse(&text))
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, routing: &Routing) -> std::io::Result<()> {
    crate::store::write_atomic(
        &config_dir.join(FILE),
        to_json(routing).to_string().as_bytes(),
    )
}

fn to_json(routing: &Routing) -> serde_json::Value {
    let scenes: Vec<serde_json::Value> = routing
        .scenes
        .iter()
        .map(|(scene, mode)| serde_json::json!({ "scene": scene, "mode": mode_key(*mode) }))
        .collect();
    serde_json::json!({
        "version": 1,
        "strategy": routing.strategy.key(),
        "enabled": routing.enabled,
        "scenes": scenes,
    })
}

/// 読めない・壊れたファイルは連動なしとして扱う（勝手に切り替えない）。
fn parse(text: &str) -> Option<Routing> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("version")?.as_u64()? != 1 {
        return None;
    }
    let strategy = Strategy::from_key(value.get("strategy")?.as_str()?)?;
    let enabled = value.get("enabled")?.as_bool()?;
    let rows = value
        .get("scenes")?
        .as_array()?
        .iter()
        .map(|row| {
            Some((
                row.get("scene")?.as_str()?.to_string(),
                mode_from_key(row.get("mode")?.as_str()?)?,
            ))
        })
        .collect::<Option<Vec<_>>>()?;
    Routing::checked(strategy, enabled, &rows).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_it_writes_and_refuses_broken_files() {
        use auralyn_ui_model::live_modes::Mode;
        let routing = Routing::checked(
            Strategy::Mode,
            true,
            &[("歌".into(), Mode::Singing), ("雑談".into(), Mode::Talk)],
        )
        .unwrap();
        assert_eq!(parse(&to_json(&routing).to_string()), Some(routing));
        assert_eq!(parse("{"), None);
        assert_eq!(
            parse(
                r#"{"version":1,"strategy":"mode","enabled":true,"scenes":[{"scene":"a","mode":"loud"}]}"#
            ),
            None
        );
        assert_eq!(
            parse(
                r#"{"version":1,"strategy":"mode","enabled":true,"scenes":[{"scene":"a","mode":"talk"},{"scene":"a","mode":"talk"}]}"#
            ),
            None
        );
    }
}
