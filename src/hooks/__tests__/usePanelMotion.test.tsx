import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePanelMotion } from '../usePanelMotion';

function panelWithAnimation() {
    const finish = vi.fn();
    const animations: Pick<Animation, 'finish'>[] = [{ finish }];
    const element = document.createElement('aside');
    (element as unknown as { getAnimations: () => Pick<Animation, 'finish'>[] }).getAnimations = () => animations;
    return { ref: { current: element as HTMLElement }, finish, animations };
}

let reducedMatches = false;
const mediaListeners = new Set<() => void>();
function setReducedMotion(value: boolean) {
    reducedMatches = value;
    mediaListeners.forEach(listener => listener());
}

beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty('--motion-panel', '240ms');
    document.documentElement.style.setProperty('--ease-drawer', 'cubic-bezier(0.32, 0.72, 0, 1)');
    reducedMatches = false;
    vi.stubGlobal('matchMedia', (query: string) => ({
        get matches() { return query.includes('reduce') && reducedMatches; },
        addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener),
    }));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    mediaListeners.clear();
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

it('起動中に動きを減らす設定を切り替えると、再読込なしで移動の有無が変わる', () => {
    const { ref } = panelWithAnimation();
    const view = renderHook(() => usePanelMotion(true, ref));
    const hiddenTransform = () => (view.result.current.motionProps.variants.hidden as { transform: string }).transform;
    expect(hiddenTransform()).toBe('translateX(100%)');
    act(() => setReducedMotion(true));
    expect(hiddenTransform()).toBe('none');
    act(() => setReducedMotion(false));
    expect(hiddenTransform()).toBe('translateX(100%)');
    view.unmount();
    expect(mediaListeners.size).toBe(0);
});

it('退場の間は残し、途中で開き直したパネルを古いタイマーで閉じない', () => {
    const { ref, finish } = panelWithAnimation();
    const view = renderHook(({ open }) => usePanelMotion(open, ref), { initialProps: { open: false } });
    fireEvent.pointerDown(window);
    view.rerender({ open: true });
    view.rerender({ open: false });
    expect(view.result.current.present).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    view.rerender({ open: true });
    act(() => vi.advanceTimersByTime(500));
    expect(finish).not.toHaveBeenCalled();
    expect(view.result.current.present).toBe(true);
    view.rerender({ open: false });
    act(() => view.result.current.onExitComplete());
    expect(view.result.current.present).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
});

it('終了通知が届かなくても、予定より少し後に退場を確定させる', () => {
    const { ref, finish } = panelWithAnimation();
    const view = renderHook(({ open }) => usePanelMotion(open, ref), { initialProps: { open: true } });
    fireEvent.pointerDown(window);
    view.rerender({ open: false });
    act(() => vi.advanceTimersByTime(380));
    expect(view.result.current.present).toBe(true);
    act(() => vi.advanceTimersByTime(20));
    expect(finish).toHaveBeenCalledTimes(1);
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
    view.unmount();
});

it('最初のフレーム前でアニメーションがまだなくても、キーボードへ切り替えれば短い待ちで片付ける', () => {
    const { ref, animations, finish } = panelWithAnimation();
    animations.length = 0;
    const view = renderHook(({ open }) => usePanelMotion(open, ref), { initialProps: { open: true } });
    fireEvent.pointerDown(window);
    view.rerender({ open: false });
    fireEvent.keyDown(window, { key: 'Tab' });
    animations.push({ finish });
    act(() => vi.advanceTimersByTime(150));
    expect(finish).toHaveBeenCalledTimes(1);
    expect(view.result.current.present).toBe(false);
    view.unmount();
});
