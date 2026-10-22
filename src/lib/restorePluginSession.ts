import { audioApi } from '../api/audio';
import type { Plugin } from '../components/features/PluginRack/PluginCard';
import type { PresetPlugin } from '../api/presets';
import { toast } from 'sonner';

function parseItems(value: unknown): PresetPlugin[] {
    if (!Array.isArray(value)) throw new Error('VSTセッションが配列ではありません');
    return value.map(item => {
        if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path
            || typeof item.name !== 'string'
            || (item.enabled !== undefined && typeof item.enabled !== 'boolean')
            || (item.muted !== undefined && typeof item.muted !== 'boolean')
            || (item.gain !== undefined && (typeof item.gain !== 'number' || !Number.isFinite(item.gain)))
            || (item.state !== undefined && typeof item.state !== 'string')) {
            throw new Error('VSTセッションの項目が不正です');
        }
        return {
            ...item, vendor: typeof item.vendor === 'string' ? item.vendor : '',
            version: typeof item.version === 'string' ? item.version : '',
            enabled: item.enabled ?? true, muted: item.muted ?? false, gain: item.gain ?? 1,
        };
    });
}

// 起動時と障害後で同じ復元手順を使う。順番とクラッシュ対象の記録を対応させる。
export async function restorePluginSession(
    value: unknown,
    onProgress: (plugins: Plugin[]) => void,
    excludePath?: string | null,
): Promise<number> {
    const items = parseItems(value);
    const loaded: Plugin[] = [];
    let failures = 0;
    for (const item of items) {
        if (excludePath && item.path === excludePath) {
            toast.warning(`問題のプラグインをスキップしました: ${item.name}`);
            continue;
        }
        let instance: Plugin | null = null;
        try {
            localStorage.setItem('vst_host_pending_plugin', item.path);
            const id = await audioApi.loadPlugin(item.path);
            instance = { ...item, id, enabled: true, muted: false, gain: 1, hasEditor: true };
            loaded.push(instance);
            if (!item.enabled) {
                await audioApi.setBypass(id, true);
                instance.enabled = false;
            }
            if (item.muted) {
                await audioApi.setMute(id, true);
                instance.muted = true;
            }
            if (item.gain !== 1) {
                await audioApi.setGain(id, item.gain);
                instance.gain = item.gain;
            }
            if (item.state !== undefined) await audioApi.setPluginState(id, item.state);
        } catch (error) {
            failures += 1;
            if (instance) {
                try {
                    await audioApi.removePlugin(instance.id);
                    loaded.splice(loaded.indexOf(instance), 1);
                } catch (cleanupError) {
                    onProgress([...loaded]);
                    throw cleanupError;
                }
            }
            console.error(`VSTの復元に失敗しました: ${item.name}`, error);
            toast.error(`${item.name} の復元に失敗しました`);
        } finally {
            localStorage.removeItem('vst_host_pending_plugin');
        }
        onProgress([...loaded]);
    }
    onProgress([...loaded]);
    return failures;
}
