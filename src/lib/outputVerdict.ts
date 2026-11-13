import { toDbfs, type MeterState } from '@/hooks/useMeterLevels';

/** 出力の一言。ピーク保持は 2 秒（メーターの peak）、平滑化は levels。 */
export type OutputVerdict = 'low' | 'ok' | 'high';

/** メーターの黄色の境目と同じ −6 dBFS。 */
export const OUTPUT_LOUD_DB = -6;
/** これ未満の平滑化値を「小さめ」とする。 */
export const OUTPUT_QUIET_DB = -30;

const loudLinear = Math.pow(10, OUTPUT_LOUD_DB / 20);
const quietLinear = Math.pow(10, OUTPUT_QUIET_DB / 20);

export interface OutputLevelSample {
    /** 平滑化した振幅。左右の大きい方を渡す。 */
    readonly smoothed: number;
    /** 2 秒保持したピーク振幅。左右の大きい方を渡す。 */
    readonly peakHold: number;
    readonly state: MeterState;
}

/**
 * 無音・停止・待機（更新待ちを含む）は一言を出さない。
 * ピーク保持が −6 dBFS 以上なら「大きすぎ」。そうでなく平滑化値が −30 dBFS 未満なら「小さめ」。それ以外は「適正」。
 */
export function outputVerdict(sample: OutputLevelSample): OutputVerdict | null {
    if (sample.state !== 'live') return null;
    if (sample.peakHold >= loudLinear) return 'high';
    if (sample.smoothed < quietLinear) return 'low';
    return 'ok';
}

/** 画面に出す dBFS。平滑化せず、ピーク保持値を使う。 */
export function formatPeakDbfs(peakHold: number): string {
    const db = toDbfs(peakHold);
    if (!Number.isFinite(db)) return '−∞';
    return db.toFixed(1).replace('-', '−');
}
