import { useMessages } from '../i18n/LocaleProvider';
import { pluginNotice, renderPluginNotice, defaultPluginMessages, type PluginNoticeSink, type PluginNoticeFormatter } from '../lib/pluginNotice';
import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { audioApi } from '../api/audio';
import type { Plugin } from '../components/features/PluginRack/PluginCard';
import { presetApi, type PresetPlugin as ApiPresetPlugin, type ApplyProfileSummary, type ProfileSaveCategories, gatherProfileAudioExtras, syncLocalStateFromProfile } from '../api/presets';
import { toast } from 'sonner';
import { liveModesApi } from '../api/liveModes';
import { beginRackRestore } from '../lib/liveRouting';
import { bundleApi, type BundleOperation } from '../api/bundles';

// 保存・構成置換を通常のラック操作から分離する。
export function usePluginProfiles(
    plugins: Plugin[],
    setPlugins: Dispatch<SetStateAction<Plugin[]>>,
    setIsLoading: Dispatch<SetStateAction<boolean>>,
    setError: Dispatch<SetStateAction<string | null>>,
    getGeneration: () => number = () => 0,
    noticeSink?: PluginNoticeSink,
) {
    const t = useMessages();
    const reportError = useCallback<PluginNoticeSink>(value => {
        if (noticeSink) noticeSink(value);
        else setError(value === null ? null : renderPluginNotice(defaultPluginMessages, value));
    }, [noticeSink, setError]);
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
                state,
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
            reportError(pluginNotice('pluginNotices.savePresetFailed'));
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
            reportError(pluginNotice('pluginNotices.saveProfileFailed'));
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
        options?: { skipBackup?: boolean; soundOnly?: boolean },
    ) => {
        const generation = getGeneration();
        const isCurrent = () => generation === getGeneration();
        const releaseRestore = beginRackRestore();
        let liveToken: string | undefined;
        setIsLoading(true);
        try {
            await liveModesApi.preflight();
            if (!isCurrent()) return null;
            liveToken = await liveModesApi.beginChanges();
            if (!isCurrent()) return null;
            const backupPlugins = await gatherPresetPlugins();
            if (!isCurrent()) return null;
            const currentIds = plugins.map(p => p.id);
            const summary = await presetApi.applyProfile(name, currentIds, backupPlugins, {
                deviceSubstitutions,
                skipBackup: options?.skipBackup,
                soundOnly: options?.soundOnly,
            });
            if (!isCurrent()) {
                for (const instance of summary.loadedPluginInstances ?? []) await audioApi.removePlugin(instance.id);
                return null;
            }
            syncLocalStateFromProfile(summary);
            syncPluginsFromApplySummary(summary);
            return summary;
        } catch (e) {
            if (!isCurrent()) return null;
            console.error("Failed to apply profile:", e);
            reportError(pluginNotice('pluginNotices.applyProfileFailed'));
            return null;
        } finally {
            if (liveToken) await finishLiveChanges(liveToken, reportError, t);
            releaseRestore();
            if (isCurrent()) setIsLoading(false);
        }
    }, [plugins, gatherPresetPlugins, syncPluginsFromApplySummary, getGeneration]);

    const restoreBackupProfile = useCallback(async () => {
        const generation = getGeneration();
        const isCurrent = () => generation === getGeneration();
        const releaseRestore = beginRackRestore();
        let liveToken: string | undefined;
        setIsLoading(true);
        try {
            await liveModesApi.preflight();
            if (!isCurrent()) return null;
            liveToken = await liveModesApi.beginChanges();
            if (!isCurrent()) return null;
            const backupPlugins = await gatherPresetPlugins();
            if (!isCurrent()) return null;
            const currentIds = plugins.map(p => p.id);
            const summary = await presetApi.restoreBackup(currentIds, backupPlugins);
            if (!isCurrent()) {
                for (const instance of summary.loadedPluginInstances ?? []) await audioApi.removePlugin(instance.id);
                return null;
            }
            syncLocalStateFromProfile(summary);
            syncPluginsFromApplySummary(summary);
            return summary;
        } catch (e) {
            if (!isCurrent()) return null;
            console.error("Failed to restore backup:", e);
            reportError(pluginNotice('pluginNotices.restoreBackupFailed'));
            return null;
        } finally {
            if (liveToken) await finishLiveChanges(liveToken, reportError, t);
            releaseRestore();
            if (isCurrent()) setIsLoading(false);
        }
    }, [plugins, gatherPresetPlugins, syncPluginsFromApplySummary, getGeneration]);

    const loadPreset = useCallback(async (name: string) => {
        const generation = getGeneration();
        const isCurrent = () => generation === getGeneration();
        const releaseRestore = beginRackRestore();
        let liveToken: string | undefined;
        setIsLoading(true);
        reportError(null);
        try {
            await liveModesApi.preflight();
            if (!isCurrent()) return false;
            liveToken = await liveModesApi.beginChanges();
            if (!isCurrent()) return false;
            const preset = await presetApi.load(name);
            if (!isCurrent()) return false;
            // Loading preset - clear current plugins and apply

            // 1. Clear current plugins
            const currentIds = plugins.map(p => p.id);
            for (const id of currentIds) {
                await audioApi.removePlugin(id);
                if (!isCurrent()) return false;
                setPlugins(previous => previous.filter(plugin => plugin.id !== id));
            }
            // Clear state immediately to avoid UI mismatch during async load
            setPlugins([]);

            // 2. Load new plugins
            const loadedPlugins: Plugin[] = [];
            let failedCount = 0;
            for (const p of preset.plugins) {
                if (!isCurrent()) return false;
                let instance: Plugin | null = null;
                try {
                    const restored = await audioApi.restorePlugin({ path: p.path, state: p.state ?? null,
                        bypassed: !p.enabled, muted: p.muted, gain: p.gain });
                    instance = { ...p, id: restored.id, hasEditor: true };
                    if (!isCurrent()) { await audioApi.removePlugin(restored.id); return false; }
                    loadedPlugins.push(instance);
                } catch (err) {
                    if (!isCurrent()) return false;
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
                    toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.pluginLoadFailed', { name: p.name }, false)));
                }
                setPlugins([...loadedPlugins]);
            }
            if (failedCount > 0) {
                reportError(pluginNotice('pluginNotices.restoreCountFailed', { count: failedCount }, false));
                return false;
            }
            return true;
        } catch (e) {
            if (!isCurrent()) return false;
            console.error("Failed to load preset:", e);
            reportError(pluginNotice('pluginNotices.loadPresetFailed'));
            return false;
        } finally {
            if (liveToken) await finishLiveChanges(liveToken, reportError, t);
            releaseRestore();
            if (isCurrent()) setIsLoading(false);
        }
    }, [plugins, getGeneration]);

    const runBundle = useCallback(async (request: BundleOperation) => {
        const generation = getGeneration();
        const isCurrent = () => generation === getGeneration();
        const release = beginRackRestore();
        setIsLoading(true);
        reportError(null);
        try {
            // Begin/Endはbundle commandがexact tokenを所有する。UIで二重予約しない。
            const result = await bundleApi.operation(request);
            if (!isCurrent()) {
                for (const instance of result.summary?.loadedPluginInstances ?? []) await audioApi.removePlugin(instance.id);
                return null;
            }
            const current = result.current ?? result.summary;
            if (current) {
                syncPluginsFromApplySummary(current);
            }
            if (result.complete && result.summary) {
                const summary = result.summary;
                // currentは実ラック表示専用。未選択・未確認の設定を保存値へ昇格しない。
                syncLocalStateFromProfile({
                    ...summary,
                    appliedAudioConfig: summary.appliedCategories.includes('audioConfig') ? summary.appliedAudioConfig : undefined,
                    appliedNoiseControl: summary.appliedCategories.includes('noiseControl') ? summary.appliedNoiseControl : undefined,
                    appliedBuiltinFx: summary.appliedCategories.includes('builtinFx') ? summary.appliedBuiltinFx : undefined,
                });
            }
            if (!result.complete) reportError(pluginNotice('pluginNotices.bundleIncomplete'));
            return result;
        } catch (error) {
            if (isCurrent()) reportError(pluginNotice('pluginNotices.bundleUnconfirmed'));
            throw error;
        } finally {
            release();
            if (isCurrent()) setIsLoading(false);
        }
    }, [getGeneration, syncPluginsFromApplySummary]);

    return { savePreset, saveProfile, loadPreset, applyProfile, restoreBackupProfile, runBundle };
}

async function finishLiveChanges(token: string, setError: PluginNoticeSink, t: PluginNoticeFormatter = defaultPluginMessages) {
    try { await liveModesApi.endChanges(token); }
    catch {
        setError(pluginNotice('pluginNotices.endUnconfirmed'));
        toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.endFailed')), { action: { label: t('pluginNotices.retryEnd'), onClick: () => { void finishLiveChanges(token, setError, t); } } });
    }
}
