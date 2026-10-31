import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePanelMotion } from '../usePanelMotion';

beforeEach(() => { vi.useFakeTimers(); document.documentElement.style.setProperty('--motion-panel', '240ms'); });
afterEach(() => { vi.useRealTimers(); document.documentElement.style.removeProperty('--motion-panel'); });

it('終了通知がなくても片付け、途中で開き直したパネルを古いタイマーで閉じない', () => {
    const view = renderHook(({ open }) => usePanelMotion(open), { initialProps: { open: false } });
    fireEvent.pointerDown(window);
    view.rerender({ open: true });
    view.rerender({ open: false });
    expect(view.result.current.present).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    view.rerender({ open: true });
    act(() => vi.advanceTimersByTime(300));
    expect(view.result.current.present).toBe(true);
    view.rerender({ open: false });
    act(() => vi.advanceTimersByTime(290));
    expect(view.result.current.present).toBe(false);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('終了待ちの途中にキーボード操作へ切り替えると、残りの動きを待たずに片付ける', () => {
    const view = renderHook(({ open }) => usePanelMotion(open), { initialProps: { open: true } });
    fireEvent.pointerDown(window);
    view.rerender({ open: false });
    expect(view.result.current.present).toBe(true);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(view.result.current.present).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
});
