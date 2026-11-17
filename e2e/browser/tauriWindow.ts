/** ブラウザ試験が差し替える Tauri 内部の invoke。 */
export interface TauriInternals {
    invoke: (command: string, args?: unknown) => Promise<unknown>;
}

declare global {
    interface Window {
        __TAURI_INTERNALS__?: TauriInternals;
        __e2eEmit?: (event: string, payload: unknown) => void;
        __e2eOutputGainWrites?: number[];
        __e2eSetOutputGain?: (value: number) => void;
        __e2eSetOutputMuted?: (muted: boolean) => void;
        __layoutMeterState?: { value: number | null };
        /** 配信ラックへ送った要求の記録（mixing.spec の模擬）。 */
        __postRequests?: { action: string; ids?: string[] }[];
    }
}
