import { PluginClientError, defaultPluginMessages, type PluginNoticeFormatter } from './pluginNotice';
import { audioApi, type RestorePluginRequest, type RestoredPlugin } from '../api/audio';
import type { Plugin } from '../components/features/PluginRack/PluginCard';
import type { PresetPlugin } from '../api/presets';
import { toast } from 'sonner';

export function parsePluginSession(value: unknown): PresetPlugin[] {
    if (!Array.isArray(value) || value.length > 32) throw new PluginClientError('sessionShape');
    return value.map(item => {
        if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path
            || typeof item.name !== 'string'
            || (item.enabled !== undefined && typeof item.enabled !== 'boolean')
            || (item.muted !== undefined && typeof item.muted !== 'boolean')
            || (item.gain !== undefined && (typeof item.gain !== 'number' || !Number.isFinite(item.gain)))
            || (item.state !== undefined && typeof item.state !== 'string')) {
            throw new PluginClientError('sessionItem');
        }
        return {
            ...item, vendor: typeof item.vendor === 'string' ? item.vendor : '',
            version: typeof item.version === 'string' ? item.version : '',
            enabled: item.enabled ?? true, muted: item.muted ?? false, gain: item.gain ?? 1,
        };
    });
}

export class SessionRackConflict extends Error {}

export interface PluginSessionRestoreResult {
    status: 'success' | 'partial' | 'failed' | 'cancelled' | 'retained';
    total: number;
    restored: number;
    failed: number;
    skipped: number;
}

// 起動時と障害後で同じ復元手順を使う。順番とクラッシュ対象の記録を対応させる。
export async function restorePluginSession(
    value: unknown,
    onProgress: (plugins: Plugin[]) => void,
    excludePath?: string | null,
    isCurrent: () => boolean = () => true,
    conditionalRestore?: (request: RestorePluginRequest) => Promise<RestoredPlugin>,
    t: PluginNoticeFormatter = defaultPluginMessages,
): Promise<PluginSessionRestoreResult> {
    const items = parsePluginSession(value);
    const loaded: Plugin[] = [];
    let failures = 0;
    let skipped = 0;
    const result = (cancelled = false): PluginSessionRestoreResult => ({
        status: cancelled ? 'cancelled' : failures === 0 && skipped === 0 ? 'success' : loaded.length === 0 && failures > 0 ? 'failed' : 'partial',
        total: items.length, restored: loaded.length, failed: failures, skipped,
    });
    const cancelled = new Error('セッション復元を中断しました');
    const checkCurrent = () => { if (!isCurrent()) throw cancelled; };
    for (const item of items) {
        if (!isCurrent()) return result(true);
        if (excludePath && item.path === excludePath) {
            skipped += 1;
            toast.warning(t('pluginNotices.excludedPlugin', { name: item.name }));
            continue;
        }
        let instance: Plugin | null = null;
        try {
            localStorage.setItem('vst_host_pending_plugin', item.path);
            const restored = await (conditionalRestore ?? audioApi.restorePlugin)({ path: item.path, state: item.state ?? null,
                bypassed: !item.enabled, muted: item.muted, gain: item.gain });
            instance = { ...item, id: restored.id, hasEditor: true };
            loaded.push(instance);
            checkCurrent();
        } catch (error) {
            if (error instanceof SessionRackConflict) throw error;
            if (error !== cancelled) failures += 1;
            // 条件付き復元は取消時も実ラックに残す。旧画面から新しいラックを削除しない。
            if (instance && !conditionalRestore) {
                try {
                    await audioApi.removePlugin(instance.id);
                    loaded.splice(loaded.indexOf(instance), 1);
                } catch (cleanupError) {
                    if (isCurrent()) onProgress([...loaded]);
                    throw cleanupError;
                }
            }
            if (error === cancelled || !isCurrent()) return result(true);
            console.error(`VSTの復元に失敗しました: ${item.name}`, error);
            toast.error(t('pluginNotices.pluginRestoreNameFailed', { name: item.name }));
        } finally {
            localStorage.removeItem('vst_host_pending_plugin');
        }
        if (isCurrent()) onProgress([...loaded]);
    }
    if (isCurrent()) onProgress([...loaded]);
    return result(!isCurrent());
}

/** 保存済み構成のうち、現在のラックに読み込まれていないVSTの名前。保存値が壊れていれば推定しない。 */
export function unrestoredPluginNames(saved: string | null, current: { path: string }[]): string[] {
    if (!saved) return [];
    let items: PresetPlugin[];
    try { items = parsePluginSession(JSON.parse(saved)); } catch { return []; }
    const remaining = current.map(plugin => plugin.path);
    return items.filter(item => {
        const index = remaining.indexOf(item.path);
        if (index >= 0) { remaining.splice(index, 1); return false; }
        return true;
    }).map(item => item.name || item.path);
}
