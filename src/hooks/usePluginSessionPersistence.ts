import { PluginClientError } from '../lib/pluginNotice';
import { useEffect, useRef } from 'react';
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
    useEffect(() => {
        let active = true;
        let saving = false;

        const canWrite = () => {
            if (!current.current.ready || current.current.protectedSession) return false;
            try { return localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY) !== 'true'; }
            catch { return false; }
        };

        const save = async (strict = false) => {
            if (!canWrite()) {
                if (strict) throw new PluginClientError('saveProtected');
                return;
            }
            if (current.current.busy || saving) {
                if (strict) throw new PluginClientError('saveBusy');
                return;
            }
            saving = true;
            try {
                const session = await Promise.all(plugins.map(async plugin => ({
                    path: plugin.path,
                    name: plugin.name,
                    vendor: plugin.vendor,
                    version: plugin.version,
                    enabled: plugin.enabled,
                    muted: plugin.muted,
                    gain: plugin.gain,
                    state: await audioApi.getPluginState(plugin.id),
                })));
                if (!active || !canWrite()) throw new PluginClientError('saveChanged');
                localStorage.setItem(PLUGIN_SESSION_KEY, JSON.stringify(session));
            } catch (error) {
                if (strict) throw error;
                // 状態の取得失敗で、最後に保存できたVSTパラメーターを失わない。
                console.warn('VSTセッションを保存できませんでした', error);
            } finally {
                saving = false;
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
        const periodic = setInterval(() => void save(), 30_000);
        return () => {
            active = false;
            clearTimeout(debounce);
            clearInterval(periodic);
            window.removeEventListener('auralyn-save-session', requested);
        };
    }, [plugins, ready, busy, protectedSession]);
}
