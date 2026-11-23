//! Stream Deckの標準Hotkeyからも使える、同じ音声操作への入口。
use crate::audio::ControlError;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::Path,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    MuteToggle,
    MuteOn,
    MuteOff,
    BypassToggle,
    BypassOn,
    BypassOff,
    GainUp,
    GainDown,
    SingingOn,
    TalkOn,
    NoiseToggle,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    action: Action,
    shortcut: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    bindings: Vec<Binding>,
    errors: Vec<ShortcutError>,
}

// 表示文をIPCへ固定せず、画面で現在の言語へ解決する。外部の詳細は別フィールドで保持する。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum ShortcutError {
    TooManyBindings,
    InvalidShortcut { shortcut: String },
    ModifierRequired,
    DuplicateBinding,
    StateUnavailable,
    LoadFailed { detail: String },
    RegisterFailed { shortcut: String, detail: String },
    RegistrationConflict { detail: String },
    SaveFailed { detail: String },
    UnregisterFailed { detail: String },
    OperationFailed { detail: String },
    AudioStateUnavailable,
    GainPending,
    ActionFailed { detail: String },
}

impl std::fmt::Display for ShortcutError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Shortcut error: {self:?}")
    }
}
impl std::error::Error for ShortcutError {}
#[derive(Default)]
pub struct Shortcuts(
    pub Mutex<Status>,
    AtomicBool,
    AtomicU64,
    Mutex<CaptureGate>,
    OnceLock<crate::audio::AudioControl>,
);

#[derive(Default)]
struct CaptureGate {
    generation: u64,
    active: Option<(u64, Instant)>,
}

impl CaptureGate {
    fn begin(&mut self, now: Instant) -> String {
        self.generation = self.generation.wrapping_add(1);
        self.active = Some((self.generation, now + Duration::from_secs(30)));
        self.generation.to_string()
    }
    fn end(&mut self, token: &str) {
        if self.active.is_some_and(|(id, _)| id.to_string() == token) {
            self.active = None;
        }
    }
    fn permits(&mut self, generation: u64, now: Instant) -> bool {
        self.generation == generation && self.token(now).is_none()
    }
    fn token(&mut self, now: Instant) -> Option<String> {
        if self.active.is_some_and(|(_, deadline)| now >= deadline) {
            self.active = None;
        }
        self.active.map(|(id, _)| id.to_string())
    }
}

// OS通知のコールバックでは音声操作が保持するgateを待たない。
fn try_dispatch_gate<T>(
    gate: &Mutex<CaptureGate>,
    dispatch: impl FnOnce(&mut CaptureGate) -> T,
) -> Option<T> {
    let mut gate = gate.try_lock().ok()?;
    Some(dispatch(&mut gate))
}

#[derive(Clone, Serialize)]
struct CaptureEvent {
    token: String,
    shortcut: String,
}

#[tauri::command]
pub async fn begin_shortcut_capture(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<String, ShortcutError> {
    if window.label() != "main" {
        return Err(ShortcutError::StateUnavailable);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Shortcuts>();
        let mut gate = state
            .3
            .lock()
            .map_err(|_| ShortcutError::StateUnavailable)?;
        Ok(gate.begin(Instant::now()))
    })
    .await
    .map_err(|e| ShortcutError::OperationFailed {
        detail: e.to_string(),
    })?
}

#[tauri::command]
pub async fn end_shortcut_capture(
    window: tauri::WebviewWindow,
    app: AppHandle,
    token: String,
) -> Result<(), ShortcutError> {
    if window.label() != "main" {
        return Err(ShortcutError::StateUnavailable);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Shortcuts>();
        let mut gate = state
            .3
            .lock()
            .map_err(|_| ShortcutError::StateUnavailable)?;
        gate.end(&token);
        Ok(())
    })
    .await
    .map_err(|e| ShortcutError::OperationFailed {
        detail: e.to_string(),
    })?
}

fn defaults() -> Vec<Binding> {
    vec![
        Binding {
            action: Action::MuteToggle,
            shortcut: "Alt+KeyM".into(),
        },
        Binding {
            action: Action::BypassToggle,
            shortcut: "Alt+KeyP".into(),
        },
    ]
}

/// 画面の音づくりへ伝える、切替後のノイズ低減設定。
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoiseToggle {
    enabled: bool,
    mode: String,
    strength: f32,
    voice_guard: bool,
}

// ON/OFFだけを反転し、モード・強度・声を守るは現在値を引き継ぐ（未設定の強度は画面と同じ既定値）。
pub(crate) fn noise_toggle(stats: &crate::audio::EngineRuntimeStats) -> NoiseToggle {
    NoiseToggle {
        enabled: !stats.noise_reduction_enabled,
        mode: if stats.noise_reduction_mode.is_empty() {
            "low".into()
        } else {
            stats.noise_reduction_mode.to_lowercase()
        },
        strength: if stats.noise_control_strength.is_finite() && stats.noise_control_strength > 0.0
        {
            stats.noise_control_strength
        } else {
            0.8
        },
        voice_guard: stats.noise_voice_guard,
    }
}

