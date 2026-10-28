import { message, type MessageKey } from '@/i18n/messages';
import type { ObsChange, ObsTypedChange, ObsUiText } from './obs';
import { invoke } from '@tauri-apps/api/core';
import type { ApplyProfileSummary, ProfileSaveCategories } from './presets';

// Only client-generated validation failures have a display key. Backend errors remain untouched.
export class BundleClientError extends Error {
    constructor(public readonly messageKey: MessageKey) { super(message('ja', messageKey)); this.name = 'BundleClientError'; }
}

export interface BundleObsSelection { source: string; volume: boolean; muted: boolean; monitor: boolean; filters: string[] }
export interface BundleFilter { name: string; kind: string; enabled: boolean }
export interface CheckedClaim { expected: import('./audio').PreparationSnapshot; usage: string; location: string }
export interface CheckedReceipt { checkedAtUnixMs: number; usage: string; location: string; preparation: import('./audio').PreparationSnapshot }
export interface BundlePreview { confirmation?: CheckedReceipt | null; id: string; name: string; revision: string; categories: string[]; running: boolean; auralyn: (ObsTypedChange & { label: string; status: 'same' | 'changed' | 'notSelected' | 'unknown'; before: string; after: string })[]; obs: ObsChange[] }
export interface BundleResult { id: string; complete: boolean; undoPending: boolean; auralyn: string; obs: string[]; auralynText?: ObsUiText | null; obsTexts?: ObsUiText[] | null; summary: ApplyProfileSummary | null; current?: ApplyProfileSummary | null }
export interface BundleRecovery { id: string | null; readable: boolean }
export type BundleOperation = { action: 'apply' | 'undo' | 'recovery_apply'; id: string };
type Reply = { type: 'names'; value: string[] } | { type: 'filters'; value: BundleFilter[] } | { type: 'saved' } | { type: 'preview'; value: BundlePreview } | { type: 'result'; value: BundleResult | null } | { type: 'recovery'; value: BundleRecovery | null };
async function request(request: unknown): Promise<Reply> { return invoke('broadcast_bundle', { request }); }
export const bundleApi = {
    async list() { const r = await request({ action: 'list' }); if (r.type !== 'names') throw new BundleClientError('presets.copy.174'); return r.value; },
    async checkedList() { const r = await request({ action: 'checked_list' }); if (r.type !== 'names') throw new BundleClientError('presets.copy.174'); return r.value; },
    async sources() { const r = await request({ action: 'sources' }); if (r.type !== 'names') throw new BundleClientError('presets.copy.175'); return r.value; },
    async filters(source: string) { const r = await request({ action: 'filters', source }); if (r.type !== 'filters') throw new BundleClientError('presets.copy.176'); return r.value; },
    async save(name: string, categories: ProfileSaveCategories, obs: BundleObsSelection[] | null, overwrite = false, checked?: CheckedClaim) { const r = await request({ action: 'save', name, categories, obs, overwrite, ...(checked ? { checked } : {}) }); if (r.type !== 'saved') throw new BundleClientError('presets.copy.177'); },
    async preview(name: string) { const r = await request({ action: 'preview', name }); if (r.type !== 'preview') throw new BundleClientError('presets.copy.178'); return r.value; },
    async operation(operation: BundleOperation) { const r = await request(operation); if (r.type !== 'result' || !r.value) throw new BundleClientError('presets.copy.179'); return r.value; },
    async history() { const r = await request({ action: 'history' }); if (r.type !== 'result') throw new BundleClientError('presets.copy.180'); return r.value; },
    async recovery() { const r = await request({ action: 'recovery_status' }); if (r.type !== 'recovery') throw new BundleClientError('presets.copy.180'); return r.value; },
    async recoveryPreview() { const r = await request({ action: 'recovery_preview' }); if (r.type !== 'preview') throw new BundleClientError('presets.copy.178'); return r.value; },
    async resolveRecovery(id: string | null) { const r = await request({ action: 'recovery_resolve', id }); if (r.type !== 'recovery' || r.value !== null) throw new BundleClientError('presets.copy.180'); },
};
