import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { audioApi } from '../api/audio';
import type { Plugin } from '../components/features/PluginRack/PluginCard';
import { presetApi, type PresetPlugin as ApiPresetPlugin, type ApplyProfileSummary, type ProfileSaveCategories, gatherProfileAudioExtras, syncLocalStateFromProfile } from '../api/presets';
import { toast } from 'sonner';

// 保存・構成置換を通常のラック操作から分離する。
export function usePluginProfiles(
    plugins: Plugin[],
    setPlugins: Dispatch<SetStateAction<Plugin[]>>,
    setIsLoading: Dispatch<SetStateAction<boolean>>,
    setError: Dispatch<SetStateAction<string | null>>,
) {
    const gatherPresetPlugins = useCallback(async (): Promise<ApiPresetPlugin[]> => {
        const presetPlugins: ApiPresetPlugin[] = [];
        for (const p of plugins) {
            // 不完全な状態で既存の保存データや復元用バックアップを上書きしない。
            const state = await audioApi.getPluginState(p.id);
            presetPlugins.push({
                path: p.path,
                name: p.name,
                vendor: p.vendor,
                version: p.version,
                enabled: p.enabled,
                muted: p.muted,
                gain: p.gain,
                state: state || undefined,
            });
        }
        return presetPlugins;
    }, [plugins]);

    const savePreset = useCallback(async (name: string) => {
        try {
            const presetPlugins = await gatherPresetPlugins();
            await presetApi.save(name, presetPlugins);
            return true;
        } catch (e) {
            console.error("Failed to save preset:", e);
            setError("プリセットの保存に失敗しました");
            return false;
        }
    }, [gatherPresetPlugins]);

    const saveProfile = useCallback(async (
        name: string,
        categories: ProfileSaveCategories,
        builtinFxAmount?: number,
    ) => {
        try {
            const presetPlugins = categories.includePlugins
                ? await gatherPresetPlugins()
                : [];
            await presetApi.saveProfile(
                name,
                categories,
                presetPlugins,
                gatherProfileAudioExtras(),
                builtinFxAmount,
            );
            return true;
        } catch (e) {
            console.error("Failed to save profile:", e);
            setError("プロファイルの保存に失敗しました");
            return false;
        }
    }, [gatherPresetPlugins]);

    const syncPluginsFromApplySummary = useCallback((summary: ApplyProfileSummary) => {
        const instances = summary.loadedPluginInstances ?? [];
        // プロファイルに plugins カテゴリが含まれていた場合、バックエンドは既存チェーンを
        // アンロード済み。全滅（missing のみ）でも UI を空チェーンへ同期する。
        const pluginsCategoryTouched =
            (summary.appliedCategories ?? []).includes('plugins') ||
            (summary.skippedCategories ?? []).includes('plugins') ||
            (summary.missingPlugins ?? []).length > 0;
        if (instances.length === 0 && !pluginsCategoryTouched) return;
        const loaded = instances.map(inst => ({
            id: inst.id,
            name: inst.name,
            path: inst.path,
            vendor: inst.vendor,
            version: inst.version,
            enabled: inst.enabled,
            muted: inst.muted,
            gain: inst.gain,
            hasEditor: true,
        }));
        setPlugins(loaded);
    }, []);

    const applyProfile = useCallback(async (
        name: string,
        deviceSubstitutions?: { inputDevice?: string; outputDevice?: string },
        options?: { skipBackup?: boolean },
    ) => {
        setIsLoading(true);
        try {
            const backupPlugins = await gatherPresetPlugins();
            const currentIds = plugins.map(p => p.id);
            const summary = await presetApi.applyProfile(name, currentIds, backupPlugins, {
                deviceSubstitutions,
                skipBackup: options?.skipBackup,
            });
            syncLocalStateFromProfile(summary);
            syncPluginsFromApplySummary(summary);
            return summary;
        } catch (e) {
            console.error("Failed to apply profile:", e);
            setError("プロファイルの適用に失敗しました");
            return null;
        } finally {
            setIsLoading(false);
        }
    }, [plugins, gatherPresetPlugins, syncPluginsFromApplySummary]);

    const restoreBackupProfile = useCallback(async () => {
        setIsLoading(true);
        try {
            const backupPlugins = await gatherPresetPlugins();
            const currentIds = plugins.map(p => p.id);
            const summary = await presetApi.restoreBackup(currentIds, backupPlugins);
            syncLocalStateFromProfile(summary);
            syncPluginsFromApplySummary(summary);
            return summary;
        } catch (e) {
            console.error("Failed to restore backup:", e);
            setError("バックアップの復元に失敗しました");
            return null;
        } finally {
            setIsLoading(false);
        }
    }, [plugins, gatherPresetPlugins, syncPluginsFromApplySummary]);

    const loadPreset = useCallback(async (name: string) => {
        setIsLoading(true);
        setError(null);
        try {
            const preset = await presetApi.load(name);
            // Loading preset - clear current plugins and apply

            // 1. Clear current plugins
            const currentIds = plugins.map(p => p.id);
            for (const id of currentIds) {
                await audioApi.removePlugin(id);
                setPlugins(previous => previous.filter(plugin => plugin.id !== id));
            }
            // Clear state immediately to avoid UI mismatch during async load
            setPlugins([]);

            // 2. Load new plugins
            const loadedPlugins: Plugin[] = [];
            let failedCount = 0;
            for (const p of preset.plugins) {
                let instance: Plugin | null = null;
                try {
                    const instanceId = await audioApi.loadPlugin(p.path);
                    instance = {
                        id: instanceId,
                        name: p.name,
                        path: p.path,
                        vendor: p.vendor,
                        version: p.version,
                        enabled: true,
                        hasEditor: true,
                        muted: false,
                        gain: 1,
                    };
                    // 途中失敗時にも、存在するインスタンスをラックから見失わない。
                    loadedPlugins.push(instance);
                    if (!p.enabled) {
                        await audioApi.setBypass(instanceId, true);
                        instance.enabled = false;
                    }
                    if (p.muted) {
                        await audioApi.setMute(instanceId, true);
                        instance.muted = true;
                    }
                    if (p.gain !== 1.0) {
                        await audioApi.setGain(instanceId, p.gain);
                        instance.gain = p.gain;
                    }
                    if (p.state !== undefined) await audioApi.setPluginState(instanceId, p.state);
                } catch (err) {
                    failedCount += 1;
                    if (instance) {
                        try {
                            await audioApi.removePlugin(instance.id);
                            loadedPlugins.splice(loadedPlugins.indexOf(instance), 1);
                        } catch (cleanupError) {
                            setPlugins([...loadedPlugins]);
                            throw cleanupError;
                        }
                    }
                    console.error(`Failed to load plugin from preset: ${p.name}`, err);
                    toast.error(`${p.name} の読み込みに失敗しました`);
                }
                setPlugins([...loadedPlugins]);
            }
            if (failedCount > 0) {
                setError(`${failedCount}件のVSTを復元できませんでした。現在のラックを確認してください。`);
                return false;
            }
            return true;
        } catch (e) {
            console.error("Failed to load preset:", e);
            setError("プリセットの読み込みに失敗しました");
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [plugins]);

    return { savePreset, saveProfile, loadPreset, applyProfile, restoreBackupProfile };
}
