import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSustained } from '../useSustained';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('条件が指定の時間続いたときだけ true になり、偽になれば数え直す', () => {
    vi.useFakeTimers();
    const view = renderHook(({ condition }) => useSustained(condition, 5000), { initialProps: { condition: true } });
    expect(view.result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(4999); });
    expect(view.result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.result.current).toBe(true);
    view.rerender({ condition: false });
    expect(view.result.current).toBe(false);
    view.rerender({ condition: true });
    expect(view.result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(4999); });
    expect(view.result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.result.current).toBe(true);
});

it('途中で条件が切れたら、前の数えは効かない', () => {
    vi.useFakeTimers();
    const view = renderHook(({ condition }) => useSustained(condition, 5000), { initialProps: { condition: true } });
    act(() => { vi.advanceTimersByTime(3000); });
    view.rerender({ condition: false });
    view.rerender({ condition: true });
    act(() => { vi.advanceTimersByTime(3000); });
    expect(view.result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(view.result.current).toBe(true);
});
