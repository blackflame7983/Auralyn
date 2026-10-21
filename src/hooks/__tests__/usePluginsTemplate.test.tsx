import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { usePlugins } from '../usePlugins';
import type { VstPlugin } from '../../api/audio';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const plugin = (path: string): VstPlugin => ({ id: path, name: path, path, vendor: '', version: '', category: 'Fx' });

beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('移行したVSTは確認後までロードせず、未確認のセッションを空で保存しない', async () => {
    const session = JSON.stringify([{ path: 'eq.vst3', name: 'EQ', vendor: '', version: '', enabled: true, muted: false, gain: 1 }]);
    localStorage.setItem('vst_host_session_plugins', session);
    localStorage.setItem('vst_host_migration_review_required', 'true');
    vi.mocked(invoke).mockResolvedValue('new-id');
    const { result } = renderHook(() => usePlugins());
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalledWith('load_plugin', expect.anything());
    expect(localStorage.getItem('vst_host_session_plugins')).toBe(session);
    await act(async () => {
        localStorage.removeItem('vst_host_migration_review_required');
        window.dispatchEvent(new Event('migration-review-completed'));
    });
    expect(invoke).toHaveBeenCalledWith('load_plugin', { path: 'eq.vst3' });
    expect(result.current.plugins[0].name).toBe('EQ');
});

it.each([
    [['comp', 'limit'], false, []],
    [['limit'], false, ['comp']],
    [[], true, ['comp', 'limit']],
] as const)('テンプレート読み込みの失敗 %j を結果とラックに反映する', async (failures, expected, loaded) => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'load_plugin') {
            const path = (args as { path: string }).path;
            if ((failures as readonly string[]).includes(path)) throw new Error('読み込み失敗');
            return `instance-${path}`;
        }
    });
    const { result } = renderHook(() => usePlugins());
    await act(async () => {});
    await act(async () => { await result.current.addPlugin(plugin('old')); });
    let applied: boolean | undefined;
    await act(async () => { applied = await result.current.applyTemplate({ '0': plugin('comp'), '1': plugin('limit') }); });
    expect(invoke).toHaveBeenCalledWith('remove_plugin', { id: 'instance-old' });
    expect(applied).toBe(expected);
    expect(result.current.plugins.map(p => p.path)).toEqual(loaded);
    expect(result.current.isLoading).toBe(false);
    if (!expected) expect(result.current.error).toMatch(/読み込めませんでした/);
});

it('削除が途中で失敗しても削除済みVSTを表示せず、残った構成から再試行できる', async () => {
    let failRemoval = true;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'load_plugin') return (args as { path: string }).path;
        if (command === 'remove_plugin' && (args as { id: string }).id === 'old-2' && failRemoval) {
            throw new Error('削除失敗');
        }
    });
    const { result } = renderHook(() => usePlugins());
    await act(async () => {});
    await act(async () => {
        await result.current.addPlugin(plugin('old-1'));
        await result.current.addPlugin(plugin('old-2'));
    });
    await act(async () => { expect(await result.current.applyTemplate({ '0': plugin('new') })).toBe(false); });
    expect(result.current.plugins.map(p => p.id)).toEqual(['old-2']);
    expect(invoke).not.toHaveBeenCalledWith('load_plugin', { path: 'new' });
    expect(result.current.isLoading).toBe(false);
    failRemoval = false;
    await act(async () => { expect(await result.current.applyTemplate({ '0': plugin('new') })).toBe(true); });
    expect(result.current.plugins.map(p => p.id)).toEqual(['new']);
    expect(result.current.error).toBeNull();
    expect(vi.mocked(invoke).mock.calls.filter(([command, args]) => command === 'remove_plugin' && (args as { id: string }).id === 'old-1')).toHaveLength(1);
});
