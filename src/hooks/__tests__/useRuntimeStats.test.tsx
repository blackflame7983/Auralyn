import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { listen } from '@tauri-apps/api/event';
import { refreshRuntimeStats, useRuntimeStats } from '../useRuntimeStats';

const stats = (count: number) => ({ glitchCount: count } as EngineRuntimeStats);
const handlers = new Map<string, () => void>();
beforeEach(() => {
    vi.useFakeTimers(); handlers.clear();
    vi.mocked(listen).mockImplementation(async (name, callback) => {
        handlers.set(name, () => callback({ event: name, id: 1, payload: undefined }));
        return () => { handlers.delete(name); };
    });
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue(stats(1));
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.restoreAllMocks(); vi.useRealTimers(); });

it('複数の利用者で一つの取得を共有し、全員が離れたら停止する', async () => {
    const first = renderHook(() => useRuntimeStats());
    const second = renderHook(() => useRuntimeStats());
    await act(async () => {});
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(1);
    expect(first.result.current).toEqual(stats(1));
    expect(second.result.current).toEqual(stats(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(3);
    first.unmount(); second.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(3);
});

it('取得中の明示更新は重複させず、古い応答を捨てて新しい取得を待つ', async () => {
    let finish!: (value: EngineRuntimeStats) => void;
    vi.mocked(audioApi.getEngineRuntimeStats).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(stats(2));
    const view = renderHook(() => useRuntimeStats());
    let refreshed = false;
    void refreshRuntimeStats(true).then(() => { refreshed = true; });
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(1);
    await act(async () => { finish(stats(1)); });
    expect(view.result.current).toEqual(stats(2));
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(2);
    expect(refreshed).toBe(true);
});

it('停止・非表示・取得失敗では古い値を無効にし復帰時に再取得する', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const view = renderHook(() => useRuntimeStats());
    await act(async () => {});
    act(() => handlers.get('audio-stopped')!());
    expect(view.result.current).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result.current).toEqual(stats(1));
    hidden.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(view.result.current).toBeNull();
    const calls = vi.mocked(audioApi.getEngineRuntimeStats).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(calls);
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValueOnce(new Error('failed'));
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(view.result.current).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result.current).toEqual(stats(1));
});


it('状態通知の購読に失敗したら古い取得結果を捨て、未確認のままにする', async () => {
    let finish!: (value: EngineRuntimeStats) => void;
    vi.mocked(audioApi.getEngineRuntimeStats).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.mocked(listen).mockImplementationOnce(() => Promise.reject(new Error('subscription failed')));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = renderHook(() => useRuntimeStats());
    await act(async () => {});
    await act(async () => { finish(stats(1)); await vi.advanceTimersByTimeAsync(3000); });
    expect(view.result.current).toBeNull();
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('音声統計の状態通知を監視できませんでした。');
    view.unmount();
    const retry = renderHook(() => useRuntimeStats());
    await act(async () => {});
    expect(retry.result.current).toEqual(stats(1));
});
