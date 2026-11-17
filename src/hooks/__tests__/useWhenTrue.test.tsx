import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWhenTrue } from '../useWhenTrue';

afterEach(cleanup);

it('真で始まったときと、偽から真に変わったときだけ動かす', () => {
    const run = vi.fn();
    const { rerender } = renderHook(({ on }) => useWhenTrue(on, run), { initialProps: { on: false } });
    expect(run).not.toHaveBeenCalled();
    rerender({ on: true });
    expect(run).toHaveBeenCalledTimes(1);
    rerender({ on: true });
    expect(run).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    expect(run).toHaveBeenCalledTimes(1);
    rerender({ on: true });
    expect(run).toHaveBeenCalledTimes(2);
});

it('真のまま始まったときは、すぐ1回動かす', () => {
    const run = vi.fn();
    renderHook(() => useWhenTrue(true, run));
    expect(run).toHaveBeenCalledTimes(1);
});

it('呼ぶ関数は、変わった描画の最新のものを使う', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ on, run }) => useWhenTrue(on, run), { initialProps: { on: false, run: first } });
    rerender({ on: true, run: second });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
});

it('関数の入れ替えだけでは動かさない', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ run }) => useWhenTrue(true, run), { initialProps: { run: first } });
    rerender({ run: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
});
