import { expect, it } from 'vitest';
import type { AudioDevice } from '@/api/audio';
import { isGenericAsioDriver, recommendMicrophone, sortWizardInputs, verifiedDefaultOutput } from '../wizardModel';

const device = (name: string, isDefault = false): AudioDevice => ({
    name, host: 'WASAPI', is_input: true, index: 0, channels: 2, is_default: isDefault,
});

const asio = (name: string): AudioDevice => ({ ...device(name), host: 'ASIO' });

it.each(['Realtek ASIO', 'ASIO4ALL v2', 'FlexASIO', 'Generic Low Latency ASIO Driver', 'ASIO2WASAPI',
    'Voicemeeter Virtual ASIO', 'VB-Audio Voicemeeter AUX Virtual ASIO', 'Voicemeeter Insert Virtual ASIO',
    'VB-Audio Voicemeeter Insert Virtual ASIO', 'realtek asio'])(
    '%sを汎用ASIOとして扱う', name => expect(isGenericAsioDriver(name)).toBe(true),
);

it.each(['Roland Rubix ASIO', 'Focusrite USB ASIO', 'Yamaha Steinberg USB ASIO', 'Creative Sound Blaster ASIO'])(
    '%sを汎用ASIOとして扱わない', name => expect(isGenericAsioDriver(name)).toBe(false),
);

it('ASIOだけ専用driverを安定順で先に出し、元の一覧を変えない', () => {
    const inputs = ['Realtek ASIO', 'Rubix ASIO', 'FlexASIO', 'Focusrite ASIO', 'VB-Audio Voicemeeter AUX Virtual ASIO'].map(asio);
    const original = [...inputs];
    expect(sortWizardInputs(inputs, 'asio')).toEqual([inputs[1], inputs[3], inputs[0], inputs[2], inputs[4]]);
    expect(inputs).toEqual(original);
    expect(sortWizardInputs(inputs, 'WASAPI')).toBe(inputs);
});

it('ASIO専用driverが一意なら汎用driverと併存しても推奨し、複数なら明示選択を待つ', () => {
    const rubix = asio('Rubix ASIO');
    const generic = ['Realtek ASIO', 'ASIO4ALL v2', 'FlexASIO', 'Voicemeeter Insert Virtual ASIO'].map(asio);
    expect(recommendMicrophone([...generic, rubix])).toBe(rubix);
    expect(recommendMicrophone([...generic, rubix, asio('Focusrite Microphone ASIO')])).toBeNull();
    expect(recommendMicrophone(generic)).toBeNull();
    expect(recommendMicrophone([rubix])).toBe(rubix);
    expect(recommendMicrophone([asio('Realtek ASIO')])?.name).toBe('Realtek ASIO');
    expect(recommendMicrophone([device('Realtek ASIO'), device('Rubix ASIO')])).toBeNull();
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
