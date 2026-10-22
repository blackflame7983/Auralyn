import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import { presetApi, type PresetPlugin } from '../../api/presets';
import type { Plugin } from '../../components/features/PluginRack/PluginCard';
import { usePluginProfiles } from '../usePluginProfiles';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const saved: PresetPlugin = { path: 'new', name: 'New', vendor: '', version: '', enabled: false, muted: true, gain: 0.5, state: 'saved' };
const plugin = (id: string): Plugin => ({ ...saved, id, path: id, enabled: true, muted: false, gain: 1, hasEditor: true });
function useFixture(initial: Plugin[] = []) {
    const [plugins, setPlugins] = useState(initial);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    return { ...usePluginProfiles(plugins, setPlugins, setLoading, setError), plugins, loading, error };
}
beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(audioApi, 'loadPlugin').mockImplementation(async path => path);
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setMute').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setPluginState').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('captured');
    vi.spyOn(presetApi, 'load').mockResolvedValue({ name: 'preset', plugins: [saved] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['setBypass', 'setMute', 'setGain', 'setPluginState'] as const)('%s失敗は不完全なVSTを削除し、成功を返さない', async method => {
    vi.mocked(audioApi[method]).mockRejectedValue(new Error('failed'));
    const { result } = renderHook(() => useFixture());
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    expect(audioApi.removePlugin).toHaveBeenCalledWith('new');
    expect(result.current.plugins).toEqual([]);
    expect(result.current.error).toMatch(/復元できませんでした/);
    expect(result.current.loading).toBe(false);
});

it('旧ラックの削除途中で失敗したら、削除できた項目だけ表示から取り除く', async () => {
    vi.mocked(audioApi.removePlugin).mockImplementation(async id => { if (id === 'old-2') throw new Error('remove failed'); });
    const { result } = renderHook(() => useFixture([plugin('old-1'), plugin('old-2')]));
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    expect(result.current.plugins.map(p => p.id)).toEqual(['old-2']);
    expect(audioApi.loadPlugin).not.toHaveBeenCalled();
});

it('復元失敗後の削除も失敗したら、残ったVSTと確認済みの設定を表示し処理を止める', async () => {
    vi.mocked(audioApi.setPluginState).mockRejectedValue(new Error('state failed'));
    vi.mocked(audioApi.removePlugin).mockRejectedValue(new Error('remove failed'));
    vi.mocked(presetApi.load).mockResolvedValue({ name: 'preset', plugins: [saved, { ...saved, path: 'later' }] });
    const { result } = renderHook(() => useFixture());
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(false); });
    expect(result.current.plugins).toEqual([expect.objectContaining({ id: 'new', enabled: false, muted: true, gain: 0.5 })]);
    expect(audioApi.loadPlugin).toHaveBeenCalledTimes(1);
});

it('正常な構成は保存状態まで復元し、成功を返す', async () => {
    const { result } = renderHook(() => useFixture([plugin('old')]));
    await act(async () => { expect(await result.current.loadPreset('preset')).toBe(true); });
    expect(result.current.plugins).toEqual([expect.objectContaining({ id: 'new', enabled: false, muted: true, gain: 0.5 })]);
    expect(audioApi.setPluginState).toHaveBeenCalledWith('new', 'saved');
    expect(result.current.error).toBeNull();
});

it('状態取得に失敗したら、保存もバックアップを伴う構成置換も開始しない', async () => {
    vi.mocked(audioApi.getPluginState).mockRejectedValue(new Error('state unavailable'));
    const save = vi.spyOn(presetApi, 'save');
    const apply = vi.spyOn(presetApi, 'applyProfile');
    const restore = vi.spyOn(presetApi, 'restoreBackup');
    const { result } = renderHook(() => useFixture([plugin('old')]));
    await act(async () => {
        expect(await result.current.savePreset('preset')).toBe(false);
        expect(await result.current.applyProfile('profile')).toBeNull();
        expect(await result.current.restoreBackupProfile()).toBeNull();
    });
    expect(save).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(audioApi.removePlugin).not.toHaveBeenCalled();
});
