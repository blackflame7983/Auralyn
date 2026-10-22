import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import type { Plugin } from '../../components/features/PluginRack/PluginCard';
import { usePluginSessionPersistence } from '../usePluginSessionPersistence';

const plugin = (id: string): Plugin => ({
    id, path: `${id}.vst3`, name: id, vendor: '', version: '',
    enabled: true, muted: false, gain: 1, hasEditor: true,
});

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('削除前の遅い状態取得が、削除後に保存したラックを復活させない', async () => {
    let finish!: (state: string) => void;
    vi.spyOn(audioApi, 'getPluginState').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = renderHook(({ plugins }) => usePluginSessionPersistence(plugins, true, false), {
        initialProps: { plugins: [plugin('old')] },
    });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    rerender({ plugins: [] });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(localStorage.getItem('vst_host_session_plugins')).toBe('[]');
    await act(async () => finish('late-state'));
    expect(localStorage.getItem('vst_host_session_plugins')).toBe('[]');
});

it('パラメーター取得に失敗した保存で、最後の正常な状態を消さない', async () => {
    localStorage.setItem('vst_host_session_plugins', 'last-good-state');
    vi.spyOn(audioApi, 'getPluginState').mockRejectedValue(new Error('engine unavailable'));
    renderHook(() => usePluginSessionPersistence([plugin('eq')], true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(localStorage.getItem('vst_host_session_plugins')).toBe('last-good-state');
});

it('前の定期保存が応答待ちの間は、重複して状態取得を要求しない', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockImplementation(() => new Promise(() => {}));
    const plugins = [plugin('eq')];
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(62_000));
    expect(read).toHaveBeenCalledOnce();
});

it('明示保存の途中で構成が変わったら、成功を通知しない', async () => {
    let finish!: (state: string) => void;
    vi.spyOn(audioApi, 'getPluginState').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender } = renderHook(({ plugins }) => usePluginSessionPersistence(plugins, true, false), {
        initialProps: { plugins: [plugin('eq')] },
    });
    const resolve = vi.fn();
    const reject = vi.fn();
    act(() => window.dispatchEvent(new CustomEvent('auralyn-save-session', { detail: { resolve, reject } })));
    rerender({ plugins: [] });
    await act(async () => finish('old-state'));
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledWith(expect.any(Error));
    expect(localStorage.getItem('vst_host_session_plugins')).toBeNull();
});
