/** 実機 WebView が公開する Tauri。ブラウザ試験の __TAURI_INTERNALS__ とは別。 */

export interface PostMixSnapshot {
    plugins: { id: string }[];
}

export interface AudioStreamStatus {
    running: boolean;
    streamFailed: boolean;
}

export interface ShortcutStatus {
    errors: unknown[];
    bindings: { action: string; shortcut: string }[];
}

export interface ObsEndpoint {
    host: string;
    port: number;
}

export interface EngineRuntimeCounts {
    activePluginCount: number;
    glitchCount: number;
}

export interface NativeTauriCore {
    invoke(command: 'post_mix', args: { request: { action: 'snapshot' } }): Promise<PostMixSnapshot>;
    invoke(command: 'auto_gain', args: { request: { action: 'status' } }): Promise<AudioStreamStatus>;
    invoke(command: 'get_shortcuts'): Promise<ShortcutStatus>;
    invoke(command: 'get_obs_credentials'): Promise<ObsEndpoint | null>;
    invoke(command: 'get_engine_runtime_stats'): Promise<EngineRuntimeCounts>;
    invoke(command: 'plugin:webview|set_webview_zoom', args: { label: string; value: number }): Promise<unknown>;
    invoke(command: 'plugin:process|exit', args: { code: number }): Promise<unknown>;
    invoke(command: string, args?: unknown): Promise<unknown>;
}

declare global {
    interface Window {
        __TAURI__?: { core: NativeTauriCore };
    }
}
