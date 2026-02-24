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
        log::debug!(
            "Setting active input device: {} ({})",
            info.name, info.host
        );
        self.active_input = Some(info);
    }

    /// Set the currently active output device info (called when audio starts)
    pub fn set_active_output(&mut self, info: DeviceInfo) {
        log::debug!(
            "Setting active output device: {} ({})",
            info.name, info.host
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

        let output = Command::new(&exe_path)
            .arg("--scan")
            .output()
            .context("Failed to spawn scanner process")?;

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

    // Extracted from core.rs start_audio_impl
    #[allow(deprecated)]
    pub fn resolve_input_device(host: &cpal::Host, target_name: &str) -> Option<cpal::Device> {
        log::debug!("resolve_input_device target='{}'", target_name);

        let mut name_counts = HashMap::new();
        if let Ok(devs) = host.input_devices() {
            for d in devs {
                if let Ok(n) = d.name() {
                    *name_counts.entry(n).or_insert(0) += 1;
                }
            }
        }

        if let Ok(devs) = host.input_devices() {
            let mut current_counts = HashMap::new();
            for d in devs {
                if let Ok(n) = d.name() {
                    let total = *name_counts.get(&n).unwrap_or(&0);
                    let candidate_base = if total > 1 {
                        let idx = current_counts.entry(n.clone()).or_insert(0);
                        *idx += 1;
                        format!("{} ({})", n, idx)
                    } else {
                        n
                    };

                    log::debug!("Checking candidate: '{}'", candidate_base);

                    // Exact or Prefix Match "name [driverspecific]"
                    if target_name == candidate_base
                        || target_name.starts_with(&format!("{} [", candidate_base))
                    {
                        log::info!(
                            "Found Input Device: '{}' (Matched '{}')",
                            candidate_base, target_name
                        );
                        return Some(d);
                    }
                }
            }
        } else {
            log::debug!("host.input_devices() failed or empty");
        }
        log::warn!("Failed to resolve input device '{}'", target_name);
        None
    }

    #[allow(deprecated)]
    pub fn resolve_output_device(host: &cpal::Host, target_name: &str) -> Option<cpal::Device> {
        log::debug!("resolve_output_device target='{}'", target_name);

        let mut name_counts = HashMap::new();
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                if let Ok(n) = d.name() {
                    *name_counts.entry(n).or_insert(0) += 1;
                }
            }
        }

        if let Ok(devs) = host.output_devices() {
            let mut current_counts = HashMap::new();
            for d in devs {
                if let Ok(n) = d.name() {
                    let total = *name_counts.get(&n).unwrap_or(&0);
                    let candidate_base = if total > 1 {
                        let idx = current_counts.entry(n.clone()).or_insert(0);
                        *idx += 1;
                        format!("{} ({})", n, idx)
                    } else {
                        n
                    };

                    log::debug!("Checking candidate: '{}'", candidate_base);

                    if target_name == candidate_base
                        || target_name.starts_with(&format!("{} [", candidate_base))
                    {
                        log::info!(
                            "Found Output Device: '{}' (Matched '{}')",
                            candidate_base, target_name
                        );
                        return Some(d);
                    }
                }
            }
        } else {
            log::debug!("host.output_devices() failed or empty");
        }
        log::warn!("Failed to resolve output device '{}'", target_name);
        None
    }
}
