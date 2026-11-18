import type { AudioStateInfo, EngineRuntimeStats, PreparationSnapshot } from '@/api/audio';
import type { LiveOutputConfig, LiveOutputStatus } from '@/api/liveOutput';
import type { ObsAudioReachResult } from '@/api/obs';
import { engineInputName } from '@/lib/inputSource';

export type PreparationUse = 'obs' | 'discord' | 'other' | 'listening';
export type PreparationStage = 'sound' | 'listen' | 'receiver';
export interface PreparationContext {
    location: 'home' | 'venue'; usage: PreparationUse | ''; signal: 'unknown' | 'separate' | 'mixed'; receiver: string;
}
export type Availability = 'unknown' | 'unconfigured' | 'stopped' | 'failed' | 'pending' | 'muted' | 'ready';
/** muted の原因。札を押したときの移動先を、札を描いたのと同じスナップショットで決める。緊急ミュートと同時なら緊急ミュートを先にする。 */
export type MuteCause = 'muted' | 'zeroGain';
export interface PreparationObservation {
    availability: Availability; muteCause?: MuteCause; config: AudioStateInfo['config']; keys: Record<PreparationStage, string> | null;
    routing?: LiveOutputConfig; inputGain?: number; obs: ObsAudioReachResult | null; obsCurrent: boolean;
}
export interface Confirmation { at: number; key: string; target: string; expired: boolean }
export type Confirmations = Partial<Record<PreparationStage, Confirmation>>;
const key = (value: unknown) => JSON.stringify(value);
export const emptyObservation = (availability: Availability = 'unknown'): PreparationObservation => ({ availability, config: null, keys: null, obs: null, obsCurrent: false });
export const isPreparationUse = (v: unknown): v is PreparationUse => ['obs', 'discord', 'other', 'listening'].includes(String(v));

export function readPreparationContext(): PreparationContext {
    const fallback: PreparationContext = { location: 'home', usage: '', signal: 'unknown', receiver: '' };
    try {
        const stored = JSON.parse(localStorage.getItem('auralyn_preparation_context') ?? 'null');
        const savedUse = localStorage.getItem('vst_host_setup_goal');
        const use = savedUse === 'local' || savedUse === 'music' ? 'listening' : savedUse;
        return { location: stored?.location === 'venue' ? 'venue' : 'home', usage: isPreparationUse(use) ? use : '',
            signal: stored?.signal === 'separate' || stored?.signal === 'mixed' ? stored.signal : 'unknown',
            receiver: stored?.usage === use && typeof stored?.receiver === 'string' ? stored.receiver.slice(0, 200) : '' };
    } catch { return fallback; }
}
export function savePreparationContext(context: PreparationContext) {
    try {
        localStorage.setItem('auralyn_preparation_context', key(context));
        if (context.usage) {
            if (!(context.usage === 'listening' && localStorage.getItem('vst_host_setup_goal') === 'music')) localStorage.setItem('vst_host_setup_goal', context.usage);
        } else localStorage.removeItem('vst_host_setup_goal');
    } catch { /* 保存できなくても、そのセッションでの準備と既存操作を妨げない。 */ }
}

// 空白だけの名前や前後の空白は、名前として保存・表示・照合しない。
export const normalizeReceiver = (receiver: string) => receiver.slice(0, 200).trim();

// 診断から受け側の入力名を保存する。準備欄が開いていればそちらが確認の失効まで行う。
export function editPreparationReceiver(receiver: string) {
    const next = normalizeReceiver(receiver);
    const event = new CustomEvent('preparation-receiver-edited', { cancelable: true, detail: next });
    if (!window.dispatchEvent(event)) return;
    const context = readPreparationContext();
    if (context.receiver === next) return;
    savePreparationContext({ ...context, receiver: next });
}

export function validPreparationSnapshot(p: PreparationSnapshot | null | undefined): p is PreparationSnapshot {
    return !!p && [p.engineEpoch, p.processingRevision, p.routingRevision, p.outputRevision, p.nrBackend, p.nrModel].every(v => typeof v === 'string' && v.length > 0)
        && [p.inputGain, p.outputGain].every(v => Number.isFinite(v) && v >= 0 && v <= 2)
        && Array.isArray(p.inputChannels) && p.inputChannels.length === 2 && p.inputChannels.every(v => Number.isSafeInteger(v) && v >= 0)
        && typeof p.controlsPending === 'boolean' && typeof p.muted === 'boolean';
}
// 比較の前後だけで用いる。メーター開始等のrevisionを恒久的な確認キーへ混ぜない。
export function observationStamp(stats: EngineRuntimeStats) {
    return key([stats.preparation, stats.latencyMetadata?.streamEpoch, stats.latencyMetadata?.comparisonRevision]);
}

