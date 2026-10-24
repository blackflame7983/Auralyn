//! 自分のfilter enabled通知だけを一度採用する。一般履歴の世代は昇格しない。
use super::*;
use std::sync::{Arc, Mutex as StdMutex};

pub(crate) struct FilterIntent {
    owner: u64,
    source: String,
    filter: String,
    kind: String,
    enabled: bool,
    generation: u64,
    base: u64,
    receipt: bool,
    expected: Arc<StdMutex<HashMap<String, u64>>>,
}
pub(crate) fn observe_filter_event(
    registry: &StdMutex<Option<FilterIntent>>,
    generation: u64,
    source: &str,
    filter: &str,
    enabled: bool,
    before: u64,
) {
    let Ok(mut registry) = registry.lock() else {
        return;
    };
    if let Some(intent) = registry.as_mut() {
        if !intent.receipt
            && intent.generation == generation
            && intent.source == source
            && intent.filter == filter
            && intent.enabled == enabled
            && intent.base == before
        {
            if let Ok(mut expected) = intent.expected.lock() {
                if expected.get(source).copied().unwrap_or(0) == before {
                    expected.insert(source.into(), before.saturating_add(1));
                    intent.receipt = true;
                }
            }
        }
    }
}

pub(super) struct BundleAccess<'a> {
    state: &'a ObsState,
    client: Arc<Client>,
    owner: u64,
    generation: u64,
    audio: Option<Witness>,
    expected: Arc<StdMutex<HashMap<String, u64>>>,
    deadline: std::time::Instant,
}
impl<'a> BundleAccess<'a> {
    pub(super) async fn new(
        state: &'a ObsState,
        owner: u64,
        generation: u64,
        audio: Option<Witness>,
        expected: HashMap<String, u64>,
    ) -> Result<Self, String> {
        let client = state
            .client
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or("OBSに手動で接続してください")?;
        Ok(Self {
            state,
            client,
            owner,
            generation,
            audio,
            expected: Arc::new(StdMutex::new(expected)),
            deadline: std::time::Instant::now() + std::time::Duration::from_secs(30),
        })
    }
    pub(super) fn expected_sources(&self) -> Result<HashMap<String, u64>, String> {
        Ok(self
            .expected
            .lock()
            .map_err(|_| "OBS対象の世代を取得できません")?
            .clone())
    }
    pub(super) async fn validate_all(&self, changes: &[Change]) -> Result<(), String> {
        for change in changes {
            self.validate_source(&change.source).await?;
        }
        self.validate()
    }
    pub(super) fn validate(&self) -> Result<(), String> {
        if std::time::Instant::now() >= self.deadline {
            return Err("OBS操作の全体期限を超えました。未確認項目と原本を保持しています".into());
        }
        validate_audio(&self.audio)?;
        if self.state.setup_generation.load(Ordering::SeqCst) != self.generation {
            return Err("OBS接続・構成が変わりました。結果を手動確認してください".into());
        }
        Ok(())
    }
    async fn validate_source(&self, source: &str) -> Result<(), String> {
        validate_boundary(
            self.state,
            self.generation,
            &self.audio,
            &self.expected,
            self.deadline,
            source,
        )
        .await
    }
    fn clear_intent(&self) {
        if let Ok(mut intent) = self.state.bundle_filter_intent.lock() {
            if intent.as_ref().is_some_and(|i| i.owner == self.owner) {
                *intent = None;
            }
        }
    }
    async fn register(
        &self,
        source: &str,
        filter: &str,
        kind: &str,
        enabled: bool,
    ) -> Result<(), String> {
        let sources = self.state.source_generations.lock().await;
        let expected = self
            .expected
            .lock()
            .map_err(|_| "OBS対象の世代を取得できません")?;
        validate_source_generation(&sources, &expected, source)?;
        let mut registry = self
            .state
            .bundle_filter_intent
            .lock()
            .map_err(|_| "OBS変更の所有情報を取得できません")?;
        if registry.is_some() {
            return Err("別のOBSフィルタ変更の確認中です".into());
        }
        *registry = Some(FilterIntent {
            owner: self.owner,
            source: source.into(),
            filter: filter.into(),
            kind: kind.into(),
            enabled,
            generation: self.generation,
            base: sources.get(source).copied().unwrap_or(0),
            receipt: false,
            expected: self.expected.clone(),
        });
        Ok(())
    }
}

