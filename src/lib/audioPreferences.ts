import type { AudioDevice, AudioDeviceList } from '../api/audio';

export interface AudioPreferences {
    host: string;
    input?: string;
    output?: string;
    sampleRate?: number;
    bufferSize?: number;
    inputChannels?: [number, number];
    inputId?: string;
    outputId?: string;
}

export function readAudioPreferences(): AudioPreferences | null {
    try {
        const value: unknown = JSON.parse(localStorage.getItem('vst_host_audio_config') ?? 'null');
        if (!value || typeof value !== 'object' || !('host' in value)
            || typeof value.host !== 'string' || !value.host.trim()) return null;
        const config = value as Record<string, unknown>;
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
            host: value.host, input: text('input'), output: text('output'),
            sampleRate: positive('sampleRate', 48_000, 768_000),
            bufferSize: positive('bufferSize', 512, 4096),
            inputChannels, inputId: text('inputId'), outputId: text('outputId'),
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
                && (d.index as number) >= 0 && (d.channels as number) > 0;
        };
        if (value && Array.isArray(value.inputs) && Array.isArray(value.outputs)) {
            return { inputs: value.inputs.filter(validDevice), outputs: value.outputs.filter(validDevice) };
        }
    } catch { /* キャッシュ破損時も設定を開き、実際のデバイスを再取得できるようにする。 */ }
    return { inputs: [], outputs: [] };
}
