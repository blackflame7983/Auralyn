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

export interface ProfileAudioConfig {
    host: string;
    inputDevice?: string;
    outputDevice?: string;
    sampleRate: number;
    bufferSize: number;
    inputChannels: number[];
    inputGainDb: number;
    masterGainDb: number;
}

export interface ProfileNoiseControl {
    enabled: boolean;
    mode: string;
    strength: number;
    voiceGuard: boolean;
    learnedProfile?: unknown;
}

export interface ProfileBuiltinFx {
    reverb?: import('./builtinEffects').ReverbParams | null;
    singing?: import('./builtinEffects').SingingParams | null;
    preset: string;
    enabled: boolean;
    amount: number;
}

export interface Preset {
    schemaVersion?: number;
    name: string;
    plugins: PresetPlugin[];
    pluginsIncluded?: boolean;
    audioConfig?: ProfileAudioConfig;
    noiseControl?: ProfileNoiseControl;
    builtinFx?: ProfileBuiltinFx;
}

export interface ProfileSaveCategories {
    includePlugins: boolean;
    includeAudioConfig: boolean;
    includeNoiseControl: boolean;
    includeBuiltinFx: boolean;
}

export interface ProfileAudioExtras {
    inputChannels?: number[];
    inputGainDb?: number;
    masterGainDb?: number;
}

export interface ProfileMeta {
    name: string;
    hasPlugins: boolean;
    hasAudioConfig: boolean;
    hasNoiseControl: boolean;
    hasBuiltinFx: boolean;
    isBackup: boolean;
}

export interface MissingDevice {
    role: string;
    name: string;
}

export interface MissingPlugin {
    name: string;
    path: string;
}

export interface LoadedPluginInstance {
    id: string;
    path: string;
    name: string;
    vendor: string;
    version: string;
    enabled: boolean;
    muted: boolean;
    gain: number;
}

export interface ApplyProfileSummary {
    appliedCategories: string[];
    skippedCategories: string[];
    missingDevices: MissingDevice[];
    missingPlugins: MissingPlugin[];
    needsEngineRestart: boolean;
    appliedAudioConfig?: ProfileAudioConfig;
    appliedNoiseControl?: ProfileNoiseControl;
    appliedBuiltinFx?: ProfileBuiltinFx;
    appliedPlugins?: PresetPlugin[];
    loadedPluginInstances?: LoadedPluginInstance[];
}

export interface DeviceSubstitutions {
    inputDevice?: string;
    outputDevice?: string;
}

/** localStorage からオーディオ補足情報を収集 */
export function gatherProfileAudioExtras(): ProfileAudioExtras {
    const inputGainPct = Number(localStorage.getItem('vst_host_input_gain') ?? '100');
    const outputGainPct = Number(localStorage.getItem('vst_host_output_gain') ?? '100');
    let inputChannels: number[] | undefined;
    try {
        const cfg = JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}');
        if (Array.isArray(cfg.inputChannels) && cfg.inputChannels.length >= 2) {
            inputChannels = cfg.inputChannels;
        }
    } catch { /* ignore */ }

    const pctToDb = (pct: number) => 20 * Math.log10(Math.max(pct / 100, 1e-6));

    return {
        inputChannels,
        inputGainDb: pctToDb(inputGainPct),
        masterGainDb: pctToDb(outputGainPct),
    };
}

export const DEFAULT_SAVE_CATEGORIES: ProfileSaveCategories = {
    includePlugins: true,
    includeAudioConfig: true,
    includeNoiseControl: true,
    includeBuiltinFx: true,
};

export const DEFAULT_EXPORT_CATEGORIES: ProfileSaveCategories = {
    includePlugins: true,
    includeAudioConfig: false,
    includeNoiseControl: true,
    includeBuiltinFx: true,
};

