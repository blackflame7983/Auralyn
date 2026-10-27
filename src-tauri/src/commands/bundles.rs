//! 配信状態の所有予約・原本・OBS差分を一つの操作へ結び付ける。
use crate::audio::conditions::ControlWitness;
use crate::obs_setup::UiText;
use crate::{
    audio,
    bundle::{self, BundleV1, EngineCapture},
    obs, obs_setup, profile,
    vst_host::presets::*,
};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub(crate) struct BundleState(tokio::sync::Mutex<Session>);
#[derive(Default)]
struct Session {
    preview: Option<Preview>,
    history: Option<Operation>,
}
struct Preview {
    id: String,
    bundle: BundleV1,
    before: Captured,
    witness: ControlWitness,
    obs: Option<obs_setup::Plan>,
}
struct Operation {
    id: String,
    backup: BundleV1,
    after: Option<Captured>,
    witness: Option<ControlWitness>,
    obs_id: Option<u64>,
    result: ResultView,
    was_running: bool,
}
#[derive(Clone)]
struct Captured {
    engine: EngineCapture,
    preset: Preset,
    active: Option<audio::ActiveAudioConfig>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewView {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub categories: Vec<String>,
    pub obs: Vec<obs_setup::Change>,
    pub running: bool,
    pub auralyn: Vec<DiffRow>,
    pub confirmation: Option<bundle::Confirmation>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiffRow {
    label: String,
    status: String,
    before: String,
    after: String,
    field_code: Option<&'static str>,
    label_text: Option<UiText>,
    before_text: Option<UiText>,
    after_text: Option<UiText>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResultView {
    pub id: String,
    pub complete: bool,
    pub undo_pending: bool,
    pub auralyn: String,
    pub obs: Vec<String>,
    pub auralyn_text: Option<UiText>,
    pub obs_texts: Option<Vec<UiText>>,
    pub summary: Option<SummaryDto>,
    pub current: Option<SummaryDto>,
}
impl ResultView {
    fn set_auralyn(&mut self, code: &'static str, fallback: impl Into<String>) {
        let text = UiText::new(code, fallback);
        self.auralyn = text.fallback_ja.clone();
        self.auralyn_text = Some(text);
    }
    fn set_obs_history(&mut self, history: &obs_setup::History) {
        self.obs = history.results.clone();
        self.obs_texts = history
            .result_entries
            .as_ref()
            .filter(|entries| entries.len() == history.results.len())
            .map(|entries| entries.iter().map(|entry| entry.text.clone()).collect());
    }
    fn set_obs_unknown(&mut self, fallback: impl Into<String>) {
        let text = UiText::new("bundle.obs.applyUnknown", fallback);
        self.obs = vec![text.fallback_ja.clone()];
        self.obs_texts = Some(vec![text]);
    }
}
/// UI同期に必要な制御値だけ。opaque VST stateを持つPresetPluginを含めない。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummaryDto {
    applied_categories: Vec<String>,
    skipped_categories: Vec<String>,
    missing_devices: Vec<MissingDevice>,
    missing_plugins: Vec<MissingPlugin>,
    needs_engine_restart: bool,
    applied_audio_config: Option<ProfileAudioConfig>,
    applied_noise_control: Option<ProfileNoiseControl>,
    applied_builtin_fx: Option<ProfileBuiltinFx>,
    loaded_plugin_instances: Vec<LoadedPluginInstance>,
}
impl From<ApplyProfileSummary> for SummaryDto {
    fn from(s: ApplyProfileSummary) -> Self {
        Self {
            applied_categories: s.applied_categories,
            skipped_categories: s.skipped_categories,
            missing_devices: s.missing_devices,
            missing_plugins: s.missing_plugins,
            needs_engine_restart: s.needs_engine_restart,
            applied_audio_config: s.applied_audio_config,
            applied_noise_control: s.applied_noise_control,
            applied_builtin_fx: s.applied_builtin_fx,
            loaded_plugin_instances: s.loaded_plugin_instances,
        }
    }
}
fn current_dto(captured: &Captured) -> SummaryDto {
    ApplyProfileSummary {
        applied_categories: vec!["plugins".into()],
        loaded_plugin_instances: captured
            .engine
            .plugins
            .iter()
            .map(|p| LoadedPluginInstance {
                id: p.id.clone(),
                path: p.plugin.path.clone(),
                name: p.plugin.name.clone(),
                vendor: p.plugin.vendor.clone(),
                version: p.plugin.version.clone(),
                enabled: p.plugin.enabled,
                muted: p.plugin.muted,
                gain: p.plugin.gain,
            })
            .collect(),
        ..Default::default()
    }
    .into()
}
#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    List,
    CheckedList,
    Sources,
    Filters {
        source: String,
    },
    Save {
        name: String,
        #[serde(default)]
        overwrite: bool,
        categories: ProfileSaveCategories,
        obs: Option<Vec<obs_setup::bundle::Selection>>,
        #[serde(default)]
        checked: Option<Box<CheckedClaim>>,
    },
    Preview {
        name: String,
    },
    Apply {
        id: String,
    },
    Undo {
        id: String,
    },
    History,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CheckedClaim {
    pub expected: crate::ipc::PreparationSnapshot,
    pub usage: String,
    pub location: String,
}
fn validate_checked_conditions(
    running: bool,
    actual: Option<&crate::ipc::PreparationSnapshot>,
    expected: &crate::ipc::PreparationSnapshot,
) -> Result<(), String> {
    if !running
        || actual != Some(expected)
        || expected.controls_pending
        || expected.muted
        || expected.output_gain == 0.0
    {
        return Err("音声処理が停止・不明・反映待ち、または確認後に条件が変わりました。音を確認し直してください".into());
    }
    Ok(())
}
async fn validate_checked(
    host: Arc<Mutex<audio::AudioHost>>,
    claim: &CheckedClaim,
) -> Result<(), String> {
    let expected = claim.expected.clone();
    super::run_blocking(move || {
        let mut host = host.lock().map_err(|_| "音声状態を取得できません")?;
        host.preflight_live_changes().map_err(|e| e.to_string())?;
        let stats = host.get_engine_runtime_stats().map_err(|e| e.to_string())?;
        validate_checked_conditions(
            stats
                .latency_metadata
                .as_ref()
                .is_some_and(|m| m.stream_running),
            stats.preparation.as_deref(),
            &expected,
        )?;
        host.checked_snapshot_supported()
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}
#[derive(Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub(crate) enum Response {
    Names(Vec<String>),
    Filters(Vec<obs_setup::bundle::FilterChoice>),
    Saved,
    Preview(Box<PreviewView>),
    Result(Option<Box<ResultView>>),
}

fn category_names(c: &ProfileSaveCategories) -> Vec<String> {
    [
        (c.include_plugins, "VST構成"),
        (c.include_audio_config, "入出力・音量"),
        (c.include_noise_control, "ノイズ低減"),
        (c.include_builtin_fx, "内蔵処理"),
    ]
    .into_iter()
    .filter(|(on, _)| *on)
    .map(|(_, name)| name.into())
    .collect()
}
#[derive(Clone, Copy)]
enum DiffField {
    Host,
    InputDevice,
    OutputDevice,
    Rate,
    Buffer,
    Channels,
    InputGain,
    OutputGain,
    Noise,
    Builtin,
    VstOrder,
    VstSettings(usize),
    VstState(usize),
    GlobalMute,
    GlobalBypass,
}
impl DiffField {
    fn code(self) -> &'static str {
        match self {
            Self::Host => "bundle.field.host",
            Self::InputDevice => "bundle.field.inputDevice",
            Self::OutputDevice => "bundle.field.outputDevice",
            Self::Rate => "bundle.field.sampleRate",
            Self::Buffer => "bundle.field.buffer",
            Self::Channels => "bundle.field.channels",
            Self::InputGain => "bundle.field.inputGain",
            Self::OutputGain => "bundle.field.outputGain",
            Self::Noise => "bundle.field.noise",
            Self::Builtin => "bundle.field.builtin",
            Self::VstOrder => "bundle.field.vstOrder",
            Self::VstSettings(_) => "bundle.field.vstSettings",
            Self::VstState(_) => "bundle.field.vstState",
            Self::GlobalMute => "bundle.field.globalMute",
            Self::GlobalBypass => "bundle.field.globalBypass",
        }
    }
}
fn raw_text(value: &str, fallback: &str) -> UiText {
    UiText::new("bundle.value.raw", fallback).text("value", value)
}
fn device_text(value: &Option<String>, fallback: &str) -> UiText {
    match value {
        Some(value) => raw_text(value, fallback),
        None => UiText::new("bundle.value.defaultDevice", fallback),
    }
}
fn noise_text(value: &ProfileNoiseControl, fallback: &str) -> UiText {
    UiText::new("bundle.value.noiseSummary", fallback)
        .boolean("enabled", value.enabled)
        .text("mode", value.mode.clone())
        .number("strength", value.strength as f64)
        .boolean("voiceGuard", value.voice_guard)
}
fn builtin_text(value: &ProfileBuiltinFx, fallback: &str) -> UiText {
    // 既存の表示要約に必要なscalarだけ。設定JSONやVST stateは受け取らない。
    let mut text = UiText::new("bundle.value.builtinSummary", fallback)
        .boolean("voiceEnabled", value.enabled)
        .text("preset", value.preset.clone())
        .number("amount", value.amount as f64)
        .boolean("hasSinging", value.singing.is_some())
        .boolean("hasReverb", value.reverb.is_some());
    if let Some(v) = value.singing {
        text = text
            .number("lowCutHz", v.low_cut_hz as f64)
            .number("dynamics", v.dynamics as f64)
            .number("brightnessDb", v.brightness_db as f64);
    }
    if let Some(v) = value.reverb {
        text = text
            .boolean("reverbEnabled", v.enabled)
            .number("mix", v.mix as f64)
            .number("decaySeconds", v.decay_seconds as f64)
            .number("damping", v.damping as f64);
    }
    text
}
fn plugin_text(value: &PresetPlugin, fallback: &str) -> UiText {
    UiText::new("bundle.value.vstSettings", fallback)
        .text("name", value.name.clone())
        .boolean("enabled", value.enabled)
        .boolean("muted", value.muted)
        .number("gainPercent", value.gain as f64 * 100.)
}
fn chain_text<'a>(names: impl Iterator<Item = &'a str>, fallback: &str) -> UiText {
    let names = names.collect::<Vec<_>>();
    if names.is_empty() {
        UiText::new("bundle.value.noVst", fallback)
    } else {
        UiText::new("bundle.value.vstChain", fallback).text("names", names.join(" → "))
    }
}
fn diff_value_texts(
    field: DiffField,
    before: &Captured,
    bundle: &BundleV1,
    old: &str,
    new: &str,
) -> (Option<UiText>, Option<UiText>) {
    let preset = &bundle.embedded_auralyn_preset;
    let audio = preset.audio_config.as_ref();
    match field {
        DiffField::Host => (
            before.active.as_ref().map(|v| raw_text(&v.host, old)),
            audio.map(|v| raw_text(&v.host, new)),
        ),
        DiffField::InputDevice => (
            before.active.as_ref().map(|v| device_text(&v.input, old)),
            audio.map(|v| device_text(&v.input_device, new)),
        ),
        DiffField::OutputDevice => (
            before.active.as_ref().map(|v| device_text(&v.output, old)),
            audio.map(|v| device_text(&v.output_device, new)),
        ),
        DiffField::Rate => (
            before
                .active
                .as_ref()
                .and_then(|v| v.sample_rate)
                .map(|v| UiText::new("bundle.value.hertz", old).number("value", v as f64)),
            audio.map(|v| {
                UiText::new("bundle.value.hertz", new).number("value", v.sample_rate as f64)
            }),
        ),
        DiffField::Buffer => (
            before
                .engine
                .fixed_buffer_request_frames
                .map(|v| UiText::new("bundle.value.frames", old).number("value", v as f64)),
            audio.map(|v| {
                UiText::new("bundle.value.frames", new).number("value", v.buffer_size as f64)
            }),
        ),
        DiffField::Channels => (
            Some(
                UiText::new("bundle.value.zeroBasedChannels", old)
                    .text("channels", format!("{:?}", before.engine.input_channels)),
            ),
            audio.map(|v| {
                UiText::new("bundle.value.zeroBasedChannels", new)
                    .text("channels", format!("{:?}", v.input_channels))
            }),
        ),
        DiffField::InputGain | DiffField::OutputGain => {
            let (old_value, new_value) = if matches!(field, DiffField::InputGain) {
                (
                    before.engine.input_gain,
                    bundle.level_intent.as_ref().map(|v| v.input_gain),
                )
            } else {
                (
                    before.engine.output_gain,
                    bundle.level_intent.as_ref().map(|v| v.output_gain),
                )
            };
            (
                Some(
                    UiText::new("bundle.value.percent", old)
                        .number("value", old_value as f64 * 100.),
                ),
                new_value.map(|v| {
                    UiText::new("bundle.value.percent", new).number("value", v as f64 * 100.)
                }),
            )
        }
        DiffField::Noise => (
            Some(noise_text(&before.engine.noise, old)),
            preset.noise_control.as_ref().map(|v| noise_text(v, new)),
        ),
        DiffField::Builtin => (
            Some(builtin_text(&before.engine.builtin, old)),
            preset.builtin_fx.as_ref().map(|v| builtin_text(v, new)),
        ),
        DiffField::VstOrder => (
            Some(chain_text(
                before.engine.plugins.iter().map(|v| v.plugin.name.as_str()),
                old,
            )),
            Some(chain_text(
                preset.plugins.iter().map(|v| v.name.as_str()),
                new,
            )),
        ),
        DiffField::VstSettings(index) => (
            before
                .engine
                .plugins
                .get(index)
                .map(|v| plugin_text(&v.plugin, old)),
            preset.plugins.get(index).map(|v| plugin_text(v, new)),
        ),
        DiffField::VstState(index) => {
            let old_plugin = before.engine.plugins.get(index).map(|v| &v.plugin);
            let same = old_plugin
                .zip(preset.plugins.get(index))
                .is_some_and(|(a, b)| a.path == b.path && a.state == b.state);
            (
                old_plugin.map(|_| UiText::new("bundle.value.vstStateCaptured", old)),
                Some(UiText::new(
                    if same {
                        "bundle.value.vstStateCaptured"
                    } else {
                        "bundle.value.vstStateChanged"
                    },
                    new,
                )),
            )
        }
        DiffField::GlobalMute => (
            Some(
                UiText::new("bundle.value.boolean", old)
                    .boolean("value", before.engine.global_mute),
            ),
            None,
        ),
        DiffField::GlobalBypass => (
            Some(
                UiText::new("bundle.value.boolean", old)
                    .boolean("value", before.engine.global_bypass),
            ),
            None,
        ),
    }
}
fn preview_diff(before: &Captured, bundle: &BundleV1) -> Vec<DiffRow> {
    let mut rows = Vec::new();
    let mut row =
        |field: DiffField, label: &str, selected: bool, old: Option<String>, new: String| {
            let status = if !selected {
                "notSelected"
            } else if old.is_none() {
                "unknown"
            } else if old.as_ref() == Some(&new) {
                "same"
            } else {
                "changed"
            };
            let before_value = old.unwrap_or_else(|| "未確認".into());
            let after_value = if selected {
                new
            } else {
                "変更しません".into()
            };
            let (before_text, after_text) =
                diff_value_texts(field, before, bundle, &before_value, &after_value);
            let code = field.code();
            let mut label_text = UiText::new(code, label);
            if let DiffField::VstSettings(index) | DiffField::VstState(index) = field {
                label_text = label_text.number("index", (index + 1) as f64);
            }
            rows.push(DiffRow {
                label: label.into(),
                status: status.into(),
                before: before_value,
                after: after_value,
                field_code: Some(code),
                label_text: Some(label_text),
                before_text: if before_text.is_none() {
                    Some(UiText::new("bundle.value.unknown", "未確認"))
                } else {
                    before_text
                },
                after_text: if selected {
                    after_text
                } else {
                    Some(UiText::new("bundle.value.notChanged", "変更しません"))
                },
            });
        };
    let preset = &bundle.embedded_auralyn_preset;
    let audio = preset.audio_config.as_ref();
    let selected = bundle.categories.include_audio_config;
    for (field, label, old, new) in [
        (
            DiffField::Host,
            "音声方式",
            before.active.as_ref().map(|c| c.host.clone()),
            audio.map(|c| c.host.clone()),
        ),
        (
            DiffField::InputDevice,
            "入力デバイス",
            before
                .active
                .as_ref()
                .map(|c| c.input.clone().unwrap_or_else(|| "既定".into())),
            audio.map(|c| c.input_device.clone().unwrap_or_else(|| "既定".into())),
        ),
        (
            DiffField::OutputDevice,
            "出力デバイス",
            before
                .active
                .as_ref()
                .map(|c| c.output.clone().unwrap_or_else(|| "既定".into())),
            audio.map(|c| c.output_device.clone().unwrap_or_else(|| "既定".into())),
        ),
        (
            DiffField::Rate,
            "サンプルレート",
            before
                .active
                .as_ref()
                .and_then(|c| c.sample_rate)
                .map(|v| format!("{v} Hz")),
            audio.map(|c| format!("{} Hz", c.sample_rate)),
        ),
        (
            DiffField::Buffer,
            "固定バッファ要求",
            before
                .engine
                .fixed_buffer_request_frames
                .map(|v| format!("{v} frames")),
            audio.map(|c| format!("{} frames", c.buffer_size)),
        ),
    ] {
        row(field, label, selected, old, new.unwrap_or_default());
    }
    row(
        DiffField::Channels,
        "入力チャンネル",
        selected,
        Some(format!("{:?}（0始まり）", before.engine.input_channels)),
        audio
            .map(|c| format!("{:?}（0始まり）", c.input_channels))
            .unwrap_or_default(),
    );
    for (field, label, old, new) in [
        (
            DiffField::InputGain,
            "入力音量",
            before.engine.input_gain,
            bundle.level_intent.as_ref().map(|v| v.input_gain),
        ),
        (
            DiffField::OutputGain,
            "全体音量",
            before.engine.output_gain,
            bundle.level_intent.as_ref().map(|v| v.output_gain),
        ),
    ] {
        row(
            field,
            label,
            selected,
            Some(format!("{:.2}%", old * 100.)),
            new.map(|v| format!("{:.2}%", v * 100.)).unwrap_or_default(),
        );
    }
    row(
        DiffField::Noise,
        "ノイズ低減",
        bundle.categories.include_noise_control,
        Some(noise_description(&before.engine.noise)),
        preset
            .noise_control
            .as_ref()
            .map(noise_description)
            .unwrap_or_default(),
    );
    row(
        DiffField::Builtin,
        "内蔵処理",
        bundle.categories.include_builtin_fx,
        Some(builtin_description(&before.engine.builtin)),
        preset
            .builtin_fx
            .as_ref()
            .map(builtin_description)
            .unwrap_or_default(),
    );
    let plugins = &preset.plugins;
    row(
        DiffField::VstOrder,
        "VST順序",
        bundle.categories.include_plugins,
        Some(if before.engine.plugins.is_empty() {
            "VSTなし".into()
        } else {
            before
                .engine
                .plugins
                .iter()
                .map(|p| p.plugin.name.as_str())
                .collect::<Vec<_>>()
                .join(" → ")
        }),
        if plugins.is_empty() {
            "VSTなし".into()
        } else {
            plugins
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(" → ")
        },
    );
    if bundle.categories.include_plugins {
        for (index, plugin) in plugins.iter().enumerate() {
            let old = before.engine.plugins.get(index).map(|p| &p.plugin);
            let describe = |p: &PresetPlugin| {
                format!(
                    "{} / {} / {} / {:.2}%",
                    p.name,
                    if p.enabled { "有効" } else { "バイパス" },
                    if p.muted {
                        "ミュート"
                    } else {
                        "ミュートなし"
                    },
                    p.gain * 100.
                )
            };
            row(
                DiffField::VstSettings(index),
                &format!("VST {} 設定", index + 1),
                true,
                old.map(describe),
                describe(plugin),
            );
            let same = old.is_some_and(|p| p.path == plugin.path && p.state == plugin.state);
            row(
                DiffField::VstState(index),
                &format!("VST {} state", index + 1),
                true,
                old.map(|_| "取得済み（値は表示しません）".into()),
                if same {
                    "取得済み（値は表示しません）".into()
                } else {
                    "変更あり（値は表示しません）".into()
                },
            );
        }
    }
    row(
        DiffField::GlobalMute,
        "全体ミュート",
        false,
        Some(
            if before.engine.global_mute {
                "ON"
            } else {
                "OFF"
            }
            .into(),
        ),
        String::new(),
    );
    row(
        DiffField::GlobalBypass,
        "VST全体バイパス",
        false,
        Some(
            if before.engine.global_bypass {
                "ON"
            } else {
                "OFF"
            }
            .into(),
        ),
        String::new(),
    );
    rows
}
fn noise_description(value: &ProfileNoiseControl) -> String {
    format!(
        "{} / {} / 強さ {:.2} / 声保護 {}",
        if value.enabled { "ON" } else { "OFF" },
        value.mode,
        value.strength,
        if value.voice_guard { "ON" } else { "OFF" }
    )
}
fn builtin_description(value: &ProfileBuiltinFx) -> String {
    let singing = value
        .singing
        .map(|s| {
            format!(
                " / ローカット {} Hz・圧縮 {:.2}・明るさ {} dB",
                s.low_cut_hz, s.dynamics, s.brightness_db
            )
        })
        .unwrap_or_default();
    let reverb = value
        .reverb
        .map(|r| {
            format!(
                " / 残響 {}・量 {:.2}・減衰 {}秒・高域減衰 {:.2}",
                if r.enabled { "ON" } else { "OFF" },
                r.mix,
                r.decay_seconds,
                r.damping
            )
        })
        .unwrap_or_else(|| " / 残響 OFF".into());
    format!(
        "声 {} / {} / 量 {:.2}{singing}{reverb}",
        if value.enabled { "ON" } else { "OFF" },
        value.preset,
        value.amount
    )
}
fn capture(host: &mut audio::AudioHost) -> Result<(Captured, ControlWitness), String> {
    let witness = host.conditions().control_snapshot()?;
    let engine = host.capture_bundle_state().map_err(|e| e.to_string())?;
    witness.validate()?;
    let active = host.get_state().config;
    let audio_config = active.clone().and_then(|c| {
        engine.fixed_buffer_request_frames?;
        Some(ProfileAudioConfig {
            host: c.host,
            input_device: c.input,
            output_device: c.output,
            sample_rate: c.sample_rate?,
            buffer_size: c.buffer_size?,
            input_channels: engine.input_channels.clone(),
            input_gain_db: linear_db(engine.input_gain),
            master_gain_db: linear_db(engine.output_gain),
        })
    });
    let preset = Preset {
        schema_version: 2,
        name: "配信状態".into(),
        plugins: engine.plugins.iter().map(|p| p.plugin.clone()).collect(),
        audio_config,
        noise_control: Some(engine.noise.clone()),
        builtin_fx: Some(engine.builtin.clone()),
    };
    Ok((
        Captured {
            engine,
            preset,
            active,
        },
        witness,
    ))
}
fn linear_db(value: f32) -> f32 {
    20.0 * value.max(0.000_001).log10()
}
fn select(mut preset: Preset, categories: &ProfileSaveCategories) -> Result<Preset, String> {
    if categories.include_audio_config && preset.audio_config.is_none() {
        return Err("入出力の固定設定を取得できません。Default・未確認バッファを固定512として保存できません。固定値を選ぶか、入出力カテゴリを外してください".into());
    }
    if !categories.include_plugins {
        preset.plugins.clear();
    }
    if !categories.include_audio_config {
        preset.audio_config = None;
    }
    if !categories.include_noise_control {
        preset.noise_control = None;
    }
    if !categories.include_builtin_fx {
        preset.builtin_fx = None;
    }
    Ok(preset)
}
fn unchanged(before: &Captured, after: &Captured) -> bool {
    // opaque component stateも除外しない。処理由来の変動でも保守的に競合にする。
    before.engine == after.engine && before.preset == after.preset
}
fn complete(summary: &ApplyProfileSummary) -> bool {
    summary.missing_devices.is_empty()
        && summary.missing_plugins.is_empty()
        && summary.skipped_categories.is_empty()
}
fn blocks_next_apply(result: &ResultView) -> bool {
    result.undo_pending && !result.complete
}
fn begin_undo(result: &mut ResultView) {
    result.complete = false;
    result.summary = None;
    result.set_auralyn(
        "bundle.undo.checking",
        "元に戻す処理を確認中です。原本を保持しています",
    );
}
fn verify_undo_snapshot(
    witness: &ControlWitness,
    expected: &Captured,
    actual: &Captured,
) -> Result<(), String> {
    witness.validate()?;
    if !unchanged(expected, actual) {
        return Err("復元直前にVSTまたは制御設定が変わりました。原本を保持しています".into());
    }
    Ok(())
}

fn selected_matches(target: &BundleV1, after: &Captured) -> bool {
    let preset = &target.embedded_auralyn_preset;
    let plugins_match = !target.categories.include_plugins
        || (preset.plugins.len() == after.engine.plugins.len()
            && preset
                .plugins
                .iter()
                .zip(&after.engine.plugins)
                .all(|(a, b)| {
                    a.path == b.plugin.path
                        && a.state == b.plugin.state
                        && a.enabled == b.plugin.enabled
                        && a.muted == b.plugin.muted
                        && a.gain == b.plugin.gain
                }));
    let audio_matches = if let Some(audio) = &preset.audio_config {
        after.preset.audio_config.as_ref().is_some_and(|current| {
            current.host == audio.host
                && current.input_device == audio.input_device
                && current.output_device == audio.output_device
                && current.sample_rate == audio.sample_rate
                && current.buffer_size == audio.buffer_size
                && current.input_channels == audio.input_channels
        })
    } else {
        true
    };
    let level_matches = target.level_intent.as_ref().is_none_or(|level| {
        level.input_gain == after.engine.input_gain && level.output_gain == after.engine.output_gain
    });
    plugins_match
        && audio_matches
        && level_matches
        && preset
            .noise_control
            .as_ref()
            .is_none_or(|noise| *noise == after.engine.noise)
        && preset
            .builtin_fx
            .as_ref()
            .is_none_or(|fx| *fx == after.engine.builtin)
}

fn apply_selected(
    root: &std::path::Path,
    host: &mut audio::AudioHost,
    target: &BundleV1,
    before: &Captured,
) -> Result<ApplyProfileSummary, String> {
    let ids = before
        .engine
        .plugins
        .iter()
        .map(|p| p.id.clone())
        .collect::<Vec<_>>();
    let replace_empty =
        target.categories.include_plugins && target.embedded_auralyn_preset.plugins.is_empty();
    // 明示emptyとカテゴリ不在を混同しない。既存profileのlegacy意味は変えない。
    if replace_empty {
        host.unload_all_plugins(&ids).map_err(|e| e.to_string())?;
    }
    let level = target.level_intent.as_ref();
    let channels = target
        .embedded_auralyn_preset
        .audio_config
        .as_ref()
        .map_or(before.engine.input_channels.as_slice(), |c| {
            c.input_channels.as_slice()
        });
    let initial = profile::StartIntent {
        input_gain: level.map_or(before.engine.input_gain, |l| l.input_gain),
        output_gain: level.map_or(before.engine.output_gain, |l| l.output_gain),
        input_channels: [
            *channels.first().ok_or("入力チャンネルが不正です")?,
            *channels.get(1).ok_or("入力チャンネルが不正です")?,
        ],
        muted: before.engine.global_mute,
        bypassed: before.engine.global_bypass,
    };
    let mut summary = profile::apply_profile_with_start_intent(
        root,
        host,
        &target.embedded_auralyn_preset,
        None,
        true,
        if target.categories.include_plugins {
            vec![]
        } else {
            before.preset.plugins.clone()
        },
        None,
        if replace_empty { &[] } else { &ids },
        Some(initial),
    )?;
    if replace_empty {
        summary.applied_categories.push("plugins".into());
    }
    if let Some(level) = &target.level_intent {
        host.set_input_gain(level.input_gain)
            .map_err(|e| e.to_string())?;
        host.set_output_gain(level.output_gain)
            .map_err(|e| e.to_string())?;
        if let Some(audio) = &mut summary.applied_audio_config {
            audio.input_gain_db = linear_db(level.input_gain);
            audio.master_gain_db = linear_db(level.output_gain);
        }
    }
    Ok(summary)
}

async fn capture_async(
    host: Arc<Mutex<audio::AudioHost>>,
) -> Result<(Captured, ControlWitness), String> {
    super::run_blocking(move || {
        let mut host = host.lock().map_err(|_| "音声状態を取得できません")?;
        capture(&mut host)
    })
    .await
}
async fn settle_capture(
    host: Arc<Mutex<audio::AudioHost>>,
) -> Result<(Captured, ControlWitness), String> {
    // RT ACK待ちを有限にする。失敗の理由を成功や未適用へ置換しない。
    let mut last = "反映状態を取得できません".to_string();
    for _ in 0..40 {
        match capture_async(host.clone()).await {
            Ok(value) => return Ok(value),
            Err(e) => last = e,
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err(last)
}

#[tauri::command]
pub(crate) async fn broadcast_bundle(
    app: AppHandle,
    audio: State<'_, audio::AudioState>,
    obs: State<'_, obs::ObsState>,
    state: State<'_, BundleState>,
    request: Request,
) -> Result<Response, String> {
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let host = audio.0.clone();
    let mut session = state.0.lock().await;
    match request {
        Request::List => Ok(Response::Names(bundle::list(&root)?)),
        Request::CheckedList => Ok(Response::Names(
            bundle::list(&root)?
                .into_iter()
                .filter(|name| bundle::load(&root, name).is_ok_and(|b| b.confirmation.is_some()))
                .collect(),
        )),
        Request::Sources => Ok(Response::Names(obs_setup::bundle::sources(&obs).await?)),
        Request::Filters { source } => Ok(Response::Filters(
            obs_setup::bundle::filters(&obs, &source).await?,
        )),
        Request::History => Ok(Response::Result(
            session.history.as_ref().map(|h| Box::new(h.result.clone())),
        )),
        Request::Save {
            name,
            overwrite,
            categories,
            obs: selection,
            checked,
        } => {
            bundle::validate_name(&name)?;
            bundle::ensure_save_allowed(&root, &name, overwrite)?;
            if let Some(claim) = &checked {
                if !categories.include_plugins
                    || !categories.include_audio_config
                    || !categories.include_noise_control
                    || !categories.include_builtin_fx
                    || selection.is_some()
                {
                    return Err(
                        "確認済み保存にはAuralynの全カテゴリを選び、OBSを外してください".into(),
                    );
                }
                validate_checked(host.clone(), claim).await?;
            }
            let (captured, witness) = capture_async(host.clone()).await?;
            let saved_obs = if let Some(selection) = selection {
                Some(obs_setup::bundle::capture(&obs, &selection).await?)
            } else {
                None
            };
            witness.validate()?;
            // OBS await中のtokenless編集やVST GUI変更を成功保存にしない。
            let (after, _) = capture_async(host.clone()).await?;
            if !unchanged(&captured, &after) {
                return Err(
                    "取得中にAuralyn/VST状態が変わりました。元の配信状態を保持しています".into(),
                );
            }
            if let Some(claim) = &checked {
                validate_checked(host, claim).await?;
            }
            let confirmation = checked.map(|claim| bundle::Confirmation {
                checked_at_unix_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
                usage: claim.usage,
                location: claim.location,
                preparation: claim.expected,
            });
            let bundle = BundleV1 {
                confirmation,
                schema_version: 1,
                revision: bundle::revision(),
                name,
                categories: categories.clone(),
                level_intent: categories
                    .include_audio_config
                    .then_some(bundle::LevelIntent {
                        input_gain: captured.engine.input_gain,
                        output_gain: captured.engine.output_gain,
                    }),
                embedded_auralyn_preset: select(captured.preset, &categories)?,
                obs: saved_obs,
            };
            bundle::save_with_overwrite(&root, &bundle, overwrite)?;
            session.preview = None;
            Ok(Response::Saved)
        }
        Request::Preview { name } => {
            session.preview = None;
            let bundle = bundle::load(&root, &name)?;
            let (before, witness) = capture_async(host).await?;
            let obs_plan = if let Some(saved) = &bundle.obs {
                Some(obs_setup::bundle::preview(&obs, saved).await?)
            } else {
                None
            };
            witness.validate()?;
            let view = PreviewView {
                id: bundle::revision(),
                name: name.clone(),
                revision: bundle.revision.clone(),
                categories: category_names(&bundle.categories),
                obs: obs_plan.as_ref().map_or(vec![], |p| p.changes.clone()),
                running: before.engine.running,
                auralyn: preview_diff(&before, &bundle),
                confirmation: bundle.confirmation.clone(),
            };
            session.preview = Some(Preview {
                id: view.id.clone(),
                bundle,
                before,
                witness,
                obs: obs_plan,
            });
            Ok(Response::Preview(Box::new(view)))
        }
        Request::Apply { id } => {
            if session
                .history
                .as_ref()
                .is_some_and(|h| blocks_next_apply(&h.result))
            {
                return Err("前の配信状態の復元候補を保持中です。先に元に戻してください".into());
            }
            let plan = session.preview.take().ok_or("差分を再確認してください")?;
            if plan.id != id
                || bundle::load(&root, &plan.bundle.name)?.revision != plan.bundle.revision
            {
                return Err("保存内容または変更予定が変わりました。再確認してください".into());
            }
            plan.witness.validate()?;
            if plan.bundle.confirmation.is_some() {
                let checked_host = host.clone();
                super::run_blocking(move || {
                    checked_host
                        .lock()
                        .map_err(|_| "音声状態を取得できません")?
                        .checked_snapshot_supported()
                        .map_err(|e| e.to_string())
                })
                .await?;
            }
            if plan.bundle.confirmation.is_some() && !plan.before.engine.global_mute {
                return Err("確認済み構成を呼び戻す前に緊急ミュートを有効にし、差分を取り直してください。復元後も確認するまでミュートを維持します".into());
            }
            if plan.bundle.categories.include_audio_config {
                super::audio::enumerate_devices_async(host.clone(), false).await?;
            }
            let host_begin = host.clone();
            let token = super::run_blocking(move || {
                host_begin
                    .lock()
                    .map_err(|_| "音声状態を取得できません")?
                    .begin_live_changes()
                    .map_err(|e| e.to_string())
            })
            .await?;
            // Endはこのcommandが取得したtokenだけをfinally相当で解放する。
            let result = apply_owned(&root, host.clone(), &obs, plan, &mut session).await;
            let end = super::run_blocking(move || {
                host.lock()
                    .map_err(|_| "音声状態を取得できません")?
                    .end_live_changes(token)
                    .map_err(|e| e.to_string())
            })
            .await;
            if let Err(error) = end {
                if let Some(history) = &mut session.history {
                    history.result.complete = false;
                    history.result.set_auralyn(
                        "bundle.reservation.endUnknown",
                        format!("復元予約の終了を要確認: {error}"),
                    );
                }
            }
            result.map(|_| {
                Response::Result(session.history.as_ref().map(|h| Box::new(h.result.clone())))
            })
        }
        Request::Undo { id } => {
            let history = session
                .history
                .as_mut()
                .ok_or("元に戻せる配信状態がありません")?;
            if history.id != id || !history.result.undo_pending {
                return Err("古い復元操作です".into());
            }
            let host_begin = host.clone();
            let token = super::run_blocking(move || {
                host_begin
                    .lock()
                    .map_err(|_| "音声状態を取得できません")?
                    .begin_live_changes()
                    .map_err(|e| e.to_string())
            })
            .await?;
            let result = undo_owned(&root, host.clone(), &obs, history).await;
            let end = super::run_blocking(move || {
                host.lock()
                    .map_err(|_| "音声状態を取得できません")?
                    .end_live_changes(token)
                    .map_err(|e| e.to_string())
            })
            .await;
            if let Err(error) = end {
                history.result.complete = false;
                history.result.set_auralyn(
                    "bundle.reservation.endUnknown",
                    format!("復元予約の終了を要確認: {error}"),
                );
            }
            if let Err(error) = result {
                history.result.complete = false;
                history.result.set_auralyn(
                    "bundle.undo.deferredUnknown",
                    format!("復元保留・結果を要確認: {error}。原本を保持しています"),
                );
                refresh_current(audio.0.clone(), history).await;
            }
            Ok(Response::Result(Some(Box::new(history.result.clone()))))
        }
    }
}

async fn apply_owned(
    root: &std::path::Path,
    host: Arc<Mutex<audio::AudioHost>>,
    obs: &obs::ObsState,
    plan: Preview,
    session: &mut Session,
) -> Result<(), String> {
    plan.witness.validate()?;
    let (before, witness) = capture_async(host.clone()).await?;
    if !unchanged(&plan.before, &before) {
        return Err("VSTを含む現在値が変更されました。差分を再確認してください".into());
    }
    if plan.bundle.categories.include_audio_config && before.preset.audio_config.is_none() {
        return Err("現在の入出力設定をバックアップできません。固定設定で音声を準備してから再確認してください".into());
    }
    witness.validate()?;
    let backup =
        BundleV1 {
            schema_version: 1,
            revision: bundle::revision(),
            name: plan.id.clone(),
            categories: plan.bundle.categories.clone(),
            confirmation: None,
            level_intent: plan.bundle.categories.include_audio_config.then_some(
                bundle::LevelIntent {
                    input_gain: before.engine.input_gain,
                    output_gain: before.engine.output_gain,
                },
            ),
            embedded_auralyn_preset: select(before.preset.clone(), &plan.bundle.categories)?,
            obs: None,
        };
    bundle::save(&root.join("broadcast-bundle-backups"), &backup)?;
    session.history = Some(Operation {
        id: plan.id.clone(),
        backup,
        after: None,
        witness: None,
        obs_id: None,
        result: ResultView {
            id: plan.id.clone(),
            complete: false,
            undo_pending: true,
            auralyn: "適用状態を要確認（原本を保持）".into(),
            auralyn_text: Some(UiText::new(
                "bundle.apply.initialUnknown",
                "適用状態を要確認（原本を保持）",
            )),
            obs: vec![],
            obs_texts: Some(vec![]),
            summary: None,
            current: None,
        },
        was_running: before.engine.running,
    });
    let history = session.history.as_mut().ok_or("操作履歴がありません")?;
    let root_owned = root.to_path_buf();
    let target = plan.bundle;
    let verify_target = target.clone();
    let apply_host = host.clone();
    let applied = super::run_blocking(move || {
        let mut host = apply_host.lock().map_err(|_| "音声状態を取得できません")?;
        witness.validate()?;
        let summary =
            host.bundle_change_scope(|host| apply_selected(&root_owned, host, &target, &before))?;
        let witness = host.conditions().control_snapshot()?;
        Ok((summary, witness))
    })
    .await;
    let (summary, applied_witness) = match applied {
        Ok(value) => value,
        Err(error) => {
            history.result.set_auralyn(
                "bundle.apply.partialUnknown",
                format!("一部適用・結果不明: {error}。原本を保持しています"),
            );
            refresh_current(host, history).await;
            return Ok(());
        }
    };
    let all_applied = complete(&summary);
    history.result.summary = Some(summary.into());
    if !all_applied {
        history.result.set_auralyn(
            "bundle.apply.incomplete",
            "一部のカテゴリ/VSTを適用できませんでした。OBSは変更していません",
        );
    }
    let (after, after_witness) = match settle_capture(host.clone()).await {
        Ok(value) => value,
        Err(error) => {
            history.result.set_auralyn(
                "bundle.apply.captureUnknown",
                format!("適用後の状態を確認できません: {error}。原本を保持しています"),
            );
            return Ok(());
        }
    };
    history.result.current = Some(current_dto(&after));
    if applied_witness.validate().is_err() {
        history.result.set_auralyn(
            "bundle.apply.conditionsChanged",
            "反映確認中にAuralynの条件が変わりました。原本を保持しています",
        );
        return Ok(());
    }
    history.after = Some(after);
    history.witness = Some(after_witness.clone());
    if !all_applied
        || !selected_matches(
            &verify_target,
            history.after.as_ref().ok_or("適用後の状態がありません")?,
        )
    {
        history.result.set_auralyn(
            "bundle.apply.valuesMismatch",
            "一部の設定・VST stateが保存値と一致しません。OBSは変更せず原本を保持しています",
        );
        return Ok(());
    }
    history.result.set_auralyn(
        "bundle.apply.confirmed",
        "Auralynの適用と制御設定を確認しました（信号到達の確認ではありません）",
    );
    if let Some(obs_plan) = plan.obs {
        // 自分のAuralyn変更前のwitnessを使わず、反映確認後に採り直す。
        let conditions_host = host.clone();
        let witness = super::run_blocking(move || {
            conditions_host
                .lock()
                .map_err(|_| "音声状態を取得できません")?
                .conditions()
                .snapshot()
        })
        .await;
        let result = match witness {
            Ok(witness) => obs_setup::bundle::apply(obs, obs_plan, witness).await,
            Err(error) => Err(error),
        };
        match result {
            Ok(obs_history) => {
                history.obs_id = Some(obs_history.id);
                history.result.set_obs_history(&obs_history);
                history.result.complete = obs_setup::bundle::applied(&obs_history);
            }
            Err(error) => history
                .result
                .set_obs_unknown(format!("OBS適用を確認できません: {error}")),
        }
    } else {
        history.result.complete = true;
    }
    if after_witness.validate().is_err() {
        history.result.complete = false;
        history.result.set_auralyn(
            "bundle.apply.conditionsChangedAfter",
            "適用後にAuralynの条件が変わりました。原本を保持しています",
        );
    }
    Ok(())
}

async fn undo_owned(
    root: &std::path::Path,
    host: Arc<Mutex<audio::AudioHost>>,
    obs: &obs::ObsState,
    history: &mut Operation,
) -> Result<(), String> {
    begin_undo(&mut history.result);
    let witness = history
        .witness
        .as_ref()
        .ok_or("適用後の状態が不明です。原本を保持しているため手動確認してください")?
        .clone();
    witness.validate()?;
    let expected = history
        .after
        .as_ref()
        .ok_or("適用後の状態が不明です。原本を保持しています")?
        .clone();
    let (current, _) = capture_async(host.clone()).await?;
    if !unchanged(&expected, &current) {
        return Err("後からVST状態または設定が変わりました。上書きせず原本を保持しています".into());
    }
    // OBSを先に戻し、競合/結果不明が残る間はAuralynを変更しない。
    if let Some(id) = history.obs_id {
        let restored = obs_setup::bundle::restore(obs, id).await?;
        history.result.set_obs_history(&restored);
        if obs_setup::bundle::pending(&restored) {
            history.result.complete = false;
            return Ok(());
        }
    }
    witness.validate()?;
    let root = root.to_path_buf();
    let backup = history.backup.clone();
    let was_running = history.was_running;
    let verify_backup = backup.clone();
    let apply_host = host.clone();
    let summary = super::run_blocking(move || {
        let mut host = apply_host.lock().map_err(|_| "音声状態を取得できません")?;
        // OBS await/実行queue待ちの後、実際に変更するHost lock内で再照合する。
        witness.validate()?;
        let (fresh, _) = capture(&mut host)?;
        verify_undo_snapshot(&witness, &expected, &fresh)?;
        let summary = host.bundle_change_scope(|host| {
            let summary = apply_selected(&root, host, &backup, &current)?;
            if !was_running {
                host.stop().map_err(|e| e.to_string())?;
            }
            Ok(summary)
        })?;
        Ok(summary)
    })
    .await;
    let summary = match summary {
        Ok(summary) => summary,
        Err(error) => {
            history.result.set_auralyn(
                "bundle.undo.partialUnknown",
                format!("Auralyn復元の一部適用・結果不明: {error}。原本を保持しています"),
            );
            refresh_current(host, history).await;
            return Ok(());
        }
    };
    history.result.summary = Some(summary.clone().into());
    if !complete(&summary) {
        history.result.set_auralyn(
            "bundle.undo.incomplete",
            "Auralynの復元が一部未完了です。原本を保持しています",
        );
        return Ok(());
    }
    let (restored, _) = settle_capture(host).await?;
    history.result.current = Some(current_dto(&restored));
    if !selected_matches(&verify_backup, &restored) || restored.engine.running != was_running {
        history.result.set_auralyn(
            "bundle.undo.valuesUnknown",
            "復元値を確認できません。原本を保持しています",
        );
        return Ok(());
    }
    history.result.set_auralyn(
        "bundle.undo.confirmed",
        "元のAuralyn設定への復元を確認しました",
    );
    history.result.complete = true;
    history.result.undo_pending = false;
    Ok(())
}

async fn refresh_current(host: Arc<Mutex<audio::AudioHost>>, history: &mut Operation) {
    if let Ok((current, _)) = settle_capture(host).await {
        history.result.current = Some(current_dto(&current));
        // 失敗後の実値は表示同期にだけ使い、外部編集をUndoの新しい基準へ採用しない。
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_dto_contains_only_actual_rack_metadata_not_control_prefs_or_state() {
        let mut captured = captured();
        captured.engine.plugins.push(bundle::CapturedPlugin {
            id: "actual-id".into(),
            plugin: PresetPlugin {
                path: "fixture-path".into(),
                name: "Fixture".into(),
                vendor: "Vendor".into(),
                version: "1".into(),
                enabled: false,
                muted: true,
                gain: 0.5,
                state: Some("opaque-component-state".into()),
            },
        });
        let dto = current_dto(&captured);
        assert_eq!(dto.applied_categories, ["plugins"]);
        assert!(dto.applied_audio_config.is_none());
        assert!(dto.applied_noise_control.is_none());
        assert!(dto.applied_builtin_fx.is_none());
        assert_eq!(dto.loaded_plugin_instances.len(), 1);
        let actual = &dto.loaded_plugin_instances[0];
        assert_eq!(actual.id, "actual-id");
        assert!(!actual.enabled && actual.muted);
        assert_eq!(actual.gain, 0.5);
        let json = serde_json::to_string(&dto).unwrap();
        assert!(!json.contains("opaque-component-state"));
        assert!(!json.contains("appliedPlugins"));
        assert!(!json.contains("\"state\""));
    }
    #[tokio::test]
    async fn undo_lock_wait_revalidates_conditions_before_mutation_and_pending_blocks_next_apply() {
        let conditions = Arc::new(audio::conditions::Conditions::default());
        let witness = conditions.control_snapshot().unwrap();
        let lock = tokio::sync::Mutex::new(());
        let held = lock.lock().await;
        let expected = captured();
        let changed = std::sync::atomic::AtomicBool::new(false);
        let restore = async {
            let _guard = lock.lock().await;
            verify_undo_snapshot(&witness, &expected, &expected)?;
            changed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, String>(())
        };
        tokio::pin!(restore);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut restore)
                .await
                .is_err()
        );
        conditions.lifecycle(false); // 別操作がHost lockを保持している間に変更。
        drop(held);
        assert!(restore.await.is_err());
        assert!(!changed.load(std::sync::atomic::Ordering::SeqCst));
        let mut result = ResultView {
            id: "undo".into(),
            complete: true,
            undo_pending: true,
            auralyn: String::new(),
            obs: vec![],
            auralyn_text: None,
            obs_texts: Some(vec![]),
            summary: None,
            current: None,
        };
        begin_undo(&mut result);
        assert!(blocks_next_apply(&result)); // OBS部分失敗/未確認で早期returnしても成功状態を残さない。
    }
    fn captured() -> Captured {
        let engine = EngineCapture {
            control_revision: "1".into(),
            running: false,
            fixed_buffer_request_frames: None,
            plugins: vec![],
            input_channels: vec![0, 1],
            input_gain: 0.,
            output_gain: 0.,
            global_mute: true,
            global_bypass: false,
            noise: ProfileNoiseControl {
                enabled: false,
                mode: "smart".into(),
                strength: 1.,
                voice_guard: true,
                learned_profile: None,
            },
            builtin: ProfileBuiltinFx {
                preset: "broadcast".into(),
                enabled: false,
                amount: 0.7,
                singing: None,
                reverb: None,
            },
        };
        Captured {
            preset: Preset {
                schema_version: 2,
                name: "配信状態".into(),
                plugins: vec![],
                audio_config: None,
                noise_control: Some(engine.noise.clone()),
                builtin_fx: Some(engine.builtin.clone()),
            },
            engine,
            active: None,
        }
    }
    #[test]
    fn partial_and_skipped_are_not_complete_and_state_or_flags_change_is_conflict() {
        let before = captured();
        let mut after = before.clone();
        assert!(unchanged(&before, &after));
        after.engine.global_mute = false;
        assert!(!unchanged(&before, &after));
        let mut summary = ApplyProfileSummary::default();
        assert!(complete(&summary));
        summary.skipped_categories.push("plugins".into());
        assert!(!complete(&summary));
        let mut result = ResultView {
            id: "operation".into(),
            complete: true,
            undo_pending: true,
            auralyn: String::new(),
            obs: vec![],
            auralyn_text: None,
            obs_texts: Some(vec![]),
            summary: None,
            current: None,
        };
        assert!(!blocks_next_apply(&result)); // 全成功は次の明示applyでarchiveできる。
        result.complete = false;
        assert!(blocks_next_apply(&result)); // partial/unknownは原本を上書きしない。
        summary.skipped_categories.clear();
        summary.missing_plugins.push(MissingPlugin {
            name: "missing".into(),
            path: "not-present".into(),
        });
        assert!(!complete(&summary));
    }
    #[test]
    fn checked_save_requires_a_running_unmuted_settled_stream_and_the_exact_observed_conditions() {
        let p = crate::ipc::PreparationSnapshot {
            engine_epoch: "engine".into(),
            processing_revision: "4".into(),
            routing_revision: "2".into(),
            input_gain: 1.0,
            input_channels: [0, 1],
            output_gain: 1.0,
            output_revision: "3".into(),
            muted: false,
            controls_pending: false,
            nr_backend: "nnnoiseless-0.5.2".into(),
            nr_model: "bundled".into(),
        };
        assert!(validate_checked_conditions(true, Some(&p), &p).is_ok());
        assert!(validate_checked_conditions(false, Some(&p), &p).is_err());
        assert!(validate_checked_conditions(true, None, &p).is_err());
        let mut changed = p.clone();
        changed.processing_revision = "6".into();
        assert!(validate_checked_conditions(true, Some(&changed), &p).is_err());
        for kind in 0..3 {
            let mut current = p.clone();
            match kind {
                0 => current.muted = true,
                1 => current.controls_pending = true,
                _ => current.output_gain = 0.0,
            };
            assert!(validate_checked_conditions(true, Some(&current), &current).is_err());
        }
    }
    #[test]
    fn preview_and_result_expose_differences_without_opaque_state_or_default_buffer_claim() {
        let before = captured();
        let target = BundleV1 {
            schema_version: 1,
            revision: "1".into(),
            name: "test".into(),
            categories: ProfileSaveCategories {
                include_plugins: true,
                ..Default::default()
            },
            embedded_auralyn_preset: select(
                before.preset.clone(),
                &ProfileSaveCategories {
                    include_plugins: true,
                    ..Default::default()
                },
            )
            .unwrap(),
            obs: None,
            confirmation: None,
            level_intent: None,
        };
        let rows = preview_diff(&before, &target);
        for row in &rows {
            assert!(row.field_code.is_some());
            assert_eq!(row.label_text.as_ref().unwrap().fallback_ja, row.label);
            assert!(row.before_text.is_some());
            assert!(row.after_text.is_some());
        }
        let buffer = rows.iter().find(|r| r.label == "固定バッファ要求").unwrap();
        assert_eq!(buffer.status, "notSelected");
        assert_eq!(buffer.before, "未確認");
        assert_eq!(
            buffer.after_text.as_ref().unwrap().code,
            "bundle.value.notChanged"
        );
        assert!(!serde_json::to_string(&rows).unwrap().contains("512"));
        let mut selected = target.categories.clone();
        selected.include_audio_config = true;
        assert!(select(before.preset.clone(), &selected).is_err());
        let secret = "opaque-state-must-not-cross-the-command-boundary";
        let mut summary = ApplyProfileSummary::default();
        summary.applied_plugins.push(PresetPlugin {
            path: "test".into(),
            name: "test".into(),
            vendor: String::new(),
            version: String::new(),
            enabled: true,
            muted: false,
            gain: 1.,
            state: Some(secret.into()),
        });
        let dto: SummaryDto = summary.into();
        let json = serde_json::to_string(&dto).unwrap();
        assert!(!json.contains(secret));
        assert!(!json.contains("appliedPlugins"));
    }
    #[test]
    fn typed_result_updates_preserve_authority_flags_and_keep_remote_errors_out_of_args() {
        let mut result = ResultView {
            id: "typed".into(),
            complete: false,
            undo_pending: true,
            auralyn: String::new(),
            obs: vec![],
            auralyn_text: None,
            obs_texts: None,
            summary: None,
            current: None,
        };
        result.set_auralyn("bundle.apply.incomplete", "一部未確認");
        assert_eq!(
            result.auralyn_text.as_ref().unwrap().fallback_ja,
            result.auralyn
        );
        let remote_error = "unstructured remote error with opaque detail";
        result.set_obs_unknown(remote_error);
        assert_eq!(result.obs, [remote_error]);
        let typed = &result.obs_texts.as_ref().unwrap()[0];
        assert_eq!(typed.fallback_ja, remote_error);
        assert_eq!(typed.code, "bundle.obs.applyUnknown");
        assert!(typed.args.is_empty());
        assert!(!result.complete);
        assert!(result.undo_pending);
        begin_undo(&mut result);
        assert_eq!(
            result.auralyn_text.as_ref().unwrap().code,
            "bundle.undo.checking"
        );
        assert!(blocks_next_apply(&result));
    }
    #[test]
    fn selected_backup_does_not_include_untouched_categories_and_empty_rack_is_explicit() {
        let before = captured();
        let categories = ProfileSaveCategories {
            include_plugins: true,
            ..Default::default()
        };
        let backup = select(before.preset.clone(), &categories).unwrap();
        assert!(backup.plugins.is_empty());
        assert!(backup.noise_control.is_none());
        assert!(backup.builtin_fx.is_none());
        assert!(backup.audio_config.is_none());
        let target = BundleV1 {
            schema_version: 1,
            revision: "1".into(),
            name: "empty".into(),
            categories,
            embedded_auralyn_preset: backup,
            obs: None,
            confirmation: None,
            level_intent: None,
        };
        assert!(selected_matches(&target, &before));
        let mut actual = before;
        actual.engine.plugins.push(bundle::CapturedPlugin {
            id: "remaining".into(),
            plugin: PresetPlugin {
                path: "test".into(),
                name: "test".into(),
                vendor: String::new(),
                version: String::new(),
                state: Some(String::new()),
                enabled: true,
                muted: false,
                gain: 1.,
            },
        });
        assert!(!selected_matches(&target, &actual));
        let mut opaque = actual.clone();
        opaque.engine.plugins[0].plugin.state = Some("changed by GUI or processing".into());
        assert!(!unchanged(&actual, &opaque));
    }
}
