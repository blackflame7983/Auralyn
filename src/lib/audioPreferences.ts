import { readInputSource, type InputSource } from './inputSource';
import type { AudioDevice, AudioDeviceList } from '../api/audio';
import { readOutputRouting, type OutputRouting } from './audioChannelRouting';

export interface AudioPreferences {
    inputSource?: InputSource;
    host: string;
    input?: string;
    output?: string;
    sampleRate?: number;
    bufferSize?: number;
    inputChannels?: [number, number];
    outputRouting?: OutputRouting;
    inputId?: string;
    outputId?: string;
}

// 完全な機器選択でIDが不明なら古いIDを引き継がず、ペアだけの部分更新では保持する。
export function deviceIdsForUpdate(previous: AudioPreferences, update: Partial<AudioPreferences> & { host: string }) {
    const changedHost = previous.host.toLowerCase() !== update.host.toLowerCase();
    const resolve = (side: 'input' | 'output', id: 'inputId' | 'outputId') =>
        id in update ? update[id] : changedHost || (update[side] !== undefined && update[side] !== previous[side])
            ? undefined : previous[id];
    return { inputId: resolve('input', 'inputId'), outputId: resolve('output', 'outputId') };
}

export function readAudioPreferences(): AudioPreferences | null {
    try {
        const value: unknown = JSON.parse(localStorage.getItem('vst_host_audio_config') ?? 'null');
        if (!value || typeof value !== 'object' || !('host' in value)
            || typeof value.host !== 'string' || !value.host.trim()) return null;
        const config = value as Record<string, unknown>;
        const inputSource = config.inputSource === undefined ? undefined : readInputSource(config.inputSource);
        if (config.inputSource !== undefined && !inputSource) return null;
        if (config.outputRouting !== undefined && !readOutputRouting(config.outputRouting)) return null;
        const text = (key: string) => typeof config[key] === 'string' ? config[key] as string : undefined;
        const positive = (key: string, fallback: number, max: number) => {
            const n = config[key];
            return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
        };
        const pair = config.inputChannels;
        const inputChannels: [number, number] | undefined = value.host.toLowerCase() !== 'asio' ? [0, 1]
            : Array.isArray(pair) && pair.length === 2 && pair.every(n => Number.isSafeInteger(n) && n >= 0)
                ? [pair[0], pair[1]] : undefined;
        return {
            inputSource,
            host: value.host, input: text('input'), output: text('output'),
            sampleRate: positive('sampleRate', 48_000, 768_000),
            bufferSize: positive('bufferSize', 512, 4096),
            inputChannels, outputRouting: readOutputRouting(config.outputRouting), inputId: text('inputId'), outputId: text('outputId'),
        };
    } catch {
        return null;
    }
}

export function readCachedAudioDevices(): AudioDeviceList {
    try {
        const value = JSON.parse(localStorage.getItem('vst_host_cached_devices') ?? 'null');
        const validDevice = (device: unknown): device is AudioDevice => {
            if (!device || typeof device !== 'object') return false;
            const d = device as Record<string, unknown>;
            return typeof d.name === 'string' && typeof d.host === 'string'
                && typeof d.is_input === 'boolean' && typeof d.is_default === 'boolean'
                && Number.isSafeInteger(d.index) && Number.isSafeInteger(d.channels)
                && (d.index as number) >= 0
                && ((d.channels as number) > 0
                    // 登録名だけのASIO候補は、未取得の能力を0で保持する。
                    || (d.channels === 0 && d.host.toLowerCase() === 'asio'
                        && typeof d.id === 'string' && d.id.length > 0 && d.buffer_size_range == null));
        };
        if (value && Array.isArray(value.inputs) && Array.isArray(value.outputs)) {
            // 前回の能力は現在の機器・接続条件を証明しない。
            const withoutRates = (device: AudioDevice) => {
                const { sample_rate_ranges: _stale, ...rest } = device;
                return rest;
            };
            return { inputs: value.inputs.filter(validDevice).map(withoutRates), outputs: value.outputs.filter(validDevice).map(withoutRates) };
        }
    } catch { /* キャッシュ破損時も設定を開き、実際のデバイスを再取得できるようにする。 */ }
    return { inputs: [], outputs: [] };
}
