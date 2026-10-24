//! 配信状態に含めるOBS値。任意settings・接続資格情報・同期値を保持しない。
use super::*;
mod intent;
use intent::BundleAccess;

pub(super) async fn rpc<T>(
    future: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(std::time::Duration::from_secs(3), future)
        .await
        .map_err(|_| "OBSの応答期限を超えました（変更要求後は適用状態を要確認）".to_string())?
}
pub(crate) use intent::{observe_filter_event, FilterIntent};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub source: String,
    pub volume: bool,
    pub muted: bool,
    pub monitor: bool,
    pub filters: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Property {
    Volume,
    Muted,
    Monitor,
    FilterEnabled { name: String, kind: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    pub source: String,
    pub kind: String,
    pub property: Property,
    pub value: Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Saved {
    pub collection: String,
    pub items: Vec<Item>,
}

pub fn validate(saved: &Saved) -> Result<(), String> {
    if saved.collection.is_empty() || saved.items.is_empty() || saved.items.len() > 128 {
        return Err("OBS保存対象が不正です（最大128項目）".into());
    }
    let mut seen = std::collections::HashSet::new();
    for item in &saved.items {
        if item.source.is_empty()
            || item.kind.is_empty()
            || !seen.insert((
                item.source.clone(),
                serde_json::to_string(&item.property).map_err(error)?,
            ))
        {
            return Err("OBS対象が空または重複しています".into());
        }
        match &item.property {
            Property::Volume
                if item
                    .value
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && (0.0..=20.0).contains(&v)) => {}
            Property::Muted | Property::FilterEnabled { .. } if item.value.is_boolean() => {}
            Property::Monitor
                if serde_json::from_value::<MonitorType>(item.value.clone()).is_ok() => {}
            _ => return Err("保存されたOBS値が不正です".into()),
        }
        if let Property::FilterEnabled { name, kind } = &item.property {
            if name.is_empty() || kind.is_empty() {
                return Err("保存されたフィルタ対象が不正です".into());
            }
        }
    }
    Ok(())
}

pub(super) async fn read_property(
    client: &Client,
    source: &str,
    property: &Property,
) -> Result<Value, String> {
    Ok(match property {
        Property::Volume => json!(client.inputs().volume(source).await.map_err(error)?.mul),
        Property::Muted => json!(client.inputs().muted(source).await.map_err(error)?),
        Property::Monitor => json!(client
            .inputs()
            .audio_monitor_type(source)
            .await
            .map_err(error)?),
        Property::FilterEnabled { name, kind } => {
            let filters = client.filters().list(source).await.map_err(error)?;
            let filter = filters
                .iter()
                .find(|f| f.name == *name && f.kind == *kind)
                .ok_or("保存した名前・種類のフィルタが見つかりません")?;
            json!(filter.enabled)
        }
    })
}

pub(super) async fn write_property(
    client: &Client,
    source: &str,
    property: &Property,
    value: Value,
) -> Result<(), String> {
    match property {
        Property::Volume => client
            .inputs()
            .set_volume(
                source,
                obws::requests::inputs::Volume::Mul(value.as_f64().ok_or("不正な音量")? as f32),
            )
            .await
            .map_err(error),
        Property::Muted => client
            .inputs()
            .set_muted(source, value.as_bool().ok_or("不正なミュート")?)
            .await
            .map_err(error),
        Property::Monitor => client
            .inputs()
            .set_audio_monitor_type(source, serde_json::from_value(value).map_err(error)?)
            .await
            .map_err(error),
        Property::FilterEnabled { name, .. } => client
            .filters()
            .set_enabled(obws::requests::filters::SetEnabled {
                source,
                filter: name,
                enabled: value.as_bool().ok_or("不正なフィルタ有効値")?,
            })
            .await
            .map_err(error),
    }
}

pub async fn sources(state: &ObsState) -> Result<Vec<String>, String> {
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("OBSに手動で接続してください")?;
    Ok(
        rpc(async { client.inputs().list(None).await.map_err(error) })
            .await?
            .into_iter()
            .map(|i| i.name)
            .collect(),
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterChoice {
    pub name: String,
    pub kind: String,
    pub enabled: bool,
}
pub async fn filters(state: &ObsState, source: &str) -> Result<Vec<FilterChoice>, String> {
    let generation = state.setup_generation.load(Ordering::SeqCst);
    let client = state
        .client
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or("OBSに手動で接続してください")?;
    let filters = rpc(async { client.filters().list(source).await.map_err(error) }).await?;
    if state.setup_generation.load(Ordering::SeqCst) != generation {
        return Err("OBS接続が変わりました。対象を再取得してください".into());
    }
    Ok(filters
        .into_iter()
        .map(|f| FilterChoice {
            name: f.name,
            kind: f.kind,
            enabled: f.enabled,
        })
        .collect())
}

pub async fn capture(state: &ObsState, selection: &[Selection]) -> Result<Saved, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        capture_inner(state, selection),
    )
    .await
    .map_err(|_| "OBS取得の期限を超えました。元の保存内容を保持しています".to_string())?
}
async fn capture_inner(state: &ObsState, selection: &[Selection]) -> Result<Saved, String> {
    if selection.is_empty() || selection.len() > 32 {
        return Err("OBSソースを1〜32件選んでください".into());
    }
    let fields = selection
        .iter()
        .try_fold(0usize, |count, s| {
            count.checked_add(
                usize::from(s.volume)
                    + usize::from(s.muted)
                    + usize::from(s.monitor)
                    + s.filters.len(),
            )
        })
        .ok_or("OBS選択項目数が不正です")?;
    if fields == 0 || fields > 128 {
        return Err("OBSの保存項目は合計1〜128件です".into());
    }
    let generation = state.setup_generation.load(Ordering::SeqCst);
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("OBSに手動で接続してください")?;
    let collection = client.collection().await?;
    let inputs = client.inputs().list(None).await.map_err(error)?;
    let mut items = Vec::new();
    for selected in selection {
        let input = inputs
            .iter()
            .find(|i| i.name == selected.source)
            .ok_or("選択したOBSソースがありません")?;
        let mut properties = Vec::new();
        if selected.volume {
            properties.push(Property::Volume);
        }
        if selected.muted {
            properties.push(Property::Muted);
        }
        if selected.monitor {
            properties.push(Property::Monitor);
        }
        if !selected.filters.is_empty() {
            let filters = client
                .filters()
                .list(&selected.source)
                .await
                .map_err(error)?;
            for name in &selected.filters {
                let filter = filters
                    .iter()
                    .find(|f| f.name == *name)
                    .ok_or("選択したOBSフィルタがありません")?;
                properties.push(Property::FilterEnabled {
                    name: name.clone(),
                    kind: filter.kind.clone(),
                });
            }
        }
        for property in properties {
            let value = read_property(client, &selected.source, &property).await?;
            items.push(Item {
                source: selected.source.clone(),
                kind: input.kind.clone(),
                property,
                value,
            });
        }
    }
    if generation != state.setup_generation.load(Ordering::SeqCst)
        || client.collection().await? != collection
    {
        return Err("取得中にOBSの構成が変わりました。保存していません".into());
    }
    let saved = Saved { collection, items };
    validate(&saved)?;
    Ok(saved)
}

pub async fn preview(state: &ObsState, saved: &Saved) -> Result<Plan, String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        preview_inner(state, saved),
    )
    .await
    .map_err(|_| "OBS差分確認の期限を超えました。適用していません".to_string())?
}
async fn preview_inner(state: &ObsState, saved: &Saved) -> Result<Plan, String> {
    validate(saved)?;
    let guard = state.client.lock().await;
    let client = guard.as_ref().ok_or("OBSに手動で接続してください")?;
    if client.collection().await? != saved.collection {
        return Err(
            "保存したシーンコレクションと異なります。OBSで切り替えてから再確認してください".into(),
        );
    }
    let generation = state.setup_generation.load(Ordering::SeqCst);
    let source_generations = state.source_generations.lock().await.clone();
    let mut changes = Vec::new();
    // 変更なしの項目も保存し、Auralyn適用後の全対象再read・競合照合に使う。
    for item in &saved.items {
        let mut change = Change {
            source: item.source.clone(),
            label: match &item.property {
                Property::Volume => "音量".into(),
                Property::Muted => "ミュート".into(),
                Property::Monitor => "モニター".into(),
                Property::FilterEnabled { name, .. } => format!("フィルタ有効: {name}"),
            },
            before: Value::Null,
            after: item.value.clone(),
            before_display: None,
            after_display: None,
            field_code: None,
            label_text: None,
            before_text: None,
            after_text: None,
            field: Field::Bundle {
                kind: item.kind.clone(),
                property: item.property.clone(),
            },
        };
        change.before = client.read(&change).await?;
        change.refresh_text();
        changes.push(change);
    }
    if generation != state.setup_generation.load(Ordering::SeqCst)
        || source_generations != *state.source_generations.lock().await
    {
        return Err("確認中にOBSの構成が変わりました".into());
    }
    let mut setup = state.setup.lock().await;
    setup.next_id = setup.next_id.checked_add(1).ok_or("履歴IDの上限です")?;
    Ok(Plan {
        audio: None,
        id: setup.next_id,
        supported: true,
        message: "選択した既存項目だけを変更します".into(),
        message_text: Some(UiText::new(
            "obs.plan.selectedExisting",
            "選択した既存項目だけを変更します",
        )),
        changes,
        duplicate_mic_sources: vec![],
        timing: None,
        collection: saved.collection.clone(),
        generation,
        source_generations,
    })
}

