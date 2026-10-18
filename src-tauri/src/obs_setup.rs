//! OBS の変更予定は接続中、履歴はアプリ終了まで保持する。フロントから任意の設定値は受け取らない。
use crate::obs::{
    is_audio_input_capture_kind, is_cable_output_device_name, ObsState, AURALYN_OBS_SOURCE_NAME,
    WASAPI_INPUT_KIND,
};
use obws::{
    common::MonitorType,
    requests::inputs::{Create, SetSettings},
    Client,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use time::Duration;
use tokio::sync::Mutex;

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub source: String,
    pub label: String,
    pub before: Value,
    pub after: Value,
    pub before_display: Option<String>,
    pub after_display: Option<String>,
    #[serde(skip)]
    field: Field,
}

#[derive(Clone)]
enum Field {
    Settings,
    Muted,
    Monitor,
    Sync,
    Create {
        scene: String,
        item: Option<i64>,
        token: String,
        index: usize,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: u64,
    pub supported: bool,
    pub message: String,
    pub changes: Vec<Change>,
    pub duplicate_mic_sources: Vec<String>,
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
    pub id: u64,
    pub restorable: bool,
    pub connection_label: String,
    pub changes: Vec<Change>,
    pub results: Vec<String>,
    #[serde(skip)]
    collection: String,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    source_generations: HashMap<String, u64>,
    #[serde(skip)]
    pending: Vec<bool>,
}

impl History {
    fn same_connection(&self, generation: u64) -> bool {
        self.generation == generation
    }

    fn refresh_restorable(&mut self, connected: bool, generation: u64) {
        self.restorable = connected && self.same_connection(generation);
    }
}

#[derive(Default)]
pub struct SetupState {
    next_id: u64,
    plan: Option<Plan>,
    history: Vec<History>,
}

impl SetupState {
    pub fn invalidate_plan(&mut self) {
        self.plan = None;
    }
}

fn error(e: impl std::fmt::Display) -> String {
    format!("OBS の確認・変更に失敗しました: {e}")
}

fn push(
    changes: &mut Vec<Change>,
    source: &str,
    label: &str,
    field: Field,
    before: Value,
    after: Value,
) {
    if before != after {
        changes.push(Change {
            source: source.into(),
            label: label.into(),
            field,
            before,
            after,
            before_display: None,
            after_display: None,
        });
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
        id: setup.next_id,
        supported: missing.is_empty(),
        message: String::new(),
        changes: vec![],
        duplicate_mic_sources: vec![],
        collection: String::new(),
        generation: state.setup_generation.load(Ordering::SeqCst),
        source_generations: state.source_generations.lock().await.clone(),
    };
    if !plan.supported {
        plan.message =
            "この OBS では安全な変更・復元に必要な操作が使えません。手動の手順をご利用ください。"
                .into();
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
                c.before_display = Some(before_display);
                c.after_display = Some(after_display);
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
        push(
            &mut plan.changes,
            &input.name,
            "同期オフセット（ms）",
            Field::Sync,
            json!(client
                .inputs()
                .audio_sync_offset(&input.name)
                .await
                .map_err(error)?
                .whole_milliseconds() as i64),
            json!(0),
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
        self.client.collection().await
    }
    async fn read(&self, c: &Change) -> Result<Value, String> {
        self.validate_source(&c.source).await?;
        self.client.read(c).await
    }
    async fn write(&self, c: &mut Change, value: Value) -> Result<(), String> {
        self.validate_source(&c.source).await?;
        self.client.write(c, value).await
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
        if !found.is_some_and(|i| is_audio_input_capture_kind(&i.kind, &i.unversioned_kind)) {
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
            Field::Sync => json!(self
                .inputs()
                .audio_sync_offset(&c.source)
                .await
                .map_err(error)?
                .whole_milliseconds() as i64),
            Field::Create { .. } => unreachable!(),
        })
    }
    async fn write(&self, c: &mut Change, value: Value) -> Result<(), String> {
        match &mut c.field {
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
            Field::Sync => self
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
        id: plan.id,
        restorable: true,
        connection_label: String::new(),
        collection: plan.collection,
        generation: plan.generation,
        source_generations: plan.source_generations,
        pending: vec![false; plan.changes.len()],
        results: vec!["未実行".into(); plan.changes.len()],
        changes: plan.changes,
    };
    // 予定の全項目を読み直す。競合があれば変更を一つも送らない。
    for (index, c) in history.changes.iter().enumerate() {
        match access.read(c).await {
            Ok(current) if current == c.before => {}
            _ => {
                history.results[index] =
                    "競合: OBS の現在値が変わりました。再確認してください。".into();
                return history;
            }
        }
    }
    for index in 0..history.changes.len() {
        let c = &mut history.changes[index];
        if access.collection().await.as_deref() != Ok(history.collection.as_str())
            || access.read(c).await.ok().as_ref() != Some(&c.before)
        {
            history.results[index] = "競合: 適用を中断しました".into();
            break;
        }
        // タイムアウトでも OBS 側で変更済みの可能性があるため、送信前に復元候補にする。
        history.pending[index] = true;
        let after = c.after.clone();
        match access.write(c, after).await {
            Ok(()) => history.results[index] = "適用済み".into(),
            Err(e) => {
                history.results[index] = format!("失敗（適用状態を要確認）: {e}");
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
        if access.collection().await.as_deref() != Ok(history.collection.as_str()) {
            history.results[index] = "競合: シーンコレクションが違うため復元しません".into();
            continue;
        }
        let c = &mut history.changes[index];
        if let Err(e) = access.recover_creation(c).await {
            history.results[index] = format!("復元保留: {e}");
            continue;
        }
        match access.read(c).await {
            Ok(current) if current == c.before => {
                history.pending[index] = false;
                history.results[index] = "元の値を確認".into();
            }
            Ok(current) if current == c.after => {
                let before = c.before.clone();
                match access.write(c, before).await {
                    Ok(()) => {
                        history.pending[index] = false;
                        history.results[index] = "復元済み".into();
                    }
                    Err(e) => history.results[index] = format!("復元失敗: {e}"),
                }
            }
            _ => {
                history.results[index] =
                    "競合: 後から変更された可能性があるため復元しません。OBS で確認してください。"
                        .into()
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
            id: 1,
            supported: true,
            message: String::new(),
            collection: "test".into(),
            generation: 0,
            source_generations: HashMap::new(),
            duplicate_mic_sources: vec![],
            changes: (0..2)
                .map(|i| Change {
                    source: i.to_string(),
                    label: "ミュート".into(),
                    field: Field::Muted,
                    before: json!(true),
                    after: json!(false),
                    before_display: None,
                    after_display: None,
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
