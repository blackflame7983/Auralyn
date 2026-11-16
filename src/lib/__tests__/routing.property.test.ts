import { expect, it } from 'vitest';
import fc from 'fast-check';
import { readOutputRouting } from '../audioChannelRouting';
import { asioChannelPairs, sortWizardInputs } from '@/components/features/SetupWizard/wizardModel';
import type { AudioDevice } from '@/api/audio';
import { meterPosition } from '../model/meter';

const replay = {
    seed: Number(process.env.FC_SEED ?? 20261117),
    numRuns: 200,
    ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}),
};

it('有限な非負振幅のメーター位置は0〜1で単調増加する', () => {
    const amplitude = fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true });
    fc.assert(fc.property(amplitude, amplitude, (a, b) => {
        const low = meterPosition(Math.min(a, b));
        const high = meterPosition(Math.max(a, b));
        expect(low).toBeGreaterThanOrEqual(0);
        expect(high).toBeLessThanOrEqual(1);
        expect(low).toBeLessThanOrEqual(high);
    }), replay);
    expect(meterPosition(0)).toBe(0);
    expect(meterPosition(1)).toBe(1);
    expect(meterPosition(NaN)).toBe(0);
});

it('独立出力はJSON往復でチャンネルとモードを保つ', () => {
    expect(readOutputRouting({ mode: 'independent', channels: [0, 65535] })).toEqual({ mode: 'independent', channels: [0, 65535] });
    fc.assert(fc.property(fc.integer({ min: 0, max: 65535 }), fc.integer({ min: 0, max: 65535 }), (left, right) => {
        const value = { mode: 'independent', channels: [left, right] };
        const decoded: unknown = JSON.parse(JSON.stringify(value));
        expect(readOutputRouting(decoded)).toEqual(value);
    }), replay);
});

it('範囲外・小数・非有限のチャンネルを受理しない', () => {
    for (const value of [-1, 65536, 0.5, NaN, Infinity, -Infinity]) {
        expect(readOutputRouting({ mode: 'independent', channels: [value, 0] })).toBeUndefined();
        expect(readOutputRouting({ mode: 'independent', channels: [0, value] })).toBeUndefined();
    }
    const invalid = fc.oneof(fc.integer({ max: -1 }), fc.integer({ min: 65536 }),
        fc.integer({ min: 0, max: 65535 }).map(value => value + 0.5), fc.constantFrom(NaN, Infinity, -Infinity));
    fc.assert(fc.property(invalid, fc.boolean(), (value, reverse) => {
        expect(readOutputRouting({ mode: 'independent', channels: reverse ? [0, value] : [value, 0] })).toBeUndefined();
    }), replay);
});

it('ASIOペアは範囲内で全チャンネルを覆い、奇数の末尾だけ重複する', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 256 }), count => {
        const pairs = asioChannelPairs(count);
        expect([...new Set(pairs.flat())]).toEqual(Array.from({ length: count }, (_, index) => index));
        expect(pairs).toHaveLength(Math.ceil(count / 2));
        for (const [left, right] of pairs) {
            expect(left).toBeGreaterThanOrEqual(0);
            expect(right).toBeLessThan(count);
            expect(right - left).toBe(left === count - 1 ? 0 : 1);
        }
    }), replay);
});

it('機器の整列は入力と要素を保ち、各分類内の順序を変えない', () => {
    fc.assert(fc.property(fc.array(fc.boolean(), { maxLength: 64 }), generic => {
        const devices: AudioDevice[] = generic.map((isGeneric, index) => ({
            name: isGeneric ? `ASIO4ALL ${index}` : `Dedicated ${index}`, host: 'ASIO',
            is_input: true, index, channels: 2, is_default: false,
        }));
        const original = structuredClone(devices);
        const sorted = sortWizardInputs(devices, 'ASIO');
        expect(devices).toEqual(original);
        expect(sorted.map(device => device.index)).toEqual([
            ...devices.filter(device => !generic[device.index]).map(device => device.index),
            ...devices.filter(device => generic[device.index]).map(device => device.index),
        ]);
    }), replay);
});
