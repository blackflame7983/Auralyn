use crate::audio::AudioState;
use crate::routing_diag;
use futures_util::StreamExt;
use obws::common::MonitorType;
use obws::requests::inputs::{Create, SetSettings};
use obws::requests::EventSubscription;
use obws::Client;
use serde::Serialize;
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter};
use time::Duration;
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
    /// 到達確認用の一時接続に使う接続パラメータ
    pub conn_params: Mutex<Option<ObsConnectionParams>>,
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
            conn_params: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ObsSceneChangedEvent {
    pub scene_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsSetupResult {
    pub created: bool,
    pub device_bound: bool,
    pub duplicate_mic_sources: Vec<String>,
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
    let client = Client::connect(&host, port, password.clone())
        .await
        .map_err(|e| format!("Failed to connect to OBS: {}", e))?;

    let events = client.events().map_err(|e| e.to_string())?;

    *state.client.lock().await = Some(client);
    *state.conn_params.lock().await = Some(ObsConnectionParams {
        host: host.clone(),
        port,
        password,
    });

    log::info!("Connected to OBS at {}:{}", host, port);

    // シーン変更などのイベントを監視
    tauri::async_runtime::spawn(async move {
        tokio::pin!(events);
        while let Some(event) = events.next().await {
            if let obws::events::Event::CurrentProgramSceneChanged { name, .. } = event {
                log::info!("OBS Scene Changed: {}", name);
                let _ = app.emit(
                    "obs://scene-changed",
                    ObsSceneChangedEvent { scene_name: name },
                );
            }
        }
        log::info!("OBS Event Loop Ended");
    });

    Ok(())
}

pub async fn disconnect_obs(state: tauri::State<'_, ObsState>) -> Result<(), String> {
    *state.client.lock().await = None;
    *state.conn_params.lock().await = None;
    Ok(())
}

/// 「Auralyn マイク」ソースを検索または作成し、推奨設定を適用する
pub async fn setup_auralyn_source(state: &ObsState) -> Result<ObsSetupResult, String> {
    let guard = state.client.lock().await;
    let client = guard
        .as_ref()
        .ok_or_else(|| "OBS に接続されていません".to_string())?;

    let inputs = client
        .inputs()
        .list(None)
        .await
        .map_err(|e| format!("OBS 入力一覧の取得に失敗: {}", e))?;

    let created = !inputs
        .iter()
        .any(|i| i.name == AURALYN_OBS_SOURCE_NAME);

    if created {
        let scene = client
            .scenes()
            .current_program_scene()
            .await
            .map_err(|e| format!("現在のシーン取得に失敗: {}", e))?;

        client
            .inputs()
            .create::<serde_json::Value>(Create {
                scene: &scene,
                input: AURALYN_OBS_SOURCE_NAME,
                kind: WASAPI_INPUT_KIND,
                settings: None,
                enabled: Some(true),
            })
            .await
            .map_err(|e| format!("OBS ソース作成に失敗: {}", e))?;
    }

    let device_bound = resolve_and_bind_cable_output(client, AURALYN_OBS_SOURCE_NAME)
        .await
        .unwrap_or(false);

    apply_recommended_input_settings(client, AURALYN_OBS_SOURCE_NAME).await?;

    let all_inputs = client
        .inputs()
        .list(None)
        .await
        .map_err(|e| format!("OBS 入力一覧の再取得に失敗: {}", e))?;

    let mut summaries = Vec::new();
    for input in &all_inputs {
        if !is_audio_input_capture_kind(&input.kind, &input.unversioned_kind) {
            continue;
        }
        let muted = client
            .inputs()
            .muted(&input.name)
            .await
            .map_err(|e| format!("ミュート状態の取得に失敗 ({}): {}", input.name, e))?;
        summaries.push(ObsInputSummary {
            name: input.name.clone(),
            kind: input.kind.clone(),
            unversioned_kind: input.unversioned_kind.clone(),
            muted,
        });
    }

    let duplicate_mic_sources = find_duplicate_mic_sources(&summaries, AURALYN_OBS_SOURCE_NAME);

    Ok(ObsSetupResult {
        created,
        device_bound,
        duplicate_mic_sources,
    })
}

/// 指定名の OBS 入力をミュート / ミュート解除
pub async fn mute_source(state: &ObsState, name: String, muted: bool) -> Result<(), String> {
    let guard = state.client.lock().await;
    let client = guard
        .as_ref()
        .ok_or_else(|| "OBS に接続されていません".to_string())?;

    client
        .inputs()
        .set_muted(&name, muted)
        .await
        .map_err(|e| format!("ミュート設定に失敗 ({}): {}", name, e))
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

        if !inputs
            .iter()
            .any(|i| i.name == AURALYN_OBS_SOURCE_NAME)
        {
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

    let deadline =
        tokio::time::Instant::now() + StdDuration::from_millis(duration_ms as u64 + 500);
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

/// CABLE Output を device_id としてバインド（失敗時は false）
async fn resolve_and_bind_cable_output(client: &Client, input_name: &str) -> Result<bool, obws::Error> {
    let items = client
        .inputs()
        .properties_list_property_items(input_name, "device_id")
        .await?;

    let device_id = items
        .iter()
        .find(|item| is_cable_output_device_name(&item.name))
        .and_then(|item| item.value.as_str().map(|s| s.to_string()));

    let Some(device_id) = device_id else {
        return Ok(false);
    };

    #[derive(Serialize)]
    struct WasapiSettings<'a> {
        device_id: &'a str,
    }

    client
        .inputs()
        .set_settings(SetSettings {
            input: input_name,
            settings: &WasapiSettings {
                device_id: &device_id,
            },
            overlay: Some(true),
        })
        .await?;

    Ok(true)
}

/// モニタリング OFF・ミュート解除など推奨設定を適用
async fn apply_recommended_input_settings(client: &Client, name: &str) -> Result<(), String> {
    client
        .inputs()
        .set_muted(name, false)
        .await
        .map_err(|e| format!("ミュート解除に失敗: {}", e))?;

    client
        .inputs()
        .set_audio_monitor_type(name, MonitorType::None)
        .await
        .map_err(|e| format!("モニタリング設定に失敗: {}", e))?;

    client
        .inputs()
        .set_audio_sync_offset(name, Duration::ZERO)
        .await
        .map_err(|e| format!("同期オフセット設定に失敗: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(is_cable_output_device_name("CABLE Output (VB-Audio Virtual Cable)"));
        assert!(!is_cable_output_device_name("CABLE Input (VB-Audio Virtual Cable)"));
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
