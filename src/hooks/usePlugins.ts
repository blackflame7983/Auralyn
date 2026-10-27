import { explicitSessionStartRequired } from '@/lib/temporarySession';
import { useMessages } from '../i18n/LocaleProvider';
import { pluginNotice, renderPluginNotice, defaultPluginMessages, type PluginNotice } from '../lib/pluginNotice';
import { useState, useCallback, useEffect, useRef } from 'react';
import { audioApi, VstPlugin, type RackPlugin } from '../api/audio';
import { Plugin } from '../components/features/PluginRack/PluginCard';
import { usePluginProfiles } from './usePluginProfiles';
import { restorePluginSession, parsePluginSession, SessionRackConflict, type PluginSessionRestoreResult } from '../lib/restorePluginSession';
import { toast } from 'sonner';
import { REVIEW_KEY } from '../api/migration';
import { usePluginSessionPersistence, protectPluginSession, PLUGIN_SESSION_KEY, PLUGIN_SESSION_PROTECTED_KEY } from './usePluginSessionPersistence';
import { liveModesApi } from '../api/liveModes';
import { beginRackRestore, rackRestoreBusy } from '../lib/liveRouting';

async function restoreSavedGains(check: () => void) {
    const input = Number(localStorage.getItem('vst_host_input_gain') ?? '100') / 100;
    const output = Number(localStorage.getItem('vst_host_output_gain') ?? '100') / 100;
    if (![input, output].every(value => Number.isFinite(value) && value >= 0 && value <= 2)) throw new Error('保存された音量を確認できません');
    await audioApi.setInputGain(input);
    check();
    await audioApi.setOutputGain(output);
    check();
}

