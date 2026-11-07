import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openStreamMixPanel, readStreamMixPanel, saveStreamMixPanel, takeStreamMixOpenRequest, useStreamMixPanel } from '../streamMixPanel';

beforeEach(() => { localStorage.clear(); saveStreamMixPanel(false); localStorage.clear(); takeStreamMixOpenRequest(); });

it('既定ではホームにパネルを出さない（#299）', () => {
    expect(readStreamMixPanel()).toBe(false);
});

it('表示の切替を保存し、開いている画面へすぐ反映する', () => {
    const view = renderHook(() => useStreamMixPanel());
    expect(view.result.current).toBe(false);
    act(() => saveStreamMixPanel(true));
    expect(view.result.current).toBe(true);
    expect(localStorage.getItem('auralyn_stream_mix_panel')).toBe('shown');
    act(() => saveStreamMixPanel(false));
    expect(view.result.current).toBe(false);
    expect(localStorage.getItem('auralyn_stream_mix_panel')).toBe('hidden');
});

it('開く依頼はパネルを出し、描画後に一度だけ受け取れる', () => {
    act(() => openStreamMixPanel());
    expect(readStreamMixPanel()).toBe(true);
    expect(takeStreamMixOpenRequest()).toBeGreaterThan(0);
    expect(takeStreamMixOpenRequest()).toBe(0);
});

afterEach(() => { vi.useRealTimers(); });
it('描画されないまま時間が経った開く依頼は、後で受け取っても使わない', () => {
    vi.useFakeTimers();
    act(() => openStreamMixPanel());
    vi.advanceTimersByTime(5000);
    expect(takeStreamMixOpenRequest()).toBe(0);
});
