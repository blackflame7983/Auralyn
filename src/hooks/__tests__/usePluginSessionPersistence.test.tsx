import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import { listen, type EventCallback } from '@tauri-apps/api/event';
import type { Plugin } from '../../components/features/PluginRack/PluginCard';
import { PLUGIN_SESSION_KEY, usePluginSessionPersistence } from '../usePluginSessionPersistence';

const plugin = (id: string): Plugin => ({
    id, path: `${id}.vst3`, name: id, vendor: '', version: '',
    enabled: true, muted: false, gain: 1, hasEditor: true,
});

const editorListeners = new Map<string, EventCallback<{ id: string }>>();
const editorEvent = (name: 'opened' | 'closed', id: string) => {
    editorListeners.get(`plugin-editor-${name}`)?.({ event: `plugin-editor-${name}`, id: 1, payload: { id } });
};
const requestSave = () => {
    const resolve = vi.fn();
    const reject = vi.fn();
    window.dispatchEvent(new CustomEvent('auralyn-save-session', { detail: { resolve, reject } }));
    return { resolve, reject };
};

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    editorListeners.clear();
    vi.mocked(listen).mockImplementation(async (name, callback) => {
        editorListeners.set(name, callback as EventCallback<{ id: string }>);
        return () => { editorListeners.delete(name); };
    });
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

it('前の保存が応答待ちの間は、定期保存で重複して状態取得を要求しない', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockImplementation(() => new Promise(() => {}));
    const plugins = [plugin('eq')];
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    act(() => editorEvent('opened', 'eq'));
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

it('状態取得開始後に復元保護が有効になったら、完了した古い保存でも原本を置換しない', async () => {
    localStorage.setItem('vst_host_session_plugins', 'original-two-plugin-session');
    let finish!: (state: string) => void;
    vi.spyOn(audioApi, 'getPluginState').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderHook(() => usePluginSessionPersistence([plugin('partial')], true, false));
    const resolve = vi.fn();
    const reject = vi.fn();
    act(() => window.dispatchEvent(new CustomEvent('auralyn-save-session', { detail: { resolve, reject } })));
    localStorage.setItem('vst_host_session_restore_protected', 'true');
    await act(async () => finish('late-state'));
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalled();
    expect(localStorage.getItem('vst_host_session_plugins')).toBe('original-two-plugin-session');
});

it('エディターが閉じていれば初回保存後60秒経っても状態を取得しない', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('state');
    const plugins = [plugin('eq'), plugin('comp')];
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(read).toHaveBeenCalledTimes(2);
    read.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).not.toHaveBeenCalled();
});

it('エディターが開いているVSTだけ10秒ごとに取得する', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockImplementation(async id => `${id}-state`);
    const plugins = [plugin('eq'), plugin('comp')];
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    read.mockClear();
    act(() => editorEvent('opened', 'eq'));
    await act(() => vi.advanceTimersByTimeAsync(9999));
    expect(read).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(read.mock.calls).toEqual([['eq']]);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(read.mock.calls).toEqual([['eq'], ['eq']]);
});

it('同じ内容の自動保存と明示保存はlocalStorageへ再書き込みしない', async () => {
    vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('state');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const plugins = [plugin('eq')];
    const { unmount } = renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(write).toHaveBeenCalledTimes(1);
    act(() => editorEvent('opened', 'eq'));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    let request!: ReturnType<typeof requestSave>;
    await act(async () => { request = requestSave(); });
    expect(request.resolve).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(1);
    unmount();
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(write).toHaveBeenCalledTimes(1);
});

it('エディターを閉じるとそのVSTをすぐ保存し、定期取得を止める', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockImplementation(async id => `${id}-state`);
    const plugins = [plugin('eq'), plugin('comp')];
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    read.mockClear();
    read.mockResolvedValue('edited-state');
    act(() => editorEvent('opened', 'eq'));
    await act(async () => editorEvent('closed', 'eq'));
    expect(read.mock.calls).toEqual([['eq']]);
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!)).toMatchObject([
        { name: 'eq', state: 'edited-state' }, { name: 'comp', state: 'comp-state' },
    ]);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).toHaveBeenCalledOnce();
});

it('取得失敗時はキャッシュの正常値を保持して他の変更を保存する', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockImplementation(async id => `${id}-state`);
    const { rerender } = renderHook(({ plugins }) => usePluginSessionPersistence(plugins, true, false), {
        initialProps: { plugins: [plugin('eq'), plugin('comp')] },
    });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    read.mockImplementation(async id => {
        if (id === 'eq') throw new Error('state unavailable');
        return 'new-comp-state';
    });
    rerender({ plugins: [{ ...plugin('eq'), gain: 0.5 }, plugin('comp')] });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!)).toMatchObject([
        { name: 'eq', gain: 0.5, state: 'eq-state' }, { name: 'comp', state: 'new-comp-state' },
    ]);
    let request!: ReturnType<typeof requestSave>;
    await act(async () => { request = requestSave(); });
    expect(request.resolve).not.toHaveBeenCalled();
    expect(request.reject).toHaveBeenCalledWith(expect.any(Error));
});

it('初回全件保存前に部分保存が来てもキャッシュのないVSTをすべて取得する', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('state');
    const plugins = [plugin('eq'), plugin('comp')];
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(async () => editorEvent('closed', 'eq'));
    expect(read.mock.calls).toEqual([['eq'], ['comp']]);
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!)).toHaveLength(2);
});

