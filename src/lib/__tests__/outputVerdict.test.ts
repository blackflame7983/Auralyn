import { expect, it } from 'vitest';
import { formatPeakDbfs, outputVerdict } from '../outputVerdict';

const linear = (db: number) => Math.pow(10, db / 20);

it('ピーク保持が −6 dBFS 以上なら大きすぎ', () => {
    expect(outputVerdict({ state: 'live', peakHold: linear(-6), smoothed: linear(-40) })).toBe('high');
    expect(outputVerdict({ state: 'live', peakHold: linear(-5.9), smoothed: linear(-20) })).toBe('high');
    expect(outputVerdict({ state: 'live', peakHold: 1, smoothed: linear(-12) })).toBe('high');
});

it('ピークが境目未満で、平滑化値が −30 dBFS 未満なら小さめ', () => {
    expect(outputVerdict({ state: 'live', peakHold: linear(-12), smoothed: linear(-30.1) })).toBe('low');
    expect(outputVerdict({ state: 'live', peakHold: linear(-7), smoothed: 0 })).toBe('low');
});

it('それ以外の稼働中は適正', () => {
    expect(outputVerdict({ state: 'live', peakHold: linear(-6.1), smoothed: linear(-30) })).toBe('ok');
    expect(outputVerdict({ state: 'live', peakHold: linear(-18), smoothed: linear(-18) })).toBe('ok');
});

it('無音・停止・待機・更新待ちは一言を出さない', () => {
    for (const state of ['silent', 'stopped', 'waiting', 'stale'] as const) {
        expect(outputVerdict({ state, peakHold: 1, smoothed: 1 })).toBeNull();
    }
});

it('dBFS の表示はピーク保持値で、無音は無限大', () => {
    expect(formatPeakDbfs(linear(-6))).toBe('−6.0');
    expect(formatPeakDbfs(linear(-12.34))).toBe('−12.3');
    expect(formatPeakDbfs(0)).toBe('−∞');
});