pub(crate) fn validate(bindings: &[Binding]) -> Result<Vec<Shortcut>, ShortcutError> {
    if bindings.len() > 8 {
        return Err(ShortcutError::TooManyBindings);
    }
    let mut keys = HashSet::new();
    let mut actions = HashSet::new();
    bindings
        .iter()
        .map(|b| {
            let key =
                Shortcut::from_str(&b.shortcut).map_err(|_| ShortcutError::InvalidShortcut {
                    shortcut: b.shortcut.clone(),
                })?;
            if b.shortcut.len() > 80 || !b.shortcut.contains('+') {
                return Err(ShortcutError::ModifierRequired);
            }
            if !keys.insert(key.id()) || !actions.insert(format!("{:?}", b.action)) {
                return Err(ShortcutError::DuplicateBinding);
            }
            Ok(key)
        })
        .collect()
}

pub(crate) fn read_bindings(root: &Path) -> Result<Vec<Binding>, ShortcutError> {
    let path = root.join("shortcuts.json");
    if path.exists() {
        let bytes = std::fs::read(path).map_err(|e| ShortcutError::LoadFailed {
            detail: e.to_string(),
        })?;
        serde_json::from_slice(&bytes).map_err(|e| ShortcutError::LoadFailed {
            detail: e.to_string(),
        })
    } else {
        Ok(defaults())
    }
}

pub fn initialize(app: &AppHandle) {
    // UIのacknowledgeや再読み込みから再度呼ばれても、同じプロセスで二重登録しない。
    if app.state::<Shortcuts>().1.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Some(audio) = app.try_state::<crate::audio::AudioState>() {
        let _ = app.state::<Shortcuts>().4.set(audio.0.clone());
    }
    let result = (|| -> Result<(), ShortcutError> {
        let root = app
            .path()
            .app_config_dir()
            .map_err(|e| ShortcutError::LoadFailed {
                detail: e.to_string(),
            })?;
        let bindings = read_bindings(&root)?;
        let keys = validate(&bindings)?;
        let state = app.state::<Shortcuts>();
        let mut state = state
            .0
            .lock()
            .map_err(|_| ShortcutError::StateUnavailable)?;
        for (b, key) in bindings.iter().zip(keys) {
            if let Err(error) = app.global_shortcut().register(key) {
                state.errors.push(ShortcutError::RegisterFailed {
                    shortcut: b.shortcut.clone(),
                    detail: error.to_string(),
                });
            }
        }
        state.bindings = bindings;
        Ok(())
    })();
    if let Err(error) = result {
        if let Ok(mut state) = app.state::<Shortcuts>().0.lock() {
            state.errors.push(error);
        }
    }
}

#[tauri::command]
pub fn get_shortcuts(app: AppHandle) -> Result<Status, ShortcutError> {
    Ok(app
        .state::<Shortcuts>()
        .0
        .lock()
        .map_err(|_| ShortcutError::StateUnavailable)?
        .clone())
}

#[tauri::command]
pub async fn save_shortcuts(
    app: AppHandle,
    bindings: Vec<Binding>,
) -> Result<Status, ShortcutError> {
    let keys = validate(&bindings)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Shortcuts>();
        let mut state = state
            .0
            .lock()
            .map_err(|_| ShortcutError::StateUnavailable)?;
        let old_keys = validate(&state.bindings)?;
        let mut added = Vec::new();
        for key in &keys {
            if !app.global_shortcut().is_registered(*key) {
                if let Err(error) = app.global_shortcut().register(*key) {
                    for registered in added {
                        let _ = app.global_shortcut().unregister(registered);
                    }
                    return Err(ShortcutError::RegistrationConflict {
                        detail: error.to_string(),
                    });
                }
                added.push(*key);
            }
        }
        let path = app
            .path()
            .app_config_dir()
            .map_err(|e| ShortcutError::SaveFailed {
                detail: e.to_string(),
            })?
            .join("shortcuts.json");
        let persist = crate::migration::write_json(&path, &bindings);
        if let Err(error) = persist {
            for key in added {
                let _ = app.global_shortcut().unregister(key);
            }
            return Err(ShortcutError::SaveFailed { detail: error });
        }
        state.errors.clear();
        for key in old_keys
            .iter()
            .filter(|old| !keys.iter().any(|new| new.id() == old.id()))
        {
            if let Err(error) = app.global_shortcut().unregister(*key) {
                state.errors.push(ShortcutError::UnregisterFailed {
                    detail: error.to_string(),
                });
            }
        }
        state.bindings = bindings;
        Ok(state.clone())
    })
    .await
    .map_err(|e| ShortcutError::OperationFailed {
        detail: e.to_string(),
    })?
}

/// 画面の `isEngineRunning` と同じ意味か。
/// 常駐プロセスだけでは足りない。停止後もプロセスは残るため、適用中の設定と、
/// 実ストリームが動いていて失敗していないことを見る。画面の定期取得は
/// `getAudioState` の `is_running` と `config`、および `getAudioStreamState`
/// （`auto_gain` の status）の `running && !streamFailed` を使っている。
pub(crate) fn shortcut_audio_running(
    process_running: bool,
    has_config: bool,
    stream_running: bool,
    stream_failed: bool,
) -> bool {
    process_running && has_config && stream_running && !stream_failed
}

