import { FixedClientError } from './clientError';
import { invoke } from '@tauri-apps/api/core';

export interface SessionMode { temporary: boolean; reviewOnly: boolean; directory: string | null; cleanupPending?: string | null }
let mode: SessionMode = { temporary: false, reviewOnly: false, directory: null };
export async function initializeTemporarySession() {
    let value: SessionMode;
    try { value = await invoke<SessionMode>('temporary_session_status'); } catch { throw new FixedClientError('session.isolation'); }
    if (!value || typeof value.temporary !== 'boolean' || typeof value.reviewOnly !== 'boolean'
        || (value.temporary && typeof value.directory !== 'string')) throw new FixedClientError('session.isolation');
    mode = value;
}
export const sessionMode = () => mode;
export const explicitSessionStartRequired = () => mode.reviewOnly;
export async function acknowledgeSessionStart() {
    if (!mode.reviewOnly) return;
    await invoke('acknowledge_session_review');
    mode = { ...mode, reviewOnly: false };
    window.dispatchEvent(new Event('session-review-completed'));
}
