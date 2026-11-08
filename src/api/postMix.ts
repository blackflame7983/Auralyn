import { invoke } from '@tauri-apps/api/core';
export interface PostMixPlugin { id: string; path: string; name: string; enabled: boolean; muted: boolean; gain: number; classId?: string }
export interface PostMixSavedPlugin { path: string; name: string; vendor: string; version: string; enabled: boolean; muted: boolean; gain: number; classId?: string }
export interface PostMixSnapshot { epoch: string; revision: string; enabled: boolean; running: boolean; savedPlugins: PostMixSavedPlugin[]; plugins: PostMixPlugin[]; restored: boolean; error: string | null; attached?: boolean | null; ready?: boolean | null; failed?: boolean | null; processedPackets?: number | null; sampleRate?: number | null; transportLatencyFrames: number; declaredPluginLatencyFrames: number | null }
type Witness = { expectedEpoch: string; expectedRevision: string };
export type PostMixRequest = { action: 'snapshot' } | (Witness & ({ action: 'enable'; enabled: boolean } | { action: 'restore_saved' | 'save' | 'reload' | 'reset' } | { action: 'add'; path: string; classId?: string } | { action: 'remove' | 'editor'; id: string } | { action: 'reorder'; ids: string[] } | { action: 'bypass' | 'mute'; id: string; active: boolean } | { action: 'gain'; id: string; value: number }));
export const postMixApi = { request: (request: PostMixRequest): Promise<PostMixSnapshot> => invoke('post_mix', { request }) };
