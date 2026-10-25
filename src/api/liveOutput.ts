import type { BuiltinConfig } from './builtinEffects';
import { invoke } from '@tauri-apps/api/core';
export interface LiveOutputConfig { splitProcessing?: boolean; monitorSinging?: BuiltinConfig | null; monitorTalk?: BuiltinConfig | null; deviceId: string | null; monitorTrim: number; broadcastTrim: number; monitorMuted: boolean }
export interface LiveOutputStatus { broadcastEpoch?: string | null; monitor?: { epoch: string; broadcastQueueFrames: number; offeredFrames: number; droppedFrames: number; acceptedRevision: string; completedRevision: string; broadcastFailed: boolean } | null; config: LiveOutputConfig; sink: { active: boolean; failed: boolean; queuedFrames: number; offeredFrames: number; consumedFrames: number; zeroFilledFrames: number; droppedFrames: number; rateHz: number } | null; error: string | null }
export const liveOutputApi = { request: (config: LiveOutputConfig | null = null): Promise<LiveOutputStatus> => invoke('live_output', { config }) };
