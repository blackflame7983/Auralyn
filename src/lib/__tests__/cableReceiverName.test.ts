import { expect, it } from 'vitest';
import { cablePlaybackName, cableReceiverName } from '../audioRouting';

it.each([
    ['CABLE Input', 'CABLE Output'],
    ['CABLE Input (VB-Audio Virtual Cable)', 'CABLE Output'],
    ['cable input [48kHz]', 'CABLE Output'],
    ['CABLE-A Input (VB-Audio Cable A)', 'CABLE-A Output'],
    ['CABLE-B Input', 'CABLE-B Output'],
])('出力先 %s から、受け側が選ぶ録音側 %s を返す', (output, expected) => {
    expect(cableReceiverName(output)).toBe(expected);
});

it.each([undefined, null, '', 'スピーカー (Realtek)', 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)', 'CABLE Output', 'CABLE-C Input', 'My CABLE Input'])(
    '名前の対応が分からない %s は null を返し、推測しない',
    output => {
        expect(cableReceiverName(output)).toBeNull();
    },
);

it('再生側と録音側の対は、どちらから求めても往復で元の名前に戻る', () => {
    for (const playback of ['CABLE Input', 'CABLE-A Input', 'CABLE-B Input']) {
        expect(cablePlaybackName(cableReceiverName(playback))).toBe(playback);
    }
});
