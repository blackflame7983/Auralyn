import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTauriMock, realisticAudioConfig, realisticDeviceNames, type TauriMockOptions } from '../tauriMock';

interface MockWindow {
    __e2eMeterLevels?: (level: number) => { input: number[]; output: number[] };
    __e2eSetOutputMuted?: (muted: boolean) => void;
    __e2ePresetOutputMuted?: (muted: boolean) => void;
    __e2eSetOutputGain?: (value: number) => void;
    __e2eEmit?: (event: string, payload: unknown) => void;
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

// 実エンジン（audio_engine/core/startup.rs）は、緊急ミュート中は出力を無音で書いて出力レベルを 0 にし、
// 入力レベルはそのまま送る。ミュートでないときは、出力音量を掛けたあとを測る。
describe('模擬のメーターレベル', () => {
    it('ミュート中は出力を 0 にし、入力はそのまま送る', () => {
        installTauriMock(legacyOptions);
        const levels = mockWindow().__e2eMeterLevels?.(0.1);
        expect(levels).toEqual({ input: [0.1, 0.1], output: [0, 0] });
    });

    it('ミュートを解除すると出力のレベルが戻り、もう一度ミュートすると 0 になる', () => {
        installTauriMock(legacyOptions);
        mockWindow().__e2eSetOutputMuted?.(false);
        expect(mockWindow().__e2eMeterLevels?.(0.1)).toEqual({ input: [0.1, 0.1], output: [0.1, 0.1] });
        mockWindow().__e2eSetOutputMuted?.(true);
        expect(mockWindow().__e2eMeterLevels?.(0.1)?.output).toEqual([0, 0]);
    });

    it('出力音量を掛けたあとを測り、音量ゼロなら出力は 0 になる', () => {
        installTauriMock(legacyOptions);
        mockWindow().__e2eSetOutputMuted?.(false);
        mockWindow().__e2eSetOutputGain?.(0.5);
        expect(mockWindow().__e2eMeterLevels?.(0.2)).toEqual({ input: [0.2, 0.2], output: [0.1, 0.1] });
        mockWindow().__e2eSetOutputGain?.(0);
        expect(mockWindow().__e2eMeterLevels?.(0.2)?.output).toEqual([0, 0]);
    });
});
// 実エンジンは、緊急ミュートの切替で global-mute-changed だけを送る。準備の画面へ直接知らせる経路を模擬に持たせると、
// 本番で起きる取り直しの遅れを試験が隠す（#799）。
describe('模擬の緊急ミュートは実エンジンと同じ通知だけを送る', () => {
    const observe = () => {
        installTauriMock(legacyOptions);
        const emitted: Array<[string, unknown]> = [];
        mockWindow().__e2eEmit = (event, payload) => { emitted.push([event, payload]); };
        const direct = vi.fn();
        window.addEventListener('preparation-external-change', direct);
        return { emitted, direct, stop: () => window.removeEventListener('preparation-external-change', direct) };
    };

    it('__e2eSetOutputMuted は global-mute-changed を送り、準備の外部変更の通知は送らない', () => {
        const { emitted, direct, stop } = observe();
        mockWindow().__e2eSetOutputMuted?.(false);
        mockWindow().__e2eSetOutputMuted?.(true);
        stop();
        expect(emitted).toEqual([['global-mute-changed', false], ['global-mute-changed', true]]);
        expect(direct).not.toHaveBeenCalled();
    });

    it('準備用の __e2ePresetOutputMuted は、状態だけを変えて緊急ミュートの通知を送らない', () => {
        const { emitted, direct, stop } = observe();
        mockWindow().__e2ePresetOutputMuted?.(false);
        stop();
        expect(mockWindow().__e2eMeterLevels?.(0.1)?.output).toEqual([0.1, 0.1]);
        expect(emitted).toEqual([]);
        expect(direct).toHaveBeenCalledTimes(1);
    });

    it('set_global_mute と toggle_global_mute は、状態を変えて global-mute-changed を送る', async () => {
        const { emitted, direct, stop } = observe();
        const invoke = mockWindow().__TAURI_INTERNALS__?.invoke;
        await invoke?.('set_global_mute', { active: false });
        expect(mockWindow().__e2eMeterLevels?.(0.1)?.output).toEqual([0.1, 0.1]);
        await invoke?.('toggle_global_mute');
        stop();
        expect(mockWindow().__e2eMeterLevels?.(0.1)?.output).toEqual([0, 0]);
        expect(emitted).toEqual([['global-mute-changed', false], ['global-mute-changed', true]]);
        expect(direct).not.toHaveBeenCalled();
    });
});