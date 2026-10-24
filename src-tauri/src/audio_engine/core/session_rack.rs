//! state取得やview作成を行わない、再表示用の制御ラック情報。
use super::*;
impl Engine {
    pub(super) fn session_rack_matches(&self, ids: &[String], revision: u64) -> bool {
        self.pending_restore.is_none()
            && self.session_rack_revision == revision
            && self.plugin_manager.pending_init.is_empty()
            && self.plugin_manager.pending_drop_by_index.is_empty()
            && self.plugin_manager.order == ids
    }
    pub(super) fn session_rack_snapshot(&self) -> Response {
        if self.pending_restore.is_some()
            || !self.plugin_manager.pending_init.is_empty()
            || !self.plugin_manager.pending_drop_by_index.is_empty()
        {
            return Response::RackBusy;
        }
        let mut plugins = Vec::with_capacity(self.plugin_manager.order.len());
        for id in &self.plugin_manager.order {
            let Some(instance) = self.plugin_manager.get(id) else {
                return Response::RackConflict;
            };
            plugins.push(crate::ipc::RackPlugin {
                id: id.clone(),
                path: instance.path.clone(),
                name: instance.name.clone(),
                enabled: !self.plugin_manager.bypassed.contains(id),
                muted: self.plugin_manager.muted.contains(id),
                gain: *self.plugin_manager.gains.get(id).unwrap_or(&1.0),
            });
        }
        Response::PluginRack {
            plugins,
            restore_eligible: self.session_rack_revision == 0,
            revision: self.session_rack_revision,
            running: self.output_stream.is_some() && !self.stream_failed.load(Ordering::Acquire),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        audio_engine::restoration::{unix_ms, StagedRestore},
        ipc::RestorePluginRequest,
        vst_host::instance::with_mock_vst,
    };
    fn request() -> RestorePluginRequest {
        RestorePluginRequest {
            path: "mock.vst3".into(),
            state: None,
            bypassed: true,
            muted: true,
            gain: 0.4,
        }
    }
    #[test]
    fn session_rack_metadata_contains_only_real_ordered_instances_and_no_state_or_view_work() {
        with_mock_vst(false, |instance| {
            let mut engine = Engine::new();
            let staged =
                StagedRestore::load_with(request(), 1, unix_ms() + 8000, |_| Ok(instance)).unwrap();
            let index = engine
                .plugin_manager
                .reserve_restored_index(&staged)
                .unwrap();
            let (id, _, _) = engine.plugin_manager.commit_restored(staged, index);
            let response = engine.session_rack_snapshot();
            let Response::PluginRack { plugins, .. } = response else {
                panic!("metadata required")
            };
            assert_eq!(plugins.len(), 1);
            assert_eq!(plugins[0].id, id);
            assert!(!plugins[0].enabled && plugins[0].muted);
            assert_eq!(plugins[0].gain, 0.4);
            let value = serde_json::to_value(&plugins[0]).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 6);
            assert!(value.get("state").is_none() && value.get("controller").is_none());
            assert!(engine.session_rack_matches(std::slice::from_ref(&id), 0));
            assert!(!engine.session_rack_matches(&[], 0));
        });
    }
    #[test]
    fn session_restore_delayed_commit_rechecks_order_and_releases_unpublished_instance() {
        for changed in ["added", "reordered", "aba"] {
            with_mock_vst(false, |instance| {
                let mut engine = Engine::new();
                assert!(engine.session_rack_matches(&[], 0));
                let mut staged =
                    StagedRestore::load_with(request(), 1, unix_ms() + 8000, |_| Ok(instance))
                        .unwrap();
                staged.expected_ids = Some(Vec::new());
                staged.expected_rack_revision = Some(0);
                // entry後、STA次turnのcommit前に別コマンドが構成を変えた境界。
                engine.plugin_manager.order.push(changed.into());
                if changed == "aba" {
                    engine.plugin_manager.order.clear();
                    engine.session_rack_revision += 2;
                    assert!(!engine.session_rack_matches(&[], 0));
                }
                engine.finish_plugin_restore(staged);
                assert!(engine.plugin_manager.plugins.is_empty());
                if changed == "aba" {
                    assert!(engine.plugin_manager.order.is_empty());
                } else {
                    assert_eq!(engine.plugin_manager.order, [changed]);
                }
                assert!(engine.pending_audio_msgs.is_empty());
            });
        }
    }
    #[test]
    fn session_rack_busy_and_intentional_empty_are_not_cold_restore_candidates() {
        let mut engine = Engine::new();
        assert!(matches!(
            engine.session_rack_snapshot(),
            Response::PluginRack {
                restore_eligible: true,
                ..
            }
        ));
        engine.session_rack_revision = 1;
        assert!(matches!(
            engine.session_rack_snapshot(),
            Response::PluginRack {
                restore_eligible: false,
                ..
            }
        ));
        engine.plugin_manager.pending_init.push("pending".into());
        assert!(matches!(engine.session_rack_snapshot(), Response::RackBusy));
        assert!(!engine.session_rack_matches(&[], 0));
    }
}
