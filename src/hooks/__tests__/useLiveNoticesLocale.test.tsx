import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { liveModesApi } from '@/api/liveModes';
import { builtinApi, defaultReverb } from '@/api/builtinEffects';
import { obsApi, type ObsLiveSceneEvent } from '@/api/obs';
import { presetApi } from '@/api/presets';
import { LIVE_ROUTING_KEY, beginRackRestore } from '@/lib/liveRouting';
import { useLiveModes } from '../useLiveModes';
import { useLiveSceneRouting } from '../useLiveSceneRouting';
import { liveSnapshot } from './liveModesFixture';

vi.mock('sonner', () => ({toast: {info: vi.fn(), error: vi.fn()}}));
function language() {
    const store = createLocaleStore(() => 'ja', () => true);
    return {store, wrapper: ({children}: {children: ReactNode}) => <LocaleProvider store={store}>{children}</LocaleProvider>};
}
beforeEach(() => {vi.useFakeTimers(); localStorage.clear(); vi.clearAllMocks(); vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot());});
afterEach(async () => {cleanup(); await act(async () => {}); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear();});
it('未使用中もpending操作中もlocaleでIPC/poll/購読を増やさず、元epoch/armed/目標の応答だけを採用する', async () => {
    const {store, wrapper} = language(); const {result} = renderHook(() => useLiveModes(), {wrapper});
    act(() => {store.setLocale('en');}); expect(liveModesApi.request).not.toHaveBeenCalled();
    let release!: () => void; await act(async () => {release = result.current.activate();});
    const subscriptionCount = vi.mocked(listen).mock.calls.length;
    const refresh = result.current.refresh; let finish!: (value: ReturnType<typeof liveSnapshot>) => void;
    const select = vi.spyOn(liveModesApi, 'select').mockReturnValue(new Promise(resolve => {finish = resolve;}));
    act(() => {void result.current.select('singing');}); expect(result.current.busy).toBe(true);
    act(() => {store.setLocale('ja');}); await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.busy).toBe(true); expect(result.current.refresh).toBe(refresh); expect(listen).toHaveBeenCalledTimes(subscriptionCount);
    expect(liveModesApi.request).toHaveBeenCalledOnce(); expect(select).toHaveBeenCalledExactlyOnceWith('singing', 'host1');
    const applied = liveSnapshot({armed: true, target: 'singing', phase: 'queued', revision: '2', acceptedRevision: '1'});
    await act(async () => finish(applied)); expect(result.current.snapshot).toBe(applied); expect(result.current.busy).toBe(false);
    act(() => release()); const requests = vi.mocked(liveModesApi.request).mock.calls.length;
    act(() => {store.setLocale('en');}); await act(() => vi.advanceTimersByTimeAsync(1000)); expect(liveModesApi.request).toHaveBeenCalledTimes(requests);
});
it('client拒否と予約busyはkeyで再表示し、raw backend例外・未保存設定・本番保護を変更しない', async () => {
    const config = {active: false, preset: 'broadcast' as const, amount: .7, singing: null, reverb: {...defaultReverb, enabled: true}};
    const builtin = vi.spyOn(builtinApi, 'request').mockResolvedValue({epoch:'engine-9',revision:'3',appliedRevision:'2',pending:true,config,undoToken:null,error:null});
    const {store, wrapper} = language(); const {result} = renderHook(() => useLiveModes(), {wrapper});
    await act(async () => {await result.current.refresh(); await result.current.saveApplied('talk');});
    expect(result.current.error).toContain('未適用の下書き'); const snapshot = result.current.snapshot;
    act(() => {store.setLocale('en');}); expect(result.current.error).toContain('Unapplied drafts are not registered'); expect(builtin).toHaveBeenCalledOnce();
    expect(result.current.snapshot).toBe(snapshot); expect(config.reverb.enabled).toBe(true); expect(liveModesApi.request).toHaveBeenCalledOnce();
    const raw = new Error('Plugin not found: 実名'); const protect = vi.spyOn(liveModesApi, 'protect').mockRejectedValue(raw);
    await act(async () => {await result.current.protect(true);}); expect(result.current.error).not.toContain('Plugin not found'); expect(result.current.errorDetail).toBe('Error: Plugin not found: 実名'); expect(raw.message).toBe('Plugin not found: 実名');
    act(() => {store.setLocale('ja');}); expect(result.current.error).toContain('モードの状態を再取得'); expect(result.current.errorDetail).toBe('Error: Plugin not found: 実名'); expect(protect).toHaveBeenCalledExactlyOnceWith(true,'host1');
    let release!: () => void; act(() => {release = beginRackRestore();});
    try {
        await act(async () => {await result.current.select('talk');}); act(() => {store.setLocale('en');});
        expect(result.current.error).toContain('Wait for it to finish'); expect(result.current.busy).toBe(true); expect(result.current.snapshot).toBe(snapshot);
        expect(liveModesApi.request).toHaveBeenCalledOnce();
    } finally {act(() => release());}
});
it('遅いscene一覧のlocale切替ではlease/購読を作り直さず、実scene名を1回だけpresetへ渡す', async () => {
    const sceneName = '実名 シーン'; const raw = JSON.stringify({version:1,strategy:'preset',explicitEnabled:true,mappings:{'未保存扱いにしない':'talk'}});
    localStorage.setItem(LIVE_ROUTING_KEY, raw);
    let receive!: (event: ObsLiveSceneEvent) => void;
    vi.spyOn(obsApi,'onLiveSceneChanged').mockImplementation(async callback => {receive=callback;return () => {};});
    vi.spyOn(obsApi,'onLiveSceneInvalidated').mockResolvedValue(() => {});
    let status = {connected:true,connectionGeneration:7,sequence:0}; const statusRead = vi.spyOn(obsApi,'liveSceneStatus').mockImplementation(async () => status);
    const disconnect = vi.spyOn(obsApi,'disconnect').mockResolvedValue(undefined); const connect = vi.spyOn(obsApi,'connect').mockResolvedValue(undefined);
    let finish!: (value: string[]) => void; const list = vi.spyOn(presetApi,'list').mockReturnValue(new Promise(resolve => {finish=resolve;})); const load = vi.fn(async () => true);
    const {store,wrapper} = language(); renderHook(() => useLiveSceneRouting(load), {wrapper}); await act(async () => {});
    status = {...status,sequence:1}; act(() => receive({sceneName,connectionGeneration:7,sequence:1}));
    const beforeReads=statusRead.mock.calls.length; act(() => {store.setLocale('en');});
    expect(statusRead).toHaveBeenCalledTimes(beforeReads); expect(obsApi.onLiveSceneChanged).toHaveBeenCalledOnce(); expect(obsApi.onLiveSceneInvalidated).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce(); expect(load).not.toHaveBeenCalled(); expect(disconnect).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    await act(async () => finish([sceneName])); expect(load).toHaveBeenCalledExactlyOnceWith(sceneName); expect(toast.info).toHaveBeenCalledWith('Loading the preset for scene “実名 シーン”');
    expect(localStorage.getItem(LIVE_ROUTING_KEY)).toBe(raw); act(() => {store.setLocale('ja');}); expect(load).toHaveBeenCalledOnce();
});
