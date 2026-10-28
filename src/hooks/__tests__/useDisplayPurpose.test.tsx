import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readDisplayPurpose, saveDisplayPurpose, useDisplayPurpose } from '../useDisplayPurpose';

beforeEach(() => localStorage.clear());
afterEach(cleanup);
it('保存された表示を優先し、未保存時だけセットアップ用途を使う', () => {
    expect(readDisplayPurpose()).toBe('voice');
    localStorage.setItem('vst_host_setup_goal', 'music');
    expect(readDisplayPurpose()).toBe('music');
    saveDisplayPurpose('voice');
    expect(readDisplayPurpose()).toBe('voice');
    localStorage.setItem('auralyn_display_purpose', 'broken');
    expect(readDisplayPurpose()).toBe('music');
});
it('複数の表示を同期し、音声用途・音量・ミュートを保持する', () => {
    localStorage.setItem('vst_host_setup_goal', 'obs');
    localStorage.setItem('vst_host_output_gain', '81');
    localStorage.setItem('vst_host_muted', 'true');
    const first = renderHook(useDisplayPurpose); const second = renderHook(useDisplayPurpose);
    act(() => first.result.current[1]('music'));
    expect(second.result.current[0]).toBe('music');
    expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
    expect(localStorage.getItem('vst_host_output_gain')).toBe('81');
    expect(localStorage.getItem('vst_host_muted')).toBe('true');
});
