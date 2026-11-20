// ブラウザ画面試験（e2e/browser）と開発プレビュー（?mock=）が共有する Tauri IPC の模擬応答。
// Playwright の addInitScript は関数を文字列化して渡すため、この関数は外側の変数・import を参照しない。
// 実接続の試験は e2e/native に分離する。本番ビルドからは参照しない。
export type MockDeviceSet = 'legacy' | 'realistic';

// 評価用の機器名。installTauriMock は addInitScript で文字列化されるため、関数の外を参照できない。
// 関数本体の同じ文字列と、この定数がずれていないことは src/dev/__tests__/tauriMock.test.ts で見る。
export const realisticDeviceNames = {
    streamInput: 'Yeti Stereo Microphone',
    musicInput: 'CABLE Output (VB-Audio Virtual Cable)',
    streamOutput: 'CABLE Input (VB-Audio Virtual Cable)',
    musicOutput: 'USB Headphones',
} as const;

export function realisticAudioConfig(purpose: 'voice' | 'music') {
    return JSON.stringify({
        host: 'WASAPI',
        input: purpose === 'music' ? realisticDeviceNames.musicInput : realisticDeviceNames.streamInput,
        output: purpose === 'music' ? realisticDeviceNames.musicOutput : realisticDeviceNames.streamOutput,
        sampleRate: 48000,
        bufferSize: 512,
        // ホームの表示（?purpose=）と入力の用途をそろえる。保存値に無いと声になり、音楽鑑賞で不一致の案内が出る。
        inputSource: { kind: 'device', config: { purpose } },
    });
}

export interface TauriMockOptions {
    liveHome: boolean;
    stoppedHome: boolean;
    registeredModes: boolean;
    builtinEnabled: boolean;
    nativeMeterProfile: boolean;
    // 省いたときは legacy。既存のブラウザ試験が期待する CABLE Output / スピーカーのままにする。
    devices?: MockDeviceSet;
    // true: 未定義の IPC を失敗させる（試験）。false: 記録して null を返す（プレビュー）。
    strict: boolean;
}

