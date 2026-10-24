import { invoke } from '@tauri-apps/api/core';

export interface ObsLiveSceneStatus { connected: boolean; connectionGeneration: number; sequence: number }
export interface ObsLiveSceneEvent { sceneName: string; connectionGeneration: number; sequence: number }
import { listen } from '@tauri-apps/api/event';

export interface ObsConfig {
    host: string;
    port: number;
    password?: string;
}

export interface ObsUiText { code: string; args: Record<string, string | number | boolean>; fallbackJa: string }
export type ObsOutcome = 'notRun' | 'applied' | 'conflict' | 'applyUnknown' | 'restoreDeferred' | 'restoreUnknown' | 'restored' | 'alreadyOriginal' | 'restoreFailed';
export interface ObsResultEntry { outcome: ObsOutcome; text: ObsUiText }
export interface ObsTypedChange { fieldCode?: string | null; labelText?: ObsUiText | null; beforeText?: ObsUiText | null; afterText?: ObsUiText | null }
export interface ObsChange extends ObsTypedChange {
    source: string;
    label: string;
    before: unknown;
    after: unknown;
    beforeDisplay?: string | null;
    afterDisplay?: string | null;
}

export interface ObsTimingTarget { targetToken: string; source: string; currentOffsetMs: number }
export interface ObsTimingTargets { supported: boolean; message: string; targets: ObsTimingTarget[] }
export interface ObsTimingMeasurement {
    method: 'manual'; comparison: 'voiceAccompaniment' | 'audioVideo'; measuredDelayMs: number;
    referenceNote: string; fps: number | null; track: number | null;
}
export interface ObsTimingRequest { targetToken: string; additionalDelayMs: number; measurement: ObsTimingMeasurement }
export interface ObsTimingMetadata {
    targetToken: string; source: string; currentOffsetMs: number; additionalDelayMs: number;
    resultOffsetMs: number; measurement: ObsTimingMeasurement;
}

export interface ObsSetupPlan {
    id: number;
    supported: boolean;
    message: string;
    messageText?: ObsUiText | null;
    changes: ObsChange[];
    duplicateMicSources: string[];
    timing?: ObsTimingMetadata | null;
}

export interface ObsSetupHistory {
    restorable?: boolean;
    connectionLabel?: string;
    id: number;
    changes: ObsChange[];
    results: string[];
    resultEntries?: ObsResultEntry[] | null;
    timing?: ObsTimingMetadata | null;
}

export type ObsReachStatus = boolean | 'unsupported';

export interface ObsReachVerification {
    operationId: string;
    checkedAtUnixMs: number;
    source: string;
    connectionGeneration: number;
    setupGeneration: number;
    sourceGeneration: number;
    targetSettingsGeneration: number;
    audioEngineEpoch: number;
    audioConditionsRevision: number;
    config: { host: string; input?: string | null; output?: string | null; sample_rate?: number | null; buffer_size?: number | null } | null;
}

export interface ObsAudioReachResult {
    reached: ObsReachStatus;
    peakDb?: number;
    verification?: ObsReachVerification | null;
}

// 画面を閉じた時の切断を、接続中の要求より後に適用する。
let connectionCommands = Promise.resolve();
function connectionCommand<T>(action: () => Promise<T>) {
    const request = connectionCommands.then(action);
    connectionCommands = request.then(
        () => {},
        () => {},
    );
    return request;
}

export const obsApi = {
    connectionStatus: async (): Promise<boolean> => {
        return await connectionCommand(() => invoke('obs_connection_status'));
    },
    connect: async (config: ObsConfig): Promise<void> => {
        return await connectionCommand(() =>
            invoke('connect_obs', {
                host: config.host,
                port: config.port,
                password: config.password || null,
            }),
        );
    },
    disconnect: async (): Promise<void> => {
        return await connectionCommand(() => invoke('disconnect_obs'));
    },
    timingTargets: async (): Promise<ObsTimingTargets> => invoke('obs_timing_targets'),
    previewTiming: async (request: ObsTimingRequest): Promise<ObsSetupPlan> => invoke('obs_preview_timing', { request }),
    previewSetup: async (muteSource?: string): Promise<ObsSetupPlan> => {
        return await invoke('obs_preview_setup', { muteSource: muteSource ?? null });
    },
    applySetup: async (id: number): Promise<ObsSetupHistory> => {
        return await invoke('obs_apply_setup', { id });
    },
    setupHistory: async (): Promise<ObsSetupHistory[]> => {
        return await invoke('obs_setup_history');
    },
    forgetHistory: async (id: number): Promise<void> => {
        return await invoke('obs_forget_setup_history', { id });
    },
    restoreSetup: async (id: number): Promise<ObsSetupHistory> => {
        return await invoke('obs_restore_setup', { id });
    },
    checkAudioReach: async (durationMs = 1500): Promise<ObsAudioReachResult> => {
        return await invoke('obs_check_audio_reach', { durationMs });
    },
    audioReachCurrent: (operationId: string): Promise<boolean> => invoke('obs_audio_reach_current', { operationId }),
    liveSceneStatus: (): Promise<ObsLiveSceneStatus> => invoke('obs_live_scene_status'),
    onLiveSceneChanged: (callback: (event: ObsLiveSceneEvent) => void) => listen<ObsLiveSceneEvent>('obs://live-scene-changed', event => callback(event.payload)),
    onLiveSceneInvalidated: (callback: () => void) => listen('obs://live-scene-invalidated', callback),
    onSceneChanged: (callback: (sceneName: string) => void) => {
        return listen<{ scene_name: string }>('obs://scene-changed', (event) => {
            callback(event.payload.scene_name);
        });
    },
};
