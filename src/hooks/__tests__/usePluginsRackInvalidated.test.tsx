import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { audioApi, type RackPlugin, type SessionRackReply } from '../../api/audio';
import { liveModesApi } from '../../api/liveModes';
import { initializeTemporarySession } from '../../lib/temporarySession';
import { usePlugins } from '../usePlugins';
import { PLUGIN_SESSION_KEY, PLUGIN_SESSION_PROTECTED_KEY } from '../usePluginSessionPersistence';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));
const item = (id: string): RackPlugin => ({ id, name: id, path: id, enabled: true, muted: false, gain: 1 });
const snapshot = (id?: string, generation = 'engine'): SessionRackReply => ({ status: 'snapshot', generation, revision: id ?? '0', running: true, present: true, restoreEligible: true, plugins: id ? [item(id)] : [] });
let event: () => void;
let start: () => void;
let cancel: () => void;
const flush = () => act(async () => {});

beforeEach(async () => {
    localStorage.clear();
    vi.mocked(invoke).mockResolvedValue({ temporary: false, reviewOnly: false, directory: null });
    await initializeTemporarySession();
    vi.mocked(listen).mockImplementation(async (name, handler) => {
        if (name === 'session-rack-invalidated') event = () => handler({ event: name, id: 1, payload: undefined });
        if (name === 'session-rack-change-started') start = () => handler({ event: name, id: 1, payload: undefined });
        if (name === 'session-rack-change-cancelled') cancel = () => handler({ event: name, id: 1, payload: undefined });
        return () => {};
    });
    vi.spyOn(audioApi, 'sessionRack').mockImplementation(async request => request.action === 'snapshot' ? snapshot() : { status: 'finished' });
    vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('state');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it('更新通知後に実ラックを照合して新しい ID を表示する', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    expect(result.current.sessionPersistenceProtected).toBe(false);
    vi.mocked(audioApi.sessionRack).mockResolvedValue(snapshot('new'));
    act(() => event());
    expect(localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY)).toBe('true');
    await flush();
    expect(result.current.plugins.map(p => p.id)).toEqual(['new']);
    expect(result.current.sessionPersistenceProtected).toBe(false);
});

it('古い非同期応答を採用しない', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    let resolve!: (reply: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValue(snapshot('new'));
    act(() => { event(); event(); }); await flush();
    await act(async () => resolve(snapshot('old')));
    expect(result.current.plugins.map(p => p.id)).toEqual(['new']);
});

it('以前から保護されている原文を保持する', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    const source = '[{"path":"saved"}]';
    localStorage.setItem(PLUGIN_SESSION_KEY, source); localStorage.setItem(PLUGIN_SESSION_PROTECTED_KEY, 'true');
    vi.mocked(audioApi.sessionRack).mockResolvedValue(snapshot('actual'));
    act(() => event()); await flush();
    expect(result.current.plugins.map(p => p.id)).toEqual(['actual']);
    expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(source);
    expect(localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY)).toBe('true');
});

it('取得失敗では原文と保存保護を保持する', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    const source = '[{"path":"saved"}]'; localStorage.setItem(PLUGIN_SESSION_KEY, source);
    vi.mocked(audioApi.sessionRack).mockRejectedValue(new Error('busy'));
    act(() => event()); await flush();
    expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(result.current.sessionRestoreStatus).toBe('failed');
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(source);
    vi.mocked(audioApi.sessionRack).mockResolvedValue(snapshot('recovered'));
    act(() => event()); await flush();
    expect(result.current.plugins.map(p => p.id)).toEqual(['recovered']);
    expect(result.current.sessionPersistenceProtected).toBe(false);
});

it('確認中に Engine 世代が変わると表示を更新しない', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    vi.mocked(audioApi.sessionRack).mockResolvedValueOnce(snapshot('old', 'engine-1')).mockResolvedValueOnce(snapshot('new', 'engine-2'));
    act(() => event()); await flush();
    expect(result.current.plugins).toEqual([]);
    expect(result.current.sessionPersistenceProtected).toBe(true);
});

it('開始時に原本を保護し、中断後の旧 ID を消して完了時に再同期する', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    vi.mocked(audioApi.sessionRack).mockResolvedValue(snapshot('old'));
    act(() => event()); await flush();
    const source = '[{"path":"saved"}]'; localStorage.setItem(PLUGIN_SESSION_KEY, source);
    vi.mocked(audioApi.sessionRack).mockClear();
    act(() => start());
    expect(localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY)).toBe('true');
    expect(audioApi.sessionRack).not.toHaveBeenCalled();
    act(() => cancel());
    expect(result.current.plugins).toEqual([]);
    expect(result.current.sessionRestoreStatus).toBe('failed');
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(source);
    vi.mocked(audioApi.sessionRack).mockResolvedValue(snapshot('recovered'));
    act(() => event()); await flush();
    expect(result.current.plugins.map(p => p.id)).toEqual(['recovered']);
    expect(result.current.sessionPersistenceProtected).toBe(false);
});

