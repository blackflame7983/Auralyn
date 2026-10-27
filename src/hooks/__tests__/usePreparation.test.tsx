import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { liveOutputApi } from '@/api/liveOutput';
import { obsApi } from '@/api/obs';
import type { ObsAudioReachResult } from '@/api/obs';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { confirmationState, preparationReach, savePreparationContext } from '@/lib/preparation';
import { usePreparation } from '../usePreparation';

const handlers = new Map<string, Set<() => void>>();
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); handlers.clear(); localStorage.clear(); preparationReach.clear(); savePreparationContext(context);
    vi.mocked(listen).mockImplementation(async (event, callback) => {
        const fn = callback as unknown as () => void;
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(fn);
        return () => { handlers.get(event)?.delete(fn); };
    });
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue(audioState);
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockImplementation(async () => runtime());
    vi.spyOn(liveOutputApi, 'request').mockResolvedValue(liveStatus);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const settle = () => act(async () => {});

it('StrictModeでも購読は一組で、確認は明示操作まで未確認、通話ではOBSを読まない', async () => {
    const obs = vi.spyOn(obsApi, 'audioReachCurrent');
    const { result, unmount } = renderHook(() => usePreparation({ running: true }), { wrapper: StrictMode });
    await settle();
    expect(result.current.observation.availability).toBe('ready');
    expect(result.current.records).toEqual({});
    expect(handlers.get('audio-started')!.size).toBe(1);
    await act(async () => result.current.confirm('sound'));
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
    expect(obs).not.toHaveBeenCalled();
    unmount(); await settle();
    expect(handlers.get('audio-started')!.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});
it('連続した状態取得を一本化し、停止後の古い成功を無視する', async () => {
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    await act(async () => result.current.confirm('sound'));
    let resolve!: (value: typeof audioState) => void;
    const read = vi.mocked(audioApi.getAudioState).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const callsBefore = read.mock.calls.length;
    let pending!: ReturnType<typeof result.current.refresh>;
    act(() => { pending = result.current.refresh(); result.current.refresh(); });
    expect(read).toHaveBeenCalledTimes(callsBefore + 1);
    act(() => handlers.get('audio-stopped')!.forEach(fn => fn()));
    await act(async () => { resolve(audioState); await pending; });
    expect(result.current.observation.availability).toBe('stopped');
    expect(confirmationState(result.current.records, 'sound')).toBe('stale');
});
it('取得失敗・処理変更を挟む読み取りを確認済みにしない', async () => {
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    await act(async () => result.current.confirm('sound'));
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValueOnce(new Error('offline'));
    await act(async () => result.current.refresh());
    expect(result.current.observation.availability).toBe('unknown');
    expect(confirmationState(result.current.records, 'sound')).toBe('stale');
    const changed = runtime(); changed.preparation!.processingRevision = '2';
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValueOnce(runtime()).mockResolvedValueOnce(changed);
    await act(async () => result.current.confirm('sound'));
    expect(confirmationState(result.current.records, 'sound')).toBe('stale');
});
it('最後の表示から条件が変わっていたら、古い聴感のクリックを新条件の確認として記録しない', async () => {
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    const changed = runtime(); changed.preparation!.processingRevision = '2';
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(changed);
    await act(async () => result.current.confirm('sound'));
    expect(result.current.records.sound).toBeUndefined();
    await act(async () => result.current.confirm('sound'));
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
});
it('出力変更だけなら音作りを保持し、用途を変えると受け側だけを失効する', async () => {
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    for (const stage of ['sound', 'listen', 'receiver'] as const) await act(async () => result.current.confirm(stage));
    act(() => result.current.changeContext({ usage: 'other', receiver: 'App' })); await settle();
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
    expect(confirmationState(result.current.records, 'listen')).toBe('confirmed');
    expect(confirmationState(result.current.records, 'receiver')).toBe('stale');
    const changed = runtime(); changed.preparation!.outputGain = .8;
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(changed);
    act(() => handlers.get('audio-conditions-changed')!.forEach(fn => fn())); await settle();
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
    expect(confirmationState(result.current.records, 'listen')).toBe('stale');
});
it('診断など別画面で用途を変えたら共用通知から反映し、受け側確認と対象名だけを失効する', async () => {
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    for (const stage of ['sound', 'listen', 'receiver'] as const) await act(async () => result.current.confirm(stage));
    act(() => {
        localStorage.setItem('vst_host_setup_goal', 'local');
        window.dispatchEvent(new Event('preparation-purpose-changed'));
    });
    await settle();
    expect(result.current.context.usage).toBe('listening');
    expect(result.current.context.receiver).toBe('');
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
    expect(confirmationState(result.current.records, 'listen')).toBe('confirmed');
    expect(confirmationState(result.current.records, 'receiver')).toBe('stale');
    act(() => {
        localStorage.removeItem('vst_host_setup_goal');
        window.dispatchEvent(new Event('preparation-purpose-changed'));
    });
    await settle();
    expect(result.current.context.usage).toBe('');
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
});
it('モーダル中は確認不可、非表示化と外部VST操作で確認を失効する', async () => {
    const { result, rerender } = renderHook(({ blocked }) => usePreparation({ running: true, blocked }), { initialProps: { blocked: false } }); await settle();
    await act(async () => result.current.confirm('sound'));
    rerender({ blocked: true });
    await act(async () => result.current.confirm('listen'));
    expect(result.current.records.listen).toBeUndefined();
    rerender({ blocked: false }); await settle();
    act(() => window.dispatchEvent(new Event('preparation-external-change'))); await settle();
    expect(confirmationState(result.current.records, 'sound')).toBe('stale');
    await act(async () => result.current.confirm('sound'));
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.observation.availability).toBe('unknown');
    expect(confirmationState(result.current.records, 'sound')).toBe('stale');
});
it('OBSの検査は指定ソースのwitnessを再検証し、利用者確認へ自動変換しない', async () => {
    savePreparationContext({ ...context, usage: 'obs', receiver: 'Auralyn Mic' });
    preparationReach.record({ reached: true, verification: { operationId: 'check-1', source: 'Auralyn Mic', checkedAtUnixMs: 1 } } as ObsAudioReachResult);
    const obs = vi.spyOn(obsApi, 'audioReachCurrent').mockResolvedValue(true);
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    expect(obs).toHaveBeenCalledWith('check-1');
    expect(result.current.observation.obsCurrent).toBe(true);
    expect(result.current.records).toEqual({});
    await act(async () => result.current.confirm('sound'));
    await act(async () => result.current.confirm('receiver'));
    obs.mockResolvedValue(false);
    act(() => handlers.get('obs://reach-invalidated')!.forEach(fn => fn())); await settle();
    expect(result.current.observation.obsCurrent).toBe(false);
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
    expect(confirmationState(result.current.records, 'receiver')).toBe('stale');
    act(() => result.current.changeContext({ receiver: 'Unrelated source' })); await settle();
    obs.mockClear();
    await act(async () => result.current.refresh());
    expect(obs).not.toHaveBeenCalled();
});
