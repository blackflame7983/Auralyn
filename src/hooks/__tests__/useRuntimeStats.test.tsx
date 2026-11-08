import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { listen } from '@tauri-apps/api/event';
import { refreshRuntimeStats, refreshRuntimeStatsChecked, useRuntimeStats, useRuntimeStatsUnavailable } from '../useRuntimeStats';

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


it('一度取得した統計が失敗したら不明にし、次の成功で戻す', async () => {
    const view = renderHook(() => ({ stats: useRuntimeStats(), unavailable: useRuntimeStatsUnavailable() }));
    await act(async () => {});
    expect(view.result.current.unavailable).toBe(false);
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result.current.stats).toBeNull();
    expect(view.result.current.unavailable).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result.current.stats).toEqual(stats(1));
    expect(view.result.current.unavailable).toBe(false);
});

it('成功のあと2.5秒更新が無いと統計を失効させる', async () => {
    const view = renderHook(() => useRuntimeStatsUnavailable());
    await act(async () => {});
    expect(view.result.current).toBe(false);
    vi.mocked(audioApi.getEngineRuntimeStats).mockReturnValue(new Promise(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(view.result.current).toBe(true);
});

it('取得失敗は明示更新の成功とせず、後続の成功で復旧する', async () => {
    const view = renderHook(() => useRuntimeStats());
    await act(async () => {});
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await expect(refreshRuntimeStatsChecked()).rejects.toThrow(); });
    expect(view.result.current).toBeNull();
    await act(async () => { await expect(refreshRuntimeStatsChecked()).resolves.toEqual(stats(1)); });
});

it('全利用終了時に未完了の旧取得から独立し、再利用時は古い応答を捨てる', async () => {
    let finish!: (value: EngineRuntimeStats) => void;
    vi.mocked(audioApi.getEngineRuntimeStats).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const old = renderHook(() => useRuntimeStats());
    old.unmount();
    const next = renderHook(() => useRuntimeStats());
    await act(async () => {});
    expect(next.result.current).toEqual(stats(1));
    await act(async () => { finish(stats(99)); });
    expect(next.result.current).toEqual(stats(1));
});


it('強制取得中に状態が無効化されたら古いsnapshotを成功として返さない', async () => {
    const view = renderHook(() => useRuntimeStats());
    await act(async () => {});
    let finish!: (value: EngineRuntimeStats) => void;
    vi.mocked(audioApi.getEngineRuntimeStats).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let request!: Promise<EngineRuntimeStats>;
    act(() => { request = refreshRuntimeStatsChecked(); });
    act(() => handlers.get('audio-stopped')!());
    await act(async () => { finish(stats(9)); await expect(request).rejects.toThrow(); });
    expect(view.result.current).toBeNull();
});

it('profile通知後に古い取得を捨て、派生値を含む新しい統計を取得する', async () => {
    let finish!: (value: EngineRuntimeStats) => void;
    const old = { ...stats(1), latencyMetadata: { schemaVersion: 1, streamRunning: true, nrProcessingFrameSamples: 480 } } as EngineRuntimeStats;
    const fresh = { ...stats(2), latencyMetadata: { schemaVersion: 1, streamRunning: true, nrProcessingFrameSamples: 960 } } as EngineRuntimeStats;
    vi.mocked(audioApi.getEngineRuntimeStats).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(fresh);
    const view = renderHook(() => useRuntimeStats());
    act(() => window.dispatchEvent(new CustomEvent('profile-fx-applied', { detail: { noiseControl: { enabled: true } } })));
    await act(async () => { finish(old); });
    expect(view.result.current).toEqual(fresh);
});
