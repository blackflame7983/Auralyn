import { invoke } from "@tauri-apps/api/core";

export interface AudioDevice {
    name: string;
    host: string;
    is_input: boolean;
    index: number;
    is_default: boolean;
    buffer_size_range?: [number, number];
    channels: number;
    id?: string;
}

export interface AudioDeviceList {
    inputs: AudioDevice[];
    outputs: AudioDevice[];
}

export interface VstPlugin {
    name: string;
    path: string;
    vendor: string;
    category: string;
    version: string;
    id: string;
}

export interface AudioConfig {
    sample_rate: number;
    buffer_size: number;
    channels: number;
}
export interface FrontendBootstrapRequest {
    config: { host: string; input?: string; output?: string; sampleRate?: number; bufferSize?: number; inputChannels?: [number, number] } | null;
    inputGain: number;
    outputGain: number;
}
export interface FrontendBootstrapReply {
    outcome: 'started' | 'attached' | 'inactive';
    initialPage: boolean;
    error: string | null;
}

export interface RackPlugin {
    id: string; path: string; name: string; enabled: boolean; muted: boolean; gain: number;
}
export type SessionRackRequest = { action: 'snapshot' }
    | { action: 'retain'; generation: string; revision: string; ids: string[]; inputGain: number | null }
    | { action: 'begin'; generation: string; revision: string; ids: string[]; inputGain: number; outputGain: number; explicit?: boolean }
    | { action: 'add'; token: string; request: RestorePluginRequest }
    | { action: 'finish'; token: string };
export type SessionRackReply = { status: 'snapshot'; generation: string; revision: string; running: boolean; present: boolean; restoreEligible: boolean; plugins: RackPlugin[] }
    | { status: 'ready'; token: string; generation: string }
    | { status: 'restored'; plugin: RestoredPlugin }
    | { status: 'finished' | 'busy' | 'conflict' }
    | { status: 'failed'; message: string };

