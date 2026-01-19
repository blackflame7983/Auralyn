use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path};

#[derive(Debug, Serialize, Deserialize)]
pub struct PresetPlugin {
    pub path: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub enabled: bool,
    pub muted: bool,
    pub gain: f32,
    pub state: Option<String>, // Base64
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub plugins: Vec<PresetPlugin>,
}

pub fn save_preset(config_dir: &Path, name: &str, preset: &Preset) -> Result<(), String> {
    let presets_dir = config_dir.join("presets");
    if !presets_dir.exists() {
        fs::create_dir_all(&presets_dir).map_err(|e| e.to_string())?;
    }

    let file_path = presets_dir.join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(preset).map_err(|e| e.to_string())?;
    fs::write(file_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_presets(config_dir: &Path) -> Result<Vec<String>, String> {
    let presets_dir = config_dir.join("presets");
    if !presets_dir.exists() {
        return Ok(Vec::new());
    }

    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(presets_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |ext| ext == "json") {
                if let Some(stem) = path.file_stem() {
                    names.push(stem.to_string_lossy().to_string());
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

pub fn load_preset(config_dir: &Path, name: &str) -> Result<Preset, String> {
    let file_path = config_dir.join("presets").join(format!("{}.json", name));
    if !file_path.exists() {
        return Err(format!("Preset not found: {}", name));
    }
    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let preset: Preset = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(preset)
}

pub fn delete_preset(config_dir: &Path, name: &str) -> Result<(), String> {
    let file_path = config_dir.join("presets").join(format!("{}.json", name));
    if file_path.exists() {
        fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
