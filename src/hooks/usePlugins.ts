import { useState, useCallback, useEffect, useRef } from 'react';
import { audioApi, VstPlugin } from '../api/audio';
import { Plugin } from '../components/features/PluginRack/PluginCard';
import { presetApi, PresetPlugin as ApiPresetPlugin } from '../api/presets';
import { toast } from 'sonner';

export const usePlugins = () => {
    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [availablePlugins, setAvailablePlugins] = useState<VstPlugin[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isSessionLoaded, setIsSessionLoaded] = useState(false);

    // Persist Session (Debounced + Periodic)
    useEffect(() => {
        if (!isSessionLoaded) return;

        const saveSession = async () => {
            // console.log("Auto-saving session...");
            const sessionData = await Promise.all(plugins.map(async p => {
                let state: string | undefined;
                try {
                    // Always try to get fresh state from backend
                    state = await audioApi.getPluginState(p.id);
                } catch (e) {
                    console.warn(`Session save: Could not get state for ${p.id}`);
                }
                return {
                    path: p.path,
                    name: p.name,
                    vendor: p.vendor,
                    version: p.version,
                    enabled: p.enabled,
                    muted: p.muted,
                    gain: p.gain,
                    state
                };
            }));
            localStorage.setItem('vst_host_session_plugins', JSON.stringify(sessionData));
            // console.log("Session saved.");
        };

        // 1. Debounced save on structure change
        const timeoutId = setTimeout(saveSession, 2000);

        // 2. Periodic save (every 30s) to capture internal VST parameter changes
        const intervalId = setInterval(saveSession, 30000);

        return () => {
            clearTimeout(timeoutId);
            clearInterval(intervalId);
        };
    }, [plugins, isSessionLoaded]);

    const resetPlugins = useCallback(() => {
        setPlugins([]);
        setIsSessionLoaded(false);
    }, []);

    const restoreSession = useCallback(async () => {
        const saved = localStorage.getItem('vst_host_session_plugins');
        if (saved) {
            try {
                setIsLoading(true);
                const items = JSON.parse(saved);
                if (items.length > 0) {
                    console.time("Parallel Plugin Restore");

                    // Parallel Load
                    const results = await Promise.allSettled(items.map(async (item: any) => {
                        // Skip if no path
                        if (!item.path) return null;

                        localStorage.setItem('vst_host_pending_plugin', item.path);
                        const id = await audioApi.loadPlugin(item.path);
                        localStorage.removeItem('vst_host_pending_plugin');

                        // Apply state (fire and forget setting updates to speed up?)
                        // Better to await to ensure consistency, but we can parallelize these too within the item scope.
                        const updates: Promise<any>[] = [];
                        if (!item.enabled) updates.push(audioApi.setBypass(id, true));
                        if (item.muted) updates.push(audioApi.setMute(id, true));
                        if (item.gain !== 1.0) updates.push(audioApi.setGain(id, item.gain));
                        if (item.state) updates.push(audioApi.setPluginState(id, item.state).catch(e => console.error(`Failed to state ${item.name}`, e)));

                        await Promise.all(updates);

                        return {
                            id,
                            name: item.name,
                            path: item.path,
                            vendor: item.vendor,
                            version: item.version,
                            enabled: item.enabled,
                            muted: item.muted,
                            gain: item.gain,
                            hasEditor: true
                        } as Plugin;
                    }));

                    const loaded: Plugin[] = [];
                    results.forEach((res: PromiseSettledResult<Plugin | null>, index: number) => {
                        if (res.status === 'fulfilled' && res.value) {
                            loaded.push(res.value);
                        } else if (res.status === 'rejected') {
                            const item = items[index];
                            console.error(`Failed to restore plugin ${item.name}`, res.reason);
                            toast.error(`${item.name} の復元に失敗しました`);
                            localStorage.removeItem('vst_host_pending_plugin');
                        }
                    });

                    if (loaded.length > 0) setPlugins(loaded);
                    console.timeEnd("Parallel Plugin Restore");
                }
            } catch (e) {
                console.error("Session restore failed", e);
            } finally {
                setIsLoading(false);
            }
        }
        setIsSessionLoaded(true);
    }, []);

    const recoverSession = useCallback(async (excludePath?: string | null) => {
        const saved = localStorage.getItem('vst_host_session_plugins');
        if (saved) {
            try {
                // Ensure engine is fresh (resetPlugins should have been called)
                // We assume start() was called or engine restarted.
                // Actually we might need to restart engine here? 
                // App.tsx handles engine lifecycle usually.

                setIsLoading(true);
                const items = JSON.parse(saved);
                const loaded: Plugin[] = [];

                for (const item of items) {
                    // Skip excluded plugin
                    if (excludePath && item.path === excludePath) {
                        console.warn(`Skipping problematic plugin: ${item.name}`);
                        toast.warning(`問題のプラグインをスキップしました: ${item.name}`);
                        continue;
                    }

                    try {
                        localStorage.setItem('vst_host_pending_plugin', item.path);
                        const id = await audioApi.loadPlugin(item.path);
                        localStorage.removeItem('vst_host_pending_plugin');

                        // Apply state
                        if (!item.enabled) await audioApi.setBypass(id, true);
                        if (item.muted) await audioApi.setMute(id, true);
                        if (item.gain !== 1.0) await audioApi.setGain(id, item.gain);

                        // Restore Internal State
                        if (item.state) {
                            try {
                                await audioApi.setPluginState(id, item.state);
                            } catch (e) {
                                console.error(`Failed to restore state for ${item.name}`, e);
                            }
                        }

                        loaded.push({
                            id, // new ID
                            name: item.name,
                            path: item.path,
                            vendor: item.vendor,
                            version: item.version,
                            enabled: item.enabled,
                            muted: item.muted,
                            gain: item.gain,
                            hasEditor: true
                        });
                    } catch (e) {
                        console.error(`Failed to restore plugin ${item.name}`, e);
                        localStorage.removeItem('vst_host_pending_plugin');
                        toast.error(`${item.name} の復元に失敗しました`);
                    }
                }
                if (loaded.length > 0) setPlugins(loaded);
            } catch (e) {
                console.error("Session recovery failed", e);
                toast.error("セッションの復元に失敗しました");
            } finally {
                localStorage.removeItem('vst_host_pending_plugin'); // Clear pending flag
                setIsLoading(false);
            }
        }
        setIsSessionLoaded(true);
    }, []);

    // Restore Session (initial load)
    const restoreStarted = useRef(false);

    useEffect(() => {
        if (!restoreStarted.current) {
            restoreStarted.current = true;
            restoreSession();
        }
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

    const savePreset = useCallback(async (name: string) => {
        try {
            const presetPlugins: ApiPresetPlugin[] = [];
            for (const p of plugins) {
                // Fetch state
                let state: string | undefined;
                try {
                    state = await audioApi.getPluginState(p.id);
                } catch (e) {
                    console.warn(`Could not get state for ${p.name}, saving without state.`);
                }

                presetPlugins.push({
                    path: p.path,
                    name: p.name,
                    vendor: p.vendor,
                    version: p.version,
                    enabled: p.enabled,
                    muted: p.muted,
                    gain: p.gain,
                    state: state || undefined
                });
            }
            await presetApi.save(name, presetPlugins);
            return true;
        } catch (e) {
            console.error("Failed to save preset:", e);
            setError("プリセットの保存に失敗しました");
            return false;
        }
    }, [plugins]);

    const loadPreset = useCallback(async (name: string) => {
        setIsLoading(true);
        try {
            const preset = await presetApi.load(name);
            // Loading preset - clear current plugins and apply

            // 1. Clear current plugins
            const currentIds = plugins.map(p => p.id);
            for (const id of currentIds) {
                await audioApi.removePlugin(id);
            }
            // Clear state immediately to avoid UI mismatch during async load
            setPlugins([]);

            // 2. Load new plugins
            let loadedPlugins: Plugin[] = [];
            for (const p of preset.plugins) {
                try {
                    const instanceId = await audioApi.loadPlugin(p.path);

                    // Set attributes
                    if (!p.enabled) await audioApi.setBypass(instanceId, true);
                    if (p.muted) await audioApi.setMute(instanceId, true);
                    if (p.gain !== 1.0) await audioApi.setGain(instanceId, p.gain);

                    // Restore State
                    if (p.state) {
                        try {
                            await audioApi.setPluginState(instanceId, p.state);
                        } catch (err) {
                            console.error(`Failed to restore state for ${p.name}`, err);
                            toast.error(`${p.name} の設定復元に失敗しました`);
                        }
                    }

                    loadedPlugins.push({
                        id: instanceId,
                        name: p.name,
                        path: p.path,
                        vendor: p.vendor,
                        version: p.version,
                        enabled: p.enabled,
                        hasEditor: true,
                        muted: p.muted,
                        gain: p.gain
                    });
                } catch (err) {
                    console.error(`Failed to load plugin from preset: ${p.name}`, err);
                    toast.error(`${p.name} の読み込みに失敗しました`);
                }
            }
            setPlugins(loadedPlugins);
            // Also update session immediately? The useEffect will catch it.
            return true;
        } catch (e) {
            console.error("Failed to load preset:", e);
            setError("プリセットの読み込みに失敗しました");
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [plugins]);

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
        try {
            // 1. Clear current plugins
            const currentIds = plugins.map(p => p.id);
            for (const id of currentIds) {
                await audioApi.removePlugin(id);
            }
            // Clear state immediately
            setPlugins([]);

            // 2. Load new plugins in order of slots
            const sortedIndexes = Object.keys(mapping).map(Number).sort((a, b) => a - b);

            const loadedPlugins: Plugin[] = [];
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
                    console.error(`Failed to load plugin for slot ${idx}`, e);
                    toast.error(`Slot ${idx + 1} (${vst.name}) の読み込みに失敗しました`);
                }
            }
            setPlugins(loadedPlugins);
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
        loadPreset,
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