it('元から保護済みなら開始・中断・再同期後も保護を維持する', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    localStorage.setItem(PLUGIN_SESSION_PROTECTED_KEY, 'true');
    act(() => { start(); cancel(); });
    vi.mocked(audioApi.sessionRack).mockResolvedValue(snapshot('recovered'));
    act(() => event()); await flush();
    expect(result.current.plugins.map(p => p.id)).toEqual(['recovered']);
    expect(result.current.sessionPersistenceProtected).toBe(true);
    expect(localStorage.getItem(PLUGIN_SESSION_PROTECTED_KEY)).toBe('true');
});

it('ラック変更前の確定失敗は中断後の再同期で同じ ID の操作へ戻れる', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    vi.mocked(audioApi.sessionRack).mockResolvedValue(snapshot('original'));
    act(() => event()); await flush();
    const source = localStorage.getItem(PLUGIN_SESSION_KEY);
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    // Hostはstate取得や原本保存の確定失敗時、cancelの後にinvalidatedを送る。
    act(() => { start(); cancel(); event(); }); await flush();
    expect(result.current.plugins.map(p => p.id)).toEqual(['original']);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.sessionPersistenceProtected).toBe(false);
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(source);
    await act(async () => { await result.current.togglePlugin('original', false); });
    expect(audioApi.setBypass).toHaveBeenCalledWith('original', true);
});

it('中断後に遅れて届いた snapshot は採用しない', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    let resolve!: (reply: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    act(() => { start(); event(); cancel(); });
    await act(async () => resolve(snapshot('stale')));
    expect(result.current.plugins).toEqual([]);
    expect(result.current.sessionPersistenceProtected).toBe(true);
});

it('中断後も保存セッションの明示再試行を実行できる', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    act(() => { start(); cancel(); });
    await act(async () => { await result.current.retrySessionRestore(); });
    expect(result.current.sessionRestoreStatus).toBe('success');
    expect(result.current.sessionPersistenceProtected).toBe(false);
});

it.each(['retry', 'recover'])('journal 作成前の中断後に保存 VST を%sで復元し、古い応答を拒否して操作できる', async method => {
    const { result } = renderHook(() => usePlugins()); await flush();
    const source = JSON.stringify([{ path: 'saved', name: 'Saved', state: 'original', enabled: true, muted: false, gain: 1 }]);
    localStorage.setItem(PLUGIN_SESSION_KEY, source);
    let stale!: (reply: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(resolve => { stale = resolve; }));
    act(() => { start(); event(); cancel(); });
    vi.mocked(audioApi.sessionRack).mockImplementation(async request => {
        if (request.action === 'snapshot') return snapshot();
        if (request.action === 'begin') return { status: 'ready', generation: 'engine', token: 'token' };
        if (request.action === 'add') return { status: 'restored', plugin: { id: 'restored', name: 'Saved', prepared: false } };
        return { status: 'finished' };
    });
    vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setOutputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: false, config: null });
    vi.spyOn(liveModesApi, 'preflight').mockResolvedValue(undefined);
    vi.spyOn(liveModesApi, 'beginChanges').mockResolvedValue('batch');
    vi.spyOn(liveModesApi, 'endChanges').mockResolvedValue(undefined);
    await act(async () => {
        if (method === 'retry') await result.current.retrySessionRestore();
        else await result.current.recoverSession();
    });
    await act(async () => stale(snapshot('stale')));
    expect(result.current.plugins.map(p => p.id)).toEqual(['restored']);
    expect(result.current.sessionPersistenceProtected).toBe(false);
    await act(async () => { await result.current.togglePlugin('restored', false); });
    expect(audioApi.setBypass).toHaveBeenCalledWith('restored', true);
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(source);
});

it('初回 snapshot 待ちの中断では古い結果を破棄し、終了後に明示再試行できる', async () => {
    let initial!: (reply: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(resolve => { initial = resolve; }));
    const { result } = renderHook(() => usePlugins()); await flush();
    act(() => { start(); cancel(); });
    await act(async () => initial(snapshot('stale')));
    expect(result.current.plugins).toEqual([]);
    expect(result.current.sessionPersistenceProtected).toBe(true);
    await act(async () => { await result.current.retrySessionRestore(); });
    expect(result.current.sessionRestoreStatus).toBe('success');
    expect(result.current.sessionPersistenceProtected).toBe(false);
});

it('再試行の snapshot 待ちに切替開始しても loading が残らず、同期後に操作できる', async () => {
    const { result } = renderHook(() => usePlugins()); await flush();
    let finish!: (reply: SessionRackReply) => void;
    vi.mocked(audioApi.sessionRack).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.spyOn(audioApi, 'setBypass').mockResolvedValue(undefined);
    act(() => { void result.current.retrySessionRestore(); });
    expect(result.current.isLoading).toBe(true);
    act(() => start());
    expect(result.current.isLoading).toBe(false);
    await act(async () => finish(snapshot('stale')));
    vi.mocked(audioApi.sessionRack).mockResolvedValue(snapshot('current'));
    act(() => event()); await flush();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.plugins.map(p => p.id)).toEqual(['current']);
    await act(async () => { await result.current.togglePlugin('current', false); });
    expect(audioApi.setBypass).toHaveBeenCalledWith('current', true);
});
