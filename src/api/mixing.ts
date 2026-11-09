import { invoke } from '@tauri-apps/api/core';

export interface OffsetContext {
    voiceInputId: string;
    voiceChannels: [number, number];
    accompaniment: string;
    outputId: string;
    broadcastId: string | null;
}
export interface MixLevels { voice: { gain: number; muted: boolean }; accompaniment: { gain: number; muted: boolean }; monitorAccompaniment: boolean; offsetMs: number; offsetContext?: OffsetContext | null }
export type MixSource = { kind: 'device'; config: { host: 'WASAPI'; inputId: string; inputChannels: [number, number] } } | { kind: 'process_loopback'; config: { appKey: string; appName: string; rawEndpointId: string; purpose: 'music' } };
export interface MixConfig { version: 1; source: MixSource; levels: MixLevels }
export interface ProcessInputSnapshot { capturedFrames: number; nonzeroFrames: number; failed: boolean; waitingForAudio: boolean; inputRateHz: number; correctionLimitPpm: number; queuedFrames: number; renderedFrames: number; correctionPpm: number; pauseResets: number; waitingDiscardedFrames: number; discontinuities: number; timestampErrors: number; nonfiniteSamples: number }
export interface MixSnapshot { epoch: string; revision: string; config: MixConfig | null; savedConfig: MixConfig | null; error: string | null; running: boolean; accompaniment: ProcessInputSnapshot | null; voicePeak: [number, number]; accompanimentPeak: [number, number]; mixPeak: [number, number]; knownVoiceProcessingFrames: number | null; pending: boolean; failed: boolean; primaryClock: { adaptive: boolean; inputRateHz: number; outputRateHz: number; queuedFrames: number; correctionPpm: number; underruns: number | null } | null }
export type MixRequest = { action: 'snapshot' } | { action: 'configure'; expectedEpoch: string; expectedRevision: string; config: MixConfig | null; candidateId?: string | null } | { action: 'levels'; expectedEpoch: string; expectedRevision: string; levels: MixLevels } | { action: 'reload' | 'reset'; expectedEpoch: string; expectedRevision: string };
export const mixingApi = { request: (request: MixRequest): Promise<MixSnapshot> => invoke('mixing', { request }) };