export function installTauriMock({ liveHome, stoppedHome, registeredModes, builtinEnabled, nativeMeterProfile, strict, devices = 'legacy' }: TauriMockOptions) {
    const callbacks = new Map<number, (payload: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let next = 1;
    const unexpected: string[] = [];
    Object.assign(window, { __e2eUnexpected: unexpected, __e2eEmit: (event: string, payload: unknown) => {
        listeners.forEach((listener, id) => {
            if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
        });
    } });
    // devices を省いた呼び出しは、既存試験と同じく入力と出力を1台ずつ返す。
    const legacyInput = { name: liveHome ? 'CABLE Output' : 'Test microphone', host: 'WASAPI', is_input: true, index: 0, channels: 2, is_default: true, id: 'mic' };
    const legacyOutput = { ...legacyInput, name: liveHome ? 'スピーカー' : 'Test headphones', is_input: false, id: 'headphones' };
    const realisticInputs = [
        { name: 'Yeti Stereo Microphone', host: 'WASAPI', is_input: true, index: 0, channels: 2, is_default: true, id: 'yeti' },
        { name: 'CABLE Output (VB-Audio Virtual Cable)', host: 'WASAPI', is_input: true, index: 1, channels: 2, is_default: false, id: 'cable-output' },
    ];
    const realisticOutputs = [
        { name: 'CABLE Input (VB-Audio Virtual Cable)', host: 'WASAPI', is_input: false, index: 0, channels: 2, is_default: false, id: 'cable-input' },
        { name: 'USB Headphones', host: 'WASAPI', is_input: false, index: 1, channels: 2, is_default: true, id: 'usb-headphones' },
    ];
    const savedDeviceName = (side: 'input' | 'output') => {
        try {
            const value: unknown = JSON.parse(localStorage.getItem('vst_host_audio_config') ?? 'null');
            if (typeof value !== 'object' || value === null) return null;
            const name = (value as { input?: unknown; output?: unknown })[side];
            return typeof name === 'string' ? name : null;
        } catch {
            return null;
        }
    };
    const audioRoute = () => {
        if (devices !== 'realistic') return { inputs: [legacyInput], outputs: [legacyOutput], input: legacyInput, output: legacyOutput };
        const streamInput = realisticInputs[0];
        const streamOutput = realisticOutputs[0];
        const input = realisticInputs.find(device => device.name === savedDeviceName('input')) ?? streamInput;
        const output = realisticOutputs.find(device => device.name === savedDeviceName('output')) ?? streamOutput;
        return { inputs: realisticInputs, outputs: realisticOutputs, input, output };
    };
    // 登録済みモードとミュート表示を含め、実Tauriで重なった本番帯を再現する。
    const builtin = { active: builtinEnabled, preset: 'broadcast', amount: 0.7, singing: null, reverb: { enabled: false, mix: 0.08, decaySeconds: 1.2, damping: 0.5 } };
    let definitions: { schemaVersion: number; version: string; singing: unknown; talk: unknown } = { schemaVersion: 1, version: '1', singing: liveHome && registeredModes ? builtin : null, talk: liveHome && registeredModes ? builtin : null };
    const modeWrites: unknown[] = [];
    let audioRunning = liveHome && !stoppedHome;
    // 実エンジンと同じく、開始の試行ごとに番号を進め、失敗した試行も番号を使い切る。親（エンジンのプロセス）の番号は 1 に固定する。
    // レベルと停止の「終わった音声」には、最後に動き始めた試行の番号を使う（失敗した試行の番号は使わない）。
    let streamAttempt = audioRunning ? 1 : 0;
    let liveAttempt = audioRunning ? 1 : 0;
    const label = (attempt: number) => `1:${attempt}`;
    const streamGeneration = () => (streamAttempt > 0 ? { stream_generation: label(streamAttempt) } : {});
    const liveGeneration = () => (audioRunning && liveAttempt > 0 ? { stream_generation: label(liveAttempt) } : {});
    const starts: unknown[] = [];
    const quits: unknown[] = [];
    Object.assign(window, { __e2eStarts: starts, __e2eQuits: quits });
    let outputMuted = true;
    let outputGain = 1;
    // 実エンジンは、ミュート・音量の変更が音声スレッドに取り込まれるまでの短い間、統計で controlsPending を真にする。
    let pendingStatsLeft = 0;
    const takePendingStats = () => { if (pendingStatsLeft <= 0) return false; pendingStatsLeft -= 1; return true; };
    Object.assign(window, { __e2ePendControls: (reads: number) => { pendingStatsLeft = reads; } });
    const page = window as {
        __e2eSaveFailure?: boolean;
        __e2eStopFailure?: boolean;
        __e2eStartFailure?: boolean;
        __e2eChannelFailure?: boolean;
        __e2eAudioUnknown?: boolean;
        __e2eEmit?: (event: string, payload: unknown) => void;
        __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    const asRecord = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : null);
    const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value as unknown[] : []);
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const saveItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
        if (page.__e2eSaveFailure && key === 'vst_host_audio_config') throw new Error('テスト用: 音声設定の保存失敗');
        return saveItem.call(this, key, value);
    };
    const gainWrites: number[] = [];
    // 実エンジンは、実行中に出力音量・ミュートを変えるコマンドの前後で audio-conditions-changed を送る（audio/conditions.rs の dispatch）。
    const notifyCommandChange = (change: () => void) => {
        if (audioRunning) page.__e2eEmit?.('audio-conditions-changed', null);
        change();
        if (audioRunning) page.__e2eEmit?.('audio-conditions-changed', null);
    };
    const setGain = (value: number) => {
        notifyCommandChange(() => { outputGain = value; });
        window.dispatchEvent(new CustomEvent('output-gain-sync', { detail: value * 100 }));
    };
    Object.assign(window, { __e2eOutputGainWrites: gainWrites, __e2eSetOutputGain: setGain });
    // 実エンジンは、緊急ミュートを切り替えると、条件の通知のあとに global-mute-changed を送る（audio.rs の set_global_mute）。準備の画面へ直接は知らせない。
    const setMuted = (muted: boolean) => {
        notifyCommandChange(() => { outputMuted = muted; });
        page.__e2eEmit?.('global-mute-changed', muted);
    };
    Object.assign(window, { __e2eSetOutputMuted: setMuted });
    // 観測を始める前から、その状態だったことにする試験の準備用。実エンジンの通知を送らないので、緊急ミュートの通知の表示も出ない。
    // 遅れを調べる試験では使わず、__e2eSetOutputMuted か実際の操作を使う。
    Object.assign(window, { __e2ePresetOutputMuted: (muted: boolean) => {
        outputMuted = muted;
        window.dispatchEvent(new Event('preparation-external-change'));
    } });
    // 実エンジンは、緊急ミュート中は出力を無音で書いて出力レベルを 0 にし、入力レベルはそのまま送る。ミュートでないときは出力音量を掛けたあとを測る。
    const meterLevels = (level: number) => {
        const out = outputMuted ? 0 : level * outputGain;
        return { input: [level, level], output: [out, out] };
    };
    Object.assign(window, { __e2eMeterLevels: meterLevels, __e2eEmitLevel: (level: number) => page.__e2eEmit?.('audio-level', { ...meterLevels(level), ...liveGeneration() }) });
    Object.assign(window, { __e2eModeWrites: modeWrites });
    const openedUrls: string[] = [];
    Object.assign(window, { __e2eOpenedUrls: openedUrls });
    const invoke = async (command: string, args: Record<string, unknown> = {}) => {
        const request = () => asRecord(args.request);
        const action = () => text(request()?.action);
        // 計測Host自身の窓の観測・配置は実WebView2へ渡す。音声操作はモックのままにする。
        if (nativeMeterProfile && ['outer_position', 'inner_size', 'outer_size', 'scale_factor', 'is_maximized', 'is_minimized', 'available_monitors', 'set_position', 'set_size', 'set_min_size', 'maximize', 'unmaximize'].some(name => command === `plugin:window|${name}`)) {
            const internals = page.__TAURI_INTERNALS__;
            if (!internals) throw new Error('計測用の Tauri 内部APIがありません');
            return internals.invoke(command, args);
        }
        if (command === 'mixing' && action() === 'snapshot') return { epoch: 'mix-empty', revision: '0', config: null, savedConfig: null, running: false, error: null, accompaniment: null, primaryClock: null, voicePeak: [0, 0], accompanimentPeak: [0, 0], mixPeak: [0, 0], knownVoiceProcessingFrames: null, pending: false, failed: false };
        if (command === 'post_mix' && action() === 'snapshot') return { epoch: 'post-empty', revision: '0', enabled: false, running: false, savedPlugins: [], plugins: [], restored: false, error: null, transportLatencyFrames: 0, declaredPluginLatencyFrames: null, attached: null, ready: null, failed: null, processedPackets: null, sampleRate: null };
        // 評価用の機器名のときだけ、ボイスチェックの試聴先（出力の候補）を返し、録音前の準備を成功させる。録音・再生は模擬しない。
        if (devices === 'realistic' && command === 'voice_check_preview' && ['open', 'status', 'devices', 'stop', 'close'].includes(action())) {
            return {
                epoch: 'preview', sessionId: request()?.sessionId, operationId: request()?.operationId, recordingId: null,
                state: action() === 'close' ? 'closed' : 'idle', positionMs: 0, durationMs: 0, source: 'processed', loopPlayback: false,
                levelMatch: false, levelMatchAvailable: false, metadata: null, recordingStale: false,
                devices: realisticOutputs.map(({ id, name }) => ({ id, name })), error: null, owner: null, conflict: null,
                levelMatchAttenuationDb: [0, 0], safetyAttenuationDb: 0, candidate: null,
            };
        }
        if (liveHome && command === 'live_output') return { config: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
        switch (command) {
            case 'temporary_session_status': return { temporary: false, reviewOnly: false, directory: null };
            case 'migration_bootstrap': return { reviewRequired: false, ui: null };
            case 'begin_display_locale_session': return 1;
            case 'set_display_locale': return true;
            case 'audio_frontend_bootstrap': return { outcome: 'inactive', initialPage: true, error: null };
            case 'get_saved_audio_config': return null;
            case 'stop_audio': {
                if (page.__e2eStopFailure) throw new Error('テスト用: 音声を止められません');
                const ended = audioRunning && liveAttempt > 0 ? { ended_stream_generation: label(liveAttempt) } : {};
                audioRunning = false;
                page.__e2eEmit?.('audio-stopped', { ...streamGeneration(), ...ended });
                return;
            }
            case 'quit_app': quits.push(0); return;
            case 'start_audio': {
                starts.push(args);
                streamAttempt += 1;
                if (page.__e2eStartFailure) throw new Error('テスト用: 機器が見つかりません');
                audioRunning = true;
                liveAttempt = streamAttempt;
                page.__e2eEmit?.('audio-started', { sample_rate: 48000, buffer_size: 512, ...streamGeneration() });
                const started = audioRoute();
                const routing = asRecord(args.channelRouting);
                return { host: 'WASAPI', input: started.input.name, output: started.output.name, sample_rate: 48000, buffer_size: 512,
                    routing: routing ? { ...routing, inputChannels: routing.inputChannels ?? [0, 1] } : undefined, ...streamGeneration() };
            }
            case 'set_input_channels':
                if (page.__e2eChannelFailure) throw new Error('テスト用: 入力チャンネルの反映失敗');
                return;
            case 'get_audio_state': {
                if (page.__e2eAudioUnknown) throw new Error('テスト用: 状態を取得できません');
                const current = audioRoute();
                return { is_running: true, config: liveHome ? { host: 'WASAPI', input: current.input.name, output: current.output.name, sample_rate: 48000, buffer_size: 512 } : null };
            }
            case 'get_audio_devices': {
                const listed = audioRoute();
                return { inputs: listed.inputs, outputs: listed.outputs };
            }
            case 'session_rack': {
                const previewPlugins = new URLSearchParams(location.search).get('previewPlugins') === '1';
                const current = request();
                const pluginPath = text(asRecord(current?.request)?.path);
                if (previewPlugins && action() === 'begin') return { status: 'ready', token: 'preview' };
                if (previewPlugins && action() === 'add') return { status: 'restored', plugin: { id: pluginPath, name: pluginPath, prepared: true } };
                if (previewPlugins && (action() === 'finish' || action() === 'retain')) return { status: 'finished' };
                if (action() === 'retain' && asList(current?.ids).length === 0 && current?.inputGain === null) return { status: 'finished' };
                if (action() !== 'snapshot') { unexpected.push(command); throw new Error('空ラックの確認以外は実行しません'); }
                return { status: 'snapshot', generation: '1', revision: '1', running: audioRunning, present: false, restoreEligible: true, plugins: [] };
            }
            case 'get_plugin_state':
                if (new URLSearchParams(location.search).get('previewPlugins') === '1') return '';
                unexpected.push(command);
                if (strict) throw new Error(`未定義のテストIPC: ${command}`);
                return null;
            case 'set_global_mute':
                if (typeof args.active === 'boolean') setMuted(args.active);
                return;
            case 'toggle_global_mute':
                setMuted(!outputMuted);
                return;
            case 'set_output_gain':
                if (typeof args.value !== 'number') return;
                notifyCommandChange(() => { outputGain = args.value as number; });
                gainWrites.push(args.value);
                return;
            case 'auto_gain': return { revision: 1, gain: outputGain, confirmedGain: outputGain, settled: true, running: audioRunning, streamFailed: false, phase: 'idle', id: null, playing: false, devices: [] };
            case 'get_plugins': case 'list_presets': case 'list_profiles': return [];
            case 'get_engine_runtime_stats': return { activePluginCount: 0, enabledPluginCount: 0, pendingUnloadCount: 0, burnedLibraryCount: 0, maxJitterUs: 0, glitchCount: 0, totalPluginLatencyMs: 0, totalChainLatencyMs: 0, globalBypass: false, builtInEffectsEnabled: builtinEnabled, builtInEffectsPreset: 'broadcast', builtInEffectsAmount: 0.7, ...(liveHome ? { preparation: { engineEpoch: '1', processingRevision: '1', routingRevision: '1', outputRevision: '1', inputGain: 1, inputChannels: [0, 1], outputGain, muted: outputMuted, controlsPending: takePendingStats(), nrBackend: 'nnnoiseless', nrModel: 'bundled' }, queueDiagnostics: { state: 'running', epoch: '1' }, latencyMetadata: { schemaVersion: 1, processingContext: 'monitor', streamEpoch: '1', streamRunning: audioRunning, stageBreakdown: { schemaVersion: 1, current: true, queryBasis: 'queriedAtRuntimeStats', streamEpoch: '1', nr: { enabled: false }, builtinVoiceEnabled: builtinEnabled, builtinReverbEnabled: false, globalBypass: false, vst: [] } } } : {}) };
            case 'builtin_effects':
                if (action() !== 'snapshot') { unexpected.push(command); throw new Error('登録導線の試験では音を変更しません'); }
                return { epoch: '1', revision: '1', appliedRevision: '1', config: builtin, pending: false, undoToken: null, error: null };
            case 'peak_protection':
                if (args.config != null) { unexpected.push(command); throw new Error('この試験ではピーク保護を変更しません'); }
                return { config: { enabled: false, ceilingDb: -1, releaseMs: 100 }, running: audioRunning, pending: false, revision: '1', reductionDb: 0, addedLatencySamples: 0 };
            case 'broadcast_true_peak':
                if (args.config != null) { unexpected.push(command); throw new Error('この試験では配信用 true-peak 制限を変更しません'); }
                return { config: { enabled: false, ceilingDb: -1, releaseMs: 100 }, running: audioRunning, pending: false, applied: false, revision: '1', reductionDb: 0, addedLatencySamples: 0 };
            case 'live_modes': {
                const current = request();
                if (action() === 'save') {
                    if (current?.expectedVersion !== definitions.version) throw new Error('登録内容のバージョン不一致');
                    modeWrites.push(args.request);
                    definitions = { ...definitions, version: String(Number(definitions.version) + 1), singing: current?.singing ?? null, talk: current?.talk ?? null };
                } else if (action() !== 'snapshot') { unexpected.push(command); throw new Error('この試験では本番モードを切り替えません'); }
                return { epoch: '1', running: audioRunning, revision: '1', acceptedRevision: '1', completedRevision: '1', target: null, applied: null, phase: liveHome ? 'custom' : 'stopped', armed: false, naturalTail: false, error: null, definitions };
            }
            case 'broadcast_bundle': return action() === 'recovery_status' ? { type: 'recovery', value: null } : { type: 'names', value: [] };
            case 'get_autostart_status': return { enabled: false, canChange: false, reason: null };
            case 'get_engine_tuning_config': return { enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false };
            case 'plugin:opener|open_url':
                if (typeof args.url === 'string') openedUrls.push(args.url);
                return;
            case 'get_shortcuts': return { bindings: [], errors: [] };
            // 音のトラブル診断を閉じるときの後始末。鳴らしていない試験音の停止は何もしない。
            case 'stop_test_tone': return;
            case 'obs_connection_status': return false;
            // OBS を使う画面を閉じたときの切断。未接続の模擬では何もしない。
            case 'disconnect_obs': return;
            case 'get_obs_credentials': return null;
            // 履歴がない状態。null のままだと設定の OBS タブが件数参照で画面全体を落とす。
            case 'obs_setup_history': return [];
            case 'scan_plugin_catalog': {
                if (new URLSearchParams(location.search).get('previewScanError') === '1') throw new Error('一覧を取れませんでした');
                const extra = asList(args.extraRoots).filter((item): item is string => typeof item === 'string');
                const showExtra = new URLSearchParams(location.search).get('previewScanFolders') === '1';
                const plugins = showExtra ? extra.filter(path => !/missing/i.test(path)).map((path, index) => ({
                    name: 'Room', path: `${path.replace(/[\\/]+$/, '')}\\Room.vst3`, vendor: 'Example', category: 'Fx|Delay', version: '1', id: `extra-${index}`,
                })) : [];
                const skippedRoots = showExtra ? extra.filter(path => /missing/i.test(path)).map(path => ({ path, reason: 'missing' })) : [];
                return { plugins, failures: [], stats: { reused: 0, scanned: plugins.length, removed: 0 }, generation: 1, recoveredFromCorrupt: false, saveError: null, skippedRoots };
            }
            case 'retry_plugin_scan': return { plugins: [], failures: [], stats: { reused: 0, scanned: 0, removed: 0 }, generation: 1, recoveredFromCorrupt: false, saveError: null, skippedRoots: [] };
            case 'get_window_activity': return true;
            case 'obs_live_scene_status': return { connected: false, connectionGeneration: 0, sequence: 0 };
            case 'set_loudness_measurement':
                if (args.id !== null) throw new Error('この画面試験では音声測定を開始しません');
                return;
            case 'has_backup_profile': return false;
            case 'get_distribution': return 'standalone';
            case 'plugin:event|listen': {
                if (typeof args.event !== 'string' || typeof args.handler !== 'number') return;
                const id = next++;
                listeners.set(id, { event: args.event, handler: args.handler });
                return id;
            }
            case 'plugin:event|unlisten':
                if (typeof args.eventId === 'number') listeners.delete(args.eventId);
                return;
            case 'plugin:window|set_theme':
            case 'plugin:window|set_min_size': return;
            default:
                unexpected.push(command);
                if (strict) throw new Error(`未定義のテストIPC: ${command}`);
                return null;
        }
    };
    // WebView2のTauri内部APIは読み取り専用。計測ビルド専用のcoreラッパーへ渡す。
    Object.assign(window, nativeMeterProfile ? { __meterProfileInternals: {
        invoke, transformCallback: (callback: (payload: unknown) => void) => { const id = next++; callbacks.set(id, callback); return id; },
        unregisterCallback: (id: number) => callbacks.delete(id),
    } } : {
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
}
