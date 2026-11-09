import { expect, it } from 'vitest';
import type { ActiveAudioConfig } from '@/api/audio';
import type { LiveOutputConfig } from '@/api/liveOutput';
import type { MixConfig, MixLevels, OffsetContext } from '@/api/mixing';
import { currentOffsetContext, mixingConfigurationValue, offsetContextChanges, offsetStatus } from '../offsetContext';

const audio: ActiveAudioConfig = { host: 'WASAPI', input: 'Mic', input_id: 'mic', output: 'Phones', output_id: 'phones', sample_rate: 48000, buffer_size: 128, routing: { inputChannels: [0, 1], outputRouting: { mode: 'legacy' } } };
const broadcast: LiveOutputConfig = { deviceId: 'broadcast', monitorTrim: 1, broadcastTrim: 1, monitorMuted: false };
const source: MixConfig['source'] = { kind: 'device', config: { host: 'WASAPI', inputId: 'music', inputChannels: [2, 3] } };
const context: OffsetContext = { voiceInputId: 'mic', voiceChannels: [0, 1], accompaniment: '["device","music",2,3]', outputId: 'phones', broadcastId: 'broadcast' };
const levels: MixLevels = { voice: { gain: 1, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: -20, offsetContext: context };

it('0、取得不能、旧データ、一致を区別する', () => {
    expect(offsetStatus({ ...levels, offsetMs: 0 }, null)).toBe('none');
    expect(offsetStatus(levels, null)).toBe('unknown');
    expect(offsetStatus({ ...levels, offsetContext: undefined }, context)).toBe('unconfirmed');
    expect(offsetStatus({ ...levels, offsetContext: null }, context)).toBe('unconfirmed');
    expect(offsetStatus(levels, { ...context, voiceChannels: [0, 1] })).toBe('confirmed');
});

it.each<[keyof OffsetContext, OffsetContext[keyof OffsetContext]]>([
    ['voiceInputId', 'other'], ['voiceChannels', [2, 1]], ['voiceChannels', [0, 3]],
    ['accompaniment', 'other'], ['outputId', 'other'], ['broadcastId', 'other'], ['broadcastId', null],
])('%sを変えると未確認、元に戻すと確認済みになる', (field, value) => {
    const changed = { ...context, [field]: value };
    expect(offsetStatus(levels, changed)).toBe('unconfirmed');
    expect(offsetContextChanges(context, changed)).toEqual([field]);
    expect(offsetStatus(levels, context)).toBe('confirmed');
    expect(levels.offsetMs).toBe(-20);
});

it('機器IDとチャンネル、IDがない旧設定の名前、配信先なしを記録する', () => {
    expect(currentOffsetContext(audio, source, broadcast)).toEqual(context);
    expect(currentOffsetContext({ ...audio, input_id: ' ', output_id: undefined }, source, { ...broadcast, deviceId: null }))
        .toEqual({ ...context, voiceInputId: 'name:Mic', outputId: 'name:Phones', broadcastId: null });
});

it('プロセス入力はアプリのキーと原音の出力先を区切りが衝突しない形で識別する', () => {
    const process = { kind: 'process_loopback' as const, config: { appKey: 'app:key', appName: 'Player', rawEndpointId: 'raw:id', purpose: 'music' as const } };
    const current = currentOffsetContext(audio, process, broadcast)!;
    expect(JSON.parse(current.accompaniment)).toEqual(['process_loopback', 'app:key', 'raw:id']);
    expect(currentOffsetContext(audio, { ...process, config: { ...process.config, appName: 'Renamed' } }, broadcast)).toEqual(current);
    for (const config of [{ ...process.config, appKey: 'other' }, { ...process.config, rawEndpointId: 'other' }]) {
        expect(offsetStatus({ ...levels, offsetContext: current }, currentOffsetContext(audio, { ...process, config }, broadcast))).toBe('unconfirmed');
    }
    for (const config of [{ ...source.config, inputId: 'other' }, { ...source.config, inputChannels: [0, 1] as [number, number] }]) {
        expect(offsetStatus(levels, currentOffsetContext(audio, { kind: 'device', config }, broadcast))).toBe('unconfirmed');
    }
});

it('不明な機器・チャンネル・オケ・配信設定を推測しない', () => {
    expect(currentOffsetContext(null, source, broadcast)).toBeNull();
    expect(currentOffsetContext({ ...audio, input: null, input_id: undefined }, source, broadcast)).toBeNull();
    expect(currentOffsetContext({ ...audio, output: null, output_id: undefined }, source, broadcast)).toBeNull();
    expect(currentOffsetContext({ ...audio, routing: undefined }, source, broadcast)).toBeNull();
    expect(currentOffsetContext(audio, null, broadcast)).toBeNull();
    expect(currentOffsetContext(audio, source, null)).toBeNull();
    expect(currentOffsetContext(audio, { ...source, config: { ...source.config, inputId: '' } }, broadcast)).toBeNull();
    expect(currentOffsetContext(audio, { kind: 'process_loopback', config: { appKey: '', appName: 'Player', rawEndpointId: 'raw', purpose: 'music' } }, broadcast)).toBeNull();
    expect(currentOffsetContext({ ...audio, input_source: { kind: 'process_loopback', config: { appKey: 'app', appName: 'Player', rawEndpointId: 'raw', purpose: 'voice' } } }, source, broadcast)).toBeNull();
});

it('文脈だけの違いは構成の変更表示から除外し、時間差の違いは残す', () => {
    const config: MixConfig = { version: 1, source, levels };
    expect(mixingConfigurationValue(config)).toBe(mixingConfigurationValue({ ...config, levels: { ...levels, offsetContext: null } }));
    expect(mixingConfigurationValue(config)).not.toBe(mixingConfigurationValue({ ...config, levels: { ...levels, offsetMs: 21 } }));
});
