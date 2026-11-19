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
        /** 模擬が成功で隠さず記録した、未定義の IPC 名（src/dev/tauriMock.ts）。 */
        __e2eUnexpected?: string[];
        __e2eStarts?: StartRequest[];
        __e2eStartFailure?: boolean;
        __e2eArmed?: boolean;
        /** 再起動を保留している間 true。__e2eReleaseRestart で再開する。 */
        __e2eRestartHeld?: boolean;
        __e2eReleaseRestart?: () => void;
        /** 再起動の直後に VST の実ラック確認を失敗させる。 */
        __e2eVstFailure?: boolean;
        /** 機器一覧の応答を保留している間 true。__e2eReleaseDevices で返す。 */
        __e2eDevicesHeld?: boolean;
        __e2eBlockDevices?: boolean;
        __e2eReleaseDevices?: () => void;
        __e2eOutputGainWrites?: number[];
        __e2eSetOutputGain?: (value: number) => void;
        __e2eSetOutputMuted?: (muted: boolean) => void;
        __e2ePresetOutputMuted?: (muted: boolean) => void;
        /** 次の n 回の統計の読取りで、出力の操作が反映待ち（controlsPending）の状態を返す。 */
        __e2ePendControls?: (reads: number) => void;
        /** get_audio_state の読取り回数。取り直しの回数と間隔を試験で数える（mute-refresh.spec.ts）。 */
        __e2eStateReads?: { count: number };
        /** 札の描き直しで消えた回数（mute-refresh.spec.ts の点滅の検出）。 */
        __chipRemoved?: { count: number };
        /** 入力の一定レベルを audio-level で流す。出力は模擬が出力ミュートと出力音量から決める（src/dev/tauriMock.ts）。 */
        __e2eEmitLevel?: (level: number) => void;
        /** 本番帯の試験が差し替えた invoke に記録した操作と、読取りを失わせる切替（ui-refinement.spec）。 */
        __refineActions?: string[];
        __refineUnknown?: boolean;
        __layoutMeterState?: { value: number | null };
        /** 配信ラックへ送った要求の記録（mixing.spec の模擬）。 */
        __postRequests?: { action: string; ids?: string[] }[];
        /** 配信用の出力先が未選択の応答を返させる（mixing.spec の模擬）。 */
        __liveOutputMissing?: boolean;
        /** 保存済みの構成の一覧を取得できない応答を返させる（preset-empty-state.spec の模擬）。 */
        __presetListFailure?: boolean;
    }
}
