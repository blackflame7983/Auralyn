import { expect, it } from 'vitest';
import { cablePlaybackName } from '../audioRouting';

it.each([
    ['CABLE Output', 'CABLE Input'],
    ['CABLE Output (VB-Audio Virtual Cable)', 'CABLE Input'],
    ['cable output [48kHz]', 'CABLE Input'],
    ['CABLE-A Output (VB-Audio Cable A)', 'CABLE-A Input'],
    ['CABLE-B Output', 'CABLE-B Input'],
])('録音側 %s から、再生アプリの出力先 %s を返す', (input, expected) => {
    expect(cablePlaybackName(input)).toBe(expected);
});

it.each([undefined, null, '', 'ステレオ ミキサー', 'Voicemeeter Out B1', 'CABLE Input', 'CABLE-C Output', 'My CABLE Output'])(
    '名前の対応が分からない %s は null を返し、推測しない',
    input => {
        expect(cablePlaybackName(input)).toBeNull();
    },
);
