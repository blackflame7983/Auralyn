import type { MessageKey } from '@/i18n/messages';
export interface LoudnessReading {
    id: number;
    ready: boolean;
    silent: boolean;
    supported: boolean;
    short_term_lufs: number | null;
    true_peak_dbtp: number | null;
}
export type Verdict = 'low' | 'good' | 'high';
export const verdictLabel: Record<Verdict, MessageKey> = {
    low: 'meterBrowser.copy.083',
    good: 'meterBrowser.copy.084',
    high: 'meterBrowser.copy.085',
};

// 声用の仮の目安。YouTube等の配信全体の基準ではない。
export const DEFAULT_TARGET = -20;
export function classifyLoudness(
    r: LoudnessReading,
    target: number,
    previous: Verdict | null
): Verdict | null {
    if (!r.supported || r.true_peak_dbtp === null || !Number.isFinite(r.true_peak_dbtp))
        return null;
    // 短い過大音も、LUFSの3秒窓や有音区間が揃うのを待たずに警告する。
    if (r.true_peak_dbtp > -1) return 'high';
    if (!r.ready || r.silent || r.short_term_lufs === null || !Number.isFinite(r.short_term_lufs))
        return null;
    const delta = r.short_term_lufs - target;
    // 1LUのヒステリシスで境界付近の往復を抑える。
    if (previous === 'low' && delta < -2) return 'low';
    if (previous === 'high' && delta > 2) return 'high';
    if (previous === 'good' && delta >= -4 && delta <= 4) return 'good';
    return delta < -3 ? 'low' : delta > 3 ? 'high' : 'good';
}
