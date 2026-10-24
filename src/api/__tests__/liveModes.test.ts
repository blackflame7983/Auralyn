import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { liveModesApi, type LiveModeRequest } from '../liveModes';
afterEach(() => vi.mocked(invoke).mockReset());
it('UI/OBSの明示modeとarm/disarmは同じclient単調intentでHost epochを送る', async () => {
    await liveModesApi.select('singing', 'host1'); await liveModesApi.protect(true, 'host1'); await liveModesApi.select('talk', 'host2'); await liveModesApi.protect(false, 'host2');
    const requests = vi.mocked(invoke).mock.calls.map(([, args]) => (args as { request: LiveModeRequest }).request).filter((request): request is Extract<LiveModeRequest, { intent: unknown }> => 'intent' in request);
    expect(requests.map(request => request.action)).toEqual(['singing_on', 'arm', 'talk_on', 'disarm']);
    expect(new Set(requests.map(request => request.intent.clientId)).size).toBe(1);
    expect(requests.map(request => request.intent.expectedEpoch)).toEqual(['host1', 'host1', 'host2', 'host2']);
    expect(requests.every((request, index) => index === 0 || request.intent.sequence > requests[index - 1].intent.sequence)).toBe(true);
    await liveModesApi.preflight(); await liveModesApi.beginChanges(); await liveModesApi.endChanges('own-token');
    expect(invoke).toHaveBeenCalledWith('end_live_changes', { token: 'own-token' });
});
