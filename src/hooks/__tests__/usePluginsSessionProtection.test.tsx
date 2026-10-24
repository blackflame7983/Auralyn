import { installSessionRackFixture } from './sessionRackFixture';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import { liveModesApi } from '../../api/liveModes';
import { bundleApi, type BundleResult } from '../../api/bundles';
import { usePlugins } from '../usePlugins';
import { PLUGIN_SESSION_KEY, PLUGIN_SESSION_BACKUP_KEY, PLUGIN_SESSION_PROTECTED_KEY } from '../usePluginSessionPersistence';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
const savedPlugin = (path: string) => ({ path, name: path, vendor: '', version: '', enabled: true, muted: false, gain: 1, state: `saved-${path}` });
const original = JSON.stringify([savedPlugin('ozone'), savedPlugin('insight')]);
const flush = () => act(() => vi.advanceTimersByTimeAsync(1));
function strictSave() {
    const resolve = vi.fn();
    const reject = vi.fn();
    act(() => window.dispatchEvent(new CustomEvent('auralyn-save-session', { detail: { resolve, reject } })));
    return { resolve, reject };
}
beforeEach(() => {
    installSessionRackFixture();
    vi.useFakeTimers();
    localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    vi.spyOn(audioApi, 'stop').mockResolvedValue(undefined);
    vi.spyOn(liveModesApi, 'preflight').mockResolvedValue(undefined);
    vi.spyOn(liveModesApi, 'beginChanges').mockResolvedValue('batch');
    vi.spyOn(liveModesApi, 'endChanges').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'loadPlugin').mockImplementation(async path => path);
    vi.spyOn(audioApi, 'restorePlugin').mockImplementation(async request => ({ id: request.path, name: request.path, prepared: false }));
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setPluginState').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setMute').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('current-state');
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

it.each(['partial', 'throw'])('配信状態%sでは途中のラックをdebounce・定期・明示保存で元sessionへ書かない', async mode => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    const { result } = renderHook(() => usePlugins());
    await flush();
    expect(result.current.sessionPersistenceProtected).toBe(false);
    const response: BundleResult = { id: 'b1', complete: false, undoPending: true, auralyn: 'partial', obs: [], summary: { appliedCategories: ['plugins'], skippedCategories: [], missingPlugins: [], missingDevices: [], needsEngineRestart: false, loadedPluginInstances: [] } };
    const command = vi.spyOn(bundleApi, 'operation');
    if (mode === 'partial') command.mockResolvedValue(response); else command.mockRejectedValue(new Error('result unknown'));
    await act(async () => { try { await result.current.runBundle({ action: 'apply', id: 'b1' }); } catch { /* 原本保持を確認する */ } });
    expect(result.current.sessionPersistenceProtected).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(62_000));
    const save = strictSave(); await flush();
    expect(save.reject).toHaveBeenCalled();
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(original);
    expect(localStorage.getItem(PLUGIN_SESSION_BACKUP_KEY)).toBe(original);
});

it('明示bundle全成功でも既存partial保護を解除しない', async () => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => { if (request.path === 'ozone') throw new Error('prepare rejected'); return { id: request.path, name: request.path, prepared: false }; });
    const { result } = renderHook(() => usePlugins());
    await flush();
    const response: BundleResult = { id: 'b1', complete: true, undoPending: true, auralyn: 'done', obs: [], summary: { appliedCategories: ['plugins'], skippedCategories: [], missingPlugins: [], missingDevices: [], needsEngineRestart: false, loadedPluginInstances: [] } };
    vi.spyOn(bundleApi, 'operation').mockResolvedValue(response);
    await act(async () => { await result.current.runBundle({ action: 'apply', id: 'b1' }); });
    expect(result.current.sessionPersistenceProtected).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(original);
});

it('通常保存可能だったsessionは明示bundle全成功後だけ新しい空ラックを保存できる', async () => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    const { result } = renderHook(() => usePlugins());
    await flush();
    vi.spyOn(bundleApi, 'operation').mockResolvedValue({ id: 'b1', complete: true, undoPending: true, auralyn: 'done', obs: [], summary: { appliedCategories: ['plugins'], skippedCategories: [], missingPlugins: [], missingDevices: [], needsEngineRestart: false, loadedPluginInstances: [] } });
    await act(async () => { await result.current.runBundle({ action: 'apply', id: 'b1' }); });
    expect(result.current.sessionPersistenceProtected).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe('[]');
    expect(localStorage.getItem(PLUGIN_SESSION_BACKUP_KEY)).toBe(original);
});

