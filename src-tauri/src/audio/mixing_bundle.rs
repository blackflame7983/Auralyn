//! 両ラックの全体保存は、現在明示選択したオケへの権限を保持して復帰する。
use super::*;
use crate::bundle::MixingConfiguration;

// 比較から復帰まで同じ排他ハンドルを保持し、他プロセスの書込み・改名を防ぐ。
#[cfg(windows)]
fn rollback_settings(
    path: &std::path::Path,
    original: &Option<Vec<u8>>,
    published: &Option<Vec<u8>>,
) -> Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE},
        Storage::FileSystem::{
            FileDispositionInfo, SetFileInformationByHandle, DELETE, FILE_DISPOSITION_INFO,
        },
    };
    let access = GENERIC_READ.0
        | if original.is_some() {
            GENERIC_WRITE.0
        } else {
            DELETE.0
        };
    let mut file = match std::fs::OpenOptions::new()
        .access_mode(access)
        .share_mode(0)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && original.is_none() => {
            return Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            anyhow::bail!("元の設定がありません。全体保存の原本から手動復旧してください")
        }
        Err(error) => return Err(error.into()),
    };
    let mut current = Vec::new();
    (&mut file)
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut current)?;
    anyhow::ensure!(
        current.len() <= 64 * 1024 * 1024,
        "設定ファイルが大きすぎます"
    );
    if original.as_ref().is_some_and(|value| *value == current) {
        return Ok(());
    }
    anyhow::ensure!(
        published.as_ref().is_some_and(|value| *value == current),
        "設定の外部変更を保持しています。全体保存の原本から手動復旧してください"
    );
    if let Some(original) = original {
        // 途中のI/O失敗時は退避済みの全体保存原本から手動復旧する。
        file.seek(SeekFrom::Start(0))?;
        file.write_all(original)?;
        file.set_len(original.len() as u64)?;
        file.sync_all()?;
        file.seek(SeekFrom::Start(0))?;
        let mut verified = Vec::new();
        (&mut file)
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut verified)?;
        anyhow::ensure!(verified == *original, "設定原本への復帰を確認できません");
    } else {
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // 内容照合後に、開いたファイル自体だけを削除予約する。
        // SAFETY: fileはDELETE権限付きで所有し、dispositionは呼出し完了まで有効な構造体と正しいサイズを渡す。
        unsafe {
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )?;
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn rollback_settings(
    _path: &std::path::Path,
    _original: &Option<Vec<u8>>,
    _published: &Option<Vec<u8>>,
) -> Result<()> {
    anyhow::bail!("この環境では設定を安全に復旧できません")
}

impl AudioHost {
    pub(crate) fn stage_bundle_voice(
        &mut self,
        plugins: &[crate::vst_host::presets::PresetPlugin],
    ) -> Result<Vec<crate::vst_host::presets::LoadedPluginInstance>> {
        anyhow::ensure!(
            self.bundle_mixing_override && self.is_global_muted,
            "ミックスの全体復帰で停止・ミュートしてから声ラックを準備してください"
        );
        anyhow::ensure!(
            matches!(
                self.execute_running_command(IpcCommand::ProcessingState)?,
                IpcResponse::ProcessingState { present: false, .. }
            ),
            "声ラックを準備する前に主音声を停止してください"
        );
        let ids = match self.execute_running_command(IpcCommand::GetPluginRack)? {
            IpcResponse::PluginRack { plugins, .. } => plugins
                .into_iter()
                .map(|plugin| plugin.id)
                .collect::<Vec<_>>(),
            IpcResponse::Error(error) => anyhow::bail!(error),
            _ => anyhow::bail!("声ラックの準備完了を待ってください"),
        };
        self.unload_all_plugins(&ids)?;
        let mut prepared = Vec::with_capacity(plugins.len());
        for plugin in plugins {
            let result = self.restore_plugin(crate::ipc::RestorePluginRequest {
                path: plugin.path.clone(),
                state: plugin.state.clone(),
                bypassed: !plugin.enabled,
                muted: plugin.muted,
                gain: plugin.gain,
                class_id: plugin.class_id.clone(),
            })?;
            prepared.push(crate::vst_host::presets::LoadedPluginInstance {
                id: result.id,
                path: plugin.path.clone(),
                name: result.name,
                vendor: plugin.vendor.clone(),
                version: plugin.version.clone(),
                enabled: plugin.enabled,
                muted: plugin.muted,
                gain: plugin.gain,
                class_id: result.class_id,
            });
        }
        let actual = self.capture_bundle_state()?;
        anyhow::ensure!(
            !actual.running
                && actual.plugins.len() == plugins.len()
                && actual
                    .plugins
                    .iter()
                    .zip(plugins)
                    .all(|(current, expected)| current.plugin.path == expected.path
                        && current.plugin.enabled == expected.enabled
                        && current.plugin.muted == expected.muted
                        && current.plugin.gain == expected.gain
                        && current.plugin.state == expected.state),
            "停止中の声ラックの復元内容を確認できません"
        );
        self.bundle_prepared_voice = true;
        Ok(prepared)
    }
    pub(crate) fn capture_bundle_mixing(
        &mut self,
    ) -> Result<(Option<MixingConfiguration>, String)> {
        self.mixing.unchanged()?;
        self.post_mix.validate_start()?;
        let input = self
            .mixing
            .selected
            .as_ref()
            .map(|start| start.config.clone());
        let before = self.post_mix.bundle_revision();
        if input.is_none() && !self.post_mix.enabled() && !self.post_mix.has_current_rack() {
            return Ok((None, before));
        }
        anyhow::ensure!(
            self.post_mix.ready(),
            "ミックス後VSTの復元状態を確認してください"
        );
        let mut post_mix = self.post_mix.capture_bundle()?;
        post_mix.enabled = self.post_mix.enabled();
        if input.is_none() && !post_mix.enabled && post_mix.plugins.is_empty() {
            return Ok((None, before));
        }
        anyhow::ensure!(
            before == self.post_mix.bundle_revision(),
            "ミックス後VSTの世代が変わりました"
        );
        let value = MixingConfiguration {
            version: 1,
            input,
            post_mix,
        };
        value.validate().map_err(anyhow::Error::msg)?;
        let revision = format!("{}:{}", before, serde_json::to_string(&value.input)?);
        Ok((Some(value), revision))
    }
    pub(crate) fn with_bundle_mixing<T>(
        &mut self,
        target: &MixingConfiguration,
        expected_revision: &str,
        apply: impl FnOnce(&mut Self) -> std::result::Result<T, String>,
    ) -> std::result::Result<T, String> {
        let mut changed = false;
        let mix_original = self.mixing.file_checkpoint();
        let post_original = self.post_mix.file_checkpoint();
        let result = (|| -> Result<T> {
            target.validate().map_err(anyhow::Error::msg)?;
            let (_, revision) = self.capture_bundle_mixing()?;
            anyhow::ensure!(
                revision == expected_revision,
                "オケまたは配信VSTの設定が変わりました。差分を再確認してください"
            );
            anyhow::ensure!(
                self.is_global_muted,
                "全体をミュートしてから二入力を復帰してください"
            );
            let selection = match &target.input {
                Some(config) => {
                    let mut selected = self
                        .mixing
                        .selected
                        .clone()
                        .ok_or_else(|| anyhow!("保存したオケの入力元を明示選択してください"))?;
                    anyhow::ensure!(
                        selected.config.source == config.source,
                        "保存したオケの入力元と現在の明示選択が一致しません"
                    );
                    selected.config = config.clone();
                    Some(selected)
                }
                None => None,
            };
            // 本人用と配信用の出力を止めた後、片方だけ成功して送出するのを防ぐ。
            changed = true;
            self.stop()?;
            self.mixing.unchanged()?;
            self.apply_engine_mixing(selection.clone())?;
            self.mixing.selected = selection;
            self.post_mix.restore_bundle(&target.post_mix)?;
            // 保存ファイルの旧値を上書きせず、明示的な全体復帰の間だけ選択値を使う。
            self.bundle_mixing_override = true;
            self.bundle_prepared_voice = false;
            let applied = apply(self);
            self.bundle_mixing_override = false;
            self.bundle_prepared_voice = false;
            let value = applied.map_err(anyhow::Error::msg)?;
            // 両ラックと出力の再開確認後も全体ミュートを保持する。
            anyhow::ensure!(self.is_global_muted, "復帰中に全体ミュートが変更されました");
            self.post_mix.commit_bundle(&target.post_mix)?;
            self.mixing.persist(target.input.as_ref())?;
            Ok(value)
        })();
        result.map_err(|error| {
            if changed {
                if self.stop().is_err() { self.kill_engine(); }
                self.is_global_muted = true;
                let mix_current = self.mixing.file_checkpoint();
                let post_current = self.post_mix.file_checkpoint();
                let post_rollback = rollback_settings(&post_original.0, &post_original.1, &post_current.1);
                let mix_rollback = rollback_settings(&mix_original.0, &mix_original.1, &mix_current.1);
                self.post_mix.kill();
                if let Some(root) = self.last_config_path.parent() {
                    self.post_mix = post_mix::State::new(root);
                    self.mixing = mixing::State::new(root);
                }
                if post_rollback.is_err() || mix_rollback.is_err() {
                    return format!("{error}。設定の外部変更または復帰失敗があります。送出を停止し、全体保存の原本を保持しています");
                }
            }
            error.to_string()
        })
    }
}
#[cfg(test)]
#[path = "mixing_bundle_tests.rs"]
mod tests;
