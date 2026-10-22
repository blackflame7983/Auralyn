import { useEffect } from 'react';
import { audioApi } from '../api/audio';
import type { Plugin } from '../components/features/PluginRack/PluginCard';

// ラック操作から保存の寿命を分離する。古い構成の取得結果で新しい保存を上書きしない。
export function usePluginSessionPersistence(plugins: Plugin[], ready: boolean, busy: boolean) {
    useEffect(() => {
        if (!ready) return;
        let active = true;
        let saving = false;

        const save = async (strict = false) => {
            if (busy || saving) {
                if (strict) throw new Error('VSTの読み込み・スキャン・保存完了後に再試行してください。');
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
                if (!active) throw new Error('保存中にVST構成が変更されました。再試行してください。');
                localStorage.setItem('vst_host_session_plugins', JSON.stringify(session));
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
    }, [plugins, ready, busy]);
}
