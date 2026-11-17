/** ブラウザ試験が差し替える Tauri 内部の invoke。 */
export interface TauriInternals {
    invoke: (command: string, args?: unknown) => Promise<unknown>;
}

/** 模擬の音声開始・再起動へ渡った要求の記録（src/dev/tauriMock.ts の __e2eStarts）。 */
export interface StartRequest {
    host?: string;
    input?: string;
    inputId?: string;
    output?: string;
    outputId?: string;
    sampleRate?: number;
    bufferSize?: number;
    inputSource?: { source: { kind: string; config: { purpose: string } }; candidateId?: string };
}

declare global {
    interface Window {
        __TAURI_INTERNALS__?: TauriInternals;
        __e2eEmit?: (event: string, payload: unknown) => void;
        __e2eStarts?: StartRequest[];
        __e2eStartFailure?: boolean;
        __e2eArmed?: boolean;
        __e2eOutputGainWrites?: number[];
        __e2eSetOutputGain?: (value: number) => void;
        __e2eSetOutputMuted?: (muted: boolean) => void;
        __layoutMeterState?: { value: number | null };
        /** 配信ラックへ送った要求の記録（mixing.spec の模擬）。 */
        __postRequests?: { action: string; ids?: string[] }[];
    }
}