export const audioApi = {
    frontendBootstrap: async (request: FrontendBootstrapRequest): Promise<FrontendBootstrapReply> => invoke('audio_frontend_bootstrap', { request }),
    sessionRack: async (request: SessionRackRequest): Promise<SessionRackReply> => invoke('session_rack', { request }),
    // 既存の状態取得コマンドで実ストリームを確認する。プロセスの常駐とは区別する。
    getAudioStreamState: async (): Promise<{ running: boolean; streamFailed: boolean }> =>
        invoke('auto_gain', { request: { action: 'status' } }),
    setLoudnessMeasurement: async (id: number | null): Promise<void> =>
        invoke('set_loudness_measurement', { id }),
    getDevices: async (forceRefresh: boolean = false): Promise<AudioDeviceList> => {
        return await invoke("get_audio_devices", { forceRefresh });
    },
    start: async (host?: string, input?: string, output?: string, bufferSize?: number, sampleRate?: number, inputId?: string, outputId?: string): Promise<AudioConfig> => {
        return await invoke("start_audio", {
            host,
            input,
            output,
            bufferSize,
            sampleRate,
            inputId,
            outputId
        });
    },
    stop: async () => {
        return await invoke("stop_audio");
    },
    scanPlugins: async (): Promise<VstPlugin[]> => {
        return await invoke("scan_plugins");
    },
    clearBlacklist: async (): Promise<void> => {
        return await invoke("clear_blacklist");
    },
    restorePlugin: async (request: RestorePluginRequest): Promise<RestoredPlugin> => invoke('restore_plugin', { request }),
    loadPlugin: async (path: string): Promise<string> => {
        return await invoke("load_plugin", { path });
    },
    removePlugin: async (id: string) => {
        return await invoke("remove_plugin", { id });
    },
    reorderPlugins: async (order: string[]) => {
        return await invoke("reorder_plugins", { order });
    },
    setBypass: async (id: string, active: boolean) => {
        return await invoke("set_bypass", { id, active });
    },
    setMute: async (id: string, active: boolean) => {
        return await invoke("set_mute", { id, active });
    },
    setGain: async (id: string, value: number) => {
        return await invoke("set_gain", { id, value });
    },
    restart: async (host?: string, input?: string, output?: string, bufferSize?: number, sampleRate?: number, inputId?: string, outputId?: string): Promise<AudioConfig> => {
        return await invoke("restart_audio_engine", {
            host,
            input,
            output,
            bufferSize,
            sampleRate,
            inputId,
            outputId
        });
    },
    openEditor: async (id: string) => {
        window.dispatchEvent(new Event('preparation-external-change'));
        return await invoke("open_editor", { id });
    },
    setGlobalMute: async (active: boolean) => {
        return await invoke("set_global_mute", { active });
    },
    toggleGlobalMute: async () => {
        return await invoke("toggle_global_mute");
    },
    setInputGain: async (value: number) => {
        return await invoke("set_input_gain", { value });
    },
    setNoiseReduction: async (active: boolean, mode?: NoiseControlMode) => {
        return await invoke("set_noise_reduction", { active, mode });
    },
    startNoiseLearning: async (durationMs = 3000) => {
        return await invoke("start_noise_learning", { durationMs });
    },
    cancelNoiseLearning: async () => {
        return await invoke("cancel_noise_learning");
    },
    setNoiseControlConfig: async (config: NoiseControlConfig) => {
        return await invoke("set_noise_control_config", {
            active: config.active,
            mode: config.mode,
            strength: config.strength,
            voiceGuard: config.voiceGuard,
        });
    },
    setBuiltInEffects: async (config: BuiltInEffectsConfig) => {
        return await invoke("set_built_in_effects", {
            active: config.active,
            preset: config.preset,
            amount: config.amount,
        });
    },
    setOutputGain: async (value: number) => {
        return await invoke("set_output_gain", { value });
    },
    setGlobalBypass: async (active: boolean) => {
        return await invoke("set_global_bypass", { active });
    },
    getPluginState: async (id: string): Promise<string> => {
        return await invoke("get_plugin_state", { id });
    },
    setPluginState: async (id: string, state: string) => {
        return await invoke("set_plugin_state", { id, state });
    },
    setInputChannels: async (left: number, right: number) => {
        return await invoke("set_input_channels", { left, right });
    },
    setChannelScan: async (active: boolean) => {
        return await invoke("set_channel_scan", { active });
    },
    getAudioState: async (): Promise<AudioStateInfo> => {
        return await invoke("get_audio_state");
    },
    getEngineTuningConfig: async (): Promise<EngineTuningConfig> => {
        return await invoke("get_engine_tuning_config");
    },
    setEngineTuningConfig: async (config: EngineTuningConfig): Promise<void> => {
        return await invoke("set_engine_tuning_config", { config });
    },
    getEngineRuntimeStats: async (): Promise<EngineRuntimeStats> => {
        return await invoke("get_engine_runtime_stats");
    },
    startVoiceCheck: async (maxMs = 10_000) => {
        return await invoke("start_voice_check", { maxMs });
    },
    stopVoiceCheck: async () => {
        return await invoke("stop_voice_check");
    },
    playVoiceCheck: async (source: VoiceCheckSource, loopPlayback = true) => {
        return await invoke("play_voice_check", { source, loopPlayback });
    },
    stopVoiceCheckPlayback: async () => {
        return await invoke("stop_voice_check_playback");
    },
    exportVoiceCheck: async (path: string, source: VoiceCheckSource) => {
        return await invoke("export_voice_check", { path, source });
    },
    exportVoiceCheckWav: async (source: VoiceCheckSource) => {
        return await invoke("export_voice_check_wav", { source });
    },
    analyzeVoiceCheck: async (): Promise<QualityReport> => {
        return await invoke("analyze_voice_check");
    },
    playTestTone: async (freqHz = 1000, durationMs = 1500, levelDb = -20) => {
        return await invoke("play_test_tone", { freqHz, durationMs, levelDb });
    },
    stopTestTone: async () => {
        return await invoke("stop_test_tone");
    },
    probeLoopback: async (
        inputDevice: string,
        durationMs = 1500,
        freqHz = 1000,
    ): Promise<LoopbackProbeResult> => {
        return await invoke("probe_loopback", { inputDevice, durationMs, freqHz });
    },
    getRoutingDiagnostics: async (): Promise<RoutingDiagnosticsReport> => {
        return await invoke("get_routing_diagnostics");
    },
};

