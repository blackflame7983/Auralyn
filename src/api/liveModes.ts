import { invoke } from '@tauri-apps/api/core';
import type { BuiltinConfig } from './builtinEffects';

export type LiveMode = 'singing' | 'talk';
export interface LiveModeSnapshot {
    epoch: string; running: boolean; revision: string; acceptedRevision: string; completedRevision: string;
    target: LiveMode | null; applied: LiveMode | null; phase: 'custom' | 'stopped' | 'queued' | 'transitioning' | 'settled';
    armed: boolean; naturalTail: boolean; error: string | null;
    definitions: { schemaVersion: 1; version: string; singing: BuiltinConfig | null; talk: BuiltinConfig | null };
}
export type LiveModeRequest = { action: 'snapshot' }
    | { action: 'save'; expectedVersion: string; singing: BuiltinConfig | null; talk: BuiltinConfig | null }
    | { action: 'singing_on' | 'talk_on' | 'arm' | 'disarm'; intent: { clientId: string; sequence: number; expectedEpoch: string } };
const clientId = crypto.randomUUID();
let sequence = 0;
const intent = (expectedEpoch: string) => ({ clientId, sequence: ++sequence, expectedEpoch });
export const liveModesApi = {
    request: (request: LiveModeRequest): Promise<LiveModeSnapshot> => invoke('live_modes', { request }),
    select: (mode: LiveMode, epoch: string): Promise<LiveModeSnapshot> => liveModesApi.request({ action: mode === 'singing' ? 'singing_on' : 'talk_on', intent: intent(epoch) }),
    protect: (armed: boolean, epoch: string): Promise<LiveModeSnapshot> => liveModesApi.request({ action: armed ? 'arm' : 'disarm', intent: intent(epoch) }),
    preflight: (): Promise<void> => invoke('preflight_live_changes'),
    beginChanges: (): Promise<string> => invoke('begin_live_changes'),
    endChanges: (token: string): Promise<void> => invoke('end_live_changes', { token }),
};
