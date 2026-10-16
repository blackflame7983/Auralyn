//! フルプロファイルの保存・適用オーケストレーション

use crate::audio::AudioHost;
use crate::vst_host::presets::{
    self, ApplyProfileSummary, DeviceSubstitutions, LoadedPluginInstance, MissingDevice,
    MissingPlugin, Preset, PresetPlugin, ProfileAudioConfig, ProfileAudioExtras, ProfileBuiltinFx,
    ProfileNoiseControl, ProfileSaveCategories, BACKUP_PROFILE_NAME,
};
use std::path::Path;

/// 現在のランタイム状態からフルプロファイルを収集する
pub fn capture_current_profile(
    host: &mut AudioHost,
    name: String,
    plugins: Vec<PresetPlugin>,
    audio_extras: Option<ProfileAudioExtras>,
) -> Result<Preset, String> {
    let state = host.get_state();
    let stats = host
        .get_engine_runtime_stats()
        .unwrap_or_default();

    let extras = audio_extras.unwrap_or_default();
    let input_channels = extras
        .input_channels
        .filter(|c| c.len() >= 2)
        .unwrap_or_else(|| vec![0, 1]);

    // エンジン停止中は架空のデバイス設定を作らない（audioConfig を含めない）
    let audio_config = state.config.map(|active| ProfileAudioConfig {
        host: active.host.clone(),
        input_device: active.input.clone(),
        output_device: active.output.clone(),
        sample_rate: active.sample_rate.unwrap_or(48000),
        buffer_size: active.buffer_size.unwrap_or(512),
        input_channels,
        input_gain_db: extras.input_gain_db.unwrap_or(0.0),
        master_gain_db: extras.master_gain_db.unwrap_or(0.0),
    });

    let noise_control = ProfileNoiseControl {
        enabled: stats.noise_reduction_enabled,
        mode: stats.noise_reduction_mode.clone(),
        strength: stats.noise_control_strength,
        voice_guard: stats.noise_voice_guard,
        learned_profile: None, // 学習プロファイルは環境依存のため既定で除外
    };

    let builtin_fx = ProfileBuiltinFx {
        preset: stats.built_in_effects_preset.clone(),
        enabled: stats.built_in_effects_enabled,
        amount: stats.built_in_effects_amount,
    };

    Ok(Preset::build_from_parts(
        name,
        &ProfileSaveCategories {
            include_plugins: true,
            include_audio_config: true,
            include_noise_control: true,
            include_builtin_fx: true,
        },
        plugins,
        audio_config,
        Some(noise_control),
        Some(builtin_fx),
    ))
}

/// 適用前に現状をバックアップ
pub fn backup_current_profile(
    config_dir: &Path,
    host: &mut AudioHost,
    plugins: Vec<PresetPlugin>,
    audio_extras: Option<ProfileAudioExtras>,
) -> Result<(), String> {
    let backup = capture_current_profile(host, BACKUP_PROFILE_NAME.to_string(), plugins, audio_extras)?;
    presets::save_preset(config_dir, BACKUP_PROFILE_NAME, &backup)
}

