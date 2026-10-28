import { FixedClientError } from '@/lib/clientError';
import { invoke } from '@tauri-apps/api/core';
import type { HistoryReason } from './history';

export interface GainProposal {
    before: number;
    after: number;
    measured: number;
    predicted: number;
    peak: number;
    limited: boolean;
}
export interface GainSnapshot {
    revision: number;
    historyId?: number | null; historyEpoch?: string | null; undoAvailable?: boolean; redoAvailable?: boolean;
    historyReason?: HistoryReason | null;
    gain: number;
    confirmedGain: number;
    settled: boolean;
    running: boolean;
    streamFailed: boolean;
    id: number;
    phase: string;
    progress: number;
    proposal: GainProposal | null;
    playing: boolean;
    error: string | null;
    devices: { id: string; name: string }[];
}
export type GainRequest =
    | { action: 'status' | 'devices' | 'cancel' | 'stop_preview' }
    | { action: 'initialize'; value: number }
    | { action: 'begin'; target: number; revision: number }
    | { action: 'preview'; id: number; after: boolean; device: string }
    | { action: 'apply' | 'restore'; id: number; revision: number }
    | { action: 'undo_history' | 'redo_history'; id: number; revision: number; epoch: string };

// 保存は確認済みの実値だけで更新する。停止中の設定は明示操作から保存する。
export function publishOutputGain(state: GainSnapshot) {
    if (
        !state?.settled ||
        state.streamFailed ||
        !Number.isFinite(state.confirmedGain) ||
        state.confirmedGain !== state.gain ||
        state.gain < 0 ||
        state.gain > 2
    )
        return;
    const pct = state.confirmedGain * 100;
    localStorage.setItem('vst_host_output_gain', String(pct));
    window.dispatchEvent(new CustomEvent('output-gain-sync', { detail: pct }));
}
let commands: Promise<unknown> = Promise.resolve();
function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = commands.catch(() => {}).then(run);
    commands = next;
    return next;
}
export async function gainCommand(request: GainRequest): Promise<GainSnapshot> {
    if (request.action === 'initialize' || request.action === 'apply' || request.action === 'restore' || request.action === 'undo_history' || request.action === 'redo_history') {
        window.dispatchEvent(new Event('output-gain-intent'));
    }
    const state = await enqueue(() => invoke<GainSnapshot>('auto_gain', { request }));
    publishOutputGain(state);
    return state;
}
// 初期表示やreloadの観測では、engine既定値を保存済み意図へ書き戻さない。
export async function readOutputGainStatus(): Promise<GainSnapshot> {
    return enqueue(() => invoke<GainSnapshot>('auto_gain', { request: { action: 'status' } }));
}
export interface ShortcutGainIntent { generation: string; revision: number; gain: number }
// 明示hotkeyの同じ要求だけを確認し、途中の再起動や新しい音量を保存へ流用しない。
export async function confirmShortcutOutputGain(intent: ShortcutGainIntent, isCurrent: () => boolean): Promise<void> {
    if (!intent || typeof intent.generation !== 'string' || !Number.isSafeInteger(intent.revision)
        || !Number.isFinite(intent.gain) || intent.gain < 0 || intent.gain > 2) return;
    for (let attempt = 0; attempt < 25 && isCurrent(); attempt += 1) {
        const observed = await enqueue(() => invoke<{ generation: string; state: GainSnapshot }>('get_output_gain_observation'));
        if (!isCurrent()) return;
        const state = observed.state;
        if (observed.generation !== intent.generation || state.revision !== intent.revision
            || state.gain !== intent.gain || state.streamFailed || !state.running) return;
        if (state.settled && state.confirmedGain === intent.gain) { publishOutputGain(state); return; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
export async function confirmOutputGain(expected: GainSnapshot): Promise<GainSnapshot> {
    for (let i = 0; i < 25; i++) {
        const state = await gainCommand({ action: 'status' });
        if (state.revision !== expected.revision || state.gain !== expected.gain) {
            throw new FixedClientError('gain.settingsChanged');
        }
        if (state.settled) return state;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new FixedClientError('gain.unconfirmed');
}
let writes: Promise<unknown> = Promise.resolve();
// 明示設定済みならエンジン側で無操作にし、返された実値へ同期する。
export async function restoreSavedOutputGain(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0 || value > 2)
        throw new FixedClientError('gain.range');
    // 起動中のストリーム切替や明示操作は正常な世代変更として扱う。
    // initializeは明示設定済みの実値を上書きしないため、再送しても旧値に戻らない。
    for (let i = 0; i < 25; i++) {
        const state = await gainCommand({ action: 'initialize', value });
        if (state.streamFailed) throw new FixedClientError('gain.audioUnverified');
        if (!state.running || state.settled) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new FixedClientError('gain.unconfirmed');
}

export function setOutputGain(value: number): Promise<void> {
    window.dispatchEvent(new Event('output-gain-intent'));
    const run = writes
        .catch(() => {})
        .then(async () => {
            if (!Number.isFinite(value) || value < 0 || value > 2)
                throw new FixedClientError('gain.range');
            await enqueue(() => invoke('set_output_gain', { value }));
            const state = await gainCommand({ action: 'status' });
            if (state.streamFailed || Math.abs(state.gain - value) > 0.000001) {
                throw new FixedClientError('gain.audioChanged');
            }
            if (!state.running) {
                localStorage.setItem('vst_host_output_gain', String(value * 100));
                window.dispatchEvent(new CustomEvent('output-gain-sync', { detail: value * 100 }));
            } else {
                await confirmOutputGain(state);
            }
        });
    writes = run;
    return run;
}
