//! OBS の変更確認（`obs_setup`）の説明文。ホストは `UiText`（コードと値）で返すので、`obsTyped.<コード>` の文言へ値を差し込む。
//! く、分からないコード・値の欠けた文言は訳さず、ホストの原文（日本語）を「原文の詳細」として出す。

use std::collections::BTreeMap;

use vst_host_lib::obs_setup::{UiArg, UiText};

use crate::i18n::{text, Lang};

/// 個別の失敗理由を持つコード。訳した要約のあとに原文も出す。
const DETAIL_CODES: [&str; 28] = [
    "obs.plan.unsupported",
    "obs.result.audioConflict",
    "obs.result.valueConflict",
    "obs.result.applyInterrupted",
    "obs.result.applyAudioUnknown",
    "obs.result.applyReadbackUnknown",
    "obs.result.applyWriteUnknown",
    "obs.result.restoreAudioDeferred",
    "obs.result.restoreCollectionConflict",
    "obs.result.restoreCreationDeferred",
    "obs.result.restoreAudioUnknown",
    "obs.result.restoreReadbackUnknown",
    "obs.result.restoreWriteFailed",
    "obs.result.restoreValueConflict",
    "obs.result.applyLateUnknown",
    "obs.result.restoreLateUnknown",
    "bundle.apply.partialUnknown",
    "bundle.apply.incomplete",
    "bundle.apply.captureUnknown",
    "bundle.apply.conditionsChanged",
    "bundle.apply.valuesMismatch",
    "bundle.apply.conditionsChangedAfter",
    "bundle.undo.deferredUnknown",
    "bundle.undo.partialUnknown",
    "bundle.undo.incomplete",
    "bundle.undo.valuesUnknown",
    "bundle.obs.applyUnknown",
    "bundle.reservation.endUnknown",
];

/// 説明文。訳せたら訳した文、訳せなければ原文。原文も出すコードなら後ろに付ける。
pub fn render(lang: Lang, ui: &UiText) -> String {
    match translate(lang, ui) {
        Some(summary) if DETAIL_CODES.contains(&ui.code) => {
            format!("{summary} — {}", original(lang, &ui.fallback_ja))
        }
        Some(summary) => summary,
        None => original(lang, &ui.fallback_ja),
    }
}

/// `UiText` が無い値（古い形）は、表示用の文字列か JSON の値をそのまま出す。
pub fn value(
    lang: Lang,
    ui: Option<&UiText>,
    display: Option<&str>,
    raw: &serde_json::Value,
) -> String {
    if let Some(ui) = ui {
        return render(lang, ui);
    }
    if let Some(display) = display {
        return display.to_string();
    }
    match raw {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => number(n),
        serde_json::Value::Bool(b) => on_off(lang, *b),
        _ => text(lang, "obsTyped.unavailable", &[]).unwrap_or_default(),
    }
}

pub fn original(lang: Lang, fallback: &str) -> String {
    text(lang, "obsTyped.original", &[("value", &fallback)]).unwrap_or_else(|| fallback.into())
}

fn on_off(lang: Lang, value: bool) -> String {
    text(
        lang,
        if value { "obsTyped.on" } else { "obsTyped.off" },
        &[],
    )
    .unwrap_or_default()
}

/// 小数は 3 桁までにして、末尾の 0 は付けない。
fn number(n: &serde_json::Number) -> String {
    let value = n.as_f64().unwrap_or_default();
    let rounded = (value * 1000.0).round() / 1000.0 + 0.0;
    format!("{rounded}")
}

