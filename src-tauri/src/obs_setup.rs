//! OBS の変更予定と履歴は接続中だけ保持する。フロントから任意の設定値は受け取らない。
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
use std::sync::atomic::{AtomicU64, Ordering};
use time::Duration;

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
    Create { scene: String, item: Option<i64> },
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub id: u64,
    pub changes: Vec<Change>,
    pub results: Vec<String>,
    #[serde(skip)]
    collection: String,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    pending: Vec<bool>,
}

#[derive(Default)]
pub struct SetupState {
    next_id: u64,
    plan: Option<Plan>,
    history: Vec<History>,
}

impl SetupState {
    pub fn reset(&mut self) {
        self.plan = None;
        self.history.clear();
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
    };
    if !plan.supported {
        plan.message =
            "この OBS では安全な変更・復元に必要な操作が使えません。手動の手順をご利用ください。"
                .into();
        return Ok(plan);
    }
    setup.history.retain(|h| h.pending.iter().any(|p| *p));
    if setup.history.len() >= 20 {
        return Err("変更履歴が20件あります。先に元に戻してください。".into());
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
        push(
            &mut plan.changes,
            AURALYN_OBS_SOURCE_NAME,
            "新規ソースを無効で追加（デバイスはOBSで指定）",
            Field::Create {
                scene: scene.clone(),
                item: None,
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
}

struct Session<'a> {
    client: &'a Client,
    generation: &'a AtomicU64,
    expected: u64,
}
impl Session<'_> {
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
        self.validate()?;
        self.client.read(c).await
    }
    async fn write(&self, c: &mut Change, value: Value) -> Result<(), String> {
        self.validate()?;
        self.client.write(c, value).await
    }
}

impl Access for Client {
    async fn collection(&self) -> Result<String, String> {
        self.scene_collections().current().await.map_err(error)
    }
    async fn read(&self, c: &Change) -> Result<Value, String> {
        // 種別の異なる同名ソースへの変更を防ぐ。
        let inputs = self.inputs().list(None).await.map_err(error)?;
        let found = inputs.iter().find(|i| i.name == c.source);
        if let Field::Create { scene, item } = &c.field {
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
            Field::Create { scene, item } => {
                if value.is_null() {
                    self.scene_items()
                        .remove(
                            scene,
                            item.ok_or("作成結果が不明です。OBS で手動確認してください")?,
                        )
                        .await
                        .map_err(error)
                } else {
                    let settings = json!({"device_id":"disabled"});
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
}

async fn apply_plan(access: &impl Access, plan: Plan) -> History {
    let mut history = History {
        id: plan.id,
        collection: plan.collection,
        generation: plan.generation,
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
    };
    session.validate()?;
    let history = apply_plan(&session, plan).await;
    setup.history.push(history.clone());
    Ok(history)
}

pub async fn history(state: &ObsState) -> Vec<History> {
    state.setup.lock().await.history.clone()
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
    ensure_restore_order(&setup.history, index)?;
    setup.plan = None;
    let session = Session {
        client,
        generation: &state.setup_generation,
        expected: setup.history[index].generation,
    };
    restore_history(&session, &mut setup.history[index]).await;
    Ok(setup.history[index].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    struct Fake {
        values: RefCell<Vec<Value>>,
        writes: RefCell<Vec<usize>>,
        fail: Option<usize>,
        collection: String,
    }
    impl Fake {
        fn new() -> Self {
            Self {
                values: RefCell::new(vec![json!(true), json!(true)]),
                writes: RefCell::new(vec![]),
                fail: None,
                collection: "test".into(),
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
}