export interface ActiveAudioConfig {
    host: string;
    input: string | null;
    output: string | null;
    sample_rate: number | null;
    buffer_size: number | null;
}

export interface AudioStateInfo {
    is_running: boolean;
    config: ActiveAudioConfig | null;
}

export interface EngineTuningConfig {
    enableAffinityPinning: boolean;
    affinityMask: string | null;
    enableRealtimePriority: boolean;
    enableTimeCriticalAudioThreads: boolean;
}

export type NoiseControlMode = 'low' | 'high' | 'smart' | 'venue';
export type BuiltInEffectsPreset = 'broadcast' | 'warm' | 'bright' | 'singing';
export type VoiceCheckSource = 'raw' | 'processed';
export type VoiceCheckStateKind = 'idle' | 'recording' | 'ready' | 'playing' | string;

export interface VoiceCheckState {
    state: VoiceCheckStateKind;
    position_ms: number;
    duration_ms: number;
}

export interface VoiceCheckEnvelope {
    raw_peaks: number[];
    processed_peaks: number[];
}

export type QualityVerdict = 'good' | 'warn' | 'bad';

export interface QualityClipReport {
    count: number;
    ratio: number;
    positionsMs: number[];
}

export interface QualityDropoutReport {
    count: number;
    positionsMs: number[];
}

export interface QualityNoiseFloorDb {
    raw: number;
    processed: number;
}

export interface QualityBandDeltaDb {
    bandHz: number;
    deltaDb: number;
}

export interface QualityLoudnessReport {
    rmsDb: number;
    peakDb: number;
}

export interface QualityAdvice {
    severity: 'info' | 'warn' | 'bad' | string;
    messageKey: string;
    params: Record<string, number | string>;
}

export interface QualityReport {
    clip: QualityClipReport;
    dropouts: QualityDropoutReport;
    noiseFloorDb: QualityNoiseFloorDb;
    snrImprovementDb: number;
    bandDeltaDb: QualityBandDeltaDb[];
    loudness: QualityLoudnessReport;
    verdict: QualityVerdict;
    advices: QualityAdvice[];
}

export interface NoiseControlConfig {
    active: boolean;
    mode: NoiseControlMode;
    strength: number;
    voiceGuard: boolean;
}

export interface BuiltInEffectsConfig {
    active: boolean;
    preset?: BuiltInEffectsPreset;
    amount: number;
}

export interface LoopbackProbeResult {
    detected: boolean;
    levelDb: number;
    unavailable: string | null;
}

export interface RoutingDeviceInfo {
    name: string;
    direction: 'render' | 'capture' | string;
    mixFormatSampleRateHz: number | null;
    isDefault: boolean;
    isDefaultCommunications: boolean;
    isVirtualCable: boolean;
}

export interface SampleRateMismatch {
    deviceName: string;
    deviceRateHz: number;
    engineRateHz: number;
    message: string;
}

export interface RoutingDiagnosticsReport {
    devices: RoutingDeviceInfo[];
    engineSampleRateHz: number | null;
    sampleRateMismatches: SampleRateMismatch[];
    defaultCommsRenderIsVirtual: boolean;
    defaultCommsRenderName: string | null;
    warnings: string[];
}

