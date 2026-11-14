import { expect, it } from 'vitest';
import { noiseModeLabelKey, readNoiseMode } from '../noiseMode';

it('ノイズ低減のモードは空白と大文字を除いた既知の4値だけを読む', () => {
    expect(readNoiseMode(' low ')).toBe('low');
    expect(readNoiseMode('HIGH')).toBe('high');
    expect(readNoiseMode('Smart')).toBe('smart');
    expect(readNoiseMode('venue')).toBe('venue');
});

it('統計がない・知らない値は不明とし、弱や詳細の表示に落とさない', () => {
    for (const value of [undefined, null, '', '  ', 'later', 'medium']) {
        expect(readNoiseMode(value)).toBe('unknown');
        expect(noiseModeLabelKey('unknown')).toBe('flow.unknown');
    }
    expect(noiseModeLabelKey('low')).toBe('master.nrLow');
    expect(noiseModeLabelKey('high')).toBe('master.nrHigh');
    expect(noiseModeLabelKey('smart')).toBe('master.nrLearn');
    expect(noiseModeLabelKey('venue')).toBe('master.nrVenue');
});
