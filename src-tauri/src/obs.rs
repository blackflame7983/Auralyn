use crate::audio::AudioState;
use crate::routing_diag;
use futures_util::StreamExt;
use obws::requests::EventSubscription;
use obws::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

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

pub struct ObsState {
    pub client: Mutex<Option<Client>>,
    event_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
            client: Mutex::new(None),
            event_task: Mutex::new(None),
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
    stop_connection(&state, &mut client_guard).await;
    let client = tokio::time::timeout(
        StdDuration::from_secs(5),
        Client::connect(&host, port, password.clone()),
    )
    .await
    .map_err(|_| "OBS への接続がタイムアウトしました".to_string())?
    .map_err(|e| format!("Failed to connect to OBS: {}", e))?;

    let events = client.events().map_err(|e| e.to_string())?;

    *client_guard = Some(client);
    *state.conn_params.lock().await = Some(ObsConnectionParams {
        host: host.clone(),
        port,
        password,
    });

    log::info!("Connected to OBS at {}:{}", host, port);

    // シーン変更などのイベントを監視
    let setup_generation = state.setup_generation.clone();
    let source_generations = state.source_generations.clone();
    *state.event_task.lock().await = Some(tokio::spawn(async move {
        tokio::pin!(events);
        while let Some(event) = events.next().await {
            invalidate_setup_target(&event, &setup_generation, &source_generations).await;
            if let obws::events::Event::CurrentProgramSceneChanged { name, .. } = event {
                log::info!("OBS Scene Changed: {}", name);
                let _ = app.emit(
                    "obs://scene-changed",
                    ObsSceneChangedEvent { scene_name: name },
                );
            }
        }
        log::info!("OBS Event Loop Ended");
    }));

    Ok(())
}

pub async fn disconnect_obs(state: tauri::State<'_, ObsState>) -> Result<(), String> {
    let mut client_guard = state.client.lock().await;
    stop_connection(&state, &mut client_guard).await;
    Ok(())
}

async fn stop_connection(state: &ObsState, client: &mut Option<Client>) {
    if let Some(task) = state.event_task.lock().await.take() {
        task.abort();
        let _ = task.await;
    }
    if let Some(mut client) = client.take() {
        client.disconnect().await;
    }
    // 復元情報を捨てずに予定だけ破棄する。購読の空白は世代で区別する。
    state.setup.lock().await.invalidate_plan();
    state.setup_generation.fetch_add(1, Ordering::SeqCst);
    *state.conn_params.lock().await = None;
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
) {
    use obws::events::Event;
    match event {
        Event::CurrentSceneCollectionChanging { .. } => {
            generation.fetch_add(1, Ordering::SeqCst);
        }
        Event::InputRemoved { name } => {
            *sources.lock().await.entry(name.clone()).or_default() += 1;
        }
        Event::InputNameChanged { old_name, new_name } => {
            let mut sources = sources.lock().await;
            *sources.entry(old_name.clone()).or_default() += 1;
            *sources.entry(new_name.clone()).or_default() += 1;
        }
        _ => {}
    }
}

/// テストトーンを再生し、OBS の入力メーターで到達を確認する
pub async fn check_audio_reach(
    obs_state: &ObsState,
    audio_state: &AudioState,
    duration_ms: u32,
) -> Result<ObsAudioReachResult, String> {
    // ソース存在チェックは既存接続で行う（ロックはここで解放される）
    {
        let guard = obs_state.client.lock().await;
        let client = guard
            .as_ref()
            .ok_or_else(|| "OBS に接続されていません".to_string())?;

        let inputs = client
            .inputs()
            .list(None)
            .await
            .map_err(|e| format!("OBS 入力一覧の取得に失敗: {}", e))?;

        if !inputs.iter().any(|i| i.name == AURALYN_OBS_SOURCE_NAME) {
            return Err(format!(
                "「{}」ソースが見つかりません。先に自動セットアップを実行してください。",
                AURALYN_OBS_SOURCE_NAME
            ));
        }
    }

    // メーター監視は一時的な第2接続で行い、既存イベントループ
    // （シーン変更通知など）と購読・ストリームを競合させない
    let params = obs_state
        .conn_params
        .lock()
        .await
        .clone()
        .ok_or_else(|| "OBS の接続情報がありません。再接続してください。".to_string())?;

    let meter_client = match Client::connect_with_config(obws::client::ConnectConfig {
        host: params.host.as_str(),
        port: params.port,
        password: params.password.as_deref(),
        event_subscriptions: Some(EventSubscription::INPUT_VOLUME_METERS),
        broadcast_capacity: None,
    })
    .await
    {
        Ok(c) => c,
        Err(_) => {
            return Ok(ObsAudioReachResult {
                reached: ReachValue::Str("unsupported".to_string()),
                peak_db: None,
            });
        }
    };

    let events = match meter_client.events() {
        Ok(stream) => stream,
        Err(_) => {
            return Ok(ObsAudioReachResult {
                reached: ReachValue::Str("unsupported".to_string()),
                peak_db: None,
            });
        }
    };

    {
        let mut host = audio_state
            .0
            .lock()
            .map_err(|_| "Failed to lock audio state".to_string())?;
        host.play_test_tone(1000.0, duration_ms, -20.0)
            .map_err(|e| e.to_string())?;
    }

    let deadline = tokio::time::Instant::now() + StdDuration::from_millis(duration_ms as u64 + 500);
    let mut peak_db = -120.0f32;
    let mut reached = false;

    tokio::pin!(events);
    while tokio::time::Instant::now() < deadline {
        tokio::select! {
            maybe_event = events.next() => {
                match maybe_event {
                    Some(obws::events::Event::InputVolumeMeters { inputs: meters }) => {
                        for meter in meters {
                            if meter.name == AURALYN_OBS_SOURCE_NAME {
                                let db = peak_db_from_meter_levels(&meter.levels);
                                peak_db = peak_db.max(db);
                                if db >= METER_DETECT_THRESHOLD_DB {
                                    reached = true;
                                }
                            }
                        }
                    }
                    None => break,
                    _ => {}
                }
            }
            _ = tokio::time::sleep(StdDuration::from_millis(50)) => {}
        }
    }

    {
        let mut host = audio_state
            .0
            .lock()
            .map_err(|_| "Failed to lock audio state".to_string())?;
        let _ = host.stop_test_tone();
    }

    drop(meter_client);

    Ok(ObsAudioReachResult {
        reached: ReachValue::Bool(reached),
        peak_db: Some(peak_db),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        stop_connection(&state, &mut client).await;
        assert!(finished.load(Ordering::SeqCst));
        assert!(state.event_task.lock().await.is_none());
        assert!(state.conn_params.lock().await.is_none());
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