export interface QueueDiagnosticsSnapshot {
    recoveryDiscardedFrames?: number | null; recoveryCount?: number | null;
    recoveryStatus?: number | null; recoveryTargetFrames?: number | null; recoveryHighFrames?: number | null;
    epoch: string;
    state: 'preparing' | 'running' | 'stopped' | 'failed';
    inputRateHz: number; outputRateHz: number;
    inputChannels: number; outputChannels: number;
    capacitySlots: number; capacityFrames: number; capacityRemainderSlots: number;
    currentSlots: number | null; currentFrames: number | null; currentPartialSlots: number | null;
    currentAudioMs: number | null;
    maxObservedSlots: number; maxObservedFrames: number; maxObservedAudioMs: number | null;
    queuedSlotsAtStop: number | null; queuedFramesAtStop: number | null;
    receivedInputFrames: number; generatedOutputFrames: number; offeredOutputFrames: number;
    acceptedOutputFrames: number; droppedOutputFrames: number;
    requestedOutputFrames: number; consumedOutputFrames: number; zeroFilledOutputFrames: number;
    queueReadCallbacks: number; underflowCallbacks: number;
}

export interface LatencyMetadata {
    broadcastState?: string | null; processingContext?: string | null; streamEpoch?: string | null; comparisonRevision?: string | null;
    schemaVersion: 1; streamRunning: boolean; nominalSampleRateHz: number | null;
    fixedBufferRequestFrames: number | null; nrConfiguredEnabled: boolean;
    nrProcessingRateHz: number | null; nrProcessingFrameSamples: number | null;
    stageBreakdown?: LatencyStageBreakdown | null;
    vstReportedLatencySamples: number; signalCorrespondence: 'unmeasured';
}

export interface LatencyStageBreakdown {
    schemaVersion: 1; queryBasis: 'queriedAtRuntimeStats'; current: boolean; streamEpoch: string | null;
    globalBypass: boolean; vstKnownSubtotalSamples: number | null; vstSubtotalOverflow: boolean;
    vst: { id: string; name: string; state: 'active' | 'bypassed' | 'muted' | 'unavailable'; bypassed: boolean; muted: boolean; declaredSamples: number | null }[];
    nr: { enabled: boolean; configuredRateHz: number | null; frameSamples: number | null; framePeriodMs: number | null; modelRateHz: number; modelFrameSamples: number; signalDelay: 'unknown' };
    builtinVoiceEnabled: boolean; builtinReverbEnabled: boolean; builtinSignalDelay: 'unknown';
}

export interface FrameTimingSnapshot {
    epoch: string; supported: boolean; sealed: boolean; counterInvalid: boolean;
    consumedFrames: number; matchedFrames: number; pendingFrames: number; unknownFrames: number;
    coveragePercent: number | null;
    p50: { lowerMs: number; upperMs: number | null } | null;
    p95: { lowerMs: number; upperMs: number | null } | null;
    histogramResolutionMs: number; observationMs: number;
    inputMetadataDropped: number; outputMetadataDropped: number;
    invalidEvents: number; pendingEvictions: number; overlappingCallbackFrames: number;
    asioCycleClassification: string;
}

// 異率の生成batchが揃ったcallbackからqueue読出完了まで。raw信号の点対応ではない。
export interface ResamplerBatchTimingSnapshot extends FrameTimingSnapshot {
    mode: 'callbackBatchReadiness';
    declaredResampler: {
        inputRateHz: number; outputRateHz: number; inputChunkFrames: number;
        maxOutputChunkFrames: number; declaredOutputDelayFrames: number;
    };
}