export const presetApi = {
    list: async (): Promise<string[]> => {
        return await invoke("list_presets");
    },
    listProfiles: async (): Promise<ProfileMeta[]> => {
        return await invoke("list_profiles");
    },
    save: async (name: string, plugins: PresetPlugin[]): Promise<void> => {
        return await invoke("save_preset", { name, plugins });
    },
    saveProfile: async (
        name: string,
        categories: ProfileSaveCategories,
        plugins: PresetPlugin[],
        audioExtras?: ProfileAudioExtras,
        builtinFxAmount?: number,
    ): Promise<void> => {
        return await invoke("save_profile", {
            name,
            categories,
            plugins,
            audioExtras: audioExtras ?? gatherProfileAudioExtras(),
            builtinFxAmount,
        });
    },
    load: async (name: string): Promise<Preset> => {
        return await invoke("load_preset", { name });
    },
    applyProfile: async (
        name: string,
        currentPluginIds: string[],
        backupPlugins: PresetPlugin[],
        options?: {
            deviceSubstitutions?: DeviceSubstitutions;
            backupAudioExtras?: ProfileAudioExtras;
            skipBackup?: boolean;
            soundOnly?: boolean;
        },
    ): Promise<ApplyProfileSummary> => {
        return await invoke("apply_profile", {
            name,
            currentPluginIds,
            backupPlugins,
            deviceSubstitutions: options?.deviceSubstitutions,
            backupAudioExtras: options?.backupAudioExtras ?? gatherProfileAudioExtras(),
            skipBackup: options?.skipBackup,
            ...(options?.soundOnly !== undefined ? { soundOnly: options.soundOnly } : {}),
        });
    },
    hasBackup: async (): Promise<boolean> => {
        return await invoke("has_backup_profile");
    },
    restoreBackup: async (
        currentPluginIds: string[],
        backupPlugins: PresetPlugin[],
        backupAudioExtras?: ProfileAudioExtras,
    ): Promise<ApplyProfileSummary> => {
        return await invoke("restore_backup_profile", {
            currentPluginIds,
            backupPlugins,
            backupAudioExtras: backupAudioExtras ?? gatherProfileAudioExtras(),
        });
    },
    delete: async (name: string): Promise<void> => {
        return await invoke("delete_preset", { name });
    },
    exportProfile: async (name: string, categories?: ProfileSaveCategories): Promise<void> => {
        return await invoke("export_profile", { name, categories });
    },
    importProfile: async (): Promise<string> => {
        return await invoke("import_profile");
    },
};

/** 適用結果を localStorage / UI イベントへ反映（Rust を正とする一方向同期） */
export function syncLocalStateFromProfile(summary: ApplyProfileSummary): void {
    if (summary.appliedAudioConfig) {
        const ac = summary.appliedAudioConfig;
        const dbToPct = (db: number) => Math.round(100 * Math.pow(10, db / 20));
        const inputPct = dbToPct(ac.inputGainDb);
        const outputPct = dbToPct(ac.masterGainDb);

        try {
            const prev = JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}');
            const next = {
                ...prev,
                host: ac.host,
                input: ac.inputDevice,
                output: ac.outputDevice,
                sampleRate: ac.sampleRate,
                bufferSize: ac.bufferSize,
                inputChannels: ac.inputChannels?.length >= 2 ? ac.inputChannels : prev.inputChannels,
            };
            localStorage.setItem('vst_host_audio_config', JSON.stringify(next));
        } catch { /* ignore */ }

        localStorage.setItem('vst_host_input_gain', String(inputPct));
        localStorage.setItem('vst_host_output_gain', String(outputPct));
        window.dispatchEvent(new CustomEvent('input-gain-sync', { detail: inputPct }));
        window.dispatchEvent(new CustomEvent('profile-audio-applied', { detail: ac }));
    }

    if (summary.appliedNoiseControl || summary.appliedBuiltinFx) {
        window.dispatchEvent(new CustomEvent('profile-fx-applied', {
            detail: {
                noiseControl: summary.appliedNoiseControl,
                builtinFx: summary.appliedBuiltinFx,
            },
        }));
    }
}
