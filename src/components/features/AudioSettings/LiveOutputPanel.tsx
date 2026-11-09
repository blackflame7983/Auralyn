import { SliderField } from '@/components/ui/SliderField';
import { Checkbox } from '@/components/ui/Checkbox';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
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
    return <section className="space-y-3 border border-border rounded-control p-3" aria-label={t('liveOutput.title')}>
        <h3 className="text-ui-heading font-semibold">{t('liveOutput.title')}</h3>
        <p className="text-ui-support">{t('liveOutput.scope')}</p>
        <p className="text-ui-support text-muted-foreground">{t('settings.apply.outputDraft')}</p>
        <details className="text-ui-support"><summary>{t('liveOutput.limitsTitle')}</summary><p>{t('liveOutput.limits')}</p><p>{t('liveOutput.saveBoundary')}</p></details>
        <Button disabled={busy || disabled} variant="link" size="sm" className="h-auto min-h-9 whitespace-normal" onClick={() => void request()}>{t('liveOutput.refresh')}</Button>
        {draft && <div className="space-y-3">
            {draft.deviceId && <AudioFlow label={t('flow.diagram')} unknownLabel={t('settings.selectDevice')} processingWarning={draft.deviceId === status?.config.deviceId && status.error && !status.sink?.failed ? t('prep.failed') : undefined}
                input={{ label: t('processInput.source'), value: inputName }}
                output={{ label: t('flow.monitorOutput'), value: monitorName }}
                receiver={{ label: t('prep.receiver'), value: t('flow.receiverUnknown') }}
                branches={[{ label: t('flow.broadcastOutput'), value: outputs.find(device => device.id === draft.deviceId)?.name ?? t('liveOutput.missing'), warning: draft.deviceId === status?.config.deviceId && status.sink?.failed ? t('flow.checkOutput') : undefined }]} /> }
            <Field label={t('liveOutput.device')}><Select  disabled={busy || disabled} value={draft.deviceId ?? ''} onChange={e => { const deviceId = e.target.value || null; setDraft({ ...draft, deviceId, splitProcessing: deviceId ? draft.splitProcessing : false }); setConfirmed(false); }}>
                <option value="">{t('liveOutput.disabled')}</option>
                {outputs.filter(d => d.host.toLowerCase().includes('wasapi') && d.id && d.channels === 2).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                {draft.deviceId && !outputs.some(d => d.id === draft.deviceId) && <option value={draft.deviceId}>{t('liveOutput.missing')}</option>}
            </Select></Field>
            <label className="flex gap-2 text-ui-control"><Checkbox disabled={busy || disabled || !draft.deviceId}  checked={!!draft.splitProcessing} onChange={e => { setDraft({ ...draft, splitProcessing: e.target.checked, monitorSinging: draft.monitorSinging ?? { active: true, preset: 'singing', amount: 0.35, singing: defaultSinging, reverb: { ...defaultReverb, enabled: true, mix: 0.05 } }, monitorTalk: draft.monitorTalk ?? { active: true, preset: 'singing', amount: 0.35, singing: defaultSinging, reverb: defaultReverb } }); setConfirmed(false); }} />{t('liveOutput.split')}</label>
            {draft.splitProcessing && <p className="text-ui-support">{t('liveOutput.splitScope')}</p>}
            {draft.splitProcessing && (['monitorSinging', 'monitorTalk'] as const).map(role => <fieldset key={role} className="space-y-2"><legend className="text-ui-control font-semibold">{t(`liveOutput.${role}`)}</legend>
                <SliderField label={t('liveOutput.brightness')} min={-3} max={3} step={0.5} disabled={busy || disabled} value={draft[role]?.singing?.brightnessDb ?? 0} formatValue={value => `${value} dB`} onValueChange={value => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, singing: { ...(config.singing ?? defaultSinging), brightnessDb: value } } }); setConfirmed(false); } }} />
                <SliderField label={t('liveOutput.dynamics')} min={0} max={1} step={0.05} disabled={busy || disabled} value={draft[role]?.singing?.dynamics ?? 0.35} formatValue={value => `${Math.round(value * 100)}%`} onValueChange={value => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, singing: { ...(config.singing ?? defaultSinging), dynamics: value } } }); setConfirmed(false); } }} />
                {role === 'monitorSinging' && <SliderField label={t('liveOutput.reverb')} min={0} max={0.2} step={0.01} disabled={busy || disabled} value={draft[role]?.reverb?.mix ?? 0} formatValue={value => `${Math.round(value * 100)}%`} onValueChange={value => { const config = draft[role]; if (config) { setDraft({ ...draft, [role]: { ...config, reverb: { ...(config.reverb ?? defaultReverb), enabled: value > 0, mix: value } } }); setConfirmed(false); } }} />}
            </fieldset>)}
            {(['monitorTrim', 'broadcastTrim'] as const).map(key => <SliderField key={key} label={t(`liveOutput.${key}`)} min={0} max={100}  disabled={busy || disabled} value={draft[key] * 100} formatValue={value => `${Math.round(value)}%`} onValueChange={value => { setDraft({ ...draft, [key]: value / 100 }); setConfirmed(false); }} />)}
            <label className="flex gap-2 text-ui-control"><Checkbox disabled={busy || disabled}  checked={draft.monitorMuted} onChange={e => { setDraft({ ...draft, monitorMuted: e.target.checked }); setConfirmed(false); }} />{t('liveOutput.monitorMuted')}</label>
            <p className="text-ui-support">{t('liveOutput.diff', { before: status?.config.deviceId ? t('liveOutput.enabled') : t('liveOutput.disabled'), after: draft.deviceId ? t('liveOutput.enabled') : t('liveOutput.disabled') })}</p>
            <label className="flex gap-2 text-ui-control"><Checkbox disabled={busy || disabled}  checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t('liveOutput.confirm')}</label>
            <Button disabled={busy || disabled || !confirmed} variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={() => void request(true)}>{t('liveOutput.save')}</Button>{' '}
            <Button disabled={busy || disabled} variant="link" size="sm" className="h-auto min-h-9 whitespace-normal" onClick={() => { setDraft(status?.config ?? null); setConfirmed(false); }}>{t('settings.apply.discardOutput')}</Button>
        </div>}
        {previous && <Button disabled={busy || disabled} variant="link" size="sm" className="h-auto min-h-9 whitespace-normal" onClick={() => { setDraft(previous); setConfirmed(false); }}>{t('liveOutput.undo')}</Button>}
        <div className="space-y-2 border-t border-border pt-3">
            <p id="live-output-stop-warning" className="text-ui-support">{t('liveOutput.stopWarning')}</p>
            <Button ref={stopButton} type="button" variant="outline" disabled={busy || disabled} aria-describedby="live-output-stop-warning"  onClick={() => setStopConfirmOpen(true)}>{t('liveOutput.stop')}</Button>
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
        {status && <p ref={savedStatus} tabIndex={-1} role="status" className="text-ui-support">{t(status.error || status.sink?.failed ? 'liveOutput.failed' : status.sink?.active ? 'liveOutput.active' : 'liveOutput.inactive')}</p>}
        {status?.monitor && <p className="text-ui-support">{t('liveOutput.monitorCounts', { queued: status.monitor.broadcastQueueFrames, offered: status.monitor.offeredFrames, dropped: status.monitor.droppedFrames, accepted: status.monitor.acceptedRevision, completed: status.monitor.completedRevision })}</p>}
        {status?.sink && <p className="text-ui-support">{t('liveOutput.counts', { queued: status.sink.queuedFrames, zero: status.sink.zeroFilledFrames, dropped: status.sink.droppedFrames, rate: status.sink.rateHz })}</p>}
        {error && <p role="alert" className="text-destructive-text text-ui-support">{t('liveOutput.error')}</p>}
    </section>;
}
