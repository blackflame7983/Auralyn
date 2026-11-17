import { audioApi } from '@/api/audio';
import { parsePluginSession, unrestoredPluginNames } from './restorePluginSession';

/** エンジンの再起動のあとに、保存した VST の構成が実ラックへ戻ったか。completed 以外は、戻せていないものとして扱う。 */
export type SessionRestoreOutcome = 'completed' | 'partial' | 'failed';

/**
 * 復元の関数は失敗を内部で通知して正常に終わるため、戻り値や例外では結果が分からない。
 * 復元が終わったあとの実ラックと保存した構成を突き合わせて、結果を返す。確認できないときは failed。
 */
export async function checkRestoredRack(saved: string | null): Promise<SessionRestoreOutcome> {
    try {
        const expected = saved === null ? [] : parsePluginSession(JSON.parse(saved));
        const rack = await audioApi.sessionRack({ action: 'snapshot' });
        if (rack.status !== 'snapshot') return 'failed';
        const missing = unrestoredPluginNames(saved, rack.plugins).length;
        if (missing === 0) return 'completed';
        return missing === expected.length ? 'failed' : 'partial';
    } catch {
        return 'failed';
    }
}
