import { invoke } from '@tauri-apps/api/core';

export interface SingingParams { lowCutHz: number; dynamics: number; brightnessDb: number }
export interface ReverbParams { enabled: boolean; mix: number; decaySeconds: number; damping: number }
export interface BuiltinConfig {
    active: boolean; preset: 'broadcast' | 'warm' | 'bright' | 'singing'; amount: number; singing: SingingParams | null;
    reverb?: ReverbParams | null;
}
export interface BuiltinSnapshot {
    epoch: string; revision: string; appliedRevision: string; config: BuiltinConfig;
    pending: boolean; undoToken: string | null; redoToken?: string | null; error: string | null;
}
export type BuiltinRequest = { action: 'snapshot' }
    | { action: 'apply'; epoch: string; expectedRevision: string; config: BuiltinConfig }
    | { action: 'apply_proposal'; epoch: string; expectedRevision: string; proposalId: string; recordingId: number }
    | { action: 'undo'; epoch: string; expectedRevision: string; undoToken: string }
    | { action: 'redo'; epoch: string; expectedRevision: string; redoToken: string };
export const defaultSinging: SingingParams = { lowCutHz: 80, dynamics: 0.35, brightnessDb: 0 };
export const defaultReverb: ReverbParams = { enabled: false, mix: 0.08, decaySeconds: 1.2, damping: 0.5 };
export const builtinApi = { request: (request: BuiltinRequest): Promise<BuiltinSnapshot> => invoke('builtin_effects', { request }) };

export interface CandidateDraft { config: BuiltinConfig; revision: string; epoch: string; draftRevision: number }
export interface ProposalBasis { epoch: string; revision: string; draftRevision: number }
