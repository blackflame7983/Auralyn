import { invoke } from "@tauri-apps/api/core";

export interface AudioDevice {
    name: string;
    host: string;
    is_input: boolean;
    index: number;
    is_default: boolean;
    buffer_size_range?: [number, number];
    channels: number;
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

export const audioApi = {
    getDevices: async (forceRefresh: boolean = false): Promise<AudioDeviceList> => {
        return await invoke("get_audio_devices", { forceRefresh });
    },
    start: async (host?: string, input?: string, output?: string, bufferSize?: number, sampleRate?: number): Promise<AudioConfig> => {
        return await invoke("start_audio", {
            host,
            input,
            output,
            bufferSize,
            sampleRate
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
    restart: async (host?: string, input?: string, output?: string, bufferSize?: number, sampleRate?: number): Promise<AudioConfig> => {
        return await invoke("restart_audio_engine", {
            host,
            input,
            output,
            bufferSize,
            sampleRate
        });
    },
    openEditor: async (id: string) => {
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
    }
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