it('削除したエディターを定期取得せず、再追加した同じIDにも古いキャッシュを使わない', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('old-state');
    const { rerender } = renderHook(({ plugins }) => usePluginSessionPersistence(plugins, true, false), {
        initialProps: { plugins: [plugin('eq'), plugin('comp')] },
    });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    act(() => editorEvent('opened', 'eq'));
    rerender({ plugins: [plugin('comp')] });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    read.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).not.toHaveBeenCalled();
    rerender({ plugins: [plugin('eq'), plugin('comp')] });
    read.mockResolvedValue('new-state');
    await act(async () => editorEvent('closed', 'comp'));
    expect(read.mock.calls).toEqual([['eq'], ['comp']]);
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!)[0].state).toBe('new-state');
});

it.each([
    { ready: false, busy: false, protectedSession: false, code: 'saveProtected' },
    { ready: true, busy: false, protectedSession: true, code: 'saveProtected' },
    { ready: true, busy: true, protectedSession: false, code: 'saveBusy' },
])('保存禁止状態では自動保存せず、明示保存には$codeを通知する', async ({ ready, busy, protectedSession, code }) => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('state');
    const plugins = [plugin('eq')];
    renderHook(() => usePluginSessionPersistence(plugins, ready, busy, protectedSession));
    act(() => editorEvent('opened', 'eq'));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => editorEvent('closed', 'eq'));
    let request!: ReturnType<typeof requestSave>;
    await act(async () => { request = requestSave(); });
    expect(request.reject).toHaveBeenCalledWith(expect.objectContaining({ code }));
    expect(read).not.toHaveBeenCalled();
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBeNull();
});

it('アンマウント後に届いた状態で書き込まず、通知の購読も解除する', async () => {
    let finish!: (state: string) => void;
    vi.spyOn(audioApi, 'getPluginState').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const plugins = [plugin('eq')];
    const { unmount } = renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    unmount();
    await act(async () => finish('late-state'));
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBeNull();
    expect(editorListeners.size).toBe(0);
});

it('明示保存は開いていないVSTも取得し、応答待ちの重複要求はsaveBusyで拒否する', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('state');
    const plugins = [plugin('eq'), plugin('comp')];
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    act(() => editorEvent('opened', 'eq'));
    read.mockClear();
    const finishes: Array<(state: string) => void> = [];
    read.mockImplementation(() => new Promise(resolve => { finishes.push(resolve); }));
    let first!: ReturnType<typeof requestSave>;
    let second!: ReturnType<typeof requestSave>;
    await act(async () => { first = requestSave(); second = requestSave(); });
    expect(read.mock.calls).toEqual([['eq'], ['comp']]);
    expect(second.reject).toHaveBeenCalledWith(expect.objectContaining({ code: 'saveBusy' }));
    await act(async () => { finishes.forEach(finish => finish('saved-state')); });
    expect(first.resolve).toHaveBeenCalledOnce();
});

it('エディター定期取得に失敗しても、最後に保存できたパラメーターを維持する', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('good-state');
    const plugins = [plugin('eq'), plugin('comp')];
    renderHook(() => usePluginSessionPersistence(plugins, true, false));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    const saved = localStorage.getItem(PLUGIN_SESSION_KEY);
    const write = vi.spyOn(Storage.prototype, 'setItem');
    read.mockClear();
    read.mockRejectedValue(new Error('state unavailable'));
    act(() => editorEvent('opened', 'eq'));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(read.mock.calls).toEqual([['eq']]);
    expect(localStorage.getItem(PLUGIN_SESSION_KEY)).toBe(saved);
    expect(write).not.toHaveBeenCalled();
});

it('保存の途中でエディターを閉じたら、その保存の後で閉じたVSTを取り直して書く', async () => {
    let finish!: (state: string) => void;
    let value = 'before-edit';
    const read = vi.spyOn(audioApi, 'getPluginState')
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
        .mockImplementation(async () => value);
    renderHook(() => usePluginSessionPersistence([plugin('eq')], true, false));
    act(() => editorEvent('opened', 'eq'));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    value = 'after-edit';
    act(() => editorEvent('closed', 'eq'));
    await act(async () => finish('before-edit'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!)[0].state).toBe('after-edit');
});

it('保存の途中に重なった全体保存を、定期保存がなくても後で実行する', async () => {
    let finish!: (state: string) => void;
    const read = vi.spyOn(audioApi, 'getPluginState')
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
        .mockResolvedValue('state');
    renderHook(() => usePluginSessionPersistence([plugin('eq'), plugin('comp')], true, false));
    // 閉じた直後の保存が応答待ちの間に、構成変更の全体保存の時刻が来る。
    act(() => editorEvent('closed', 'eq'));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => finish('state'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenLastCalledWith('comp');
    expect(read.mock.calls.filter(([id]) => id === 'eq')).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(PLUGIN_SESSION_KEY)!)).toHaveLength(2);
});

it('一覧の更新より先に届いたエディターの通知も、更新後の定期保存の対象にする', async () => {
    const read = vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('state');
    const { rerender } = renderHook(({ plugins }) => usePluginSessionPersistence(plugins, true, false), {
        initialProps: { plugins: [plugin('old')] },
    });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    act(() => editorEvent('opened', 'new'));
    rerender({ plugins: [plugin('new')] });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    read.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(read).toHaveBeenCalledWith('new');
});
