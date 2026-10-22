use crate::ipc::DeviceInfo;
use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use log;
use std::collections::HashMap;
use std::process::Command;

pub struct DeviceManager {
    pub cached_devices: Vec<DeviceInfo>,
    /// Currently active input device (set when audio starts)
    pub active_input: Option<DeviceInfo>,
    /// Currently active output device (set when audio starts)
    pub active_output: Option<DeviceInfo>,
}

impl Default for DeviceManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceManager {
    pub fn new() -> Self {
        Self {
            cached_devices: Vec::new(),
            active_input: None,
            active_output: None,
        }
    }

    /// Set the currently active input device info (called when audio starts)
    pub fn set_active_input(&mut self, info: DeviceInfo) {
        log::debug!("Setting active input device: {} ({})", info.name, info.host);
        self.active_input = Some(info);
    }

    /// Set the currently active output device info (called when audio starts)
    pub fn set_active_output(&mut self, info: DeviceInfo) {
        log::debug!(
            "Setting active output device: {} ({})",
            info.name,
            info.host
        );
        self.active_output = Some(info);
    }

    /// Clear active device info (called when audio stops)
    pub fn clear_active_devices(&mut self) {
        self.active_input = None;
        self.active_output = None;
    }

    pub fn enumerate(&mut self) -> Result<Vec<DeviceInfo>> {
        log::debug!("Starting OOP Device Enumeration...");
        let exe_path = std::env::current_exe().unwrap_or_else(|_| "audio_engine.exe".into());

        let output = crate::child_process::run(
            Command::new(&exe_path).arg("--scan"),
            std::time::Duration::from_secs(30),
        )
        .context("Device scanner did not complete")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!("Scanner failed: {}", stderr));
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() {
            log::debug!("[Scanner Stderr]:\n{}", stderr);
        }

        let json = String::from_utf8_lossy(&output.stdout);
        let mut dev_list: Vec<DeviceInfo> =
            serde_json::from_str(&json).context(format!("Scanner JSON error. Output: {}", json))?;

        log::debug!("OOP Scan found {} devices.", dev_list.len());
        for d in &dev_list {
            log::debug!(
                "  - [{}] {} ({})",
                d.host,
                d.name,
                if d.is_input { "In" } else { "Out" }
            );
        }

        // Merge active devices if they are missing from OOP scan results
        // This handles the case where ASIO drivers are exclusively locked by this process
        if let Some(active_in) = &self.active_input {
            if !dev_list
                .iter()
                .any(|d| d.name == active_in.name && d.host == active_in.host && d.is_input)
            {
                log::debug!(
                    "Merging active input device into scan results: {}",
                    active_in.name
                );
                dev_list.push(active_in.clone());
            }
        }
        if let Some(active_out) = &self.active_output {
            if !dev_list
                .iter()
                .any(|d| d.name == active_out.name && d.host == active_out.host && !d.is_input)
            {
                log::debug!(
                    "Merging active output device into scan results: {}",
                    active_out.name
                );
                dev_list.push(active_out.clone());
            }
        }

        self.cached_devices = dev_list.clone();
        Ok(dev_list)
    }

    #[allow(deprecated)]
    pub fn resolve_input_device(host: &cpal::Host, target_name: &str) -> Option<cpal::Device> {
        let devices = host.input_devices().ok()?;
        resolve_named_device(
            devices.filter_map(|device| device.name().ok().map(|name| (device, name))),
            target_name,
        )
    }

    #[allow(deprecated)]
    pub fn resolve_output_device(host: &cpal::Host, target_name: &str) -> Option<cpal::Device> {
        let devices = host.output_devices().ok()?;
        resolve_named_device(
            devices.filter_map(|device| device.name().ok().map(|name| (device, name))),
            target_name,
        )
    }
}

// 一度の列挙結果から連番を付け、完全一致を優先する。曖昧な接頭辞一致では選ばない。
fn resolve_named_device<T>(devices: impl Iterator<Item = (T, String)>, target: &str) -> Option<T> {
    let devices: Vec<_> = devices.collect();
    let mut counts = HashMap::new();
    for (_, name) in &devices {
        *counts.entry(name.clone()).or_insert(0_usize) += 1;
    }
    let mut indices = HashMap::new();
    let mut fallback = None;
    let mut ambiguous = false;
    let mut exact = None;
    let mut ambiguous_exact = false;
    for (device, name) in devices {
        let candidate = if counts[&name] > 1 {
            let index = indices.entry(name.clone()).or_insert(0_usize);
            *index += 1;
            format!("{} ({})", name, index)
        } else {
            name
        };
        if target == candidate {
            ambiguous_exact |= exact.is_some();
            exact = Some(device);
        } else if target.starts_with(&format!("{} [", candidate)) {
            ambiguous |= fallback.is_some();
            fallback = Some(device);
        }
    }
    if ambiguous_exact {
        None
    } else if exact.is_some() {
        exact
    } else if ambiguous {
        None
    } else {
        fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn select(names: &[&str], target: &str) -> Option<usize> {
        resolve_named_device(
            names
                .iter()
                .enumerate()
                .map(|(index, name)| (index, (*name).into())),
            target,
        )
    }
    #[test]
    fn resolves_duplicate_indices_and_rate_suffix_from_one_snapshot() {
        assert_eq!(select(&["Mic", "Mic", "Out"], "Mic (2) [48kHz]"), Some(1));
        assert_eq!(select(&["Mic", "Mic"], "Mic"), None);
        assert_eq!(select(&["Mic"], "Mic [44.1kHz, 48kHz]"), Some(0));
        assert_eq!(select(&["Mic"], "Microphone"), None);
    }
    #[test]
    fn exact_name_wins_over_a_prefix_and_ambiguous_prefix_is_rejected() {
        assert_eq!(select(&["Mic", "Mic [USB]"], "Mic [USB]"), Some(1));
        assert_eq!(select(&["Mic", "Mic [USB]"], "Mic [USB] [48kHz]"), None);
        assert_eq!(select(&["Mic", "Mic (1)", "Mic"], "Mic (1)"), None);
    }
}
