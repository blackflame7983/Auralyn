import { PluginClientError } from '../lib/pluginNotice';
import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '../api/audio';
import type { Plugin } from '../components/features/PluginRack/PluginCard';

// ラック操作から保存の寿命を分離する。古い構成の取得結果で新しい保存を上書きしない。
export const PLUGIN_SESSION_KEY = 'vst_host_session_plugins';
export const PLUGIN_SESSION_BACKUP_KEY = 'vst_host_session_plugins_before_restore';
export const PLUGIN_SESSION_PROTECTED_KEY = 'vst_host_session_restore_protected';

// 復元中の途中ラックを保存しない。退避した原文は、その後の失敗でも上書きしない。
export function protectPluginSession(saved: string | null) {
    localStorage.setItem(PLUGIN_SESSION_PROTECTED_KEY, 'true');
    if (saved !== null && localStorage.getItem(PLUGIN_SESSION_BACKUP_KEY) === null) {
        localStorage.setItem(PLUGIN_SESSION_BACKUP_KEY, saved);
    }
}

export function usePluginSessionPersistence(plugins: Plugin[], ready: boolean, busy: boolean, protectedSession = false) {
    const current = useRef({ ready, busy, protectedSession });
    current.current = { ready, busy, protectedSession };
    const openEditors = useRef(new Set<string>());
    const states = useRef(new Map<string, string>());
    const lastWritten = useRef<string | null>(null);
    const editorEvents = useRef({ opened: (_id: string) => {}, closed: (_id: string) => {} });

    useEffect(() => {
        let active = true;
        const subscriptions = [
            listen<{ id: string }>('plugin-editor-opened', event => {
                if (active) editorEvents.current.opened(event.payload.id);
            }),
            listen<{ id: string }>('plugin-editor-closed', event => {
                if (active) editorEvents.current.closed(event.payload.id);
            }),
        ].map(subscription => subscription.catch(error => {
            console.warn('VSTエディターの通知を購読できませんでした', error);
            return () => {};
        }));
        return () => {
            active = false;
            for (const subscription of subscriptions) void subscription.then(unlisten => unlisten());
        };
    }, []);

    useEffect(() => {
        let active = true;
        let saving = false;
        let periodic: ReturnType<typeof setInterval> | undefined;
        // 保存中に閉じたエディターの最終状態を捨てず、今の保存の後で取り直す。
        const pending = new Set<string>();
        let pendingAll = false;
        const ids = new Set(plugins.map(plugin => plugin.id));
        for (const id of openEditors.current) if (!ids.has(id)) openEditors.current.delete(id);
        for (const id of states.current.keys()) if (!ids.has(id)) states.current.delete(id);

        const canWrite = () => {
            if (!current.current.ready || current.current.protectedSession) return false;
            try { return localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY) !== 'true'; }
            catch { return false; }
        };

        const save = async (strict = false, refresh?: ReadonlySet<string>) => {
            if (!canWrite()) {
                if (strict) throw new PluginClientError('saveProtected');
                return;
            }
            if (current.current.busy || saving) {
                if (strict) throw new PluginClientError('saveBusy');
                // busy の解除は依存の変化で全体保存になるため、保存中の重なりだけを持ち越す。
                // 定期保存がないため、重なった全体保存も落とさない。
                if (saving) {
                    if (refresh) for (const id of refresh) pending.add(id);
                    else pendingAll = true;
                }
                return;
            }
            saving = true;
            try {
                const session = await Promise.all(plugins.map(async plugin => {
                    let state = states.current.get(plugin.id);
                    // 部分保存でも、初回の状態がないVSTは取得して欠落を防ぐ。
                    if (!refresh || refresh.has(plugin.id) || state === undefined) {
                        try {
                            state = await audioApi.getPluginState(plugin.id);
                            if (active) states.current.set(plugin.id, state);
                        } catch (error) {
                            // 自動保存は最後の正常値を使い、明示保存は取得失敗を通知する。
                            if (strict || state === undefined) throw error;
                            console.warn('VSTパラメーターを取得できませんでした', error);
                        }
                    }
                    return {
                        path: plugin.path,
                        name: plugin.name,
                        vendor: plugin.vendor,
                        version: plugin.version,
                        enabled: plugin.enabled,
                        muted: plugin.muted,
                        gain: plugin.gain,
                        ...(plugin.classId ? { classId: plugin.classId } : {}),
                        state,
                    };
                }));
                if (!active || !canWrite() || current.current.busy) throw new PluginClientError('saveChanged');
                const serialized = JSON.stringify(session);
                if (serialized !== lastWritten.current && serialized !== localStorage.getItem(PLUGIN_SESSION_KEY)) {
                    localStorage.setItem(PLUGIN_SESSION_KEY, serialized);
                    lastWritten.current = serialized;
                }
            } catch (error) {
                if (strict) throw error;
                // 状態の取得失敗で、最後に保存できたVSTパラメーターを失わない。
                console.warn('VSTセッションを保存できませんでした', error);
            } finally {
                saving = false;
                if (active && (pendingAll || pending.size > 0)) {
                    const next = pendingAll ? undefined : new Set(pending);
                    pendingAll = false;
                    pending.clear();
                    void save(false, next);
                }
            }
        };

        const requested = (event: Event) => {
            const { resolve, reject } = (event as CustomEvent<{
                resolve: () => void;
                reject: (error: unknown) => void;
            }>).detail;
            void save(true).then(resolve, reject);
        };
        window.addEventListener('auralyn-save-session', requested);
        const debounce = setTimeout(() => void save(), 2000);
        const syncPeriodic = () => {
            if (openEditors.current.size > 0 && periodic === undefined) {
                periodic = setInterval(() => void save(false, new Set(openEditors.current)), 10_000);
            } else if (openEditors.current.size === 0 && periodic !== undefined) {
                clearInterval(periodic);
                periodic = undefined;
            }
        };
        editorEvents.current = {
            opened: id => {
                // 再読み込み直後は一覧の更新より先に届くため、id を絞らずに記録する。
                // 一覧にない id は次の構成変更で外し、保存の対象にもならない。
                if (!active) return;
                openEditors.current.add(id);
                syncPeriodic();
            },
            closed: id => {
                if (!active) return;
                openEditors.current.delete(id);
                syncPeriodic();
                if (ids.has(id)) void save(false, new Set([id]));
            },
        };
        syncPeriodic();
        return () => {
            active = false;
            clearTimeout(debounce);
            clearInterval(periodic);
            window.removeEventListener('auralyn-save-session', requested);
        };
    }, [plugins, ready, busy, protectedSession]);
}
