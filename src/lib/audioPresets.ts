/** 接続の組み合わせに名前を付けて持つ記録。入力元と経路は、読み戻すときに検証する。 */
export interface AudioPreset {
    host?: string;
    inputSource?: unknown;
    input?: string;
    output?: string;
    bufferSize?: number;
    sampleRate?: number;
    inputId?: string;
    outputId?: string;
    inputChannels?: [number, number];
    outputRouting?: unknown;
}

export type AudioPresets = Record<string, AudioPreset>;

export const AUDIO_PRESETS_KEY = 'vst_host_audio_presets';

const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const channelPair = (value: unknown): [number, number] | undefined => {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [left, right] = value as unknown[];
    const first = count(left);
    const second = count(right);
    return first === undefined || second === undefined ? undefined : [first, second];
};

function parseAudioPreset(value: unknown): AudioPreset | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const item = value as Record<string, unknown>;
    return {
        host: text(item.host), inputSource: item.inputSource, input: text(item.input), output: text(item.output),
        bufferSize: count(item.bufferSize), sampleRate: count(item.sampleRate),
        inputId: text(item.inputId), outputId: text(item.outputId),
        inputChannels: channelPair(item.inputChannels), outputRouting: item.outputRouting,
    };
}

/** 保存された文字列を読む。壊れた記録や形の違う項目は、無かったものとして捨てる。 */
export function parseAudioPresets(raw: string | null): AudioPresets | undefined {
    if (!raw) return undefined;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return undefined; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const presets: AudioPresets = {};
    for (const [name, entry] of Object.entries(value)) {
        const preset = parseAudioPreset(entry);
        if (preset) presets[name] = preset;
    }
    return presets;
}

export function readAudioPresets(): AudioPresets | undefined {
    return parseAudioPresets(localStorage.getItem(AUDIO_PRESETS_KEY));
}

export function writeAudioPresets(presets: AudioPresets): void {
    localStorage.setItem(AUDIO_PRESETS_KEY, JSON.stringify(presets));
}
