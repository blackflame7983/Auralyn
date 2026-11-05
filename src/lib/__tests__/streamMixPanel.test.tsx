import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
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
    expect(takeStreamMixOpenRequest()).toBe(true);
    expect(takeStreamMixOpenRequest()).toBe(false);
});