export function buildPreparationObservation(state: AudioStateInfo, stats: EngineRuntimeStats, live: LiveOutputStatus, context: PreparationContext,
    obs: ObsAudioReachResult | null = null, obsCurrent = false): PreparationObservation {
    const base = { config: state.config, obs, obsCurrent };
    const unavailable = (availability: Availability) => ({ ...emptyObservation(availability), ...base });
    if (!state.config?.host || !engineInputName(state.config) || !state.config.output) return unavailable('unconfigured');
    if (!state.is_running) return unavailable('stopped');
    if (live.error || live.sink?.failed || live.monitor?.broadcastFailed || stats.queueDiagnostics?.state === 'failed') return unavailable('failed');
    const p = stats.preparation;
    if (!validPreparationSnapshot(p) || !stats.latencyMetadata?.streamEpoch || stats.latencyMetadata.streamRunning !== true || !live.config) return unavailable('unknown');
    if ((live.config.splitProcessing && !live.config.deviceId) || (live.config.deviceId && live.sink?.active !== true)) return unavailable('failed');
    const source = state.config.input_source;
    // アプリの音声は機器名を持たない。アプリか出力先の端点が変わったら、音作りから再確認する。
    const inputIdentity = source?.kind === 'process_loopback' ? ['app', source.config.appKey, source.config.rawEndpointId] : state.config.input;
    const input = [state.config.host, inputIdentity, state.config.sample_rate, state.config.buffer_size, p.inputGain, p.inputChannels];
    const sound = key([p.engineEpoch, stats.latencyMetadata.streamEpoch, input, p.processingRevision, p.nrBackend, p.nrModel, context.location, context.signal]);
    const listen = key([sound, state.config.output, p.outputRouting, p.outputGain, p.outputRevision, p.routingRevision, p.muted, live.config, live.broadcastEpoch]);
    const availability: Availability = p.controlsPending ? 'pending' : p.muted || p.outputGain === 0 ? 'muted' : 'ready';
    const muteCause: MuteCause | undefined = availability === 'muted' ? p.muted ? 'muted' : 'zeroGain' : undefined;
    return { ...base, availability, muteCause, inputGain: p.inputGain, routing: live.config,
        keys: { sound, listen, receiver: key([listen, context.usage, context.receiver.trim(), obs?.verification?.operationId, obsCurrent]) } };
}

// 一度失効した確認は、設定をA→B→Aと戻しても再び成功にはしない。
export function expireConfirmations(records: Confirmations, observation: PreparationObservation): Confirmations {
    return Object.fromEntries(Object.entries(records).map(([stage, receipt]) => [stage,
        receipt && !receipt.expired && (!observation.keys || receipt.key !== observation.keys[stage as PreparationStage]) ? { ...receipt, expired: true } : receipt]));
}
export function confirmationState(records: Confirmations, stage: PreparationStage): 'unconfirmed' | 'confirmed' | 'stale' {
    return !records[stage] ? 'unconfirmed' : records[stage]?.expired ? 'stale' : 'confirmed';
}
export function nextPreparationStage(observation: PreparationObservation, records: Confirmations, context: PreparationContext): 'connect' | 'purpose' | PreparationStage | 'done' {
    if (observation.availability !== 'ready') return 'connect';
    if (!context.usage) return 'purpose';
    return (['sound', 'listen', 'receiver'] as const).find(s => confirmationState(records, s) !== 'confirmed') ?? 'done';
}

// 生音声は保持しない。OBSの既存witnessを表示時に再検証してから使う。
let reach: ObsAudioReachResult | null = null;
const reachSubscribers = new Set<() => void>();
export const preparationReach = {
    get: () => reach,
    subscribe: (callback: () => void) => { reachSubscribers.add(callback); return () => { reachSubscribers.delete(callback); }; },
    clear: () => { reach = null; reachSubscribers.forEach(fn => fn()); },
    record: (result: ObsAudioReachResult) => { reach = result; reachSubscribers.forEach(fn => fn()); },
};
