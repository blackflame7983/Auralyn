import { installSessionRackFixture } from './sessionRackFixture';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type EngineRuntimeStats } from '../../api/audio';
import { liveModesApi } from '../../api/liveModes';
import { usePlugins } from '../usePlugins';
import { PLUGIN_SESSION_KEY as KEY, PLUGIN_SESSION_BACKUP_KEY as BACKUP, PLUGIN_SESSION_PROTECTED_KEY as PROTECTED } from '../usePluginSessionPersistence';
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));
const saved = JSON.stringify([{ path: 'one', name: 'One', state: 'original', enabled: false, muted: true, gain: .3 }]);
const flush = () => act(async () => {});
beforeEach(() => {
    installSessionRackFixture();
    vi.useFakeTimers(); localStorage.clear(); localStorage.setItem(KEY, saved);
    vi.spyOn(audioApi, 'restorePlugin').mockResolvedValue({ id: 'one-id', name: 'One', prepared: false });
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    vi.spyOn(audioApi, 'stop').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({ activePluginCount: 0, pendingUnloadCount: 0 } as EngineRuntimeStats);
    vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setOutputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setGlobalMute').mockResolvedValue(undefined);
    vi.spyOn(liveModesApi, 'preflight').mockResolvedValue(undefined);
    vi.spyOn(liveModesApi, 'beginChanges').mockResolvedValue('batch');
    vi.spyOn(liveModesApi, 'endChanges').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });
