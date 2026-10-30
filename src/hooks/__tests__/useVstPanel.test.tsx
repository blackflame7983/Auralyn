import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getVstPanelOpen, saveVstPanelOpen, useVstPanel } from '../useVstPanel';
import { saveDisplayPurpose } from '../useDisplayPurpose';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); saveVstPanelOpen(false); localStorage.clear(); });

it.each([
    { label: '未設定', storage: {}, open: false },
    { label: '以前のかんたん表示', storage: { vst_host_beginner_mode: 'true' }, open: false },
    { label: '以前の VST・詳細', storage: { vst_host_beginner_mode: 'false' }, open: true },
    { label: '音楽鑑賞', storage: { auralyn_display_purpose: 'music' }, open: true },
    { label: '音楽鑑賞のセットアップ', storage: { vst_host_setup_goal: 'music' }, open: true },
    { label: '保存値が優先', storage: { vst_host_beginner_mode: 'false', auralyn_vst_panel_open: 'false' }, open: false },
])('保存値がない間の既定を以前の表示と用途から決める（$label）', ({ storage, open }) => {
    Object.entries(storage).forEach(([key, value]) => localStorage.setItem(key, value));
    expect(getVstPanelOpen()).toBe(open);
});

it('表示用途を変えると、保存値がない間の既定を読み直す', () => {
    const { result } = renderHook(() => useVstPanel());
    expect(result.current[0]).toBe(false);
    act(() => saveDisplayPurpose('music'));
    expect(result.current[0]).toBe(true);
});

it('保存できない環境でも、押した開閉はこの画面の間そのまま使う', () => {
    const { result } = renderHook(() => useVstPanel());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](previous => !previous));
    expect(result.current[0]).toBe(false);
});
