import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { audioApi } from '../../api/audio';
import { usePlugins } from '../usePlugins';
import { installSessionRackFixture } from './sessionRackFixture';
import { PLUGIN_SESSION_KEY as KEY, PLUGIN_SESSION_BACKUP_KEY as BACKUP } from '../usePluginSessionPersistence';
import { LocaleProvider } from '../../i18n/LocaleProvider';
import { createLocaleStore, type Locale } from '../../i18n/locale';
import { message } from '../../i18n/messages';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), loading: vi.fn(), info: vi.fn() } }));

// バックエンドが操作ロック中に返す原文（src-tauri の PROTECTED）。
const BACKEND_REASON = '本番保護中はデバイス変更・スキャン・ラック／プロファイル置換はできません。停止・ミュートは利用できます。変更する場合は本番保護を解除してください';
const item = (path: string) => ({ path, name: `実名 ${path}`, enabled: true, muted: false, gain: .8, state: `opaque-${path}` });

function language(locale: Locale) {
    const store = createLocaleStore(() => locale, () => true);
    return { wrapper: ({ children }: { children: ReactNode }) => <LocaleProvider store={store}>{children}</LocaleProvider> };
}
async function rack(locale: Locale) {
    const { wrapper } = language(locale);
    const view = renderHook(() => usePlugins(), { wrapper });
    await act(async () => {});
    expect(view.result.current.plugins.map(plugin => plugin.id)).toEqual(['a', 'b']);
    return view;
}

/** 最後に出した失敗の通知の題と説明。 */
function lastError(): { title: unknown; description: string } {
    const call = vi.mocked(toast.error).mock.calls.slice(-1).pop();
    if (!call) throw new Error('toast.error が呼ばれていません');
    const options: unknown = call[1];
    return { title: call[0], description: typeof options === 'object' && options !== null ? String(Reflect.get(options, 'description')) : '' };
}

beforeEach(() => {
    localStorage.clear(); installSessionRackFixture();
    vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    vi.spyOn(audioApi, 'restorePlugin').mockImplementation(async request => ({ id: request.path, name: request.path, prepared: false }));
    vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined); vi.spyOn(audioApi, 'setOutputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('runtime');
    localStorage.setItem(KEY, JSON.stringify([item('a'), item('b')])); localStorage.setItem(BACKUP, 'immutable backup');
    vi.mocked(toast.error).mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it.each(['ja', 'en'] as const)('操作ロック中に VST を削除しようとすると、保護の理由と解除のしかたを見える形で出し、ラックは変えない ($locale)', async locale => {
    vi.spyOn(audioApi, 'removePlugin').mockRejectedValue(BACKEND_REASON);
    const { result } = await rack(locale);
    await act(async () => { await result.current.removePlugin('a'); });
    expect(result.current.plugins.map(plugin => plugin.id)).toEqual(['a', 'b']);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const { title, description } = lastError();
    expect(title).toBe(message(locale, 'pluginNotices.removeFailed'));
    expect(description).toContain(BACKEND_REASON);
    expect(description).toContain(message(locale, 'pluginNotices.liveLockedHint'));
    expect(result.current.error).toBeNull();
});

it.each(['ja', 'en'] as const)('操作ロック中に VST を並べ替えようとすると、保護の理由と解除のしかたを見える形で出し、並びは元のまま ($locale)', async locale => {
    vi.spyOn(audioApi, 'reorderPlugins').mockRejectedValue(BACKEND_REASON);
    const { result } = await rack(locale);
    const reversed = [...result.current.plugins].reverse();
    await act(async () => { await result.current.reorderPlugins(reversed); });
    expect(result.current.plugins.map(plugin => plugin.id)).toEqual(['a', 'b']);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const { title, description } = lastError();
    expect(title).toBe(message(locale, 'pluginNotices.reorderFailed'));
    expect(description).toContain(BACKEND_REASON);
    expect(description).toContain(message(locale, 'pluginNotices.liveLockedHint'));
    expect(result.current.error).toBeNull();
});

it('保護以外の理由で削除や並べ替えに失敗したときは、これまでどおり一般の失敗文にする', async () => {
    vi.spyOn(audioApi, 'removePlugin').mockRejectedValue('Plugin not found');
    vi.spyOn(audioApi, 'reorderPlugins').mockRejectedValue('engine busy');
    const { result } = await rack('ja');
    await act(async () => { await result.current.removePlugin('a'); });
    expect(result.current.error).toBe(message('ja', 'pluginNotices.removeFailed'));
    await act(async () => { await result.current.reorderPlugins([...result.current.plugins].reverse()); });
    expect(result.current.error).toBe(message('ja', 'pluginNotices.reorderFailed'));
    expect(result.current.plugins.map(plugin => plugin.id)).toEqual(['a', 'b']);
    expect(toast.error).not.toHaveBeenCalled();
});

it('削除を元に戻す操作がロックに阻まれたときも、保護の理由を出す', async () => {
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    const { result } = await rack('ja');
    await act(async () => { await result.current.removePlugin('a'); });
    const success = vi.mocked(toast.success).mock.calls.slice(-1).pop();
    const action = (success?.[1] as { action?: { onClick: () => void } } | undefined)?.action;
    expect(action).toBeDefined();
    vi.mocked(audioApi.restorePlugin).mockRejectedValue(BACKEND_REASON);
    vi.mocked(toast.loading).mockReturnValue('undo-toast');
    await act(async () => { action?.onClick(); });
    const { title, description } = lastError();
    expect(title).toBe(message('ja', 'pluginNotices.restoreFailed'));
    expect(description).toContain(message('ja', 'pluginNotices.liveLockedHint'));
});