/// プロファイルを適用（カテゴリ欠落 = そのカテゴリは変更しない）
#[expect(
    clippy::too_many_arguments,
    reason = "既存の公開Rust関数の引数契約を維持する"
)]
pub fn apply_profile(
    config_dir: &Path,
    host: &mut AudioHost,
    profile: &Preset,
    substitutions: Option<DeviceSubstitutions>,
    skip_backup: bool,
    backup_plugins: Vec<PresetPlugin>,
    backup_audio_extras: Option<ProfileAudioExtras>,
    current_plugin_ids: &[String],
) -> Result<ApplyProfileSummary, String> {
    if !skip_backup {
        backup_current_profile(config_dir, host, backup_plugins.clone(), backup_audio_extras)?;
    }

    let mut summary = ApplyProfileSummary::default();
    let subs = substitutions.unwrap_or_default();

    // 再起動時の復元用に、プロファイルに含まれないカテゴリの現在値を控えておく
    // （エンジン再起動でノイズ/FX/VST はすべて初期化されるため）
    let pre_stats = host.get_engine_runtime_stats().ok();

    // デバイス一覧を取得（欠落チェック用）
    let devices = host.enumerate_devices(false).map_err(|e| e.to_string())?;
    let input_names: Vec<String> = devices.inputs.iter().map(|d| d.name.clone()).collect();
    let output_names: Vec<String> = devices.outputs.iter().map(|d| d.name.clone()).collect();

    let state = host.get_state();
    let current = state.config.as_ref();

    // --- オーディオ設定 ---
    if let Some(ref audio_cfg) = profile.audio_config {
        let mut resolved = audio_cfg.clone();
        let mut can_apply_audio = true;

        if let Some(ref input) = resolved.input_device {
            let use_name = subs
                .input_device
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(input.as_str());
            if !presets::device_exists(use_name, true, &input_names, &output_names) {
                summary.missing_devices.push(MissingDevice {
                    role: "input".to_string(),
                    name: input.clone(),
                });
                can_apply_audio = false;
            } else {
                resolved.input_device = Some(use_name.to_string());
            }
        }

        if let Some(ref output) = resolved.output_device {
            let use_name = subs
                .output_device
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(output.as_str());
            if !presets::device_exists(use_name, false, &input_names, &output_names) {
                summary.missing_devices.push(MissingDevice {
                    role: "output".to_string(),
                    name: output.clone(),
                });
                can_apply_audio = false;
            } else {
                resolved.output_device = Some(use_name.to_string());
            }
        }

        if can_apply_audio {
            let differs = presets::audio_config_differs(
                current.map(|c| c.host.as_str()),
                current.and_then(|c| c.input.as_deref()),
                current.and_then(|c| c.output.as_deref()),
                current.and_then(|c| c.buffer_size),
                current.and_then(|c| c.sample_rate),
                &resolved,
            );

            if differs {
                summary.needs_engine_restart = true;
                host.kill_engine();
                host.start(
                    Some(resolved.host.clone()),
                    resolved.input_device.clone(),
                    resolved.output_device.clone(),
                    Some(resolved.buffer_size),
                    Some(resolved.sample_rate),
                )
                .map_err(|e| e.to_string())?;

                // 再起動で消えた設定のうち、プロファイルに含まれない
                // カテゴリは適用前の状態を復元する（カテゴリ欠落 = 変更しない）
                if let Some(ref stats) = pre_stats {
                    if profile.noise_control.is_none() {
                        let _ = host.set_noise_control_config(
                            stats.noise_reduction_enabled,
                            stats.noise_reduction_mode.clone(),
                            stats.noise_control_strength,
                            stats.noise_voice_guard,
                        );
                    }
                    if profile.builtin_fx.is_none() {
                        let _ = host.set_built_in_effects(
                            stats.built_in_effects_enabled,
                            Some(stats.built_in_effects_preset.clone()),
                            stats.built_in_effects_amount,
                        );
                    }
                }
                if profile.plugins.is_empty() && !backup_plugins.is_empty() {
                    let (instances, missing) = load_plugin_chain(host, &backup_plugins);
                    summary.loaded_plugin_instances = instances;
                    summary.missing_plugins.extend(missing);
                }
            }

            // ゲイン・チャンネルはエンジン再起動の有無に関わらず適用
            if resolved.input_channels.len() >= 2 {
                host.set_input_channels(resolved.input_channels[0], resolved.input_channels[1])
                    .map_err(|e| e.to_string())?;
            }
            host.set_input_gain(presets::db_to_linear(resolved.input_gain_db))
                .map_err(|e| e.to_string())?;
            host.set_output_gain(presets::db_to_linear(resolved.master_gain_db))
                .map_err(|e| e.to_string())?;

            summary.applied_audio_config = Some(resolved);
            summary.applied_categories.push("audioConfig".to_string());
        } else {
            summary.skipped_categories.push("audioConfig".to_string());
        }
    }

    // --- ノイズ抑制 ---
    if let Some(ref nc) = profile.noise_control {
        host.set_noise_control_config(
            nc.enabled,
            nc.mode.clone(),
            nc.strength,
            nc.voice_guard,
        )
        .map_err(|e| e.to_string())?;
        summary.applied_noise_control = Some(nc.clone());
        summary.applied_categories.push("noiseControl".to_string());
    }

    // --- 内蔵 FX ---
    if let Some(ref fx) = profile.builtin_fx {
        host.set_built_in_effects(
            fx.enabled,
            Some(fx.preset.clone()),
            fx.amount,
        )
        .map_err(|e| e.to_string())?;
        summary.applied_builtin_fx = Some(fx.clone());
        summary.applied_categories.push("builtinFx".to_string());
    }

    // --- VST チェーン ---
    if !profile.plugins.is_empty() {
        // 再起動していない場合のみ明示アンロードが必要（再起動済みなら空の状態）
        if !summary.needs_engine_restart {
            host.unload_all_plugins(current_plugin_ids);
        }

        let (loaded_instances, missing) = load_plugin_chain(host, &profile.plugins);
        summary.missing_plugins.extend(missing);
        if !loaded_instances.is_empty() {
            summary.applied_plugins = profile
                .plugins
                .iter()
                .filter(|p| loaded_instances.iter().any(|i| i.path == p.path))
                .cloned()
                .collect();
            summary.loaded_plugin_instances = loaded_instances;
            summary.applied_categories.push("plugins".to_string());
        } else {
            summary.skipped_categories.push("plugins".to_string());
        }
    }

    Ok(summary)
}

/// プラグインチェーンを順にロードし、(ロード済みインスタンス, 見つからなかったもの) を返す
fn load_plugin_chain(
    host: &mut AudioHost,
    plugins: &[PresetPlugin],
) -> (Vec<LoadedPluginInstance>, Vec<MissingPlugin>) {
    let mut loaded_instances = Vec::new();
    let mut missing = Vec::new();
    for p in plugins {
        match host.load_plugin(&p.path) {
            Ok(id) => {
                if !p.enabled {
                    let _ = host.set_bypass(&id, true);
                }
                if p.muted {
                    let _ = host.set_mute(&id, true);
                }
                if (p.gain - 1.0).abs() > f32::EPSILON {
                    let _ = host.set_gain(&id, p.gain);
                }
                if let Some(ref state) = p.state {
                    let _ = host.set_plugin_state(&id, state);
                }
                loaded_instances.push(LoadedPluginInstance {
                    id,
                    path: p.path.clone(),
                    name: p.name.clone(),
                    vendor: p.vendor.clone(),
                    version: p.version.clone(),
                    enabled: p.enabled,
                    muted: p.muted,
                    gain: p.gain,
                });
            }
            Err(_) => {
                missing.push(MissingPlugin {
                    name: p.name.clone(),
                    path: p.path.clone(),
                });
            }
        }
    }
    (loaded_instances, missing)
}
