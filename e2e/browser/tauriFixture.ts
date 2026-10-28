import { test as base, expect } from '@playwright/test';

// この層だけがIPCをモックする。実接続試験はe2e/nativeに分離する。
export const test = base.extend<{ transport: void }>({
    transport: [async ({ page }, use) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            const callbacks = new Map<number, (payload: unknown) => void>();
            let next = 1;
            const unexpected: string[] = [];
            Object.assign(window, { __e2eUnexpected: unexpected });
            const mic = { name: 'Test microphone', host: 'WASAPI', is_input: true, index: 0, channels: 2, is_default: true, id: 'mic' };
            const output = { ...mic, name: 'Test headphones', is_input: false, id: 'headphones' };
            const invoke = async (command: string, args: Record<string, any> = {}) => {
                switch (command) {
                    case 'temporary_session_status': return { temporary: false, reviewOnly: false, directory: null };
                    case 'migration_bootstrap': return { reviewRequired: false, ui: null };
                    case 'begin_display_locale_session': return 1;
                    case 'set_display_locale': return true;
                    case 'audio_frontend_bootstrap': return { outcome: 'inactive', initialPage: true, error: null };
                    case 'get_audio_state': return { is_running: true, config: null };
                    case 'get_audio_devices': return { inputs: [mic], outputs: [output] };
                    case 'session_rack': return { status: 'snapshot', generation: '1', revision: '1', running: false, present: false, restoreEligible: false, plugins: [] };
                    case 'auto_gain': return { revision: 1, gain: 1, confirmedGain: 1, settled: true, running: false, streamFailed: false, phase: 'idle', id: null, playing: false, devices: [] };
                    case 'get_plugins': case 'list_presets': case 'list_profiles': return [];
                    case 'get_engine_runtime_stats': return { activePluginCount: 0, enabledPluginCount: 0, pendingUnloadCount: 0, burnedLibraryCount: 0, maxJitterUs: 0, glitchCount: 0, totalPluginLatencyMs: 0, totalChainLatencyMs: 0, globalBypass: false };
                    case 'live_modes': return { epoch: '1', running: false, revision: '1', acceptedRevision: '1', completedRevision: '1', target: null, applied: null, phase: 'stopped', armed: false, naturalTail: false, error: null, definitions: { schemaVersion: 1, version: '1', singing: null, talk: null } };
                    case 'broadcast_bundle': return args.request.action === 'recovery_status' ? { type: 'recovery', value: null } : { type: 'names', value: [] };
                    case 'get_autostart_status': return { enabled: false, canChange: false, reason: null };
                    case 'get_engine_tuning_config': return { enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false };
                    case 'get_shortcuts': return { enabled: false, bindings: [] };
                    case 'obs_connection_status': return false;
                    case 'obs_live_scene_status': return { connected: false, connectionGeneration: 0, sequence: 0 };
                    case 'set_loudness_measurement':
                        if (args.id !== null) throw new Error('この画面試験では音声測定を開始しません');
                        return;
                    case 'has_backup_profile': return false;
                    case 'get_distribution': return 'standalone';
                    case 'plugin:event|listen': return next++;
                    case 'plugin:event|unlisten':
                    case 'plugin:window|set_theme':
                    case 'plugin:window|set_min_size': return;
                    default: unexpected.push(command); throw new Error(`未定義のテストIPC: ${command}`);
                }
            };
            Object.assign(window, {
                __TAURI_INTERNALS__: {
                    invoke,
                    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
                    transformCallback: (callback: (payload: unknown) => void) => { const id = next++; callbacks.set(id, callback); return id; },
                    unregisterCallback: (id: number) => callbacks.delete(id),
                },
                __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
            });
            localStorage.setItem('vst_host_tutorial_completed', 'true');
            localStorage.setItem('vst_host_update_policy', JSON.stringify({ automatic: false, download: false }));
        });
        await use();
        const unexpected = await page.evaluate(() => (window as any).__e2eUnexpected);
        expect(unexpected, '未定義IPCを成功した応答で隠さない').toEqual([]);
        expect(errors, '画面の実行時例外').toEqual([]);
    }, { auto: true }],
});
export { expect };
