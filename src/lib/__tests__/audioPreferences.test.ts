import { afterEach, expect, it } from 'vitest';
import { readAudioPreferences, readCachedAudioDevices, deviceIdsForUpdate } from '../audioPreferences';

afterEach(() => localStorage.clear());

it('完全な選択の未知IDを古いIDへ戻さず、ペアだけの部分更新では保持する', () => {
    const previous = { host: 'ASIO', input: 'same name', output: 'same name', inputId: 'old-in', outputId: 'old-out' };
    expect(deviceIdsForUpdate(previous, { host: 'ASIO', input: 'same name', output: 'same name', inputId: undefined, outputId: undefined }))
        .toEqual({ inputId: undefined, outputId: undefined });
    expect(deviceIdsForUpdate(previous, { host: 'ASIO', inputChannels: [2, 3] }))
        .toEqual({ inputId: 'old-in', outputId: 'old-out' });
    expect(deviceIdsForUpdate(previous, { host: 'ASIO', input: 'different', inputId: 'new-in' }))
        .toEqual({ inputId: 'new-in', outputId: 'old-out' });
});

it('旧呼出し元の機器名変更やホスト変更でも、別機器のIDを引き継がない', () => {
    const previous = { host: 'ASIO', input: 'A', output: 'A', inputId: 'old-in', outputId: 'old-out' };
    expect(deviceIdsForUpdate(previous, { host: 'ASIO', input: 'B', output: 'B' }))
        .toEqual({ inputId: undefined, outputId: undefined });
    expect(deviceIdsForUpdate(previous, { host: 'WASAPI' }))
        .toEqual({ inputId: undefined, outputId: undefined });
    expect(deviceIdsForUpdate(previous, { host: 'asio' }))
        .toEqual({ inputId: 'old-in', outputId: 'old-out' });
});

it('登録名だけのASIO候補をキャッシュから復元し、他のゼロ・負数チャンネルは除外する', () => {
    const registered = { name: 'Insert ASIO', host: 'ASIO', id: 'ASIO:Insert ASIO', channels: 0, index: 0, is_input: true, is_default: false };
    localStorage.setItem('vst_host_cached_devices', JSON.stringify({
        inputs: [registered, { ...registered, channels: -1 }, { ...registered, host: 'Wasapi' }, { ...registered, id: null }, { ...registered, buffer_size_range: [128, 1024] }],
        outputs: [{ ...registered, is_input: false }],
    }));
    expect(readCachedAudioDevices()).toEqual({ inputs: [registered], outputs: [{ ...registered, is_input: false }] });
});

it.each(['{broken', 'null', '[]', '{"host":42}', '{"host":""}'])('破損した設定 %s で自動開始しない', value => {
    localStorage.setItem('vst_host_audio_config', value);
    expect(readAudioPreferences()).toBeNull();
});

it('レート・バッファ・入力ペアの不正値を音声エンジンへ渡さない', () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({
        host: 'ASIO', input: 'mic', bufferSize: 48000, sampleRate: -1, inputChannels: [-1, 'bad'],
    }));
    expect(readAudioPreferences()).toMatchObject({ host: 'ASIO', input: 'mic', bufferSize: 512, sampleRate: 48000 });
    expect(readAudioPreferences()?.inputChannels).toBeUndefined();
});

it.each(['{broken', 'null', '{"inputs":null,"outputs":[]}', '{"inputs":[null,{}],"outputs":[]}'])('破損したデバイスキャッシュ %s でも設定を開ける', value => {
    localStorage.setItem('vst_host_cached_devices', value);
    expect(readCachedAudioDevices()).toEqual({ inputs: [], outputs: [] });
});


it('以前のデバイスキャッシュのレート範囲は現在の能力として復元しない', () => {
    const device = { name: 'mic', host: 'Wasapi', channels: 2, index: 0, is_input: true, is_default: true, sample_rate_ranges: [[48000, 96000]] };
    localStorage.setItem('vst_host_cached_devices', JSON.stringify({ inputs: [device], outputs: [] }));
    expect(readCachedAudioDevices().inputs[0].sample_rate_ranges).toBeUndefined();
});
