use crate::audio::AudioState;
use crate::audio::{conditions::Witness, ActiveAudioConfig};
use crate::routing_diag;
use futures_util::StreamExt;
use obws::requests::EventSubscription;
use obws::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, watch, Mutex};

struct ReachTask {
    cancel: watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

// OBSの確認処理と音声IPCを分け、実デバイスを起動せず中止を検証する。
trait ReachTone: Send + Sync {
    fn play(
        &self,
        duration_ms: u32,
    ) -> impl std::future::Future<Output = Result<ReachReceipt, String>> + Send;
    fn stop(
        &self,
        receipt: &ReachReceipt,
    ) -> impl std::future::Future<Output = Result<ReachReceipt, String>> + Send;
}

struct ReachReceipt {
    witness: Witness,
    config: Option<ActiveAudioConfig>,
}

struct ReachMeasurement {
    result: ObsAudioReachResult,
    receipt: Option<ReachReceipt>,
    fingerprint: Option<u64>,
}

impl ReachTone for AudioState {
    async fn play(&self, duration_ms: u32) -> Result<ReachReceipt, String> {
        let host = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut host = host
                .lock()
                .map_err(|_| "音声状態を取得できません".to_string())?;
            let witness = host
                .begin_obs_reach_tone(duration_ms)
                .map_err(|e| e.to_string())?;
            Ok(ReachReceipt {
                witness,
                config: host.get_state().config,
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn stop(&self, receipt: &ReachReceipt) -> Result<ReachReceipt, String> {
        let host = self.0.clone();
        let witness = receipt.witness.clone();
        tokio::task::spawn_blocking(move || {
            let mut host = host
                .lock()
                .map_err(|_| "音声状態を取得できません".to_string())?;
            let witness = host
                .finish_obs_reach_tone(&witness)
                .map_err(|e| e.to_string())?;
            Ok(ReachReceipt {
                witness,
                config: host.get_state().config,
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

pub const AURALYN_OBS_SOURCE_NAME: &str = "Auralyn マイク";
pub const WASAPI_INPUT_KIND: &str = "wasapi_input_capture";

/// OBS 入力レベルメーターで音到達とみなす閾値（dB）
const METER_DETECT_THRESHOLD_DB: f32 = -50.0;

#[derive(Clone)]
pub struct ObsConnectionParams {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
}

#[derive(Default)]
struct SceneClock {
    generation: AtomicU64,
    sequence: AtomicU64,
    connected: AtomicBool,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LiveSceneStatus {
    pub connected: bool,
    pub connection_generation: u64,
    pub sequence: u64,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LiveSceneEvent {
    pub scene_name: String,
    pub connection_generation: u64,
    pub sequence: u64,
}
impl SceneClock {
    fn begin(&self) -> u64 {
        self.connected.store(false, Ordering::SeqCst);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.sequence.store(0, Ordering::SeqCst);
        self.connected.store(true, Ordering::SeqCst);
        generation
    }
    fn stop(&self) {
        self.connected.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    fn event(&self, generation: u64, name: String) -> Option<LiveSceneEvent> {
        if !self.connected.load(Ordering::SeqCst)
            || self.generation.load(Ordering::SeqCst) != generation
        {
            return None;
        }
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        if self.generation.load(Ordering::SeqCst) != generation
            || !self.connected.load(Ordering::SeqCst)
        {
            return None;
        }
        Some(LiveSceneEvent {
            scene_name: name,
            connection_generation: generation,
            sequence,
        })
    }
    fn status(&self) -> LiveSceneStatus {
        LiveSceneStatus {
            connected: self.connected.load(Ordering::SeqCst),
            connection_generation: self.generation.load(Ordering::SeqCst),
            sequence: self.sequence.load(Ordering::SeqCst),
        }
    }
}
pub fn live_scene_status(state: &ObsState) -> LiveSceneStatus {
    state.scene_clock.status()
}

pub struct ObsState {
    scene_clock: Arc<SceneClock>,
    pub client: Mutex<Option<Arc<Client>>>,
    pub(crate) bundle_filter_intent:
        Arc<std::sync::Mutex<Option<crate::obs_setup::bundle::FilterIntent>>>,
    event_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    reach_task: Mutex<Option<ReachTask>>,
    reach_operation: AtomicU64,
    reach_settings_generation: Arc<AtomicU64>,
    reach_verification: Mutex<Option<ReachVerification>>,
    /// 到達確認用の一時接続に使う接続パラメータ
    pub conn_params: Mutex<Option<ObsConnectionParams>>,
    pub setup: Mutex<crate::obs_setup::SetupState>,
    pub setup_generation: Arc<AtomicU64>,
    pub source_generations: Arc<Mutex<HashMap<String, u64>>>,
}

impl Default for ObsState {
    fn default() -> Self {
        Self::new()
    }
}

impl ObsState {
    pub fn new() -> Self {
        Self {
            scene_clock: Arc::new(SceneClock::default()),
            client: Mutex::new(None),
            bundle_filter_intent: Arc::new(std::sync::Mutex::new(None)),
            event_task: Mutex::new(None),
            reach_task: Mutex::new(None),
            reach_operation: AtomicU64::new(0),
            reach_settings_generation: Arc::new(AtomicU64::new(0)),
            reach_verification: Mutex::new(None),
            conn_params: Mutex::new(None),
            setup: Mutex::new(crate::obs_setup::SetupState::default()),
            setup_generation: Arc::new(AtomicU64::new(0)),
            source_generations: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ObsSceneChangedEvent {
    pub scene_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsAudioReachResult {
    pub reached: ReachValue,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_db: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<ObsReachVerification>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsReachVerification {
    operation_id: String,
    checked_at_unix_ms: u64,
    source: String,
    connection_generation: u64,
    setup_generation: u64,
    source_generation: u64,
    target_settings_generation: u64,
    audio_engine_epoch: u64,
    audio_conditions_revision: u64,
    config: Option<ActiveAudioConfig>,
}

#[derive(Clone)]
struct ReachVerification {
    metadata: ObsReachVerification,
    witness: Witness,
    fingerprint: u64,
    valid: bool,
}

// 読取りだけ。新しい接続や音声を起動せず、自己toneの通知が遅着した場合も
// native条件を再照合する。過去の成功を接続変更後へ持ち越さない。
pub async fn audio_reach_current(state: &ObsState, operation_id: &str) -> bool {
    audio_reach_current_with(state, operation_id, || async {
        tokio::time::timeout(StdDuration::from_secs(2), async {
            let client = state
                .client
                .lock()
                .await
                .clone()
                .ok_or("OBSの接続が終了しました")?;
            reach_fingerprint(&client).await
        })
        .await
        .map_err(|_| "OBSの再確認が時間切れになりました".to_string())?
    })
    .await
}

async fn audio_reach_current_with<F, Fut>(state: &ObsState, operation_id: &str, read: F) -> bool
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<u64, String>>,
{
    let expected = {
        let record = state.reach_verification.lock().await;
        let Some(record) = record
            .as_ref()
            .filter(|record| record.valid && record.metadata.operation_id == operation_id)
        else {
            return false;
        };
        record.clone()
    };
    let before = reach_binding_current(state, &expected.metadata).await
        && expected.witness.validate().is_ok()
        && operation_id == state.reach_operation.load(Ordering::SeqCst).to_string();
    let matches = before
        && read()
            .await
            .is_ok_and(|actual| actual == expected.fingerprint);
    let valid = matches
        && reach_binding_current(state, &expected.metadata).await
        && expected.witness.validate().is_ok()
        && operation_id == state.reach_operation.load(Ordering::SeqCst).to_string();
    let mut record = state.reach_verification.lock().await;
    let Some(record) = record
        .as_mut()
        .filter(|record| record.metadata.operation_id == operation_id)
    else {
        return false;
    };
    // 一度観測した不一致・読取不能は設定を戻しても復活させない。
    record.valid &= valid;
    record.valid
}

async fn bounded_reach_fingerprint(client: &Client) -> Result<u64, String> {
    tokio::time::timeout(StdDuration::from_secs(2), reach_fingerprint(client))
        .await
        .map_err(|_| "OBSの再確認が時間切れになりました".to_string())?
}

async fn reach_fingerprint(client: &Client) -> Result<u64, String> {
    let source = AURALYN_OBS_SOURCE_NAME;
    let inputs = client
        .inputs()
        .list(None)
        .await
        .map_err(|_| "OBSの対象を再確認できません".to_string())?;
    if inputs.len() > 256 {
        return Err("OBSの対象が多いため再確認できません".into());
    }
    let input = inputs
        .iter()
        .find(|input| input.name == source)
        .ok_or("OBSの対象が見つかりません")?;
    let settings = client
        .inputs()
        .settings::<serde_json::Value>(source)
        .await
        .map_err(|_| "OBSの対象設定を再確認できません".to_string())?
        .settings;
    let filters = client
        .filters()
        .list(source)
        .await
        .map_err(|_| "OBSのフィルターを再確認できません".to_string())?;
    if filters.len() > 128 {
        return Err("OBSのフィルターが多いため再確認できません".into());
    }
    let filters =
        serde_json::to_value(filters).map_err(|_| "OBSの対象を再確認できません".to_string())?;
    Ok(hash_reach_target(
        &input.kind,
        &input.unversioned_kind,
        &settings,
        &filters,
    ))
}

fn hash_reach_target(
    kind: &str,
    unversioned_kind: &str,
    settings: &serde_json::Value,
    filters: &serde_json::Value,
) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    kind.hash(&mut hash);
    unversioned_kind.hash(&mut hash);
    // URLや資格情報を含み得る実設定はDTO・履歴・ログへ保持しない。
    settings.to_string().hash(&mut hash);
    filters.to_string().hash(&mut hash);
    hash.finish()
}

async fn reach_binding_current(state: &ObsState, record: &ObsReachVerification) -> bool {
    let source_generation = state
        .source_generations
        .lock()
        .await
        .get(&record.source)
        .copied()
        .unwrap_or(0);
    state.scene_clock.connected.load(Ordering::SeqCst)
        && state.scene_clock.generation.load(Ordering::SeqCst) == record.connection_generation
        && state.setup_generation.load(Ordering::SeqCst) == record.setup_generation
        && state.reach_settings_generation.load(Ordering::SeqCst)
            == record.target_settings_generation
        && source_generation == record.source_generation
}

/// フロント向け: `true` / `false` / `"unsupported"`
#[derive(Serialize)]
#[serde(untagged)]
pub enum ReachValue {
    Bool(bool),
    Str(String),
}

/// 重複マイク検出用の入力サマリー（純粋ロジックのテスト用）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObsInputSummary {
    pub name: String,
    pub kind: String,
    pub unversioned_kind: String,
    pub muted: bool,
}

/// 音声入力キャプチャ系ソースかどうか
pub fn is_audio_input_capture_kind(kind: &str, unversioned_kind: &str) -> bool {
    unversioned_kind.contains("input_capture") || kind.contains("input_capture")
}

/// VB-CABLE のキャプチャ側（CABLE Output）かどうか
pub fn is_cable_output_device_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    routing_diag::is_virtual_cable_name(name) && lower.contains("output")
}

/// ミュートされていない重複マイクソース名を列挙
pub fn find_duplicate_mic_sources(inputs: &[ObsInputSummary], auralyn_name: &str) -> Vec<String> {
    inputs
        .iter()
        .filter(|i| i.name != auralyn_name)
        .filter(|i| is_audio_input_capture_kind(&i.kind, &i.unversioned_kind))
        .filter(|i| !i.muted)
        .map(|i| i.name.clone())
        .collect()
}

/// OBS メーター（Mul）のピークを dB に変換
pub fn mul_to_db(mul: f32) -> f32 {
    if mul <= 1e-10 {
        -120.0
    } else {
        20.0 * mul.log10()
    }
}

/// InputVolumeMeters の levels からピーク dB を算出
pub fn peak_db_from_meter_levels(levels: &[[f32; 3]]) -> f32 {
    let peak_mul = levels
        .iter()
        .flat_map(|channels| channels.iter())
        .copied()
        .fold(0.0f32, f32::max);
    mul_to_db(peak_mul)
}

pub async fn connect_obs(
    app: AppHandle,
    state: tauri::State<'_, ObsState>,
    host: String,
    port: u16,
    password: Option<String>,
) -> Result<(), String> {
    // 接続開始と切断を同じロックで直列化し、閉じた画面の遅い接続を残さない。
    let mut client_guard = state.client.lock().await;
    let stopped = stop_connection(&state, &mut client_guard).await;
    let _ = app.emit("obs://timing-invalidated", ());
    stopped?;
    let client = tokio::time::timeout(
        StdDuration::from_secs(5),
        Client::connect(&host, port, password.clone()),
    )
    .await
    .map_err(|_| "OBS への接続がタイムアウトしました".to_string())?
    .map_err(|e| format!("Failed to connect to OBS: {}", e))?;

    let events = client.events().map_err(|e| e.to_string())?;

    *client_guard = Some(Arc::new(client));
    *state.conn_params.lock().await = Some(ObsConnectionParams {
        host: host.clone(),
        port,
        password,
    });

    log::info!("Connected to OBS at {}:{}", host, port);

    // シーン変更などのイベントを監視
    let scene_clock = state.scene_clock.clone();
    let connection_generation = scene_clock.begin();
    let setup_generation = state.setup_generation.clone();
    let source_generations = state.source_generations.clone();
    let bundle_filter_intent = state.bundle_filter_intent.clone();
    let reach_settings_generation = state.reach_settings_generation.clone();
    *state.event_task.lock().await = Some(tokio::spawn(async move {
        tokio::pin!(events);
        while let Some(event) = events.next().await {
            if invalidate_reach_settings(&event, &reach_settings_generation) {
                let _ = app.emit("obs://reach-invalidated", ());
            }
            let invalidated = if let obws::events::Event::SourceFilterEnableStateChanged {
                source,
                filter,
                enabled,
            } = &event
            {
                let mut sources = source_generations.lock().await;
                let before = sources.get(source).copied().unwrap_or(0);
                sources.insert(source.clone(), before.saturating_add(1));
                crate::obs_setup::bundle::observe_filter_event(
                    &bundle_filter_intent,
                    setup_generation.load(Ordering::SeqCst),
                    source,
                    filter,
                    *enabled,
                    before,
                );
                true
            } else {
                invalidate_setup_target(&event, &setup_generation, &source_generations).await
            };
            if invalidated {
                let _ = app.emit("obs://timing-invalidated", ());
            }
            if let obws::events::Event::CurrentProgramSceneChanged { name, .. } = event {
                if let Some(event) = scene_clock.event(connection_generation, name.clone()) {
                    let _ = app.emit("obs://live-scene-changed", event);
                }
                log::info!("OBS Scene Changed: {}", name);
                let _ = app.emit(
                    "obs://scene-changed",
                    ObsSceneChangedEvent { scene_name: name },
                );
            }
        }
        if scene_clock.generation.load(Ordering::SeqCst) == connection_generation {
            scene_clock.stop();
        }
        let _ = app.emit("obs://live-scene-invalidated", ());
        // 購読が失われた後の条件を、古い測定と同一として扱わない。
        setup_generation.fetch_add(1, Ordering::SeqCst);
        let _ = app.emit("obs://timing-invalidated", ());
        log::info!("OBS Event Loop Ended");
    }));

    Ok(())
}

pub async fn disconnect_obs(
    app: AppHandle,
    state: tauri::State<'_, ObsState>,
) -> Result<(), String> {
    let mut client_guard = state.client.lock().await;
    let result = stop_connection(&state, &mut client_guard).await;
    let _ = app.emit("obs://timing-invalidated", ());
    result
}

async fn stop_reach(state: &ObsState) -> Result<(), String> {
    if let Some(reach) = state.reach_task.lock().await.take() {
        let _ = reach.cancel.send(true);
        // abortは後始末も捨てるため使わず、テスト音と一時接続の終了を待つ。
        return reach.task.await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn invalidate_reach_settings(event: &obws::events::Event, generation: &AtomicU64) -> bool {
    use obws::events::Event;
    let changed = match event {
        Event::InputMuteStateChanged { name, .. }
        | Event::InputVolumeChanged { name, .. }
        | Event::InputAudioBalanceChanged { name, .. }
        | Event::InputAudioSyncOffsetChanged { name, .. }
        | Event::InputAudioTracksChanged { name, .. }
        | Event::InputAudioMonitorTypeChanged { name, .. } => name == AURALYN_OBS_SOURCE_NAME,
        _ => false,
    };
    if changed {
        generation.fetch_add(1, Ordering::SeqCst);
    }
    changed
}

async fn stop_connection(state: &ObsState, client: &mut Option<Arc<Client>>) -> Result<(), String> {
    state.scene_clock.stop();
    let reach_result = stop_reach(state).await;
    if let Some(task) = state.event_task.lock().await.take() {
        task.abort();
        let _ = task.await;
    }
    // 旧Arc上のRPCが後着しても、新接続の成功として採用しない。
    state.setup_generation.fetch_add(1, Ordering::SeqCst);
    if let Some(client) = client.take() {
        if let Ok(mut client) = Arc::try_unwrap(client) {
            client.disconnect().await;
        }
        // 操作中のArcは世代失効で中断し、最後のClient::dropが通信を閉じる。
    }
    // 復元情報を捨てずに予定だけ破棄する。購読の空白は世代で区別する。
    state.setup.lock().await.invalidate_plan();
    *state.conn_params.lock().await = None;
    reach_result
}

/// 接続し直さずに状態を取得し、設定画面の再表示で履歴を維持する。
pub async fn connection_status(state: &ObsState) -> bool {
    let guard = state.client.lock().await;
    let Some(client) = guard.as_ref() else {
        return false;
    };
    // ローカルのイベント購読可否ではなく、現在の通信を期限付きで確認する。
    matches!(
        tokio::time::timeout(StdDuration::from_secs(2), client.general().version()).await,
        Ok(Ok(_))
    )
}

async fn invalidate_setup_target(
    event: &obws::events::Event,
    generation: &AtomicU64,
    sources: &Mutex<HashMap<String, u64>>,
) -> bool {
    use obws::events::Event;
    match event {
        Event::CurrentSceneCollectionChanging { .. }
        | Event::CurrentSceneCollectionChanged { .. }
        | Event::ExitStarted => {
            generation.fetch_add(1, Ordering::SeqCst);
            true
        }
        Event::InputRemoved { name } => {
            *sources.lock().await.entry(name.clone()).or_default() += 1;
            true
        }
        Event::InputNameChanged { old_name, new_name } => {
            let mut sources = sources.lock().await;
            *sources.entry(old_name.clone()).or_default() += 1;
            *sources.entry(new_name.clone()).or_default() += 1;
            true
        }
        Event::SourceFilterCreated { source, .. }
        | Event::SourceFilterRemoved { source, .. }
        | Event::SourceFilterListReindexed { source, .. }
        | Event::SourceFilterEnableStateChanged { source, .. }
        | Event::SourceFilterNameChanged { source, .. } => {
            *sources.lock().await.entry(source.clone()).or_default() += 1;
            true
        }
        // 同期値自身の通知はapply/restoreでも発生するため失効させない。
        // 値の競合は書込み前と読戻しで検出する。
        _ => false,
    }
}

/// テストトーンを再生し、OBS の入力メーターで到達を確認する
pub async fn check_audio_reach(
    obs_state: &ObsState,
    audio_state: &AudioState,
    duration_ms: u32,
) -> Result<ObsAudioReachResult, String> {
    // 登録と切断を同じロックで直列化し、切断後に確認処理を開始しない。
    let guard = obs_state.client.lock().await;
    if guard.is_none() {
        return Err("OBS に接続されていません".into());
    }
    if !(100..=5000).contains(&duration_ms) {
        return Err("到達確認の時間は100〜5000msで指定してください".into());
    }
    let operation = obs_state.reach_operation.fetch_add(1, Ordering::SeqCst) + 1;
    stop_reach(obs_state).await?;
    let mut metadata = ObsReachVerification {
        operation_id: operation.to_string(),
        checked_at_unix_ms: 0,
        source: AURALYN_OBS_SOURCE_NAME.into(),
        connection_generation: obs_state.scene_clock.generation.load(Ordering::SeqCst),
        setup_generation: obs_state.setup_generation.load(Ordering::SeqCst),
        source_generation: obs_state
            .source_generations
            .lock()
            .await
            .get(AURALYN_OBS_SOURCE_NAME)
            .copied()
            .unwrap_or(0),
        target_settings_generation: obs_state.reach_settings_generation.load(Ordering::SeqCst),
        audio_engine_epoch: 0,
        audio_conditions_revision: 0,
        config: None,
    };
    let params = obs_state
        .conn_params
        .lock()
        .await
        .clone()
        .ok_or("OBS の接続情報がありません。再接続してください。")?;
    let audio = AudioState(audio_state.0.clone());
    let client = guard.as_ref().cloned().ok_or("OBSの接続が終了しました")?;
    let (cancel, receiver) = watch::channel(false);
    let (reply, result) = oneshot::channel();
    *obs_state.reach_task.lock().await = Some(ReachTask {
        cancel,
        task: tokio::spawn(async move {
            let before = bounded_reach_fingerprint(&client).await;
            let (mut result, cleanup) = match before {
                Ok(fingerprint) => {
                    let (mut result, cleanup) =
                        run_audio_reach(params, audio, duration_ms, receiver).await;
                    if result
                        .as_ref()
                        .is_ok_and(|measurement| measurement.receipt.is_some())
                    {
                        match bounded_reach_fingerprint(&client).await {
                            Ok(after) if after == fingerprint => {
                                if let Ok(measurement) = &mut result {
                                    measurement.fingerprint = Some(fingerprint);
                                }
                            }
                            _ => {
                                result =
                                    Err("確認中にOBSの対象設定が変わったか、再確認できませんでした"
                                        .into())
                            }
                        }
                    }
                    (result, cleanup)
                }
                Err(error) => (Err(error), Ok(())),
            };
            if result.as_ref().is_ok_and(|measurement| {
                measurement.receipt.is_some() && measurement.fingerprint.is_none()
            }) {
                result = Err("OBSの対象設定を確認できません".into());
            }
            let _ = reply.send(result);
            cleanup
        }),
    });
    drop(guard);
    let measurement = result
        .await
        .map_err(|_| "OBS の到達確認が終了しました".to_string())??;
    let mut result = measurement.result;
    if let Some(receipt) = measurement.receipt {
        receipt.witness.validate()?;
        metadata.checked_at_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "確認時刻を取得できません".to_string())?
            .as_millis()
            .try_into()
            .map_err(|_| "確認時刻を取得できません".to_string())?;
        metadata.audio_engine_epoch = receipt.witness.engine_epoch();
        metadata.audio_conditions_revision = receipt.witness.revision();
        metadata.config = receipt.config;
        let mut record = obs_state.reach_verification.lock().await;
        if !reach_binding_current(obs_state, &metadata).await
            || receipt.witness.validate().is_err()
            || obs_state.reach_operation.load(Ordering::SeqCst) != operation
        {
            return Err("確認中に対象または音声条件が変わりました。再確認してください".into());
        }
        result.verification = Some(metadata.clone());
        *record = Some(ReachVerification {
            metadata,
            witness: receipt.witness,
            fingerprint: measurement
                .fingerprint
                .ok_or("OBSの対象設定を確認できません")?,
            valid: true,
        });
    }
    Ok(result)
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    if !*cancel.borrow() {
        let _ = cancel.changed().await;
    }
}

fn reach_cancelled() -> String {
    "OBS の利用を終了したため到達確認を中止しました".into()
}

async fn run_audio_reach(
    params: ObsConnectionParams,
    audio: impl ReachTone,
    duration_ms: u32,
    mut cancel: watch::Receiver<bool>,
) -> (Result<ReachMeasurement, String>, Result<(), String>) {
    let connection = tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => return (Err(reach_cancelled()), Ok(())),
        connection = tokio::time::timeout(
            StdDuration::from_secs(5),
            Client::connect_with_config(obws::client::ConnectConfig {
                host: params.host.as_str(),
                port: params.port,
                password: params.password.as_deref(),
                event_subscriptions: Some(EventSubscription::INPUT_VOLUME_METERS),
                broadcast_capacity: None,
            }),
        ) => connection,
    };
    let mut meter_client = match connection {
        Ok(Ok(client)) => client,
        _ => {
            return (
                Ok(ReachMeasurement {
                    result: ObsAudioReachResult {
                        reached: ReachValue::Str("unsupported".into()),
                        peak_db: None,
                        verification: None,
                    },
                    receipt: None,
                    fingerprint: None,
                }),
                Ok(()),
            )
        }
    };
    let mut receipt = None;
    let result = observe_audio_reach(
        &meter_client,
        &audio,
        duration_ms,
        &mut cancel,
        &mut receipt,
    )
    .await;
    // 所有条件が変わった場合は別のtoneを停止しない。開始ACKを失った場合も
    // 無条件のStopを送らず、最大5秒のtone自身の期限に委ねる。
    let cleanup = match receipt.take() {
        Some(owned) => audio
            .stop(&owned)
            .await
            .map(|finished| receipt = Some(finished)),
        None => Ok(()),
    };
    let _ = tokio::time::timeout(StdDuration::from_secs(2), meter_client.disconnect()).await;
    (
        cleanup.clone().and(result).map(|result| ReachMeasurement {
            result,
            receipt,
            fingerprint: None,
        }),
        cleanup,
    )
}

async fn observe_audio_reach(
    meter_client: &Client,
    audio: &impl ReachTone,
    duration_ms: u32,
    cancel: &mut watch::Receiver<bool>,
    receipt: &mut Option<ReachReceipt>,
) -> Result<ObsAudioReachResult, String> {
    let inputs_api = meter_client.inputs();
    let inputs = tokio::select! {
        biased;
        _ = cancelled(cancel) => return Err(reach_cancelled()),
        inputs = tokio::time::timeout(StdDuration::from_secs(5), inputs_api.list(None)) => {
            inputs.map_err(|_| "OBSの対象確認が時間切れになりました".to_string())?
                .map_err(|e| e.to_string())?
        },
    };
    if !inputs.iter().any(|i| i.name == AURALYN_OBS_SOURCE_NAME) {
        return Err(format!(
            "「{}」ソースが見つかりません。先に自動セットアップを実行してください。",
            AURALYN_OBS_SOURCE_NAME
        ));
    }
    let events = match meter_client.events() {
        Ok(events) => events,
        Err(_) => {
            return Ok(ObsAudioReachResult {
                reached: ReachValue::Str("unsupported".into()),
                peak_db: None,
                verification: None,
            })
        }
    };
    if *cancel.borrow() {
        return Err(reach_cancelled());
    }
    // 開始を送った後は応答まで待つ。停止が先行してから遅い開始が届くのを防ぐ。
    *receipt = Some(audio.play(duration_ms).await?);
    let deadline = tokio::time::sleep(StdDuration::from_millis(duration_ms as u64 + 500));
    tokio::pin!(deadline, events);
    let mut peak_db = -120.0f32;
    let mut reached = false;
    loop {
        tokio::select! {
            biased;
            _ = cancelled(cancel) => return Err(reach_cancelled()),
            _ = &mut deadline => break,
            event = events.next() => match event {
                Some(obws::events::Event::InputVolumeMeters { inputs }) => {
                    for meter in inputs {
                        if meter.name == AURALYN_OBS_SOURCE_NAME {
                            let db = peak_db_from_meter_levels(&meter.levels);
                            peak_db = peak_db.max(db);
                            reached |= db >= METER_DETECT_THRESHOLD_DB;
                        }
                    }
                }
                None => break,
                _ => {}
            },
        }
    }
    Ok(ObsAudioReachResult {
        reached: ReachValue::Bool(reached),
        peak_db: Some(peak_db),
        verification: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reach_target_settings_aba_advances_generation_without_meter_or_other_source_noise() {
        use obws::events::Event;
        let generation = AtomicU64::new(0);
        for muted in [true, false] {
            assert!(invalidate_reach_settings(
                &Event::InputMuteStateChanged {
                    name: AURALYN_OBS_SOURCE_NAME.into(),
                    muted
                },
                &generation
            ));
        }
        assert_eq!(generation.load(Ordering::SeqCst), 2);
        assert!(!invalidate_reach_settings(
            &Event::InputMuteStateChanged {
                name: "別ソース".into(),
                muted: true
            },
            &generation
        ));
        assert!(!invalidate_reach_settings(
            &Event::InputVolumeMeters { inputs: Vec::new() },
            &generation
        ));
        assert_eq!(generation.load(Ordering::SeqCst), 2);
    }

    async fn retain_test_verification(
        state: &ObsState,
        conditions: &Arc<crate::audio::conditions::Conditions>,
    ) {
        state.scene_clock.begin();
        state.reach_operation.store(1, Ordering::SeqCst);
        let witness = conditions.snapshot().unwrap();
        *state.reach_verification.lock().await = Some(ReachVerification {
            metadata: ObsReachVerification {
                operation_id: "1".into(),
                checked_at_unix_ms: 1_700_000_000_000,
                source: AURALYN_OBS_SOURCE_NAME.into(),
                connection_generation: state.scene_clock.generation.load(Ordering::SeqCst),
                setup_generation: 0,
                source_generation: 0,
                target_settings_generation: 0,
                audio_engine_epoch: witness.engine_epoch(),
                audio_conditions_revision: witness.revision(),
                config: None,
            },
            witness,
            fingerprint: 23,
            valid: true,
        });
    }

    #[tokio::test]
    async fn reach_verification_rejects_audio_obs_source_epoch_and_old_operations() {
        for change in 0..8 {
            let state = ObsState::new();
            let conditions = Arc::new(crate::audio::conditions::Conditions::default());
            conditions.lifecycle(true);
            retain_test_verification(&state, &conditions).await;
            assert!(audio_reach_current_with(&state, "1", || async { Ok(23) }).await);
            assert!(!audio_reach_current_with(&state, "unknown", || async { Ok(23) }).await);
            match change {
                0 => conditions.lifecycle(true), // mode/gain/VST等の条件世代変更
                1 => conditions.lifecycle(false),
                2 => {
                    state.scene_clock.stop();
                    state.scene_clock.begin();
                }
                3 => {
                    state
                        .source_generations
                        .lock()
                        .await
                        .insert(AURALYN_OBS_SOURCE_NAME.into(), 1);
                }
                4 => {
                    state.setup_generation.fetch_add(1, Ordering::SeqCst);
                }
                5 => {
                    state.reach_operation.store(2, Ordering::SeqCst);
                }
                6 => {
                    state
                        .reach_settings_generation
                        .fetch_add(1, Ordering::SeqCst);
                }
                _ => {
                    state.scene_clock.stop();
                }
            }
            assert!(
                !audio_reach_current_with(&state, "1", || async { Ok(23) }).await,
                "変更{change}後の以前の成功を拒否"
            );
            let retained = state.reach_verification.lock().await;
            assert_eq!(
                retained.as_ref().unwrap().metadata.checked_at_unix_ms,
                1_700_000_000_000
            );
            assert_eq!(
                retained.as_ref().unwrap().metadata.source,
                AURALYN_OBS_SOURCE_NAME
            );
        }
    }

    #[tokio::test]
    async fn reach_silent_device_or_filter_change_and_read_failure_expire_sticky() {
        let input = serde_json::json!({"device_id":"original"});
        let filters = serde_json::json!([{"filterName":"existing", "filterSettings":{"ratio":3}}]);
        let original = hash_reach_target("input", "input", &input, &filters);
        let replacements = [
            Ok(hash_reach_target(
                "input",
                "input",
                &serde_json::json!({"device_id":"replacement"}),
                &filters,
            )),
            Ok(hash_reach_target(
                "input",
                "input",
                &input,
                &serde_json::json!([{"filterName":"existing", "filterSettings":{"ratio":4}}]),
            )),
            Err("読取失敗".to_string()),
        ];
        for replacement in replacements {
            let state = ObsState::new();
            let conditions = Arc::new(crate::audio::conditions::Conditions::default());
            conditions.lifecycle(true);
            retain_test_verification(&state, &conditions).await;
            state
                .reach_verification
                .lock()
                .await
                .as_mut()
                .unwrap()
                .fingerprint = original;
            assert!(audio_reach_current_with(&state, "1", || async { Ok(original) }).await);
            assert!(!audio_reach_current_with(&state, "1", || async { replacement }).await);
            // 同じ接続・条件世代で元の値へ戻っても、観測済みの変更を消さない。
            assert!(
                !audio_reach_current_with(&state, "1", || async {
                    panic!("失効した記録を再読取で復活させない")
                })
                .await
            );
        }
    }

    #[tokio::test]
    async fn reach_readback_rechecks_conditions_and_never_expires_a_new_operation() {
        for newer in [false, true] {
            let state = Arc::new(ObsState::new());
            let conditions = Arc::new(crate::audio::conditions::Conditions::default());
            conditions.lifecycle(true);
            retain_test_verification(&state, &conditions).await;
            let (started, entered) = oneshot::channel();
            let (release, finish) = oneshot::channel();
            let owned = state.clone();
            let task = tokio::spawn(async move {
                audio_reach_current_with(&owned, "1", || async {
                    let _ = started.send(());
                    finish.await.unwrap();
                    Ok(23)
                })
                .await
            });
            entered.await.unwrap();
            if newer {
                state.reach_operation.store(2, Ordering::SeqCst);
                state
                    .reach_verification
                    .lock()
                    .await
                    .as_mut()
                    .unwrap()
                    .metadata
                    .operation_id = "2".into();
            } else {
                conditions.lifecycle(true);
            }
            release.send(()).unwrap();
            assert!(!task.await.unwrap());
            assert_eq!(
                state
                    .reach_verification
                    .lock()
                    .await
                    .as_ref()
                    .unwrap()
                    .valid,
                newer
            );
        }
    }

    #[tokio::test]
    async fn reach_public_read_without_connection_is_false_and_stays_expired() {
        let state = ObsState::new();
        let conditions = Arc::new(crate::audio::conditions::Conditions::default());
        conditions.lifecycle(true);
        retain_test_verification(&state, &conditions).await;
        assert!(!audio_reach_current(&state, "1").await);
        assert!(
            !state
                .reach_verification
                .lock()
                .await
                .as_ref()
                .unwrap()
                .valid
        );
    }

    #[test]
    fn reach_dto_keeps_legacy_shape_and_never_serializes_private_witness() {
        let legacy = ObsAudioReachResult {
            reached: ReachValue::Bool(true),
            peak_db: Some(-30.),
            verification: None,
        };
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            serde_json::json!({ "reached": true, "peakDb": -30. })
        );
    }

    #[tokio::test]
    async fn stopping_connection_joins_event_task_and_clears_credentials() {
        use std::sync::atomic::AtomicBool;
        struct Finished(Arc<AtomicBool>);
        impl Drop for Finished {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let state = ObsState::new();
        let finished = Arc::new(AtomicBool::new(false));
        let dropped = finished.clone();
        *state.conn_params.lock().await = Some(ObsConnectionParams {
            host: "localhost".into(),
            port: 4455,
            password: Some("test".into()),
        });
        *state.event_task.lock().await = Some(tokio::spawn(async move {
            let _finished = Finished(dropped);
            std::future::pending::<()>().await;
        }));
        tokio::task::yield_now().await;
        let mut client = state.client.lock().await;
        stop_connection(&state, &mut client)
            .await
            .expect("接続停止");
        assert!(finished.load(Ordering::SeqCst));
        assert!(state.event_task.lock().await.is_none());
        assert!(state.conn_params.lock().await.is_none());
        assert_eq!(state.setup_generation.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn reach_cancellation_closes_a_pending_handshake_without_starting_audio() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("試験用ローカル待受");
        let params = ObsConnectionParams {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            password: None,
        };
        struct NoTone;
        impl ReachTone for NoTone {
            async fn play(&self, _: u32) -> Result<ReachReceipt, String> {
                panic!("接続待機中に音声を開始しない");
            }
            async fn stop(&self, _: &ReachReceipt) -> Result<ReachReceipt, String> {
                panic!("未開始の音声を停止しない");
            }
        }
        let (cancel, receiver) = watch::channel(false);
        let task = tokio::spawn(run_audio_reach(params, NoTone, 30_000, receiver));
        let (mut socket, _) = tokio::time::timeout(StdDuration::from_secs(2), listener.accept())
            .await
            .expect("接続期限")
            .expect("接続受付");
        cancel.send(true).expect("中止通知");
        let (result, cleanup) = tokio::time::timeout(StdDuration::from_secs(2), task)
            .await
            .expect("中止を30秒の測定終了まで待たない")
            .expect("到達確認タスク");
        assert!(matches!(result, Err(ref error) if error == &reach_cancelled()));
        assert!(cleanup.is_ok());
        let mut data = Vec::new();
        let closed = tokio::time::timeout(StdDuration::from_secs(2), socket.read_to_end(&mut data))
            .await
            .expect("一時接続の終了期限");
        // ハンドシェイク途中の取消は、WindowsではEOFではなくRSTになることもある。
        // どちらも接続の終了であり、期限切れやそれ以外のI/O失敗は許容しない。
        match closed {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            Err(error) => panic!("一時接続の終了: {error}"),
        }
    }

    #[tokio::test]
    async fn stopping_connection_waits_for_reach_cleanup_before_returning() {
        let state = Arc::new(ObsState::new());
        let (cancel, mut receiver) = watch::channel(false);
        let (cancelled_tx, cancelled_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        *state.reach_task.lock().await = Some(ReachTask {
            cancel,
            task: tokio::spawn(async move {
                cancelled(&mut receiver).await;
                let _ = cancelled_tx.send(());
                let _ = finish_rx.await;
                Ok(())
            }),
        });
        let stopped = state.clone();
        let stop = tokio::spawn(async move {
            let mut client = stopped.client.lock().await;
            stop_connection(&stopped, &mut client).await
        });
        cancelled_rx.await.expect("到達確認へ中止通知");
        assert!(!stop.is_finished(), "後始末が終わる前に切断完了にしない");
        assert_eq!(state.setup_generation.load(Ordering::SeqCst), 0);
        finish_tx.send(()).expect("後始末完了");
        stop.await.expect("停止タスク").expect("停止成功");
        assert!(state.reach_task.lock().await.is_none());
        assert_eq!(state.setup_generation.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn reach_cleanup_failure_is_reported_after_disconnect() {
        let state = ObsState::new();
        let (cancel, mut receiver) = watch::channel(false);
        *state.reach_task.lock().await = Some(ReachTask {
            cancel,
            task: tokio::spawn(async move {
                cancelled(&mut receiver).await;
                Err("テスト音の停止失敗".into())
            }),
        });
        let mut client = state.client.lock().await;
        assert_eq!(
            stop_connection(&state, &mut client).await.unwrap_err(),
            "テスト音の停止失敗"
        );
        assert_eq!(state.setup_generation.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn input_events_invalidate_only_affected_names() {
        use obws::events::Event;
        let generation = AtomicU64::new(3);
        let sources = Mutex::new(HashMap::new());
        invalidate_setup_target(
            &Event::InputRemoved {
                name: "created".into(),
            },
            &generation,
            &sources,
        )
        .await;
        invalidate_setup_target(
            &Event::InputNameChanged {
                old_name: "old".into(),
                new_name: "new".into(),
            },
            &generation,
            &sources,
        )
        .await;
        assert_eq!(generation.load(Ordering::SeqCst), 3);
        assert_eq!(
            *sources.lock().await,
            HashMap::from([("created".into(), 1), ("old".into(), 1), ("new".into(), 1)])
        );
        invalidate_setup_target(
            &Event::CurrentSceneCollectionChanging {
                name: "other".into(),
            },
            &generation,
            &sources,
        )
        .await;
        assert_eq!(generation.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn timing_conditions_invalidate_on_filter_changes_but_not_own_sync_write() {
        use obws::events::Event;
        let generation = AtomicU64::new(3);
        let sources = Mutex::new(HashMap::new());
        assert!(
            invalidate_setup_target(
                &Event::SourceFilterEnableStateChanged {
                    source: "voice".into(),
                    filter: "compressor".into(),
                    enabled: false,
                },
                &generation,
                &sources,
            )
            .await
        );
        assert_eq!(sources.lock().await.get("voice"), Some(&1));
        assert!(
            !invalidate_setup_target(
                &Event::InputAudioSyncOffsetChanged {
                    name: "voice".into(),
                    offset: time::Duration::milliseconds(50),
                },
                &generation,
                &sources,
            )
            .await
        );
        assert_eq!(sources.lock().await.get("voice"), Some(&1));
        assert_eq!(generation.load(Ordering::SeqCst), 3);
        assert!(invalidate_setup_target(&Event::ExitStarted, &generation, &sources).await);
        assert_eq!(generation.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn disconnected_state_reports_not_connected() {
        assert!(!connection_status(&ObsState::new()).await);
    }

    fn summary(name: &str, kind: &str, muted: bool) -> ObsInputSummary {
        ObsInputSummary {
            name: name.to_string(),
            kind: kind.to_string(),
            unversioned_kind: kind.to_string(),
            muted,
        }
    }

    #[test]
    fn cable_output_device_name_detection() {
        assert!(is_cable_output_device_name(
            "CABLE Output (VB-Audio Virtual Cable)"
        ));
        assert!(!is_cable_output_device_name(
            "CABLE Input (VB-Audio Virtual Cable)"
        ));
        assert!(!is_cable_output_device_name("Realtek HD Audio"));
    }

    #[test]
    fn duplicate_mic_filters_muted_and_auralyn() {
        let inputs = vec![
            summary("Auralyn マイク", "wasapi_input_capture", false),
            summary("Desktop Mic", "wasapi_input_capture", false),
            summary("Old Mic", "wasapi_input_capture", true),
            summary("Webcam", "dshow_input", false),
        ];
        let dupes = find_duplicate_mic_sources(&inputs, AURALYN_OBS_SOURCE_NAME);
        assert_eq!(dupes, vec!["Desktop Mic".to_string()]);
    }

    #[test]
    fn peak_db_from_meter_levels_converts_mul() {
        let levels = vec![[0.1, 0.0, 0.0]];
        let db = peak_db_from_meter_levels(&levels);
        assert!((db - (-20.0)).abs() < 0.1);
    }

    #[test]
    fn mul_to_db_silence_floor() {
        assert_eq!(mul_to_db(0.0), -120.0);
    }
}

#[cfg(test)]
mod live_scene_tests {
    use super::*;
    #[test]
    fn live_modes_scene_clock_does_not_emit_initial_scene_and_rejects_retired_generation() {
        let clock = SceneClock::default();
        let first = clock.begin();
        assert_eq!(clock.status().sequence, 0);
        assert_eq!(clock.event(first, "singing".into()).unwrap().sequence, 1);
        assert_eq!(clock.event(first, "talk".into()).unwrap().sequence, 2);
        clock.stop();
        assert!(!clock.status().connected);
        assert!(clock.event(first, "late".into()).is_none());
        let second = clock.begin();
        assert_ne!(first, second);
        assert!(clock.event(first, "late".into()).is_none());
        assert_eq!(clock.event(second, "new".into()).unwrap().sequence, 1);
    }
}
