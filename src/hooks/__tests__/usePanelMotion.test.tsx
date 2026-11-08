import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePanelMotion } from '../usePanelMotion';

function panelWithAnimation() {
    const finish = vi.fn();
    const element = document.createElement('aside');
    (element as unknown as { getAnimations: () => Pick<Animation, 'finish'>[] }).getAnimations = () => [{ finish }];
    return { ref: { current: element as HTMLElement }, finish };
}

beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--motion-panel', '240ms');
    document.documentElement.style.setProperty('--ease-drawer', 'cubic-bezier(0.32, 0.72, 0, 1)');
});
afterEach(() => {
    vi.useRealTimers();
    document.documentElement.style.removeProperty('--motion-panel');
    document.documentElement.style.removeProperty('--ease-drawer');
});

it('トークンの時間と曲線で動かし、キーボード操作では動かさない', () => {
    const { ref } = panelWithAnimation();
    const view = renderHook(() => usePanelMotion(true, ref));
    expect(view.result.current.motionProps.initial).toBe(false);
    expect(view.result.current.motionProps.transition).toMatchObject({ duration: 0 });
    fireEvent.pointerDown(window);
    expect(view.result.current.motionProps.initial).toBe('hidden');
    expect(view.result.current.motionProps.transition).toMatchObject({ duration: 0.24, ease: [0.32, 0.72, 0, 1] });
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(view.result.current.motionProps.transition).toMatchObject({ duration: 0 });
});

it('退場の間は残し、終了通知がなくても片付け、途中で開き直したパネルを古いタイマーで閉じない', () => {
    const { ref, finish } = panelWithAnimation();
    const view = renderHook(({ open }) => usePanelMotion(open, ref), { initialProps: { open: false } });
    fireEvent.pointerDown(window);
    view.rerender({ open: true });
    view.rerender({ open: false });
    expect(view.result.current.present).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    view.rerender({ open: true });
    act(() => vi.advanceTimersByTime(300));
    expect(finish).not.toHaveBeenCalled();
    view.rerender({ open: false });
    act(() => vi.advanceTimersByTime(290));
    expect(finish).toHaveBeenCalledTimes(1);
    act(() => view.result.current.onExitComplete());
    expect(view.result.current.present).toBe(false);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('終了待ちの途中にキーボード操作へ切り替えると、残りの動きを待たずに片付ける', () => {
    const { ref, finish } = panelWithAnimation();
    const view = renderHook(({ open }) => usePanelMotion(open, ref), { initialProps: { open: true } });
    fireEvent.pointerDown(window);
    view.rerender({ open: false });
    expect(view.result.current.present).toBe(true);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
});
