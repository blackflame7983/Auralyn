/** ブラウザ試験が差し替える Tauri 内部の invoke。 */
export interface TauriInternals {
    invoke: (command: string, args?: unknown) => Promise<unknown>;
}

declare global {
    interface Window {
        __TAURI_INTERNALS__?: TauriInternals;
        __e2eEmit?: (event: string, payload: unknown) => void;
    }
}
