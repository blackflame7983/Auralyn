import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { audioApi } from '../../api/audio';
import { presetApi } from '../../api/presets';
import { usePlugins } from '../usePlugins';
import { installSessionRackFixture } from './sessionRackFixture';
import { PLUGIN_SESSION_KEY as KEY, PLUGIN_SESSION_BACKUP_KEY as BACKUP, PLUGIN_SESSION_PROTECTED_KEY as PROTECTED } from '../usePluginSessionPersistence';
import { LocaleProvider } from '../../i18n/LocaleProvider';
import { createLocaleStore } from '../../i18n/locale';
import { PluginClientError } from '../../lib/pluginNotice';

vi.mock('sonner', () => ({toast: {error: vi.fn(), success: vi.fn(), warning: vi.fn(), loading: vi.fn()}}));
const item = (path: string) => ({path, name: `実名 ${path}`, enabled: true, muted: false, gain: .8, state: `opaque-${path}`});
const original = JSON.stringify([item('a'), item('b')]);
function language() {
    const store = createLocaleStore(() => 'ja', () => true);
    return {store, wrapper: ({children}: {children: ReactNode}) => <LocaleProvider store={store}>{children}</LocaleProvider>};
}
function strictSave() {
    const resolve = vi.fn(), reject = vi.fn();
    act(() => window.dispatchEvent(new CustomEvent('auralyn-save-session', {detail: {resolve, reject}})));
    return {resolve, reject};
}
beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); installSessionRackFixture();
    vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({is_running: true, config: null});
    vi.spyOn(audioApi, 'restorePlugin').mockImplementation(async request => ({id: request.path, name: request.path, prepared: false}));
    vi.spyOn(audioApi, 'removePlugin').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setInputGain').mockResolvedValue(undefined); vi.spyOn(audioApi, 'setOutputGain').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'scanPlugins').mockResolvedValue([]); vi.spyOn(audioApi, 'getPluginState').mockResolvedValue('runtime');
    vi.spyOn(audioApi, 'start').mockResolvedValue({sample_rate: 48000, buffer_size: 512, channels: 2}); vi.spyOn(audioApi, 'stop').mockResolvedValue(undefined);
    localStorage.setItem(KEY, original); localStorage.setItem(BACKUP, 'immutable backup');
});
afterEach(() => {cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear();});
it.each(['retained', 'partial'])('%sのnoticeはlocaleだけで再表示し、62秒・明示保存でも原本と副作用数を維持する', async kind => {
    if (kind === 'retained') {
        localStorage.setItem(KEY, '{corrupt saved JSON');
        vi.mocked(audioApi.sessionRack).mockResolvedValue({status: 'snapshot', generation: 'g', revision: '7', running: false, present: true, restoreEligible: false,
            plugins: [{id: 'actual-a', path: 'same', name: 'Actual A', enabled: true, muted: false, gain: .3}, {id: 'actual-b', path: 'same', name: 'Actual B', enabled: false, muted: true, gain: .7}]});
    } else {
        vi.mocked(audioApi.restorePlugin).mockImplementation(async request => {if (request.path === 'a') throw new Error('Plugin not found: actual SDK error'); return {id: 'actual-b', name: '実名 b', prepared: false};});
    }
    const {store, wrapper} = language(); const {result} = renderHook(() => usePlugins(), {wrapper}); await act(async () => {});
    expect(result.current.sessionRestoreStatus).toBe(kind);
    expect(result.current.error?.match(/保護中/g)).toHaveLength(1);
    const snapshot = {raw: localStorage.getItem(KEY), backup: localStorage.getItem(BACKUP), ids: result.current.plugins.map(p => p.id), requests: vi.mocked(audioApi.sessionRack).mock.calls.length, restores: vi.mocked(audioApi.restorePlugin).mock.calls.length, input: vi.mocked(audioApi.setInputGain).mock.calls.length, output: vi.mocked(audioApi.setOutputGain).mock.calls.length};
    const functions = [result.current.restoreSession, result.current.retrySessionRestore, result.current.scanPlugins, result.current.savePreset];
    act(() => {store.setLocale('en');});
    expect(result.current.error).toContain(kind === 'retained' ? 'Showing the VST rack retained' : '1 VSTs could not be restored');
    expect(result.current.error?.match(/saved configuration is protected/g)).toHaveLength(1);
    expect(result.current.sessionProtectionReason).toContain('protected');
    expect([result.current.restoreSession, result.current.retrySessionRestore, result.current.scanPlugins, result.current.savePreset]).toEqual(functions);
    await act(() => vi.advanceTimersByTimeAsync(62_000)); const save = strictSave(); await act(async () => {});
    expect(save.resolve).not.toHaveBeenCalled(); const error = save.reject.mock.calls[0][0];
    expect(error).toBeInstanceOf(PluginClientError); expect(error.code).toBe('saveProtected'); expect(error.message).toContain('保護中');
    expect(localStorage.getItem(KEY)).toBe(snapshot.raw); expect(localStorage.getItem(BACKUP)).toBe(snapshot.backup); expect(localStorage.getItem(PROTECTED)).toBe('true');
    expect(result.current.plugins.map(p => p.id)).toEqual(snapshot.ids);
    expect(audioApi.sessionRack).toHaveBeenCalledTimes(snapshot.requests); expect(audioApi.restorePlugin).toHaveBeenCalledTimes(snapshot.restores);
    expect(audioApi.setInputGain).toHaveBeenCalledTimes(snapshot.input); expect(audioApi.setOutputGain).toHaveBeenCalledTimes(snapshot.output);
    expect(audioApi.scanPlugins).not.toHaveBeenCalled(); expect(audioApi.getPluginState).not.toHaveBeenCalled(); expect(audioApi.start).not.toHaveBeenCalled(); expect(audioApi.stop).not.toHaveBeenCalled();
    act(() => {store.setLocale('ja');}); expect(result.current.error?.match(/保護中/g)).toHaveLength(1);
});
it('profile保存の遅い失敗もkeyで保持し、locale変更で保存要求やstate採取を再実行しない', async () => {
    localStorage.setItem(KEY, '[]'); let fail!: (error: unknown) => void;
    const save = vi.spyOn(presetApi, 'save').mockReturnValue(new Promise((_resolve, reject) => {fail = reject;}));
    const {store, wrapper} = language(); const {result} = renderHook(() => usePlugins(), {wrapper}); await act(async () => {});
    let pending!: Promise<boolean>; act(() => {pending = result.current.savePreset('My 実名');}); await act(async () => {});
    act(() => {store.setLocale('en');}); expect(save).toHaveBeenCalledOnce();
    await act(async () => {fail(new Error('raw SDK')); expect(await pending).toBe(false);}); expect(result.current.error).toBe('Could not save the preset');
    act(() => {store.setLocale('ja');}); expect(result.current.error).toBe('プリセットの保存に失敗しました'); expect(save).toHaveBeenCalledExactlyOnceWith('My 実名', []);
});