export const usePlugins = () => {
    const [plugins, setPlugins] = useState<Plugin[]>([]);
    const [availablePlugins, setAvailablePlugins] = useState<VstPlugin[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const t = useMessages();
    const [error, setError] = useState<PluginNotice | null>(null);
    const setLegacyError = useCallback((value: import('react').SetStateAction<string | null>) => {
        setError(previous => typeof value === 'function' ? value(previous === null ? null : renderPluginNotice(defaultPluginMessages, previous)) : value);
    }, []);
    const [isSessionLoaded, setIsSessionLoaded] = useState(false);
    const [sessionPersistenceProtected, setSessionPersistenceProtected] = useState(true);
    const [sessionRestoreStatus, setSessionRestoreStatus] = useState<PluginSessionRestoreResult['status'] | 'pending'>('pending');
    const sessionRestorePending = useRef(false);
    const restoreGeneration = useRef(0);
    const mounted = useRef(true);
    const retryPending = useRef(false);
    const manualRecoveryPending = useRef(false);
    const pluginsRef = useRef(plugins);
    pluginsRef.current = plugins;
    const retryRef = useRef<(() => Promise<unknown>) | null>(null);

    usePluginSessionPersistence(plugins, isSessionLoaded, isLoading || isScanning, sessionPersistenceProtected);

    const resetPlugins = useCallback(() => {
        // Reactの次のeffectを待たず、進行中の自動保存にも原本保護を伝える。
        try { protectPluginSession(localStorage.getItem(PLUGIN_SESSION_KEY)); } catch { /* 保存処理自体もfail-closedにする。 */ }
        restoreGeneration.current += 1;
        setSessionPersistenceProtected(true);
        setSessionRestoreStatus('cancelled');
        setPlugins([]);
        setIsSessionLoaded(false);
        setIsLoading(false);
    }, []);

    const hydrateRack = useCallback((rack: RackPlugin[]) => {
        const next = rack.map(plugin => ({ ...plugin, vendor: '', version: '', hasEditor: true }));
        pluginsRef.current = next;
        setPlugins(next);
    }, []);

    const restoreSavedSession = useCallback(async (excludePath?: string | null, explicit = false) => {
        if (sessionRestorePending.current || (manualRecoveryPending.current && !retryPending.current)) return;
        sessionRestorePending.current = true;
        const confirmationRequired = !explicit && (explicitSessionStartRequired() || localStorage.getItem(REVIEW_KEY) === 'true');
        const generation = ++restoreGeneration.current;
        const isCurrent = () => mounted.current && generation === restoreGeneration.current;
        let token: string | undefined;
        setSessionPersistenceProtected(true);
        setIsSessionLoaded(false);
        setSessionRestoreStatus('pending');
        setIsLoading(true);
        setError(null);
        try {
            // JSONの解析・音量操作より先に、既存engineの実IDを確認する。失敗は空扱いしない。
            const rack = await audioApi.sessionRack({ action: 'snapshot' });
            if (!isCurrent()) return;
            if (rack.status !== 'snapshot') throw new SessionRackConflict('ラックの確認待ち、または構成が変更されています');
            const saved = localStorage.getItem(PLUGIN_SESSION_KEY);
            protectPluginSession(saved);
            if (rack.plugins.length > 0 || (!rack.restoreEligible && !explicit)) {
                hydrateRack(rack.plugins);
                setSessionRestoreStatus('retained');
                setError(pluginNotice('pluginNotices.retained', undefined, true));
                return;
            }
            if (!explicit && (confirmationRequired || explicitSessionStartRequired() || localStorage.getItem(REVIEW_KEY) === 'true')) return;
            const items = saved === null ? [] : parsePluginSession(JSON.parse(saved));
            if (items.length === 0) {
                const savedInput = localStorage.getItem('vst_host_input_gain');
                const retained = await audioApi.sessionRack({ action: 'retain', generation: rack.generation, revision: rack.revision,
                    ids: [], inputGain: savedInput === null ? null : Number(savedInput) / 100 });
                if (!isCurrent()) return;
                if (retained.status !== 'finished') throw new SessionRackConflict('空ラックが変更されました');
                if (localStorage.getItem(PLUGIN_SESSION_KEY) !== saved) {
                    setSessionRestoreStatus('cancelled');
                    setError(pluginNotice('pluginNotices.savedChanged', undefined, true));
                    return;
                }
                setSessionRestoreStatus('success');
                // 空ラックでも手動復旧は後続のgain・Start・予約終了まで成功扱いしない。
                if (!manualRecoveryPending.current) {
                    localStorage.removeItem(PLUGIN_SESSION_PROTECTED_KEY);
                    setSessionPersistenceProtected(false);
                    setIsSessionLoaded(true);
                }
                return { status: 'success', total: 0, restored: 0, failed: 0, skipped: 0 } as PluginSessionRestoreResult;
            }
            const inputGain = Number(localStorage.getItem('vst_host_input_gain') ?? '100') / 100;
            const outputGain = Number(localStorage.getItem('vst_host_output_gain') ?? '100') / 100;
            const begun = await audioApi.sessionRack({ action: 'begin', generation: rack.generation, revision: rack.revision,
                ids: rack.plugins.map(plugin => plugin.id), inputGain, outputGain, explicit });
            if (begun.status === 'ready') token = begun.token;
            if (!isCurrent()) return;
            if (!token) throw new SessionRackConflict('別の復元またはラック変更を確認しました');
            const outcome = await restorePluginSession(items, next => { if (isCurrent()) { pluginsRef.current = next; setPlugins(next); } }, excludePath, isCurrent, async request => {
                if (!isCurrent()) throw new SessionRackConflict('復元を中断しました');
                const added = await audioApi.sessionRack({ action: 'add', token: token!, request });
                if (added.status === 'restored') return added.plugin;
                if (added.status === 'failed') throw new Error(added.message);
                throw new SessionRackConflict('実ラックまたはエンジンの世代が変更されました');
            }, t);
            if (!isCurrent()) return;
            const finished = await audioApi.sessionRack({ action: 'finish', token });
            token = undefined;
            if (!isCurrent()) return;
            if (finished.status !== 'finished') throw new SessionRackConflict('復元の最終確認中に構成が変更されました');
            // 外部で保存原文が変わった場合も、古い復元結果で保護を解除しない。
            if (localStorage.getItem(PLUGIN_SESSION_KEY) !== saved) {
                setSessionRestoreStatus('cancelled');
                setError(pluginNotice('pluginNotices.savedChanged', undefined, true));
                return;
            }
            setSessionRestoreStatus(outcome.status);
            if (outcome.status === 'success') {
                if (!manualRecoveryPending.current) {
                    localStorage.removeItem(PLUGIN_SESSION_PROTECTED_KEY);
                    setSessionPersistenceProtected(false);
                    setIsSessionLoaded(true);
                }
            } else {
                const excludedOnly = outcome.failed === 0 && outcome.skipped > 0;
                const message = excludedOnly
                    ? pluginNotice('pluginNotices.excluded', undefined, true)
                    : pluginNotice('pluginNotices.partial', { failed: outcome.failed, skipped: outcome.skipped }, true);
                setError(message);
                if (!excludedOnly) toast.error(renderPluginNotice(t, message), { action: { label: t('pluginNotices.retrySaved'), onClick: () => void retryRef.current?.() } });
            }
            return outcome;
        } catch (error) {
            if (isCurrent()) {
                if (token) {
                    await audioApi.sessionRack({ action: 'finish', token }).catch(() => undefined);
                    token = undefined;
                }
                // 競合時も既存の実ラックだけを再表示し、追加・削除・gain復元へ戻らない。
                const actual = await audioApi.sessionRack({ action: 'snapshot' }).catch(() => null);
                if (!isCurrent()) return;
                if (actual?.status === 'snapshot') hydrateRack(actual.plugins);
                setSessionRestoreStatus('failed');
                const message = error instanceof SessionRackConflict
                    ? pluginNotice('pluginNotices.conflict', undefined, true)
                    : pluginNotice('pluginNotices.restoreFailedProtected', undefined, true);
                setError(message);
                toast.error(renderPluginNotice(t, message), { action: { label: t('pluginNotices.retrySaved'), onClick: () => void retryRef.current?.() } });
            }
        } finally {
            if (token) await audioApi.sessionRack({ action: 'finish', token }).catch(() => undefined);
            sessionRestorePending.current = false;
            if (isCurrent()) setIsLoading(false);
        }
    }, [hydrateRack]);

    const retrySavedSession = useCallback(async (excludePath?: string | null, manual = false) => {
        if (retryPending.current || sessionRestorePending.current || (manualRecoveryPending.current && !manual)) return;
        retryPending.current = true;
        let expectedGeneration = restoreGeneration.current;
        const isCurrent = () => expectedGeneration === restoreGeneration.current;
        setSessionPersistenceProtected(true);
        setIsLoading(true);
        try {
            protectPluginSession(localStorage.getItem(PLUGIN_SESSION_KEY));
            const actual = await audioApi.sessionRack({ action: 'snapshot' });
            if (!isCurrent()) return;
            if (actual.status !== 'snapshot') throw new Error('実ラックを確認できません');
            hydrateRack(actual.plugins);
            // 明示的な再試行だけが、直前に確認した実IDを回収する。
            for (const plugin of actual.plugins) {
                if (!isCurrent()) return;
                await audioApi.removePlugin(plugin.id);
                if (!isCurrent()) return;
                setPlugins(previous => previous.filter(current => current.id !== plugin.id));
            }
            if (!isCurrent()) return;
            // 自分が開始する復元の一世代分だけを引き継ぐ。
            expectedGeneration += 1;
            return await restoreSavedSession(excludePath, true);
        } catch {
            if (!isCurrent()) return;
            setSessionRestoreStatus('failed');
            setError(pluginNotice('pluginNotices.retryFailed', undefined, true));
        } finally {
            retryPending.current = false;
            if (isCurrent()) setIsLoading(false);
        }
    }, [restoreSavedSession, hydrateRack]);
    const retrySessionRestore = useCallback(async () => { await retrySavedSession(); }, [retrySavedSession]);
    retryRef.current = retrySessionRestore;

    const restoreSession = useCallback(async (explicit = true) => {
        await restoreSavedSession(undefined, explicit);
    }, [restoreSavedSession]);
    const protectForManualRecovery = useCallback(() => {
        protectPluginSession(localStorage.getItem(PLUGIN_SESSION_KEY));
        const generation = ++restoreGeneration.current;
        setSessionPersistenceProtected(true);
        setIsSessionLoaded(false);
        setSessionRestoreStatus('cancelled');
        setError(null);
        return () => generation === restoreGeneration.current;
    }, []);

    const keepSessionStopped = useCallback(async () => {
        if (manualRecoveryPending.current) throw new Error('復旧操作中です');
        manualRecoveryPending.current = true;
        let isCurrent = () => false;
        try {
            isCurrent = protectForManualRecovery();
            // Hostのローカルread。終了済みならStopでもchildを起こさない。
            const state = await audioApi.getAudioState();
            if (!isCurrent()) throw new Error('復旧操作を中断しました');
            if (state.is_running) await audioApi.stop();
        } finally {
            manualRecoveryPending.current = false;
            if (isCurrent()) setIsLoading(false);
        }
    }, [protectForManualRecovery]);

    const resumeWithoutPlugins = useCallback(async (start: () => Promise<unknown>) => {
        if (manualRecoveryPending.current || sessionRestorePending.current || retryPending.current || rackRestoreBusy()) {
            throw new Error('構成の変更処理中です');
        }
        manualRecoveryPending.current = true;
        const release = beginRackRestore();
        let token: string | undefined;
        let isCurrent = () => true;
        setIsLoading(true);
        try {
            isCurrent = protectForManualRecovery();
            const check = () => { if (!isCurrent()) throw new Error('復旧操作を中断しました'); };
            await liveModesApi.preflight(); check();
            token = await liveModesApi.beginChanges(); check();
            const state = await audioApi.getAudioState(); check();
            let freshEngine = !state.is_running;
            if (state.is_running) {
                await audioApi.stop(); check();
                freshEngine = !(await audioApi.getAudioState()).is_running; check();
            }
            if (!freshEngine) {
                for (const plugin of [...pluginsRef.current]) {
                    await audioApi.removePlugin(plugin.id); check();
                    pluginsRef.current = pluginsRef.current.filter(item => item.id !== plugin.id);
                    setPlugins(pluginsRef.current);
                }
            }
            // 未知IDを推測せず、公開統計で実backendの空ラックを一度だけ確認する。
            const stats = await audioApi.getEngineRuntimeStats(); check();
            if (stats.activePluginCount !== 0 || stats.pendingUnloadCount !== 0) {
                throw new Error('VSTの回収完了を確認できません。音声を開始せず、保存済み構成を保護しています。');
            }
            pluginsRef.current = [];
            setPlugins([]);
            if (freshEngine) {
                // 新しいsidecarの最初のcallbackより前に、保存されたgain意図を戻す。
                await restoreSavedGains(check); check();
            }
            await start(); check();
            if (token) { const completed = token; token = undefined; await liveModesApi.endChanges(completed); check(); }
            setError(pluginNotice('pluginNotices.resumedEmpty', undefined, true));
        } catch (error) {
            if (isCurrent()) setError(pluginNotice('pluginNotices.resumeEmptyFailed', undefined, true));
            throw error;
        } finally {
            try { if (token) await liveModesApi.endChanges(token); }
            finally { release(); manualRecoveryPending.current = false; if (isCurrent()) setIsLoading(false); }
        }
    }, [protectForManualRecovery]);

    const recoverSession = useCallback(async (excludePath?: string | null, start?: () => Promise<unknown>) => {
        if (manualRecoveryPending.current || sessionRestorePending.current || retryPending.current || rackRestoreBusy()) throw new Error('構成の変更処理中です');
        manualRecoveryPending.current = true;
        const release = beginRackRestore();
        let token: string | undefined;
        try {
            const isCurrent = protectForManualRecovery();
            await liveModesApi.preflight();
            if (!isCurrent()) throw new Error('復旧操作を中断しました');
            token = await liveModesApi.beginChanges();
            if (!isCurrent()) throw new Error('復旧操作を中断しました');
            const state = await audioApi.getAudioState();
            if (!isCurrent()) throw new Error('復旧操作を中断しました');
            if (state.is_running) await audioApi.stop();
            if (!isCurrent()) throw new Error('復旧操作を中断しました');
            const freshEngine = !state.is_running || !(await audioApi.getAudioState()).is_running;
            if (!isCurrent()) throw new Error('復旧操作を中断しました');
            // 初回engine終了後は旧IDを再利用しない。再試行は途中ラックを回収してから復元。
            if (freshEngine) { pluginsRef.current = []; setPlugins([]); }
            const saved = localStorage.getItem(PLUGIN_SESSION_KEY);
            const outcome = await retrySavedSession(excludePath, true);
            if (!outcome || outcome.failed > 0 || outcome.status === 'cancelled' || outcome.status === 'failed') throw new Error('保存済み構成の復元が完了していません。原本を保護中です。');
            const generation = restoreGeneration.current;
            if (freshEngine) await restoreSavedGains(() => { if (generation !== restoreGeneration.current) throw new Error('復旧操作を中断しました'); });
            if (generation !== restoreGeneration.current) throw new Error('復旧操作を中断しました');
            if (start) await start();
            if (generation !== restoreGeneration.current || localStorage.getItem(PLUGIN_SESSION_KEY) !== saved) throw new Error('復旧操作を中断しました');
            if (token) { const completed = token; token = undefined; await liveModesApi.endChanges(completed); }
            if (generation !== restoreGeneration.current || localStorage.getItem(PLUGIN_SESSION_KEY) !== saved) throw new Error('復旧操作を中断しました');
            if (outcome.status === 'success') {
                localStorage.removeItem(PLUGIN_SESSION_PROTECTED_KEY);
                setSessionPersistenceProtected(false);
                setIsSessionLoaded(true);
            } else {
                setError(pluginNotice('pluginNotices.resumedExcluded', undefined, true));
            }
        } finally {
            try { if (token) await liveModesApi.endChanges(token); }
            finally { release(); manualRecoveryPending.current = false; }
        }
    }, [protectForManualRecovery, retrySavedSession]);

    // Restore Session (initial load)
    const restoreStarted = useRef(false);
    const initialRestore = useRef<Promise<void> | null>(null);
    const reviewRestoreStarted = useRef(false);

    useEffect(() => {
        mounted.current = true;
        const confirmed = () => {
            // 両方の確認が揃ってから一度だけ復元する。初回snapshot待ちの通知も失わない。
            if (explicitSessionStartRequired() || localStorage.getItem(REVIEW_KEY) === 'true' || reviewRestoreStarted.current) return;
            reviewRestoreStarted.current = true;
            const generation = restoreGeneration.current;
            void initialRestore.current?.then(() => {
                if (mounted.current && generation === restoreGeneration.current) return restoreSession();
            });
        };
        window.addEventListener('migration-review-completed', confirmed);
        window.addEventListener('session-review-completed', confirmed);
        if (!restoreStarted.current) {
            restoreStarted.current = true;
            initialRestore.current = restoreSession(false);
        }
        return () => {
            mounted.current = false;
            window.removeEventListener('migration-review-completed', confirmed);
            window.removeEventListener('session-review-completed', confirmed);
            // StrictModeの同一hook再接続ではpending readを共有し、真のunmountだけを失効する。
            queueMicrotask(() => { if (!mounted.current) restoreGeneration.current += 1; });
        };
    }, [restoreSession]);

    const rejectDuringRestore = useCallback(() => {
        if (!sessionRestorePending.current && !retryPending.current && !manualRecoveryPending.current) return false;
        setError(pluginNotice('pluginNotices.restoring', undefined, true));
        return true;
    }, []);

    const scanPlugins = useCallback(async () => {
        setIsScanning(true);
        setError(null);
        try {
            const result = await audioApi.scanPlugins();
            setAvailablePlugins(result);
        } catch (err) {
            console.error("Failed to scan plugins:", err);
            setError(pluginNotice('pluginNotices.scanFailed'));
        } finally {
            setIsScanning(false);
        }
    }, []);

    const addPlugin = useCallback(async (vstPlugin: VstPlugin) => {
        if (rejectDuringRestore()) return false;
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
            setError(pluginNotice('pluginNotices.loadFailed', { detail: String(e) }, false));
            return false;
        } finally {
            setIsLoading(false);
        }
    }, []);

    const removePlugin = useCallback(async (id: string) => {
        if (rejectDuringRestore()) return;
        const generation = restoreGeneration.current;
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

            if (generation !== restoreGeneration.current) return;
            // 2. Remove from Engine
            await audioApi.removePlugin(id);

            if (generation !== restoreGeneration.current) return;
            // 3. Update UI
            setPlugins(prev => prev.filter(p => p.id !== id));

            // 4. Show Undo Toast
            toast.success(renderPluginNotice(t, pluginNotice('pluginNotices.removed', { name: pluginToRemove.name }, false)), {
                action: {
                    label: t('pluginNotices.undo'),
                    onClick: async () => {
                        if (rejectDuringRestore() || generation !== restoreGeneration.current) return;
                        const toastId = toast.loading(renderPluginNotice(t, pluginNotice('pluginNotices.restoringPlugin', { name: pluginToRemove.name }, false)));
                        try {
                            const restored = await audioApi.restorePlugin({ path: pluginToRemove.path, state: savedState ?? null,
                                bypassed: !pluginToRemove.enabled, muted: pluginToRemove.muted, gain: pluginToRemove.gain });
                            const newId = restored.id;
                            if (generation !== restoreGeneration.current) {
                                await audioApi.removePlugin(newId);
                                toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.cancelled')), { id: toastId });
                                return;
                            }

                            // Add back to list (Append to end)
                            const restoredPlugin = { ...pluginToRemove, id: newId };
                            setPlugins(prev => [...prev, restoredPlugin]);

                            toast.success(renderPluginNotice(t, pluginNotice('pluginNotices.restored')), { id: toastId });
                        } catch (e) {
                            console.error("Undo failed", e);
                            toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.restoreFailed')), { id: toastId });
                        }
                    }
                },
                duration: 5000, // 5 seconds to undo
            });

        } catch (e) {
            console.error("Failed to remove plugin", e);
            setError(pluginNotice('pluginNotices.removeFailed'));
        }
    }, [plugins]);

    const togglePlugin = useCallback(async (id: string, enabled: boolean) => {
        if (rejectDuringRestore()) return;
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
        if (rejectDuringRestore()) return;
        const previousPlugins = [...plugins];
        // Optimistic update
        setPlugins(newPlugins);
        try {
            const ids = newPlugins.map(p => p.id);
            await audioApi.reorderPlugins(ids);
        } catch (e) {
            console.error("Failed to reorder plugins:", e);
            setError(pluginNotice('pluginNotices.reorderFailed'));
            // Rollback
            setPlugins(previousPlugins);
        }
    }, [plugins]);

    const openEditor = useCallback(async (id: string) => {
        if (rejectDuringRestore()) return;
        const generation = restoreGeneration.current;
        const isCurrent = () => generation === restoreGeneration.current;
        const target = plugins.find(p => p.id === id);

        const reloadAllFromUi = async () => {
            const reloaded: Plugin[] = [];
            for (const p of plugins) {
                if (!isCurrent()) throw new Error('復元を中断しました');
                const restored = await audioApi.restorePlugin({ path: p.path, state: null,
                    bypassed: !p.enabled, muted: p.muted, gain: p.gain });
                const newId = restored.id;
                if (!isCurrent()) { await audioApi.removePlugin(newId); throw new Error('復元を中断しました'); }
                reloaded.push({ ...p, id: newId });
                setPlugins([...reloaded]);
            }
            setPlugins(reloaded);
            return reloaded;
        };

        try {
            await audioApi.openEditor(id);
        } catch (e) {
            if (!isCurrent()) return;
            const message = `${e}`;
            console.error(`Failed to open editor for ${id}`, e);

            // If the engine got restarted/crashed, all plugin IDs become invalid.
            if (message.includes("loaded_count=0")) {
                if (!target) {
                    toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.editorFailed')), { description: t('pluginNotices.rawDetail', { detail: message }) });
                    return;
                }

                const toastId = toast.loading(renderPluginNotice(t, pluginNotice('pluginNotices.restoringAfterRestart')));
                try {
                    setPlugins([]);
                    const reloaded = await reloadAllFromUi();
                    const reopened = reloaded.find(p => p.path === target.path);
                    if (!reopened) {
                        throw new Error("復元後に対象プラグインが見つかりませんでした");
                    }
                    await audioApi.openEditor(reopened.id);
                    toast.success(renderPluginNotice(t, pluginNotice('pluginNotices.editorOpened')), { id: toastId });
                    return;
                } catch (err) {
                    toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.pluginRestoreFailed')), { id: toastId, description: t('pluginNotices.rawDetail', { detail: String(err) }) });
                    return;
                }
            }

            // Single plugin re-load fallback (stale id or removed plugin)
            if (message.includes("Plugin not found") && target) {
                const toastId = toast.loading(renderPluginNotice(t, pluginNotice('pluginNotices.reloading')));
                try {
                    const restored = await audioApi.restorePlugin({ path: target.path, state: null,
                        bypassed: !target.enabled, muted: target.muted, gain: target.gain });
                    const newId = restored.id;
                    if (!isCurrent()) { await audioApi.removePlugin(newId); return; }

                    setPlugins(prev => prev.map(p => p.id === id ? { ...p, id: newId } : p));
                    await audioApi.openEditor(newId);
                    toast.success(renderPluginNotice(t, pluginNotice('pluginNotices.editorOpened')), { id: toastId });
                    return;
                } catch (err) {
                    toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.reloadFailed')), { id: toastId, description: t('pluginNotices.rawDetail', { detail: String(err) }) });
                    return;
                }
            }

            toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.editorFailed')), {
                description: t('pluginNotices.rawDetail', { detail: message }),
            });
        }
    }, [plugins]);

    const toggleMute = useCallback(async (id: string, muted: boolean) => {
        if (rejectDuringRestore()) return;
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
        if (rejectDuringRestore()) return;
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

    const getRestoreGeneration = useCallback(() => restoreGeneration.current, []);
    const profileActions = usePluginProfiles(plugins, setPlugins, setIsLoading, setLegacyError, getRestoreGeneration, setError);
    const { savePreset, saveProfile } = profileActions;
    // ドロップやイベントから呼ばれても、復元途中のラックをprofileで置き換えない。
    const loadPreset = useCallback(async (...args: Parameters<typeof profileActions.loadPreset>) => {
        if (rejectDuringRestore()) return false;
        return profileActions.loadPreset(...args);
    }, [profileActions.loadPreset, rejectDuringRestore]);
    const applyProfile = useCallback(async (...args: Parameters<typeof profileActions.applyProfile>) => {
        if (rejectDuringRestore()) return null;
        return profileActions.applyProfile(...args);
    }, [profileActions.applyProfile, rejectDuringRestore]);
    const restoreBackupProfile = useCallback(async (...args: Parameters<typeof profileActions.restoreBackupProfile>) => {
        if (rejectDuringRestore()) return null;
        return profileActions.restoreBackupProfile(...args);
    }, [profileActions.restoreBackupProfile, rejectDuringRestore]);
    const runBundle = useCallback(async (...args: Parameters<typeof profileActions.runBundle>) => {
        if (rejectDuringRestore()) return null;
        const generation = restoreGeneration.current;
        const wasProtected = sessionPersistenceProtected || localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY) === 'true';
        protectPluginSession(localStorage.getItem(PLUGIN_SESSION_KEY));
        setSessionPersistenceProtected(true);
        try {
            const result = await profileActions.runBundle(...args);
            if (generation !== restoreGeneration.current) return null;
            if (result?.complete && !wasProtected) {
                localStorage.removeItem(PLUGIN_SESSION_PROTECTED_KEY);
                setSessionPersistenceProtected(false);
            } else if (!result?.complete) {
                setSessionRestoreStatus('partial');
            }
            return result;
        } catch (error) {
            if (generation === restoreGeneration.current) setSessionRestoreStatus('failed');
            throw error;
        }
    }, [profileActions.runBundle, rejectDuringRestore, sessionPersistenceProtected]);

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
        if (rejectDuringRestore()) return false;
        try {
            await audioApi.setPluginState(id, state);
            return true;
        } catch (e) {
            console.error(`Failed to load state for ${id}`, e);
            return false;
        }
    }, []);

    const applyTemplate = useCallback(async (mapping: Record<string, VstPlugin>) => {
        if (rejectDuringRestore()) return false;
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
                    toast.error(renderPluginNotice(t, pluginNotice('pluginNotices.slotFailed', { slot: idx + 1, name: vst.name }, false)));
                }
            }
            setPlugins(loadedPlugins);
            // 一部だけ読み込めた場合も、画面を閉じずラックの確認と再試行へつなぐ。
            if (failedCount > 0) {
                setError(pluginNotice('pluginNotices.loadCountFailed', { count: failedCount }, false));
                return false;
            }
            return true;
        } catch (e) {
            console.error("Failed to apply template:", e);
            setError(pluginNotice('pluginNotices.applyTemplateFailed'));
            return false;
        } finally {
            setIsLoading(false);
        }
    }, [plugins]);

    const sessionProtectionReason = sessionPersistenceProtected && sessionRestoreStatus !== 'pending'
        ? t('pluginNotices.protected')
        : null;
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
        runBundle,
        savePluginState,
        loadPluginState,
        applyTemplate,
        isLoading,
        isScanning,
        error: sessionProtectionReason && !(typeof error === 'object' && error?.includesProtectionExplanation)
            ? `${error ? `${renderPluginNotice(t, error)} ` : ''}${sessionProtectionReason}`
            : error === null ? null : renderPluginNotice(t, error),
        restoreSession,
        recoverSession,
        keepSessionStopped,
        resumeWithoutPlugins,
        resetPlugins,
        sessionRestoreStatus,
        sessionPersistenceProtected,
        sessionProtectionReason,
        retrySessionRestore
    };
};