it('部分復元・手動編集・debounce・定期・明示保存の全経路で原本2件を維持する', async () => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => { if (request.path === 'ozone') throw new Error('VST set_processing failed'); return { id: request.path, name: request.path, prepared: false }; });
    const { result } = renderHook(() => usePlugins());
    await flush();
    expect(result.current.sessionRestoreStatus).toBe('partial');
    expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(result.current.plugins.map(plugin => plugin.path)).toEqual(['insight']);
    expect(result.current.error).toContain('保護中');
    expect(localStorage.getItem(PLUGIN_SESSION_BACKUP_KEY)).toBe(original);
    await act(async () => { await result.current.addPlugin({ id: 'new', path: 'new', name: 'new', vendor: '', version: '', category: 'Fx' }); });
    await act(() => vi.advanceTimersByTimeAsync(62_000));
    const save = strictSave();
    await flush();
    expect(save.resolve).not.toHaveBeenCalled();
    expect(save.reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('保護中') }));
    expect(audioApi.getPluginState).not.toHaveBeenCalled();
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(original);
});

it('全件復元が成功した場合だけ通常保存できる', async () => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    const { result } = renderHook(() => usePlugins());
    await flush();
    expect(result.current.sessionRestoreStatus).toBe('success');
    expect(result.current.sessionPersistenceProtected).toBe(false);
    expect(localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!).map((plugin: { state: string }) => plugin.state)).toEqual(['current-state', 'current-state']);
    const save = strictSave();
    await flush();
    expect(save.resolve).toHaveBeenCalledOnce();
});

it.each(['malformed', 'invalid-shape', 'load-failure', 'skip'])('復元%sで原文と最初のbackupを維持し再mount後も自動保存しない', async mode => {
    const source = mode === 'malformed' ? '{broken' : mode === 'invalid-shape' ? '{}' : original;
    localStorage.setItem(PLUGIN_SESSION_KEY, source);
    localStorage.setItem(PLUGIN_SESSION_BACKUP_KEY, 'first-backup-must-stay');
    if (mode === 'skip') localStorage.setItem('vst_host_migration_review_required', 'true');
    if (mode === 'load-failure') vi.mocked(audioApi.restorePlugin).mockRejectedValue(new Error('load failed'));
    const first = renderHook(() => usePlugins());
    await flush();
    if (mode === 'skip') await act(async () => { await first.result.current.recoverSession('ozone'); });
    expect(first.result.current.sessionPersistenceProtected).toBe(true);
    expect(first.result.current.sessionRestoreStatus).toBe(mode === 'skip' ? 'partial' : 'failed');
    first.unmount();
    const second = renderHook(() => usePlugins());
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(62_000));
    const save = strictSave();
    await flush();
    expect(save.reject).toHaveBeenCalled();
    expect(second.result.current.sessionPersistenceProtected).toBe(true);
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(source);
    expect(localStorage.getItem(PLUGIN_SESSION_BACKUP_KEY)).toBe('first-backup-must-stay');
});

it('明示再試行で途中ラックを回収し、原本全件の復元成功後だけ保存を再開する', async () => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => { if (request.path === 'ozone') throw new Error('first failure'); return { id: request.path, name: request.path, prepared: false }; });
    const { result } = renderHook(() => usePlugins());
    await flush();
    expect(result.current.sessionRestoreStatus).toBe('partial');
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => ({ id: request.path, name: request.path, prepared: false }));
    await act(async () => { await result.current.retrySessionRestore(); });
    expect(audioApi.removePlugin).toHaveBeenCalledWith('insight');
    expect(result.current.sessionRestoreStatus).toBe('success');
    expect(result.current.plugins.map(plugin => plugin.path)).toEqual(['ozone', 'insight']);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!)).toHaveLength(2);
    expect(localStorage.getItem(PLUGIN_SESSION_BACKUP_KEY)).toBe(original);
});