/// 音声が止まっている比較ショートカットは送らない。
/// 動いているときは、これまでと同じオン・オフ・反転を返す。
pub(crate) fn compare_shortcut_bypass(
    audio_running: bool,
    action: &Action,
    current_bypass: bool,
) -> Option<bool> {
    if !audio_running {
        return None;
    }
    match action {
        Action::BypassOn => Some(true),
        Action::BypassOff => Some(false),
        Action::BypassToggle => Some(!current_bypass),
        _ => None,
    }
}

pub fn dispatch(app: AppHandle, id: u32) {
    let state = app.state::<Shortcuts>();
    let Some(Some((action, generation))) = try_dispatch_gate(&state.3, |gate| {
        let binding = state.0.lock().ok().and_then(|status| {
            status
                .bindings
                .iter()
                .find(|binding| {
                    Shortcut::from_str(&binding.shortcut).is_ok_and(|key| key.id() == id)
                })
                .cloned()
        })?;
        if let Some(token) = gate.token(Instant::now()) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "shortcut-captured",
                    CaptureEvent {
                        token,
                        shortcut: binding.shortcut,
                    },
                );
            }
            return None;
        }
        Some((binding.action, gate.generation))
    }) else {
        return;
    };
    let is_mode = matches!(action, Action::SingingOn | Action::TalkOn);
    let intent_sequence = if is_mode {
        app.state::<Shortcuts>().2.fetch_add(1, Ordering::AcqRel) + 1
    } else {
        0
    };
    let audio = app.state::<Shortcuts>().4.get().cloned();
    let notify_app = app.clone();
    let notify: Notifier = Arc::new(move |notice| {
        let _ = notify_app.emit("shortcut-error", notice);
    });
    let spawn: Spawner = Arc::new(|job| {
        tauri::async_runtime::spawn_blocking(job);
    });
    let Some(audio) = audio else {
        notify_shortcut_error_off_callback(&spawn, notify, ShortcutError::AudioStateUnavailable);
        return;
    };
    let conditions = app
        .try_state::<crate::audio::conditions::ConditionState>()
        .map(|conditions| conditions.0.clone());
    let posted_action = action.clone();
    post_shortcut_work(
        &audio,
        &posted_action,
        conditions.as_ref(),
        notify,
        spawn,
        move |host| {
            // 開始前に待機していた操作は、入力開始後に実行しない。
            let shortcuts = app.state::<Shortcuts>();
            let mut gate = shortcuts
                .3
                .lock()
                .map_err(|_| ShortcutError::StateUnavailable)?;
            if !gate.permits(generation, Instant::now()) {
                return Ok(());
            }
            match action {
                Action::SingingOn | Action::TalkOn => {
                    if intent_sequence != app.state::<Shortcuts>().2.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    use crate::audio_engine::live_modes::{Intent, Request};
                    let epoch = host.live_modes(Request::Snapshot)?.epoch;
                    let intent = Intent {
                        client_id: "shortcuts".into(),
                        sequence: intent_sequence,
                        expected_epoch: epoch,
                    };
                    let request = if action == Action::SingingOn {
                        Request::SingingOn { intent }
                    } else {
                        Request::TalkOn { intent }
                    };
                    host.live_modes(request)?;
                }
                Action::MuteToggle => host.toggle_global_mute()?,
                Action::MuteOn => host.set_global_mute(true)?,
                Action::MuteOff => host.set_global_mute(false)?,
                Action::BypassToggle | Action::BypassOn | Action::BypassOff => {
                    // 止まっているあいだは比較の切り替えを送らず、フラグも変えない。
                    // プロセスが無い、または適用中の設定が無いときは、状態の照会もしない。
                    let info = host.get_state();
                    let (stream_running, stream_failed) =
                        if info.is_running && info.config.is_some() {
                            match host.auto_gain(crate::audio_engine::auto_gain::Request::Status) {
                                Ok(status) => (status.running, status.stream_failed),
                                // 画面の取得失敗と同じく、動いていないものとして扱う。通知は出さない。
                                Err(_) => (false, false),
                            }
                        } else {
                            (false, false)
                        };
                    let audio_running = shortcut_audio_running(
                        info.is_running,
                        info.config.is_some(),
                        stream_running,
                        stream_failed,
                    );
                    let current_bypass = if audio_running && matches!(action, Action::BypassToggle)
                    {
                        host.get_engine_runtime_stats()?.global_bypass
                    } else {
                        false
                    };
                    match compare_shortcut_bypass(audio_running, &action, current_bypass) {
                        Some(active) => host.set_global_bypass(active)?,
                        None => {
                            log::info!(
                                "音声が止まっているため、比較のショートカットを無視しました"
                            );
                        }
                    }
                }
                Action::NoiseToggle => {
                    let next = noise_toggle(&host.get_engine_runtime_stats()?);
                    host.set_noise_control_config(
                        next.enabled,
                        next.mode.clone(),
                        next.strength,
                        next.voice_guard,
                    )?;
                    app.emit("shortcut-noise-toggled", next)?;
                }
                Action::GainUp | Action::GainDown => {
                    let status = host.auto_gain(crate::audio_engine::auto_gain::Request::Status)?;
                    if status.stream_failed || (status.running && !status.settled) {
                        return Err(ShortcutError::GainPending.into());
                    }
                    let next = (status.gain
                        + if action == Action::GainUp {
                            0.01
                        } else {
                            -0.01
                        })
                    .clamp(0.0, 2.0);
                    host.set_output_gain(next)?;
                    if !status.running {
                        app.emit("shortcut-stopped-gain", next * 100.0)?;
                    } else {
                        let intent = host.shortcut_gain_intent(next)?;
                        app.emit("shortcut-output-gain", intent)?;
                    }
                }
            }
            Ok(())
        },
    );
}