// 処理に消費された入力cohortの到着区間。FIR/NR/VSTの信号対応ではない。
export interface TimingDistribution {
    matchedFrames: number;
    earliestArrivalToEnd: { p50: FrameTimingSnapshot['p50']; p95: FrameTimingSnapshot['p95'] };
    latestArrivalToEnd: { p50: FrameTimingSnapshot['p50']; p95: FrameTimingSnapshot['p95'] };
}
export interface ResamplerCohortTimingSnapshot {
    periods?: { windowSeconds: number; updateIntervalMs: number; startupDurationMs: number; startNs: string | null; endNs: string; recent: TimingDistribution; startup: TimingDistribution; steady: TimingDistribution } | null;
    schemaVersion: 1 | 2; epoch: string; mode: 'inputCohortToOutputBufferEnd' | 'sameRateInputToOutputBufferEnd';
    // applied = RT受理・状態反映。gain平滑化／VST内部完了のACKではない。
    windowId?: string; requestedRevision?: string; completedRevision?: string; appliedRevision?: string; rejectedRevision?: string | null; normalMicOutput?: boolean; streamConsumedFrames?: number;
    status: 'collecting' | 'partial' | 'invalid' | 'sealed' | 'unsupported' | 'pending' | 'substituted';
    signalCorrespondence: 'notMeasured';
    geometry: { inputUnitFrames: number; outputUnitFrames: number } | null;
    receivedInputFrames: number; cohortInputFrames: number; unemittedInputFrames: number | null;
    consumedFrames: number; matchedFrames: number; pendingFrames: number; unknownFrames: number;
    zeroFilledFrames: number; coveragePercent: number | null;
    earliestArrivalToEnd: { p50: FrameTimingSnapshot['p50']; p95: FrameTimingSnapshot['p95'] };
    latestArrivalToEnd: { p50: FrameTimingSnapshot['p50']; p95: FrameTimingSnapshot['p95'] };
    invalidReasons: string[];
}

export interface PreparationSnapshot {
    engineEpoch: string; processingRevision: string; routingRevision: string; inputGain: number; inputChannels: [number, number];
    outputGain: number; outputRevision: string; muted: boolean; controlsPending: boolean;
    nrBackend: string; nrModel: string;
}
export interface EngineRuntimeStats {
    preparation?: PreparationSnapshot | null;
    resamplerCohortTiming?: ResamplerCohortTimingSnapshot | null;
    frameTiming?: FrameTimingSnapshot | null;
    resamplerBatchTiming?: ResamplerBatchTimingSnapshot | null;
    latencyMetadata?: LatencyMetadata | null;
    activePluginCount: number;
    enabledPluginCount: number;
    pendingUnloadCount: number;
    burnedLibraryCount: number;
    globalBypass: boolean;
    queueDiagnostics?: QueueDiagnosticsSnapshot | null;
    callbackDiagnostics?: {
        count: number;
        minFrames: number;
        maxFrames: number;
        totalProcessingUs: number;
        maxProcessingUs: number;
    };
    maxJitterUs: number;
    glitchCount: number;
    totalPluginLatencySamples: number;
    totalPluginLatencyMs: number;
    noiseReductionLatencySamples: number;
    noiseReductionLatencyMs: number;
    totalChainLatencySamples: number;
    totalChainLatencyMs: number;
    noiseReductionEnabled: boolean;
    noiseReductionActive: boolean;
    noiseReductionMode: string;
    noiseLearningState: 'idle' | 'capturing' | 'ready' | string;
    noiseLearningProgress: number;
    noiseProfileAvailable: boolean;
    noiseProfileRms: number;
    recommendedNoiseMix: number;
    speechDetected: boolean;
    noiseVoiceGuard: boolean;
    noiseControlStrength: number;
    builtInEffectsEnabled: boolean;
    builtInEffectsPreset: string;
    builtInEffectsAmount: number;
    builtInSinging?: import('./builtinEffects').SingingParams | null;
    builtInReverb?: import('./builtinEffects').ReverbParams | null;
}


export interface RestorePluginRequest {
    path: string;
    state: string | null;
    bypassed: boolean;
    muted: boolean;
    gain: number;
}
// prepared:falseは停止中の復元成功。次回Startで処理準備される。
export interface RestoredPlugin { id: string; name: string; prepared: boolean }
