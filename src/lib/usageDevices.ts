import type { DisplayPurpose } from './displayPurpose';
import { readInputSource, type InputSource } from './inputSource';
import type { AudioPreferences } from './audioPreferences';

export const USAGE_DEVICES_KEY = 'auralyn_usage_devices';

export interface UsageDeviceRecord {
    host: string;
    input?: string;
    inputId?: string;
    output: string;
    outputId?: string;
    sampleRate: number;
    bufferSize: number;
    inputSource: InputSource;
}

export type UsageDeviceStore = Partial<Record<DisplayPurpose, UsageDeviceRecord>>;

const STORE_KEYS = ['version', 'voice', 'music'];
const RECORD_KEYS = ['host', 'input', 'inputId', 'output', 'outputId', 'sampleRate', 'bufferSize', 'inputSource'];

function recordObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    if (value.length === 0 || value.length > max || /[\x00-\x1f]/.test(value)) return undefined;
    return value;
}

function positive(value: unknown, max: number): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max ? value : undefined;
}

export function parseUsageDevice(value: unknown, purpose: DisplayPurpose): UsageDeviceRecord | null {
    const record = recordObject(value);
    if (!record || Object.keys(record).some(key => !RECORD_KEYS.includes(key))) return null;
    const host = text(record.host, 200);
    const sampleRate = positive(record.sampleRate, 768_000);
    const bufferSize = positive(record.bufferSize, 4096);
    const inputSource = readInputSource(record.inputSource);
    const output = text(record.output, 260);
    if (!host || !sampleRate || !bufferSize || !inputSource || !output || inputSource.config.purpose !== purpose) return null;
    const input = record.input === undefined ? undefined : text(record.input, 260);
    const inputId = record.inputId === undefined ? undefined : text(record.inputId, 4096);
    const outputId = record.outputId === undefined ? undefined : text(record.outputId, 4096);
    if ((record.input !== undefined && !input) || (record.inputId !== undefined && !inputId) || (record.outputId !== undefined && !outputId)) return null;
    if (inputSource.kind === 'process_loopback') {
        if (input || inputId) return null;
    } else if (!input && !inputId) return null;
    return { host, input, inputId, output, outputId, sampleRate, bufferSize, inputSource };
}

export function readUsageDevices(): UsageDeviceStore {
    try {
        const value = recordObject(JSON.parse(localStorage.getItem(USAGE_DEVICES_KEY) ?? 'null'));
        if (!value || value.version !== 1 || Object.keys(value).some(key => !STORE_KEYS.includes(key))) return {};
        const store: UsageDeviceStore = {};
        for (const purpose of ['voice', 'music'] as const) {
            if (value[purpose] === undefined) continue;
            const record = parseUsageDevice(value[purpose], purpose);
            if (record) store[purpose] = record;
        }
        return store;
    } catch {
        return {};
    }
}

export function writeUsageDevice(purpose: DisplayPurpose, record: UsageDeviceRecord): void {
    if (!parseUsageDevice(record, purpose)) throw new Error('使い道の機器を保存できません');
    const current = readUsageDevices();
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, ...current, [purpose]: record }));
}

export function usageDeviceFromPreferences(prefs: AudioPreferences, purpose: DisplayPurpose): UsageDeviceRecord | null {
    const inputSource = prefs.inputSource ?? { kind: 'device' as const, config: { purpose: 'voice' as const } };
    return parseUsageDevice({
        host: prefs.host,
        input: inputSource.kind === 'process_loopback' ? undefined : prefs.input,
        inputId: inputSource.kind === 'process_loopback' ? undefined : prefs.inputId,
        output: prefs.output,
        outputId: prefs.outputId,
        sampleRate: prefs.sampleRate,
        bufferSize: prefs.bufferSize,
        inputSource,
    }, purpose);
}
