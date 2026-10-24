// 既存hookテストでは、新しい予約APIを通して従来のVST応答stubを再利用する。
import { vi } from 'vitest';
import { audioApi, type RackPlugin } from '../../api/audio';
export function installSessionRackFixture() {
    let plugins: Array<RackPlugin & { removalIndex: number }> = [];
    let active = false;
    vi.spyOn(audioApi, 'sessionRack').mockImplementation(async request => {
        if (request.action === 'snapshot') {
            const lastState = vi.isMockFunction(audioApi.getAudioState) ? vi.mocked(audioApi.getAudioState).mock.results.slice(-1)[0]?.value : undefined;
            if (lastState && (await lastState)?.is_running === false) plugins = [];
            const removals = vi.isMockFunction(audioApi.removePlugin) ? vi.mocked(audioApi.removePlugin).mock.calls : [];
            plugins = plugins.filter(plugin => !removals.slice(plugin.removalIndex).some(([id]) => id === plugin.id));
            return { status: 'snapshot', revision: '0', running: false, generation: 'fixture', present: true, restoreEligible: true,
                plugins: plugins.map(({ removalIndex: _, ...plugin }) => plugin) };
        }
        if (request.action === 'retain') return { status: 'finished' };
        if (request.action === 'begin') { active = true; return { status: 'ready', generation: 'fixture', token: 'fixture-token' }; }
        if (request.action === 'finish') { active = false; return { status: 'finished' }; }
        if (!active) return { status: 'conflict' };
        try {
            const plugin = await audioApi.restorePlugin(request.request);
            const removalIndex = vi.isMockFunction(audioApi.removePlugin) ? vi.mocked(audioApi.removePlugin).mock.calls.length : 0;
            plugins.push({ id: plugin.id, name: plugin.name, path: request.request.path,
                enabled: !request.request.bypassed, muted: request.request.muted, gain: request.request.gain, removalIndex });
            return { status: 'restored', plugin };
        } catch (error) { return { status: 'failed', message: String(error) }; }
    });
}
