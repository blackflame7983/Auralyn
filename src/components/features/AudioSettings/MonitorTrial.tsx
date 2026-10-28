import { useEffect, useRef, useState } from 'react';
import { sessionMode } from '@/lib/temporarySession';
import { audioApi, type AudioDevice, type AudioStateInfo, type EngineRuntimeStats } from '@/api/audio';
import { liveModesApi } from '@/api/liveModes';
import { readAudioPreferences, type AudioPreferences } from '@/lib/audioPreferences';
import { useMessages } from '@/i18n/LocaleProvider';
import { LatencyDetails } from '@/components/layout/LatencyDetails';

const condition = (s: EngineRuntimeStats) => JSON.stringify([s.queueDiagnostics?.epoch, s.latencyMetadata?.streamEpoch, s.latencyMetadata?.comparisonRevision, s.resamplerCohortTiming?.requestedRevision, s.latencyMetadata?.stageBreakdown]);
export function monitorAdvice(s: EngineRuntimeStats) {
    if (!s.latencyMetadata?.streamRunning) return [];
    const advice: { kind: 'nr' | 'conversion' | 'vstDelay' | 'vstUnknown'; name?: string; samples?: number }[] = [];
    if (s.latencyMetadata.nrConfiguredEnabled) advice.push({ kind: 'nr' });
    if (s.queueDiagnostics?.state === 'running' && s.queueDiagnostics.inputRateHz !== s.queueDiagnostics.outputRateHz) advice.push({ kind: 'conversion' });
    const stages = s.latencyMetadata.stageBreakdown;
    if (stages?.current) for (const vst of stages.vst) {
        if (vst.state !== 'active') continue;
        if (vst.declaredSamples === null) advice.push({ kind: 'vstUnknown', name: vst.name });
        else if (Number.isSafeInteger(vst.declaredSamples) && vst.declaredSamples > 0) advice.push({ kind: 'vstDelay', name: vst.name, samples: vst.declaredSamples });
    }
    return advice;
}
interface Trial { original: AudioPreferences; applied: AudioPreferences; before: EngineRuntimeStats; after: EngineRuntimeStats; condition: string; requested: number; }
// 原本には制御設定のみを保存する。録音データや古いUndo権限は永続化しない。
const storageKey = () => {
    const mode = sessionMode();
    return mode.temporary ? `auralyn_monitor_trial_original_v1_temporary_${encodeURIComponent(mode.directory ?? '')}` : 'auralyn_monitor_trial_original_v1';
};
type RecoveryRecord = { kind: 'none' } | { kind: 'invalid' } | { kind: 'saved'; original: AudioPreferences };
class RecoveryDeviceError extends Error {}
function validOriginal(value: unknown): value is AudioPreferences {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    const text = (x: unknown) => typeof x === 'string' && x.trim().length > 0 && x.length <= 2048;
    const channels = item.inputChannels;
    return text(item.host) && text(item.inputId) && text(item.outputId) && text(item.input) && text(item.output)
        && Number.isSafeInteger(item.sampleRate) && (item.sampleRate as number) > 0 && (item.sampleRate as number) <= 768000
        && Number.isSafeInteger(item.bufferSize) && (item.bufferSize as number) > 0 && (item.bufferSize as number) <= 4096
        && (channels === undefined || (Array.isArray(channels) && channels.length === 2 && channels.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 65535)));
}
function readRecovery(): RecoveryRecord {
    try {
        let raw = localStorage.getItem(storageKey());
        // 旧セッションの原本も保存に成功した場合だけ移す。
        if (raw === null && !sessionMode().temporary) {
            const legacy = sessionStorage.getItem('auralyn_monitor_trial_original');
            if (legacy !== null) {
                const original = JSON.parse(legacy);
                if (!validOriginal(original)) return {kind: 'invalid'};
                raw = JSON.stringify({version: 1, original});
                localStorage.setItem(storageKey(), raw);
                if (localStorage.getItem(storageKey()) !== raw) return {kind: 'invalid'};
                sessionStorage.removeItem('auralyn_monitor_trial_original');
            }
        }
        if (raw === null) return {kind: 'none'};
        const parsed = JSON.parse(raw);
        return parsed?.version === 1 && validOriginal(parsed.original) ? {kind: 'saved', original: parsed.original} : {kind: 'invalid'};
    } catch { return {kind: 'invalid'}; }
}
function persistOriginal(original: AudioPreferences) {
    if (!validOriginal(original) || readRecovery().kind !== 'none') throw new Error('未解決の試験原本があります');
    const raw = JSON.stringify({version: 1, original});
    localStorage.setItem(storageKey(), raw);
    if (localStorage.getItem(storageKey()) !== raw) throw new Error('試験原本を確認できません');
}
function removeOriginal() {
    localStorage.removeItem(storageKey());
    if (localStorage.getItem(storageKey()) !== null) throw new Error('試験原本を解除できません');
    if (!sessionMode().temporary) sessionStorage.removeItem('auralyn_monitor_trial_original');
}
export function MonitorTrial({ devices, onApplied, onBusyChange, disabled = false }: { disabled?: boolean; onBusyChange?: (busy: boolean) => void; devices: AudioDevice[]; onApplied: (config: AudioPreferences) => Promise<void> }) {
    const t = useMessages();
    const [recovery, setRecovery] = useState<RecoveryRecord>(readRecovery);
    const recoveryOriginal = recovery.kind === 'saved' ? recovery.original : null;
    const operation = useRef(false);
    const [adoptConfirmed, setAdoptConfirmed] = useState(false);
    const [recoverConfirmed, setRecoverConfirmed] = useState(false);
    const [confirmedBasis, setConfirmedBasis] = useState<string | null>(null);
    const confirmationGeneration = useRef(0);
    const [trial, setTrial] = useState<Trial | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
    const [error, setError] = useState(false);
    const [deviceMissing, setDeviceMissing] = useState(false);
    const [heard, setHeard] = useState(false);
    const [accepted, setAccepted] = useState(false);
    const [pending, setPending] = useState<{ original: AudioPreferences; before: EngineRuntimeStats; candidate: number } | null>(null);
    const sameDevices = (state: AudioStateInfo, config: AudioPreferences) => !!config.inputId && !!config.outputId
        && state.is_running && !!state.config && state.config.host === config.host
        && state.config.input === config.input && state.config.output === config.output
        && state.config.input_id === config.inputId && state.config.output_id === config.outputId;
    const recorded = (s: EngineRuntimeStats) => {
        const q = s.resamplerCohortTiming?.periods?.recent.earliestArrivalToEnd;
        const range = (r: { lowerMs: number; upperMs: number | null } | null | undefined) => !r || !Number.isFinite(r.lowerMs) || r.lowerMs < 0 || (r.upperMs !== null && (!Number.isFinite(r.upperMs) || r.upperMs <= r.lowerMs)) ? t('singingRoute.unknown') : r.upperMs === null ? t('batchTiming.rangeOpen', { lower: r.lowerMs.toFixed(2) }) : `${r.lowerMs.toFixed(2)}–${r.upperMs.toFixed(2)} ms`;
        return <p className="text-sm">{t('monitorTrial.recorded', { p50: range(q?.p50), p95: range(q?.p95), glitches: Number.isSafeInteger(s.glitchCount) && s.glitchCount >= 0 ? s.glitchCount : t('singingRoute.unknown') })}</p>;
    };
    async function prepare() {
        if (operation.current || readRecovery().kind !== 'none') return;
        operation.current = true; setBusy(true); setError(false); setAccepted(false);
        try {
            await liveModesApi.preflight();
            const original = readAudioPreferences();
            const [before, state] = await Promise.all([audioApi.getEngineRuntimeStats(), audioApi.getAudioState()]);
            const current = before.latencyMetadata;
            const range = devices.find(d => d.id === original?.outputId && d.host === original?.host)?.buffer_size_range;
            const fixed = current?.fixedBufferRequestFrames;
            if (!original?.inputId || !original.outputId || !sameDevices(state, original) || !current?.streamRunning || !fixed || !range || !current.nominalSampleRateHz) throw Error();
            const candidate = [128, 256, 512].find(value => value < fixed && value >= range[0] && value <= range[1]);
            if (!candidate) throw Error();
            setPending({ original: { ...original, sampleRate: current.nominalSampleRateHz, bufferSize: fixed }, before, candidate });
        } catch { setDeviceMissing(false); setError(true); } finally { operation.current = false; setBusy(false); }
    }
    async function start(config: AudioPreferences, expectedState?: AudioStateInfo) {
        const actual = await audioApi.start(config.host, config.input, config.output, config.bufferSize, config.sampleRate, config.inputId, config.outputId, expectedState);
        const applied = { ...config, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size };
        if (config.inputChannels) await audioApi.setInputChannels(...config.inputChannels);
        await onApplied(applied);
        return applied;
    }
    async function restoreChecked(config: AudioPreferences, expectedState: AudioStateInfo) {
        const applied = await start(config, expectedState);
        const [state, verified] = await Promise.all([audioApi.getAudioState(), audioApi.getAudioStreamState()]);
        if (!verified.running || verified.streamFailed || !sameDevices(state, config)
            || applied.sampleRate !== config.sampleRate || applied.bufferSize !== config.bufferSize) throw Error();
    }
    async function apply() {
        if (!pending || operation.current) return;
        operation.current = true; setBusy(true); setError(false); setHeard(false);
        try {
            await liveModesApi.preflight();
            const [current, expectedState] = await Promise.all([audioApi.getEngineRuntimeStats(), audioApi.getAudioState()]);
            if (condition(current) !== condition(pending.before) || !current.latencyMetadata?.streamRunning || !sameDevices(expectedState, pending.original)) throw Error();
            // 障害や画面終了後も原本を残し、不完全な復元を成功扱いしない。
            persistOriginal(pending.original); setRecovery({kind: 'saved', original: pending.original});
            const applied = await start({ ...pending.original, bufferSize: pending.candidate }, expectedState);
            const [after, appliedState] = await Promise.all([audioApi.getEngineRuntimeStats(), audioApi.getAudioState()]);
            if (!sameDevices(appliedState, pending.original)) throw Error();
            setTrial({ original: pending.original, applied, before: pending.before, after, condition: condition(after), requested: pending.candidate });
            setPending(null);
        } catch { setRecovery(readRecovery()); setDeviceMissing(false); setError(true); } finally { operation.current = false; setBusy(false); }
    }
    async function finish(keep: boolean) {
        if (!trial || operation.current) return;
        operation.current = true; setBusy(true); setError(false);
        try {
            await liveModesApi.preflight();
            const latest = await audioApi.getEngineRuntimeStats();
            if (!latest.latencyMetadata?.streamRunning || condition(latest) !== trial.condition) throw Error();
            const state = await audioApi.getAudioState();
            if (!sameDevices(state, trial.original)) throw Error();
            if (keep) {
                if (!heard) return;
                localStorage.setItem('auralyn_monitor_trial_result', JSON.stringify({ checkedAt: Date.now(), requested: trial.requested, applied: trial.applied, before: trial.before, after: latest, original: trial.original }));
                setAccepted(true);
            } else {
                await restoreChecked(trial.original, state);
            }
            removeOriginal(); setRecovery({kind: 'none'}); setTrial(null); setHeard(false);
        } catch { setRecovery(readRecovery()); setDeviceMissing(false); setError(true); } finally { operation.current = false; setBusy(false); }
    }
    return <section aria-label={t('monitorTrial.title')} className="space-y-3 border border-border rounded p-3">
        <h3 className="font-semibold">{t('monitorTrial.title')}</h3>
        <p className="text-sm">{t('monitorTrial.scope')}</p>
        <button disabled={busy || disabled || !!trial || !!pending || recovery.kind !== 'none'} onClick={() => void prepare()} className="underline disabled:opacity-50">{t('monitorTrial.prepare')}</button>
        {pending && <div className="space-y-2"><p>{t('monitorTrial.change', { before: pending.original.bufferSize!, after: pending.candidate, rate: pending.original.sampleRate! })}</p>
            {monitorAdvice(pending.before).length > 0 && <details><summary>{t('monitorTrial.fxPlans')}</summary><ul className="list-disc pl-4 text-sm">{monitorAdvice(pending.before).map((a, index) => <li key={index}>{t(`monitorTrial.advice.${a.kind}`, { name: a.name ?? '', samples: a.samples ?? '' })}</li>)}</ul><p className="text-xs">{t('monitorTrial.fxBoundary')}</p></details>}
            <p className="text-sm">{t('monitorTrial.warning')}</p>
            <button disabled={busy || disabled || recovery.kind !== 'none'} onClick={() => void apply()} className="border rounded p-2">{t('monitorTrial.apply')}</button>{' '}
            <button disabled={busy || disabled} onClick={() => setPending(null)} className="link-button">{t('monitorTrial.cancel')}</button>
        </div>}
        {trial && <div className="space-y-2"><p>{t('monitorTrial.requested', { frames: trial.requested })}</p>
            <p>{t('monitorTrial.actual', { rate: trial.applied.sampleRate!, frames: trial.applied.bufferSize! })}</p>
            <details><summary>{t('monitorTrial.before')}</summary>{recorded(trial.before)}</details>
            <button disabled={busy || disabled} className="link-button" onClick={async () => {
                setBusy(true); setError(false); setHeard(false);
                try { const after = await audioApi.getEngineRuntimeStats(); if (condition(after) !== trial.condition || !after.latencyMetadata?.streamRunning) throw Error(); setTrial({ ...trial, after }); } catch { setError(true); } finally { setBusy(false); }
            }}>{t('monitorTrial.refresh')}</button>
            <LatencyDetails stats={trial.after} />
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={heard} onChange={event => setHeard(event.target.checked)} />{t('monitorTrial.heard')}</label>
            <button disabled={busy || disabled || !heard} className="border rounded p-2 disabled:opacity-50" onClick={() => void finish(true)}>{t('monitorTrial.keep')}</button>{' '}
            <button disabled={busy || disabled} className="link-button" onClick={() => void finish(false)}>{t('monitorTrial.restore')}</button>
        </div>}
        {recovery.kind !== 'none' && !trial && <div className="space-y-2">
            {recoveryOriginal ? <p>{t('monitorTrial.recovery', { input: recoveryOriginal.input ?? '', output: recoveryOriginal.output ?? '', rate: recoveryOriginal.sampleRate!, frames: recoveryOriginal.bufferSize! })}</p> : <p role="alert">{t('monitorTrial.recoveryUnreadable')}</p>}
            {recoveryOriginal && <><label className="flex gap-2 text-sm"><input type="checkbox" checked={recoverConfirmed} onChange={async e => {
                const checked = e.target.checked; const generation = ++confirmationGeneration.current;
                setRecoverConfirmed(checked); setConfirmedBasis(null);
                if (!checked) return;
                try {
                    const [stats, state] = await Promise.all([audioApi.getEngineRuntimeStats(), audioApi.getAudioState()]);
                    if (!stats.latencyMetadata?.streamRunning || !state.is_running || !state.config) throw Error();
                    if (generation === confirmationGeneration.current) setConfirmedBasis(JSON.stringify([condition(stats), state]));
                } catch { if (generation === confirmationGeneration.current) { setDeviceMissing(false); setError(true); } }
            }} />{t('monitorTrial.recoverConfirm')}</label>
            <button className="border rounded p-2 disabled:opacity-50" disabled={busy || disabled || !recoverConfirmed || !confirmedBasis} onClick={async () => {
                if (operation.current) return;
                operation.current = true; setBusy(true); setError(false);
                try {
                    await liveModesApi.preflight();
                    const [stream, list, before, expectedState] = await Promise.all([audioApi.getAudioStreamState(), audioApi.getDevices(true), audioApi.getEngineRuntimeStats(), audioApi.getAudioState()]);
                    const match = (d: AudioDevice, id: string | undefined, name: string | undefined, input: boolean) => d.id === id && d.host === recoveryOriginal.host && d.name === name && d.is_input === input;
                    if (!stream.running || stream.streamFailed || !before.latencyMetadata?.streamRunning
                        || !sameDevices(expectedState, recoveryOriginal)
                        || list.inputs.filter(d => match(d, recoveryOriginal.inputId, recoveryOriginal.input, true)).length !== 1
                        || list.outputs.filter(d => match(d, recoveryOriginal.outputId, recoveryOriginal.output, false)).length !== 1) throw new RecoveryDeviceError();
                    if (JSON.stringify([condition(before), expectedState]) !== confirmedBasis) throw Error();
                    const afterDevices = await audioApi.getEngineRuntimeStats();
                    if (!afterDevices.latencyMetadata?.streamRunning || condition(before) !== condition(afterDevices)) throw Error();
                    await restoreChecked(recoveryOriginal, expectedState);
                    removeOriginal(); setRecovery({kind: 'none'}); setRecoverConfirmed(false); setConfirmedBasis(null);
                } catch (cause) { setRecovery(readRecovery()); setDeviceMissing(cause instanceof RecoveryDeviceError); setError(true); setRecoverConfirmed(false); setConfirmedBasis(null); } finally { operation.current = false; setBusy(false); }
            }}>{t('monitorTrial.recover')}</button></>}
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={adoptConfirmed} onChange={e => setAdoptConfirmed(e.target.checked)} />{t('monitorTrial.recoveryAdoptConfirm')}</label>
            <button className="border rounded p-2 disabled:opacity-50" disabled={busy || disabled || !adoptConfirmed} onClick={() => {
                if (operation.current) return;
                operation.current = true; setBusy(true); setError(false);
                try { removeOriginal(); setRecovery({kind:'none'}); setAdoptConfirmed(false); } catch { setRecovery(readRecovery()); setError(true); }
                finally { operation.current = false; setBusy(false); }
            }}>{t('monitorTrial.recoveryAdopt')}</button>
        </div>}
        {accepted && <p role="status">{t('monitorTrial.accepted')}</p>}
        {error && <p role="alert" className="text-destructive-text">{t(deviceMissing ? 'monitorTrial.recoveryDeviceMissing' : 'monitorTrial.error')}</p>}
    </section>;
}
