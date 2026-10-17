import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ObsConfig {
    host: string;
    port: number;
    password?: string;
}

export interface ObsChange {
    source: string;
    label: string;
    before: unknown;
    after: unknown;
    beforeDisplay?: string | null;
    afterDisplay?: string | null;
}

export interface ObsSetupPlan {
    id: number;
    supported: boolean;
    message: string;
    changes: ObsChange[];
    duplicateMicSources: string[];
}

export interface ObsSetupHistory {
    id: number;
    changes: ObsChange[];
    results: string[];
}

export type ObsReachStatus = boolean | "unsupported";

export interface ObsAudioReachResult {
    reached: ObsReachStatus;
    peakDb?: number;
}

export const obsApi = {
    connectionStatus: async (): Promise<boolean> => {
        return await invoke("obs_connection_status");
    },
    connect: async (config: ObsConfig): Promise<void> => {
        return await invoke("connect_obs", {
            host: config.host,
            port: config.port,
            password: config.password || null
        });
    },
    disconnect: async (): Promise<void> => {
        return await invoke("disconnect_obs");
    },
    previewSetup: async (muteSource?: string): Promise<ObsSetupPlan> => {
        return await invoke("obs_preview_setup", { muteSource: muteSource ?? null });
    },
    applySetup: async (id: number): Promise<ObsSetupHistory> => {
        return await invoke("obs_apply_setup", { id });
    },
    setupHistory: async (): Promise<ObsSetupHistory[]> => {
        return await invoke("obs_setup_history");
    },
    restoreSetup: async (id: number): Promise<ObsSetupHistory> => {
        return await invoke("obs_restore_setup", { id });
    },
    checkAudioReach: async (durationMs = 1500): Promise<ObsAudioReachResult> => {
        return await invoke("obs_check_audio_reach", { durationMs });
    },
    onSceneChanged: (callback: (sceneName: string) => void) => {
        return listen<{ scene_name: string }>("obs://scene-changed", (event) => {
            callback(event.payload.scene_name);
        });
    }
};
