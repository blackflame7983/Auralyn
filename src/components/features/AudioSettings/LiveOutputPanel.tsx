import { defaultSinging, defaultReverb } from '@/api/builtinEffects';
import { useEffect, useRef, useState } from 'react';
import type { AudioDevice } from '@/api/audio';
import { audioApi } from '@/api/audio';
import { liveOutputApi, type LiveOutputConfig, type LiveOutputStatus } from '@/api/liveOutput';
import { useMessages } from '@/i18n/LocaleProvider';

export function LiveOutputPanel({ outputs, onBusyChange, disabled = false }: { disabled?: boolean; outputs: AudioDevice[]; onBusyChange?: (busy: boolean) => void }) {
    const t = useMessages();
    const sequence = useRef(0);
    const busyNow = useRef(false);
    const savedStatus = useRef<HTMLParagraphElement>(null);
    const focusAfterSave = useRef(false);
    const [status, setStatus] = useState<LiveOutputStatus | null>(null);
    const [previous, setPrevious] = useState<LiveOutputConfig | null>(null);
    const [draft, setDraft] = useState<LiveOutputConfig | null>(null);
    const [busy, setBusy] = useState(false);
    busyNow.current = busy;
    useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
    const [error, setError] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    useEffect(() => { if (!busy && status && focusAfterSave.current) { focusAfterSave.current = false; savedStatus.current?.focus(); } }, [busy, status]);
    useEffect(() => {
        if (!status) return;
        let active = true; let reading = false;
        const timer = setInterval(async () => {
            if (!active || reading || busyNow.current || document.hidden) return;
            reading = true; const ticket = sequence.current;
            try { const next = await liveOutputApi.request(); if (active && ticket === sequence.current) setStatus(next); }
            catch { if (active && ticket === sequence.current) { setStatus(value => value ? { ...value, sink: null, error: 'unavailable' } : null); setError(true); } }
            finally { reading = false; }
        }, 1000);
        return () => { active = false; clearInterval(timer); };
    }, [Boolean(status)]);
    async function request(save = false) {
        sequence.current++;
        setBusy(true); setError(false);
        try { const received = await liveOutputApi.request(save ? draft : null); if (save && status) setPrevious(status.config); focusAfterSave.current = save; setStatus(received); setDraft(received.config); setConfirmed(false); }
        catch { focusAfterSave.current = false; setError(true); } finally { setBusy(false); }
    }
    return <section className="space-y-3 border border-border rounded p-3" aria-label={t('liveOutput.title')}>
        <h3 className="font-semibold">{t('liveOutput.title')}</h3>
        <p className="text-sm">{t('liveOutput.scope')}</p>
        <details className="text-xs"><summary>{t('liveOutput.limitsTitle')}</summary><p>{t('liveOutput.limits')}</p><p>{t('liveOutput.saveBoundary')}</p></details>
        <button disabled={busy || disabled} className="underline" onClick={() => void request()}>{t('liveOutput.refresh')}</button>
        {draft && <div className="space-y-3">
            <label className="block text-sm">{t('liveOutput.device')}<select className="w-full p-2 bg-background border rounded" disabled={busy || disabled} value={draft.deviceId ?? ''} onChange={e => { const deviceId = e.target.value || null; setDraft({ ...draft, deviceId, splitProcessing: deviceId ? draft.splitProcessing : false }); setConfirmed(false); }}>
                <option value="">{t('liveOutput.disabled')}</option>
                {outputs.filter(d => d.host.toLowerCase().includes('wasapi') && d.id && d.channels === 2).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                {draft.deviceId && !outputs.some(d => d.id === draft.deviceId) && <option value={draft.deviceId}>{t('liveOutput.missing')}</option>}
            </select></label>
            <label className="flex gap-2 text-sm"><input disabled={busy || disabled || !draft.deviceId} type="checkbox" checked={!!draft.splitProcessing} onChange={e => { setDraft({ ...draft, splitProcessing: e.target.checked, monitorSinging: draft.monitorSinging ?? { active: true, preset: 'singing', amount: 0.35, singing: defaultSinging, reverb: { ...defaultReverb, enabled: true, mix: 0.05 } }, monitorTalk: draft.monitorTalk ?? { active: true, preset: 'singing', amount: 0.35, singing: defaultSinging, reverb: defaultReverb } }); setConfirmed(false); }} />{t('liveOutput.split')}</label>
            {draft.splitProcessing && <p className="text-sm">{t('liveOutput.splitScope')}</p>}
            {draft.splitProcessing && (['monitorSinging', 'monitorTalk'] as const).map(role => <fieldset key={role} className="space-y-2"><legend>{t(`liveOutput.${role}`)}</legend>
                <label className="block text-sm">{t('liveOutput.brightness')} ({draft[role]?.singing?.brightnessDb ?? 0} dB)<input className="block w-full" disabled={busy || disabled} type="range" min="-3" max="3" step="0.5" value={draft[role]?.singing?.brightnessDb ?? 0} onChange={e => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, singing: { ...(config.singing ?? defaultSinging), brightnessDb: Number(e.target.value) } } }); setConfirmed(false); } }} /></label>
                <label className="block text-sm">{t('liveOutput.dynamics')} ({Math.round((draft[role]?.singing?.dynamics ?? 0.35) * 100)}%)<input className="block w-full" disabled={busy || disabled} type="range" min="0" max="1" step="0.05" value={draft[role]?.singing?.dynamics ?? 0.35} onChange={e => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, singing: { ...(config.singing ?? defaultSinging), dynamics: Number(e.target.value) } } }); setConfirmed(false); } }} /></label>
                {role === 'monitorSinging' && <label className="block text-sm">{t('liveOutput.reverb')} ({Math.round((draft[role]?.reverb?.mix ?? 0) * 100)}%)<input className="block w-full" disabled={busy || disabled} type="range" min="0" max="0.2" step="0.01" value={draft[role]?.reverb?.mix ?? 0} onChange={e => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, reverb: { ...(config.reverb ?? defaultReverb), enabled: Number(e.target.value) > 0, mix: Number(e.target.value) } } }); setConfirmed(false); } }} /></label>}
            </fieldset>)}
            {(['monitorTrim', 'broadcastTrim'] as const).map(key => <label className="block text-sm" key={key}>{t(`liveOutput.${key}`)} ({Math.round(draft[key] * 100)}%)<input className="block w-full" type="range" min="0" max="100" disabled={busy || disabled} value={draft[key] * 100} onChange={e => { setDraft({ ...draft, [key]: Number(e.target.value) / 100 }); setConfirmed(false); }} /></label>)}
            <label className="flex gap-2 text-sm"><input disabled={busy || disabled} type="checkbox" checked={draft.monitorMuted} onChange={e => { setDraft({ ...draft, monitorMuted: e.target.checked }); setConfirmed(false); }} />{t('liveOutput.monitorMuted')}</label>
            <p className="text-xs">{t('liveOutput.diff', { before: status?.config.deviceId ? t('liveOutput.enabled') : t('liveOutput.disabled'), after: draft.deviceId ? t('liveOutput.enabled') : t('liveOutput.disabled') })}</p>
            <label className="flex gap-2 text-sm"><input disabled={busy || disabled} type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('liveOutput.confirm')}</label>
            <button disabled={busy || disabled || !confirmed} className="border rounded p-2 disabled:opacity-50" onClick={() => void request(true)}>{t('liveOutput.save')}</button>{' '}
            <button disabled={busy || disabled} className="underline" onClick={() => { setDraft(status?.config ?? null); setConfirmed(false); }}>{t('monitorTrial.cancel')}</button>
        </div>}
        {previous && <button disabled={busy || disabled} className="underline" onClick={() => { setDraft(previous); setConfirmed(false); }}>{t('liveOutput.undo')}</button>}
        <button disabled={busy || disabled} className="underline" onClick={async () => { setBusy(true); try { await audioApi.stop(); await request(); } catch { setError(true); } finally { setBusy(false); } }}>{t('liveOutput.stop')}</button>
        {status && <p ref={savedStatus} tabIndex={-1} role="status" className="text-sm">{t(status.error || status.sink?.failed ? 'liveOutput.failed' : status.sink?.active ? 'liveOutput.active' : 'liveOutput.inactive')}</p>}
        {status?.monitor && <p className="text-xs">{t('liveOutput.monitorCounts', { queued: status.monitor.broadcastQueueFrames, offered: status.monitor.offeredFrames, dropped: status.monitor.droppedFrames, accepted: status.monitor.acceptedRevision, completed: status.monitor.completedRevision })}</p>}
        {status?.sink && <p className="text-xs">{t('liveOutput.counts', { queued: status.sink.queuedFrames, zero: status.sink.zeroFilledFrames, dropped: status.sink.droppedFrames, rate: status.sink.rateHz })}</p>}
        {error && <p role="alert" className="text-destructive text-sm">{t('liveOutput.error')}</p>}
    </section>;
}
