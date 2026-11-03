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
    recovery_id: Option<String>,
}
fn validate_saved_preview(
    plan: &Preview,
    id: &str,
    current: &BundleV1,
    recovery_id: Option<&str>,
) -> Result<(), String> {
    // revisionを据え置いた外部編集も、確認済みの内容として適用しない。
    if plan.id != id
        || plan.recovery_id.as_deref() != recovery_id
        || bundle::content_digest(current)? != bundle::content_digest(&plan.bundle)?
    {
        return Err("保存内容または変更予定が変わりました。再確認してください".into());
    }
    Ok(())
}
struct Operation {
    id: String,
    backup: BundleV1,
    after: Option<Captured>,
    witness: Option<ControlWitness>,
    obs_id: Option<u64>,
    result: ResultView,
    was_running: bool,
    original_devices: Option<bundle::RecoveryDevices>,
}
fn active_devices(active: Option<&audio::ActiveAudioConfig>) -> Option<bundle::RecoveryDevices> {
    let active = active?;
    let input_id = active.input_id.as_ref()?.clone();
    let output_id = active.output_id.as_ref()?.clone();
    if input_id.is_empty() || output_id.is_empty() {
        return None;
    }
    Some(bundle::RecoveryDevices {
        input_id,
        output_id,
    })
}
fn recovery_device_matches(
    list: &[audio::AudioDevice],
    host: &str,
    name: &Option<String>,
    id: &str,
) -> bool {
    name.as_ref().is_some_and(|name| {
        list.iter()
            .filter(|device| {
                device.host.eq_ignore_ascii_case(host)
                    && device.name == *name
                    && device.id.as_deref() == Some(id)
            })
            .count()
            == 1
    })
}
#[derive(Clone)]
struct Captured {
    mixing: Option<bundle::MixingConfiguration>,
    mixing_revision: String,
    process: Option<bundle::ProcessConfiguration>,
    process_target: Option<crate::input_source::Target>,
    live: Option<bundle::LiveConfiguration>,
    live_revision: String,
    engine: EngineCapture,
    preset: Preset,
    active: Option<audio::ActiveAudioConfig>,
    output: Option<bundle::OutputConfiguration>,
    output_revision: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewView {
    pub mixing: Option<MixingPreview>,
    pub process: Option<ProcessPreview>,
    pub live: Option<LivePreview>,
    pub output: Option<OutputPreview>,
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
pub(crate) struct MixingPreview {
    before: MixingSummary,
    after: MixingSummary,
    missing_devices: Vec<String>,
    missing_plugins: Vec<String>,
    plugin_state_changed: bool,
    missing_device_labels: Vec<PreviewDeviceLabel>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MixingSummary {
    input: Option<crate::audio_engine::mixing::Config>,
    input_device_name: Option<String>,
    post_mix: MixingPostSummary,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MixingPostSummary {
    enabled: bool,
    plugins: Vec<crate::audio::post_mix::SavedPlugin>,
}
// 表示名は識別に使わない。IDの一致が一意な機器だけを現在名へ解決する。
fn preview_device_name(
    devices: &[audio::AudioDevice],
    host: Option<&str>,
    id: Option<&str>,
    saved_name: Option<&str>,
) -> Option<String> {
    let id = id?;
    let mut matches = devices.iter().filter(|device| {
        device.id.as_deref() == Some(id)
            && host.is_none_or(|host| device.host.eq_ignore_ascii_case(host))
    });
    match (matches.next(), matches.next()) {
        (Some(device), None) => Some(device.name.as_str()),
        (None, _) => saved_name,
        _ => None,
    }
    .filter(|name| !name.trim().is_empty())
    .map(str::to_owned)
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewDeviceLabel {
    // 欠落判定用のIDと、翻訳する用途・任意の機器名を分ける。
    #[serde(skip)]
    id: String,
    role: &'static str,
    name: Option<String>,
}
fn mixing_summary(
    value: &bundle::MixingConfiguration,
    devices: &audio::AudioDeviceList,
) -> MixingSummary {
    let input_device_name = value.input.as_ref().and_then(|input| match &input.source {
        crate::audio_engine::mixing::Source::Device(device) => preview_device_name(
            &devices.inputs,
            Some(&device.host),
            Some(&device.input_id),
            None,
        ),
        crate::audio_engine::mixing::Source::ProcessLoopback(_) => None,
    });
    MixingSummary {
        input: value.input.clone(),
        input_device_name,
        post_mix: MixingPostSummary {
            enabled: value.post_mix.enabled,
            plugins: value.post_mix.plugins.iter().map(Into::into).collect(),
        },
    }
}
fn mixing_preview(
    current: &bundle::MixingConfiguration,
    target: &bundle::MixingConfiguration,
    devices: &audio::AudioDeviceList,
    missing_plugins: Vec<String>,
) -> MixingPreview {
    use crate::audio_engine::mixing::Source;
    let missing_device_labels: Vec<PreviewDeviceLabel> = target
        .input
        .as_ref()
        .map(|input| {
            let (list, id, role) = match &input.source {
                Source::Device(device) => (
                    &devices.inputs,
                    device.input_id.clone(),
                    "accompanimentInput",
                ),
                Source::ProcessLoopback(process) => (
                    &devices.outputs,
                    format!("wasapi:{}", process.raw_endpoint_id),
                    "originalOutput",
                ),
            };
            if list
                .iter()
                .filter(|d| d.host.eq_ignore_ascii_case("wasapi") && d.id.as_ref() == Some(&id))
                .count()
                == 1
            {
                vec![]
            } else {
                vec![PreviewDeviceLabel {
                    name: preview_device_name(list, Some("wasapi"), Some(&id), None),
                    id,
                    role,
                }]
            }
        })
        .unwrap_or_default();
    MixingPreview {
        before: mixing_summary(current, devices),
        after: mixing_summary(target, devices),
        missing_devices: missing_device_labels
            .iter()
            .map(|device| device.id.clone())
            .collect(),
        missing_device_labels,
        missing_plugins,
        plugin_state_changed: current.post_mix.plugins.iter().map(|p| &p.state).ne(target
            .post_mix
            .plugins
            .iter()
            .map(|p| &p.state)),
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessPreview {
    before: Option<bundle::ProcessConfiguration>,
    after: bundle::ProcessConfiguration,
    selection_matches: bool,
    missing_devices: Vec<String>,
    missing_plugins: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LivePreview {
    before: Option<LiveSummary>,
    after: LiveSummary,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveSummary {
    definitions: crate::audio_engine::live_modes::Definitions,
    target: Option<crate::audio_engine::live_modes::Mode>,
    monitor: Option<crate::audio_engine::split_monitor::State>,
    singing_plugins: Option<usize>,
    talk_plugins: Option<usize>,
}
impl From<&bundle::LiveConfiguration> for LiveSummary {
    fn from(value: &bundle::LiveConfiguration) -> Self {
        Self {
            definitions: value.definitions.clone(),
            target: value.target,
            monitor: value.monitor.clone(),
            singing_plugins: value.singing_plugins.as_ref().map(Vec::len),
            talk_plugins: value.talk_plugins.as_ref().map(Vec::len),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputPreview {
    before: Option<crate::audio_engine::live_output::Config>,
    after: crate::audio_engine::live_output::Config,
    before_device_name: Option<String>,
    after_device_name: Option<String>,
    missing_device_labels: Vec<PreviewDeviceLabel>,
    restart_required: bool,
    missing_devices: Vec<String>,
    missing_plugins: Vec<String>,
}
fn build_output_preview(
    current: Option<&bundle::OutputConfiguration>,
    bundle: &BundleV1,
    devices: &audio::AudioDeviceList,
    missing_plugins: Vec<String>,
) -> Option<OutputPreview> {
    let output = bundle.output.as_ref()?;
    let missing_device_labels = missing_output_device_labels(bundle, devices);
    Some(OutputPreview {
        before: current.map(|o| o.config.clone()),
        after: output.config.clone(),
        before_device_name: preview_device_name(
            &devices.outputs,
            Some("wasapi"),
            current.and_then(|o| o.config.device_id.as_deref()),
            None,
        ),
        after_device_name: preview_device_name(
            &devices.outputs,
            Some("wasapi"),
            output.config.device_id.as_deref(),
            None,
        ),
        restart_required: true,
        missing_devices: missing_device_labels
            .iter()
            .map(|device| device.id.clone())
            .collect(),
        missing_device_labels,
        missing_plugins,
    })
}
fn missing_output_plugins(bundle: &BundleV1) -> Result<Vec<String>, String> {
    let mut missing = Vec::new();
    let bound = bundle
        .live
        .iter()
        .flat_map(|live| [&live.singing_plugins, &live.talk_plugins])
        .flatten()
        .flatten();
    let post = bundle.mixing.iter().flat_map(|mix| &mix.post_mix.plugins);
    for plugin in bundle
        .embedded_auralyn_preset
        .plugins
        .iter()
        .chain(bound)
        .chain(post)
    {
        match std::path::Path::new(&plugin.path).try_exists() {
            Ok(true) => {}
            Ok(false) => missing.push(plugin.name.clone()),
            Err(_) => {
                return Err("VSTファイルを確認できません。アクセス権を確認してください".into())
            }
        }
    }
    Ok(missing)
}
fn missing_output_device_labels(
    bundle: &BundleV1,
    devices: &audio::AudioDeviceList,
) -> Vec<PreviewDeviceLabel> {
    let Some(output) = &bundle.output else {
        return vec![];
    };
    let mut missing = Vec::new();
    let saved = bundle.embedded_auralyn_preset.audio_config.as_ref();
    for (list, id, role, saved_name) in [
        (
            &devices.inputs,
            &output.devices.input_id,
            "primaryInput",
            saved.and_then(|config| config.input_device.as_deref()),
        ),
        (
            &devices.outputs,
            &output.devices.output_id,
            "primaryOutput",
            saved.and_then(|config| config.output_device.as_deref()),
        ),
    ] {
        if list
            .iter()
            .filter(|device| device.id.as_ref() == Some(id))
            .count()
            != 1
        {
            missing.push(PreviewDeviceLabel {
                id: id.clone(),
                role,
                name: preview_device_name(list, None, Some(id), saved_name),
            });
        }
    }
    if let Some(id) = &output.config.device_id {
        if devices
            .outputs
            .iter()
            .filter(|device| {
                device.host.eq_ignore_ascii_case("wasapi") && device.id.as_ref() == Some(id)
            })
            .count()
            != 1
        {
            missing.push(PreviewDeviceLabel {
                id: id.clone(),
                role: "broadcastOutput",
                name: preview_device_name(&devices.outputs, Some("wasapi"), Some(id), None),
            });
        }
    }
    missing
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
        #[serde(default)]
        include_output: bool,
        #[serde(default)]
        include_live: bool,
        #[serde(default)]
        include_process: bool,
        #[serde(default)]
        include_mixing: bool,
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
    RecoveryStatus,
    RecoveryPreview,
    RecoveryApply {
        id: String,
    },
    RecoveryResolve {
        id: Option<String>,
    },
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
    include_output: bool,
    include_live: bool,
    include_process: bool,
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
        if include_process {
            host.process_snapshot_supported()
        } else if include_live {
            host.full_snapshot_supported()
        } else if include_output {
            host.output_snapshot_supported()
        } else {
            host.checked_snapshot_supported()
        }
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
    Recovery(Option<RecoveryView>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryView {
    pub id: Option<String>,
    pub readable: bool,
    pub runtime_checkpoint: bool,
}

fn recovery_view(root: &std::path::Path) -> Result<Option<RecoveryView>, String> {
    if !bundle::recovery_exists(root)? {
        return Ok(None);
    }
    match bundle::read_recovery(root) {
        Ok(Some(receipt)) => {
            let readable = bundle::load_recovery_backup(root, &receipt).is_ok();
            Ok(Some(RecoveryView {
                runtime_checkpoint: receipt.runtime.is_some(),
                id: Some(receipt.backup_name),
                readable,
            }))
        }
        _ => Ok(Some(RecoveryView {
            id: None,
            readable: false,
            runtime_checkpoint: false,
        })),
    }
}

// 保存対象と同じsource/propertyを、変更前に再取得して原本へ含める。
fn recovery_obs_selection(saved: &obs_setup::bundle::Saved) -> Vec<obs_setup::bundle::Selection> {
    use obs_setup::bundle::{Property, Selection};
    let mut sources = std::collections::BTreeMap::<String, Selection>::new();
    for item in &saved.items {
        let selection = sources
            .entry(item.source.clone())
            .or_insert_with(|| Selection {
                source: item.source.clone(),
                volume: false,
                muted: false,
                monitor: false,
                filters: vec![],
            });
        match &item.property {
            Property::Volume => selection.volume = true,
            Property::Muted => selection.muted = true,
            Property::Monitor => selection.monitor = true,
            Property::FilterEnabled { name, .. } => selection.filters.push(name.clone()),
        }
    }
    sources.into_values().collect()
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
    OutputRouting,
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
            Self::OutputRouting => "bundle.field.outputRouting",
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
fn output_routing_text(routing: crate::ipc::OutputRouting) -> String {
    match routing {
        crate::ipc::OutputRouting::Legacy => "従来の接続".into(),
        crate::ipc::OutputRouting::Insert => "入力と同じチャンネル".into(),
        crate::ipc::OutputRouting::Independent { channels } => {
            format!(
                "出力 {} / {}",
                channels[0].saturating_add(1),
                channels[1].saturating_add(1)
            )
        }
    }
}
fn output_routing_ui_text(routing: crate::ipc::OutputRouting, fallback: &str) -> UiText {
    match routing {
        crate::ipc::OutputRouting::Legacy => UiText::new("bundle.value.outputLegacy", fallback),
        crate::ipc::OutputRouting::Insert => UiText::new("bundle.value.outputInsert", fallback),
        crate::ipc::OutputRouting::Independent { channels } => {
            UiText::new("bundle.value.outputIndependent", fallback)
                .number("left", channels[0].saturating_add(1) as f64)
                .number("right", channels[1].saturating_add(1) as f64)
        }
    }
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
        DiffField::OutputRouting => (
            Some(output_routing_ui_text(before.engine.output_routing, old)),
            audio.map(|v| output_routing_ui_text(v.output_routing, new)),
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
    row(
        DiffField::OutputRouting,
        "出力チャンネル",
        selected,
        Some(output_routing_text(before.engine.output_routing)),
        audio
            .map(|c| output_routing_text(c.output_routing))
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
    let (mixing, mixing_revision) = host.capture_bundle_mixing().map_err(|e| e.to_string())?;
    witness.validate()?;
    let active = host.get_state().config;
    let (process, process_target) = host
        .capture_bundle_process()
        .map_err(|e| e.to_string())?
        .map_or((None, None), |(process, target)| {
            (Some(process), Some(target))
        });
    let (output_config, output_revision) = host
        .capture_bundle_output(engine.running)
        .map_err(|e| e.to_string())?;
    witness.validate()?;
    let output = active_devices(active.as_ref()).map(|devices| bundle::OutputConfiguration {
        version: 1,
        devices,
        config: output_config,
    });
    let (live, live_revision) = if let Some(output) = &output {
        let (live, revision) = host
            .capture_bundle_live(output)
            .map_err(|e| e.to_string())?;
        if !live.matches_builtin(&engine.builtin) {
            return Err("本番モードと内蔵処理の反映完了を待ってください".into());
        }
        witness.validate()?;
        (Some(live), revision)
    } else {
        (None, "absent".into())
    };
    let audio_config = active.clone().and_then(|c| {
        engine.fixed_buffer_request_frames?;
        Some(ProfileAudioConfig {
            host: c.host,
            input_device: c.input,
            output_device: c.output,
            sample_rate: c.sample_rate?,
            buffer_size: c.buffer_size?,
            input_channels: engine.input_channels.clone(),
            output_routing: engine.output_routing,
            input_gain_db: linear_db(engine.input_gain),
            master_gain_db: linear_db(engine.output_gain),
        })
    });
    let preset = Preset {
        plugins_included: Some(true),
        schema_version: 2,
        name: "配信状態".into(),
        plugins: engine.plugins.iter().map(|p| p.plugin.clone()).collect(),
        audio_config,
        noise_control: Some(engine.noise.clone()),
        builtin_fx: Some(engine.builtin.clone()),
    };
    Ok((
        Captured {
            mixing,
            mixing_revision,
            process,
            process_target,
            live,
            live_revision,
            engine,
            preset,
            active,
            output,
            output_revision,
        },
        witness,
    ))
}

/// 通常設定の原本領域に退避し、既存の手動復旧だけから取り出す。音声は変更しない。
pub(crate) fn preserve_temporary_runtime(
    root: &std::path::Path,
    host: &mut audio::AudioHost,
) -> Result<(), String> {
    if bundle::recovery_exists(root)? {
        return Err("未解決の復旧原本があります。先に確認してください".into());
    }
    host.preflight_runtime_checkpoint()
        .map_err(|e| e.to_string())?;
    let initial = host.conditions().control_snapshot()?;
    let name = format!("runtime-{}", bundle::revision());
    let (mixing, initial_mixing_revision) =
        host.capture_bundle_mixing().map_err(|e| e.to_string())?;
    let reservation = if mixing.is_some() {
        let devices = active_devices(host.get_state().config.as_ref())
            .ok_or("元の入出力機器IDを確認できません。退避せず、現在の音声を維持しています")?;
        bundle::reserve_mixing_runtime_intent(root, &name, devices, initial.engine_epoch())?
    } else if host
        .capture_bundle_process()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        bundle::reserve_process_runtime_intent(root, &name, initial.engine_epoch())?
    } else {
        let devices = active_devices(host.get_state().config.as_ref())
            .ok_or("元の入出力機器IDを確認できません。退避せず、現在の音声を維持しています")?;
        bundle::reserve_runtime_intent(root, &name, devices, initial.engine_epoch())?
    };
    let (before, witness) = capture(host)?;
    let (after, _) = capture(host)?;
    initial.validate()?;
    witness.validate()?;
    if mixing != before.mixing
        || initial_mixing_revision != before.mixing_revision
        || !unchanged(&before, &after)
    {
        return Err("取得中に設定またはVSTが変わりました。現在の音声を維持しています".into());
    }
    let categories = ProfileSaveCategories {
        include_plugins: true,
        include_audio_config: true,
        include_noise_control: true,
        include_builtin_fx: true,
    };
    let extended = before.process.is_none()
        && (before.mixing.is_some()
            || before
                .output
                .as_ref()
                .is_some_and(|o| o.config != Default::default())
            || before.live.as_ref().is_some_and(|live| {
                live.target.is_some() || live.definitions != Default::default()
            }));
    let original = BundleV1 {
        mixing: before.mixing.clone(),
        process: before.process.clone(),
        live: if extended {
            Some(before.live.clone().ok_or("本番設定を退避できません")?)
        } else {
            None
        },
        output: if extended {
            Some(before.output.clone().ok_or("出力構成を退避できません")?)
        } else {
            None
        },
        schema_version: if before.mixing.is_some() {
            5
        } else if before.process.is_some() {
            4
        } else if extended {
            3
        } else {
            1
        },
        revision: bundle::revision(),
        name,
        categories: categories.clone(),
        confirmation: None,
        level_intent: Some(bundle::LevelIntent {
            input_gain: before.engine.input_gain,
            output_gain: before.engine.output_gain,
        }),
        embedded_auralyn_preset: select(before.preset, &categories)?,
        obs: None,
    };
    bundle::finish_runtime_recovery(root, &original, reservation, before.engine.control_revision)?;
    // 保存中にStop等が要求された場合も、退避した原本を保持して再起動を拒否する。
    witness.validate()
}
fn empty_mixing() -> bundle::MixingConfiguration {
    bundle::MixingConfiguration {
        version: 1,
        input: None,
        post_mix: bundle::mixing_configuration::PostMixPreset {
            schema_version: 1,
            role: "post_mix".into(),
            enabled: false,
            plugins: vec![],
        },
    }
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
    before.mixing == after.mixing
        && before.mixing_revision == after.mixing_revision
        && before.engine == after.engine
        && before.process == after.process
        && before.process_target == after.process_target
        && before.live == after.live
        && before.live_revision == after.live_revision
        && before.output == after.output
        && before.output_revision == after.output_revision
        && before.preset == after.preset
        && before.active.as_ref().map(|a| (&a.input_id, &a.output_id))
            == after.active.as_ref().map(|a| (&a.input_id, &a.output_id))
}
fn complete(summary: &ApplyProfileSummary) -> bool {
    summary.missing_devices.is_empty()
        && summary.missing_plugins.is_empty()
        && summary.skipped_categories.is_empty()
}
fn validate_runtime_restore(before: &Captured) -> Result<(), String> {
    if !before.engine.running || !before.engine.global_mute {
        return Err("元の機器を明示開始してミュートし、差分を取り直してください。復帰後もミュートを維持します".into());
    }
    Ok(())
}
fn validate_output_devices(
    target: &BundleV1,
    current: &Captured,
    devices: &audio::AudioDeviceList,
) -> Result<(), String> {
    let Some(output) = &target.output else {
        return Ok(());
    };
    validate_runtime_restore(current)?;
    let audio = target
        .embedded_auralyn_preset
        .audio_config
        .as_ref()
        .ok_or("入出力設定がありません")?;
    if active_devices(current.active.as_ref()).as_ref() != Some(&output.devices)
        || !current.active.as_ref().is_some_and(|a| {
            a.host.eq_ignore_ascii_case(&audio.host)
                && a.input == audio.input_device
                && a.output == audio.output_device
        })
        || !recovery_device_matches(
            &devices.inputs,
            &audio.host,
            &audio.input_device,
            &output.devices.input_id,
        )
        || !recovery_device_matches(
            &devices.outputs,
            &audio.host,
            &audio.output_device,
            &output.devices.output_id,
        )
        || output.config.device_id.as_ref().is_some_and(|id| {
            devices
                .outputs
                .iter()
                .filter(|d| d.host.eq_ignore_ascii_case("wasapi") && d.id.as_ref() == Some(id))
                .count()
                != 1
        })
    {
        return Err(
            "保存した主入出力と配信用出力をIDで特定できません。機器を明示選択してください".into(),
        );
    }
    Ok(())
}
fn missing_process_devices(
    saved: &bundle::ProcessConfiguration,
    devices: &audio::AudioDeviceList,
) -> Vec<String> {
    [
        &saved.output_id,
        &format!("wasapi:{}", saved.source.raw_endpoint_id),
    ]
    .into_iter()
    .filter(|id| {
        devices
            .outputs
            .iter()
            .filter(|d| d.host.eq_ignore_ascii_case("wasapi") && d.id.as_ref() == Some(*id))
            .count()
            != 1
    })
    .cloned()
    .collect()
}
fn validate_process_selection(
    target: &BundleV1,
    current: &Captured,
    devices: &audio::AudioDeviceList,
) -> Result<(), String> {
    let Some(saved) = &target.process else {
        if target.categories.include_audio_config && current.process.is_some() {
            return Err(
                "現在の入力はプロセス入力です。プロセス設定を含む保存形式を使用してください".into(),
            );
        }
        return Ok(());
    };
    validate_runtime_restore(current)?;
    let audio = target
        .embedded_auralyn_preset
        .audio_config
        .as_ref()
        .ok_or("返し先の設定がありません")?;
    if current.process.as_ref() != Some(saved)
        || current.process_target.is_none()
        || !current.active.as_ref().is_some_and(|a| {
            a.host.eq_ignore_ascii_case(&audio.host)
                && a.input.is_none()
                && a.output == audio.output_device
        })
        || !missing_process_devices(saved, devices).is_empty()
    {
        return Err("保存したアプリ・用途・原音用出力・返し先と現在の明示選択が異なります。音声設定で選び直してください".into());
    }
    Ok(())
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

fn builtin_matches(expected: &ProfileBuiltinFx, actual: &ProfileBuiltinFx) -> bool {
    // apply_profileが旧省略形式を既定値で設定する場合と同じ意味で照合する。
    // 無効な処理でも、既定値と異なる保持パラメーターの差は省略しない。
    expected.enabled == actual.enabled
        && expected.preset == actual.preset
        && expected.amount == actual.amount
        && expected.reverb.unwrap_or_default() == actual.reverb.unwrap_or_default()
        && if expected.preset == "singing" {
            expected.singing.unwrap_or_default() == actual.singing.unwrap_or_default()
        } else {
            expected.singing == actual.singing
        }
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
                && current.output_routing == audio.output_routing
        })
    } else {
        true
    };
    let level_matches = target.level_intent.as_ref().is_none_or(|level| {
        level.input_gain == after.engine.input_gain && level.output_gain == after.engine.output_gain
    });
    target.mixing.as_ref().is_none_or(|mixing| {
        after
            .mixing
            .as_ref()
            .map_or_else(|| *mixing == empty_mixing(), |actual| actual == mixing)
    }) && target
        .process
        .as_ref()
        .is_none_or(|process| after.process.as_ref() == Some(process))
        && target
            .live
            .as_ref()
            .is_none_or(|live| after.live.as_ref() == Some(live))
        && target
            .output
            .as_ref()
            .is_none_or(|output| after.output.as_ref() == Some(output))
        && plugins_match
        && audio_matches
        && level_matches
        && preset
            .noise_control
            .as_ref()
            .is_none_or(|noise| *noise == after.engine.noise)
        && preset
            .builtin_fx
            .as_ref()
            .is_none_or(|fx| builtin_matches(fx, &after.engine.builtin))
}

fn validate_mixing_selection(target: &BundleV1, before: &Captured) -> Result<(), String> {
    if target.mixing.is_none() && before.mixing.is_some() {
        return Err(
            "現在のミックスを退避できない保存形式です。ミックスを含む配信状態を使用してください"
                .into(),
        );
    }
    if let Some(mixing) = &target.mixing {
        validate_runtime_restore(before)?;
        if let Some(input) = &mixing.input {
            if before
                .mixing
                .as_ref()
                .and_then(|m| m.input.as_ref())
                .is_none_or(|current| current.source != input.source)
            {
                return Err(
                    "保存したオケの入力元を現在の音声で明示選択してから、差分を取り直してください"
                        .into(),
                );
            }
        }
    }
    Ok(())
}
fn apply_selected(
    root: &std::path::Path,
    host: &mut audio::AudioHost,
    target: &BundleV1,
    before: &Captured,
    device_ids: Option<bundle::RecoveryDevices>,
) -> Result<ApplyProfileSummary, String> {
    validate_mixing_selection(target, before)?;
    if let Some(mixing) = &target.mixing {
        validate_runtime_restore(before)?;
        if target.output.is_none()
            || target.live.is_none()
            || !target.categories.include_plugins
            || target.embedded_auralyn_preset.audio_config.is_none()
        {
            return Err("ミックスの復帰範囲を確認できません".into());
        }
        return host.with_bundle_mixing(mixing, &before.mixing_revision, |host| {
            let prepared = host
                .stage_bundle_voice(&target.embedded_auralyn_preset.plugins)
                .map_err(|e| e.to_string())?;
            apply_selected_without_mixing(root, host, target, before, device_ids, Some(&prepared))
        });
    }
    apply_selected_without_mixing(root, host, target, before, device_ids, None)
}
fn apply_selected_without_mixing(
    root: &std::path::Path,
    host: &mut audio::AudioHost,
    target: &BundleV1,
    before: &Captured,
    device_ids: Option<bundle::RecoveryDevices>,
    prepared: Option<&[LoadedPluginInstance]>,
) -> Result<ApplyProfileSummary, String> {
    if let Some(process) = &target.process {
        let audio = target
            .embedded_auralyn_preset
            .audio_config
            .as_ref()
            .ok_or("入出力設定がありません")?;
        let initial = selected_start_intent(target, before)?;
        return host.process_bundle_scope(&before.output_revision, |host| {
            host.start_bundle_process(process, audio, initial)
                .map_err(|e| e.to_string())?;
            let mut restarted = before.clone();
            restarted.engine.plugins.clear();
            restarted.preset.plugins.clear();
            restarted.engine.input_channels = audio.input_channels.clone();
            restarted.engine.output_routing = audio.output_routing;
            // 機器入力だけを扱う既存profileの開始経路へ戻さず、音作りの共通処理を使う。
            let mut sound = target.clone();
            sound.embedded_auralyn_preset.audio_config = None;
            let mut summary = apply_selected_core(root, host, &sound, &restarted, None, None)?;
            if !complete(&summary) {
                return Err(
                    "プロセス入力のVST・処理をすべて復帰できません。停止し原本を保持しています"
                        .into(),
                );
            }
            let mut applied_audio = audio.clone();
            applied_audio.input_gain_db = linear_db(initial.input_gain);
            applied_audio.master_gain_db = linear_db(initial.output_gain);
            summary.applied_audio_config = Some(applied_audio);
            summary.applied_categories.push("audioConfig".into());
            summary.needs_engine_restart = true;
            Ok(summary)
        });
    }
    if let Some(live) = &target.live {
        let output = target.output.as_ref().ok_or("出力構成がありません")?;
        return host.with_bundle_live(live, output, &before.live_revision, |host| {
            apply_selected_output(root, host, target, before, device_ids, prepared)
        });
    }
    apply_selected_output(root, host, target, before, device_ids, prepared)
}
fn apply_selected_output(
    root: &std::path::Path,
    host: &mut audio::AudioHost,
    target: &BundleV1,
    before: &Captured,
    device_ids: Option<bundle::RecoveryDevices>,
    prepared: Option<&[LoadedPluginInstance]>,
) -> Result<ApplyProfileSummary, String> {
    if let Some(output) = &target.output {
        let audio = target
            .embedded_auralyn_preset
            .audio_config
            .as_ref()
            .ok_or("入出力設定がありません")?;
        let initial = selected_start_intent(target, before)?;
        return host.with_bundle_output(
            &output.config,
            &before.output_revision,
            target.live.is_some(),
            |host| {
                // 出力ファイルの旧値を使わず、最初のcallbackから現在のミュートを保持する。
                let started = host
                    .start_bundle_with_device_ids(
                        Some(audio.host.clone()),
                        audio.input_device.clone(),
                        audio.output_device.clone(),
                        Some(audio.buffer_size),
                        Some(audio.sample_rate),
                        initial,
                        Some(output.devices.input_id.clone()),
                        Some(output.devices.output_id.clone()),
                    )
                    .map_err(|e| e.to_string())?;
                if prepared.is_some() {
                    let actual = host.get_state().config;
                    let stats = host.get_engine_runtime_stats().map_err(|e| e.to_string())?;
                    let routing = started.routing.or_else(|| {
                        stats
                            .preparation
                            .as_ref()
                            .map(|p| crate::ipc::ChannelRouting {
                                input_channels: Some(p.input_channels),
                                output_routing: p.output_routing,
                            })
                    });
                    if !prepared_start_matches(
                        &started,
                        actual.as_ref(),
                        routing,
                        audio,
                        &output.devices,
                        initial,
                    ) {
                        return Err(
                            "準備した声VSTの入出力が一致しません。音声を停止して原本を保持します"
                                .into(),
                        );
                    }
                }
                let mut restarted = before.clone();
                restarted.engine.plugins.clear();
                restarted.preset.plugins.clear();
                let mut summary = apply_selected_core(
                    root,
                    host,
                    target,
                    &restarted,
                    Some(output.devices.clone()),
                    prepared,
                )?;
                if !complete(&summary) {
                    return Err(
                        "VST・入出力をすべて復帰できません。音声を停止し原本を保持しています"
                            .into(),
                    );
                }
                summary.needs_engine_restart = true;
                Ok(summary)
            },
        );
    }
    if prepared.is_some() {
        return Err("準備済みVSTの出力構成がありません".into());
    }
    apply_selected_core(root, host, target, before, device_ids, None)
}

fn prepared_start_matches(
    started: &audio::AudioConfig,
    actual: Option<&audio::ActiveAudioConfig>,
    routing: Option<crate::ipc::ChannelRouting>,
    expected: &ProfileAudioConfig,
    devices: &bundle::RecoveryDevices,
    initial: profile::StartIntent,
) -> bool {
    let Some(actual) = actual else {
        return false;
    };
    !crate::vst_host::presets::audio_config_differs(
        Some(&actual.host),
        actual.input.as_deref(),
        actual.output.as_deref(),
        actual.buffer_size,
        actual.sample_rate,
        expected,
    ) && actual.input_id.as_ref() == Some(&devices.input_id)
        && actual.output_id.as_ref() == Some(&devices.output_id)
        && started.sample_rate == expected.sample_rate
        && started.buffer_size == expected.buffer_size
        && routing
            == Some(crate::ipc::ChannelRouting {
                input_channels: Some(initial.input_channels),
                output_routing: initial.output_routing,
            })
}

// mixed 復帰では声ラックと入出力の開始は完了済み。共通処理による再起動・再読込を防ぐ。
fn restore_profile(target: &BundleV1, prepared: bool) -> Preset {
    let mut profile = target.embedded_auralyn_preset.clone();
    if prepared {
        profile.plugins.clear();
        profile.audio_config = None;
    }
    profile
}

fn add_prepared_summary(
    summary: &mut ApplyProfileSummary,
    target: &BundleV1,
    prepared: &[LoadedPluginInstance],
    initial: profile::StartIntent,
) -> Result<(), String> {
    let plugins = &target.embedded_auralyn_preset.plugins;
    if plugins.len() != prepared.len()
        || plugins
            .iter()
            .zip(prepared)
            .any(|(expected, actual)| expected.path != actual.path)
    {
        return Err("準備した声VSTの構成を確認できません".into());
    }
    let mut audio = target
        .embedded_auralyn_preset
        .audio_config
        .clone()
        .ok_or("入出力設定がありません")?;
    audio.input_gain_db = linear_db(initial.input_gain);
    audio.master_gain_db = linear_db(initial.output_gain);
    summary.applied_audio_config = Some(audio);
    summary.applied_categories.push("audioConfig".into());
    summary.applied_plugins = plugins.clone();
    summary.loaded_plugin_instances = prepared.to_vec();
    summary.applied_categories.push("plugins".into());
    Ok(())
}

fn apply_selected_core(
    root: &std::path::Path,
    host: &mut audio::AudioHost,
    target: &BundleV1,
    before: &Captured,
    device_ids: Option<bundle::RecoveryDevices>,
    prepared: Option<&[LoadedPluginInstance]>,
) -> Result<ApplyProfileSummary, String> {
    let ids = before
        .engine
        .plugins
        .iter()
        .map(|p| p.id.clone())
        .collect::<Vec<_>>();
    let replace_empty = prepared.is_none()
        && target.categories.include_plugins
        && target.embedded_auralyn_preset.plugins.is_empty();
    let profile = restore_profile(target, prepared.is_some());
    // 明示emptyとカテゴリ不在を混同しない。既存profileのlegacy意味は変えない。
    if replace_empty {
        host.unload_all_plugins(&ids).map_err(|e| e.to_string())?;
    }
    let initial = selected_start_intent(target, before)?;
    let mut summary = profile::apply_profile_with_start_intent_and_ids(
        root,
        host,
        &profile,
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
        device_ids.map(|ids| (ids.input_id, ids.output_id)),
    )?;
    if replace_empty {
        summary.applied_categories.push("plugins".into());
    }
    if let Some(prepared) = prepared {
        add_prepared_summary(&mut summary, target, prepared, initial)?;
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

fn selected_start_intent(
    target: &BundleV1,
    before: &Captured,
) -> Result<profile::StartIntent, String> {
    let level = target.level_intent.as_ref();
    let audio = target.embedded_auralyn_preset.audio_config.as_ref();
    let channels = audio.map_or(before.engine.input_channels.as_slice(), |c| {
        c.input_channels.as_slice()
    });
    Ok(profile::StartIntent {
        input_gain: level.map_or(before.engine.input_gain, |l| l.input_gain),
        output_gain: level.map_or(before.engine.output_gain, |l| l.output_gain),
        input_channels: [
            *channels.first().ok_or("入力チャンネルが不正です")?,
            *channels.get(1).ok_or("入力チャンネルが不正です")?,
        ],
        output_routing: audio.map_or(before.engine.output_routing, |c| c.output_routing),
        muted: before.engine.global_mute,
        bypassed: before.engine.global_bypass,
    })
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
        Request::RecoveryStatus => Ok(Response::Recovery(recovery_view(&root)?)),
        Request::RecoveryResolve { id } => {
            bundle::resolve_recovery(&root, id.as_deref())?;
            session.history = None;
            session.preview = None;
            Ok(Response::Recovery(None))
        }
        Request::Save {
            name,
            overwrite,
            categories,
            obs: selection,
            checked,
            include_output,
            include_live,
            include_process,
            include_mixing,
        } => {
            if include_mixing && (!include_output || !include_live || include_process) {
                return Err("ミックスの保存には出力構成と本番モード、全カテゴリが必要です".into());
            }
            if include_process && (include_output || include_live) {
                return Err("プロセス入力と処理分離・本番モードの同時保存には未対応です".into());
            }
            if include_live && !include_output {
                return Err("本番モードの保存には出力構成も含めてください".into());
            }
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
                validate_checked(
                    host.clone(),
                    claim,
                    include_output,
                    include_live,
                    include_process,
                )
                .await?;
            }
            let (captured, witness) = capture_async(host.clone()).await?;
            if captured.mixing.is_some() && !include_mixing {
                return Err("オケ・ミックス後VSTも保存することを選んでください。声用VSTだけの保存はプロファイルを使ってください".into());
            }
            if include_process {
                let source = host.clone();
                super::run_blocking(move || {
                    source
                        .lock()
                        .map_err(|_| "音声状態を取得できません")?
                        .process_snapshot_supported()
                        .map_err(|e| e.to_string())
                })
                .await?;
            } else if categories.include_audio_config && captured.process.is_some() {
                return Err("プロセス入力の設定も保存することを選んでください".into());
            }
            if include_output {
                let c = &categories;
                if !(c.include_plugins
                    && c.include_audio_config
                    && c.include_noise_control
                    && c.include_builtin_fx)
                {
                    return Err("分離出力の保存には全カテゴリが必要です".into());
                }
                let source = host.clone();
                super::run_blocking(move || {
                    let mut host = source.lock().map_err(|_| "音声状態を取得できません")?;
                    if include_live {
                        host.full_snapshot_supported()
                    } else {
                        host.output_snapshot_supported()
                    }
                    .map_err(|e| e.to_string())
                })
                .await?;
            } else if categories.include_audio_config
                && captured
                    .output
                    .as_ref()
                    .is_some_and(|output| output.config != Default::default())
            {
                return Err("分離出力の設定も保存することを選んでください。出力構成を省略して保存できません".into());
            }
            if !include_live
                && captured
                    .live
                    .as_ref()
                    .is_some_and(|live| live.target.is_some())
            {
                return Err("歌／雑談モードも保存することを選んでください".into());
            }
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
                validate_checked(host, claim, include_output, include_live, include_process)
                    .await?;
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
                mixing: if include_mixing {
                    Some(captured.mixing.clone().unwrap_or_else(empty_mixing))
                } else {
                    None
                },
                process: if include_process {
                    Some(
                        captured
                            .process
                            .clone()
                            .ok_or("プロセス入力の実値を取得できません")?,
                    )
                } else {
                    None
                },
                live: if include_live {
                    Some(captured.live.clone().ok_or("本番モードを取得できません")?)
                } else {
                    None
                },
                output: if include_output {
                    Some(
                        captured
                            .output
                            .clone()
                            .ok_or("主入出力の機器IDを取得できません")?,
                    )
                } else {
                    None
                },
                confirmation,
                schema_version: if include_mixing {
                    5
                } else if include_process {
                    4
                } else if include_live {
                    3
                } else if include_output {
                    2
                } else {
                    1
                },
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
        request @ (Request::Preview { .. } | Request::RecoveryPreview) => {
            session.preview = None;
            let (bundle, recovery_id) = match request {
                Request::Preview { name } => (bundle::load(&root, &name)?, None),
                Request::RecoveryPreview => {
                    let receipt = bundle::read_recovery(&root)?.ok_or("復旧原本がありません")?;
                    let original = bundle::load_recovery_backup(&root, &receipt)?;
                    (original, Some(receipt.backup_name))
                }
                _ => unreachable!(),
            };
            let (before, witness) = capture_async(host.clone()).await?;
            let process_preview = if let Some(process) = &bundle.process {
                let devices = super::audio::enumerate_devices_async(host.clone(), true).await?;
                Some(ProcessPreview {
                    before: before.process.clone(),
                    after: process.clone(),
                    selection_matches: before.process.as_ref() == Some(process),
                    missing_devices: missing_process_devices(process, &devices),
                    missing_plugins: missing_output_plugins(&bundle)?,
                })
            } else {
                None
            };
            let output_preview = if bundle.output.is_some() {
                let devices = super::audio::enumerate_devices_async(host.clone(), true).await?;
                build_output_preview(
                    before.output.as_ref(),
                    &bundle,
                    &devices,
                    missing_output_plugins(&bundle)?,
                )
            } else {
                None
            };
            let mixing_preview = if let Some(mixing) = &bundle.mixing {
                let devices = super::audio::enumerate_devices_async(host.clone(), true).await?;
                Some(mixing_preview(
                    &before.mixing.clone().unwrap_or_else(empty_mixing),
                    mixing,
                    &devices,
                    missing_output_plugins(&bundle)?,
                ))
            } else {
                None
            };
            let obs_plan = if let Some(saved) = &bundle.obs {
                Some(obs_setup::bundle::preview(&obs, saved).await?)
            } else {
                None
            };
            witness.validate()?;
            let view = PreviewView {
                mixing: mixing_preview,
                process: process_preview,
                live: bundle.live.as_ref().map(|live| LivePreview {
                    before: before.live.as_ref().map(Into::into),
                    after: live.into(),
                }),
                output: output_preview,
                id: bundle::revision(),
                name: bundle.name.clone(),
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
                recovery_id,
            });
            Ok(Response::Preview(Box::new(view)))
        }
        request @ (Request::Apply { .. } | Request::RecoveryApply { .. }) => {
            let (id, recovering) = match request {
                Request::Apply { id } => (id, false),
                Request::RecoveryApply { id } => (id, true),
                _ => unreachable!(),
            };
            if !recovering && bundle::recovery_exists(&root)? {
                return Err("未解決の配信状態の原本があります。先に確認してください".into());
            }
            if !recovering
                && session
                    .history
                    .as_ref()
                    .is_some_and(|h| blocks_next_apply(&h.result))
            {
                return Err("前の配信状態の復元候補を保持中です。先に元に戻してください".into());
            }
            let plan = session.preview.take().ok_or("差分を再確認してください")?;
            let receipt = if recovering {
                Some(bundle::read_recovery(&root)?.ok_or("復旧原本がありません")?)
            } else {
                None
            };
            let expected_recovery = receipt.as_ref().map(|r| r.backup_name.clone());
            let current_saved = if recovering {
                bundle::load_recovery_backup(
                    &root,
                    receipt.as_ref().ok_or("復旧原本がありません")?,
                )?
            } else {
                bundle::load(&root, &plan.bundle.name)?
            };
            validate_saved_preview(&plan, &id, &current_saved, expected_recovery.as_deref())?;
            if recovering
                && !plan.before.engine.running
                && plan.bundle.categories.include_audio_config
            {
                return Err("音声は停止中です。自動開始せず、設定を確認してください".into());
            }
            if recovering
                && plan.obs.as_ref().is_some_and(|obs| {
                    obs.changes.iter().any(|change| {
                        change.field_code == Some("obs.field.muted")
                            && change.before.as_bool() == Some(true)
                            && change.after.as_bool() == Some(false)
                    })
                })
            {
                return Err("現在のOBSミュートを解除する復元はできません。受け側と現在の状態を確認してください".into());
            }
            plan.witness.validate()?;
            if receipt
                .as_ref()
                .is_some_and(|receipt| receipt.runtime.is_some())
            {
                validate_runtime_restore(&plan.before)?;
                let check_host = host.clone();
                let include_process = plan.bundle.process.is_some();
                let include_live = plan.bundle.live.is_some();
                super::run_blocking(move || {
                    let mut host = check_host.lock().map_err(|_| "音声状態を取得できません")?;
                    if include_process {
                        host.process_snapshot_supported()
                    } else if include_live {
                        host.full_snapshot_supported()
                    } else {
                        host.checked_snapshot_supported()
                    }
                    .map_err(|e| e.to_string())
                })
                .await?;
            }
            if plan.bundle.confirmation.is_some()
                || plan.bundle.output.is_some()
                || plan.bundle.process.is_some()
            {
                let checked_host = host.clone();
                let include_output = plan.bundle.output.is_some();
                let include_live = plan.bundle.live.is_some();
                let include_process = plan.bundle.process.is_some();
                super::run_blocking(move || {
                    let mut host = checked_host
                        .lock()
                        .map_err(|_| "音声状態を取得できません")?;
                    if include_process {
                        host.process_snapshot_supported()
                    } else if include_live {
                        host.full_snapshot_supported()
                    } else if include_output {
                        host.output_snapshot_supported()
                    } else {
                        host.checked_snapshot_supported()
                    }
                    .map_err(|e| e.to_string())
                })
                .await?;
            }
            validate_mixing_selection(&plan.bundle, &plan.before)?;
            if plan.bundle.live.is_none()
                && plan
                    .before
                    .live
                    .as_ref()
                    .is_some_and(|live| live.target.is_some())
            {
                return Err("選択中の歌／雑談モードを退避できない形式です。本番モードを含めた保存形式を使用してください".into());
            }
            if plan.bundle.confirmation.is_some() && !plan.before.engine.global_mute {
                return Err("確認済み構成を呼び戻す前に緊急ミュートを有効にし、差分を取り直してください。復元後も確認するまでミュートを維持します".into());
            }
            if plan.bundle.categories.include_audio_config {
                let devices = super::audio::enumerate_devices_async(
                    host.clone(),
                    recovering || plan.bundle.output.is_some() || plan.bundle.process.is_some(),
                )
                .await?;
                validate_output_devices(&plan.bundle, &plan.before, &devices)?;
                validate_process_selection(&plan.bundle, &plan.before, &devices)?;
                if (plan.bundle.output.is_some() || plan.bundle.process.is_some())
                    && !missing_output_plugins(&plan.bundle)?.is_empty()
                {
                    return Err(
                        "保存したVSTが見つかりません。ファイルを確認して差分を取り直してください"
                            .into(),
                    );
                }
                if recovering && plan.bundle.process.is_none() {
                    let target = plan
                        .bundle
                        .embedded_auralyn_preset
                        .audio_config
                        .as_ref()
                        .ok_or("復元する入出力設定がありません")?;
                    let current = plan
                        .before
                        .active
                        .as_ref()
                        .ok_or("現在の入出力を確認できません")?;
                    if !current.host.eq_ignore_ascii_case(&target.host)
                        || current.input != target.input_device
                        || current.output != target.output_device
                    {
                        return Err("元の入出力機器を現在の設定と照合できません。先に機器を選び直してください".into());
                    }
                    let ids = receipt.as_ref().and_then(|r| r.devices.as_ref()).ok_or("復旧原本に機器IDがありません。機器を手動で確認し現在の設定を採用してください")?;
                    if active_devices(Some(current)).as_ref() != Some(ids) {
                        return Err(
                            "現在の機器IDが元の機器と異なります。機器を手動で確認してください"
                                .into(),
                        );
                    }
                    if !recovery_device_matches(
                        &devices.inputs,
                        &target.host,
                        &target.input_device,
                        &ids.input_id,
                    ) || !recovery_device_matches(
                        &devices.outputs,
                        &target.host,
                        &target.output_device,
                        &ids.output_id,
                    ) {
                        return Err(
                            "元の入出力機器を一意に特定できません。機器を確認してください".into(),
                        );
                    }
                }
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
            let receipt_id = expected_recovery.unwrap_or_else(|| plan.id.clone());
            let result = apply_owned(
                &root,
                host.clone(),
                &obs,
                plan,
                &mut session,
                receipt.and_then(|r| r.devices),
            )
            .await;
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
            if let Some(history) = &mut session.history {
                if result.is_ok() && history.result.complete {
                    if let Err(error) = bundle::resolve_recovery(&root, Some(&receipt_id)) {
                        history.result.complete = false;
                        history.result.set_auralyn(
                            "bundle.recovery.clearUnknown",
                            format!("復旧情報を解除できません: {error}"),
                        );
                    }
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
            if let Some(saved) = &history.backup.obs {
                let preview = obs_setup::bundle::preview(&obs, saved).await?;
                if preview.changes.iter().any(|change| {
                    change.field_code == Some("obs.field.muted")
                        && change.before.as_bool() == Some(true)
                        && change.after.as_bool() == Some(false)
                }) {
                    return Err("現在のOBSミュートを解除する復元はできません。受け側と現在の状態を確認してください".into());
                }
            }
            if bundle::recovery_exists(&root)? {
                if bundle::read_recovery(&root)?
                    .is_none_or(|receipt| receipt.backup_name != history.backup.name)
                {
                    return Err("別の未解決原本があります。先に復旧情報を確認してください".into());
                }
            } else {
                bundle::reserve_recovery(
                    &root,
                    &history.backup.name,
                    history.original_devices.clone(),
                )?;
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
            if history.result.complete && !history.result.undo_pending {
                if let Err(error) = bundle::resolve_recovery(&root, Some(&history.backup.name)) {
                    history.result.complete = false;
                    history.result.set_auralyn(
                        "bundle.recovery.clearUnknown",
                        format!("復旧情報を解除できません: {error}"),
                    );
                }
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
    recovery_devices: Option<bundle::RecoveryDevices>,
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
    let backup_obs = match &plan.bundle.obs {
        Some(saved) => Some(obs_setup::bundle::capture(obs, &recovery_obs_selection(saved)).await?),
        None => None,
    };
    witness.validate()?;
    let backup =
        BundleV1 {
            mixing: if plan.bundle.mixing.is_some() {
                Some(before.mixing.clone().unwrap_or_else(empty_mixing))
            } else {
                None
            },
            process: if plan.bundle.process.is_some() {
                Some(
                    before
                        .process
                        .clone()
                        .ok_or("変更前のプロセス設定を取得できません")?,
                )
            } else {
                None
            },
            live: if plan.bundle.live.is_some() {
                Some(
                    before
                        .live
                        .clone()
                        .ok_or("変更前の本番モードを取得できません")?,
                )
            } else {
                None
            },
            output: if plan.bundle.output.is_some() {
                Some(
                    before
                        .output
                        .clone()
                        .ok_or("変更前の出力構成を退避できません")?,
                )
            } else {
                None
            },
            schema_version: if plan.bundle.mixing.is_some() {
                5
            } else if plan.bundle.process.is_some() {
                4
            } else if plan.bundle.live.is_some() {
                3
            } else if plan.bundle.output.is_some() {
                2
            } else {
                1
            },
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
            obs: backup_obs,
        };
    bundle::save(&root.join("broadcast-bundle-backups"), &backup)?;
    let original_devices = if plan.bundle.categories.include_audio_config {
        active_devices(before.active.as_ref())
    } else {
        None
    };
    if plan.recovery_id.is_none() {
        bundle::reserve_recovery(root, &backup.name, original_devices.clone())?;
    }
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
        original_devices,
    });
    let history = session.history.as_mut().ok_or("操作履歴がありません")?;
    let root_owned = root.to_path_buf();
    let target = plan.bundle;
    let verify_target = target.clone();
    let verify_devices = recovery_devices.clone();
    let apply_host = host.clone();
    let applied = super::run_blocking(move || {
        let mut host = apply_host.lock().map_err(|_| "音声状態を取得できません")?;
        witness.validate()?;
        let summary = host.bundle_change_scope(|host| {
            apply_selected(&root_owned, host, &target, &before, recovery_devices)
        })?;
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
        || (verify_devices.is_some()
            && active_devices(history.after.as_ref().and_then(|a| a.active.as_ref()))
                != verify_devices)
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
    if history.backup.categories.include_audio_config
        && history.original_devices.is_none()
        && history.backup.process.is_none()
    {
        return Err("復旧原本に機器IDがありません。機器を手動で確認してください".into());
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
    let original_devices = history.original_devices.clone();
    let verify_devices = original_devices.clone();
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
            let summary = apply_selected(&root, host, &backup, &current, original_devices)?;
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
    if !selected_matches(&verify_backup, &restored)
        || restored.engine.running != was_running
        || (verify_devices.is_some() && active_devices(restored.active.as_ref()) != verify_devices)
    {
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
#[path = "bundles/tests.rs"]
mod tests;
