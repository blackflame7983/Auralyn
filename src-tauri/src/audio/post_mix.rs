//! 配信ミックス後のVSTを、声用ラックとは別のEngineと保存領域で管理する。
use super::*;
use crate::ipc::RackPlugin;
use crate::vst_host::presets::PresetPlugin;
use std::path::{Path, PathBuf};

type Saved = crate::bundle::mixing_configuration::PostMixPreset;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedPlugin {
    path: String,
    name: String,
    vendor: String,
    version: String,
    enabled: bool,
    muted: bool,
    gain: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    class_id: Option<String>,
}
impl From<&PresetPlugin> for SavedPlugin {
    fn from(p: &PresetPlugin) -> Self {
        Self {
            path: p.path.clone(),
            name: p.name.clone(),
            vendor: p.vendor.clone(),
            version: p.version.clone(),
            enabled: p.enabled,
            muted: p.muted,
            gain: p.gain,
            class_id: p.class_id.clone(),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    epoch: String,
    revision: String,
    enabled: bool,
    running: bool,
    saved_plugins: Vec<SavedPlugin>,
    plugins: Vec<RackPlugin>,
    restored: bool,
    error: Option<String>,
    transport_latency_frames: u32,
    declared_plugin_latency_frames: Option<u32>,
    attached: Option<bool>,
    ready: Option<bool>,
    failed: Option<bool>,
    processed_packets: Option<u64>,
    sample_rate: Option<u32>,
}
impl Snapshot {
    fn apply_status(&mut self, response: IpcResponse) {
        if let IpcResponse::PostMixStatus {
            attached,
            ready,
            failed,
            sample_rate,
            transport_latency_frames,
            declared_plugin_latency_frames,
            processed_packets,
        } = response
        {
            self.attached = Some(attached);
            self.ready = Some(ready);
            self.failed = Some(failed);
            self.sample_rate = sample_rate;
            self.processed_packets = processed_packets;
            self.transport_latency_frames = transport_latency_frames;
            if ready && !failed {
                self.declared_plugin_latency_frames = declared_plugin_latency_frames;
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Snapshot,
    Enable {
        expected_epoch: String,
        expected_revision: String,
        enabled: bool,
    },
    RestoreSaved {
        expected_epoch: String,
        expected_revision: String,
    },
    Add {
        expected_epoch: String,
        expected_revision: String,
        path: String,
        #[serde(default)]
        class_id: Option<String>,
    },
    Remove {
        expected_epoch: String,
        expected_revision: String,
        id: String,
    },
    Reorder {
        expected_epoch: String,
        expected_revision: String,
        ids: Vec<String>,
    },
    Bypass {
        expected_epoch: String,
        expected_revision: String,
        id: String,
        active: bool,
    },
    Mute {
        expected_epoch: String,
        expected_revision: String,
        id: String,
        active: bool,
    },
    Gain {
        expected_epoch: String,
        expected_revision: String,
        id: String,
        value: f32,
    },
    Editor {
        expected_epoch: String,
        expected_revision: String,
        id: String,
    },
    Save {
        expected_epoch: String,
        expected_revision: String,
    },
    Reload {
        expected_epoch: String,
        expected_revision: String,
    },
    Reset {
        expected_epoch: String,
        expected_revision: String,
    },
}
impl Request {
    fn witness(&self) -> Option<(&str, &str)> {
        match self {
            Self::Snapshot => None,
            Self::Enable {
                expected_epoch,
                expected_revision,
                ..
            }
            | Self::RestoreSaved {
                expected_epoch,
                expected_revision,
            }
            | Self::Add {
                expected_epoch,
                expected_revision,
                ..
            }
            | Self::Remove {
                expected_epoch,
                expected_revision,
                ..
            }
            | Self::Reorder {
                expected_epoch,
                expected_revision,
                ..
            }
            | Self::Bypass {
                expected_epoch,
                expected_revision,
                ..
            }
            | Self::Mute {
                expected_epoch,
                expected_revision,
                ..
            }
            | Self::Gain {
                expected_epoch,
                expected_revision,
                ..
            }
            | Self::Editor {
                expected_epoch,
                expected_revision,
                ..
            }
            | Self::Save {
                expected_epoch,
                expected_revision,
            }
            | Self::Reload {
                expected_epoch,
                expected_revision,
            }
            | Self::Reset {
                expected_epoch,
                expected_revision,
            } => Some((expected_epoch, expected_revision)),
        }
    }
}
fn raw(path: &Path) -> Result<Option<Vec<u8>>> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = Vec::new();
    file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 64 * 1024 * 1024,
        "保存されたVST設定が大きすぎます"
    );
    Ok(Some(bytes))
}
fn read(path: &Path) -> Result<(Option<Vec<u8>>, Option<Saved>)> {
    let bytes = raw(path)?;
    if let Some(content) = &bytes {
        let value: serde_json::Value = serde_json::from_slice(content)?;
        let plugins = value
            .get("plugins")
            .and_then(|value| value.as_array())
            .ok_or_else(|| anyhow!("保存された配信VST一覧が不正です"))?;
        for plugin in plugins {
            let fields = plugin
                .as_object()
                .ok_or_else(|| anyhow!("保存された配信VSTが不正です"))?;
            anyhow::ensure!(
                fields.keys().all(|key| [
                    "path", "name", "vendor", "version", "enabled", "muted", "gain", "state",
                    "classId",
                ]
                .contains(&key.as_str())),
                "保存された配信VSTに未知の情報があります"
            );
        }
    }
    let saved = bytes
        .as_ref()
        .map(|v| serde_json::from_slice::<Saved>(v))
        .transpose()?;
    if let Some(s) = &saved {
        s.validate().map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            s.schema_version == 1 && s.role == "post_mix" && s.plugins.len() <= 32,
            "配信VSTの保存形式を確認してください"
        );
        for p in &s.plugins {
            anyhow::ensure!(
                !p.path.is_empty()
                    && p.path.len() <= 32768
                    && !p.path.contains('\0')
                    && p.gain.is_finite()
                    && (0.0..=2.0).contains(&p.gain)
                    && p.state.as_ref().is_none_or(|s| s.len() <= 64 * 1024 * 1024),
                "保存されたVST設定が不正です"
            );
        }
    }
    Ok((bytes, saved))
}
pub(super) struct State {
    path: PathBuf,
    child: Option<Box<AudioHost>>,
    raw: Option<Vec<u8>>,
    saved: Option<Saved>,
    epoch: String,
    revision: u64,
    enabled: bool,
    restored: bool,
    running: bool,
    error: Option<String>,
}
impl State {
    pub(super) fn new(root: &Path) -> Self {
        let path = root.join("post-mix.json");
        let (raw, saved, error) = match read(&path) {
            Ok((r, s)) => (r, s, None),
            Err(e) => (None, None, Some(e.to_string())),
        };
        Self {
            path,
            child: None,
            raw,
            saved,
            epoch: crate::bundle::revision(),
            revision: 0,
            enabled: false,
            restored: false,
            running: false,
            error,
        }
    }
    pub(super) fn enabled(&self) -> bool {
        self.enabled
    }
    pub(super) fn has_current_rack(&self) -> bool {
        self.restored
            && self
                .child
                .as_ref()
                .is_some_and(|c| c.child.is_some() && c.reader_active.load(Ordering::Acquire))
    }
    /// 破損や未復元の有効な保存設定を、無効扱いで黙って通さない。
    pub(super) fn validate_start(&self) -> Result<()> {
        self.unchanged()?;
        anyhow::ensure!(
            self.restored || !self.saved.as_ref().is_some_and(|saved| saved.enabled),
            "保存した配信VSTを明示的に復元するか、保存設定を復旧してください"
        );
        if self.enabled {
            anyhow::ensure!(self.ready(), "配信VSTを明示的に復元してください");
        }
        Ok(())
    }
    pub(super) fn ready(&self) -> bool {
        !self.enabled
            || (self.error.is_none()
                && self.restored
                && self
                    .child
                    .as_ref()
                    .is_some_and(|c| c.reader_active.load(Ordering::Acquire) && c.child.is_some()))
    }
    fn unchanged(&self) -> Result<()> {
        anyhow::ensure!(
            self.error.is_none(),
            "配信VSTの保存状態を読み直すか復旧してください"
        );
        anyhow::ensure!(
            raw(&self.path)? == self.raw,
            "配信VSTの保存状態が変わりました。読み直してください"
        );
        Ok(())
    }
    fn persist(&mut self, saved: &Saved) -> Result<()> {
        self.unchanged()?;
        let bytes = serde_json::to_vec_pretty(saved)?;
        anyhow::ensure!(
            bytes.len() <= 64 * 1024 * 1024,
            "配信VSTの保存状態が大きすぎます"
        );
        let dir = self
            .path
            .parent()
            .ok_or_else(|| anyhow!("保存先がありません"))?;
        std::fs::create_dir_all(dir)?;
        let tmp = self
            .path
            .with_extension(format!("{}.pending", crate::bundle::revision()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        self.unchanged()?;
        std::fs::rename(tmp, &self.path)?;
        self.raw = Some(bytes.clone());
        self.saved = Some(saved.clone());
        anyhow::ensure!(
            std::fs::read(&self.path)? == bytes,
            "保存後の配信VST設定を確認できません"
        );
        Ok(())
    }
    pub(super) fn file_checkpoint(&self) -> (PathBuf, Option<Vec<u8>>) {
        (self.path.clone(), self.raw.clone())
    }
    fn child(&mut self) -> Result<&mut AudioHost> {
        if self.child.is_none() {
            let root = self
                .path
                .parent()
                .ok_or_else(|| anyhow!("保存先がありません"))?
                .join("post-mix-runtime");
            let mut child = AudioHost::new(root);
            child.post_role = true;
            self.child = Some(Box::new(child));
        }
        let child = self.child.as_mut().expect("子Hostは作成済み");
        child.ensure_engine_running()?;
        Ok(child)
    }
    fn rack(&mut self) -> Result<Vec<RackPlugin>> {
        let Some(child) = self.child.as_mut() else {
            return Ok(Vec::new());
        };
        anyhow::ensure!(
            child.reader_active.load(Ordering::Acquire) && child.child.is_some(),
            "配信VSTのEngineが終了しました。保存設定を選び直してください"
        );
        match child.execute_running_command(IpcCommand::GetPluginRack)? {
            IpcResponse::PluginRack { plugins, .. } => Ok(plugins),
            IpcResponse::Error(e) => Err(anyhow!(e)),
            _ => Err(anyhow!("配信VSTの状態を確認できません")),
        }
    }
    fn command(&mut self, cmd: IpcCommand) -> Result<IpcResponse> {
        let child = self.child()?;
        match child.execute_running_command(cmd)? {
            IpcResponse::Error(e) => Err(anyhow!(e)),
            other => Ok(other),
        }
    }
    fn success(&mut self, cmd: IpcCommand) -> Result<()> {
        anyhow::ensure!(
            matches!(self.command(cmd)?, IpcResponse::Success),
            "配信VSTの操作結果を確認できません"
        );
        Ok(())
    }
    pub(super) fn bundle_revision(&self) -> String {
        let child = self
            .child
            .as_ref()
            .map(|c| {
                format!(
                    "{}:{}:{}",
                    c.engine_generation,
                    c.reader_active.load(Ordering::Acquire),
                    c.child.is_some()
                )
            })
            .unwrap_or_else(|| "none".into());
        format!(
            "{}:{}:{}:{}:{}",
            self.epoch, self.revision, self.restored, self.enabled, child
        )
    }
    /// VSTの状態はラックの前後世代を比較して取得し、UIには返さない。
    pub(super) fn capture_bundle(
        &mut self,
    ) -> Result<crate::bundle::mixing_configuration::PostMixPreset> {
        self.unchanged()?;
        if self.child.is_none() {
            return Ok(self.saved.clone().unwrap_or(Saved {
                schema_version: 1,
                role: "post_mix".into(),
                enabled: false,
                plugins: Vec::new(),
            }));
        }
        anyhow::ensure!(self.restored, "配信VSTを明示的に復元してください");
        let witness = self.bundle_revision();
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| anyhow!("配信VSTの状態を確認できません"))?;
        anyhow::ensure!(
            child.reader_active.load(Ordering::Acquire) && child.child.is_some(),
            "配信VSTの接続が終了しました"
        );
        let (before, revision) = match child.execute_running_command(IpcCommand::GetPluginRack)? {
            IpcResponse::PluginRack {
                plugins, revision, ..
            } => (plugins, revision),
            IpcResponse::Error(error) => anyhow::bail!(error),
            _ => anyhow::bail!("配信VSTの一覧を確認できません"),
        };
        let mut plugins = Vec::new();
        for p in &before {
            let data = match child
                .execute_running_command(IpcCommand::GetPluginState { id: p.id.clone() })?
            {
                IpcResponse::PluginState { state, .. } => state,
                IpcResponse::Error(error) => anyhow::bail!(error),
                _ => anyhow::bail!("配信VSTの状態を取得できません"),
            };
            plugins.push(PresetPlugin {
                path: p.path.clone(),
                name: p.name.clone(),
                vendor: String::new(),
                version: String::new(),
                enabled: p.enabled,
                muted: p.muted,
                gain: p.gain,
                state: Some(data),
                class_id: p.class_id.clone(),
            });
        }
        let (after, end_revision) =
            match child.execute_running_command(IpcCommand::GetPluginRack)? {
                IpcResponse::PluginRack {
                    plugins, revision, ..
                } => (plugins, revision),
                IpcResponse::Error(error) => anyhow::bail!(error),
                _ => anyhow::bail!("配信VSTの一覧を確認できません"),
            };
        anyhow::ensure!(
            revision == end_revision
                && before
                    .iter()
                    .map(|p| {
                        (
                            &p.id,
                            &p.path,
                            p.class_id.as_deref(),
                            p.enabled,
                            p.muted,
                            p.gain.to_bits(),
                        )
                    })
                    .eq(after.iter().map(|p| {
                        (
                            &p.id,
                            &p.path,
                            p.class_id.as_deref(),
                            p.enabled,
                            p.muted,
                            p.gain.to_bits(),
                        )
                    }))
                && witness == self.bundle_revision(),
            "取得中に配信VSTが変更されました"
        );
        let result = Saved {
            schema_version: 1,
            role: "post_mix".into(),
            enabled: self.enabled,
            plugins,
        };
        result.validate().map_err(anyhow::Error::msg)?;
        Ok(result)
    }
    /// 親が停止・ミュートを確認した後にだけ呼ぶ。旧保存原本は書換え前に保管する。
    pub(super) fn restore_bundle(
        &mut self,
        preset: &crate::bundle::mixing_configuration::PostMixPreset,
    ) -> Result<()> {
        preset.validate().map_err(anyhow::Error::msg)?;
        self.unchanged()?;
        let dir = self
            .path
            .parent()
            .ok_or_else(|| anyhow!("保存先がありません"))?
            .join("post-mix-backups");
        std::fs::create_dir_all(&dir)?;
        let name = format!("bundle-{}", crate::bundle::revision());
        if let Some(bytes) = &self.raw {
            let path = dir.join(format!("{name}.original.json"));
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            f.write_all(bytes)?;
            f.sync_all()?;
            drop(f);
            anyhow::ensure!(
                std::fs::read(path)? == *bytes,
                "配信VSTの元設定を保管できません"
            );
        }
        let mut marker = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(format!("{name}.state.json")))?;
        marker.write_all(&serde_json::to_vec(&serde_json::json!({"version":1,"existed":self.raw.is_some(),"original":self.raw.as_ref().map(|_| format!("{name}.original.json"))}))?)?;
        marker.sync_all()?;
        drop(marker);
        self.stop()?;
        self.discard_child();
        let result: Result<()> = (|| {
            self.child()?;
            for plugin in &preset.plugins {
                let child = self.child()?;
                child.next_restore_operation = child
                    .next_restore_operation
                    .checked_add(1)
                    .ok_or_else(|| anyhow!("復元操作IDの上限です"))?;
                let id = child.next_restore_operation;
                let generation = child.engine_generation;
                let response = child.execute_running_command(IpcCommand::RestorePlugin {
                    request: crate::ipc::RestorePluginRequest {
                        path: plugin.path.clone(),
                        state: plugin.state.clone(),
                        bypassed: !plugin.enabled,
                        muted: plugin.muted,
                        gain: plugin.gain,
                        class_id: plugin.class_id.clone(),
                    },
                    operation_id: id,
                    expires_at_ms: crate::audio_engine::restoration::unix_ms().saturating_add(8000),
                })?;
                validate_restore_response(generation, child.engine_generation, id, response)?;
            }
            self.restored = true;
            self.enabled = preset.enabled;
            let captured = self.capture_bundle()?;
            anyhow::ensure!(
                captured.plugins.len() == preset.plugins.len()
                    && captured
                        .plugins
                        .iter()
                        .zip(&preset.plugins)
                        .all(|(a, b)| a.path == b.path
                            && a.enabled == b.enabled
                            && a.muted == b.muted
                            && a.gain == b.gain
                            && a.state == b.state),
                "配信VSTの復元内容を確認できません"
            );
            self.revision = self
                .revision
                .checked_add(1)
                .ok_or_else(|| anyhow!("配信VSTの世代を更新できません"))?;
            Ok(())
        })();
        if let Err(error) = result {
            self.discard_child();
            self.error =
                Some("配信VSTの復元を完了できませんでした。保存状態を読み直してください".into());
            return Err(error);
        }
        Ok(())
    }
    pub(super) fn commit_bundle(&mut self, preset: &Saved) -> Result<()> {
        self.persist(preset)
    }
    pub(super) fn kill(&mut self) {
        self.discard_child();
    }
    fn discard_child(&mut self) {
        if let Some(mut child) = self.child.take() {
            child.kill_engine();
        }
        self.restored = false;
        self.enabled = false;
        self.running = false;
    }
    pub(super) fn stop(&mut self) -> Result<()> {
        if let Some(child) = &mut self.child {
            if child.reader_active.load(Ordering::Acquire) {
                match child.execute_running_command(IpcCommand::Stop) {
                    Ok(IpcResponse::Success) => {}
                    _ => {
                        child.kill_engine();
                        self.restored = false;
                        self.running = false;
                        anyhow::bail!("配信VSTを停止できませんでした");
                    }
                }
            } else if child.child.is_some() {
                child.kill_engine();
                self.restored = false;
            }
        }
        self.running = false;
        Ok(())
    }
    pub(super) fn start(
        &mut self,
        rate: u32,
        descriptor: crate::audio_engine::post_mix::Descriptor,
    ) -> Result<()> {
        anyhow::ensure!(
            self.enabled && self.ready(),
            "配信VSTの保存設定を明示的に復元してください"
        );
        self.unchanged()?;
        anyhow::ensure!(
            rate == descriptor.sample_rate,
            "配信VSTのサンプルレートが一致しません"
        );
        if self.running {
            self.stop()?;
            anyhow::ensure!(self.ready(), "配信VSTを選び直してください");
        }
        // readyを確認後は新しい子を生成しない。
        let child = self
            .child
            .as_mut()
            .ok_or_else(|| anyhow!("配信VSTを選び直してください"))?;
        match child.execute_running_command(IpcCommand::PostMixStart { descriptor }) {
            Ok(IpcResponse::Success) => {
                self.running = true;
                Ok(())
            }
            Ok(IpcResponse::Error(e)) => {
                child.kill_engine();
                self.restored = false;
                Err(anyhow!(e))
            }
            _ => {
                child.kill_engine();
                self.restored = false;
                Err(anyhow!("配信VSTを開始できません"))
            }
        }
    }
    fn snapshot(&mut self) -> Result<Snapshot> {
        if let Some(child) = self.child.as_mut() {
            if child.reader_active.load(Ordering::Acquire) {
                match child.execute_running_command(IpcCommand::ProcessingState)? {
                    IpcResponse::ProcessingState { present, failed } => {
                        if self.running && (!present || failed) {
                            self.error = Some("配信VSTの処理が停止しました".into());
                        }
                        self.running = present;
                    }
                    IpcResponse::Error(error) => return Err(anyhow!(error)),
                    _ => anyhow::bail!("配信VSTの状態を確認できません"),
                }
            } else {
                self.restored = false;
                self.running = false;
                self.error = Some("配信VSTのEngineが終了しました".into());
                self.child = None;
            }
        }
        let plugins = self.rack()?;
        Ok(Snapshot {
            epoch: self.epoch.clone(),
            revision: self.revision.to_string(),
            enabled: self.enabled,
            running: self.running,
            saved_plugins: self.saved.as_ref().map_or_else(Vec::new, |s| {
                s.plugins.iter().map(SavedPlugin::from).collect()
            }),
            plugins,
            restored: self.restored,
            error: self
                .error
                .clone()
                .or_else(|| self.unchanged().err().map(|e| e.to_string())),
            transport_latency_frames: crate::audio_engine::post_mix::TRANSPORT_LATENCY_FRAMES,
            declared_plugin_latency_frames: None,
            attached: None,
            ready: None,
            failed: None,
            processed_packets: None,
            sample_rate: None,
        })
    }
}
impl AudioHost {
    fn post_mix_stopped(&mut self) -> Result<()> {
        if self.reader_active.load(Ordering::Acquire) {
            match self.execute_running_command(IpcCommand::ProcessingState)? {
                IpcResponse::ProcessingState { present: false, .. } => {}
                IpcResponse::ProcessingState { .. } => {
                    anyhow::bail!("音声を停止してから配信VSTを変更してください")
                }
                IpcResponse::Error(e) => anyhow::bail!(e),
                _ => anyhow::bail!("音声の停止状態を確認できません"),
            }
        } else if self.child.is_some() {
            self.kill_engine();
        }
        Ok(())
    }
    pub(crate) fn post_mix(&mut self, request: Request) -> Result<Snapshot> {
        if let Some((epoch, revision)) = request.witness() {
            anyhow::ensure!(
                epoch == self.post_mix.epoch && revision == self.post_mix.revision.to_string(),
                "配信VSTの設定が変わりました。読み直してください"
            );
            self.guard_mode_vst()?;
        }
        if matches!(
            &request,
            Request::Enable { .. }
                | Request::RestoreSaved { .. }
                | Request::Add { .. }
                | Request::Remove { .. }
                | Request::Reorder { .. }
                | Request::Reload { .. }
                | Request::Reset { .. }
        ) {
            self.preflight_live_changes()?;
            self.post_mix_stopped()?;
        }
        if !matches!(
            &request,
            Request::Snapshot | Request::Reload { .. } | Request::Reset { .. }
        ) {
            self.post_mix.unchanged()?;
        }
        if matches!(&request, Request::Enable { enabled: true, .. }) {
            anyhow::ensure!(
                self.mixing.selected.is_some(),
                "オケの入力元を明示選択してから配信VSTを有効にしてください"
            );
        }
        let state = &mut self.post_mix;
        let result: Result<()> = (|| {
            match request {
                Request::Snapshot => return Ok(()),
                Request::Enable { enabled, .. } => {
                    if enabled {
                        anyhow::ensure!(
                            state.restored && state.ready_for_enable(),
                            "配信VSTを明示的に復元してください"
                        );
                    }
                    state.enabled = enabled;
                }
                Request::RestoreSaved { .. } => {
                    state.discard_child();
                    let saved = state.saved.clone();
                    state.child()?;
                    if let Some(saved) = &saved {
                        for plugin in &saved.plugins {
                            let child = state.child()?;
                            child.next_restore_operation = child
                                .next_restore_operation
                                .checked_add(1)
                                .ok_or_else(|| anyhow!("復元操作IDの上限です"))?;
                            let id = child.next_restore_operation;
                            let generation = child.engine_generation;
                            let response =
                                child.execute_running_command(IpcCommand::RestorePlugin {
                                    request: crate::ipc::RestorePluginRequest {
                                        path: plugin.path.clone(),
                                        state: plugin.state.clone(),
                                        bypassed: !plugin.enabled,
                                        muted: plugin.muted,
                                        gain: plugin.gain,
                                        class_id: plugin.class_id.clone(),
                                    },
                                    operation_id: id,
                                    expires_at_ms: crate::audio_engine::restoration::unix_ms()
                                        .saturating_add(8000),
                                })?;
                            validate_restore_response(
                                generation,
                                child.engine_generation,
                                id,
                                response,
                            )?;
                        }
                    }
                    state.restored = true;
                    state.enabled = saved.is_some_and(|s| s.enabled);
                }
                Request::Add { path, class_id, .. } => {
                    anyhow::ensure!(
                        state.restored || state.saved.as_ref().is_none_or(|s| s.plugins.is_empty()),
                        "保存した配信VSTを先に復元してください"
                    );
                    anyhow::ensure!(
                        !path.is_empty()
                            && path.len() <= 32768
                            && !path.contains('\0')
                            && state.rack()?.len() < 32,
                        "VSTを追加できません"
                    );
                    anyhow::ensure!(
                        matches!(
                            state.command(IpcCommand::LoadPlugin { path, class_id })?,
                            IpcResponse::PluginLoaded { .. }
                        ),
                        "VSTの追加結果を確認できません"
                    );
                    state.restored = true;
                }
                Request::Remove { id, .. } => {
                    state.require_id(&id)?;
                    state.success(IpcCommand::UnloadPlugin { id })?;
                }
                Request::Reorder { ids, .. } => {
                    let rack = state.rack()?;
                    let mut a: Vec<_> = rack.iter().map(|p| p.id.clone()).collect();
                    let mut b = ids.clone();
                    a.sort();
                    b.sort();
                    anyhow::ensure!(a == b, "配信VSTの順序を確認してください");
                    state.success(IpcCommand::ReorderPlugins { order: ids })?;
                }
                Request::Bypass { id, active, .. } => {
                    state.require_id(&id)?;
                    state.success(IpcCommand::SetBypass { id, active })?;
                }
                Request::Mute { id, active, .. } => {
                    state.require_id(&id)?;
                    state.success(IpcCommand::SetMute { id, active })?;
                }
                Request::Gain { id, value, .. } => {
                    state.require_id(&id)?;
                    anyhow::ensure!(
                        value.is_finite() && (0.0..=2.0).contains(&value),
                        "音量は0〜2で指定してください"
                    );
                    state.success(IpcCommand::SetGain { id, value })?;
                }
                Request::Editor { id, .. } => {
                    state.require_id(&id)?;
                    state.success(IpcCommand::OpenEditor { id })?;
                }
                Request::Save { .. } => {
                    anyhow::ensure!(state.restored, "配信VSTを明示的に復元してください");
                    let captured = state.capture_bundle()?;
                    state.persist(&captured)?;
                }
                Request::Reload { .. } => {
                    state.discard_child();
                    let (bytes, saved) = read(&state.path)?;
                    state.raw = bytes;
                    state.saved = saved;
                    state.error = None;
                }
                Request::Reset { .. } => {
                    state.discard_child();
                    state.error = Some("保存状態の保管を完了できませんでした".into());
                    let bytes = raw(&state.path)?;
                    let directory = state
                        .path
                        .parent()
                        .ok_or_else(|| anyhow!("保存先がありません"))?
                        .join("post-mix-backups");
                    std::fs::create_dir_all(&directory)?;
                    let name = format!("reset-{}", crate::bundle::revision());
                    if let Some(bytes) = &bytes {
                        let path = directory.join(format!("{name}.original.json"));
                        let mut file = std::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&path)?;
                        file.write_all(bytes)?;
                        file.sync_all()?;
                        drop(file);
                        anyhow::ensure!(
                            std::fs::read(path)? == *bytes,
                            "保存状態の保管に失敗しました"
                        );
                    }
                    let mut marker = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(directory.join(format!("{name}.state.json")))?;
                    marker.write_all(&serde_json::to_vec(&serde_json::json!({"version":1,"existed":bytes.is_some(),"original":bytes.as_ref().map(|_| format!("{name}.original.json"))}))?)?;
                    marker.sync_all()?;
                    state.raw = bytes;
                    state.error = None;
                    state.persist(&Saved {
                        schema_version: 1,
                        role: "post_mix".into(),
                        enabled: false,
                        plugins: Vec::new(),
                    })?;
                }
            }
            state.revision = state
                .revision
                .checked_add(1)
                .ok_or_else(|| anyhow!("配信VSTの世代を更新できません"))?;
            Ok(())
        })();
        if let Err(error) = result {
            state.discard_child();
            state.error =
                Some("配信VSTの操作を完了できませんでした。保存状態を読み直してください".into());
            return Err(error);
        }
        let mut snapshot = state.snapshot()?;
        if self.reader_active.load(Ordering::Acquire) && self.post_mix.enabled() {
            snapshot.apply_status(self.execute_running_command(IpcCommand::PostMixStatus)?);
        }
        Ok(snapshot)
    }
}
impl State {
    fn ready_for_enable(&self) -> bool {
        self.error.is_none()
            && self
                .child
                .as_ref()
                .is_some_and(|c| c.reader_active.load(Ordering::Acquire) && c.child.is_some())
    }
    fn require_id(&mut self, id: &str) -> Result<()> {
        anyhow::ensure!(
            self.rack()?.iter().any(|p| p.id == id),
            "配信VSTを選び直してください"
        );
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn temporary() -> PathBuf {
        std::env::temp_dir().join(format!("auralyn-post-mix-{}", crate::bundle::revision()))
    }
    #[test]
    fn status_transfer_preserves_actual_rate_and_failure() {
        let mut host = AudioHost::new(temporary());
        let mut snapshot = host.post_mix(Request::Snapshot).unwrap();
        assert!(snapshot.attached.is_none());
        snapshot.apply_status(IpcResponse::PostMixStatus {
            attached: true,
            ready: false,
            failed: true,
            sample_rate: Some(44100),
            transport_latency_frames: 256,
            declared_plugin_latency_frames: Some(42),
            processed_packets: Some(9),
        });
        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["attached"], true);
        assert_eq!(json["ready"], false);
        assert_eq!(json["failed"], true);
        assert_eq!(json["sampleRate"], 44100);
        assert_eq!(json["processedPackets"], 9);
        assert_eq!(json["transportLatencyFrames"], 256);
        assert!(json["declaredPluginLatencyFrames"].is_null());
    }
    #[test]
    fn cold_saved_state_does_not_spawn_or_expose_vst_state() {
        let root = temporary();
        std::fs::create_dir(&root).unwrap();
        let value = Saved {
            schema_version: 1,
            role: "post_mix".into(),
            enabled: true,
            plugins: vec![PresetPlugin {
                path: "fixture.vst3".into(),
                name: "fixture".into(),
                vendor: String::new(),
                version: String::new(),
                enabled: true,
                muted: false,
                gain: 0.0,
                state: Some("private-state".into()),
                class_id: None,
            }],
        };
        std::fs::write(
            root.join("post-mix.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let mut host = AudioHost::new(root.clone());
        let snapshot = host.post_mix(Request::Snapshot).unwrap();
        assert!(
            !snapshot.enabled
                && !snapshot.restored
                && !snapshot.running
                && host.post_mix.child.is_none()
        );
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains("private-state") && !json.contains("\"state\""));
        std::fs::remove_file(root.join("post-mix.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn stale_reset_is_rejected_and_corrupt_bytes_are_backed_up() {
        let root = temporary();
        std::fs::create_dir(&root).unwrap();
        let original = b"{broken";
        std::fs::write(root.join("post-mix.json"), original).unwrap();
        let mut host = AudioHost::new(root.clone());
        let epoch = host.post_mix.epoch.clone();
        assert!(host
            .post_mix(Request::Reset {
                expected_epoch: epoch.clone(),
                expected_revision: "9".into()
            })
            .is_err());
        assert_eq!(std::fs::read(root.join("post-mix.json")).unwrap(), original);
        let snapshot = host
            .post_mix(Request::Reset {
                expected_epoch: epoch,
                expected_revision: "0".into(),
            })
            .unwrap();
        assert!(!snapshot.enabled && !snapshot.restored && snapshot.error.is_none());
        let backups: Vec<_> = std::fs::read_dir(root.join("post-mix-backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert!(backups
            .iter()
            .any(|p| p.to_string_lossy().ends_with(".original.json")
                && std::fs::read(p).unwrap() == original));
        for file in backups {
            std::fs::remove_file(file).unwrap();
        }
        std::fs::remove_dir(root.join("post-mix-backups")).unwrap();
        std::fs::remove_file(root.join("post-mix.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
