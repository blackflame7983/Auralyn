import { useEffect, useState } from 'react';
import { audioApi, type AudioDevice, type EngineRuntimeStats } from '@/api/audio';
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
export function MonitorTrial({ devices, onApplied, onBusyChange, disabled = false }: { disabled?: boolean; onBusyChange?: (busy: boolean) => void; devices: AudioDevice[]; onApplied: (config: AudioPreferences) => Promise<void> }) {
    const t = useMessages();
    const [recovery, setRecovery] = useState<AudioPreferences | null>(() => {
        try { const data = JSON.parse(sessionStorage.getItem('auralyn_monitor_trial_original') ?? 'null'); return data && typeof data.host === 'string' && typeof data.inputId === 'string' && typeof data.outputId === 'string' && Number.isSafeInteger(data.sampleRate) && data.sampleRate > 0 && data.sampleRate <= 768000 && Number.isSafeInteger(data.bufferSize) && data.bufferSize > 0 && data.bufferSize <= 4096 ? data : null; } catch { return null; }
    });
    const [recoverConfirmed, setRecoverConfirmed] = useState(false);
    const [trial, setTrial] = useState<Trial | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
    const [error, setError] = useState(false);
    const [heard, setHeard] = useState(false);
    const [accepted, setAccepted] = useState(false);
    const [pending, setPending] = useState<{ original: AudioPreferences; before: EngineRuntimeStats; candidate: number } | null>(null);
    const recorded = (s: EngineRuntimeStats) => {
        const q = s.resamplerCohortTiming?.periods?.recent.earliestArrivalToEnd;
        const range = (r: { lowerMs: number; upperMs: number | null } | null | undefined) => !r || !Number.isFinite(r.lowerMs) || r.lowerMs < 0 || (r.upperMs !== null && (!Number.isFinite(r.upperMs) || r.upperMs <= r.lowerMs)) ? t('singingRoute.unknown') : r.upperMs === null ? t('batchTiming.rangeOpen', { lower: r.lowerMs.toFixed(2) }) : `${r.lowerMs.toFixed(2)}–${r.upperMs.toFixed(2)} ms`;
        return <p className="text-sm">{t('monitorTrial.recorded', { p50: range(q?.p50), p95: range(q?.p95), glitches: Number.isSafeInteger(s.glitchCount) && s.glitchCount >= 0 ? s.glitchCount : t('singingRoute.unknown') })}</p>;
    };
    async function prepare() {
        setBusy(true); setError(false); setAccepted(false);
        try {
            await liveModesApi.preflight();
            const original = readAudioPreferences();
            const before = await audioApi.getEngineRuntimeStats();
            const current = before.latencyMetadata;
            const range = devices.find(d => d.id === original?.outputId && d.host === original?.host)?.buffer_size_range;
            const fixed = current?.fixedBufferRequestFrames;
            if (!original?.inputId || !original.outputId || !current?.streamRunning || !fixed || !range || !current.nominalSampleRateHz) throw Error();
            const candidate = [128, 256, 512].find(value => value < fixed && value >= range[0] && value <= range[1]);
            if (!candidate) throw Error();
            setPending({ original: { ...original, sampleRate: current.nominalSampleRateHz, bufferSize: fixed }, before, candidate });
        } catch { setError(true); } finally { setBusy(false); }
    }
    async function start(config: AudioPreferences) {
        const actual = await audioApi.start(config.host, config.input, config.output, config.bufferSize, config.sampleRate, config.inputId, config.outputId);
        const applied = { ...config, sampleRate: actual.sample_rate, bufferSize: actual.buffer_size };
        if (config.inputChannels) await audioApi.setInputChannels(...config.inputChannels);
        await onApplied(applied);
        return applied;
    }
    async function apply() {
        if (!pending) return;
        setBusy(true); setError(false); setHeard(false);
        try {
            await liveModesApi.preflight();
            const current = await audioApi.getEngineRuntimeStats();
            if (condition(current) !== condition(pending.before) || !current.latencyMetadata?.streamRunning) throw Error();
            // 障害や画面終了後も原本を残し、不完全な復元を成功扱いしない。
            sessionStorage.setItem('auralyn_monitor_trial_original', JSON.stringify(pending.original)); setRecovery(pending.original);
            const applied = await start({ ...pending.original, bufferSize: pending.candidate });
            const after = await audioApi.getEngineRuntimeStats();
            setTrial({ original: pending.original, applied, before: pending.before, after, condition: condition(after), requested: pending.candidate });
            setPending(null);
        } catch { setError(true); } finally { setBusy(false); }
    }
    async function finish(keep: boolean) {
        if (!trial) return;
        setBusy(true); setError(false);
        try {
            await liveModesApi.preflight();
            const latest = await audioApi.getEngineRuntimeStats();
            if (!latest.latencyMetadata?.streamRunning || condition(latest) !== trial.condition) throw Error();
            if (keep) {
                if (!heard) return;
                localStorage.setItem('auralyn_monitor_trial_result', JSON.stringify({ checkedAt: Date.now(), requested: trial.requested, applied: trial.applied, before: trial.before, after: latest, original: trial.original }));
                setAccepted(true);
            } else { await start(trial.original); }
            sessionStorage.removeItem('auralyn_monitor_trial_original'); setRecovery(null); setTrial(null); setHeard(false);
        } catch { setError(true); } finally { setBusy(false); }
    }
    return <section aria-label={t('monitorTrial.title')} className="space-y-3 border border-border rounded p-3">
        <h3 className="font-semibold">{t('monitorTrial.title')}</h3>
        <p className="text-sm">{t('monitorTrial.scope')}</p>
        <button disabled={busy || disabled || !!trial || !!pending || !!recovery} onClick={() => void prepare()} className="underline disabled:opacity-50">{t('monitorTrial.prepare')}</button>
        {pending && <div className="space-y-2"><p>{t('monitorTrial.change', { before: pending.original.bufferSize!, after: pending.candidate, rate: pending.original.sampleRate! })}</p>
            {monitorAdvice(pending.before).length > 0 && <details><summary>{t('monitorTrial.fxPlans')}</summary><ul className="list-disc pl-4 text-sm">{monitorAdvice(pending.before).map((a, index) => <li key={index}>{t(`monitorTrial.advice.${a.kind}`, { name: a.name ?? '', samples: a.samples ?? '' })}</li>)}</ul><p className="text-xs">{t('monitorTrial.fxBoundary')}</p></details>}
            <p className="text-sm">{t('monitorTrial.warning')}</p>
            <button disabled={busy || disabled} onClick={() => void apply()} className="border rounded p-2">{t('monitorTrial.apply')}</button>{' '}
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
        {recovery && !trial && <div className="space-y-2">
            <p>{t('monitorTrial.recovery', { input: recovery.input ?? '', output: recovery.output ?? '', rate: recovery.sampleRate!, frames: recovery.bufferSize! })}</p>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={recoverConfirmed} onChange={e => setRecoverConfirmed(e.target.checked)} />{t('monitorTrial.recoverConfirm')}</label>
            <button className="border rounded p-2 disabled:opacity-50" disabled={busy || disabled || !recoverConfirmed} onClick={async () => {
                setBusy(true); setError(false);
                try { await liveModesApi.preflight(); await start(recovery); sessionStorage.removeItem('auralyn_monitor_trial_original'); setRecovery(null); setRecoverConfirmed(false); } catch { setError(true); } finally { setBusy(false); }
            }}>{t('monitorTrial.recover')}</button>
        </div>}
        {accepted && <p role="status">{t('monitorTrial.accepted')}</p>}
        {error && <p role="alert" className="text-destructive-text">{t('monitorTrial.error')}</p>}
    </section>;
}
