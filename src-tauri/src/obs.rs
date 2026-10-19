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
    ) -> impl std::future::Future<Output = Result<(), String>> + Send;
    fn stop(&self) -> impl std::future::Future<Output = Result<(), String>> + Send;
}

impl ReachTone for AudioState {
    async fn play(&self, duration_ms: u32) -> Result<(), String> {
        let host = self.0.clone();
        tokio::task::spawn_blocking(move || {
            host.lock()
                .map_err(|_| "音声状態を取得できません".to_string())?
                .play_test_tone(1000.0, duration_ms, -20.0)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn stop(&self) -> Result<(), String> {
        let host = self.0.clone();
        tokio::task::spawn_blocking(move || {
            host.lock()
                .map_err(|_| "音声状態を取得できません".to_string())?
                .stop_test_tone()
                .map_err(|e| e.to_string())
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

pub struct ObsState {
    pub client: Mutex<Option<Client>>,
    event_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    reach_task: Mutex<Option<ReachTask>>,
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
            reach_task: Mutex::new(None),
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
    stop_connection(&state, &mut client_guard).await?;
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
    stop_connection(&state, &mut client_guard).await
}

async fn stop_reach(state: &ObsState) -> Result<(), String> {
    if let Some(reach) = state.reach_task.lock().await.take() {
        let _ = reach.cancel.send(true);
        // abortは後始末も捨てるため使わず、テスト音と一時接続の終了を待つ。
        return reach.task.await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn stop_connection(state: &ObsState, client: &mut Option<Client>) -> Result<(), String> {
    let reach_result = stop_reach(state).await;
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
    // 登録と切断を同じロックで直列化し、切断後に確認処理を開始しない。
    let guard = obs_state.client.lock().await;
    if guard.is_none() {
        return Err("OBS に接続されていません".into());
    }
    stop_reach(obs_state).await?;
    let params = obs_state
        .conn_params
        .lock()
        .await
        .clone()
        .ok_or("OBS の接続情報がありません。再接続してください。")?;
    let audio = AudioState(audio_state.0.clone());
    let (cancel, receiver) = watch::channel(false);
    let (reply, result) = oneshot::channel();
    *obs_state.reach_task.lock().await = Some(ReachTask {
        cancel,
        task: tokio::spawn(async move {
            let (result, cleanup) = run_audio_reach(params, audio, duration_ms, receiver).await;
            let _ = reply.send(result);
            cleanup
        }),
    });
    drop(guard);
    result
        .await
        .map_err(|_| "OBS の到達確認が終了しました".to_string())?
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
) -> (Result<ObsAudioReachResult, String>, Result<(), String>) {
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
                Ok(ObsAudioReachResult {
                    reached: ReachValue::Str("unsupported".into()),
                    peak_db: None,
                }),
                Ok(()),
            )
        }
    };
    let mut tone_attempted = false;
    let result = observe_audio_reach(
        &meter_client,
        &audio,
        duration_ms,
        &mut cancel,
        &mut tone_attempted,
    )
    .await;
    let cleanup = if tone_attempted {
        // 開始IPCの応答喪失も含め、終了前に停止を要求する。
        audio.stop().await
    } else {
        Ok(())
    };
    meter_client.disconnect().await;
    (cleanup.clone().and(result), cleanup)
}

async fn observe_audio_reach(
    meter_client: &Client,
    audio: &impl ReachTone,
    duration_ms: u32,
    cancel: &mut watch::Receiver<bool>,
    tone_attempted: &mut bool,
) -> Result<ObsAudioReachResult, String> {
    let inputs_api = meter_client.inputs();
    let inputs = tokio::select! {
        biased;
        _ = cancelled(cancel) => return Err(reach_cancelled()),
        inputs = inputs_api.list(None) => inputs.map_err(|e| e.to_string())?,
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
            })
        }
    };
    if *cancel.borrow() {
        return Err(reach_cancelled());
    }
    *tone_attempted = true;
    // 開始を送った後は応答まで待つ。停止が先行してから遅い開始が届くのを防ぐ。
    audio.play(duration_ms).await?;
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
            async fn play(&self, _: u32) -> Result<(), String> {
                panic!("接続待機中に音声を開始しない");
            }
            async fn stop(&self) -> Result<(), String> {
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
        tokio::time::timeout(StdDuration::from_secs(2), socket.read_to_end(&mut data))
            .await
            .expect("一時接続の終了期限")
            .expect("一時接続の終了");
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