fn is_mute_action(action: &Action) -> bool {
    matches!(
        action,
        Action::MuteToggle | Action::MuteOn | Action::MuteOff
    )
}

/// ミュートの動作は、コマンドのミュートと同じく、停止のレーンで先に実行する入口にする。
fn shortcut_entry(action: &Action) -> crate::audio::Entry {
    if is_mute_action(action) {
        crate::audio::Entry::new(crate::audio::EntryKind::Shortcut, "global_shortcut_mute")
    } else {
        crate::audio::Entry::new(crate::audio::EntryKind::Shortcut, "global_shortcut")
    }
}

/// ミュートの動作だけが、待つ前に停止・ミュートの意図を記録する（`Pending`は閉包が持つ）。
fn shortcut_interrupt(
    action: &Action,
    conditions: Option<&Arc<crate::audio::conditions::Conditions>>,
) -> Option<crate::audio::conditions::Pending> {
    conditions
        .filter(|_| is_mute_action(action))
        .map(crate::audio::conditions::Conditions::interrupt_restore)
}

pub(crate) type Notifier = Arc<dyn Fn(ShortcutError) + Send + Sync>;
pub(crate) type Spawner = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

fn shortcut_notice(error: &anyhow::Error) -> Option<ShortcutError> {
    if let Some(control) = error.downcast_ref::<ControlError>() {
        return control_notice(*control);
    }
    Some(
        error
            .downcast_ref::<ShortcutError>()
            .cloned()
            .unwrap_or_else(|| ShortcutError::ActionFailed {
                detail: error.to_string(),
            }),
    )
}

/// 受付の断りの通知。停止が先に行われた断りは、利用者の意図に合うので何も出さない。
fn control_notice(error: ControlError) -> Option<ShortcutError> {
    match error {
        ControlError::StoppedFirst => None,
        ControlError::Busy | ControlError::Expired => Some(ShortcutError::ActionFailed {
            detail: error.to_string(),
        }),
        ControlError::Poisoned | ControlError::Stopped | ControlError::Reentrant => {
            Some(ShortcutError::AudioStateUnavailable)
        }
    }
}

/// OS のコールバックの上では`emit`を呼ばない（Tauri の`emit`は競合すると止まる）。通知は別のスレッドへ渡す。
/// ランタイムが終わった後の`spawn_blocking`の panic はコールバックへ抜けさせず、通知を諦める。
pub(crate) fn notify_shortcut_error_off_callback(
    spawn: &Spawner,
    notify: Notifier,
    error: ShortcutError,
) {
    let job: Box<dyn FnOnce() + Send> = Box::new(move || notify(error));
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| spawn(job))).is_err() {
        log::warn!("ショートカットのエラー通知を出せませんでした");
    }
}

