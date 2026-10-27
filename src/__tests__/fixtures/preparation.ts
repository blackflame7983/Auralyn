import type { AudioStateInfo, EngineRuntimeStats } from '@/api/audio';
import type { LiveOutputStatus } from '@/api/liveOutput';
import type { PreparationContext } from '@/lib/preparation';
export const context: PreparationContext = { location: 'home', usage: 'discord', signal: 'separate', receiver: 'CABLE Output' };
export const audioState: AudioStateInfo = { is_running: true, config: { host: 'WASAPI', input: 'Mic', output: 'CABLE Input', sample_rate: 48000, buffer_size: 256 } };
export const runtime = () => ({ preparation: { engineEpoch: '1', processingRevision: '1', routingRevision: '1', inputGain: 1, inputChannels: [0, 0], outputGain: 1, outputRevision: '1', muted: false, controlsPending: false, nrBackend: 'nnnoiseless', nrModel: 'bundled' }, latencyMetadata: { streamEpoch: '1', streamRunning: true } } as EngineRuntimeStats);
export const liveStatus: LiveOutputStatus = { config: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