pub async fn apply(state: &ObsState, mut plan: Plan, audio: Witness) -> Result<History, String> {
    plan.audio = Some(audio);
    let session = BundleAccess::new(
        state,
        plan.id,
        plan.generation,
        plan.audio.clone(),
        plan.source_generations.clone(),
    )
    .await?;
    session.validate()?;
    let mut history = apply_plan(&session, plan).await;
    history.source_generations = session.expected_sources()?;
    let mut setup = state.setup.lock().await;
    // 履歴lockの待機中に接続/音声条件が変わっても、古い成功を公開しない。
    if session.validate_all(&history.changes).await.is_err() {
        invalidate_completion(&mut history, false);
    }
    setup.history.push(history.clone());
    Ok(history)
}

pub async fn restore(state: &ObsState, id: u64) -> Result<History, String> {
    let mut history = {
        let setup = state.setup.lock().await;
        let index = setup
            .history
            .iter()
            .position(|h| h.id == id)
            .ok_or("履歴がありません")?;
        ensure_restore_order(&setup.history, index)?;
        setup.history[index].clone()
    };
    let session = BundleAccess::new(
        state,
        id,
        history.generation,
        history.audio.clone(),
        history.source_generations.clone(),
    )
    .await?;
    session.validate()?;
    restore_history(&session, &mut history).await;
    history.source_generations = session.expected_sources()?;
    let mut setup = state.setup.lock().await;
    if session.validate_all(&history.changes).await.is_err() {
        invalidate_completion(&mut history, true);
    }
    let old = setup
        .history
        .iter_mut()
        .find(|h| h.id == id)
        .ok_or("履歴がありません")?;
    *old = history.clone();
    Ok(history)
}

