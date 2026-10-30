import { test as base, expect } from '@playwright/test';

// この層だけがIPCをモックする。実接続試験はe2e/nativeに分離する。
export const test = base.extend<{ transport: void; liveHome: boolean; registeredModes: boolean }>({
    liveHome: [false, { option: true }],
    registeredModes: [true, { option: true }],
    transport: [async ({ page, liveHome, registeredModes }, use) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(({ liveHome, registeredModes }) => {
            const callbacks = new Map<number, (payload: unknown) => void>();
            const listeners = new Map<number, { event: string; handler: number }>();
            let next = 1;
            const unexpected: string[] = [];
            Object.assign(window, { __e2eUnexpected: unexpected, __e2eEmit: (event: string, payload: unknown) => {
                listeners.forEach((listener, id) => {
                    if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
                });
            } });
            const mic = { name: liveHome ? 'CABLE Output' : 'Test microphone', host: 'WASAPI', is_input: true, index: 0, channels: 2, is_default: true, id: 'mic' };
            const output = { ...mic, name: liveHome ? 'スピーカー' : 'Test headphones', is_input: false, id: 'headphones' };
            // 登録済みモードとミュート表示を含め、実Tauriで重なった本番帯を再現する。
            const builtin = { active: false, preset: 'broadcast', amount: 0.7, singing: null, reverb: { enabled: false, mix: 0.08, decaySeconds: 1.2, damping: 0.5 } };
            let definitions = { schemaVersion: 1, version: '1', singing: liveHome && registeredModes ? builtin : null, talk: liveHome && registeredModes ? builtin : null };
            const modeWrites: unknown[] = [];
            let outputMuted = true;
            Object.assign(window, { __e2eSetOutputMuted: (muted: boolean) => {
                outputMuted = muted;
                window.dispatchEvent(new Event('preparation-external-change'));
            } });
            Object.assign(window, { __e2eModeWrites: modeWrites });
            const invoke = async (command: string, args: Record<string, any> = {}) => {
                if (liveHome && command === 'live_output') return { config: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
                switch (command) {
                    case 'temporary_session_status': return { temporary: false, reviewOnly: false, directory: null };
                    case 'migration_bootstrap': return { reviewRequired: false, ui: null };
                    case 'begin_display_locale_session': return 1;
                    case 'set_display_locale': return true;
                    case 'audio_frontend_bootstrap': return { outcome: 'inactive', initialPage: true, error: null };
                    case 'get_audio_state': return { is_running: true, config: liveHome ? { host: 'WASAPI', input: mic.name, output: output.name, sample_rate: 48000, buffer_size: 512 } : null };
                    case 'get_audio_devices': return { inputs: [mic], outputs: [output] };
                    case 'session_rack':
                        if (args.request.action === 'retain' && args.request.ids.length === 0 && args.request.inputGain === null) return { status: 'finished' };
                        if (args.request.action !== 'snapshot') { unexpected.push(command); throw new Error('空ラックの確認以外は実行しません'); }
                        return { status: 'snapshot', generation: '1', revision: '1', running: liveHome, present: false, restoreEligible: true, plugins: [] };
                    case 'auto_gain': return { revision: 1, gain: 1, confirmedGain: 1, settled: true, running: liveHome, streamFailed: false, phase: 'idle', id: null, playing: false, devices: [] };
                    case 'get_plugins': case 'list_presets': case 'list_profiles': return [];
                    case 'get_engine_runtime_stats': return { activePluginCount: 0, enabledPluginCount: 0, pendingUnloadCount: 0, burnedLibraryCount: 0, maxJitterUs: 0, glitchCount: 0, totalPluginLatencyMs: 0, totalChainLatencyMs: 0, globalBypass: false, ...(liveHome ? { preparation: { engineEpoch: '1', processingRevision: '1', routingRevision: '1', outputRevision: '1', inputGain: 1, inputChannels: [0, 1], outputGain: 1, muted: outputMuted, controlsPending: false, nrBackend: 'nnnoiseless', nrModel: 'bundled' }, queueDiagnostics: { state: 'running', epoch: '1' }, latencyMetadata: { schemaVersion: 1, processingContext: 'monitor', streamEpoch: '1', streamRunning: true, stageBreakdown: { schemaVersion: 1, current: true, queryBasis: 'queriedAtRuntimeStats', streamEpoch: '1', nr: { enabled: false }, builtinVoiceEnabled: false, builtinReverbEnabled: false, globalBypass: false, vst: [] } } } : {}) };
                    case 'builtin_effects':
                        if (args.request.action !== 'snapshot') { unexpected.push(command); throw new Error('登録導線の試験では音を変更しません'); }
                        return { epoch: '1', revision: '1', appliedRevision: '1', config: builtin, pending: false, undoToken: null, error: null };
                    case 'peak_protection':
                        if (args.config != null) { unexpected.push(command); throw new Error('この試験ではピーク保護を変更しません'); }
                        return { config: { enabled: false, ceilingDb: -1, releaseMs: 100 }, running: liveHome, pending: false, revision: '1', reductionDb: 0, addedLatencySamples: 0 };
                    case 'live_modes':
                        if (args.request.action === 'save') {
                            if (args.request.expectedVersion !== definitions.version) throw new Error('登録内容のバージョン不一致');
                            modeWrites.push(args.request);
                            definitions = { ...definitions, version: String(Number(definitions.version) + 1), singing: args.request.singing, talk: args.request.talk };
                        } else if (args.request.action !== 'snapshot') { unexpected.push(command); throw new Error('この試験では本番モードを切り替えません'); }
                        return { epoch: '1', running: liveHome, revision: '1', acceptedRevision: '1', completedRevision: '1', target: null, applied: null, phase: liveHome ? 'custom' : 'stopped', armed: false, naturalTail: false, error: null, definitions };
                    case 'broadcast_bundle': return args.request.action === 'recovery_status' ? { type: 'recovery', value: null } : { type: 'names', value: [] };
                    case 'get_autostart_status': return { enabled: false, canChange: false, reason: null };
                    case 'get_engine_tuning_config': return { enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false };
                    case 'get_shortcuts': return { bindings: [], errors: [] };
                    case 'obs_connection_status': return false;
                    case 'obs_live_scene_status': return { connected: false, connectionGeneration: 0, sequence: 0 };
                    case 'set_loudness_measurement':
                        if (args.id !== null) throw new Error('この画面試験では音声測定を開始しません');
                        return;
                    case 'has_backup_profile': return false;
                    case 'get_distribution': return 'standalone';
                    case 'plugin:event|listen': {
                        const id = next++;
                        listeners.set(id, { event: args.event, handler: args.handler });
                        return id;
                    }
                    case 'plugin:event|unlisten': listeners.delete(args.eventId); return;
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
        }, { liveHome, registeredModes });
        await use();
        const unexpected = await page.evaluate(() => (window as any).__e2eUnexpected);
        expect(unexpected, '未定義IPCを成功した応答で隠さない').toEqual([]);
        expect(errors, '画面の実行時例外').toEqual([]);
    }, { auto: true }],
});
export { expect };
