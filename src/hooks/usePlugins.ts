import { useState, useCallback, useEffect, useRef } from 'react';
import { audioApi, VstPlugin } from '../api/audio';
import { Plugin } from '../components/features/PluginRack/PluginCard';
import { usePluginProfiles } from './usePluginProfiles';
import { restorePluginSession } from '../lib/restorePluginSession';
import { toast } from 'sonner';
import { REVIEW_KEY } from '../api/migration';
import { usePluginSessionPersistence } from './usePluginSessionPersistence';

export const usePlugins = () => {
    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [availablePlugins, setAvailablePlugins] = useState<VstPlugin[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isSessionLoaded, setIsSessionLoaded] = useState(false);
    const sessionRestorePending = useRef(false);

    usePluginSessionPersistence(plugins, isSessionLoaded, isLoading || isScanning);

    const resetPlugins = useCallback(() => {
        setPlugins([]);
        setIsSessionLoaded(false);
    }, []);

    const restoreSavedSession = useCallback(async (excludePath?: string | null) => {
        if (sessionRestorePending.current) return;
        sessionRestorePending.current = true;
        const saved = localStorage.getItem('vst_host_session_plugins');
        setIsLoading(true);
        setError(null);
        try {
            if (saved) {
                const failures = await restorePluginSession(JSON.parse(saved), setPlugins, excludePath);
                if (failures > 0) setError(`${failures}件のVSTを復元できませんでした。現在のラックを確認してください。`);
            }
        } catch (error) {
            console.error('セッションの復元に失敗しました', error);
            setError('セッションの復元に失敗しました。現在のラックを確認してください。');
            toast.error('セッションの復元に失敗しました');
        } finally {
            sessionRestorePending.current = false;
            setIsLoading(false);
            setIsSessionLoaded(true);
        }
    }, []);

    const restoreSession = useCallback(async () => {
        if (localStorage.getItem(REVIEW_KEY) !== 'true') await restoreSavedSession();
    }, [restoreSavedSession]);
    const recoverSession = restoreSavedSession;

    // Restore Session (initial load)
    const restoreStarted = useRef(false);

    useEffect(() => {
        const confirmed = () => { void restoreSession(); };
        window.addEventListener('migration-review-completed', confirmed);
        if (!restoreStarted.current) {
            restoreStarted.current = true;
            restoreSession();
        }
        return () => window.removeEventListener('migration-review-completed', confirmed);
    }, [restoreSession]);

    const scanPlugins = useCallback(async () => {
        setIsScanning(true);
        setError(null);
        try {
            const result = await audioApi.scanPlugins();
            setAvailablePlugins(result);
        } catch (err) {
            console.error("Failed to scan plugins:", err);
            setError("プラグインのスキャンに失敗しました。");
        } finally {
            setIsScanning(false);
        }
    }, []);

    const addPlugin = useCallback(async (vstPlugin: VstPlugin) => {
        setIsLoading(true);
        try {
            // Track pending plugin for crash recovery
            localStorage.setItem('vst_host_pending_plugin', vstPlugin.path); // Track pending

            const instanceId = await audioApi.loadPlugin(vstPlugin.path);

            localStorage.removeItem('vst_host_pending_plugin'); // Cleared on success

            const newPlugin: Plugin = {
                id: instanceId,
                name: vstPlugin.name,
                path: vstPlugin.path,
                vendor: vstPlugin.vendor,
                version: vstPlugin.version,
                enabled: true,
                hasEditor: true,
                muted: false,
                gain: 1.0,
            };

            setPlugins(prev => [...prev, newPlugin]);
            return true;
        } catch (e) {
            console.error("Failed to load plugin:", e);
            localStorage.removeItem('vst_host_pending_plugin'); // Also clear on caught error
            setError(`プラグインのロードに失敗しました: ${e}`);
            return false;
        } finally {
            setIsLoading(false);
        }
    }, []);

    const removePlugin = useCallback(async (id: string) => {
        const pluginToRemove = plugins.find(p => p.id === id);
        if (!pluginToRemove) return;

        try {
            // 1. Capture State for Undo
            let savedState: string | undefined;
            try {
                savedState = await audioApi.getPluginState(id);
            } catch (e) {
                console.warn("Could not save state for undo", e);
            }

            // 2. Remove from Engine
            await audioApi.removePlugin(id);

            // 3. Update UI
            setPlugins(prev => prev.filter(p => p.id !== id));

            // 4. Show Undo Toast
            toast.success(`${pluginToRemove.name} を削除しました`, {
                action: {
                    label: "元に戻す",
                    onClick: async () => {
                        const toastId = toast.loading(`${pluginToRemove.name} を復元中...`);
                        try {
                            // Restore Plugin
                            const newId = await audioApi.loadPlugin(pluginToRemove.path);

                            // Restore Parameters
                            if (!pluginToRemove.enabled) await audioApi.setBypass(newId, true);
                            if (pluginToRemove.muted) await audioApi.setMute(newId, true);
                            if (pluginToRemove.gain !== 1.0) await audioApi.setGain(newId, pluginToRemove.gain);

                            // Restore Internal State
                            if (savedState) {
                                await audioApi.setPluginState(newId, savedState);
                            }

                            // Add back to list (Append to end)
                            const restoredPlugin = { ...pluginToRemove, id: newId };
                            setPlugins(prev => [...prev, restoredPlugin]);

                            toast.success("復元しました", { id: toastId });
                        } catch (e) {
                            console.error("Undo failed", e);
                            toast.error("復元に失敗しました", { id: toastId });
                        }
                    }
                },
                duration: 5000, // 5 seconds to undo
            });

        } catch (e) {
            console.error("Failed to remove plugin", e);
            setError("プラグインの削除に失敗しました");
        }
    }, [plugins]);

    const togglePlugin = useCallback(async (id: string, enabled: boolean) => {
        try {
            await audioApi.setBypass(id, !enabled); // API uses "bypass" (true = disabled)
            setPlugins(prev => prev.map(p => p.id === id ? { ...p, enabled } : p));
        } catch (e) {
            console.error("Failed to toggle plugin:", e);
            // Revert
            setPlugins(prev => prev.map(p => p.id === id ? { ...p, enabled: !enabled } : p));
        }
    }, []);

    const reorderPlugins = useCallback(async (newPlugins: Plugin[]) => {
        const previousPlugins = [...plugins];
        // Optimistic update
        setPlugins(newPlugins);
        try {
            const ids = newPlugins.map(p => p.id);
            await audioApi.reorderPlugins(ids);
        } catch (e) {
            console.error("Failed to reorder plugins:", e);
            setError("並べ替えに失敗しました。元に戻します。");
            // Rollback
            setPlugins(previousPlugins);
        }
    }, [plugins]);

    const openEditor = useCallback(async (id: string) => {
        const target = plugins.find(p => p.id === id);

        const reloadAllFromUi = async () => {
            const reloaded: Plugin[] = [];
            for (const p of plugins) {
                const newId = await audioApi.loadPlugin(p.path);
                if (!p.enabled) await audioApi.setBypass(newId, true);
                if (p.muted) await audioApi.setMute(newId, true);
                if (p.gain !== 1.0) await audioApi.setGain(newId, p.gain);
                reloaded.push({ ...p, id: newId });
            }
            setPlugins(reloaded);
            return reloaded;
        };

        try {
            await audioApi.openEditor(id);
        } catch (e) {
            const message = `${e}`;
            console.error(`Failed to open editor for ${id}`, e);

            // If the engine got restarted/crashed, all plugin IDs become invalid.
            if (message.includes("loaded_count=0")) {
                if (!target) {
                    toast.error("エディタを開けませんでした", { description: message });
                    return;
                }

                const toastId = toast.loading("エンジン再起動を検知。プラグインを復元中...");
                try {
                    const reloaded = await reloadAllFromUi();
                    const reopened = reloaded.find(p => p.path === target.path);
                    if (!reopened) {
                        throw new Error("復元後に対象プラグインが見つかりませんでした");
                    }
                    await audioApi.openEditor(reopened.id);
                    toast.success("エディタを開きました", { id: toastId });
                    return;
                } catch (err) {
                    toast.error("プラグイン復元に失敗しました", { id: toastId, description: `${err}` });
                    return;
                }
            }

            // Single plugin re-load fallback (stale id or removed plugin)
            if (message.includes("Plugin not found") && target) {
                const toastId = toast.loading("プラグインを再読み込み中...");
                try {
                    const newId = await audioApi.loadPlugin(target.path);
                    if (!target.enabled) await audioApi.setBypass(newId, true);
                    if (target.muted) await audioApi.setMute(newId, true);
                    if (target.gain !== 1.0) await audioApi.setGain(newId, target.gain);

                    setPlugins(prev => prev.map(p => p.id === id ? { ...p, id: newId } : p));
                    await audioApi.openEditor(newId);
                    toast.success("エディタを開きました", { id: toastId });
                    return;
                } catch (err) {
                    toast.error("再読み込みに失敗しました", { id: toastId, description: `${err}` });
                    return;
                }
            }

            toast.error("エディタを開けませんでした", {
                description: message,
            });
        }
    }, [plugins]);

    const toggleMute = useCallback(async (id: string, muted: boolean) => {
        try {
            await audioApi.setMute(id, muted);
            setPlugins(prev => prev.map(p => p.id === id ? { ...p, muted } : p));
        } catch (e) {
            console.error("Failed to mute plugin:", e);
            // Revert
            setPlugins(prev => prev.map(p => p.id === id ? { ...p, muted: !muted } : p));
        }
    }, []);

    const setPluginGain = useCallback(async (id: string, gain: number) => {
        const plugin = plugins.find(p => p.id === id);
        if (!plugin) return;
        const previousGain = plugin.gain;

        try {
            // Optimistic update
            setPlugins(prev => prev.map(p => p.id === id ? { ...p, gain } : p));
            await audioApi.setGain(id, gain);
        } catch (e) {
            console.error("Failed to set plugin gain:", e);
            // Rollback
            setPlugins(prev => prev.map(p => p.id === id ? { ...p, gain: previousGain } : p));
        }
    }, [plugins]);

    const { savePreset, saveProfile, loadPreset, applyProfile, restoreBackupProfile } =
        usePluginProfiles(plugins, setPlugins, setIsLoading, setError);

    const savePluginState = useCallback(async (id: string) => {
        try {
            const state = await audioApi.getPluginState(id);
            return state;
        } catch (e) {
            console.error(`Failed to save state for ${id}`, e);
            return null;
        }
    }, []);

    const loadPluginState = useCallback(async (id: string, state: string) => {
        try {
            await audioApi.setPluginState(id, state);
            return true;
        } catch (e) {
            console.error(`Failed to load state for ${id}`, e);
            return false;
        }
    }, []);

    const applyTemplate = useCallback(async (mapping: Record<string, VstPlugin>) => {
        setIsLoading(true);
        setError(null);
        try {
            // 1. Clear current plugins
            const currentIds = plugins.map(p => p.id);
            for (const id of currentIds) {
                await audioApi.removePlugin(id);
                // 途中で削除が失敗しても、削除済みのVSTをラックへ残さない。
                setPlugins(prev => prev.filter(plugin => plugin.id !== id));
            }

            // 2. Load new plugins in order of slots
            const sortedIndexes = Object.keys(mapping).map(Number).sort((a, b) => a - b);

            const loadedPlugins: Plugin[] = [];
            let failedCount = 0;
            for (const idx of sortedIndexes) {
                const vst = mapping[idx];
                if (!vst) continue;

                try {
                    // Load plugin for slot
                    const instanceId = await audioApi.loadPlugin(vst.path);

                    loadedPlugins.push({
                        id: instanceId,
                        name: vst.name,
                        path: vst.path,
                        vendor: vst.vendor,
                        version: vst.version,
                        enabled: true,
                        hasEditor: true,
                        muted: false,
                        gain: 1.0,
                    });
                } catch (e) {
                    failedCount += 1;
                    console.error(`Failed to load plugin for slot ${idx}`, e);
                    toast.error(`Slot ${idx + 1} (${vst.name}) の読み込みに失敗しました`);
                }
            }
            setPlugins(loadedPlugins);
            // 一部だけ読み込めた場合も、画面を閉じずラックの確認と再試行へつなぐ。
            if (failedCount > 0) {
                setError(`${failedCount}件のVSTを読み込めませんでした。現在のラックを確認してください。`);
                return false;
            }
            return true;
        } catch (e) {
            console.error("Failed to apply template:", e);
            setError("テンプレートの適用に失敗しました");
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [plugins]);

    return {
        plugins,
        availablePlugins,
        scanPlugins,
        addPlugin,
        removePlugin,
        togglePlugin,
        reorderPlugins,
        openEditor,
        toggleMute,
        setPluginGain,
        savePreset,
        saveProfile,
        loadPreset,
        applyProfile,
        restoreBackupProfile,
        savePluginState,
        loadPluginState,
        applyTemplate,
        isLoading,
        isScanning,
        error,
        restoreSession,
        recoverSession,
        resetPlugins
    };
};