pub fn pending(history: &History) -> bool {
    history.pending.iter().any(|p| *p)
}
fn invalidate_completion(history: &mut History, restoring: bool) {
    history.restorable = false;
    history.completion_valid = false;
    for (pending, change) in history.pending.iter_mut().zip(&history.changes) {
        *pending |= change.before != change.after;
    }
    let (outcome, code, text) = if restoring {
        (
            Outcome::RestoreUnknown,
            "obs.result.restoreLateUnknown",
            "復元状態を要確認: 履歴確定前に接続・音声条件が変わりました",
        )
    } else {
        (
            Outcome::ApplyUnknown,
            "obs.result.applyLateUnknown",
            "適用状態を要確認: 履歴確定前に接続・音声条件が変わりました",
        )
    };
    for index in 0..history.results.len() {
        set_result(
            &mut history.results,
            &mut history.result_entries,
            index,
            outcome,
            code,
            text,
        );
    }
}
pub fn applied(history: &History) -> bool {
    history.completion_valid
        && history.restorable
        && history.results.len() == history.changes.len()
        && history.result_entries.as_ref().is_some_and(|entries| {
            entries.len() == history.changes.len()
                && entries
                    .iter()
                    .all(|entry| entry.outcome == Outcome::Applied)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        value: std::cell::RefCell<Value>,
        writes: std::cell::Cell<usize>,
        fail_after_write: bool,
        fail_readback: std::cell::Cell<bool>,
    }
    impl Access for Fake {
        async fn collection(&self) -> Result<String, String> {
            Ok("c".into())
        }
        async fn read(&self, _: &Change) -> Result<Value, String> {
            if self.fail_readback.get() && self.writes.get() > 0 {
                return Err("readback unavailable".into());
            }
            Ok(self.value.borrow().clone())
        }
        async fn write(&self, _: &mut Change, value: Value) -> Result<(), String> {
            self.writes.set(self.writes.get() + 1);
            *self.value.borrow_mut() = value;
            if self.fail_after_write {
                Err("timeout after OBS may have applied".into())
            } else {
                Ok(())
            }
        }
    }
    fn plan() -> Plan {
        Plan {
            audio: None,
            id: 9,
            supported: true,
            message: String::new(),
            message_text: None,
            changes: vec![Change {
                source: "voice".into(),
                label: "mute".into(),
                before: json!(false),
                after: json!(true),
                before_display: None,
                after_display: None,
                field_code: None,
                label_text: None,
                before_text: None,
                after_text: None,
                field: Field::Bundle {
                    kind: "audio".into(),
                    property: Property::Muted,
                },
            }],
            duplicate_mic_sources: vec![],
            timing: None,
            collection: "c".into(),
            generation: 1,
            source_generations: HashMap::new(),
        }
    }
    fn assert_results(history: &History, outcomes: &[Outcome]) {
        let entries = history.result_entries.as_ref().unwrap();
        assert_eq!(entries.len(), outcomes.len());
        assert_eq!(entries.len(), history.results.len());
        for ((entry, legacy), outcome) in entries.iter().zip(&history.results).zip(outcomes) {
            assert_eq!(&entry.outcome, outcome);
            assert_eq!(&entry.text.fallback_ja, legacy);
            assert!(!entry.text.code.is_empty());
            assert!(entry.text.args.is_empty());
        }
    }
    #[tokio::test]
    async fn typed_success_requires_complete_known_results_but_not_japanese_wording() {
        let access = Fake {
            value: std::cell::RefCell::new(json!(false)),
            writes: std::cell::Cell::new(0),
            fail_after_write: false,
            fail_readback: std::cell::Cell::new(false),
        };
        let history = apply_plan(&access, plan()).await;
        assert_results(&history, &[Outcome::Applied]);
        let mut translated = history.clone();
        translated.results[0] = "Applied".into();
        assert!(applied(&translated));
        for outcome in [
            Outcome::NotRun,
            Outcome::Conflict,
            Outcome::ApplyUnknown,
            Outcome::RestoreDeferred,
            Outcome::RestoreUnknown,
            Outcome::Restored,
            Outcome::AlreadyOriginal,
            Outcome::RestoreFailed,
        ] {
            let mut other = history.clone();
            other.result_entries.as_mut().unwrap()[0].outcome = outcome;
            assert!(!applied(&other));
        }
        let mut missing = history.clone();
        missing.result_entries = None;
        assert!(!applied(&missing));
        let mut short = history.clone();
        short.result_entries.as_mut().unwrap().clear();
        assert!(!applied(&short));
        let mut legacy_short = history;
        legacy_short.results.clear();
        assert!(!applied(&legacy_short));
    }
    #[tokio::test]
    async fn late_invalid_empty_completion_never_revives_after_refresh_or_history_read() {
        let access = Fake {
            value: std::cell::RefCell::new(json!(false)),
            writes: std::cell::Cell::new(0),
            fail_after_write: false,
            fail_readback: std::cell::Cell::new(false),
        };
        let mut empty = plan();
        empty.changes.clear();
        let valid = apply_plan(&access, empty).await;
        assert!(applied(&valid));
        assert_eq!(access.writes.get(), 0);
        for restoring in [false, true] {
            let mut invalid = valid.clone();
            invalidate_completion(&mut invalid, restoring);
            invalid.refresh_restorable(true, 1);
            assert!(invalid.restorable);
            assert!(!applied(&invalid));
            let state = ObsState::new();
            state.setup.lock().await.history.push(invalid);
            let mut read = crate::obs_setup::history(&state).await;
            assert_eq!(read.len(), 1);
            read[0].refresh_restorable(true, 1);
            assert!(!applied(&read[0]));
            let wire = serde_json::to_value(&read[0]).unwrap();
            for private in ["completionValid", "pending", "audio", "generation"] {
                assert!(wire.get(private).is_none());
            }
        }
    }
    #[tokio::test]
    async fn late_invalidation_synchronizes_results_and_preserves_uncertain_undo() {
        let access = Fake {
            value: std::cell::RefCell::new(json!(false)),
            writes: std::cell::Cell::new(0),
            fail_after_write: false,
            fail_readback: std::cell::Cell::new(false),
        };
        for restoring in [false, true] {
            let mut history = apply_plan(&access, plan()).await;
            invalidate_completion(&mut history, restoring);
            assert!(pending(&history));
            assert!(!applied(&history));
            assert_results(
                &history,
                &[if restoring {
                    Outcome::RestoreUnknown
                } else {
                    Outcome::ApplyUnknown
                }],
            );
            *access.value.borrow_mut() = json!(false);
        }
    }
    #[tokio::test]
    async fn unknown_write_and_readback_failure_keep_pending_then_conflicting_undo_never_overwrites(
    ) {
        for timeout in [false, true] {
            let access = Fake {
                value: std::cell::RefCell::new(json!(false)),
                writes: std::cell::Cell::new(0),
                fail_after_write: timeout,
                fail_readback: std::cell::Cell::new(!timeout),
            };
            let mut history = apply_plan(&access, plan()).await;
            assert!(pending(&history));
            assert!(!applied(&history));
            assert_results(&history, &[Outcome::ApplyUnknown]);
            assert_eq!(access.writes.get(), 1);
            access.fail_readback.set(false);
            *access.value.borrow_mut() = json!("external edit");
            restore_history(&access, &mut history).await;
            assert_eq!(access.writes.get(), 1);
            assert!(pending(&history));
            assert!(history.results[0].contains("競合"));
            assert_results(&history, &[Outcome::Conflict]);
        }
    }
    #[tokio::test]
    async fn explicit_apply_and_undo_readback_complete_but_unchanged_items_never_write() {
        let access = Fake {
            value: std::cell::RefCell::new(json!(false)),
            writes: std::cell::Cell::new(0),
            fail_after_write: false,
            fail_readback: std::cell::Cell::new(false),
        };
        let mut history = apply_plan(&access, plan()).await;
        assert!(applied(&history));
        restore_history(&access, &mut history).await;
        assert_results(&history, &[Outcome::Restored]);
        assert!(!pending(&history));
        assert_eq!(*access.value.borrow(), json!(false));
        assert_eq!(access.writes.get(), 2);
        let mut same = plan();
        same.changes[0].after = json!(false);
        let history = apply_plan(&access, same).await;
        assert!(applied(&history));
        assert!(!pending(&history));
        assert_eq!(access.writes.get(), 2);
    }
    #[test]
    fn saved_values_reject_arbitrary_settings_sync_credentials_duplicates_and_nonfinite_volume() {
        assert!(
            serde_json::from_value::<Property>(json!({"type":"settings","password":"x"})).is_err()
        );
        assert!(serde_json::from_value::<Property>(json!({"type":"sync"})).is_err());
        let item = Item {
            source: "voice".into(),
            kind: "wasapi_input_capture".into(),
            property: Property::Volume,
            value: json!(1.0),
        };
        assert!(validate(&Saved {
            collection: "c".into(),
            items: vec![item.clone()]
        })
        .is_ok());
        assert!(validate(&Saved {
            collection: "c".into(),
            items: vec![item.clone(), item.clone()]
        })
        .is_err());
        assert!(validate(&Saved {
            collection: "c".into(),
            items: vec![Item {
                value: json!("NaN"),
                ..item
            }]
        })
        .is_err());
    }
}