fn translate(lang: Lang, ui: &UiText) -> Option<String> {
    let mut shown: BTreeMap<&str, String> = ui
        .args
        .iter()
        .map(|(key, arg)| {
            let value = match arg {
                UiArg::Text(s) => s.clone(),
                UiArg::Number(n) => number(n),
                UiArg::Bool(b) => on_off(lang, *b),
            };
            (*key, value)
        })
        .collect();
    let arg_text = |key: &str| match ui.args.get(key) {
        Some(UiArg::Text(s)) => Some(s.as_str()),
        _ => None,
    };
    let flag = |key: &str| matches!(ui.args.get(key), Some(UiArg::Bool(true)));
    match ui.code {
        "obs.value.monitor" => {
            let key = match arg_text("mode")? {
                "OBS_MONITORING_TYPE_NONE" => "obsTyped.monitor.none",
                "OBS_MONITORING_TYPE_MONITOR_ONLY" => "obsTyped.monitor.only",
                "OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT" => "obsTyped.monitor.output",
                _ => return None,
            };
            shown.insert("mode", text(lang, key, &[])?);
        }
        "bundle.value.noiseSummary" => {
            let mode = text(lang, &format!("obsTyped.noise.{}", arg_text("mode")?), &[])?;
            shown.insert("mode", mode);
        }
        "bundle.value.builtinSummary" => {
            let preset = text(
                lang,
                &format!("obsTyped.preset.{}", arg_text("preset")?),
                &[],
            )?;
            let detail = |on: bool, key: &str, shown: &BTreeMap<&str, String>| {
                if !on {
                    return Some(String::new());
                }
                fill(lang, key, shown)
            };
            let singing = detail(flag("hasSinging"), "obsTyped.singingDetails", &shown)?;
            let reverb = detail(flag("hasReverb"), "obsTyped.reverbDetails", &shown)?;
            shown.insert("preset", preset);
            shown.insert("singingDetails", singing);
            shown.insert("reverbDetails", reverb);
        }
        _ => {}
    }
    fill(lang, &format!("obsTyped.{}", ui.code), &shown)
}

/// 文言に値を差し込む。差し込めなかった `{名前}` が残ったら、値が欠けているので訳さない。
fn fill(lang: Lang, key: &str, shown: &BTreeMap<&str, String>) -> Option<String> {
    let args: Vec<(&str, &dyn std::fmt::Display)> = shown
        .iter()
        .map(|(key, value)| (*key, value as &dyn std::fmt::Display))
        .collect();
    let template = text(lang, key, &[])?;
    let missing = template.split('{').skip(1).any(|rest| {
        rest.split_once('}').is_some_and(|(name, _)| {
            !name.is_empty()
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !shown.contains_key(name)
        })
    });
    if missing {
        return None;
    }
    text(lang, key, &args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ui(code: &'static str, args: &[(&'static str, UiArg)]) -> UiText {
        UiText {
            code,
            args: args.iter().cloned().collect(),
            fallback_ja: "原文".into(),
        }
    }

    #[test]
    fn known_codes_are_translated_and_values_filled() {
        let filter = ui(
            "obs.field.filterEnabled",
            &[("filter", UiArg::Text("Gate".into()))],
        );
        assert!(render(Lang::En, &filter).contains("Gate"));
        let monitor = ui(
            "obs.value.monitor",
            &[(
                "mode",
                UiArg::Text("OBS_MONITORING_TYPE_MONITOR_ONLY".into()),
            )],
        );
        assert_eq!(render(Lang::Ja, &monitor), "モニターのみ");
        let ms = ui(
            "obs.value.milliseconds",
            &[(
                "value",
                UiArg::Number(serde_json::Number::from_f64(12.34567).unwrap()),
            )],
        );
        assert_eq!(render(Lang::Ja, &ms), "12.346 ms");
        let braces = ui(
            "obs.field.filterEnabled",
            &[("filter", UiArg::Text("{Gate}".into()))],
        );
        let shown = render(Lang::Ja, &braces);
        assert!(shown.contains("{Gate}") && !shown.contains("原文"));
        let tiny = ui(
            "obs.value.milliseconds",
            &[(
                "value",
                UiArg::Number(serde_json::Number::from_f64(-0.0004).unwrap()),
            )],
        );
        assert_eq!(render(Lang::Ja, &tiny), "0 ms");
    }

    #[test]
    fn unknown_codes_or_missing_values_show_the_original() {
        let unknown = ui("obs.no.such", &[]);
        assert!(render(Lang::Ja, &unknown).contains("原文"));
        let missing = ui("obs.field.filterEnabled", &[]);
        assert!(render(Lang::Ja, &missing).contains("原文"));
        let detail = ui("obs.result.valueConflict", &[]);
        let shown = render(Lang::Ja, &detail);
        assert!(shown.starts_with("現在値が変わりました") && shown.contains("原文"));
    }
}
