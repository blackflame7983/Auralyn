import { installSessionRackFixture } from './sessionRackFixture';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { audioApi } from '../../api/audio';
import { usePlugins } from '../usePlugins';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => 'toast') } }));
const plugin = { id: 'available', path: 'plugin.vst3', name: 'Plugin', vendor: '', version: '', category: 'Fx' };
beforeEach(() => {
    installSessionRackFixture();
    localStorage.clear(); vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(audioApi, 'loadPlugin').mockResolvedValue('original-id');
    vi.spyOn(audioApi, 'restorePlugin').mockResolvedValue({ id: 'restored-id', name: 'Plugin', prepared: false });
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('');
    vi.spyOn(audioApi, 'setPluginState').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setMute').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'openEditor').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
async function loaded() {
    const hook = renderHook(() => usePlugins());
    await act(async () => {});
    await act(async () => { await hook.result.current.addPlugin(plugin); });
    return hook;
}
function undo() {
    const options = vi.mocked(toast.success).mock.calls.find(([, options]) => (options as { action?: unknown })?.action)?.[1];
    return (options as unknown as { action: { onClick: () => Promise<void> } }).action.onClick;
}
it('削除undoは空文字stateと元設定を一括復元し、prepared:falseでも成功する', async () => {
    const { result } = await loaded();
    await act(async () => { await result.current.toggleMute('original-id', true); await result.current.setPluginGain('original-id', 0.4); });
    await act(async () => { await result.current.removePlugin('original-id'); });
    await act(async () => { await undo()(); });
    expect(audioApi.restorePlugin).toHaveBeenCalledWith({ path: plugin.path, state: '', bypassed: false, muted: true, gain: 0.4 });
    expect(result.current.plugins).toEqual([expect.objectContaining({ id: 'restored-id', muted: true, gain: 0.4 })]);
    expect(audioApi.loadPlugin).toHaveBeenCalledTimes(1);
    expect(audioApi.setPluginState).not.toHaveBeenCalled();
});
it('undo応答待ちのresetでは返却IDを回収し、旧undoを再実行しても復元しない', async () => {
    const { result } = await loaded();
    await act(async () => { await result.current.removePlugin('original-id'); });
    const restore = undo();
    let finish!: (value: { id: string; name: string; prepared: boolean }) => void;
    vi.mocked(audioApi.restorePlugin).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = restore(); });
    act(() => result.current.resetPlugins());
    await act(async () => { finish({ id: 'late-id', name: 'Plugin', prepared: true }); await pending; });
    expect(audioApi.removePlugin).toHaveBeenCalledWith('late-id');
    expect(result.current.plugins).toEqual([]);
    expect(result.current.sessionPersistenceProtected).toBe(true);
    await act(async () => { await restore(); });
    expect(audioApi.restorePlugin).toHaveBeenCalledTimes(1);
});
it('単体editor fallbackは内部stateなしを明示した一括設定で再ロードする', async () => {
    const { result } = await loaded();
    vi.mocked(audioApi.openEditor).mockRejectedValueOnce(new Error('Plugin not found'));
    await act(async () => { await result.current.openEditor('original-id'); });
    expect(audioApi.restorePlugin).toHaveBeenCalledWith({ path: plugin.path, state: null, bypassed: false, muted: false, gain: 1 });
    expect(audioApi.openEditor).toHaveBeenLastCalledWith('restored-id');
    expect(result.current.plugins[0].id).toBe('restored-id');
    expect(audioApi.loadPlugin).toHaveBeenCalledTimes(1);
});
it('全体editor fallbackの一括復元失敗では旧分割APIへ戻さない', async () => {
    const { result } = await loaded();
    vi.mocked(audioApi.openEditor).mockRejectedValueOnce(new Error('loaded_count=0'));
    vi.mocked(audioApi.restorePlugin).mockRejectedValue(new Error('prepare failed'));
    await act(async () => { await result.current.openEditor('original-id'); });
    expect(result.current.plugins).toEqual([]);
    expect(audioApi.loadPlugin).toHaveBeenCalledTimes(1);
    expect(audioApi.setPluginState).not.toHaveBeenCalled();
});
