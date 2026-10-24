use std::collections::{HashMap, HashSet};

use anyhow::{anyhow, Result};
use log;

use crate::vst_host::instance::{PluginLibrary, VstInstance, VstProcessor};

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
    pub burned_libraries: Vec<std::sync::Arc<PluginLibrary>>,
    burned_library_keys: HashSet<String>,
}

impl Default for PluginManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginManager {
    pub(crate) fn reserve_restored_index(
        &mut self,
        staged: &super::restoration::StagedRestore,
    ) -> Result<u8> {
        staged.check_deadline()?;
        self.alloc_rt_index(&staged.instance.id)
    }

    pub(crate) fn commit_restored(
        &mut self,
        staged: super::restoration::StagedRestore,
        index: u8,
    ) -> (String, String, u8) {
        let id = staged.instance.id.clone();
        let name = staged.instance.name.clone();
        if staged.request.bypassed {
            self.bypassed.insert(id.clone());
        }
        if staged.request.muted {
            self.muted.insert(id.clone());
        }
        self.gains.insert(id.clone(), staged.request.gain);
        self.order.push(id.clone());
        self.plugins.insert(id.clone(), staged.instance);
        (id, name, index)
    }

    pub(crate) fn stop_processing(&mut self) {
        for instance in self.plugins.values_mut() {
            instance.stop_processing();
        }
    }

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

    pub fn reorder_plugins(&mut self, order: Vec<String>) -> Result<()> {
        // 欠落・重複・古いIDを含む要求では、処理中のチェーンを部分的に消さない。
        let requested: HashSet<_> = order.iter().collect();
        if order.len() != self.order.len()
            || requested.len() != order.len()
            || self.order.iter().any(|id| !requested.contains(id))
        {
            return Err(anyhow!(
                "Plugin order must contain each loaded plugin exactly once"
            ));
        }
        self.order = order;
        Ok(())
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
                self.free_rt_index(&id);
                return Err(e);
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
    ) -> Result<Vec<(u8, VstProcessor)>> {
        if !self.pending_init.is_empty() {
            return Err(anyhow!("VSTの遅延初期化が完了するまで音声を開始できません"));
        }
        let mut processors = Vec::new();
        let prepared = (|| -> Result<()> {
            for id in &self.order {
                if let Some(instance) = self.plugins.get_mut(id) {
                    instance
                        .prepare_processing(
                            sample_rate,
                            safe_max_block_size as i32,
                            channels as i32,
                        )
                        .map_err(|error| {
                            anyhow!("{} ({id}) の音声準備に失敗しました: {error}", instance.name)
                        })?;
                    if instance.needs_deferred_connection() {
                        instance.finalize_connection()?;
                    }
                    let proc = instance
                        .create_processor()
                        .ok_or_else(|| anyhow!("{} のprocessorを作成できません", instance.name))?;
                    let idx = self
                        .rt_index_of(id)
                        .ok_or_else(|| anyhow!("VST slotが見つかりません"))?;
                    processors.push((idx, proc));
                }
            }

            Ok(())
        })();
        if let Err(error) = prepared {
            // processor参照を先に制御側で解放してから、成功済み・失敗途中の全VSTを停止。
            drop(processors);
            self.stop_processing();
            return Err(error);
        }
        Ok(processors)
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

    /// 一回のgetter巡回から旧互換小計と段別申告を得る。
    pub fn latency_report(
        &self,
        global_bypass: bool,
    ) -> (u32, Option<u32>, bool, Vec<crate::ipc::VstLatencyStage>) {
        latency_rows(
            self.order.iter().take(MAX_PLUGINS).filter_map(|id| {
                self.plugins.get(id).map(|instance| {
                    (
                        id.clone(),
                        instance.name.clone(),
                        self.bypassed.contains(id),
                        self.muted.contains(id),
                        instance.declared_latency_samples(),
                    )
                })
            }),
            global_bypass,
        )
    }
    pub fn total_latency_samples(&self, global_bypass: bool) -> u32 {
        self.latency_report(global_bypass).0
    }
}

fn latency_rows(
    rows: impl Iterator<Item = (String, String, bool, bool, Option<u32>)>,
    global: bool,
) -> (u32, Option<u32>, bool, Vec<crate::ipc::VstLatencyStage>) {
    let mut total = 0u64;
    let mut known = true;
    let mut stages = Vec::with_capacity(MAX_PLUGINS);
    for (id, name, bypassed, muted, value) in rows.take(MAX_PLUGINS) {
        if !global && !bypassed {
            total = total.saturating_add(u64::from(value.unwrap_or(0)));
            known &= value.is_some();
        }
        let state = if global || bypassed {
            "bypassed"
        } else if muted {
            "muted"
        } else if value.is_none() {
            "unavailable"
        } else {
            "active"
        };
        stages.push(crate::ipc::VstLatencyStage {
            id,
            name,
            state: state.into(),
            bypassed,
            muted,
            declared_samples: value,
        });
    }
    let overflow = total > u64::from(u32::MAX);
    (
        total.min(u64::from(u32::MAX)) as u32,
        (known && !overflow).then_some(total as u32),
        overflow,
        stages,
    )
}

#[cfg(test)]
mod tests {
    use super::{burned_library_key, PluginManager};

    #[test]
    fn invalid_reorders_preserve_the_chain_and_valid_reorders_preserve_all_plugins() {
        let mut manager = PluginManager::new();
        manager.order = vec!["a".into(), "b".into()];
        for order in [
            vec![],
            vec!["a"],
            vec!["a", "a"],
            vec!["a", "other"],
            vec!["b", "a", "extra"],
        ] {
            assert!(manager
                .reorder_plugins(order.into_iter().map(String::from).collect())
                .is_err());
            assert_eq!(manager.order, ["a", "b"]);
        }
        manager
            .reorder_plugins(vec!["b".into(), "a".into()])
            .unwrap();
        assert_eq!(manager.order, ["b", "a"]);
    }

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

#[cfg(test)]
mod latency_tests {
    use super::*;
    #[test]
    fn latency_unknown_overflow_bypass_and_bound_do_not_create_a_measured_total() {
        let row = |v| ("id".into(), "Public name".into(), false, false, v);
        let r = latency_rows([row(None), row(Some(0))].into_iter(), false);
        assert_eq!(
            (r.0, r.1, r.2, r.3[0].state.as_str()),
            (0, None, false, "unavailable")
        );
        let r = latency_rows([row(Some(u32::MAX)), row(Some(1))].into_iter(), false);
        assert_eq!((r.0, r.1, r.2), (u32::MAX, None, true));
        let r = latency_rows(std::iter::repeat_with(|| row(Some(1))).take(100), true);
        assert_eq!((r.0, r.1, r.3.len()), (0, Some(0), MAX_PLUGINS));
        let r = latency_rows(
            [("id".into(), "Name".into(), true, false, None)].into_iter(),
            false,
        );
        assert_eq!((r.0, r.1, r.3[0].state.as_str()), (0, Some(0), "bypassed"));
    }
}
