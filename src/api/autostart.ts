import { invoke } from "@tauri-apps/api/core";

export interface AutostartStatus {
    enabled: boolean;
    method: string;
    canChange: boolean;
    reason?: string | null;
}

export const autostartApi = {
    getStatus: async (): Promise<AutostartStatus> => {
        return await invoke<AutostartStatus>("get_autostart_status");
    },

    setEnabled: async (enabled: boolean): Promise<void> => {
        return await invoke("set_autostart_enabled", { enabled });
    }
};