// RPC完了後と履歴公開前で共有する。source lock待機中の接続/音声変更も再検査する。
pub(super) async fn validate_boundary(
    state: &ObsState,
    generation: u64,
    audio: &Option<Witness>,
    expected: &StdMutex<HashMap<String, u64>>,
    deadline: std::time::Instant,
    source: &str,
) -> Result<(), String> {
    let validate = || {
        if std::time::Instant::now() >= deadline {
            return Err("OBS操作の期限を超えました".into());
        }
        validate_audio(audio)?;
        if state.setup_generation.load(Ordering::SeqCst) != generation {
            return Err("OBS接続・構成が変わりました".into());
        }
        Ok(())
    };
    validate()?;
    let current = state.source_generations.lock().await;
    let expected = expected
        .lock()
        .map_err(|_| "OBS対象の世代を取得できません")?;
    validate_source_generation(&current, &expected, source)?;
    validate()
}
impl Drop for BundleAccess<'_> {
    fn drop(&mut self) {
        self.clear_intent();
    }
}
impl Access for BundleAccess<'_> {
    async fn collection(&self) -> Result<String, String> {
        self.validate()?;
        let value = rpc(self.client.collection()).await?;
        self.validate()?;
        Ok(value)
    }
    async fn read(&self, change: &Change) -> Result<Value, String> {
        self.validate_source(&change.source).await?;
        let value = rpc(self.client.read(change)).await?;
        self.validate_source(&change.source).await?;
        Ok(value)
    }
    async fn write(&self, change: &mut Change, value: Value) -> Result<(), String> {
        self.validate_source(&change.source).await?;
        rpc(self.client.read(change)).await?;
        let filter = match &change.field {
            Field::Bundle {
                property: Property::FilterEnabled { name, kind },
                ..
            } => Some((name.clone(), kind.clone())),
            _ => None,
        };
        if let Some((filter, kind)) = &filter {
            self.register(
                &change.source,
                filter,
                kind,
                value.as_bool().ok_or("不正なフィルタ値")?,
            )
            .await?;
        }
        // 直前のread/register await中の切断・改名・別音声変更を送信前にも拒否する。
        if let Err(error) = self.validate_source(&change.source).await {
            self.clear_intent();
            return Err(error);
        }
        if let Err(error) = rpc(self.client.write(change, value.clone())).await {
            self.clear_intent();
            return Err(error);
        }
        if let Some((_, kind)) = filter {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                self.validate()?;
                let received = self
                    .state
                    .bundle_filter_intent
                    .lock()
                    .map_err(|_| "OBS変更の確認情報を取得できません")?
                    .as_ref()
                    .is_some_and(|i| i.owner == self.owner && i.kind == kind && i.receipt);
                if received {
                    let current = rpc(self.client.read(change)).await?;
                    self.validate_source(&change.source).await?;
                    self.clear_intent();
                    if current != value {
                        return Err("OBSフィルタの変更後の値が一致しません".into());
                    }
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    self.clear_intent();
                    return Err("OBS応答後の変更通知を確認できません。適用状態は不明のため履歴を保持しています".into());
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }
        self.validate_source(&change.source).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn deferred_rpc_read_revalidates_connection_source_and_audio_before_write() {
        for change in 0..3 {
            let state = ObsState::new();
            let generation = state.setup_generation.load(Ordering::SeqCst);
            let conditions = Arc::new(crate::audio::conditions::Conditions::default());
            conditions.lifecycle(true);
            let audio = Some(conditions.snapshot().unwrap());
            let expected = StdMutex::new(HashMap::from([("voice".into(), 0)]));
            let (tx, rx) = tokio::sync::oneshot::channel();
            let writes = std::sync::atomic::AtomicUsize::new(0);
            let work = async {
                rx.await.unwrap(); // 先行RPC readの遅い応答。
                validate_boundary(
                    &state,
                    generation,
                    &audio,
                    &expected,
                    std::time::Instant::now() + std::time::Duration::from_secs(1),
                    "voice",
                )
                .await?;
                writes.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>(())
            };
            match change {
                0 => {
                    state.setup_generation.fetch_add(1, Ordering::SeqCst);
                }
                1 => {
                    state
                        .source_generations
                        .lock()
                        .await
                        .insert("voice".into(), 1);
                }
                _ => conditions.lifecycle(false),
            }
            tx.send(()).unwrap();
            assert!(work.await.is_err());
            assert_eq!(writes.load(Ordering::SeqCst), 0);
        }
    }
    #[tokio::test]
    async fn history_lock_wait_cannot_publish_a_success_after_invalidation() {
        let state = ObsState::new();
        let generation = state.setup_generation.load(Ordering::SeqCst);
        let expected = StdMutex::new(HashMap::from([("voice".into(), 0)]));
        let held = state.setup.lock().await;
        let publish = async {
            let _setup = state.setup.lock().await;
            validate_boundary(
                &state,
                generation,
                &None,
                &expected,
                std::time::Instant::now() + std::time::Duration::from_secs(1),
                "voice",
            )
            .await
        };
        tokio::pin!(publish);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), &mut publish)
                .await
                .is_err()
        );
        state.setup_generation.fetch_add(1, Ordering::SeqCst);
        drop(held);
        assert!(publish.await.is_err());
    }
    #[test]
    fn only_one_matching_event_promotes_own_source_epoch_not_other_histories() {
        let expected = Arc::new(StdMutex::new(HashMap::from([("voice".into(), 4)])));
        let registry = StdMutex::new(Some(FilterIntent {
            owner: 1,
            source: "voice".into(),
            filter: "comp".into(),
            kind: "compressor_filter".into(),
            enabled: false,
            generation: 7,
            base: 4,
            receipt: false,
            expected: expected.clone(),
        }));
        for (generation, filter, enabled, before) in [
            (8, "comp", false, 4),
            (7, "other", false, 4),
            (7, "comp", true, 4),
            (7, "comp", false, 5),
        ] {
            observe_filter_event(&registry, generation, "voice", filter, enabled, before);
            assert_eq!(expected.lock().unwrap()["voice"], 4);
        }
        observe_filter_event(&registry, 7, "voice", "comp", false, 4);
        assert_eq!(expected.lock().unwrap()["voice"], 5);
        observe_filter_event(&registry, 7, "voice", "comp", false, 5);
        assert_eq!(expected.lock().unwrap()["voice"], 5);
        *registry.lock().unwrap() = None; // timeout/操作終了後のeventは後続操作へ採用しない。
        observe_filter_event(&registry, 7, "voice", "comp", false, 4);
        assert_eq!(expected.lock().unwrap()["voice"], 5);
    }
}