async function loaded() { const hook = renderHook(() => usePlugins()); await flush(); return hook; }
it('VSTなしはStop→実Unload→空backend確認→明示Startとし、空ラックを保存しない', async () => {
    const { result } = await loaded(); const start = vi.fn(async () => {});
    await act(async () => { await result.current.resumeWithoutPlugins(start); });
    expect(vi.mocked(audioApi.stop).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(audioApi.removePlugin).mock.invocationCallOrder[0]);
    expect(audioApi.removePlugin).toHaveBeenCalledWith('one-id');
    expect(vi.mocked(audioApi.getEngineRuntimeStats).mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
    expect(result.current.plugins).toEqual([]); expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(audioApi.setGlobalMute).not.toHaveBeenCalled(); expect(audioApi.setInputGain).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(62000));
    const reject = vi.fn(); act(() => window.dispatchEvent(new CustomEvent('auralyn-save-session', { detail: { resolve: vi.fn(), reject } })));
    await flush(); expect(reject).toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(saved); expect(localStorage.getItem(BACKUP)).toBe(saved); expect(localStorage.getItem(PROTECTED)).toBe('true');
});
it.each(['protected', 'stop', 'unload', 'remaining', 'pending', 'missing', 'start'])('%s拒否で成功せず、原本保護を継続し有限回で終了する', async failure => {
    const { result } = await loaded(); const start = vi.fn(async () => {});
    if (failure === 'protected') vi.mocked(liveModesApi.preflight).mockRejectedValue(new Error('armed'));
    if (failure === 'stop') vi.mocked(audioApi.stop).mockRejectedValue(new Error('stop'));
    if (failure === 'unload') vi.mocked(audioApi.removePlugin).mockRejectedValue(new Error('unload'));
    if (['remaining', 'pending', 'missing'].includes(failure)) vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue({ activePluginCount: failure === 'remaining' ? 1 : 0, pendingUnloadCount: failure === 'pending' ? 1 : failure === 'missing' ? undefined : 0 } as EngineRuntimeStats);
    if (failure === 'start') start.mockRejectedValue(new Error('start'));
    await act(async () => { await expect(result.current.resumeWithoutPlugins(start)).rejects.toThrow(); });
    if (failure !== 'start') expect(start).not.toHaveBeenCalled();
    if (failure === 'protected') expect(audioApi.stop).not.toHaveBeenCalled();
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(['remaining', 'pending', 'missing', 'start'].includes(failure) ? 1 : 0);
    expect(localStorage.getItem(KEY)).toBe(saved); expect(localStorage.getItem(PROTECTED)).toBe('true');
    if (failure !== 'protected') expect(liveModesApi.endChanges).toHaveBeenCalledWith('batch');
});
it('終了済engineで旧IDを推測せず、保存gainを最初のStartより前に戻す', async () => {
    const { result } = await loaded();
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: false, config: null });
    localStorage.setItem('vst_host_input_gain', '60'); localStorage.setItem('vst_host_output_gain', '40');
    const start = vi.fn(async () => {}); await act(async () => { await result.current.resumeWithoutPlugins(start); });
    expect(audioApi.removePlugin).not.toHaveBeenCalled(); expect(audioApi.stop).not.toHaveBeenCalled();
    expect(audioApi.setInputGain).toHaveBeenCalledWith(.6); expect(audioApi.setOutputGain).toHaveBeenCalledWith(.4);
    expect(vi.mocked(audioApi.setOutputGain).mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
});
it.each([true, false])('停止維持は再開・復元・本番保護解除をせず、終了済=%sではStopも呼ばない', async exited => {
    const { result } = await loaded(); vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: !exited, config: null });
    const restoreCount = vi.mocked(audioApi.restorePlugin).mock.calls.length;
    await act(async () => { await result.current.keepSessionStopped(); });
    expect(audioApi.stop).toHaveBeenCalledTimes(exited ? 0 : 1); expect(liveModesApi.preflight).not.toHaveBeenCalled(); expect(liveModesApi.beginChanges).not.toHaveBeenCalled();
    expect(audioApi.restorePlugin).toHaveBeenCalledTimes(restoreCount); expect(localStorage.getItem(KEY)).toBe(saved); expect(localStorage.getItem(PROTECTED)).toBe('true');
});
it('全件再試行は途中rackを回収し、Start失敗時は保存保護を解除せず、成功した再試行だけ解除する', async () => {
    const { result } = await loaded(); const start = vi.fn().mockRejectedValueOnce(new Error('start')).mockResolvedValue(undefined);
    await act(async () => { await expect(result.current.recoverSession(null, start)).rejects.toThrow(); });
    expect(result.current.sessionPersistenceProtected).toBe(true); expect(localStorage.getItem(KEY)).toBe(saved);
    await act(async () => { await result.current.recoverSession(null, start); });
    expect(audioApi.removePlugin).toHaveBeenCalledTimes(2); expect(result.current.sessionPersistenceProtected).toBe(false);
    expect(audioApi.restorePlugin).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'original', bypassed: true, muted: true, gain: .3 }));
});
it('明示除外だけは失敗とせず完了し、原本と保護は維持する', async () => {
    const { result } = await loaded(); const start = vi.fn(async () => {});
    await act(async () => { await result.current.recoverSession('one', start); });
    expect(start).toHaveBeenCalledOnce(); expect(result.current.sessionRestoreStatus).toBe('partial'); expect(result.current.error).toContain('選択したVSTを除いて');
    expect(localStorage.getItem(PROTECTED)).toBe('true'); expect(localStorage.getItem(KEY)).toBe(saved);
});
it('復元失敗を含むpartialではStartへ進まず、原本の保護を解除しない', async () => {
    const { result } = await loaded(); const start = vi.fn(async () => {});
    vi.mocked(audioApi.restorePlugin).mockRejectedValue(new Error('restore failed'));
    await act(async () => { await expect(result.current.recoverSession(null, start)).rejects.toThrow(); });
    expect(start).not.toHaveBeenCalled(); expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(localStorage.getItem(KEY)).toBe(saved);
});
it('停止維持のStop拒否を成功として扱わず、原本を保持する', async () => {
    const { result } = await loaded(); vi.mocked(audioApi.stop).mockRejectedValue(new Error('stop failed'));
    await act(async () => { await expect(result.current.keepSessionStopped()).rejects.toThrow('stop failed'); });
    expect(liveModesApi.beginChanges).not.toHaveBeenCalled(); expect(localStorage.getItem(KEY)).toBe(saved);
});
it.each(['without', 'restore'])('実クラッシュのstale child true→Stop回収→falseでも%sは旧IDを使わずgainを戻す', async choice => {
    const { result } = await loaded();
    vi.mocked(audioApi.getAudioState).mockResolvedValueOnce({ is_running: true, config: null }).mockResolvedValue({ is_running: false, config: null });
    localStorage.setItem('vst_host_input_gain', '50'); localStorage.setItem('vst_host_output_gain', '30');
    const start = vi.fn(async () => {});
    await act(async () => {
        if (choice === 'without') await result.current.resumeWithoutPlugins(start);
        else await result.current.recoverSession(null, start);
    });
    expect(audioApi.stop).toHaveBeenCalledOnce(); expect(audioApi.removePlugin).not.toHaveBeenCalled();
    expect(audioApi.setInputGain).toHaveBeenCalledWith(.5); expect(audioApi.setOutputGain).toHaveBeenCalledWith(.3);
    expect(vi.mocked(audioApi.setOutputGain).mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
    expect(start).toHaveBeenCalledOnce();
});
it('復元応答待ちで停止維持を選んでもloadingを残さず、遅い応答で保護を解除しない', async () => {
    let finish!: (value: { id: string; name: string; prepared: boolean }) => void;
    vi.mocked(audioApi.restorePlugin).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result } = await loaded(); expect(result.current.isLoading).toBe(true);
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: false, config: null });
    await act(async () => { await result.current.keepSessionStopped(); });
    expect(result.current.isLoading).toBe(false);
    await act(async () => finish({ id: 'late-id', name: 'One', prepared: false }));
    expect(audioApi.removePlugin).not.toHaveBeenCalled(); // 条件付き復元の取消は次の実ラック確認へ残す。
    expect(liveModesApi.beginChanges).not.toHaveBeenCalled();
    expect(audioApi.setInputGain).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false); expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(localStorage.getItem(KEY)).toBe(saved); expect(localStorage.getItem(PROTECTED)).toBe('true');
});
