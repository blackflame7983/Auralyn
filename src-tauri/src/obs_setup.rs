//! OBS の変更予定は接続中、履歴はアプリ終了まで保持する。フロントから任意の設定値は受け取らない。
pub(crate) mod bundle;
use crate::audio::conditions::{Conditions, Witness};
use crate::obs::{
    is_audio_input_capture_kind, is_cable_output_device_name, ObsState, AURALYN_OBS_SOURCE_NAME,
    WASAPI_INPUT_KIND,
};
use obws::{
    common::MonitorType,
    requests::inputs::{Create, SetSettings},
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use time::Duration;
use tokio::sync::Mutex;

/// 表示専用。任意JSON/資格情報/stateをargsへ流す汎用変換は持たない。
#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum UiArg {
    Text(String),
    Number(serde_json::Number),
    Bool(bool),
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiText {
    pub code: &'static str,
    pub args: std::collections::BTreeMap<&'static str, UiArg>,
    pub fallback_ja: String,
}
impl UiText {
    pub(crate) fn new(code: &'static str, fallback: impl Into<String>) -> Self {
        Self {
            code,
            args: Default::default(),
            fallback_ja: fallback.into(),
        }
    }
    pub(crate) fn text(mut self, key: &'static str, value: impl Into<String>) -> Self {
        self.args.insert(key, UiArg::Text(value.into()));
        self
    }
    pub(crate) fn number(mut self, key: &'static str, value: f64) -> Self {
        if let Some(number) = serde_json::Number::from_f64(value) {
            self.args.insert(key, UiArg::Number(number));
        }
        self
    }
    pub(crate) fn boolean(mut self, key: &'static str, value: bool) -> Self {
        self.args.insert(key, UiArg::Bool(value));
        self
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    NotRun,
    Applied,
    Conflict,
    ApplyUnknown,
    RestoreDeferred,
    RestoreUnknown,
    Restored,
    AlreadyOriginal,
    RestoreFailed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultEntry {
    pub outcome: Outcome,
    pub text: UiText,
}

// changesを借用中でも更新できるよう、表示用の両fieldだけを受け取る。
// 間にawaitせずlegacy/typedを更新し、欠落typedをJP文言から復元しない。
fn set_result(
    results: &mut [String],
    entries: &mut Option<Vec<ResultEntry>>,
    index: usize,
    outcome: Outcome,
    code: &'static str,
    fallback: impl Into<String>,
) {
    let text = UiText::new(code, fallback);
    if let Some(result) = results.get_mut(index) {
        *result = text.fallback_ja.clone();
    }
    if let Some(entry) = entries.as_mut().and_then(|entries| entries.get_mut(index)) {
        *entry = ResultEntry { outcome, text };
    }
}

const REQUIRED: &[&str] = &[
    "GetInputList",
    "GetInputSettings",
    "SetInputSettings",
    "GetInputMute",
    "SetInputMute",
    "GetInputAudioMonitorType",
    "SetInputAudioMonitorType",
    "GetInputAudioSyncOffset",
    "SetInputAudioSyncOffset",
    "GetSceneCollectionList",
    "GetCurrentProgramScene",
    "GetInputPropertiesListPropertyItems",
    "GetInputKindList",
    "CreateInput",
    "GetSceneItemList",
    "RemoveSceneItem",
    "GetSceneItemTransform",
    "GetSceneItemEnabled",
    "GetSceneItemLocked",
    "GetInputVolume",
    "GetInputAudioBalance",
    "GetInputAudioTracks",
    "GetSourceFilterList",
];

const TIMING_REQUIRED: &[&str] = &[
    "GetInputList",
    "GetInputSettings",
    "GetInputAudioSyncOffset",
    "SetInputAudioSyncOffset",
    "GetSceneCollectionList",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingTarget {
    pub target_token: String,
    pub source: String,
    pub current_offset_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingTargets {
    pub supported: bool,
    pub message: String,
    pub targets: Vec<TimingTarget>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimingMeasurement {
    pub method: TimingMethod,
    pub comparison: TimingComparison,
    pub measured_delay_ms: i64,
    pub reference_note: String,
    pub fps: Option<f64>,
    pub track: Option<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TimingMethod {
    Manual,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TimingComparison {
    VoiceAccompaniment,
    AudioVideo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimingPreviewRequest {
    pub target_token: String,
    pub additional_delay_ms: i64,
    pub measurement: TimingMeasurement,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingMetadata {
    pub target_token: String,
    pub source: String,
    pub current_offset_ms: i64,
    pub additional_delay_ms: i64,
    pub result_offset_ms: i64,
    pub measurement: TimingMeasurement,
}

#[derive(Clone)]
struct TimingBinding {
    audio: Witness,
    target: TimingTarget,
    collection: String,
    generation: u64,
    source_generation: u64,
    fingerprint: u64,
}

fn timing_supported(available: &[String]) -> bool {
    TIMING_REQUIRED
        .iter()
        .all(|required| available.iter().any(|item| item == required))
}

fn timing_metadata(
    target: &TimingTarget,
    request: TimingPreviewRequest,
) -> Result<TimingMetadata, String> {
    let measurement = &request.measurement;
    if request.target_token.len() > 100
        || !(0..=20_950).contains(&request.additional_delay_ms)
        || !(-60_000..=60_000).contains(&measurement.measured_delay_ms)
        || measurement.reference_note.trim().is_empty()
        || measurement.reference_note.chars().count() > 500
        || measurement
            .fps
            .is_some_and(|fps| !fps.is_finite() || !(1.0..=240.0).contains(&fps))
        || measurement
            .track
            .is_some_and(|track| !(1..=6).contains(&track))
    {
        return Err("同期調整の測定条件・追加遅延が範囲外です".into());
    }
    let result = target
        .current_offset_ms
        .checked_add(request.additional_delay_ms)
        .filter(|value| (-950..=20_000).contains(value))
        .ok_or("同期オフセットがOBSの範囲（-950〜20000ms）を超えます")?;
    Ok(TimingMetadata {
        target_token: target.target_token.clone(),
        source: target.source.clone(),
        current_offset_ms: target.current_offset_ms,
        additional_delay_ms: request.additional_delay_ms,
        result_offset_ms: result,
        measurement: request.measurement,
    })
}

fn timing_change(binding: &TimingBinding, metadata: &TimingMetadata) -> Change {
    Change {
        source: binding.target.source.clone(),
        label: "同期オフセット（追加遅延）".into(),
        before: json!(metadata.current_offset_ms),
        after: json!(metadata.result_offset_ms),
        before_display: Some(format!("{} ms", metadata.current_offset_ms)),
        after_display: Some(format!("{} ms", metadata.result_offset_ms)),
        field_code: None,
        label_text: None,
        before_text: None,
        after_text: None,
        field: Field::TimingSync {
            fingerprint: binding.fingerprint,
        },
    }
    .with_text()
}

async fn timing_fingerprint(client: &Client, source: &str) -> Result<u64, String> {
    let inputs = client.inputs().list(None).await.map_err(error)?;
    let input = inputs
        .iter()
        .find(|input| input.name == source)
        .ok_or("対象ソースが見つかりません")?;
    let settings = client
        .inputs()
        .settings::<Value>(source)
        .await
        .map_err(error)?
        .settings;
    Ok(input_fingerprint(
        &input.kind,
        &input.unversioned_kind,
        &settings,
    ))
}

fn input_fingerprint(kind: &str, unversioned_kind: &str, settings: &Value) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    kind.hash(&mut hash);
    unversioned_kind.hash(&mut hash);
    // 設定値そのもの（URL・資格情報を含み得る）は予定・履歴へ保持しない。
    settings.to_string().hash(&mut hash);
    hash.finish()
}

pub(crate) async fn timing_targets(
    state: &ObsState,
    conditions: &std::sync::Arc<Conditions>,
) -> Result<TimingTargets, String> {
    let audio = conditions.snapshot()?;
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("OBS に接続してください")?;
    let mut setup = state.setup.lock().await;
    setup.invalidate_plan();
    setup.next_id = setup.next_id.checked_add(1).ok_or("同期確認IDの上限です")?;
    let available = client
        .general()
        .version()
        .await
        .map_err(error)?
        .available_requests;
    let supported = timing_supported(&available);
    let mut result = TimingTargets {
        supported,
        message: "追加遅延を適用するソースを選んでください。履歴はアプリ終了まで保持します。"
            .into(),
        targets: vec![],
    };
    if !supported {
        result.message =
            "このOBSでは同期調整の安全な確認・変更・復元に必要な操作が使えません。".into();
        return Ok(result);
    }
    let generation = state.setup_generation.load(Ordering::SeqCst);
    let collection = client.collection().await?;
    let sources = state.source_generations.lock().await.clone();
    let inputs = client.inputs().list(None).await.map_err(error)?;
    if inputs.len() > 256 {
        return Err("ソースが多いため同期調整はOBSで手動確認してください".into());
    }
    let mut bindings = HashMap::new();
    for (index, input) in inputs.into_iter().enumerate() {
        // 音声offsetを取得できる実在ソースだけを対象にする。
        let Ok(offset) = client.inputs().audio_sync_offset(&input.name).await else {
            continue;
        };
        let fingerprint = timing_fingerprint(client, &input.name).await?;
        let offset = i64::try_from(offset.whole_milliseconds()).map_err(error)?;
        let target = TimingTarget {
            target_token: format!("timing-{}-{index}", setup.next_id),
            source: input.name,
            current_offset_ms: offset,
        };
        bindings.insert(
            target.target_token.clone(),
            TimingBinding {
                audio: audio.clone(),
                source_generation: sources.get(&target.source).copied().unwrap_or(0),
                target: target.clone(),
                collection: collection.clone(),
                generation,
                fingerprint,
            },
        );
        result.targets.push(target);
    }
    if state.setup_generation.load(Ordering::SeqCst) != generation
        || client.collection().await? != collection
        || *state.source_generations.lock().await != sources
    {
        return Err("OBSの構成が変わりました。対象を取得し直してください".into());
    }
    audio.validate()?;
    setup.timing_targets = bindings;
    Ok(result)
}

pub async fn preview_timing(
    state: &ObsState,
    request: TimingPreviewRequest,
) -> Result<Plan, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("OBS に接続してください")?;
    let mut setup = state.setup.lock().await;
    setup.plan = None;
    let binding = setup.timing_binding(&request.target_token)?;
    let source_generations =
        HashMap::from([(binding.target.source.clone(), binding.source_generation)]);
    let session = Session {
        audio: Some(binding.audio.clone()),
        client,
        generation: &state.setup_generation,
        expected: binding.generation,
        sources: &state.source_generations,
        expected_sources: source_generations.clone(),
    };
    session.validate_source(&binding.target.source).await?;
    if setup.history.len() >= 20 {
        return Err("変更履歴が20件あります。不要な履歴を削除してください".into());
    }
    setup.next_id = setup.next_id.checked_add(1).ok_or("変更予定IDの上限です")?;
    let plan = timing_plan(&session, binding, request, setup.next_id).await?;
    session
        .validate_source(&plan.timing.as_ref().expect("同期予定の測定条件").source)
        .await?;
    if session.collection().await? != plan.collection {
        return Err("シーンコレクションが変わりました".into());
    }
    setup.plan = Some(plan.clone());
    Ok(plan)
}

async fn timing_plan(
    access: &impl Access,
    binding: TimingBinding,
    request: TimingPreviewRequest,
    id: u64,
) -> Result<Plan, String> {
    binding.audio.validate()?;
    let metadata = timing_metadata(&binding.target, request)?;
    if access.collection().await? != binding.collection {
        return Err("シーンコレクションが変わりました".into());
    }
    let change = timing_change(&binding, &metadata);
    if access.read(&change).await? != change.before {
        return Err("同期値が変わりました。対象を取得し直してください".into());
    }
    binding.audio.validate()?;
    Ok(Plan {
        audio: Some(binding.audio),
        id, supported: true, message: "測定条件と追加遅延を確認して適用してください。音声・映像の一致は手動で確認してください。".into(),
        message_text: Some(UiText::new("obs.plan.manualTiming", "測定条件と追加遅延を確認して適用してください。音声・映像の一致は手動で確認してください。")),
        changes: if change.before == change.after { vec![] } else { vec![change] }, duplicate_mic_sources: vec![], timing: Some(metadata),
        source_generations: HashMap::from([(binding.target.source.clone(), binding.source_generation)]),
        collection: binding.collection, generation: binding.generation,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub source: String,
    pub label: String,
    pub before: Value,
    pub after: Value,
    pub before_display: Option<String>,
    pub after_display: Option<String>,
    pub field_code: Option<&'static str>,
    pub label_text: Option<UiText>,
    pub before_text: Option<UiText>,
    pub after_text: Option<UiText>,
    #[serde(skip)]
    field: Field,
}

#[derive(Clone)]
enum Field {
    Bundle {
        kind: String,
        property: bundle::Property,
    },
    Settings,
    Muted,
    Monitor,
    // 新規提案は作らないが、既存の同期変更履歴を復元する読書き契約を維持する。
    #[allow(dead_code)]
    Sync,
    TimingSync {
        fingerprint: u64,
    },
    Create {
        scene: String,
        item: Option<i64>,
        token: String,
        index: usize,
    },
}

impl Change {
    fn with_text(mut self) -> Self {
        self.refresh_text();
        self
    }
    fn refresh_text(&mut self) {
        let code = match &self.field {
            Field::Settings => "obs.field.inputDevice",
            Field::Muted => "obs.field.muted",
            Field::Monitor => "obs.field.monitor",
            Field::Sync => "obs.field.syncOffset",
            Field::TimingSync { .. } => "obs.field.additionalDelay",
            Field::Create { .. } => "obs.field.createDisabledSource",
            Field::Bundle { property, .. } => match property {
                bundle::Property::Volume => "obs.field.volume",
                bundle::Property::Muted => "obs.field.muted",
                bundle::Property::Monitor => "obs.field.monitor",
                bundle::Property::FilterEnabled { .. } => "obs.field.filterEnabled",
            },
        };
        self.field_code = Some(code);
        let mut label = UiText::new(code, self.label.clone());
        if let Field::Bundle {
            property: bundle::Property::FilterEnabled { name, .. },
            ..
        } = &self.field
        {
            label = label.text("filter", name.clone());
        }
        self.label_text = Some(label);
        self.before_text = self.value_text(&self.before, self.before_display.as_deref());
        self.after_text = self.value_text(&self.after, self.after_display.as_deref());
    }
    fn value_text(&self, value: &Value, display: Option<&str>) -> Option<UiText> {
        let fallback = display
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        match &self.field {
            Field::Settings => Some(match value.get("device_id").and_then(Value::as_str) {
                Some(device) => UiText::new("obs.value.device", fallback).text("device", device),
                None => UiText::new("obs.value.defaultDevice", fallback),
            }),
            Field::Sync | Field::TimingSync { .. } => value.as_i64().map(|ms| {
                UiText::new("obs.value.milliseconds", fallback).number("value", ms as f64)
            }),
            Field::Create { scene, .. } => Some(if value.is_null() {
                UiText::new("obs.value.sourceAbsent", fallback)
            } else {
                UiText::new("obs.value.disabledSource", fallback).text("scene", scene.clone())
            }),
            Field::Muted
            | Field::Bundle {
                property: bundle::Property::Muted | bundle::Property::FilterEnabled { .. },
                ..
            } => value
                .as_bool()
                .map(|v| UiText::new("obs.value.boolean", fallback).boolean("value", v)),
            Field::Monitor
            | Field::Bundle {
                property: bundle::Property::Monitor,
                ..
            } => value
                .as_str()
                .map(|mode| UiText::new("obs.value.monitor", fallback).text("mode", mode)),
            Field::Bundle {
                property: bundle::Property::Volume,
                ..
            } => value
                .as_f64()
                .map(|v| UiText::new("obs.value.volumeMultiplier", fallback).number("value", v)),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(skip)]
    audio: Option<Witness>,
    pub id: u64,
    pub supported: bool,
    pub message: String,
    pub message_text: Option<UiText>,
    pub changes: Vec<Change>,
    pub duplicate_mic_sources: Vec<String>,
    pub timing: Option<TimingMetadata>,
    #[serde(skip)]
    collection: String,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    source_generations: HashMap<String, u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    #[serde(skip)]
    audio: Option<Witness>,
    pub id: u64,
    pub restorable: bool,
    pub connection_label: String,
    pub changes: Vec<Change>,
    pub results: Vec<String>,
    pub result_entries: Option<Vec<ResultEntry>>,
    pub timing: Option<TimingMetadata>,
    #[serde(skip)]
    collection: String,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    source_generations: HashMap<String, u64>,
    #[serde(skip)]
    pending: Vec<bool>,
    // 表示用restorableの再計算でlate-invalid完了を復活させない。Undo権限には使わない。
    #[serde(skip)]
    completion_valid: bool,
}

impl History {
    fn same_connection(&self, generation: u64) -> bool {
        self.generation == generation
    }

    fn refresh_restorable(&mut self, connected: bool, generation: u64) {
        self.restorable =
            connected && self.same_connection(generation) && validate_audio(&self.audio).is_ok();
    }
}

#[derive(Default)]
pub struct SetupState {
    next_id: u64,
    plan: Option<Plan>,
    history: Vec<History>,
    timing_targets: HashMap<String, TimingBinding>,
}

impl SetupState {
    fn timing_binding(&self, token: &str) -> Result<TimingBinding, String> {
        self.timing_targets
            .get(token)
            .cloned()
            .ok_or_else(|| "対象の期限が切れました。取得し直してください".into())
    }
    pub fn invalidate_plan(&mut self) {
        self.plan = None;
        self.timing_targets.clear();
    }
}

fn error(e: impl std::fmt::Display) -> String {
    format!("OBS の確認・変更に失敗しました: {e}")
}

fn validate_audio(witness: &Option<Witness>) -> Result<(), String> {
    witness.as_ref().map_or(Ok(()), Witness::validate)
}

fn push(
    changes: &mut Vec<Change>,
    source: &str,
    label: &str,
    field: Field,
    before: Value,
    after: Value,
) {
    // セットアップの新規提案では利用者の同期調整を維持する。
    // Syncの読書きは、既存の変更履歴を安全に復元するため残す。
    if matches!(&field, Field::Sync | Field::TimingSync { .. }) {
        return;
    }
    if before != after {
        changes.push(
            Change {
                source: source.into(),
                label: label.into(),
                field,
                before,
                after,
                before_display: None,
                after_display: None,
                field_code: None,
                label_text: None,
                before_text: None,
                after_text: None,
            }
            .with_text(),
        );
    }
}

pub async fn preview(state: &ObsState, mute_source: Option<String>) -> Result<Plan, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("OBS に接続してください")?;
    let mut setup = state.setup.lock().await;
    setup.plan = None;
    setup.next_id += 1;
    let available = client
        .general()
        .version()
        .await
        .map_err(error)?
        .available_requests;
    let missing: Vec<_> = REQUIRED
        .iter()
        .filter(|r| !available.iter().any(|a| a == **r))
        .copied()
        .collect();
    let mut plan = Plan {
        audio: None,
        id: setup.next_id,
        supported: missing.is_empty(),
        message: String::new(),
        message_text: None,
        changes: vec![],
        duplicate_mic_sources: vec![],
        timing: None,
        collection: String::new(),
        generation: state.setup_generation.load(Ordering::SeqCst),
        source_generations: state.source_generations.lock().await.clone(),
    };
    if !plan.supported {
        plan.message =
            "この OBS では安全な変更・復元に必要な操作が使えません。手動の手順をご利用ください。"
                .into();
        plan.message_text = Some(UiText::new("obs.plan.unsupported", plan.message.clone()));
        return Ok(plan);
    }
    if setup.history.len() >= 20 {
        return Err(
            "変更履歴が20件あります。OBSで状態を確認し、不要な履歴を削除してください。".into(),
        );
    }
    plan.collection = client.scene_collections().current().await.map_err(error)?;
    let inputs = client.inputs().list(None).await.map_err(error)?;
    for input in &inputs {
        if input.name != AURALYN_OBS_SOURCE_NAME
            && is_audio_input_capture_kind(&input.kind, &input.unversioned_kind)
            && !client.inputs().muted(&input.name).await.map_err(error)?
        {
            plan.duplicate_mic_sources.push(input.name.clone());
        }
    }
    if let Some(name) = mute_source {
        if !plan.duplicate_mic_sources.contains(&name) {
            return Err("対象マイクの状態が変わりました。もう一度確認してください。".into());
        }
        push(
            &mut plan.changes,
            &name,
            "ミュート",
            Field::Muted,
            json!(false),
            json!(true),
        );
    } else if let Some(input) = inputs.iter().find(|i| i.name == AURALYN_OBS_SOURCE_NAME) {
        if input.unversioned_kind != WASAPI_INPUT_KIND {
            return Err(
                "同名のソースが音声入力キャプチャではありません。OBS で確認してください。".into(),
            );
        }
        let settings = client
            .inputs()
            .settings::<Value>(&input.name)
            .await
            .map_err(error)?
            .settings;
        let items = client
            .inputs()
            .properties_list_property_items(&input.name, "device_id")
            .await
            .map_err(error)?;
        let cables: Vec<_> = items
            .iter()
            .filter(|i| i.enabled && is_cable_output_device_name(&i.name))
            .collect();
        if cables.len() != 1 {
            return Err("CABLE Output を一意に選べません。OBS のソースプロパティでデバイスを選んでください。".into());
        }
        if !cables[0].value.is_string() {
            return Err("デバイスの識別子が不正です。OBS で確認してください。".into());
        }
        let before_display = items
            .iter()
            .find(|i| Some(&i.value) == settings.get("device_id"))
            .map(|i| i.name.clone())
            .unwrap_or_else(|| "未指定（OBS の既定値）".into());
        let after_display = cables[0].name.clone();
        let mut after = settings.clone();
        after
            .as_object_mut()
            .ok_or("OBS のデバイス設定を読み取れません")?
            .insert("device_id".into(), cables[0].value.clone());
        let count = plan.changes.len();
        push(
            &mut plan.changes,
            &input.name,
            "入力デバイス（CABLE Output）",
            Field::Settings,
            settings,
            after,
        );
        if plan.changes.len() > count {
            if let Some(c) = plan.changes.last_mut() {
                let before_text = items
                    .iter()
                    .find(|item| Some(&item.value) == c.before.get("device_id"))
                    .map(|item| {
                        UiText::new("obs.value.device", before_display.clone())
                            .text("device", item.name.clone())
                    })
                    .unwrap_or_else(|| {
                        UiText::new("obs.value.defaultDevice", before_display.clone())
                    });
                let after_text = UiText::new("obs.value.device", after_display.clone())
                    .text("device", after_display.clone());
                c.before_display = Some(before_display);
                c.after_display = Some(after_display);
                c.refresh_text();
                c.before_text = Some(before_text);
                c.after_text = Some(after_text);
            }
        }
        push(
            &mut plan.changes,
            &input.name,
            "ミュート",
            Field::Muted,
            json!(client.inputs().muted(&input.name).await.map_err(error)?),
            json!(false),
        );
        push(
            &mut plan.changes,
            &input.name,
            "モニタリング",
            Field::Monitor,
            json!(client
                .inputs()
                .audio_monitor_type(&input.name)
                .await
                .map_err(error)?),
            json!(MonitorType::None),
        );
    } else {
        if !client
            .inputs()
            .list_kinds(true)
            .await
            .map_err(error)?
            .iter()
            .any(|k| k == WASAPI_INPUT_KIND)
        {
            return Err("音声入力キャプチャが使えません。手動の手順をご利用ください。".into());
        }
        // 未作成ソースのプロパティ一覧を得るために仮ソースは作らない。
        // 新規作成は無効・既定デバイスなしで行い、音を流す前にユーザーがデバイスを指定する。
        let scene = client
            .scenes()
            .current_program_scene()
            .await
            .map_err(error)?;
        let index = client
            .scene_items()
            .list(&scene)
            .await
            .map_err(error)?
            .len();
        let token = format!(
            "{}-{}-{}",
            std::process::id(),
            setup.next_id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(error)?
                .as_nanos()
        );
        push(
            &mut plan.changes,
            AURALYN_OBS_SOURCE_NAME,
            "新規ソースを無効で追加（デバイスはOBSで指定）",
            Field::Create {
                scene: scene.clone(),
                item: None,
                token,
                index,
            },
            Value::Null,
            json!({"scene":scene,"device_id":"disabled","enabled":false}),
        );
        plan.message =
            "作成後、OBS のソースプロパティで CABLE Output を選び、ソースを有効にしてください。"
                .into();
        plan.message_text = Some(UiText::new(
            "obs.plan.configureCreatedSource",
            plan.message.clone(),
        ));
    }
    setup.plan = Some(plan.clone());
    Ok(plan)
}

// 作成したシーン項目の復元では、ソース全体と項目の状態を照合してからその項目だけ外す。
// 別シーンにユーザーが追加した参照は削除しない。
async fn created_snapshot(
    client: &Client,
    source: &str,
    scene: &str,
    id: i64,
) -> Result<Value, String> {
    let item = client
        .scene_items()
        .list(scene)
        .await
        .map_err(error)?
        .into_iter()
        .find(|i| i.id == id && i.source_name == source)
        .ok_or("作成したシーン項目が見つかりません")?;
    Ok(json!({
        "item":item,
        "settings":client.inputs().settings::<Value>(source).await.map_err(error)?,
        "muted":client.inputs().muted(source).await.map_err(error)?,
        "monitor":client.inputs().audio_monitor_type(source).await.map_err(error)?,
        "sync":client.inputs().audio_sync_offset(source).await.map_err(error)?.whole_milliseconds() as i64,
        "volume":client.inputs().volume(source).await.map_err(error)?,
        "balance":client.inputs().audio_balance(source).await.map_err(error)?,
        "tracks":client.inputs().audio_tracks(source).await.map_err(error)?,
        "filters":client.filters().list(source).await.map_err(error)?,
        "enabled":client.scene_items().enabled(scene,id).await.map_err(error)?,
        "locked":client.scene_items().locked(scene,id).await.map_err(error)?,
        "transform":client.scene_items().transform(scene,id).await.map_err(error)?
    }))
}

trait Access {
    async fn collection(&self) -> Result<String, String>;
    async fn read(&self, change: &Change) -> Result<Value, String>;
    async fn write(&self, change: &mut Change, value: Value) -> Result<(), String>;
    async fn recover_creation(&self, _change: &mut Change) -> Result<(), String> {
        Ok(())
    }
}

struct Session<'a> {
    audio: Option<Witness>,
    client: &'a Client,
    generation: &'a AtomicU64,
    expected: u64,
    sources: &'a Mutex<HashMap<String, u64>>,
    expected_sources: HashMap<String, u64>,
}
impl Session<'_> {
    async fn validate_source(&self, source: &str) -> Result<(), String> {
        self.validate()?;
        validate_source_generation(&*self.sources.lock().await, &self.expected_sources, source)
    }
    fn validate(&self) -> Result<(), String> {
        validate_audio(&self.audio)?;
        if self.generation.load(Ordering::SeqCst) == self.expected {
            Ok(())
        } else {
            Err(
                "OBS の構成が変わりました。安全に復元できないため、OBS で手動確認してください。"
                    .into(),
            )
        }
    }
}
impl Access for Session<'_> {
    async fn collection(&self) -> Result<String, String> {
        self.validate()?;
        let collection = self.client.collection().await?;
        self.validate()?;
        Ok(collection)
    }
    async fn read(&self, c: &Change) -> Result<Value, String> {
        self.validate_source(&c.source).await?;
        let value = self.client.read(c).await?;
        if matches!(c.field, Field::TimingSync { .. } | Field::Bundle { .. }) {
            self.validate_source(&c.source).await?;
        }
        Ok(value)
    }
    async fn write(&self, c: &mut Change, value: Value) -> Result<(), String> {
        self.validate_source(&c.source).await?;
        self.client.write(c, value).await?;
        if matches!(c.field, Field::TimingSync { .. }) {
            self.validate_source(&c.source).await?;
        }
        Ok(())
    }
    async fn recover_creation(&self, c: &mut Change) -> Result<(), String> {
        self.validate_source(&c.source).await?;
        self.client.recover_creation(c).await
    }
}

fn validate_source_generation(
    current: &HashMap<String, u64>,
    expected: &HashMap<String, u64>,
    source: &str,
) -> Result<(), String> {
    if current.get(source).copied().unwrap_or(0) == expected.get(source).copied().unwrap_or(0) {
        Ok(())
    } else {
        Err("対象ソースが削除・改名されました。OBS で手動確認してください。".into())
    }
}

const CREATION_TOKEN: &str = "auralyn_setup_token";

fn creation_settings(token: &str) -> Value {
    json!({"device_id":"disabled", CREATION_TOKEN:token})
}

// 取得できなかった「作成直後の状態」を、後から変更された状態で置き換えない。
// 不明な項目や既定値との差があれば自動削除せず、手動確認に残す。
fn pristine_creation(snapshot: &Value, token: &str, index: usize) -> bool {
    snapshot["settings"]
        == json!({"inputKind":WASAPI_INPUT_KIND,"inputSettings":creation_settings(token)})
        && snapshot["item"]["sceneItemIndex"] == json!(index)
        && snapshot["muted"] == json!(false)
        && snapshot["monitor"] == json!(MonitorType::None)
        && snapshot["sync"] == json!(0)
        && snapshot["volume"] == json!({"inputVolumeMul":1.0,"inputVolumeDb":0.0})
        && snapshot["balance"] == json!(0.5)
        && snapshot["tracks"] == json!([true, true, true, true, true, true])
        && snapshot["filters"] == json!([])
        && snapshot["enabled"] == json!(false)
        && snapshot["locked"] == json!(false)
        && snapshot["transform"]
            == json!({"sourceWidth":0.0,"sourceHeight":0.0,"positionX":0.0,"positionY":0.0,"rotation":0.0,"scaleX":1.0,"scaleY":1.0,"width":0.0,"height":0.0,"alignment":5,"boundsType":"OBS_BOUNDS_NONE","boundsAlignment":0,"boundsWidth":0.0,"boundsHeight":0.0,"cropLeft":0,"cropRight":0,"cropTop":0,"cropBottom":0})
}

fn adopt_creation_snapshot(c: &mut Change, id: i64, snapshot: Value) -> Result<(), String> {
    let Field::Create {
        item, token, index, ..
    } = &mut c.field
    else {
        return Ok(());
    };
    if item.is_some_and(|known| known != id)
        || snapshot["item"]["sceneItemId"] != json!(id)
        || snapshot["item"]["sourceName"] != json!(c.source)
        || !pristine_creation(&snapshot, token, *index)
    {
        return Err("作成後に変更された可能性があります。OBS で手動確認してください".into());
    }
    *item = Some(id);
    c.after = snapshot;
    Ok(())
}

impl Access for Client {
    async fn collection(&self) -> Result<String, String> {
        self.scene_collections().current().await.map_err(error)
    }
    async fn read(&self, c: &Change) -> Result<Value, String> {
        // 種別の異なる同名ソースへの変更を防ぐ。
        let inputs = self.inputs().list(None).await.map_err(error)?;
        let found = inputs.iter().find(|i| i.name == c.source);
        if let Field::Bundle { kind, property } = &c.field {
            if found.is_none_or(|input| input.kind != *kind) {
                return Err("保存した種類のOBSソースが見つかりません".into());
            }
            return bundle::read_property(self, &c.source, property).await;
        }
        if let Field::Create { scene, item, .. } = &c.field {
            return match item {
                Some(id) => created_snapshot(self, &c.source, scene, *id).await,
                None => Ok(if found.is_none() {
                    Value::Null
                } else {
                    json!("既存ソースあり")
                }),
            };
        }
        if matches!(c.field, Field::TimingSync { .. }) {
            let Field::TimingSync { fingerprint } = c.field else {
                unreachable!()
            };
            if found.is_none() || timing_fingerprint(self, &c.source).await? != fingerprint {
                return Err("対象ソースの設定が変わりました。対象を取得し直してください".into());
            }
        } else if !found.is_some_and(|i| is_audio_input_capture_kind(&i.kind, &i.unversioned_kind))
        {
            return Err("対象の音声入力が見つかりません".into());
        }
        Ok(match c.field {
            Field::Settings => {
                self.inputs()
                    .settings::<Value>(&c.source)
                    .await
                    .map_err(error)?
                    .settings
            }
            Field::Muted => json!(self.inputs().muted(&c.source).await.map_err(error)?),
            Field::Monitor => json!(self
                .inputs()
                .audio_monitor_type(&c.source)
                .await
                .map_err(error)?),
            Field::Sync | Field::TimingSync { .. } => json!(self
                .inputs()
                .audio_sync_offset(&c.source)
                .await
                .map_err(error)?
                .whole_milliseconds()
                as i64),
            Field::Create { .. } => unreachable!(),
            Field::Bundle { .. } => unreachable!(),
        })
    }
    async fn write(&self, c: &mut Change, value: Value) -> Result<(), String> {
        match &mut c.field {
            Field::Bundle { property, .. } => {
                bundle::write_property(self, &c.source, property, value).await
            }
            Field::Settings => self
                .inputs()
                .set_settings(SetSettings {
                    input: &c.source,
                    settings: &value,
                    overlay: Some(false),
                })
                .await
                .map_err(error),
            Field::Muted => self
                .inputs()
                .set_muted(&c.source, value.as_bool().ok_or("不正なミュート値")?)
                .await
                .map_err(error),
            Field::Monitor => self
                .inputs()
                .set_audio_monitor_type(&c.source, serde_json::from_value(value).map_err(error)?)
                .await
                .map_err(error),
            Field::Sync | Field::TimingSync { .. } => self
                .inputs()
                .set_audio_sync_offset(
                    &c.source,
                    Duration::milliseconds(value.as_i64().ok_or("不正な同期値")?),
                )
                .await
                .map_err(error),
            Field::Create {
                scene, item, token, ..
            } => {
                if value.is_null() {
                    self.scene_items()
                        .remove(
                            scene,
                            item.ok_or("作成結果が不明です。OBS で手動確認してください")?,
                        )
                        .await
                        .map_err(error)
                } else {
                    let settings = creation_settings(token);
                    let id = self
                        .inputs()
                        .create(Create {
                            scene,
                            input: &c.source,
                            kind: WASAPI_INPUT_KIND,
                            settings: Some(&settings),
                            enabled: Some(false),
                        })
                        .await
                        .map_err(error)?;
                    *item = Some(id);
                    c.after = created_snapshot(self, &c.source, scene, id).await?;
                    Ok(())
                }
            }
        }
    }

    async fn recover_creation(&self, c: &mut Change) -> Result<(), String> {
        let Field::Create { scene, item, .. } = &mut c.field else {
            return Ok(());
        };
        if c.after.get("item").is_some() {
            return Ok(());
        }
        let items = self.scene_items().list(scene).await.map_err(error)?;
        let matches: Vec<_> = items.iter().filter(|i| i.source_name == c.source).collect();
        if matches.is_empty()
            && self
                .inputs()
                .list(None)
                .await
                .map_err(error)?
                .iter()
                .all(|i| i.name != c.source)
        {
            // 作成されなかった／既に取り消された場合は通常のreadで元の不在を確認する。
            *item = None;
            return Ok(());
        }
        if matches.len() != 1 || item.is_some_and(|id| id != matches[0].id) {
            return Err("作成した項目を一意に確認できません".into());
        }
        let snapshot = created_snapshot(self, &c.source, scene, matches[0].id).await?;
        adopt_creation_snapshot(c, matches[0].id, snapshot)
    }
}

async fn apply_plan(access: &impl Access, plan: Plan) -> History {
    let mut history = History {
        audio: plan.audio,
        id: plan.id,
        restorable: true,
        connection_label: String::new(),
        collection: plan.collection,
        generation: plan.generation,
        source_generations: plan.source_generations,
        pending: vec![false; plan.changes.len()],
        completion_valid: true,
        results: vec!["未実行".into(); plan.changes.len()],
        result_entries: Some(vec![
            ResultEntry {
                outcome: Outcome::NotRun,
                text: UiText::new("obs.result.notRun", "未実行")
            };
            plan.changes.len()
        ]),
        timing: plan.timing,
        changes: plan.changes,
    };
    // 予定の全項目を読み直す。競合があれば変更を一つも送らない。
    for (index, c) in history.changes.iter().enumerate() {
        if let Err(error) = validate_audio(&history.audio) {
            set_result(
                &mut history.results,
                &mut history.result_entries,
                index,
                Outcome::Conflict,
                "obs.result.audioConflict",
                format!("競合: {error}"),
            );
            return history;
        }
        match access.read(c).await {
            Ok(current) if current == c.before => {}
            _ => {
                set_result(
                    &mut history.results,
                    &mut history.result_entries,
                    index,
                    Outcome::Conflict,
                    "obs.result.valueConflict",
                    "競合: OBS の現在値が変わりました。再確認してください。",
                );
                return history;
            }
        }
    }
    for index in 0..history.changes.len() {
        let c = &mut history.changes[index];
        if access.collection().await.as_deref() != Ok(history.collection.as_str())
            || access.read(c).await.ok().as_ref() != Some(&c.before)
            || validate_audio(&history.audio).is_err()
        {
            set_result(
                &mut history.results,
                &mut history.result_entries,
                index,
                Outcome::Conflict,
                "obs.result.applyInterrupted",
                "競合: 適用を中断しました",
            );
            break;
        }
        // タイムアウトでも OBS 側で変更済みの可能性があるため、送信前に復元候補にする。
        if matches!(c.field, Field::Bundle { .. }) && c.before == c.after {
            set_result(
                &mut history.results,
                &mut history.result_entries,
                index,
                Outcome::Applied,
                "obs.result.applied",
                "適用済み",
            );
            continue;
        }
        history.pending[index] = true;
        let after = c.after.clone();
        match access.write(c, after).await {
            Ok(()) => {
                if let Err(error) = validate_audio(&history.audio) {
                    set_result(
                        &mut history.results,
                        &mut history.result_entries,
                        index,
                        Outcome::ApplyUnknown,
                        "obs.result.applyAudioUnknown",
                        format!("適用状態を要確認: {error}"),
                    );
                    break;
                }
                if matches!(c.field, Field::TimingSync { .. } | Field::Bundle { .. })
                    && access.read(c).await.ok().as_ref() != Some(&c.after)
                {
                    set_result(
                        &mut history.results,
                        &mut history.result_entries,
                        index,
                        Outcome::ApplyUnknown,
                        "obs.result.applyReadbackUnknown",
                        "適用状態を要確認: OBSの変更後の値を確認できません",
                    );
                    break;
                }
                if let Err(error) = validate_audio(&history.audio) {
                    set_result(
                        &mut history.results,
                        &mut history.result_entries,
                        index,
                        Outcome::ApplyUnknown,
                        "obs.result.applyAudioUnknown",
                        format!("適用状態を要確認: {error}"),
                    );
                    break;
                }
                set_result(
                    &mut history.results,
                    &mut history.result_entries,
                    index,
                    Outcome::Applied,
                    "obs.result.applied",
                    "適用済み",
                );
            }
            Err(e) => {
                set_result(
                    &mut history.results,
                    &mut history.result_entries,
                    index,
                    Outcome::ApplyUnknown,
                    "obs.result.applyWriteUnknown",
                    format!("失敗（適用状態を要確認）: {e}"),
                );
                break;
            }
        }
    }
    history
}

async fn restore_history(access: &impl Access, history: &mut History) {
    for index in (0..history.changes.len()).rev() {
        if !history.pending[index] {
            continue;
        }
        if let Err(error) = validate_audio(&history.audio) {
            set_result(
                &mut history.results,
                &mut history.result_entries,
                index,
                Outcome::RestoreDeferred,
                "obs.result.restoreAudioDeferred",
                format!("復元保留: {error}"),
            );
            continue;
        }
        if access.collection().await.as_deref() != Ok(history.collection.as_str()) {
            set_result(
                &mut history.results,
                &mut history.result_entries,
                index,
                Outcome::Conflict,
                "obs.result.restoreCollectionConflict",
                "競合: シーンコレクションが違うため復元しません",
            );
            continue;
        }
        let c = &mut history.changes[index];
        if let Err(e) = access.recover_creation(c).await {
            set_result(
                &mut history.results,
                &mut history.result_entries,
                index,
                Outcome::RestoreDeferred,
                "obs.result.restoreCreationDeferred",
                format!("復元保留: {e}"),
            );
            continue;
        }
        match access.read(c).await {
            Ok(current) if current == c.before => {
                history.pending[index] = false;
                set_result(
                    &mut history.results,
                    &mut history.result_entries,
                    index,
                    Outcome::AlreadyOriginal,
                    "obs.result.alreadyOriginal",
                    "元の値を確認",
                );
            }
            Ok(current) if current == c.after => {
                let before = c.before.clone();
                match access.write(c, before).await {
                    Ok(()) => {
                        if let Err(error) = validate_audio(&history.audio) {
                            set_result(
                                &mut history.results,
                                &mut history.result_entries,
                                index,
                                Outcome::RestoreUnknown,
                                "obs.result.restoreAudioUnknown",
                                format!("復元状態を要確認: {error}"),
                            );
                            continue;
                        }
                        if matches!(c.field, Field::TimingSync { .. } | Field::Bundle { .. })
                            && access.read(c).await.ok().as_ref() != Some(&c.before)
                        {
                            set_result(
                                &mut history.results,
                                &mut history.result_entries,
                                index,
                                Outcome::RestoreUnknown,
                                "obs.result.restoreReadbackUnknown",
                                "復元状態を要確認: OBSの復元後の値を確認できません",
                            );
                        } else {
                            history.pending[index] = false;
                            set_result(
                                &mut history.results,
                                &mut history.result_entries,
                                index,
                                Outcome::Restored,
                                "obs.result.restored",
                                "復元済み",
                            );
                        }
                    }
                    Err(e) => set_result(
                        &mut history.results,
                        &mut history.result_entries,
                        index,
                        Outcome::RestoreFailed,
                        "obs.result.restoreWriteFailed",
                        format!("復元失敗: {e}"),
                    ),
                }
            }
            _ => {
                set_result(
                    &mut history.results,
                    &mut history.result_entries,
                    index,
                    Outcome::Conflict,
                    "obs.result.restoreValueConflict",
                    "競合: 後から変更された可能性があるため復元しません。OBS で確認してください。",
                );
            }
        }
    }
}

pub async fn apply(state: &ObsState, id: u64) -> Result<History, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("OBS に接続してください")?;
    let mut setup = state.setup.lock().await;
    if setup.plan.as_ref().map(|p| p.id) != Some(id) {
        return Err("変更予定の期限が切れました。もう一度確認してください。".into());
    }
    let plan = setup.plan.take().ok_or("変更予定がありません")?;
    if client.collection().await? != plan.collection {
        return Err("シーンコレクションが変わりました。再確認してください。".into());
    }
    let session = Session {
        audio: plan.audio.clone(),
        client,
        generation: &state.setup_generation,
        expected: plan.generation,
        sources: &state.source_generations,
        expected_sources: plan.source_generations.clone(),
    };
    session.validate()?;
    let mut history = apply_plan(&session, plan).await;
    if let Some(params) = state.conn_params.lock().await.as_ref() {
        history.connection_label = format!("{}:{}", params.host, params.port);
    }
    history.refresh_restorable(true, state.setup_generation.load(Ordering::SeqCst));
    setup.history.push(history.clone());
    Ok(history)
}

pub async fn history(state: &ObsState) -> Vec<History> {
    let connected = state.client.lock().await;
    let generation = state.setup_generation.load(Ordering::SeqCst);
    state
        .setup
        .lock()
        .await
        .history
        .iter()
        .cloned()
        .map(|mut h| {
            h.refresh_restorable(connected.is_some(), generation);
            h
        })
        .collect()
}

pub async fn forget_history(state: &ObsState, id: u64) -> Result<(), String> {
    let mut setup = state.setup.lock().await;
    let index = setup
        .history
        .iter()
        .position(|h| h.id == id)
        .ok_or("履歴がありません")?;
    setup.history.remove(index);
    Ok(())
}

fn ensure_restore_order(history: &[History], index: usize) -> Result<(), String> {
    let target = &history[index];
    // 別ソースの競合・通信失敗はこの履歴の復元を妨げない。
    // 同じソースは作成取り消しも含め、新しい変更を先に戻す。
    let overlaps = history[index + 1..].iter().any(|newer| {
        newer
            .changes
            .iter()
            .zip(&newer.pending)
            .any(|(change, pending)| {
                *pending
                    && target
                        .changes
                        .iter()
                        .zip(&target.pending)
                        .any(|(old, pending)| *pending && old.source == change.source)
            })
    });
    if overlaps {
        Err("同じソースの新しい変更から順に元に戻してください。".into())
    } else {
        Ok(())
    }
}

pub async fn restore(state: &ObsState, id: u64) -> Result<History, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("OBS に接続してください")?;
    let mut setup = state.setup.lock().await;
    let index = setup
        .history
        .iter()
        .position(|h| h.id == id)
        .ok_or("履歴がありません")?;
    if !setup.history[index].same_connection(state.setup_generation.load(Ordering::SeqCst)) {
        return Err("接続をまたいだ履歴のソース同一性を確認できません。履歴を参照してOBSで手動確認してください。".into());
    }
    ensure_restore_order(&setup.history, index)?;
    setup.plan = None;
    let session = Session {
        audio: setup.history[index].audio.clone(),
        client,
        generation: &state.setup_generation,
        expected: setup.history[index].generation,
        sources: &state.source_generations,
        expected_sources: setup.history[index].source_generations.clone(),
    };
    restore_history(&session, &mut setup.history[index]).await;
    setup.history[index].refresh_restorable(true, state.setup_generation.load(Ordering::SeqCst));
    Ok(setup.history[index].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn timing_request(additional: i64) -> TimingPreviewRequest {
        TimingPreviewRequest {
            target_token: "timing-test".into(),
            additional_delay_ms: additional,
            measurement: TimingMeasurement {
                method: TimingMethod::Manual,
                comparison: TimingComparison::VoiceAccompaniment,
                measured_delay_ms: 120,
                reference_note: "同じ録画の声と伴奏を比較".into(),
                fps: Some(60.0),
                track: Some(1),
            },
        }
    }
    fn timing_binding(offset: i64) -> TimingBinding {
        let conditions = std::sync::Arc::new(Conditions::default());
        conditions.lifecycle(true);
        TimingBinding {
            audio: conditions.snapshot().unwrap(),
            target: TimingTarget {
                target_token: "timing-test".into(),
                source: "0".into(),
                current_offset_ms: offset,
            },
            collection: "test".into(),
            generation: 0,
            source_generation: 0,
            fingerprint: 9,
        }
    }

    #[test]
    fn timing_validates_checked_addition_and_measurement_bounds() {
        let target = timing_binding(-240).target;
        let metadata = timing_metadata(&target, timing_request(175)).unwrap();
        assert_eq!(metadata.result_offset_ms, -65);
        assert!(timing_metadata(&target, timing_request(-1)).is_err());
        assert!(timing_metadata(&timing_binding(20_000).target, timing_request(1)).is_err());
        assert!(timing_metadata(&timing_binding(i64::MAX).target, timing_request(1)).is_err());
        assert!(timing_metadata(&timing_binding(-951).target, timing_request(0)).is_err());
        for invalid in [f64::NAN, f64::INFINITY, 0.0, 241.0] {
            let mut request = timing_request(0);
            request.measurement.fps = Some(invalid);
            assert!(timing_metadata(&target, request).is_err());
        }
        for invalid in [0, 7] {
            let mut request = timing_request(0);
            request.measurement.track = Some(invalid);
            assert!(timing_metadata(&target, request).is_err());
        }
        let mut request = timing_request(0);
        request.measurement.reference_note = "a".repeat(501);
        assert!(timing_metadata(&target, request).is_err());
        let mut value = serde_json::to_value(timing_request(0).measurement).unwrap();
        value["method"] = json!("automatic");
        assert!(serde_json::from_value::<TimingMeasurement>(value).is_err());
    }

    #[test]
    fn timing_capabilities_and_target_tokens_are_scoped() {
        let mut available: Vec<_> = TIMING_REQUIRED.iter().map(|s| (*s).to_owned()).collect();
        assert!(timing_supported(&available));
        available.pop();
        assert!(!timing_supported(&available));
        let mut setup = SetupState::default();
        setup
            .timing_targets
            .insert("timing-test".into(), timing_binding(0));
        assert!(setup.timing_binding("arbitrary-source-name").is_err());
        assert!(setup.timing_binding("timing-test").is_ok());
        setup.invalidate_plan();
        assert!(setup.timing_binding("timing-test").is_err());
        assert!(validate_source_generation(
            &HashMap::from([("0".into(), 1)]),
            &HashMap::new(),
            "0"
        )
        .is_err());
        let settings = json!({"device_id":"first"});
        let fingerprint = input_fingerprint("input", "input", &settings);
        assert_ne!(
            fingerprint,
            input_fingerprint("input", "input", &json!({"device_id":"replacement"}))
        );
        assert_ne!(fingerprint, input_fingerprint("media", "media", &settings));
    }

    struct TimingFake {
        value: RefCell<i64>,
        writes: RefCell<Vec<i64>>,
        stale: std::cell::Cell<bool>,
        ignore_write: bool,
        fail_write: bool,
        conditions_on_write: Option<std::sync::Arc<Conditions>>,
    }
    impl TimingFake {
        fn new(value: i64) -> Self {
            Self {
                value: RefCell::new(value),
                writes: RefCell::new(vec![]),
                stale: std::cell::Cell::new(false),
                ignore_write: false,
                fail_write: false,
                conditions_on_write: None,
            }
        }
    }
    impl Access for TimingFake {
        async fn collection(&self) -> Result<String, String> {
            Ok("test".into())
        }
        async fn read(&self, _: &Change) -> Result<Value, String> {
            if self.stale.get() {
                Err("ソースの設定・世代が変更されました".into())
            } else {
                Ok(json!(*self.value.borrow()))
            }
        }
        async fn write(&self, _: &mut Change, value: Value) -> Result<(), String> {
            let value = value.as_i64().unwrap();
            self.writes.borrow_mut().push(value);
            if !self.ignore_write {
                *self.value.borrow_mut() = value;
            }
            if let Some(conditions) = &self.conditions_on_write {
                conditions.lifecycle(false);
            }
            if self.fail_write {
                Err("timeout".into())
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn timing_preview_is_sync_only_and_apply_readback_and_undo_keep_metadata() {
        let fake = TimingFake::new(-240);
        let plan = timing_plan(&fake, timing_binding(-240), timing_request(175), 1)
            .await
            .unwrap();
        assert_eq!(plan.changes.len(), 1);
        assert!(matches!(plan.changes[0].field, Field::TimingSync { .. }));
        let mut history = apply_plan(&fake, plan).await;
        assert_eq!(history.results, ["適用済み"]);
        assert_eq!(
            history.timing.as_ref().unwrap().measurement.reference_note,
            "同じ録画の声と伴奏を比較"
        );
        assert_eq!(*fake.value.borrow(), -65);
        restore_history(&fake, &mut history).await;
        assert_eq!(*fake.value.borrow(), -240);
        assert!(!history.pending[0]);
        assert_eq!(history.results, ["復元済み"]);
    }

    #[tokio::test]
    async fn timing_stale_source_and_offset_prevent_preview_or_apply_writes() {
        let fake = TimingFake::new(-239);
        assert!(
            timing_plan(&fake, timing_binding(-240), timing_request(175), 1)
                .await
                .is_err()
        );
        *fake.value.borrow_mut() = -240;
        let plan = timing_plan(&fake, timing_binding(-240), timing_request(175), 1)
            .await
            .unwrap();
        fake.stale.set(true);
        assert!(
            timing_plan(&fake, timing_binding(-240), timing_request(175), 1)
                .await
                .is_err()
        );
        let history = apply_plan(&fake, plan).await;
        assert!(history.results[0].starts_with("競合"));
        assert!(fake.writes.borrow().is_empty());
    }

    #[tokio::test]
    async fn timing_mismatch_and_timeout_keep_uncertain_history_and_safe_undo() {
        for fail_write in [false, true] {
            let mut fake = TimingFake::new(0);
            fake.ignore_write = !fail_write;
            fake.fail_write = fail_write;
            let plan = timing_plan(&fake, timing_binding(0), timing_request(120), 1)
                .await
                .unwrap();
            let mut history = apply_plan(&fake, plan).await;
            assert!(history.pending[0]);
            assert_ne!(history.results[0], "適用済み");
            assert!(history.results[0].contains("要確認"));
            fake.ignore_write = false;
            fake.fail_write = false;
            restore_history(&fake, &mut history).await;
            assert_eq!(*fake.value.borrow(), 0);
            assert!(!history.pending[0]);
        }
        let mut fake = TimingFake::new(0);
        let plan = timing_plan(&fake, timing_binding(0), timing_request(120), 1)
            .await
            .unwrap();
        let mut history = apply_plan(&fake, plan).await;
        fake.ignore_write = true;
        restore_history(&fake, &mut history).await;
        assert!(history.pending[0]);
        assert!(history.results[0].contains("要確認"));
    }

    #[tokio::test]
    async fn timing_audio_changes_expire_targets_plans_and_undo_without_affecting_general_setup() {
        let conditions = std::sync::Arc::new(Conditions::default());
        conditions.lifecycle(true);
        let fake = TimingFake::new(0);
        let mut binding = timing_binding(0);
        binding.audio = conditions.snapshot().unwrap();
        let plan = timing_plan(&fake, binding.clone(), timing_request(120), 1)
            .await
            .unwrap();
        assert!(serde_json::to_value(&plan).unwrap().get("audio").is_none());
        conditions.lifecycle(false);
        conditions.lifecycle(true);
        assert!(timing_plan(&fake, binding, timing_request(120), 2)
            .await
            .is_err());
        let history = apply_plan(&fake, plan).await;
        assert!(fake.writes.borrow().is_empty());
        assert!(history.results[0].starts_with("競合"));
        let mut binding = timing_binding(0);
        binding.audio = conditions.snapshot().unwrap();
        let plan = timing_plan(&fake, binding, timing_request(120), 3)
            .await
            .unwrap();
        let mut history = apply_plan(&fake, plan).await;
        assert_eq!(history.results[0], "適用済み");
        conditions.lifecycle(false);
        history.refresh_restorable(true, 0);
        assert!(!history.restorable);
        restore_history(&fake, &mut history).await;
        assert!(history.pending[0]);
        assert_eq!(*fake.value.borrow(), 120);
        let general = Fake::new();
        let mut history = apply_plan(&general, super::tests::plan()).await;
        restore_history(&general, &mut history).await;
        assert!(history.pending.iter().all(|pending| !pending));
    }

    #[tokio::test]
    async fn timing_audio_change_during_write_keeps_uncertain_history_instead_of_success() {
        let conditions = std::sync::Arc::new(Conditions::default());
        conditions.lifecycle(true);
        let mut fake = TimingFake::new(0);
        fake.conditions_on_write = Some(conditions.clone());
        let mut binding = timing_binding(0);
        binding.audio = conditions.snapshot().unwrap();
        let plan = timing_plan(&fake, binding, timing_request(120), 1)
            .await
            .unwrap();
        let history = apply_plan(&fake, plan).await;
        assert_eq!(*fake.value.borrow(), 120);
        assert!(history.pending[0]);
        assert!(history.results[0].contains("要確認"));
        assert_ne!(history.results[0], "適用済み");
    }

    #[test]
    fn setup_proposals_preserve_sync_offsets_but_keep_routing_changes() {
        for offset in [-240, 0, 175] {
            let mut changes = Vec::new();
            push(
                &mut changes,
                "mic",
                "同期オフセット（ms）",
                Field::Sync,
                json!(offset),
                json!(0),
            );
            push(
                &mut changes,
                "mic",
                "ミュート",
                Field::Muted,
                json!(true),
                json!(false),
            );
            assert_eq!(changes.len(), 1);
            assert!(matches!(changes[0].field, Field::Muted));
            assert_eq!(changes[0].before, json!(true));
            assert_eq!(changes[0].after, json!(false));
        }
    }

    #[tokio::test]
    async fn legacy_sync_history_can_still_restore_previous_offset() {
        let fake = Fake::new();
        fake.values.borrow_mut()[0] = json!(175);
        let mut old_plan = plan();
        old_plan.changes.truncate(1);
        old_plan.changes[0].field = Field::Sync;
        old_plan.changes[0].before = json!(175);
        old_plan.changes[0].after = json!(0);
        let mut history = apply_plan(&fake, old_plan).await;
        assert_eq!(fake.values.borrow()[0], json!(0));
        restore_history(&fake, &mut history).await;
        assert_eq!(fake.values.borrow()[0], json!(175));
        assert_eq!(history.results, ["復元済み"]);
    }

    #[tokio::test]
    async fn disconnect_keeps_history_and_expires_plan_without_reusing_ids() {
        let fake = Fake::new();
        let original = apply_plan(&fake, plan()).await;
        let state = ObsState::new();
        {
            let mut setup = state.setup.lock().await;
            setup.next_id = 9;
            setup.plan = Some(plan());
            setup.history.push(original.clone());
            setup.invalidate_plan();
            assert!(setup.plan.is_none());
            assert_eq!(setup.next_id, 9);
            assert_eq!(setup.history.len(), 1);
            assert_eq!(setup.history[0].pending, original.pending);
        }
        assert!(original.same_connection(0));
        state.setup_generation.fetch_add(1, Ordering::SeqCst);
        assert!(!original.same_connection(1));
        let items = history(&state).await;
        assert_eq!(items.len(), 1);
        assert!(!items[0].restorable);
        assert_eq!(items[0].results, original.results);
        assert_eq!(items[0].changes[0].before, original.changes[0].before);
        forget_history(&state, original.id)
            .await
            .expect("明示的な履歴削除");
        assert!(history(&state).await.is_empty());
        assert_eq!(*fake.writes.borrow(), vec![0, 1]); // 履歴操作はOBSへ書かない。
    }

    #[test]
    fn source_invalidation_preserves_unrelated_history_and_rejects_reused_names() {
        let original = HashMap::new();
        let removed = HashMap::from([("created".into(), 1)]);
        assert!(validate_source_generation(&removed, &original, "mic").is_ok());
        assert!(validate_source_generation(&removed, &original, "created").is_err());
        let renamed = HashMap::from([("old".into(), 1), ("new".into(), 1)]);
        for name in ["old", "new"] {
            assert!(validate_source_generation(&renamed, &original, name).is_err());
        }
        assert!(validate_source_generation(&renamed, &original, "mic").is_ok());
        assert!(validate_source_generation(&renamed, &renamed, "new").is_ok());
    }
    use std::cell::RefCell;
    struct Fake {
        values: RefCell<Vec<Value>>,
        writes: RefCell<Vec<usize>>,
        fail: Option<usize>,
        collection: String,
        generation: Option<Arc<AtomicU64>>,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                values: RefCell::new(vec![json!(true), json!(true)]),
                writes: RefCell::new(vec![]),
                fail: None,
                collection: "test".into(),
                generation: None,
            }
        }
    }
    impl Access for Fake {
        async fn collection(&self) -> Result<String, String> {
            Ok(self.collection.clone())
        }
        async fn read(&self, c: &Change) -> Result<Value, String> {
            Ok(self.values.borrow()[c.source.parse::<usize>().map_err(error)?].clone())
        }
        async fn write(&self, c: &mut Change, v: Value) -> Result<(), String> {
            let index = c.source.parse::<usize>().map_err(error)?;
            self.writes.borrow_mut().push(index);
            self.values.borrow_mut()[index] = v;
            if let Some(generation) = &self.generation {
                generation.fetch_add(1, Ordering::SeqCst);
            }
            // OBS が変更を受け付けたが応答を失った場合を含む。
            if self.fail == Some(index) {
                Err("通信切断".into())
            } else {
                Ok(())
            }
        }
    }
    fn plan() -> Plan {
        Plan {
            audio: None,
            id: 1,
            supported: true,
            message: String::new(),
            message_text: None,
            collection: "test".into(),
            generation: 0,
            source_generations: HashMap::new(),
            duplicate_mic_sources: vec![],
            timing: None,
            changes: (0..2)
                .map(|i| Change {
                    source: i.to_string(),
                    label: "ミュート".into(),
                    field: Field::Muted,
                    before: json!(true),
                    after: json!(false),
                    before_display: None,
                    after_display: None,
                    field_code: None,
                    label_text: None,
                    before_text: None,
                    after_text: None,
                })
                .collect(),
        }
    }
    #[tokio::test]
    async fn completed_history_reflects_generation_changes_during_apply() {
        let generation = Arc::new(AtomicU64::new(0));
        let mut fake = Fake::new();
        fake.generation = Some(generation.clone());
        let mut applied = apply_plan(&fake, plan()).await;
        applied.refresh_restorable(true, generation.load(Ordering::SeqCst));
        assert!(!applied.restorable);
        assert!(applied.pending.iter().any(|pending| *pending));
        let unchanged = Fake::new();
        let mut current = apply_plan(&unchanged, plan()).await;
        current.refresh_restorable(true, 0);
        assert!(current.restorable);
        current.refresh_restorable(false, 0);
        assert!(!current.restorable);
    }

    #[tokio::test]
    async fn apply_and_restore_reverse_order() {
        let fake = Fake::new();
        let mut h = apply_plan(&fake, plan()).await;
        assert_eq!(h.results, vec!["適用済み", "適用済み"]);
        restore_history(&fake, &mut h).await;
        assert_eq!(*fake.writes.borrow(), vec![0, 1, 1, 0]);
        assert!(h.pending.iter().all(|v| !v));
        assert_eq!(*fake.values.borrow(), vec![json!(true), json!(true)]);
    }
    fn assert_typed(history: &History, outcomes: &[Outcome]) {
        let entries = history.result_entries.as_ref().unwrap();
        assert_eq!(entries.len(), outcomes.len());
        assert_eq!(entries.len(), history.results.len());
        for ((entry, legacy), outcome) in entries.iter().zip(&history.results).zip(outcomes) {
            assert_eq!(&entry.outcome, outcome);
            assert_eq!(&entry.text.fallback_ja, legacy);
            assert!(entry.text.args.is_empty()); // arbitrary remote errors are fallback only
        }
    }
    #[tokio::test]
    async fn typed_partial_restore_and_original_results_keep_pending_authority() {
        let mut fake = Fake::new();
        fake.fail = Some(1);
        let mut history = apply_plan(&fake, plan()).await;
        assert_typed(&history, &[Outcome::Applied, Outcome::ApplyUnknown]);
        fake.fail = Some(0);
        restore_history(&fake, &mut history).await;
        assert_typed(&history, &[Outcome::RestoreFailed, Outcome::Restored]);
        assert_eq!(history.pending, [true, false]);
        fake.fail = None;
        restore_history(&fake, &mut history).await;
        assert_typed(&history, &[Outcome::AlreadyOriginal, Outcome::Restored]);
        assert_eq!(history.pending, [false, false]);
        let stale = Fake::new();
        stale.values.borrow_mut()[0] = json!(false);
        let rejected = apply_plan(&stale, plan()).await;
        assert_typed(&rejected, &[Outcome::Conflict, Outcome::NotRun]);
        assert!(stale.writes.borrow().is_empty());
    }
    #[tokio::test]
    async fn typed_audio_invalid_restore_is_deferred_or_unknown_without_clearing_pending() {
        let conditions = Arc::new(Conditions::default());
        conditions.lifecycle(true);
        let mut binding = timing_binding(0);
        binding.audio = conditions.snapshot().unwrap();
        let mut fake = TimingFake::new(0);
        let plan = timing_plan(&fake, binding, timing_request(10), 1)
            .await
            .unwrap();
        let mut history = apply_plan(&fake, plan).await;
        fake.conditions_on_write = Some(conditions.clone());
        restore_history(&fake, &mut history).await;
        assert_typed(&history, &[Outcome::RestoreUnknown]);
        assert!(history.pending[0]);
        let writes = fake.writes.borrow().len();
        restore_history(&fake, &mut history).await;
        assert_typed(&history, &[Outcome::RestoreDeferred]);
        assert_eq!(fake.writes.borrow().len(), writes);
        assert!(history.pending[0]);
    }
    #[test]
    fn typed_values_use_whitelisted_scalars_and_never_arbitrary_settings_or_owner_tokens() {
        let secret = "opaque-credential-or-state-sentinel";
        let mut settings = plan().changes.remove(0);
        settings.field = Field::Settings;
        settings.before =
            json!({"device_id":"device-a", "password":secret,"nested":{"state":secret}});
        settings.after = json!({"device_id":"device-b", "password":secret});
        settings.refresh_text();
        let wire = serde_json::to_value((
            &settings.before_text.as_ref().unwrap().args,
            &settings.after_text.as_ref().unwrap().args,
        ))
        .unwrap();
        assert!(!wire.to_string().contains(secret));
        assert!(wire.to_string().contains("device-a"));
        let mut creation = creation_plan().changes.remove(0);
        creation.refresh_text();
        let wire = serde_json::to_string(&creation.after_text).unwrap();
        assert!(!wire.contains("owned-token"));
        let text = UiText::new("test.scalar", "fallback")
            .number("n", 1.5)
            .number("invalid", f64::NAN)
            .boolean("enabled", true)
            .text("name", "source");
        let args = serde_json::to_value(text).unwrap()["args"].clone();
        assert!(args.get("invalid").is_none());
        assert!(args
            .as_object()
            .unwrap()
            .values()
            .all(|v| v.is_string() || v.is_number() || v.is_boolean()));
    }
    #[tokio::test]
    async fn one_stale_value_prevents_all_writes() {
        let fake = Fake::new();
        fake.values.borrow_mut()[1] = json!(false);
        let h = apply_plan(&fake, plan()).await;
        assert!(fake.writes.borrow().is_empty());
        assert!(h.results[1].starts_with("競合"));
    }
    #[tokio::test]
    async fn partial_failure_keeps_undo_for_uncertain_write() {
        let mut fake = Fake::new();
        fake.fail = Some(1);
        let mut h = apply_plan(&fake, plan()).await;
        assert_eq!(h.results[0], "適用済み");
        assert!(h.results[1].starts_with("失敗"));
        assert_eq!(h.pending, vec![true, true]);
        fake.fail = None;
        restore_history(&fake, &mut h).await;
        assert_eq!(*fake.values.borrow(), vec![json!(true), json!(true)]);
    }
    #[tokio::test]
    async fn restore_preserves_later_user_edit() {
        let fake = Fake::new();
        let mut h = apply_plan(&fake, plan()).await;
        fake.values.borrow_mut()[1] = json!("user value");
        restore_history(&fake, &mut h).await;
        assert_eq!(fake.values.borrow()[1], json!("user value"));
        assert!(h.results[1].starts_with("競合"));
        assert_eq!(h.results[0], "復元済み");
        assert!(h.pending[1]);
    }
    #[tokio::test]
    async fn restore_does_not_write_to_other_collection() {
        let mut fake = Fake::new();
        let mut h = apply_plan(&fake, plan()).await;
        fake.collection = "other".into();
        restore_history(&fake, &mut h).await;
        assert_eq!(*fake.writes.borrow(), vec![0, 1]);
        assert!(h.results.iter().all(|r| r.starts_with("競合")));
    }
    #[tokio::test]
    async fn repeated_restore_is_noop() {
        let fake = Fake::new();
        let mut h = apply_plan(&fake, plan()).await;
        restore_history(&fake, &mut h).await;
        restore_history(&fake, &mut h).await;
        assert_eq!(fake.writes.borrow().len(), 4);
    }

    #[tokio::test]
    async fn conflicting_newer_source_does_not_block_older_source() {
        let fake = Fake::new();
        let mut first = plan();
        first.changes.truncate(1);
        let mut second = plan();
        second.id = 2;
        second.changes.remove(0);
        let mut histories = vec![
            apply_plan(&fake, first).await,
            apply_plan(&fake, second).await,
        ];
        fake.values.borrow_mut()[1] = json!("user edit");
        restore_history(&fake, &mut histories[1]).await;
        assert!(histories[1].pending[0]);
        assert!(histories[1].results[0].starts_with("競合"));
        assert!(ensure_restore_order(&histories, 0).is_ok());
        restore_history(&fake, &mut histories[0]).await;
        assert_eq!(*fake.values.borrow(), vec![json!(true), json!("user edit")]);
        assert!(!histories[0].pending[0]);
    }

    #[tokio::test]
    async fn uncertain_write_still_blocks_older_change_to_same_source() {
        let mut fake = Fake::new();
        let mut first = plan();
        first.changes.truncate(1);
        let h1 = apply_plan(&fake, first).await;
        let mut second = plan();
        second.id = 2;
        second.changes.truncate(1);
        second.changes[0].before = json!(false);
        second.changes[0].after = json!(true);
        fake.fail = Some(0);
        let h2 = apply_plan(&fake, second).await;
        assert!(h2.results[0].starts_with("失敗"));
        assert!(h2.pending[0]);
        let mut histories = vec![h1, h2];
        assert!(ensure_restore_order(&histories, 0).is_err());
        fake.fail = None;
        restore_history(&fake, &mut histories[1]).await;
        assert!(ensure_restore_order(&histories, 0).is_ok());
        restore_history(&fake, &mut histories[0]).await;
        assert_eq!(fake.values.borrow()[0], json!(true));
    }

    fn creation_plan() -> Plan {
        let mut p = plan();
        p.changes = vec![Change {
            source: "created".into(),
            label: "作成".into(),
            before: Value::Null,
            after: json!({"scene":"test","device_id":"disabled","enabled":false}),
            before_display: None,
            after_display: None,
            field_code: None,
            label_text: None,
            before_text: None,
            after_text: None,
            field: Field::Create {
                scene: "test".into(),
                item: None,
                token: "owned-token".into(),
                index: 0,
            },
        }];
        p
    }

    fn initial_creation_snapshot() -> Value {
        json!({"item":{"sceneItemId":7,"sceneItemIndex":0,"sourceName":"created"},
            "settings":{"inputKind":WASAPI_INPUT_KIND,"inputSettings":{"device_id":"disabled","auralyn_setup_token":"owned-token"}},
            "muted":false,"monitor":"OBS_MONITORING_TYPE_NONE","sync":0,
            "volume":{"inputVolumeMul":1.0,"inputVolumeDb":0.0},"balance":0.5,
            "tracks":[true,true,true,true,true,true],"filters":[],"enabled":false,"locked":false,
            "transform":{"sourceWidth":0.0,"sourceHeight":0.0,"positionX":0.0,"positionY":0.0,"rotation":0.0,"scaleX":1.0,"scaleY":1.0,"width":0.0,"height":0.0,"alignment":5,"boundsType":"OBS_BOUNDS_NONE","boundsAlignment":0,"boundsWidth":0.0,"boundsHeight":0.0,"cropLeft":0,"cropRight":0,"cropTop":0,"cropBottom":0}})
    }

    struct CreationFake {
        remote: RefCell<Value>,
        returned_id: bool,
    }
    impl Access for CreationFake {
        async fn collection(&self) -> Result<String, String> {
            Ok("test".into())
        }
        async fn read(&self, _: &Change) -> Result<Value, String> {
            Ok(self.remote.borrow().clone())
        }
        async fn write(&self, c: &mut Change, value: Value) -> Result<(), String> {
            if value.is_null() {
                *self.remote.borrow_mut() = Value::Null;
                return Ok(());
            }
            *self.remote.borrow_mut() = initial_creation_snapshot();
            if self.returned_id {
                if let Field::Create { item, .. } = &mut c.field {
                    *item = Some(7);
                }
            }
            Err("作成応答／直後の取得が失敗".into())
        }
        async fn recover_creation(&self, c: &mut Change) -> Result<(), String> {
            let snapshot = self.remote.borrow().clone();
            if snapshot.is_null() {
                return Ok(());
            }
            adopt_creation_snapshot(c, 7, snapshot)
        }
    }

    #[tokio::test]
    async fn lost_create_response_and_failed_initial_snapshot_can_be_restored() {
        for returned_id in [false, true] {
            let fake = CreationFake {
                remote: RefCell::new(Value::Null),
                returned_id,
            };
            let mut history = apply_plan(&fake, creation_plan()).await;
            assert!(history.results[0].starts_with("失敗"));
            assert!(history.pending[0]);
            restore_history(&fake, &mut history).await;
            assert_eq!(history.results[0], "復元済み");
            assert!(!history.pending[0]);
            assert!(fake.remote.borrow().is_null());
        }
    }

    #[tokio::test]
    async fn uncertain_creation_does_not_delete_foreign_or_modified_source() {
        for (pointer, value) in [
            (
                "/settings/inputSettings/auralyn_setup_token",
                json!("foreign"),
            ),
            ("/settings/inputSettings/device_id", json!("user-device")),
            ("/volume/inputVolumeMul", json!(0.5)),
            ("/monitor", json!("OBS_MONITORING_TYPE_MONITOR_ONLY")),
            ("/enabled", json!(true)),
            ("/filters", json!([{"name":"user filter"}])),
            ("/transform/positionX", json!(42.0)),
            ("/item/sceneItemIndex", json!(1)),
            ("/item/sceneItemId", json!(8)),
        ] {
            let fake = CreationFake {
                remote: RefCell::new(Value::Null),
                returned_id: false,
            };
            let mut history = apply_plan(&fake, creation_plan()).await;
            *fake
                .remote
                .borrow_mut()
                .pointer_mut(pointer)
                .expect("fixture field") = value;
            let modified = fake.remote.borrow().clone();
            restore_history(&fake, &mut history).await;
            assert!(history.results[0].starts_with("復元保留"), "{pointer}");
            assert!(history.pending[0]);
            assert_eq!(*fake.remote.borrow(), modified);
        }
    }

    #[tokio::test]
    async fn failed_creation_with_no_source_needs_no_removal() {
        let fake = CreationFake {
            remote: RefCell::new(Value::Null),
            returned_id: false,
        };
        let mut history = apply_plan(&fake, creation_plan()).await;
        *fake.remote.borrow_mut() = Value::Null;
        restore_history(&fake, &mut history).await;
        assert_eq!(history.results[0], "元の値を確認");
        assert!(!history.pending[0]);
    }
}
