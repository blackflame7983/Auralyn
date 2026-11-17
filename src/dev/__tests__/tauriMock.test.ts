import { afterEach, describe, expect, it } from 'vitest';
import { installTauriMock, realisticAudioConfig, realisticDeviceNames, type TauriMockOptions } from '../tauriMock';

interface MockWindow {
    __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
}

const originalSetItem = Storage.prototype.setItem;

const legacyOptions: TauriMockOptions = {
    liveHome: true, stoppedHome: false, registeredModes: true, builtinEnabled: false, nativeMeterProfile: false, strict: true,
};

function mockWindow(): MockWindow {
    return window as MockWindow;
}

function names(value: unknown, side: 'inputs' | 'outputs'): string[] {
    if (typeof value !== 'object' || value === null) return [];
    const list = (value as { inputs?: unknown; outputs?: unknown })[side];
    if (!Array.isArray(list)) return [];
    return list.flatMap(item => {
        if (typeof item !== 'object' || item === null) return [];
        const name = (item as { name?: unknown }).name;
        return typeof name === 'string' ? [name] : [];
    });
}

function runningNames(value: unknown): { input: string; output: string } | null {
    if (typeof value !== 'object' || value === null) return null;
    const config = (value as { config?: unknown }).config;
    if (typeof config !== 'object' || config === null) return null;
    const record = config as { input?: unknown; output?: unknown };
    if (typeof record.input !== 'string' || typeof record.output !== 'string') return null;
    return { input: record.input, output: record.output };
}

afterEach(() => {
    Storage.prototype.setItem = originalSetItem;
    localStorage.clear();
    delete mockWindow().__TAURI_INTERNALS__;
});

describe('模擬の機器名', () => {
    it('関数本体は、評価用の定数と同じ機器名を持っている', () => {
        const source = installTauriMock.toString();
        for (const name of Object.values(realisticDeviceNames)) expect(source).toContain(name);
        expect(source).toContain('CABLE Output');
        expect(source).toContain('スピーカー');
    });

    it('devices を省くと、実行中は CABLE Output とスピーカーを1台ずつ返す', async () => {
        installTauriMock(legacyOptions);
        const invoke = mockWindow().__TAURI_INTERNALS__?.invoke;
        const listed = await invoke?.('get_audio_devices');
        const state = runningNames(await invoke?.('get_audio_state'));
        expect(names(listed, 'inputs')).toEqual(['CABLE Output']);
        expect(names(listed, 'outputs')).toEqual(['スピーカー']);
        expect(state).toEqual({ input: 'CABLE Output', output: 'スピーカー' });
    });

    it('未設定の legacy は試験用のマイクとヘッドホンのまま', async () => {
        installTauriMock({ ...legacyOptions, liveHome: false, registeredModes: false });
        const invoke = mockWindow().__TAURI_INTERNALS__?.invoke;
        const listed = await invoke?.('get_audio_devices');
        expect(names(listed, 'inputs')).toEqual(['Test microphone']);
        expect(names(listed, 'outputs')).toEqual(['Test headphones']);
    });

    it('realistic は配信の構成を既定にし、保存値が音楽鑑賞ならその入出力を返す', async () => {
        installTauriMock({ ...legacyOptions, devices: 'realistic' });
        const invoke = mockWindow().__TAURI_INTERNALS__?.invoke;
        const listed = await invoke?.('get_audio_devices');
        expect(names(listed, 'inputs')).toEqual([realisticDeviceNames.streamInput, realisticDeviceNames.musicInput]);
        expect(names(listed, 'outputs')).toEqual([realisticDeviceNames.streamOutput, realisticDeviceNames.musicOutput]);
        expect(runningNames(await invoke?.('get_audio_state'))).toEqual({
            input: realisticDeviceNames.streamInput, output: realisticDeviceNames.streamOutput,
        });
        localStorage.setItem('vst_host_audio_config', realisticAudioConfig('music'));
        expect(runningNames(await invoke?.('get_audio_state'))).toEqual({
            input: realisticDeviceNames.musicInput, output: realisticDeviceNames.musicOutput,
        });
    });
});
