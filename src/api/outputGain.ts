import { invoke } from '@tauri-apps/api/core';

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
    | { action: 'apply' | 'restore'; id: number; revision: number };

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
    const state = await enqueue(() => invoke<GainSnapshot>('auto_gain', { request }));
    publishOutputGain(state);
    return state;
}
export async function confirmOutputGain(expected: GainSnapshot): Promise<GainSnapshot> {
    for (let i = 0; i < 25; i++) {
        const state = await gainCommand({ action: 'status' });
        if (state.revision !== expected.revision || state.gain !== expected.gain) {
            throw new Error('音声設定が変わりました。現在の音量を確認してください。');
        }
        if (state.settled) return state;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('音量の反映を確認できません。状態を再取得してください。');
}
let writes: Promise<unknown> = Promise.resolve();
// 明示設定済みならエンジン側で無操作にし、返された実値へ同期する。
export async function restoreSavedOutputGain(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0 || value > 2)
        throw new Error('出力音量は0〜200%で指定してください。');
    const state = await gainCommand({ action: 'initialize', value });
    if (state.running && !state.settled) await confirmOutputGain(state);
}

export function setOutputGain(value: number): Promise<void> {
    const run = writes
        .catch(() => {})
        .then(async () => {
            if (!Number.isFinite(value) || value < 0 || value > 2)
                throw new Error('出力音量は0〜200%で指定してください。');
            await enqueue(() => invoke('set_output_gain', { value }));
            const state = await gainCommand({ action: 'status' });
            if (state.streamFailed || Math.abs(state.gain - value) > 0.000001) {
                throw new Error('音声状態が変わりました。現在の音量を確認してください。');
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
