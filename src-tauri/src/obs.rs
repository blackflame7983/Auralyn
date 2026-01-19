use obws::Client;
use tauri::{AppHandle, Emitter};
use serde::Serialize;
use tokio::sync::Mutex;
use futures_util::StreamExt;

pub struct ObsState {
    pub client: Mutex<Option<Client>>,
}

impl ObsState {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct ObsSceneChangedEvent {
    pub scene_name: String,
}

pub async fn connect_obs(
    app: AppHandle,
    state: tauri::State<'_, ObsState>,
    host: String,
    port: u16,
    password: Option<String>,
) -> Result<(), String> {
    let client = Client::connect(&host, port, password)
        .await
        .map_err(|e| format!("Failed to connect to OBS: {}", e))?;

    let events = client.events().map_err(|e| e.to_string())?;
    
    *state.client.lock().await = Some(client);
    
    log::info!("Connected to OBS at {}:{}", host, port);

    // Spawn event listener
    tauri::async_runtime::spawn(async move {
        tokio::pin!(events);
        while let Some(event) = events.next().await {
            match event {
                obws::events::Event::CurrentProgramSceneChanged { name, .. } => {
                    log::info!("OBS Scene Changed: {}", name);
                    let _ = app.emit("obs://scene-changed", ObsSceneChangedEvent {
                        scene_name: name,
                    });
                }
                _ => {}
            }
        }
        log::info!("OBS Event Loop Ended");
    });

    Ok(())
}

pub async fn disconnect_obs(state: tauri::State<'_, ObsState>) -> Result<(), String> {
    *state.client.lock().await = None;
    Ok(())
}
