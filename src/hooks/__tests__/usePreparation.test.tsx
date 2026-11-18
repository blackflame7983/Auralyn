import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { liveOutputApi } from '@/api/liveOutput';
import { obsApi } from '@/api/obs';
import type { ObsAudioReachResult } from '@/api/obs';
import { context, audioState, runtime, runtimeWith, liveStatus } from '@/__tests__/fixtures/preparation';
import { confirmationState, editPreparationReceiver, preparationReach, readPreparationContext, savePreparationContext } from '@/lib/preparation';
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
it('診断で受け側の入力名を変えると保存し、受け側の確認だけを失効する', async () => {
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    for (const stage of ['sound', 'listen', 'receiver'] as const) await act(async () => result.current.confirm(stage));
    act(() => { editPreparationReceiver('Auralyn Mic'); });
    await settle();
    expect(result.current.context.receiver).toBe('Auralyn Mic');
    expect(readPreparationContext().receiver).toBe('Auralyn Mic');
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
    expect(confirmationState(result.current.records, 'listen')).toBe('confirmed');
    expect(confirmationState(result.current.records, 'receiver')).toBe('stale');
    act(() => { editPreparationReceiver(''); });
    await settle();
    expect(result.current.context.receiver).toBe('');
    expect(readPreparationContext().receiver).toBe('');
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
it('診断を開いている間（blocked）に名前を確定しても、背後を確認待ちにせず、閉じたあとの読み直しで受け側だけが失効する', async () => {
    const { result, rerender } = renderHook(({ blocked }) => usePreparation({ running: true, blocked }), { initialProps: { blocked: false } }); await settle();
    for (const stage of ['sound', 'listen', 'receiver'] as const) await act(async () => result.current.confirm(stage));
    rerender({ blocked: true }); await settle();
    act(() => { editPreparationReceiver('Auralyn Mic'); }); await settle();
    expect(result.current.context.receiver).toBe('Auralyn Mic');
    expect(result.current.observation.availability).toBe('ready');
    expect(result.current.checking).toBe(false);
    expect(confirmationState(result.current.records, 'receiver')).toBe('stale');
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
    rerender({ blocked: false }); await settle();
    expect(result.current.observation.availability).toBe('ready');
    expect(result.current.checking).toBe(false);
    expect(confirmationState(result.current.records, 'listen')).toBe('confirmed');
});
it('名前が前後の空白しか変わらないときは、確認を失効せず、OBS到達の記録も消さない', async () => {
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    for (const stage of ['sound', 'listen', 'receiver'] as const) await act(async () => result.current.confirm(stage));
    const clear = vi.spyOn(preparationReach, 'clear');
    act(() => { editPreparationReceiver(`  ${context.receiver}  `); }); await settle();
    expect(clear).not.toHaveBeenCalled();
    expect(result.current.context.receiver).toBe(context.receiver);
    expect(confirmationState(result.current.records, 'receiver')).toBe('confirmed');
    act(() => result.current.changeContext({ receiver: `${context.receiver} ` })); await settle();
    expect(confirmationState(result.current.records, 'receiver')).toBe('confirmed');
    expect(clear).not.toHaveBeenCalled();
});
it('空白だけの名前は空として保存する', async () => {
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    act(() => { editPreparationReceiver('   '); }); await settle();
    expect(result.current.context.receiver).toBe('');
    expect(readPreparationContext().receiver).toBe('');
});
// ---- #799: 緊急ミュートと出力音量ゼロを、定期の取り直し（2秒）を待たずに札へ反映する ----
const controls = { muted: false, outputGain: 1 };
const timers = () => { vi.useRealTimers(); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] }); };
const emitTauri = (name: string) => act(() => { handlers.get(name)?.forEach(fn => fn()); });
const gainSynced = (pct: number) => act(() => { window.dispatchEvent(new CustomEvent('output-gain-sync', { detail: pct })); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const mockControls = () => {
    controls.muted = false; controls.outputGain = 1;
    vi.mocked(audioApi.getEngineRuntimeStats).mockImplementation(async () => runtimeWith(controls));
};
const readsOf = () => vi.mocked(audioApi.getAudioState).mock.calls.length / 2;

it('緊急ミュートの通知で、2秒の定期取得を待たずに「音を送っていません」へ変わり、解除でも戻る', async () => {
    timers(); mockControls();
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    expect(result.current.observation.availability).toBe('ready');
    controls.muted = true; emitTauri('global-mute-changed'); await settle();
    expect(result.current.observation.availability).toBe('muted');
    expect(result.current.observation.muteCause).toBe('muted');
    await advance(300);
    controls.muted = false; emitTauri('global-mute-changed'); await settle();
    expect(result.current.observation.availability).toBe('ready');
});
it('出力音量を0にした同期で、定期取得を待たずに音量ゼロへ変わり、戻すと戻る', async () => {
    timers(); mockControls();
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    controls.outputGain = 0; gainSynced(0); await settle();
    expect(result.current.observation.availability).toBe('muted');
    expect(result.current.observation.muteCause).toBe('zeroGain');
    await advance(300);
    controls.outputGain = 1; gainSynced(100); await settle();
    expect(result.current.observation.availability).toBe('ready');
});
it('取り直しの途中でミュートが解けても、前の状態の応答で上書きせず、最後の操作の状態が残る', async () => {
    timers(); mockControls(); controls.muted = true;
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    expect(result.current.observation.availability).toBe('muted');
    let release!: () => void; let calls = 0; let hold = true;
    vi.mocked(audioApi.getAudioState).mockImplementation(async () => {
        calls += 1;
        if (hold && calls === 2) await new Promise<void>(resolve => { release = resolve; });
        return audioState;
    });
    act(() => { void result.current.refresh(); }); await settle();
    controls.muted = false; emitTauri('global-mute-changed');
    hold = false; release(); await settle();
    expect(result.current.observation.availability).toBe('ready');
    // 解除→再ミュートの順で操作しても、最後のミュートが残る。
    calls = 0; hold = true;
    act(() => { void result.current.refresh(); }); await settle();
    controls.muted = true; emitTauri('global-mute-changed');
    await advance(300);
    controls.muted = false; emitTauri('global-mute-changed');
    await advance(300);
    controls.muted = true; emitTauri('global-mute-changed');
    hold = false; release(); await settle(); await advance(300); await settle();
    expect(result.current.observation.availability).toBe('muted');
});
it('スライダーの連続操作で、取り直しは操作の回数だけ走らず、最後の値が残る', async () => {
    timers(); mockControls();
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    const before = readsOf();
    for (let i = 0; i < 20; i += 1) { controls.outputGain = (19 - i) / 19; gainSynced(controls.outputGain * 100); }
    await settle(); await advance(300); await settle();
    expect(readsOf() - before).toBeGreaterThanOrEqual(1);
    expect(readsOf() - before).toBeLessThanOrEqual(3);
    expect(result.current.observation.availability).toBe('muted');
    expect(result.current.observation.muteCause).toBe('zeroGain');
    const spread = readsOf();
    for (let i = 0; i < 20; i += 1) { controls.outputGain = i / 20 + .05; gainSynced(controls.outputGain * 100); await advance(30); await settle(); }
    await advance(300); await settle();
    expect(readsOf() - spread).toBeLessThanOrEqual(6);
    expect(result.current.observation.availability).toBe('ready');
});
it('診断・設定などで取得を止めている間も、ミュートと音量ゼロの札だけは変わり、確認の記録と構成は保つ', async () => {
    timers(); mockControls();
    const { result, rerender } = renderHook(({ blocked }) => usePreparation({ running: true, blocked }), { initialProps: { blocked: false } }); await settle();
    await act(async () => result.current.confirm('sound'));
    const config = result.current.observation.config;
    rerender({ blocked: true }); await settle();
    const full = { state: vi.mocked(audioApi.getAudioState).mock.calls.length, live: vi.mocked(liveOutputApi.request).mock.calls.length };
    controls.muted = true; emitTauri('global-mute-changed'); await settle();
    expect(result.current.observation.availability).toBe('muted');
    expect(result.current.observation.muteCause).toBe('muted');
    await advance(300);
    controls.muted = false; controls.outputGain = 0; gainSynced(0); await settle();
    expect(result.current.observation.muteCause).toBe('zeroGain');
    await advance(300);
    controls.outputGain = 1; gainSynced(100); await settle();
    expect(result.current.observation.availability).toBe('ready');
    expect(result.current.observation.config).toBe(config);
    expect(result.current.checking).toBe(false);
    expect(confirmationState(result.current.records, 'sound')).toBe('confirmed');
    expect(vi.mocked(audioApi.getAudioState).mock.calls.length).toBe(full.state);
    expect(vi.mocked(liveOutputApi.request).mock.calls.length).toBe(full.live);
});
it('取得を止めている間に、読取りが失敗しても札を「確認できません」へ落とさない', async () => {
    timers(); mockControls();
    const { result, rerender } = renderHook(({ blocked }) => usePreparation({ running: true, blocked }), { initialProps: { blocked: false } }); await settle();
    rerender({ blocked: true }); await settle();
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValue(new Error('offline'));
    emitTauri('global-mute-changed'); await settle();
    expect(result.current.observation.availability).toBe('ready');
});

// ---- #799 レビュー指摘：同じ音量の再通知の判定は、読取りで確定した値だけを使う ----
it('読取りに失敗したあとの、同じ音量の再通知でも取り直して、札が直る', async () => {
    timers(); mockControls();
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    controls.outputGain = 0;
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValueOnce(new Error('offline'));
    gainSynced(0); await settle();
    expect(result.current.observation.availability).toBe('unknown');
    await advance(300);
    mockControls(); controls.outputGain = 0;
    gainSynced(0); await settle();
    expect(result.current.observation.availability).toBe('muted');
    expect(result.current.observation.muteCause).toBe('zeroGain');
});
it('反映待ち（controlsPending）の読取りのあとの、同じ音量の再通知でも取り直す', async () => {
    timers(); mockControls();
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    vi.mocked(audioApi.getEngineRuntimeStats).mockImplementation(async () => {
        const stats = runtimeWith({ muted: false, outputGain: 0 });
        return { ...stats, preparation: stats.preparation && { ...stats.preparation, controlsPending: true } };
    });
    gainSynced(0); await settle();
    expect(result.current.observation.availability).toBe('pending');
    await advance(300);
    mockControls(); controls.outputGain = 0;
    gainSynced(0); await settle();
    expect(result.current.observation.availability).toBe('muted');
});
it('実際に読めた値と同じ再通知（音量の自動調整の状態確認など）では取り直さない', async () => {
    timers(); mockControls();
    renderHook(() => usePreparation({ running: true })); await settle();
    const before = readsOf();
    gainSynced(100); await settle(); await advance(300); gainSynced(100); await settle();
    expect(readsOf()).toBe(before);
    controls.outputGain = .5; gainSynced(50); await settle();
    expect(readsOf()).toBe(before + 1);
    await advance(300);
    gainSynced(50); await settle();
    expect(readsOf()).toBe(before + 1);
});
it('通知なしに音量が変わっても、次の読取りで確定した値と突き合わせるので、再通知を取りこぼさない', async () => {
    timers(); mockControls();
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    controls.outputGain = 0; gainSynced(0); await settle();
    expect(result.current.observation.muteCause).toBe('zeroGain');
    // 通知を出さない経路（定期の取り直し）で音量が戻ったあと、もう一度0にした通知を受ける。
    controls.outputGain = 1; await advance(2000); await settle();
    expect(result.current.observation.availability).toBe('ready');
    controls.outputGain = 0; gainSynced(0); await settle();
    expect(result.current.observation.muteCause).toBe('zeroGain');
});

// ---- #799 レビュー指摘：取得を止めている間の読取りは、古い応答で新しい状態を上書きしない ----
it('設定のページを閉じて開き直しても、前の読取りの古い応答で現在の札を上書きしない', async () => {
    timers(); mockControls();
    const { result, rerender } = renderHook(({ blocked }) => usePreparation({ running: true, blocked }), { initialProps: { blocked: false } }); await settle();
    expect(result.current.observation.availability).toBe('ready');
    rerender({ blocked: true }); await settle();
    let release!: () => void; let hold = true;
    vi.mocked(audioApi.getEngineRuntimeStats).mockImplementation(async () => {
        const stats = runtimeWith(controls);
        if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
        return stats;
    });
    controls.muted = true; emitTauri('global-mute-changed'); await settle();
    // 古い読取り（ミュート）が返らないまま、ミュートが解けて、ページを閉じて開き直す。
    controls.muted = false;
    rerender({ blocked: false }); await settle();
    expect(result.current.observation.availability).toBe('ready');
    rerender({ blocked: true }); await settle();
    release(); await settle();
    expect(result.current.observation.availability).toBe('ready');
});
it('停止の通知のあとに返った、取得停止中の古い読取りで札を書き換えない', async () => {
    timers(); mockControls();
    const { result } = renderHook(() => usePreparation({ running: true, blocked: true })); await settle();
    let release!: () => void;
    vi.mocked(audioApi.getEngineRuntimeStats).mockImplementation(async () => {
        const stats = runtimeWith({ muted: true, outputGain: 1 });
        await new Promise<void>(resolve => { release = resolve; });
        return stats;
    });
    emitTauri('global-mute-changed'); await settle();
    emitTauri('audio-stopped'); emitTauri('audio-started'); await settle();
    mockControls(); controls.muted = false;
    release(); await settle();
    expect(result.current.observation.availability).not.toBe('muted');
});

it('条件の通知（ミュートや音量の操作のたびに来る）の間も、音を送っていない札は消えず、取り直しで状態が変わる', async () => {
    timers(); mockControls(); controls.muted = true;
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    expect(result.current.observation.availability).toBe('muted');
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
        emitTauri('audio-conditions-changed'); seen.push(result.current.observation.availability);
        await settle(); seen.push(result.current.observation.availability);
    }
    expect(new Set(seen)).toEqual(new Set(['muted']));
    await advance(300);
    await advance(300);
    controls.muted = false; emitTauri('audio-conditions-changed'); await settle();
    expect(result.current.observation.availability).toBe('ready');
});

it('条件の通知が続いても（スライダーの操作ごとに2回ずつ来る）、取り直しは間隔ごとに1回へまとまり、最後の状態が残る', async () => {
    timers(); mockControls();
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    const before = readsOf();
    for (let i = 0; i < 40; i += 1) { controls.outputGain = (39 - i) / 39; emitTauri('audio-conditions-changed'); await advance(10); await settle(); }
    await advance(300); await settle();
    expect(readsOf() - before).toBeLessThanOrEqual(8);
    expect(result.current.observation.muteCause).toBe('zeroGain');
});
it('アプリの音声で確認した記録の対象は、空ではなくアプリ名になる（#756）', async () => {
    const source = { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'chrome.exe', rawEndpointId: 'raw-1', purpose: 'music' } } as const;
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ ...audioState, config: { host: 'WASAPI', input: null, output: 'CABLE Input', sample_rate: 48000, buffer_size: 256, input_source: source } });
    const { result } = renderHook(() => usePreparation({ running: true })); await settle();
    expect(result.current.observation.availability).toBe('ready');
    for (const stage of ['sound', 'listen'] as const) await act(async () => result.current.confirm(stage));
    expect(result.current.records.sound?.target).toBe('chrome.exe');
    expect(result.current.records.listen?.target).toBe('chrome.exe');
});
