import { FixedClientError } from '@/lib/clientError';
import { invoke } from '@tauri-apps/api/core';
import type { HistoryReason } from './history';
import type { BuiltinConfig } from './builtinEffects';
import type { VoiceCheckSource } from './audio';

export interface VoicePreviewOptions { source: VoiceCheckSource; loopPlayback: boolean; levelMatch: boolean }
export interface VoiceRecordingMetadata {
    recordingId: number; revision: number; sampleRate: number; bufferSize: number; host: string;
    inputChannels: [number, number]; inputGain: number; noiseEnabled: boolean; noiseMode: string;
    noiseStrength: number; voiceGuard: boolean; builtInEnabled: boolean; builtInPreset: string;
    builtInAmount: number; globalBypass: boolean;
    reverb?: import('./builtinEffects').ReverbParams | null;
    singing?: import('./builtinEffects').SingingParams | null;
    plugins: { id: string; name: string; enabled: boolean; muted: boolean; gain: number }[];
    changedDuringRecording: boolean; rawTap: string; processedTap: string; vstParametersVerified: boolean;
}
export interface NoiseCandidateConfig {
    enabled: boolean; mode: string; strength: number; voiceGuard: boolean;
    learnedMix: number; hasLearnedMix: boolean; profileRms: number | null; backend: string; model: string;
}
export interface BuiltinCandidate {
    noise?: NoiseCandidateConfig | null;
    id: string; recordingId: number; baseRevision: string; state: string; config: BuiltinConfig;
    sampleRate: number; sourceFrames: number; renderedFrames: number; algorithmicLatencyFrames: number;
    filterPhase: string; samplePeak: number | null; error: string | null;
    proposal?: VoiceProposal | null;
    proposalError?: ProposalMessage | null;
}
export interface ProposalMessage { code: string; args: Record<string, number>; fallbackJa: string }
export interface ProposalPreferences {
    dynamics: 'natural' | 'even'; lowCut: 'preserve' | 'tidy'; brightness: 'keep' | 'brighter' | 'softer';
    room: 'unknown' | 'reflective' | 'dry'; reverb: 'keep' | 'none' | 'short' | 'wide';
}
export const proposalPreferencesEqual = (a?: ProposalPreferences | null, b?: ProposalPreferences | null) => !!a && !!b
    && (['dynamics','lowCut','brightness','room','reverb'] as const).every(key=>a[key]===b[key]);
export interface ProposalPreferenceRequest { preferences: ProposalPreferences; preferencesRevision: number }
export const defaultProposalPreferences: ProposalPreferences = { dynamics:'natural',lowCut:'preserve',brightness:'keep',room:'unknown',reverb:'keep' };
export interface VoiceProposal {
    id: string; epoch: string; recordingId: number; baseRevision: string; ruleVersion: string; config: BuiltinConfig;
    metrics: { sampleRate: number; sourceFrames: number; durationSeconds: number; channelPeak: [number, number]; channelRmsDb: [number, number]; windowMs: number; activityThresholdDb: number; totalWindows: number; activeWindows: number; activeFraction: number; activeRmsP10Db: number; activeRmsP50Db: number; activeRmsP90Db: number; activeWindowSpreadDb: number };
    preferences?: ProposalPreferences | null; preferencesRevision?: number | null;
    evaluation?: { sharedActivityWindows:number; hpfEnergyLossDb:number; controlSpreadDb:number; candidateSpreadDb:number; levelLossDb:number; maxGainReductionDb:number; preClampPeak:number; preClampOverCount:number; finalPeakBeforeTailFade:number } | null;
    reasons: ProposalMessage[]; limitations: ProposalMessage[];
}
export interface VoicePreviewSnapshot extends VoicePreviewOptions {
    noiseHistoryReason?: HistoryReason | null;
    noiseBasis?: string; noiseUndoToken?: string | null; noiseRedoToken?: string | null; noiseSettings?: NoiseCandidateConfig | null; noisePending?: boolean;
    candidate?: BuiltinCandidate | null;
    epoch: string; sessionId: number; operationId: number; recordingId: number | null;
    state: 'idle' | 'playing' | 'stopping' | 'stopped' | 'failed' | 'closed';
    positionMs: number; durationMs: number; levelMatchAvailable: boolean;
    metadata: VoiceRecordingMetadata | null; recordingStale: boolean;
    devices: { id: string; name: string }[]; error: string | null;
    owner: string | null; conflict: string | null;
    levelMatchAttenuationDb: [number, number]; safetyAttenuationDb: number;
}
export type VoicePreviewAction = { action: 'open' | 'status' | 'devices' | 'stop' | 'close' }
    | ({ action: 'start'; recordingId: number; deviceId: string; candidateId?: string | null } & VoicePreviewOptions)
    | ({ action: 'update' } & VoicePreviewOptions)
    | { action: 'prepare_noise'; recordingId: number; expectedBasis: string; variant: 'current' | 'weaker' | 'stronger' }
    | { action: 'apply_noise'; candidateId: string; expectedBasis: string }
    | { action: 'undo_noise'; token: string }
    | { action: 'redo_noise'; token: string }
    | { action: 'prepare_candidate'; recordingId: number; expectedRevision: string; config: BuiltinConfig }
    | ({ action: 'prepare_proposal'; recordingId: number; builtinEpoch: string; expectedRevision: string; ruleVersion?: 'singing-rules-v2' } & Partial<ProposalPreferenceRequest>)
    | { action: 'candidate_status' | 'cancel_candidate'; candidateId: string };
export type VoicePreviewRequest = (VoicePreviewAction | { action: 'history_status' }) & { clientId: string; sessionId: number; operationId: number; epoch: string | null };
const clientId = crypto.randomUUID();
let nextSessionId = 0;
export const voiceCheckPreview = (request: VoicePreviewRequest): Promise<VoicePreviewSnapshot> => invoke('voice_check_preview', { request });
export const voicePreviewApi = { request: voiceCheckPreview };

// 操作IDは変更要求だけ進める。終了はopen応答前でも同じsessionへ送れる。
export function createVoicePreviewSession() {
    const sessionId = ++nextSessionId;
    let operationId = 0;
    let epoch: string | null = null;
    let closed = false;
    return {
        sessionId,
        get operationId() { return operationId; },
        get ready() { return epoch !== null && !closed; },
        get closed() { return closed; },
        async send(action: VoicePreviewAction) {
            if (closed && action.action !== 'close') throw new FixedClientError('preview.closed');
            if (action.action !== 'status' && action.action !== 'devices' && action.action !== 'candidate_status') operationId += 1;
            if (action.action === 'close') closed = true;
            const snapshot = await voicePreviewApi.request({ ...action, clientId, sessionId, operationId, epoch });
            if (!snapshot || snapshot.sessionId !== sessionId) throw new FixedClientError('preview.invalidSnapshot');
            if (action.action === 'open' && !closed) epoch = snapshot.epoch;
            return snapshot;
        },
    };
}
export type VoicePreviewSession = ReturnType<typeof createVoicePreviewSession>;