it('再起動resetで遅い復元を中断し、返った1件を完全復元として保存しない', async () => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    let finish!: (value: { id: string; name: string; prepared: boolean }) => void;
    vi.mocked(audioApi.restorePlugin).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => usePlugins());
    await flush();
    act(() => result.current.resetPlugins());
    await act(async () => finish({ id: 'late-ozone', name: 'Ozone', prepared: false }));
    expect(result.current.sessionRestoreStatus).toBe('cancelled');
    expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(audioApi.removePlugin).not.toHaveBeenCalled(); // 旧画面の取消から新しい実ラックを削除しない。
    await act(() => vi.advanceTimersByTimeAsync(62_000));
    const save = strictSave();
    await flush();
    expect(save.reject).toHaveBeenCalled();
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(original);
});

it('再試行の削除応答待ちにresetされたら、古い再試行は再ロードも保護解除もしない', async () => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => { if (request.path === 'ozone') throw new Error('first failure'); return { id: request.path, name: request.path, prepared: false }; });
    const { result } = renderHook(() => usePlugins());
    await flush();
    expect(result.current.sessionRestoreStatus).toBe('partial');
    const previousLoads = vi.mocked(audioApi.restorePlugin).mock.calls.length;
    let finishRemoval!: () => void;
    vi.mocked(audioApi.removePlugin).mockReturnValueOnce(new Promise(resolve => { finishRemoval = () => resolve(undefined); }));
    let retry!: Promise<void>;
    act(() => { retry = result.current.retrySessionRestore(); });
    await flush();
    act(() => result.current.resetPlugins());
    await act(async () => { finishRemoval(); await retry; });
    expect(audioApi.restorePlugin).toHaveBeenCalledTimes(previousLoads);
    expect(result.current.sessionRestoreStatus).toBe('cancelled');
    expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(result.current.plugins).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(62_000));
    const save = strictSave();
    await flush();
    expect(save.reject).toHaveBeenCalled();
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(original);
    expect(localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY)).toBe('true');
});

it('A復元済みB待機中の追加・削除・操作・profile置換をhookで拒否しghostを作らない', async () => {
    localStorage.setItem(PLUGIN_SESSION_KEY, original);
    let finishSecond!: (value: { id: string; name: string; prepared: boolean }) => void;
    vi.mocked(audioApi.restorePlugin).mockImplementation(request => request.path === 'insight' ? new Promise(resolve => { finishSecond = resolve; }) : Promise.resolve({ id: request.path, name: request.path, prepared: false }));
    const reorder = vi.spyOn(audioApi, 'reorderPlugins').mockResolvedValue(undefined);
    const editor = vi.spyOn(audioApi, 'openEditor').mockResolvedValue(undefined);
    const { result } = renderHook(() => usePlugins());
    await flush();
    expect(result.current.plugins.map(plugin => plugin.path)).toEqual(['ozone']);
    const previousStates = vi.mocked(audioApi.setPluginState).mock.calls.length;
    await act(async () => {
        expect(await result.current.addPlugin({ id: 'ghost', path: 'ghost', name: 'ghost', vendor: '', version: '', category: 'Fx' })).toBe(false);
        await result.current.removePlugin('ozone');
        await result.current.toggleMute('ozone', true);
        await result.current.togglePlugin('ozone', false);
        await result.current.setPluginGain('ozone', 0.4);
        await result.current.reorderPlugins([]);
        await result.current.openEditor('ozone');
        expect(await result.current.loadPluginState('ozone', 'manual')).toBe(false);
        expect(await result.current.applyTemplate({})).toBe(false);
        expect(await result.current.loadPreset('manual')).toBe(false);
        expect(await result.current.applyProfile('manual')).toBeNull();
        expect(await result.current.restoreBackupProfile()).toBeNull();
    });
    expect(audioApi.restorePlugin).toHaveBeenCalledTimes(2);
    expect(audioApi.loadPlugin).not.toHaveBeenCalled();
    expect(audioApi.removePlugin).not.toHaveBeenCalled();
    expect(audioApi.setMute).not.toHaveBeenCalled();
    expect(audioApi.setBypass).not.toHaveBeenCalled();
    expect(audioApi.setGain).not.toHaveBeenCalled();
    expect(audioApi.setPluginState).toHaveBeenCalledTimes(previousStates);
    expect(reorder).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
    expect(result.current.error).toContain('復元処理中');
    await act(async () => finishSecond({ id: 'insight', name: 'Insight', prepared: false }));
    expect(result.current.plugins.map(plugin => plugin.path)).toEqual(['ozone', 'insight']);
    expect(result.current.sessionRestoreStatus).toBe('success');
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!).map((plugin: { path: string }) => plugin.path)).toEqual(['ozone', 'insight']);
});
