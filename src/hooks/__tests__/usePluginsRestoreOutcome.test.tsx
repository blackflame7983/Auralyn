import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '../../api/audio';
import { usePlugins } from '../usePlugins';
import { installSessionRackFixture } from './sessionRackFixture';
import { PLUGIN_SESSION_KEY as KEY } from '../usePluginSessionPersistence';
import { checkRestoredRack } from '@/lib/rackRestoreOutcome';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), loading: vi.fn(), info: vi.fn() } }));

const item = (path: string) => ({ path, name: `実名 ${path}`, enabled: true, muted: false, gain: .8, state: `opaque-${path}` });
let injectSnapshotFailure = false;

beforeEach(() => {
    localStorage.clear();
    injectSnapshotFailure = false;
    installSessionRackFixture();
    const fixture = vi.mocked(audioApi.sessionRack).getMockImplementation();
    if (!fixture) throw new Error('sessionRack の模擬が入っていません');
    vi.mocked(audioApi.sessionRack).mockImplementation(async request => {
        if (injectSnapshotFailure && request.action === 'snapshot') throw new Error('注入した VST の確認失敗');
        return fixture(request);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    vi.spyOn(audioApi, 'restorePlugin').mockImplementation(async request => ({ id: request.path, name: request.path, prepared: false }));
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setOutputGain').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

async function restoreSavedRack(paths: string[]) {
    const { result } = renderHook(() => usePlugins());
    await act(async () => {});
    localStorage.setItem(KEY, JSON.stringify(paths.map(item)));
    // 実際の復元の関数は、失敗を内部で通知して正常に終わる。戻り値からは結果が分からない。
    await act(async () => { await expect(result.current.restoreSession()).resolves.toBeUndefined(); });
    return result;
}

it('保存した構成をすべて戻せたら completed', async () => {
    await restoreSavedRack(['a', 'b']);
    expect(await checkRestoredRack(localStorage.getItem(KEY))).toBe('completed');
});

it('保存した構成が空なら、空のラックで completed', async () => {
    await restoreSavedRack([]);
    expect(await checkRestoredRack(localStorage.getItem(KEY))).toBe('completed');
});

it('実ラックの確認が失敗しても、復元の関数は例外にしない。確認の結果は failed', async () => {
    injectSnapshotFailure = true;
    await restoreSavedRack(['a', 'b']);
    expect(await checkRestoredRack(localStorage.getItem(KEY))).toBe('failed');
});

it('一部の VST を戻せなかったら partial', async () => {
    vi.mocked(audioApi.restorePlugin).mockImplementation(async request => {
        if (request.path === 'a') throw new Error('Plugin not found');
        return { id: request.path, name: request.path, prepared: false };
    });
    await restoreSavedRack(['a', 'b']);
    expect(await checkRestoredRack(localStorage.getItem(KEY))).toBe('partial');
});

it('すべての VST を戻せなかったら failed', async () => {
    vi.mocked(audioApi.restorePlugin).mockRejectedValue(new Error('Plugin not found'));
    await restoreSavedRack(['a', 'b']);
    expect(await checkRestoredRack(localStorage.getItem(KEY))).toBe('failed');
});

it('保存した構成を読めないときは、戻せたと見なさず failed', async () => {
    expect(await checkRestoredRack('{壊れた保存値')).toBe('failed');
});
