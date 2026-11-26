//! 「接続の確認」の利用場所・入力の種類・送り先の保存。GPUI 版は自分のファイル（`gpui_preparation.json`）に書く
//! （Tauri 版は画面（WebView）の中に保存していて読めない）。確認の記録は保存しない（このセッションだけ）。

use std::path::Path;

use auralyn_ui_model::preparation::{normalize_receiver, Context, Location, Signal, Usage};

const FILE: &str = "gpui_preparation.json";

pub fn load(config_dir: &Path) -> Context {
    std::fs::read_to_string(config_dir.join(FILE))
        .ok()
        .and_then(|text| parse(&text))
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, context: &Context) -> std::io::Result<()> {
    crate::store::write_atomic(
        &config_dir.join(FILE),
        to_json(context).to_string().as_bytes(),
    )
}

fn usage_key(usage: Usage) -> &'static str {
    match usage {
        Usage::Obs => "obs",
        Usage::Discord => "discord",
        Usage::Other => "other",
        Usage::Listening => "listening",
    }
}

fn to_json(context: &Context) -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "location": match context.location { Location::Home => "home", Location::Venue => "venue" },
        "signal": match context.signal {
            Signal::Unknown => "unknown",
            Signal::Separate => "separate",
            Signal::Mixed => "mixed",
        },
        "usage": context.usage.map(usage_key),
        "receiver": context.receiver,
    })
}

/// 知らない値は既定にする（Tauri 版と同じ）。
fn parse(text: &str) -> Option<Context> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("version")?.as_u64()? != 1 {
        return None;
    }
    let text = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or_default();
    let usage = [Usage::Obs, Usage::Discord, Usage::Other, Usage::Listening]
        .into_iter()
        .find(|usage| usage_key(*usage) == text("usage"));
    Some(Context {
        location: if text("location") == "venue" {
            Location::Venue
        } else {
            Location::Home
        },
        signal: match text("signal") {
            "separate" => Signal::Separate,
            "mixed" => Signal::Mixed,
            _ => Signal::Unknown,
        },
        usage,
        receiver: normalize_receiver(text("receiver")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_context_reads_back_and_unknown_values_fall_back() {
        let context = Context {
            location: Location::Venue,
            signal: Signal::Mixed,
            usage: Some(Usage::Discord),
            receiver: "マイク".into(),
        };
        assert_eq!(parse(&to_json(&context).to_string()), Some(context));
        let odd = parse(r#"{"version":1,"location":"moon","usage":"tv"}"#).unwrap();
        assert_eq!(odd, Context::default());
        assert_eq!(parse(r#"{"version":2}"#), None);
    }
}
