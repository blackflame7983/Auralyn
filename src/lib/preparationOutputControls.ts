import type { EngineRuntimeStats } from '@/api/audio';
import { validPreparationSnapshot, type MuteCause, type PreparationObservation } from '@/lib/preparation';

/**
 * 観測の取得を止めている間（設定・診断などを開いている間）に、ミュートと出力音量ゼロの札だけを更新する。
 * 構成・確認の鍵・受け側の検査は読み直さず、完全な取り直しは再開時に行う。
 * 札が「準備できた」か「音を送っていない」のときだけ書き換え、それ以外の状態は触らない。
 */
export function withOutputControls(old: PreparationObservation, stats: EngineRuntimeStats): PreparationObservation {
    if (old.availability !== 'ready' && old.availability !== 'muted') return old;
    const p = stats.preparation;
    if (!validPreparationSnapshot(p) || p.controlsPending || stats.latencyMetadata?.streamRunning !== true) return old;
    const muted = p.muted || p.outputGain === 0;
    const muteCause: MuteCause | undefined = muted ? p.muted ? 'muted' : 'zeroGain' : undefined;
    const availability = muted ? 'muted' : 'ready';
    if (old.availability === availability && old.muteCause === muteCause) return old;
    return { ...old, availability, muteCause };
}