/// ショートカットの本体を実行のスレッドへ積んで、待たずに戻る。積めない・実行できないときは、
/// コールバックの外で`AudioStateUnavailable`を通知する。
pub(crate) fn post_shortcut_work(
    control: &crate::audio::AudioControl,
    action: &Action,
    conditions: Option<&Arc<crate::audio::conditions::Conditions>>,
    notify: Notifier,
    spawn: Spawner,
    work: impl FnOnce(&mut crate::audio::AudioHost) -> anyhow::Result<()> + Send + 'static,
) {
    let entry = shortcut_entry(action);
    let interrupt = shortcut_interrupt(action, conditions);
    let (closure_notify, closure_spawn) = (notify.clone(), spawn.clone());
    let posted = control.post(entry, move |host| match host {
        Ok(host) => {
            let _interrupt = interrupt;
            if let Err(error) = work(host) {
                if let Some(notice) = shortcut_notice(&error) {
                    closure_notify(notice);
                }
            }
        }
        Err(error) => {
            if let Some(notice) = control_notice(error) {
                notify_shortcut_error_off_callback(&closure_spawn, closure_notify, notice);
            }
        }
    });
    if let Err(error) = posted {
        if let Some(notice) = control_notice(error) {
            notify_shortcut_error_off_callback(&spawn, notify, notice);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn busy_capture_gate_drops_dispatch_without_running_callback() {
        let gate = Mutex::new(CaptureGate::default());
        let guard = gate.lock().unwrap();
        let mut dispatched = false;
        assert_eq!(
            try_dispatch_gate(&gate, |_| {
                dispatched = true;
                1
            }),
            None
        );
        assert!(!dispatched);
        drop(guard);
        assert_eq!(
            try_dispatch_gate(&gate, |_| {
                dispatched = true;
                1
            }),
            Some(1)
        );
        assert!(dispatched);
    }
    #[test]
    fn capture_gate_expires_and_ignores_old_tokens() {
        let now = Instant::now();
        let mut gate = CaptureGate::default();
        assert!(gate.permits(0, now));
        let first = gate.begin(now);
        assert!(!gate.permits(0, now));
        assert!(!gate.permits(1, now));
        assert_eq!(gate.token(now), Some(first.clone()));
        let second = gate.begin(now);
        gate.end(&first);
        assert_eq!(gate.token(now), Some(second.clone()));
        assert_eq!(gate.token(now + Duration::from_secs(30)), None);
        assert!(gate.permits(2, now + Duration::from_secs(30)));
        let third = gate.begin(now);
        gate.end(&third);
        assert_eq!(gate.token(now), None);
        assert_ne!(first, second);
    }
    #[test]
    fn validation_errors_keep_reason_codes_instead_of_display_text() {
        let mut bindings = defaults();
        bindings[1].shortcut = "Unknown+KeyP".into();
        assert_eq!(
            validate(&bindings).unwrap_err(),
            ShortcutError::InvalidShortcut {
                shortcut: "Unknown+KeyP".into()
            }
        );
        bindings[1].shortcut = "KeyP".into();
        assert_eq!(
            validate(&bindings).unwrap_err(),
            ShortcutError::ModifierRequired
        );
        bindings[1].shortcut = bindings[0].shortcut.clone();
        assert_eq!(
            validate(&bindings).unwrap_err(),
            ShortcutError::DuplicateBinding
        );
        assert_eq!(
            validate(&vec![bindings[0].clone(); 9]).unwrap_err(),
            ShortcutError::TooManyBindings
        );
    }

    #[test]
    fn ipc_status_and_rejections_keep_codes_keys_and_external_details_separate() {
        let status = Status {
            bindings: defaults(),
            errors: vec![ShortcutError::RegisterFailed {
                shortcut: "Alt+KeyM".into(),
                detail: "OS 1409: 予約済み".into(),
            }],
        };
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(
            json["errors"][0],
            serde_json::json!({"code": "registerFailed", "shortcut": "Alt+KeyM", "detail": "OS 1409: 予約済み"})
        );
        let cases = [
            (ShortcutError::TooManyBindings, "tooManyBindings"),
            (
                ShortcutError::InvalidShortcut {
                    shortcut: "Alt+KeyM".into(),
                },
                "invalidShortcut",
            ),
            (ShortcutError::ModifierRequired, "modifierRequired"),
            (ShortcutError::DuplicateBinding, "duplicateBinding"),
            (ShortcutError::StateUnavailable, "stateUnavailable"),
            (
                ShortcutError::LoadFailed {
                    detail: "raw".into(),
                },
                "loadFailed",
            ),
            (
                ShortcutError::RegistrationConflict {
                    detail: "raw".into(),
                },
                "registrationConflict",
            ),
            (
                ShortcutError::SaveFailed {
                    detail: "raw".into(),
                },
                "saveFailed",
            ),
            (
                ShortcutError::UnregisterFailed {
                    detail: "raw".into(),
                },
                "unregisterFailed",
            ),
            (
                ShortcutError::OperationFailed {
                    detail: "raw".into(),
                },
                "operationFailed",
            ),
            (
                ShortcutError::AudioStateUnavailable,
                "audioStateUnavailable",
            ),
            (ShortcutError::GainPending, "gainPending"),
            (
                ShortcutError::ActionFailed {
                    detail: "raw".into(),
                },
                "actionFailed",
            ),
        ];
        for (error, code) in cases {
            assert_eq!(serde_json::to_value(error).unwrap()["code"], code);
        }
    }

    #[test]
    fn live_modes_hotkeys_are_explicit_not_auto_registered_and_keep_eight_binding_limit() {
        assert!(defaults()
            .iter()
            .all(|binding| !matches!(binding.action, Action::SingingOn | Action::TalkOn)));
        let bindings = vec![
            Binding {
                action: Action::SingingOn,
                shortcut: "Alt+KeyS".into(),
            },
            Binding {
                action: Action::TalkOn,
                shortcut: "Alt+KeyT".into(),
            },
        ];
        assert!(validate(&bindings).is_ok());
        let json = serde_json::to_string(&bindings).unwrap();
        assert!(json.contains("singingOn") && json.contains("talkOn"));
        let old: Vec<Binding> =
            serde_json::from_str(r#"[{"action":"muteToggle","shortcut":"Alt+KeyM"}]"#).unwrap();
        assert!(validate(&old).is_ok());
        assert!(validate(&vec![bindings[0].clone(); 9]).is_err());
    }

    #[test]
    fn noise_toggle_is_explicit_and_only_flips_enabled_keeping_mode_strength_and_voice_guard() {
        assert!(defaults()
            .iter()
            .all(|binding| binding.action != Action::NoiseToggle));
        let old: Vec<Binding> =
            serde_json::from_str(r#"[{"action":"noiseToggle","shortcut":"Alt+KeyN"}]"#).unwrap();
        assert!(validate(&old).is_ok());
        let mut full: Vec<Binding> = [
            Action::MuteToggle,
            Action::BypassToggle,
            Action::GainUp,
            Action::GainDown,
            Action::SingingOn,
            Action::TalkOn,
            Action::MuteOn,
            Action::NoiseToggle,
        ]
        .into_iter()
        .enumerate()
        .map(|(index, action)| Binding {
            action,
            shortcut: format!("Alt+F{}", index + 1),
        })
        .collect();
        assert!(validate(&full).is_ok());
        full.push(Binding {
            action: Action::MuteOff,
            shortcut: "Alt+F9".into(),
        });
        assert_eq!(validate(&full).unwrap_err(), ShortcutError::TooManyBindings);

        let stats = crate::audio::EngineRuntimeStats {
            noise_reduction_enabled: true,
            noise_reduction_mode: "venue".into(),
            noise_control_strength: 1.1,
            noise_voice_guard: false,
            ..Default::default()
        };
        let off = noise_toggle(&stats);
        assert_eq!(
            off,
            NoiseToggle {
                enabled: false,
                mode: "venue".into(),
                strength: 1.1,
                voice_guard: false,
            }
        );
        let on = noise_toggle(&crate::audio::EngineRuntimeStats {
            noise_reduction_enabled: false,
            noise_voice_guard: true,
            ..Default::default()
        });
        assert_eq!(
            serde_json::to_value(on).unwrap(),
            serde_json::json!({"enabled": true, "mode": "low", "strength": 0.8f32, "voiceGuard": true})
        );
    }

    #[test]
    fn stopped_compare_shortcuts_are_not_sent_and_running_ones_are() {
        for action in [Action::BypassToggle, Action::BypassOn, Action::BypassOff] {
            assert_eq!(compare_shortcut_bypass(false, &action, false), None);
            assert_eq!(compare_shortcut_bypass(false, &action, true), None);
        }
        assert_eq!(
            compare_shortcut_bypass(true, &Action::BypassOn, false),
            Some(true)
        );
        assert_eq!(
            compare_shortcut_bypass(true, &Action::BypassOff, true),
            Some(false)
        );
        assert_eq!(
            compare_shortcut_bypass(true, &Action::BypassToggle, false),
            Some(true)
        );
        assert_eq!(
            compare_shortcut_bypass(true, &Action::BypassToggle, true),
            Some(false)
        );
        // 緊急ミュートなど、比較以外はここでは送らない。
        assert_eq!(
            compare_shortcut_bypass(true, &Action::MuteToggle, false),
            None
        );
    }

    #[test]
    fn shortcut_audio_running_matches_the_screen_not_the_resident_process() {
        assert!(shortcut_audio_running(true, true, true, false));
        // 停止後もプロセスと設定は残る。実ストリームが止まっていれば比較は送らない。
        assert!(!shortcut_audio_running(true, true, false, false));
        assert!(!shortcut_audio_running(true, true, true, true));
        assert!(!shortcut_audio_running(true, true, false, true));
        assert!(!shortcut_audio_running(true, false, true, false));
        assert!(!shortcut_audio_running(false, true, true, false));
        assert!(!shortcut_audio_running(false, false, false, false));
    }

    #[test]
    fn duplicates_plain_keys_and_invalid_shortcuts_do_not_register() {
        assert!(validate(&defaults()).is_ok());
        let mut b = defaults();
        b[1].shortcut = b[0].shortcut.clone();
        assert!(validate(&b).is_err());
        b[1].shortcut = "KeyP".into();
        assert!(validate(&b).is_err());
        b[1].shortcut = "Unknown+KeyP".into();
        assert!(validate(&b).is_err());
        b = defaults();
        b[1].action = Action::MuteToggle;
        assert!(validate(&b).is_err());
    }

    fn notice_log() -> (
        Notifier,
        Arc<Mutex<Vec<ShortcutError>>>,
        std::sync::mpsc::Sender<()>,
    ) {
        let log: Arc<Mutex<Vec<ShortcutError>>> = Arc::default();
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let sink = log.clone();
        let notify: Notifier = Arc::new(move |notice| {
            let _ = gate.lock().unwrap().recv_timeout(Duration::from_secs(10));
            sink.lock().unwrap().push(notice);
        });
        (notify, log, release)
    }

    fn thread_spawner() -> Spawner {
        Arc::new(|job| {
            std::thread::spawn(job);
        })
    }

    fn control() -> crate::audio::AudioControl {
        crate::audio::AudioControl::new(crate::audio::AudioHost::new(
            std::env::temp_dir().join(format!("auralyn-shortcut-{}", std::process::id())),
        ))
    }

    fn returns_within_the_gate(what: &str, f: impl FnOnce() + Send + 'static) {
        let (done, wait) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            f();
            let _ = done.send(());
        });
        wait.recv_timeout(Duration::from_secs(10))
            .unwrap_or_else(|_| panic!("時間内に戻らなかった: {what}"));
    }

    fn wait_for(log: &Arc<Mutex<Vec<ShortcutError>>>, len: usize) {
        let started = Instant::now();
        while log.lock().unwrap().len() < len {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "通知が出なかった"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    // X11：閉じた列への`post`は、通知の発行が止まっていても、コールバックを塞がない。通知は別のスレッドで1回出る。
    #[test]
    fn x11_a_closed_queue_notifies_off_the_callback_and_never_blocks_it() {
        let control = control();
        control.close_for_test();
        let (notify, log, release) = notice_log();
        let called = Arc::new(AtomicBool::new(false));
        let flag = called.clone();
        let spawn = thread_spawner();
        returns_within_the_gate("post_shortcut_work on a closed queue", move || {
            post_shortcut_work(&control, &Action::GainUp, None, notify, spawn, move |_| {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            });
        });
        assert!(log.lock().unwrap().is_empty(), "通知の発行は止まっている");
        assert!(!called.load(Ordering::SeqCst), "閉じた列では本体を呼ばない");
        release.send(()).unwrap();
        wait_for(&log, 1);
        assert_eq!(*log.lock().unwrap(), [ShortcutError::AudioStateUnavailable]);
    }

    // X11：poison した後も、本体は呼ばれず、`AudioStateUnavailable`が1回だけ出る。実行のスレッドの上では`emit`しない。
    #[test]
    fn x11_a_poisoned_control_maps_to_audio_state_unavailable_off_the_callback() {
        let control = control();
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            control.run(crate::audio::Entry::command("poison"), |_| -> () {
                panic!("poison the audio state")
            })
        }));
        assert!(poisoned.is_err());
        let (notify, log, release) = notice_log();
        release.send(()).unwrap();
        let called = Arc::new(AtomicBool::new(false));
        let flag = called.clone();
        post_shortcut_work(
            &control,
            &Action::GainUp,
            None,
            notify,
            thread_spawner(),
            move |_| {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            },
        );
        wait_for(&log, 1);
        assert_eq!(*log.lock().unwrap(), [ShortcutError::AudioStateUnavailable]);
        assert!(!called.load(Ordering::SeqCst));
    }

    // X11：`spawn_blocking`が使えないとき（ランタイムの終了後）も、コールバックへ panic を抜けさせない。
    #[test]
    fn x11_a_failing_spawner_never_panics_into_the_callback() {
        let control = control();
        control.close_for_test();
        let (notify, log, _release) = notice_log();
        let spawn: Spawner = Arc::new(|_| panic!("the runtime is gone"));
        post_shortcut_work(&control, &Action::GainUp, None, notify, spawn, |_| Ok(()));
        assert!(log.lock().unwrap().is_empty());
    }

    // 本体の失敗は、実行のスレッドの上で今と同じ文言の通知になる。`ShortcutError`はそのまま、それ以外は`ActionFailed`。
    #[test]
    fn a_failing_body_is_reported_with_the_same_notices() {
        let control = control();
        let (notify, log, release) = notice_log();
        release.send(()).unwrap();
        release.send(()).unwrap();
        post_shortcut_work(
            &control,
            &Action::GainUp,
            None,
            notify.clone(),
            thread_spawner(),
            |_| Err(ShortcutError::GainPending.into()),
        );
        post_shortcut_work(
            &control,
            &Action::GainUp,
            None,
            notify,
            thread_spawner(),
            |_| Err(anyhow::anyhow!("detail")),
        );
        wait_for(&log, 2);
        assert_eq!(
            *log.lock().unwrap(),
            [
                ShortcutError::GainPending,
                ShortcutError::ActionFailed {
                    detail: "detail".into()
                }
            ]
        );
    }

    /// 実行のスレッドを、数えず断られない仕事の閉包の中で止める。送ると（または落とすと）進む。
    fn blocked_control() -> (crate::audio::AudioControl, std::sync::mpsc::Sender<()>) {
        let control = control();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        control
            .post(
                crate::audio::Entry::command("end_live_changes"),
                move |_| {
                    let _ = entered_tx.send(());
                    let _ = release_rx.recv_timeout(Duration::from_secs(10));
                },
            )
            .unwrap();
        entered_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("実行のスレッドが止まらなかった");
        (control, release_tx)
    }

    fn wait_pending(conditions: &crate::audio::conditions::Conditions, expected: u64) {
        let started = Instant::now();
        while conditions.pending_count() != expected {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "Pending の数が {expected} にならなかった: {}",
                conditions.pending_count()
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    // Y13（ショートカット）：ミュートの3動作だけが、待つ前に`interrupt_restore`の`Pending`を取る。
    // `Pending`は、閉包が終わる・受付に失敗する・断られる・早く戻る、のどの経路でも落ちる。
    #[test]
    fn y13_only_the_mute_shortcuts_take_the_interrupt_pending_and_always_release_it() {
        use crate::audio::conditions::Conditions;
        let conditions = Arc::new(Conditions::default());
        for (action, mute) in [
            (Action::MuteToggle, true),
            (Action::MuteOn, true),
            (Action::MuteOff, true),
            (Action::BypassToggle, false),
            (Action::BypassOn, false),
            (Action::BypassOff, false),
            (Action::GainUp, false),
            (Action::GainDown, false),
            (Action::SingingOn, false),
            (Action::TalkOn, false),
            (Action::NoiseToggle, false),
        ] {
            let pending = shortcut_interrupt(&action, Some(&conditions));
            assert_eq!(pending.is_some(), mute, "{action:?}");
            assert_eq!(conditions.pending_count(), u64::from(mute));
            drop(pending);
            assert_eq!(conditions.pending_count(), 0);
            assert_eq!(
                shortcut_entry(&action).name,
                if mute {
                    "global_shortcut_mute"
                } else {
                    "global_shortcut"
                }
            );
        }
        assert!(shortcut_interrupt(&Action::MuteOn, None).is_none());

        let (control, release) = blocked_control();
        let (notify, log, _gate) = notice_log();
        let posting = control.clone();
        let spawn = thread_spawner();
        let posted_conditions = conditions.clone();
        returns_within_the_gate("the mute shortcut while the actor is blocked", move || {
            post_shortcut_work(
                &posting,
                &Action::MuteOn,
                Some(&posted_conditions),
                notify,
                spawn,
                |_| Ok(()),
            );
        });
        assert_eq!(conditions.pending_count(), 1, "待つ前に取る");
        assert!(conditions.control_snapshot().is_err());
        release.send(()).unwrap();
        wait_pending(&conditions, 0);
        assert!(conditions.control_snapshot().is_ok());

        let called = Arc::new(AtomicBool::new(false));
        for early in [false, true] {
            let (control, release) = blocked_control();
            let flag = called.clone();
            let (notify, _log, gate) = notice_log();
            gate.send(()).unwrap();
            post_shortcut_work(
                &control,
                &Action::MuteToggle,
                Some(&conditions),
                notify,
                thread_spawner(),
                move |_| {
                    flag.store(true, Ordering::SeqCst);
                    if early {
                        return Ok(());
                    }
                    Err(anyhow::anyhow!("failed"))
                },
            );
            assert_eq!(conditions.pending_count(), 1);
            release.send(()).unwrap();
            wait_pending(&conditions, 0);
        }

        let closed = self::control();
        closed.close_for_test();
        let (notify, _log, _gate) = notice_log();
        post_shortcut_work(
            &closed,
            &Action::MuteOff,
            Some(&conditions),
            notify,
            thread_spawner(),
            |_| Ok(()),
        );
        assert_eq!(conditions.pending_count(), 0, "受付に失敗したときも落ちる");
        assert!(log.lock().unwrap().is_empty());
    }

    // Y20：ショートカットの断りの通知。停止が先に行われた断りは黙って捨て、混雑・期限切れは`ActionFailed`の`detail`へ新しい文言、
    // 止まった・poison は今の`AudioStateUnavailable`。トレイは、どれも黙って捨てる。
    #[test]
    fn y20_shortcut_refusals_map_silently_or_to_action_failed() {
        use crate::audio::control::{BUSY_TEXT, EXPIRED_TEXT};
        assert_eq!(control_notice(ControlError::StoppedFirst), None);
        assert_eq!(
            control_notice(ControlError::Busy),
            Some(ShortcutError::ActionFailed {
                detail: BUSY_TEXT.into()
            })
        );
        assert_eq!(
            control_notice(ControlError::Expired),
            Some(ShortcutError::ActionFailed {
                detail: EXPIRED_TEXT.into()
            })
        );
        for error in [
            ControlError::Stopped,
            ControlError::Poisoned,
            ControlError::Reentrant,
        ] {
            assert_eq!(
                control_notice(error),
                Some(ShortcutError::AudioStateUnavailable)
            );
        }
        assert_eq!(
            shortcut_notice(&anyhow::Error::from(ControlError::StoppedFirst)),
            None,
            "本体の中から出た停止が先の断りも、黙って捨てる"
        );
        for error in [
            ControlError::StoppedFirst,
            ControlError::Busy,
            ControlError::Expired,
            ControlError::Stopped,
            ControlError::Poisoned,
        ] {
            crate::audio::tray_mute_toggle(Err(error));
        }

        // 停止より前に受け付けたショートカットは、本体を呼ばず、何も通知しない。
        let (control, release) = blocked_control();
        let (notify, log, _gate) = notice_log();
        let called = Arc::new(AtomicBool::new(false));
        let flag = called.clone();
        post_shortcut_work(
            &control,
            &Action::GainUp,
            None,
            notify,
            thread_spawner(),
            move |_| {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            },
        );
        control
            .post(crate::audio::Entry::command("stop_audio"), |_| ())
            .unwrap();
        release.send(()).unwrap();
        control
            .run(crate::audio::Entry::command("get_audio_state"), |_| ())
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(!called.load(Ordering::SeqCst));
        assert!(
            log.lock().unwrap().is_empty(),
            "停止が先の断りは何も出さない"
        );

        // 満杯：受付で断られ、新しい文言を`ActionFailed`で出す。
        let (control, release) = blocked_control();
        control.set_limits(
            1,
            Duration::from_secs(3600),
            Duration::from_secs(3600),
            Duration::from_secs(3600),
        );
        control
            .post(crate::audio::Entry::command("get_audio_state"), |_| ())
            .unwrap();
        let (notify, log, gate) = notice_log();
        gate.send(()).unwrap();
        post_shortcut_work(
            &control,
            &Action::GainUp,
            None,
            notify,
            thread_spawner(),
            |_| Ok(()),
        );
        wait_for(&log, 1);
        assert_eq!(
            *log.lock().unwrap(),
            [ShortcutError::ActionFailed {
                detail: BUSY_TEXT.into()
            }]
        );
        release.send(()).unwrap();

        // 受付から期限を過ぎた：取り出す時に断られ、新しい文言を出す。
        let (control, release) = blocked_control();
        control.set_limits(
            256,
            Duration::from_millis(50),
            Duration::from_secs(3600),
            Duration::from_secs(3600),
        );
        let (notify, log, gate) = notice_log();
        gate.send(()).unwrap();
        post_shortcut_work(
            &control,
            &Action::GainUp,
            None,
            notify,
            thread_spawner(),
            |_| Ok(()),
        );
        std::thread::sleep(Duration::from_millis(150));
        release.send(()).unwrap();
        wait_for(&log, 1);
        assert_eq!(
            *log.lock().unwrap(),
            [ShortcutError::ActionFailed {
                detail: EXPIRED_TEXT.into()
            }]
        );
    }
}
