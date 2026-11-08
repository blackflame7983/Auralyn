/** カタログの1件は path と、あれば classId で区別する。classId が無い旧データは path だけで照合する。 */
export interface PluginRef {
    path: string;
    classId?: string | null;
}

export function pluginKey(plugin: PluginRef): string {
    return plugin.classId ? `${plugin.path}::${plugin.classId.toUpperCase()}` : plugin.path;
}

export type ReportedChannelLayout = 'mono' | 'monoToStereo';

/** ステレオと未交渉はバッジにしない。保存もしない。 */
export function reportedChannelLayout(layout: string | null | undefined): ReportedChannelLayout | undefined {
    return layout === 'mono' || layout === 'monoToStereo' ? layout : undefined;
}

export function fileLabel(path: string): string {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
}

/** reference に classId が無いときは path だけを見る。あるときは相手の classId も一致が必要。 */
export function samePlugin(reference: PluginRef, other: PluginRef): boolean {
    if (reference.path !== other.path) return false;
    if (!reference.classId) return true;
    return Boolean(other.classId) && other.classId!.toUpperCase() === reference.classId.toUpperCase();
}

export function pendingStorageValue(plugin: PluginRef): string {
    return plugin.classId
        ? JSON.stringify({ path: plugin.path, classId: plugin.classId })
        : plugin.path;
}

const legacyClassWarnings = new Set<string>();

/** 同じパスの曖昧な旧データ通知は、この画面の間に1回だけ出す。 */
export function claimLegacyClassWarning(path: string): boolean {
    if (legacyClassWarnings.has(path)) return false;
    legacyClassWarnings.add(path);
    return true;
}

export function readPending(stored: string | null): PluginRef | null {
    if (!stored) return null;
    if (!stored.startsWith('{')) return { path: stored };
    try {
        const value = JSON.parse(stored) as { path?: unknown; classId?: unknown };
        if (typeof value.path !== 'string' || !value.path) return { path: stored };
        return {
            path: value.path,
            classId: typeof value.classId === 'string' && value.classId ? value.classId : undefined,
        };
    } catch {
        return { path: stored };
    }
}
