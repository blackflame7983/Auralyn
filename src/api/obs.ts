import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ObsConfig {
    host: string;
    port: number;
    password?: string;
}

export interface ObsSetupResult {
    created: boolean;
    deviceBound: boolean;
    duplicateMicSources: string[];
}

export type ObsReachStatus = boolean | "unsupported";

export interface ObsAudioReachResult {
    reached: ObsReachStatus;
    peakDb?: number;
}

export const obsApi = {
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
    setupAuralynSource: async (): Promise<ObsSetupResult> => {
        return await invoke("obs_setup_auralyn_source");
    },
    muteSource: async (name: string, muted: boolean): Promise<void> => {
        return await invoke("obs_mute_source", { name, muted });
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
