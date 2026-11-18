import type { AudioStateInfo, EngineRuntimeStats } from '@/api/audio';
import type { LiveOutputStatus } from '@/api/liveOutput';
import type { PreparationContext } from '@/lib/preparation';
export const context: PreparationContext = { location: 'home', usage: 'discord', signal: 'separate', receiver: 'CABLE Output' };
export const audioState: AudioStateInfo = { is_running: true, config: { host: 'WASAPI', input: 'Mic', output: 'CABLE Input', sample_rate: 48000, buffer_size: 256 } };
export const runtime = () => ({ preparation: { engineEpoch: '1', processingRevision: '1', routingRevision: '1', inputGain: 1, inputChannels: [0, 0], outputGain: 1, outputRevision: '1', muted: false, controlsPending: false, nrBackend: 'nnnoiseless', nrModel: 'bundled' }, latencyMetadata: { streamEpoch: '1', streamRunning: true } } as EngineRuntimeStats);
/** 緊急ミュートと出力音量だけを変えた統計。同じ統計から札の表示と移動先が決まることを試験で確かめる（#766）。 */
export const runtimeWith = (controls: { muted: boolean; outputGain: number }): EngineRuntimeStats => {
    const stats = runtime();
    if (!stats.preparation) throw new Error('fixture に preparation がありません');
    stats.preparation = { ...stats.preparation, ...controls };
    return stats;
};
export const liveStatus: LiveOutputStatus = { config: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
