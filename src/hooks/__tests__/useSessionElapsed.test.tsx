import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSessionElapsed } from '../useSessionElapsed';

afterEach(() => { cleanup(); vi.useRealTimers(); document.dispatchEvent(new Event('visibilitychange')); });

it('開いたときに既に実行中なら出さず、止めてから始めた時刻だけ数える', () => {
    vi.useFakeTimers();
    const view = renderHook(({ running }) => useSessionElapsed(running), { initialProps: { running: true } });
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(view.result.current).toBeNull();
    view.rerender({ running: false });
    expect(view.result.current).toBeNull();
    view.rerender({ running: true });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(view.result.current).toBe('00:01');
    view.rerender({ running: false });
    expect(view.result.current).toBeNull();
});

it('画面が隠れている間はタイマーを進めず、見えたときにまとめて合わせる', () => {
    vi.useFakeTimers();
    const view = renderHook(({ running }) => useSessionElapsed(running), { initialProps: { running: false } });
    view.rerender({ running: true });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(view.result.current).toBe('00:01');
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(view.result.current).toBe('00:01');
    hidden.mockReturnValue(false);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(view.result.current).toBe('00:06');
});
