import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { defaultSinging, defaultReverb } from '@/api/builtinEffects';
import { useEffect, useRef, useState } from 'react';
import type { AudioDevice } from '@/api/audio';
import { audioApi } from '@/api/audio';
import { liveOutputApi, type LiveOutputConfig, type LiveOutputStatus } from '@/api/liveOutput';
import { useMessages } from '@/i18n/LocaleProvider';
import { Button } from '@/components/ui/button';
import { AudioFlow } from '@/components/ui/AudioFlow';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

export function LiveOutputPanel({ outputs, inputName, monitorName, onBusyChange, disabled = false, autoLoad = false }: { autoLoad?: boolean; disabled?: boolean; outputs: AudioDevice[]; inputName?: string; monitorName?: string; onBusyChange?: (busy: boolean) => void }) {
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
    const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
    const stopButton = useRef<HTMLButtonElement>(null);
    const restoreStopFocus = useRef(false);
    useEffect(() => {
        const button = stopButton.current;
        // 親のbusy通知が反映され、操作可能になってからフォーカスを戻す。
        if (!busy && !disabled && restoreStopFocus.current && button && !button.disabled) {
            button.focus();
            if (document.activeElement === button) restoreStopFocus.current = false;
        }
    }, [busy, disabled]);
    useEffect(() => { if (!busy && status && focusAfterSave.current) { focusAfterSave.current = false; savedStatus.current?.focus(); } }, [busy, status]);
    useEffect(() => {
        if (!status) return;
        let active = true; let reading = false;
        const read = async () => {
            if (!active || reading || busyNow.current || isAppHidden()) return;
            reading = true; const ticket = sequence.current;
            try { const next = await liveOutputApi.request(); if (active && ticket === sequence.current) setStatus(next); }
            catch { if (active && ticket === sequence.current) { setStatus(value => value ? { ...value, sink: null, error: 'unavailable' } : null); setError(true); } }
            finally { reading = false; }
        };
        const visible = () => { if (!isAppHidden()) void read(); };
        const timer = setInterval(() => void read(), 1000);
        addAppVisibilityListener(visible);
        return () => { active = false; clearInterval(timer); removeAppVisibilityListener(visible); };
    }, [Boolean(status)]);
    useEffect(() => { if (autoLoad) void request(); return () => { sequence.current++; }; }, [autoLoad]);
    async function request(save = false) {
        const ticket = ++sequence.current;
        setBusy(true); setError(false);
        try { const received = await liveOutputApi.request(save ? draft : null); if (ticket !== sequence.current) return; if (save && status) setPrevious(status.config); focusAfterSave.current = save; setStatus(received); setDraft(received.config); setConfirmed(false); }
        catch { if (ticket === sequence.current) { focusAfterSave.current = false; setError(true); } } finally { if (ticket === sequence.current) setBusy(false); }
    }
    return <section className="space-y-3 border border-border rounded p-3" aria-label={t('liveOutput.title')}>
        <h3 className="text-ui-heading font-semibold">{t('liveOutput.title')}</h3>
        <p className="text-sm">{t('liveOutput.scope')}</p>
        <details className="text-ui-support"><summary>{t('liveOutput.limitsTitle')}</summary><p>{t('liveOutput.limits')}</p><p>{t('liveOutput.saveBoundary')}</p></details>
        <button disabled={busy || disabled} className="link-button text-ui-support" onClick={() => void request()}>{t('liveOutput.refresh')}</button>
        {draft && <div className="space-y-3">
            {draft.deviceId && <AudioFlow label={t('flow.diagram')} unknownLabel={t('settings.selectDevice')} processingWarning={draft.deviceId === status?.config.deviceId && status.error && !status.sink?.failed ? t('prep.failed') : undefined}
                input={{ label: t('processInput.source'), value: inputName }}
                output={{ label: t('flow.monitorOutput'), value: monitorName }}
                receiver={{ label: t('prep.receiver'), value: t('flow.receiverUnknown') }}
                branches={[{ label: t('flow.broadcastOutput'), value: outputs.find(device => device.id === draft.deviceId)?.name ?? t('liveOutput.missing'), warning: draft.deviceId === status?.config.deviceId && status.sink?.failed ? t('flow.checkOutput') : undefined }]} /> }
            <label className="block text-ui-control">{t('liveOutput.device')}<select className="w-full p-2 bg-background border rounded text-ui-control" disabled={busy || disabled} value={draft.deviceId ?? ''} onChange={e => { const deviceId = e.target.value || null; setDraft({ ...draft, deviceId, splitProcessing: deviceId ? draft.splitProcessing : false }); setConfirmed(false); }}>
                <option value="">{t('liveOutput.disabled')}</option>
                {outputs.filter(d => d.host.toLowerCase().includes('wasapi') && d.id && d.channels === 2).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                {draft.deviceId && !outputs.some(d => d.id === draft.deviceId) && <option value={draft.deviceId}>{t('liveOutput.missing')}</option>}
            </select></label>
            <label className="flex gap-2 text-ui-control"><input disabled={busy || disabled || !draft.deviceId} type="checkbox" checked={!!draft.splitProcessing} onChange={e => { setDraft({ ...draft, splitProcessing: e.target.checked, monitorSinging: draft.monitorSinging ?? { active: true, preset: 'singing', amount: 0.35, singing: defaultSinging, reverb: { ...defaultReverb, enabled: true, mix: 0.05 } }, monitorTalk: draft.monitorTalk ?? { active: true, preset: 'singing', amount: 0.35, singing: defaultSinging, reverb: defaultReverb } }); setConfirmed(false); }} />{t('liveOutput.split')}</label>
            {draft.splitProcessing && <p className="text-sm">{t('liveOutput.splitScope')}</p>}
            {draft.splitProcessing && (['monitorSinging', 'monitorTalk'] as const).map(role => <fieldset key={role} className="space-y-2"><legend className="text-ui-control font-semibold">{t(`liveOutput.${role}`)}</legend>
                <label className="block text-ui-control">{t('liveOutput.brightness')} ({draft[role]?.singing?.brightnessDb ?? 0} dB)<input className="block w-full" disabled={busy || disabled} type="range" min="-3" max="3" step="0.5" value={draft[role]?.singing?.brightnessDb ?? 0} onChange={e => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, singing: { ...(config.singing ?? defaultSinging), brightnessDb: Number(e.target.value) } } }); setConfirmed(false); } }} /></label>
                <label className="block text-ui-control">{t('liveOutput.dynamics')} ({Math.round((draft[role]?.singing?.dynamics ?? 0.35) * 100)}%)<input className="block w-full" disabled={busy || disabled} type="range" min="0" max="1" step="0.05" value={draft[role]?.singing?.dynamics ?? 0.35} onChange={e => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, singing: { ...(config.singing ?? defaultSinging), dynamics: Number(e.target.value) } } }); setConfirmed(false); } }} /></label>
                {role === 'monitorSinging' && <label className="block text-ui-control">{t('liveOutput.reverb')} ({Math.round((draft[role]?.reverb?.mix ?? 0) * 100)}%)<input className="block w-full" disabled={busy || disabled} type="range" min="0" max="0.2" step="0.01" value={draft[role]?.reverb?.mix ?? 0} onChange={e => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, reverb: { ...(config.reverb ?? defaultReverb), enabled: Number(e.target.value) > 0, mix: Number(e.target.value) } } }); setConfirmed(false); } }} /></label>}
            </fieldset>)}
            {(['monitorTrim', 'broadcastTrim'] as const).map(key => <label className="block text-ui-control" key={key}>{t(`liveOutput.${key}`)} ({Math.round(draft[key] * 100)}%)<input className="block w-full" type="range" min="0" max="100" disabled={busy || disabled} value={draft[key] * 100} onChange={e => { setDraft({ ...draft, [key]: Number(e.target.value) / 100 }); setConfirmed(false); }} /></label>)}
            <label className="flex gap-2 text-ui-control"><input disabled={busy || disabled} type="checkbox" checked={draft.monitorMuted} onChange={e => { setDraft({ ...draft, monitorMuted: e.target.checked }); setConfirmed(false); }} />{t('liveOutput.monitorMuted')}</label>
            <p className="text-ui-support">{t('liveOutput.diff', { before: status?.config.deviceId ? t('liveOutput.enabled') : t('liveOutput.disabled'), after: draft.deviceId ? t('liveOutput.enabled') : t('liveOutput.disabled') })}</p>
            <label className="flex gap-2 text-ui-control"><input disabled={busy || disabled} type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('liveOutput.confirm')}</label>
            <button disabled={busy || disabled || !confirmed} className="border rounded p-2 disabled:opacity-50 text-ui-control" onClick={() => void request(true)}>{t('liveOutput.save')}</button>{' '}
            <button disabled={busy || disabled} className="link-button text-ui-support" onClick={() => { setDraft(status?.config ?? null); setConfirmed(false); }}>{t('monitorTrial.cancel')}</button>
        </div>}
        {previous && <button disabled={busy || disabled} className="link-button text-ui-support" onClick={() => { setDraft(previous); setConfirmed(false); }}>{t('liveOutput.undo')}</button>}
        <div className="space-y-2 border-t border-border pt-3">
            <p id="live-output-stop-warning" className="text-sm">{t('liveOutput.stopWarning')}</p>
            <Button ref={stopButton} type="button" variant="outline" disabled={busy || disabled} aria-describedby="live-output-stop-warning" className="border-destructive-text bg-destructive/10 text-foreground hover:bg-destructive/20 text-ui-control" onClick={() => setStopConfirmOpen(true)}>{t('liveOutput.stop')}</Button>
        </div>
        <ConfirmDialog
            isOpen={stopConfirmOpen}
            title={t('liveOutput.stopTitle')}
            description={t('liveOutput.stopWarning')}
            confirmLabel={t('liveOutput.stop')}
            variant="destructive"
            onCancel={() => setStopConfirmOpen(false)}
            onConfirm={async () => {
                setStopConfirmOpen(false);
                if (busyNow.current || disabled) return;
                busyNow.current = true;
                sequence.current++;
                restoreStopFocus.current = true;
                setBusy(true);
                try { await audioApi.stop(); await request(); }
                catch { setError(true); }
                finally { setBusy(false); }
            }}
        />
        {status && <p ref={savedStatus} tabIndex={-1} role="status" className="text-sm">{t(status.error || status.sink?.failed ? 'liveOutput.failed' : status.sink?.active ? 'liveOutput.active' : 'liveOutput.inactive')}</p>}
        {status?.monitor && <p className="text-ui-support">{t('liveOutput.monitorCounts', { queued: status.monitor.broadcastQueueFrames, offered: status.monitor.offeredFrames, dropped: status.monitor.droppedFrames, accepted: status.monitor.acceptedRevision, completed: status.monitor.completedRevision })}</p>}
        {status?.sink && <p className="text-ui-support">{t('liveOutput.counts', { queued: status.sink.queuedFrames, zero: status.sink.zeroFilledFrames, dropped: status.sink.droppedFrames, rate: status.sink.rateHz })}</p>}
        {error && <p role="alert" className="text-destructive-text text-sm">{t('liveOutput.error')}</p>}
    </section>;
}
