use anyhow::{Result, Context};
use winreg::enums::*;
use winreg::RegKey;
use serde::Serialize;
use std::env;

const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APP_VALUE_NAME: &str = "VSTHost";

#[derive(Debug, Serialize)]
pub struct AutostartStatus {
    pub enabled: bool,
    pub method: String,
    pub command: Option<String>,
}

pub fn get_autostart_status() -> Result<AutostartStatus> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = hkcu.open_subkey(RUN_KEY_PATH)
        .context("Failed to open HKCU Run key")?;

    let command: Result<String, _> = run_key.get_value(APP_VALUE_NAME);

    match command {
        Ok(cmd) => Ok(AutostartStatus {
            enabled: true,
            method: "registry".to_string(),
            command: Some(cmd),
        }),
        Err(_) => Ok(AutostartStatus {
            enabled: false,
            method: "registry".to_string(),
            command: None,
        }),
    }
}

pub fn set_autostart_enabled(enabled: bool) -> Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // Open with write permission
    let (run_key, _) = hkcu.create_subkey(RUN_KEY_PATH)
        .context("Failed to open HKCU Run key for writing")?;

    if enabled {
        let exe_path = env::current_exe()?;
        let exe_str = exe_path.to_string_lossy();
        
        // Ensure path is quoted to handle spaces
        let command = format!("\"{}\" --autostart", exe_str);
        
        run_key.set_value(APP_VALUE_NAME, &command)
            .context("Failed to set autostart registry value")
    } else {
        match run_key.delete_value(APP_VALUE_NAME) {
            Ok(_) => Ok(()),
            Err(e) => {
                // If it doesn't exist, that's fine (already disabled)
                if e.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(anyhow::anyhow!("Failed to delete registry value: {}", e))
                }
            }
        }
    }
}
