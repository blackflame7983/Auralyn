import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MasterBar } from '../MasterBar';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@/api/audio', () => ({
    audioApi: { getEngineRuntimeStats: vi.fn().mockRejectedValue(new Error('停止中')) },
}));

let running: boolean;
let gain: number;
let initialized: boolean;
let finishListening: () => void;
let started: () => void;
let unlistenStarted: () => void;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('vst_host_output_gain', '50');
    running = false;
    gain = 1;
    initialized = false;
    unlistenStarted = vi.fn();
    vi.mocked(listen).mockImplementation((event, callback) => {
        if (event !== 'audio-started') return Promise.resolve(vi.fn());
        started = () => callback({ event, id: 1, payload: undefined });
        return new Promise((resolve) => {
            finishListening = () => resolve(unlistenStarted);
        });
    });
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
        const { request } = args as { request: { action: string; value?: number } };
        if (request.action === 'initialize' && running && !initialized) {
            gain = request.value!;
            initialized = true;
        }
        return {
            revision: 1, gain, confirmedGain: gain, running, settled: running,
            streamFailed: false, id: 0, phase: 'idle', progress: 0,
            proposal: null, playing: false, error: null, devices: [],
        };
    });
});

afterEach(async () => {
    cleanup();
    await act(async () => {});
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('起動時の保存ゲイン復元', () => {
    it('購読待ち中に開始イベントを逃しても保存値を復元し、定期取得で100%を保存しない', async () => {
        render(<MasterBar />);
        await act(async () => {});
        await act(async () => {
            // 起動が購読完了より先でも、完了後の初期取得で拾う。
            running = true;
            await vi.advanceTimersByTimeAsync(1500);
        });
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
        expect(invoke).not.toHaveBeenCalled();
        await act(async () => { finishListening(); });
        expect(gain).toBe(0.5);
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
    });

    it('購読完了後に開始した場合もイベントから復元する', async () => {
        render(<MasterBar />);
        await act(async () => { finishListening(); });
        expect(gain).toBe(1);
        await act(async () => {
            running = true;
            started();
        });
        expect(gain).toBe(0.5);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
    });

    it('購読待ち中に閉じた場合は遅い初期化や定期取得を残さない', async () => {
        const view = render(<MasterBar />);
        view.unmount();
        await act(async () => {
            finishListening();
            await vi.advanceTimersByTimeAsync(1500);
        });
        expect(unlistenStarted).toHaveBeenCalledOnce();
        expect(invoke).not.toHaveBeenCalled();
    });
});
