import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ObsConfig {
    host: string;
    port: number;
    password?: string;
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
    onSceneChanged: (callback: (sceneName: string) => void) => {
        return listen<{ scene_name: string }>("obs://scene-changed", (event) => {
            callback(event.payload.scene_name);
        });
    }
};
