use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, Result};
use log;

use crate::vst_host::instance::{VstInstance, VstProcessor};

pub const MAX_PLUGINS: usize = 32;

fn burned_library_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::burned_library_key;

    #[test]
    fn burned_library_key_is_stable() {
        let path = r"C:\VST3\Plugin.vst3";
        let key1 = burned_library_key(path);
        let key2 = burned_library_key(path);
        assert_eq!(key1, key2);
    }

    #[cfg(windows)]
    #[test]
    fn burned_library_key_is_case_insensitive_on_windows() {
        let upper = burned_library_key(r"C:\VST3\PLUGIN.VST3");
        let lower = burned_library_key(r"c:\vst3\plugin.vst3");
        assert_eq!(upper, lower);
    }
}

pub struct PluginManager {
    pub plugins: HashMap<String, VstInstance>,
    pub order: Vec<String>,
    pub pending_init: Vec<String>,

    // Stable RT indices (avoid String alloc/free in audio callback)
    rt_index_by_id: HashMap<String, u8>,
    id_by_rt_index: Vec<Option<String>>,

    // Deferred drop (unload) handling: instance stays alive until RT confirms processor retired
    pub pending_drop_by_index: HashMap<u8, VstInstance>,

    // UI State
    pub muted: HashSet<String>,
    pub bypassed: HashSet<String>,
    pub gains: HashMap<String, f32>,

    // Safely burnt libraries to prevent unload crashes
    pub burned_libraries: Vec<std::sync::Arc<libloading::Library>>, // Fully qualified just in case
    burned_library_keys: HashSet<String>,
}

impl PluginManager {
    pub fn new() -> Self {
        Self {
            plugins: HashMap::new(),
            order: Vec::new(),
            pending_init: Vec::new(),
            rt_index_by_id: HashMap::new(),
            id_by_rt_index: vec![None; MAX_PLUGINS],
            pending_drop_by_index: HashMap::new(),
            muted: HashSet::new(),
            bypassed: HashSet::new(),
            gains: HashMap::new(),
            burned_libraries: Vec::new(),
            burned_library_keys: HashSet::new(),
        }
    }

    fn alloc_rt_index(&mut self, id: &str) -> Result<u8> {
        if let Some(idx) = self.rt_index_by_id.get(id).copied() {
            return Ok(idx);
        }

        let Some((index, _)) = self
            .id_by_rt_index
            .iter()
            .enumerate()
            .find(|(_, v)| v.is_none())
        else {
            return Err(anyhow!(
                "Plugin limit reached (MAX_PLUGINS={})",
                MAX_PLUGINS
            ));
        };

        let idx_u8: u8 = index
            .try_into()
            .map_err(|_| anyhow!("Internal error: rt index overflow"))?;
        self.id_by_rt_index[index] = Some(id.to_string());
        self.rt_index_by_id.insert(id.to_string(), idx_u8);
        Ok(idx_u8)
    }

    pub fn rt_index_of(&self, id: &str) -> Option<u8> {
        self.rt_index_by_id.get(id).copied()
    }

    pub fn free_rt_index(&mut self, id: &str) {
        let Some(idx) = self.rt_index_by_id.remove(id) else {
            return;
        };
        let idx_usize = idx as usize;
        if idx_usize < self.id_by_rt_index.len() {
            self.id_by_rt_index[idx_usize] = None;
        }
    }

    pub fn load_plugin(
        &mut self,
        path: &str,
        sample_rate: f64,
        block_size: usize,
        channels: usize,
        engine_running: bool, // If true, we try to prepare processing immediately
    ) -> Result<(String, String, u8, Option<VstProcessor>)> {
        let mut instance = VstInstance::load(path)?;
        let id = instance.id.clone();
        let name = instance.name.clone();
        let rt_index = self.alloc_rt_index(&id)?;

        // Deferred Logic
        if instance.needs_deferred_connection() {
            log::info!("Plugin {} queued for deferred initialization", name);
            self.pending_init.push(id.clone());
            self.plugins.insert(id.clone(), instance);
            self.order.push(id.clone());
            return Ok((id, name, rt_index, None)); // No processor yet
        }

        let mut processor = None;
        if engine_running {
            if let Err(e) =
                instance.prepare_processing(sample_rate, block_size as i32, channels as i32)
            {
                log::warn!("Failed to prepare plugin {} on load: {}", name, e);
            }
            processor = instance.create_processor();
        }

        self.plugins.insert(id.clone(), instance);
        self.order.push(id.clone());

        Ok((id, name, rt_index, processor))
    }

    pub fn remove_plugin(&mut self, id: &str) -> Result<()> {
        if self.plugins.remove(id).is_some() {
            self.order.retain(|x| x != id);
            self.muted.remove(id);
            self.bypassed.remove(id);
            self.gains.remove(id);
            // Pending init remove?
            self.pending_init.retain(|x| x != id);
            self.free_rt_index(id);
            Ok(())
        } else {
            Err(anyhow!("Plugin not found"))
        }
    }

