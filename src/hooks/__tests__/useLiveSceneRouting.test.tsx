import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { obsApi, type ObsLiveSceneEvent } from '@/api/obs';
import { presetApi } from '@/api/presets';
import { liveModesApi } from '@/api/liveModes';
import { LIVE_ROUTING_KEY, saveLiveRouting, beginRackRestore } from '@/lib/liveRouting';
import { useLiveSceneRouting } from '../useLiveSceneRouting';
import { liveSnapshot } from './liveModesFixture';
let receive: (event: ObsLiveSceneEvent) => void;
let invalidated: () => void;
let status: { connected: boolean; connectionGeneration: number; sequence: number };
const load = vi.fn(async () => true);
const emit = async (sceneName = '同名', sequence = 1, connectionGeneration = 1) => {
    status = { connected: true, sequence, connectionGeneration };
    await act(async () => receive({ sceneName, sequence, connectionGeneration }));
};
beforeEach(() => {
    localStorage.clear(); load.mockClear(); status = { connected: true, connectionGeneration: 1, sequence: 0 };
    vi.spyOn(obsApi, 'liveSceneStatus').mockImplementation(async () => status);
    vi.spyOn(obsApi, 'onLiveSceneChanged').mockImplementation(async callback => { receive = callback; return vi.fn<() => void>(); });
    vi.spyOn(obsApi, 'onLiveSceneInvalidated').mockImplementation(async callback => { invalidated = callback; return vi.fn<() => void>(); });
    vi.spyOn(obsApi, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(obsApi, 'connect').mockResolvedValue(undefined);
    vi.spyOn(presetApi, 'list').mockResolvedValue(['同名']);
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot());
    vi.spyOn(liveModesApi, 'select').mockResolvedValue(liveSnapshot());
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.restoreAllMocks(); });
const ready = async () => { renderHook(() => useLiveSceneRouting(load)); await waitFor(() => expect(obsApi.liveSceneStatus).toHaveBeenCalled()); await act(async () => {}); };
it('未保存は接続中の従来presetだけを使い、接続・初期取得では読み込まない', async () => {
    await ready();
    expect(load).not.toHaveBeenCalled(); expect(obsApi.connect).not.toHaveBeenCalled();
    await emit();
    expect(load).toHaveBeenCalledWith('同名'); expect(liveModesApi.select).not.toHaveBeenCalled();
});
it('mode方式は同名presetへ一切触らず、未割当とmode失敗でもfallbackしない', async () => {
    saveLiveRouting({ version: 1, strategy: 'mode', explicitEnabled: true, mappings: { 同名: 'singing' } });
    await ready();
    await emit('未割当'); expect(liveModesApi.select).not.toHaveBeenCalled();
    vi.mocked(liveModesApi.select).mockRejectedValueOnce('未登録');
    await emit('同名', 2);
    expect(liveModesApi.select).toHaveBeenCalledWith('singing', 'host1');
    expect(presetApi.list).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
});
it.each(['strategy', 'sequence', 'disconnect'])('遅いlist中の%sは旧preset読込を無効にする', async change => {
    let resolve!: (value: string[]) => void;
    vi.mocked(presetApi.list).mockReturnValue(new Promise(done => { resolve = done; }));
    await ready();
    await emit();
    if (change === 'strategy') act(() => saveLiveRouting({ version: 1, strategy: 'none', explicitEnabled: false, mappings: {} }));
    else if (change === 'sequence') await emit('別のシーン', 2);
    else status = { connected: false, connectionGeneration: 2, sequence: 0 };
    await act(async () => resolve(['同名']));
    expect(load).not.toHaveBeenCalled();
});
it('同じ連番・旧接続世代を拒否し、手動再接続後の新世代の実sceneだけ受理する', async () => {
    saveLiveRouting({ version: 1, strategy: 'mode', explicitEnabled: true, mappings: { 同名: 'talk' } });
    await ready(); await emit();
    await emit(); expect(liveModesApi.select).toHaveBeenCalledTimes(1);
    status = { connected: false, connectionGeneration: 2, sequence: 0 };
    await act(async () => invalidated());
    await act(async () => receive({ sceneName: '同名', connectionGeneration: 1, sequence: 9 }));
    expect(liveModesApi.select).toHaveBeenCalledTimes(1);
    status = { connected: true, connectionGeneration: 3, sequence: 0 };
    expect(liveModesApi.select).toHaveBeenCalledTimes(1);
    await emit('同名', 1, 3);
    expect(liveModesApi.select).toHaveBeenCalledTimes(2); expect(obsApi.connect).not.toHaveBeenCalled();
});
it('preset復元の全体busy中はmodeを実行せず、方式保存を拒否する', async () => {
    saveLiveRouting({ version: 1, strategy: 'mode', explicitEnabled: true, mappings: { 同名: 'talk' } });
    await ready(); const release = beginRackRestore();
    try {
        await emit(); expect(liveModesApi.select).not.toHaveBeenCalled();
        expect(() => saveLiveRouting({ version: 1, strategy: 'none', explicitEnabled: false, mappings: {} })).toThrow('復元中');
    } finally { release(); }
});
it('明示enableだけ背景leaseを持ち、hiddenでも保ち、disableで最後の接続を解放する', async () => {
    localStorage.setItem(LIVE_ROUTING_KEY, JSON.stringify({ version: 1, strategy: 'mode', explicitEnabled: true, mappings: {} }));
    await ready();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(obsApi.disconnect).not.toHaveBeenCalled();
    act(() => saveLiveRouting({ version: 1, strategy: 'none', explicitEnabled: false, mappings: {} }));
    await act(async () => {});
    expect(obsApi.disconnect).toHaveBeenCalledOnce(); hidden.mockRestore();
});
