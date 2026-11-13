import { expect, it } from 'vitest';
import { formatElapsed } from '../sessionElapsed';

const at = (seconds: number) => formatElapsed(0, seconds * 1000);

it('1時間未満は分と秒、1時間以上は時を付ける', () => {
    expect(at(0)).toBe('00:00');
    expect(at(59)).toBe('00:59');
    expect(at(60)).toBe('01:00');
    expect(at(3599)).toBe('59:59');
    expect(at(3600)).toBe('01:00:00');
    expect(at(3661)).toBe('01:01:01');
    expect(formatElapsed(1_000, 2_500)).toBe('00:01');
});

it('開始より前や、時刻が数でないときは出さない', () => {
    expect(formatElapsed(5_000, 1_000)).toBeNull();
    expect(formatElapsed(Number.NaN, 1_000)).toBeNull();
    expect(formatElapsed(0, Number.POSITIVE_INFINITY)).toBeNull();
});
