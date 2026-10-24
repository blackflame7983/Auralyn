import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type RackPlugin, type SessionRackRequest, type SessionRackReply } from '../../api/audio';
import { usePlugins } from '../usePlugins';
import { PLUGIN_SESSION_KEY as KEY, PLUGIN_SESSION_BACKUP_KEY as BACKUP, PLUGIN_SESSION_PROTECTED_KEY as PROTECTED } from '../usePluginSessionPersistence';
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));
const saved = JSON.stringify([{ path: 'same', name: 'Saved A', enabled: false, muted: true, gain: .3, state: 'opaque-a' },
    { path: 'same', name: 'Saved B', enabled: true, muted: false, gain: .8, state: 'opaque-b' }]);
const rackItem = (id: string): RackPlugin => ({ id, path: 'same', name: `Actual ${id}`, enabled: id === 'a', muted: id === 'b', gain: .4 });
const flush = () => act(async () => {});
let rack: RackPlugin[], eligible: boolean, generation: string, lease: string | undefined, sequence: number;
function snapshot(): SessionRackReply { return { status: 'snapshot', revision: '0', running: false, generation, present: true, restoreEligible: eligible, plugins: [...rack] }; }
async function backend(request: SessionRackRequest): Promise<SessionRackReply> {
    if (request.action === 'snapshot') return lease ? { status: 'busy' } : snapshot();
    if (request.action === 'retain') { eligible = false; return { status: 'finished' }; }
    if (request.action === 'begin') {
        if (lease) return { status: 'busy' };
        if (generation !== request.generation || rack.length || (!eligible && !request.explicit)) return { status: 'conflict' };
        eligible = false; lease = `lease-${++sequence}`; return { status: 'ready', generation, token: lease };
    }
    if (request.token !== lease) return { status: 'conflict' };
    if (request.action === 'finish') { lease = undefined; return { status: 'finished' }; }
    const plugin = { id: `new-${++sequence}`, name: request.request.path, prepared: false };
    rack.push({ id: plugin.id, name: plugin.name, path: request.request.path, enabled: !request.request.bypassed, muted: request.request.muted, gain: request.request.gain });
    return { status: 'restored', plugin };
}
beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); localStorage.setItem(KEY, saved); localStorage.setItem(BACKUP, 'immutable-backup');
    rack = []; eligible = true; generation = 'engine-1'; lease = undefined; sequence = 0;
    vi.spyOn(audioApi, 'sessionRack').mockImplementation(backend);
    vi.spyOn(audioApi, 'restorePlugin').mockRejectedValue(new Error('legacy restore forbidden'));
    vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined); vi.spyOn(audioApi, 'setOutputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'removePlugin').mockImplementation(async id => { rack = rack.filter(plugin => plugin.id !== id); });
    vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    vi.spyOn(audioApi, 'stop').mockResolvedValue(undefined); vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('runtime-state');
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });
function strictSave() {
    const reject = vi.fn(), resolve = vi.fn();
    act(() => window.dispatchEvent(new CustomEvent('auralyn-save-session', { detail: { reject, resolve } })));
    return { reject, resolve };
}
it.each(['saved', 'corrupt', 'different'])('既存2件は%s原本をparse/loadせず実IDと同一path別instanceを引継ぎ、全保存経路で原文を保持する', async mode => {
    rack = [rackItem('a'), rackItem('b')]; eligible = false;
    const raw = mode === 'corrupt' ? '{broken' : mode === 'different' ? '[{"path":"different"}]' : saved;
    localStorage.setItem(KEY, raw); localStorage.setItem(PROTECTED, 'true');
    const { result } = renderHook(() => usePlugins()); await flush();
    expect(result.current.plugins.map(plugin => plugin.id)).toEqual(['a', 'b']);
    expect(result.current.plugins.map(plugin => plugin.path)).toEqual(['same', 'same']);
    expect(result.current.plugins[1]).toMatchObject({ name: 'Actual b', muted: true, enabled: false, gain: .4 });
    expect(result.current.sessionRestoreStatus).toBe('retained'); expect(result.current.error).toContain('表示しています');
    expect(audioApi.sessionRack).toHaveBeenCalledTimes(1);
    expect(audioApi.restorePlugin).not.toHaveBeenCalled(); expect(audioApi.removePlugin).not.toHaveBeenCalled();
    expect(audioApi.setInputGain).not.toHaveBeenCalled(); expect(audioApi.setOutputGain).not.toHaveBeenCalled();
    expect(audioApi.start).not.toHaveBeenCalled(); expect(audioApi.stop).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(62000)); const save = strictSave(); await flush();
    expect(save.reject).toHaveBeenCalled(); expect(audioApi.getPluginState).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe(raw); expect(localStorage.getItem(BACKUP)).toBe('immutable-backup'); expect(localStorage.getItem(PROTECTED)).toBe('true');
});
it('本物のunmount/remountでも同一backendへappendせず、直前の意図した空ラックも復元し直さない', async () => {
    const first = renderHook(() => usePlugins()); await flush();
    expect(rack).toHaveLength(2); const ids = rack.map(plugin => plugin.id); first.unmount();
    const second = renderHook(() => usePlugins()); await flush();
    expect(second.result.current.plugins.map(plugin => plugin.id)).toEqual(ids); expect(rack).toHaveLength(2);
    second.unmount(); rack = []; // 最後のVSTを利用者が削除した同じengine。
    const third = renderHook(() => usePlugins()); await flush();
    expect(third.result.current.plugins).toEqual([]); expect(third.result.current.sessionRestoreStatus).toBe('retained');
    expect(vi.mocked(audioApi.sessionRack).mock.calls.filter(([request]) => request.action === 'add')).toHaveLength(2);
});
it.each(['busy', 'conflict', 'throw'])('snapshot %sは空へfallbackせず、保存・gain・追加を行わない', async status => {
    if (status === 'throw') vi.mocked(audioApi.sessionRack).mockRejectedValue(new Error('disconnected'));
    else vi.mocked(audioApi.sessionRack).mockResolvedValue({ status: status as 'busy' | 'conflict' });
    const { result } = renderHook(() => usePlugins()); await flush();
    expect(result.current.sessionRestoreStatus).toBe('failed'); expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(vi.mocked(audioApi.sessionRack).mock.calls.every(([request]) => request.action === 'snapshot')).toBe(true);
    expect(audioApi.restorePlugin).not.toHaveBeenCalled(); expect(localStorage.getItem(KEY)).toBe(saved);
});
it('遅いsnapshot中のresetは元UIを上書きせず、真のunmount後もBeginしない', async () => {
    let finish!: (value: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(() => usePlugins()); act(() => hook.result.current.resetPlugins());
    await act(async () => finish(snapshot()));
    expect(hook.result.current.sessionRestoreStatus).toBe('cancelled'); expect(audioApi.sessionRack).toHaveBeenCalledTimes(1);
    hook.unmount();
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const second = renderHook(() => usePlugins()); second.unmount();
    await act(async () => finish(snapshot()));
    expect(audioApi.sessionRack).toHaveBeenCalledTimes(2);
});
it('StrictModeはpending snapshotを一度だけ取得して引継ぐ', async () => {
    rack = [rackItem('a')]; eligible = false;
    let finish!: (value: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => usePlugins(), { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> });
    expect(audioApi.sessionRack).toHaveBeenCalledTimes(1); await act(async () => finish(snapshot()));
    expect(result.current.plugins[0].id).toBe('a'); expect(audioApi.sessionRack).toHaveBeenCalledTimes(1);
});
it('2pageが同じempty snapshotを見ても予約競合後に追加せず実ラックへ再接続する', async () => {
    const empty = snapshot(); let snapshots = 0;
    vi.mocked(audioApi.sessionRack).mockImplementation(async request => {
        if (request.action === 'snapshot' && snapshots++ < 2) return empty;
        return backend(request);
    });
    const a = renderHook(() => usePlugins()), b = renderHook(() => usePlugins()); await flush();
    expect(rack).toHaveLength(2); expect([a.result.current.sessionPersistenceProtected, b.result.current.sessionPersistenceProtected]).toContain(true);
    expect(vi.mocked(audioApi.sessionRack).mock.calls.filter(([request]) => request.action === 'add')).toHaveLength(2);
    expect(audioApi.restorePlugin).not.toHaveBeenCalled();
});
it('追加途中の世代競合で後続追加せず保護し、取消応答のIDを別ラックから削除しない', async () => {
    let finish!: (value: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockImplementation(request => request.action === 'add'
        ? new Promise(resolve => { finish = resolve; }) : backend(request));
    const { result } = renderHook(() => usePlugins()); await flush();
    act(() => result.current.resetPlugins());
    await act(async () => finish({ status: 'restored', plugin: { id: 'old-id', name: 'Old', prepared: false } }));
    expect(audioApi.removePlugin).not.toHaveBeenCalled(); expect(result.current.plugins).toEqual([]);
    expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(vi.mocked(audioApi.sessionRack).mock.calls.filter(([request]) => request.action === 'add')).toHaveLength(1);
});
it('明示retryはhidden actual IDsを読み直して回収し、成功時だけ保存保護を解除する', async () => {
    rack = [rackItem('hidden-a'), rackItem('hidden-b')]; eligible = false;
    const { result } = renderHook(() => usePlugins()); await flush();
    rack.push(rackItem('external-c'));
    await act(async () => { await result.current.retrySessionRestore(); });
    expect(vi.mocked(audioApi.removePlugin).mock.calls.map(([id]) => id)).toEqual(['hidden-a', 'hidden-b', 'external-c']);
    expect(result.current.sessionRestoreStatus).toBe('success'); expect(result.current.sessionPersistenceProtected).toBe(false);
    expect(rack).toHaveLength(2); expect(localStorage.getItem(BACKUP)).toBe('immutable-backup');
});

it('snapshot待ちの手動停止維持は古いread結果でgain復元や追加へ進まない', async () => {
    let finish!: (value: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: false, config: null });
    const { result } = renderHook(() => usePlugins());
    await act(async () => { await result.current.keepSessionStopped(); });
    await act(async () => finish(snapshot()));
    expect(audioApi.sessionRack).toHaveBeenCalledTimes(1); expect(audioApi.start).not.toHaveBeenCalled();
    expect(audioApi.setInputGain).not.toHaveBeenCalled(); expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(localStorage.getItem(KEY)).toBe(saved);
});
it.each([null, '[]'])('cold空の保存%sはretain要求だけで、保存inputGainはtyped値のまま渡す', async source => {
    if (source === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, source);
    localStorage.setItem('vst_host_input_gain', '35');
    const { result } = renderHook(() => usePlugins()); await flush();
    expect(result.current.sessionRestoreStatus).toBe('success');
    expect(audioApi.sessionRack).toHaveBeenCalledWith({ action: 'retain', generation, revision: '0', ids: [], inputGain: .35 });
    expect(vi.mocked(audioApi.sessionRack).mock.calls.some(([request]) => request.action === 'begin' || request.action === 'add')).toBe(false);
    expect(audioApi.start).not.toHaveBeenCalled(); expect(audioApi.setInputGain).not.toHaveBeenCalled();
});

it('空retain応答待ちのSESSION原文変更を保存で潰さず保護し続ける', async () => {
    localStorage.setItem(KEY, '[]');
    let finish!: (value: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockImplementation(request => request.action === 'retain'
        ? new Promise(resolve => { finish = resolve; }) : backend(request));
    const { result } = renderHook(() => usePlugins()); await flush();
    localStorage.setItem(KEY, saved);
    await act(async () => finish({ status: 'finished' }));
    expect(result.current.sessionRestoreStatus).toBe('cancelled'); expect(result.current.sessionPersistenceProtected).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(62000)); const save = strictSave(); await flush();
    expect(save.reject).toHaveBeenCalled(); expect(localStorage.getItem(KEY)).toBe(saved);
    expect(localStorage.getItem(BACKUP)).toBe('immutable-backup'); expect(localStorage.getItem(PROTECTED)).toBe('true');
});
it('手動空構成restore後のStart失敗では元構成保護を解除しない', async () => {
    localStorage.setItem(KEY, '[]');
    const { result } = renderHook(() => usePlugins()); await flush();
    const live = await import('../../api/liveModes');
    vi.spyOn(live.liveModesApi, 'preflight').mockResolvedValue(undefined);
    vi.spyOn(live.liveModesApi, 'beginChanges').mockResolvedValue('manual-batch');
    vi.spyOn(live.liveModesApi, 'endChanges').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: false, config: null });
    const start = vi.fn(async () => { throw new Error('Start failed'); });
    await act(async () => { await expect(result.current.recoverSession(null, start)).rejects.toThrow('Start failed'); });
    expect(result.current.sessionPersistenceProtected).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(62000)); const save = strictSave(); await flush();
    expect(save.reject).toHaveBeenCalled(); expect(localStorage.getItem(KEY)).toBe('[]');
    expect(localStorage.getItem(BACKUP)).toBe('immutable-backup'); expect(localStorage.getItem(PROTECTED)).toBe('true');
});
