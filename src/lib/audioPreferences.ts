import { readInputSource, type InputSource } from './inputSource';
import type { ActiveAudioConfig, AudioDevice, AudioDeviceList } from '../api/audio';
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

/** 設定が無い状態で、画面が初期値として使う周波数とバッファ。起動時の正規化（useAudioConfig）も同じ値にする。 */
export const UNSET_SAMPLE_RATE = 48_000;
export const UNSET_BUFFER_SIZE = 512;

/**
 * 画面の保持値を「設定が無い」状態へ戻す更新。画面の保持値の更新は省いた項目を旧値から引き継ぐため、
 * 空の値と、明示した undefined（機器ID・入力元）で、すべての項目を上書きする。
 * 周波数とバッファは 0 にしない。0 は接続のページの初期値になり、開始要求と保存値へ流れる。
 */
export const UNSET_AUDIO_UPDATE: Partial<AudioPreferences> & { host: string } = {
    host: '', input: '', output: '', inputId: undefined, outputId: undefined, inputSource: undefined,
    sampleRate: UNSET_SAMPLE_RATE, bufferSize: UNSET_BUFFER_SIZE, outputRouting: { mode: 'legacy' },
};

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
        return parseAudioPreferences(value);
    } catch {
        return null;
    }
}

// WebViewとnativeの保存形式は異なるが、復帰時も同じ入力・経路の検証を通す。
export function savedAudioPreferences(saved: ActiveAudioConfig): AudioPreferences | null {
    return parseAudioPreferences({
        host: saved.host, input: saved.input, output: saved.output,
        inputId: saved.input_id, outputId: saved.output_id, inputSource: saved.input_source,
        sampleRate: saved.sample_rate, bufferSize: saved.buffer_size,
        inputChannels: saved.routing?.inputChannels, outputRouting: saved.routing?.outputRouting,
    });
}

function parseAudioPreferences(value: unknown): AudioPreferences | null {
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
