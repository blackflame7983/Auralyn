import { invoke } from "@tauri-apps/api/core";

export interface PresetPlugin {
    path: string;
    name: string;
    vendor: string;
    version: string;
    enabled: boolean;
    muted: boolean;
    gain: number;
    state?: string;
}

export interface Preset {
    name: string;
    plugins: PresetPlugin[];
}

export const presetApi = {
    list: async (): Promise<string[]> => {
        return await invoke("list_presets");
    },
    save: async (name: string, plugins: PresetPlugin[]): Promise<void> => {
        return await invoke("save_preset", { name, plugins });
    },
    load: async (name: string): Promise<Preset> => {
        return await invoke("load_preset", { name });
    },
    delete: async (name: string): Promise<void> => {
        return await invoke("delete_preset", { name });
    }
};
