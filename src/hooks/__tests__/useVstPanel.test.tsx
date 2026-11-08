import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { saveDisplayPurpose } from '../useDisplayPurpose';

let panel: typeof import('../useVstPanel');
beforeEach(async () => { vi.resetModules(); localStorage.clear(); panel = await import('../useVstPanel'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it.each([
    { purpose: 'voice', saved: 'true', legacy: 'false', open: false },
    { purpose: 'voice', saved: 'false', legacy: 'true', open: false },
    { purpose: 'music', saved: 'false', legacy: 'true', open: true },
    { purpose: 'music', saved: 'true', legacy: 'false', open: true },
])('起動時は保存値によらず用途で開閉を決める ($purpose / $saved)', ({ purpose, saved, legacy, open }) => {
    localStorage.setItem('auralyn_display_purpose', purpose);
    localStorage.setItem('auralyn_vst_panel_open', saved);
    localStorage.setItem('vst_host_beginner_mode', legacy);
    const { result } = renderHook(() => panel.useVstPanel());
    expect(result.current[0]).toBe(open);
    expect(localStorage.getItem('auralyn_vst_panel_open')).toBe(saved);
});

it('表示用途を変えると、明示操作前の既定を読み直す', () => {
    const { result } = renderHook(() => panel.useVstPanel());
    expect(result.current[0]).toBe(false);
    act(() => saveDisplayPurpose('music'));
    expect(result.current[0]).toBe(true);
});

it.each([false, true])('起動後の開閉は複数の利用箇所へ共有し、保存の成否によらず維持する (保存失敗=%s)', fails => {
    const first = renderHook(() => panel.useVstPanel());
    const second = renderHook(() => panel.useVstPanel());
    if (fails) vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    act(() => first.result.current[1](true));
    expect(first.result.current[0]).toBe(true);
    expect(second.result.current[0]).toBe(true);
    if (!fails) expect(localStorage.getItem('auralyn_vst_panel_open')).toBe('true');
    act(() => second.result.current[1](previous => !previous));
    expect(first.result.current[0]).toBe(false);
    expect(second.result.current[0]).toBe(false);
});
