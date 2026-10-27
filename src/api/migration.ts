import { FixedClientError } from '@/lib/clientError';
import { invoke } from '@tauri-apps/api/core';

export const MIGRATION_KEYS = [
    'vst_host_theme', 'vst_host_beginner_mode', 'vst_host_simple_mode',
    'vst_host_locale',
    'vst_host_audio_config', 'vst_host_audio_presets', 'vst_host_input_gain',
    'vst_host_output_gain', 'vst_host_plugin_favorites', 'vst_host_plugin_recent',
    'vst_host_session_plugins', 'vst_host_setup_goal', 'vst_host_wizard_done',
    'auralyn_preparation_context',
    'vst_host_tutorial_completed', 'vst_host_settings_advanced',
] as const;
export const REVIEW_KEY = 'vst_host_migration_review_required';
export interface MigrationSummary {
    appVersion: string; settings: string[]; files: string[];
    audio?: { host: string; input?: string; output?: string; sampleRate?: number; bufferSize?: number } | null;
    plugins?: string[];
}

export function collectSettings(): Record<string, string> {
    return Object.fromEntries(MIGRATION_KEYS.flatMap(key => {
        const value = localStorage.getItem(key);
        return value === null ? [] : [[key, value]];
    }));
}

export async function flushSession(): Promise<void> {
    if (localStorage.getItem(REVIEW_KEY) === 'true') return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new FixedClientError('migration.flushTimeout')), 15000);
        window.dispatchEvent(new CustomEvent('auralyn-save-session', { detail: {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: (error: unknown) => { clearTimeout(timer); reject(error); },
        } }));
    });
}

// Reactの設定・音声・VST初期化より前に、確認済みのキーだけを反映する。
export async function bootstrapMigration(): Promise<void> {
    const pending = await invoke<{ reviewRequired: boolean; ui: Record<string, string> | null }>('migration_bootstrap', { acknowledge: false });
    if (pending.ui) {
        const importedLocale = pending.ui.vst_host_locale;
        if (importedLocale !== undefined && importedLocale !== 'ja' && importedLocale !== 'en') throw new FixedClientError('migration.invalidLocale');
        const old = collectSettings();
        try {
            for (const key of MIGRATION_KEYS) {
                if (Object.prototype.hasOwnProperty.call(pending.ui, key)) localStorage.setItem(key, pending.ui[key]);
                else localStorage.removeItem(key);
            }
            localStorage.setItem(REVIEW_KEY, 'true');
        } catch (error) {
            for (const key of MIGRATION_KEYS) {
                if (Object.prototype.hasOwnProperty.call(old, key)) localStorage.setItem(key, old[key]);
                else localStorage.removeItem(key);
            }
            throw error;
        }
        await invoke('migration_bootstrap', { acknowledge: true });
    }
    if (pending.reviewRequired) localStorage.setItem(REVIEW_KEY, 'true');
    else localStorage.removeItem(REVIEW_KEY);
}
