import { expect, it } from 'vitest';
import type { AudioDevice } from '@/api/audio';
import { recommendMicrophone, verifiedDefaultOutput } from '../wizardModel';

const device = (name: string, isDefault = false): AudioDevice => ({
    name, host: 'WASAPI', is_input: true, index: 0, channels: 2, is_default: isDefault,
});

it.each(['再生リダイレクト', 'Stereo Mix', 'ステレオ ミキサー', 'Loopback', 'What U Hear', 'CABLE Output', 'Voicemeeter Out B1'])(
    '%sは既定でもマイクとして自動選択しない', name => {
        const loopback = device(name, true);
        expect(recommendMicrophone([loopback])).toBeNull();
        const mic = device('USB マイク');
        expect(recommendMicrophone([loopback, mic])).toBe(mic);
    },
);

it('空・複数候補では先頭や既定を確定せず、マイクが一意な場合だけ推奨する', () => {
    const mic = device('Microphone USB');
    const line = device('ライン入力', true);
    expect(recommendMicrophone([])).toBeNull();
    expect(recommendMicrophone([line])).toBe(line);
    expect(recommendMicrophone([line, device('別の入力')])).toBeNull();
    expect(recommendMicrophone([line, mic])).toBe(mic);
    expect(recommendMicrophone([device('既定のマイク', true), mic])).toBeNull();
});

it('既定の物理出力が一意な場合だけ使い、仮想出力や既定不明を代用しない', () => {
    const speaker = { ...device('スピーカー', true), is_input: false };
    const cable = { ...device('CABLE Input', true), is_input: false };
    expect(verifiedDefaultOutput([])).toBeNull();
    expect(verifiedDefaultOutput([cable])).toBeNull();
    expect(verifiedDefaultOutput([{ ...speaker, is_default: false }, cable])).toBeNull();
    expect(verifiedDefaultOutput([speaker, cable])).toBe(speaker);
    expect(verifiedDefaultOutput([speaker, { ...speaker, name: 'ヘッドホン' }])).toBeNull();
});
