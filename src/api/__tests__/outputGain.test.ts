import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
    confirmOutputGain,
    gainCommand,
    publishOutputGain,
    restoreSavedOutputGain,
    setOutputGain,
    type GainSnapshot,
} from '../outputGain';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const state: GainSnapshot = {
    revision: 20,
    gain: 0.8,
    confirmedGain: 0.8,
    settled: true,
    running: true,
    streamFailed: false,
    id: 10,
    phase: 'ready',
    progress: 1,
    proposal: null,
    playing: false,
    error: null,
    devices: [],
};
beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
});
describe('出力ゲインの反映確認', () => {
    it('起動中の世代変更を再確認し、明示変更済みの音量を旧保存値で戻さない', async () => {
        vi.mocked(invoke)
            .mockResolvedValueOnce({ ...state, settled: false })
            .mockResolvedValueOnce({ ...state, revision: 21, gain: 0.5, confirmedGain: 0.5 });
        await restoreSavedOutputGain(0.8);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
        expect(invoke).toHaveBeenCalledTimes(2);
        expect(invoke).toHaveBeenLastCalledWith('auto_gain', {
            request: { action: 'initialize', value: 0.8 },
        });
    });

    it('起動復元のストリーム障害を成功として保存しない', async () => {
        vi.mocked(invoke).mockResolvedValue({ ...state, running: false, streamFailed: true, settled: false });
        await expect(restoreSavedOutputGain(0.8)).rejects.toThrow('音声状態を確認できません');
        expect(localStorage.getItem('vst_host_output_gain')).toBeNull();
    });

    it('遅い起動時復元はプロファイルの実値を保存し、旧値を再送しない', async () => {
        let finish!: (s: GainSnapshot) => void;
        vi.mocked(invoke).mockImplementationOnce(
            () => new Promise<GainSnapshot>((resolve) => {
                finish = resolve;
            }),
        );
        const restore = restoreSavedOutputGain(1);
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
        // プロファイルのmutexが解放された時点では50%が明示適用済み。
        finish({ ...state, gain: 0.5, confirmedGain: 0.5 });
        await restore;
        expect(invoke).toHaveBeenCalledWith('auto_gain', {
            request: { action: 'initialize', value: 1 },
        });
        expect(
            vi.mocked(invoke).mock.calls.some(([command]) => command === 'set_output_gain'),
        ).toBe(false);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
    });

    it('通常起動の保存値復元はRTの反映を待って保存する', async () => {
        vi.mocked(invoke)
            .mockResolvedValueOnce({ ...state, settled: false })
            .mockResolvedValueOnce(state);
        await restoreSavedOutputGain(0.8);
        expect(invoke).toHaveBeenNthCalledWith(1, 'auto_gain', {
            request: { action: 'initialize', value: 0.8 },
        });
        expect(localStorage.getItem('vst_host_output_gain')).toBe('80');
    });
    it('ストリーム障害を停止中の設定保存と誤認しない', async () => {
        vi.mocked(invoke).mockImplementation(async (command) =>
            command === 'set_output_gain'
                ? undefined
                : { ...state, running: false, streamFailed: true, settled: false },
        );
        await expect(setOutputGain(0.8)).rejects.toThrow('音声状態が変わりました');
        expect(localStorage.getItem('vst_host_output_gain')).toBeNull();
    });
    it('未確認の値を保存せず、確認済み値を表示へ同期する', () => {
        publishOutputGain({ ...state, settled: false });
        expect(localStorage.getItem('vst_host_output_gain')).toBeNull();
        const cb = vi.fn();
        window.addEventListener('output-gain-sync', cb);
        publishOutputGain(state);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('80');
        expect(cb).toHaveBeenCalledOnce();
        window.removeEventListener('output-gain-sync', cb);
    });
    it('世代が変わった場合は元の操作を成功扱いにしない', async () => {
        vi.mocked(invoke).mockResolvedValue({ ...state, revision: 21, gain: 1, confirmedGain: 1 });
        await expect(confirmOutputGain(state)).rejects.toThrow('音声設定が変わりました');
        expect(localStorage.getItem('vst_host_output_gain')).toBe('100');
    });
    it('実値の反映を待ち、同じゲインを二重に掛けない', async () => {
        vi.mocked(invoke).mockImplementation(async (command) =>
            command === 'set_output_gain' ? undefined : state,
        );
        await setOutputGain(0.8);
        expect(invoke).toHaveBeenCalledWith('set_output_gain', { value: 0.8 });
        expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'set_output_gain')).toHaveLength(
            1,
        );
        expect(localStorage.getItem('vst_host_output_gain')).toBe('80');
    });
    it('遅い開始の後に中止を送り、遅れて録音を残さない', async () => {
        let finish!: (s: GainSnapshot) => void;
        vi.mocked(invoke)
            .mockImplementationOnce(
                () =>
                    new Promise<GainSnapshot>((resolve) => {
                        finish = resolve;
                    }),
            )
            .mockResolvedValue(state);
        const begin = gainCommand({ action: 'begin', target: -20, revision: 20 });
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
        const cancel = gainCommand({ action: 'cancel' });
        expect(invoke).toHaveBeenCalledOnce();
        finish(state);
        await begin;
        await cancel;
        expect(invoke).toHaveBeenLastCalledWith('auto_gain', { request: { action: 'cancel' } });
    });
    it('入力値・IPC失敗を保存せず伝播する', async () => {
        await expect(setOutputGain(NaN)).rejects.toThrow();
        vi.mocked(invoke).mockRejectedValue(new Error('engine unavailable'));
        await expect(setOutputGain(1)).rejects.toThrow('engine unavailable');
        expect(localStorage.getItem('vst_host_output_gain')).toBeNull();
    });
});
