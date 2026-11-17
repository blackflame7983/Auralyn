import { afterEach, expect, it } from 'vitest';
import { AUDIO_PRESETS_KEY, parseAudioPresets, readAudioPresets, writeAudioPresets } from '../audioPresets';

afterEach(() => localStorage.clear());

it('保存が無い・壊れている・オブジェクトでないときは、読めなかったものとして扱う', () => {
    expect(parseAudioPresets(null)).toBeUndefined();
    expect(parseAudioPresets('')).toBeUndefined();
    expect(parseAudioPresets('{')).toBeUndefined();
    expect(parseAudioPresets('null')).toBeUndefined();
    expect(parseAudioPresets('[]')).toBeUndefined();
    expect(parseAudioPresets('3')).toBeUndefined();
});

it('空の保存は空の一覧として読み、中身のない名前は捨てる', () => {
    expect(parseAudioPresets('{}')).toEqual({});
    expect(parseAudioPresets(JSON.stringify({ a: null, b: 3, c: [], d: 'x' }))).toEqual({});
});

it('型の違う項目は無かったものとして落とし、正しい項目と入力元・経路はそのまま残す', () => {
    const source = { kind: 'device', config: { purpose: 'voice' } };
    const parsed = parseAudioPresets(JSON.stringify({ 配信用: {
        host: 'ASIO', input: 'in', output: 5, inputId: 'asio:1', outputId: null, bufferSize: '256', sampleRate: 48000,
        inputChannels: [0, 1], inputSource: source, outputRouting: { mode: 'insert' },
    }, 壊れ: { inputChannels: [0, 'x'], sampleRate: null } }));
    expect(parsed?.配信用).toEqual({
        host: 'ASIO', input: 'in', output: undefined, inputId: 'asio:1', outputId: undefined, bufferSize: undefined, sampleRate: 48000,
        inputChannels: [0, 1], inputSource: source, outputRouting: { mode: 'insert' },
    });
    expect(parsed?.壊れ?.inputChannels).toBeUndefined();
    expect(parsed?.壊れ?.sampleRate).toBeUndefined();
});

it('チャンネルの組は、2つの有限の数だけを受け付ける', () => {
    const channels = (value: unknown) => parseAudioPresets(JSON.stringify({ p: { inputChannels: value } }))?.p?.inputChannels;
    expect(channels([2, 3])).toEqual([2, 3]);
    expect(channels([2])).toBeUndefined();
    expect(channels([0, 1, 2])).toBeUndefined();
    expect(channels('01')).toBeUndefined();
});

it('書いた一覧を同じ保存先から読み戻せる', () => {
    expect(readAudioPresets()).toBeUndefined();
    writeAudioPresets({ a: { host: 'WASAPI', sampleRate: 44100 } });
    expect(localStorage.getItem(AUDIO_PRESETS_KEY)).toContain('WASAPI');
    expect(readAudioPresets()).toEqual({ a: { host: 'WASAPI', sampleRate: 44100 } });
});
