//! 保存した構成（Tauri 版と同じ `presets/`）の一覧・保存・適用・削除・書き出し・読み込み。接続は扱わない。

use super::*;

impl Control {
    fn profile_entries(&self) -> anyhow::Result<Vec<ProfileEntry>> {
        let list = presets::list_profile_meta(&self.config_dir).map_err(anyhow::Error::msg)?;
        Ok(list
            .into_iter()
            .map(|meta| ProfileEntry {
                name: meta.name,
                has_plugins: meta.has_plugins,
                has_noise: meta.has_noise_control,
                has_effects: meta.has_builtin_fx,
                is_backup: meta.is_backup,
            })
            .collect())
    }

    pub(super) fn list_profiles(&mut self) {
        match self.profile_entries() {
            Ok(entries) => {
                let _ = self.notices.send(Notice::Profiles(entries));
            }
            Err(e) => self.fail("list_profiles", e),
        }
    }

    pub(super) fn delete_profile(&mut self, name: &str) {
        if let Err(e) = presets::delete_preset(&self.config_dir, name) {
            self.fail("delete_profile", anyhow::anyhow!(e));
        }
        self.list_profiles();
    }

    pub(super) fn export_profile(&mut self, name: &str, path: &Path) {
        let result = presets::load_preset(&self.config_dir, name)
            .map_err(anyhow::Error::msg)
            .and_then(|mut preset| {
                preset.audio_config = None;
                Ok(serde_json::to_string_pretty(&preset)?)
            })
            .and_then(|json| Ok(std::fs::write(path, json)?));
        match result {
            Ok(()) => self.tell(ProfileFile::Exported(name.to_owned())),
            Err(e) => self.fail("export_profile", e),
        }
    }

    pub(super) fn import_profile(&mut self, path: &Path) {
        match self.import_parts(path) {
            Ok(done) => {
                self.list_profiles();
                self.tell(done);
            }
            Err(e) => self.fail("import_profile", e),
        }
    }

    fn import_parts(&mut self, path: &Path) -> anyhow::Result<ProfileFile> {
        let mut preset: presets::Preset = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        let entries = self.profile_entries()?;
        let name = match save_name(&preset.name, &entries) {
            Ok(name) => name,
            Err(NameIssue::Exists) => return Ok(ProfileFile::Exists(preset.name)),
            Err(NameIssue::Empty) => anyhow::bail!("構成の名前がありません"),
        };
        preset.name = name.clone();
        presets::save_preset(&self.config_dir, &name, &preset).map_err(anyhow::Error::msg)?;
        Ok(ProfileFile::Imported(name))
    }

    fn tell(&self, done: ProfileFile) {
        let _ = self.notices.send(Notice::ProfileFile(done));
    }

    /// 今の並び（中の設定を取り直す）と音づくりを、構成の形にする。接続は含めない
    /// （GPUI 版は入出力の音量・チャンネルを Tauri 版の形で持たないので、違う値を保存しないため）。
    pub(super) fn capture_profile(&mut self, name: &str) -> anyhow::Result<presets::Preset> {
        // 子が落ちていると既定の音づくりが読めてしまうので、先に読み直す。
        self.recover();
        self.save(true);
        let plugins = self
            .rack
            .iter()
            .map(|slot| presets::PresetPlugin {
                path: slot.path.clone(),
                name: slot.name.clone(),
                vendor: String::new(),
                version: String::new(),
                enabled: slot.enabled,
                muted: slot.muted,
                gain: slot.gain,
                state: slot.state.clone(),
                class_id: slot.class_id.clone(),
            })
            .collect();
        let mut preset = vst_host_lib::profile::capture_current_profile(
            &mut self.host,
            name.to_owned(),
            plugins,
            None,
        )
        .map_err(anyhow::Error::msg)?;
        preset.audio_config = None;
        Ok(preset)
    }

    pub(super) fn save_profile(&mut self, name: &str) {
        let result = self.capture_profile(name).and_then(|preset| {
            presets::save_preset(&self.config_dir, name, &preset).map_err(anyhow::Error::msg)
        });
        if let Err(e) = result {
            self.fail("save_profile", e);
        }
        self.list_profiles();
    }

    /// 並びは今の VST を外して構成の VST を読み直し、音づくりは構成の値を送る（Tauri 版の適用と同じ呼び出し）。
    /// 構成に無い分類は変えない。読めなかった VST は「読めていない」枠として残す（起動時の復元と同じ）。
    pub(super) fn apply_profile(&mut self, name: &str, restore: bool) {
        // 子が落ちていたら先に読み直す（あとで読み直すと、落ちる前の音づくりで構成の値を上書きしてしまう）。
        self.recover();
        let result = self.apply_profile_parts(name, restore);
        if let Err(e) = result {
            self.fail("apply_profile", e);
        }
        // 次の起動もこの構成の音づくりで始まる。
        self.reread_and_save_sound();
        self.list_profiles();
    }

    /// 構成に無い分類は変えない。外せない VST があればそこで止める（画面から消えたまま鳴り続けないように）。
    pub(super) fn apply_profile_parts(&mut self, name: &str, restore: bool) -> anyhow::Result<()> {
        let profile = presets::load_preset(&self.config_dir, name).map_err(anyhow::Error::msg)?;
        if !restore {
            let backup = self.capture_profile(presets::BACKUP_PROFILE_NAME)?;
            presets::save_preset(&self.config_dir, presets::BACKUP_PROFILE_NAME, &backup)
                .map_err(anyhow::Error::msg)?;
        }
        if let Some(nc) = &profile.noise_control {
            self.host.set_noise_control_config(
                nc.enabled,
                nc.mode.clone(),
                nc.strength,
                nc.voice_guard,
            )?;
        }
        if let Some(fx) = &profile.builtin_fx {
            self.host.set_built_in_effects_from_profile(
                fx.enabled,
                Some(fx.preset.clone()),
                fx.amount,
                fx.singing,
                Some(fx.reverb.unwrap_or_default()),
                fx.deesser,
            )?;
        }
        if profile.includes_plugin_category() {
            // 位置がずれるので、古い ID では当てない。
            self.renamed.clear();
            let loaded: Vec<String> = self
                .rack
                .iter()
                .filter(|s| s.loaded)
                .map(|s| s.id.clone())
                .collect();
            for id in loaded {
                if let Err(e) = self.host.remove_plugin(&id) {
                    self.changed();
                    return Err(e);
                }
                self.rack.retain(|slot| slot.id != id);
            }
            self.rack.clear();
            for plugin in profile.plugins {
                self.restore(RestorePluginRequest {
                    path: plugin.path,
                    state: plugin.state,
                    bypassed: !plugin.enabled,
                    muted: plugin.muted,
                    gain: plugin.gain,
                    class_id: plugin.class_id,
                });
            }
            self.changed();
        }
        Ok(())
    }
}
