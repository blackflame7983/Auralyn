use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Blacklist {
    pub paths: HashSet<String>,
    #[serde(skip)]
    file_path: PathBuf,
}

impl Blacklist {
    pub fn new(config_dir: &PathBuf) -> Self {
        let file_path = config_dir.join("vst_blacklist.json");
        let mut list = if file_path.exists() {
            match fs::read_to_string(&file_path) {
                Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
                    log::error!("Failed to parse blacklist: {}", e);
                    Blacklist::default()
                }),
                Err(e) => {
                    log::error!("Failed to read blacklist: {}", e);
                    Blacklist::default()
                }
            }
        } else {
            Blacklist::default()
        };
        list.file_path = file_path;
        list
    }

    pub fn save(&self) {
        match serde_json::to_string_pretty(self) {
            Ok(s) => {
                if let Err(e) = fs::write(&self.file_path, s) {
                    log::error!("Failed to save blacklist: {}", e);
                }
            }
            Err(e) => log::error!("Failed to serialize blacklist: {}", e),
        }
    }

    pub fn add(&mut self, path: &str) {
        if self.paths.insert(path.to_string()) {
            log::warn!("Blacklisting plugin: {}", path);
            self.save();
        }
    }

    pub fn remove(&mut self, path: &str) {
        if self.paths.remove(path) {
            log::info!("Removing plugin from blacklist: {}", path);
            self.save();
        }
    }

    pub fn contains(&self, path: &str) -> bool {
        self.paths.contains(path)
    }

    pub fn clear(&mut self) {
        self.paths.clear();
        self.save();
        log::info!("Blacklist cleared.");
    }
}
