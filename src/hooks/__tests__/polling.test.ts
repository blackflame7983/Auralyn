import { afterEach, expect, it, vi } from 'vitest';
import { startPolling } from '../internal/polling';

afterEach(() => vi.useRealTimers());

it('応答待ち中は重複せず、停止後の遅い応答でも再開しない', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const request = vi.fn((current: AbortSignal) => {
        signal = current;
        return new Promise<void>(resolve => { finish = resolve; });
    });
    const onValue = vi.fn();
    const stop = startPolling({ intervalMs: 100, request, onValue, onError: error => { throw error; } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    stop();
    expect(signal?.aborted).toBe(true);
    finish?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(onValue).not.toHaveBeenCalled();
});

it('失敗を通知した後も間隔を守って再開し、停止でタイマーを回収する', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const onError = vi.fn();
    const stop = startPolling({ intervalMs: 100, request, onValue: vi.fn(), onError });
    try {
        await vi.advanceTimersByTimeAsync(99);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(request).toHaveBeenCalledTimes(2);
    } finally { stop(); }
    expect(vi.getTimerCount()).toBe(0);
});