    pub fn begin_unload(&mut self, id: &str) -> Result<u8> {
        let idx = self
            .rt_index_of(id)
            .ok_or_else(|| anyhow!("Plugin not found"))?;
        let instance = self
            .plugins
            .remove(id)
            .ok_or_else(|| anyhow!("Plugin not found"))?;

        // KILL SWITCH: stop audio thread ASAP (actual drop happens after RT retires processor)
        instance
            .active_flag
            .store(false, std::sync::atomic::Ordering::SeqCst);

        self.order.retain(|x| x != id);
        self.pending_init.retain(|x| x != id);
        self.muted.remove(id);
        self.bypassed.remove(id);
        self.gains.remove(id);

        self.pending_drop_by_index.insert(idx, instance);
        Ok(idx)
    }

    pub fn finalize_unload(&mut self, index: u8) {
        if let Some(instance) = self.pending_drop_by_index.remove(&index) {
            // Graveyard strategy v2: PERMANENT RETENTION ("Pinning")
            // Some plugins (Insight 2) crash if their DLL is ever unloaded, due to lingering threads.
            // We clone the Library Arc and keep it forever in `burned_libraries`.
            // Since `LoadLibrary` reuses the module handle for the same path, this doesn't cause
            // memory explosion on repeated load/unload; it just pins the refcount > 0.

            let key = burned_library_key(&instance.path);
            if self.burned_library_keys.insert(key) {
                let library_ref = instance._library.clone();
                self.burned_libraries.push(library_ref);
            }

            // Now drop the instance (releases VST3 interfaces)
            drop(instance);
        }

        let idx_usize = index as usize;
        if idx_usize < self.id_by_rt_index.len() {
            if let Some(id) = self.id_by_rt_index[idx_usize].take() {
                self.rt_index_by_id.remove(&id);
            }
        }
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut VstInstance> {
        self.plugins.get_mut(id)
    }

    pub fn get(&self, id: &str) -> Option<&VstInstance> {
        self.plugins.get(id)
    }

    pub fn exists(&self, id: &str) -> bool {
        self.plugins.contains_key(id)
    }

    // Helper to generate execution list for Audio Thread start
    // Returns (Processors, Initial Gains, Initial Mutes, Bypassed?)
    // Bypassed is stored in VstInstance? No, strictly VstProcessor state?
    // core.rs had `bypassed_plugins` map implies Engine state.
    // Wait, core.rs:837 `bypassed_plugins = HashSet::new()` inside run_loop. It wasn't persisted in Engine struct?
    // Ah, `AudioThreadMessage::SetBypass` updates the RT thread. The UI state might not have been persisted in `Engine` struct?
    // Checking `core.rs`: line ~102 has `muted_plugins` and `plugin_gains` fields. `bypassed` was missing?
    // Core check: `Command::SetBypass` did push message. Did it update local state?
    // `core.rs:406` -> No, it only pushed message. So Bypass state was ephemeral to Audio Thread or managed by Plugin instance?
    // Actually `VstInstance` has `bypass` state?
    // `set_bypass` on instance?
    // If `core.rs` didn't track it, I won't track it here for now to match parity.

    pub fn prepare_for_audio_start(
        &mut self,
        sample_rate: f64,
        channels: usize,
        safe_max_block_size: usize,
    ) -> Vec<(u8, VstProcessor)> {
        let mut processors = Vec::new();

        for id in &self.order {
            if self.pending_init.contains(id) {
                continue;
            }
            if let Some(instance) = self.plugins.get_mut(id) {
                if let Err(e) = instance.prepare_processing(
                    sample_rate,
                    safe_max_block_size as i32,
                    channels as i32,
                ) {
                    log::warn!("Failed to prepare plugin {}: {}", instance.name, e);
                }
                if let Some(proc) = instance.create_processor() {
                    if let Some(idx) = self.rt_index_of(id) {
                        processors.push((idx, proc));
                    }
                }
            }
        }

        processors
    }

    pub fn on_processor_retired(&mut self, index: u8) {
        self.finalize_unload(index);
    }

    pub fn runtime_stats(&self) -> (u32, u32, u32) {
        (
            self.plugins.len().try_into().unwrap_or(u32::MAX),
            self.pending_drop_by_index
                .len()
                .try_into()
                .unwrap_or(u32::MAX),
            self.burned_libraries.len().try_into().unwrap_or(u32::MAX),
        )
    }

    pub fn enabled_plugin_count(&self, global_bypass: bool) -> u32 {
        if global_bypass {
            return 0;
        }

        self.order
            .iter()
            .filter(|id| self.plugins.contains_key(*id) && !self.bypassed.contains(*id))
            .count()
            .try_into()
            .unwrap_or(u32::MAX)
    }

    pub fn total_latency_samples(&self, global_bypass: bool) -> u32 {
        if global_bypass {
            return 0;
        }

        let mut total: u64 = 0;
        for id in &self.order {
            if self.bypassed.contains(id) {
                continue;
            }
            if let Some(instance) = self.plugins.get(id) {
                total = total.saturating_add(instance.latency_samples() as u64);
            }
        }

        total.min(u32::MAX as u64) as u32
    }
}
