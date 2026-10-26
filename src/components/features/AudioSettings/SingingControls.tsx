import { Button } from '@/components/ui/button';
import { useMessages } from '@/i18n/LocaleProvider';
import { audioApi } from '@/api/audio';
import { defaultReverb } from '@/api/builtinEffects';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';
import type { SingingDraft } from '@/hooks/useSingingDraft';

export function SingingControls({ model, onPreview, onSaveProfile, compact = false, running, previewActive = false, showHeading = true }: {
    model: SingingDraft; running?: boolean; previewActive?: boolean; onPreview?: () => void; onSaveProfile?: () => void; compact?: boolean; showHeading?: boolean;
}) {
    const t = useMessages();
    const { snapshot, draft, busy, conflict, error } = model;
    const [observedRunning, setObservedRunning] = useState<boolean | undefined>();
    const refreshStream = useRef<() => void>(() => {});
    useEffect(() => {
        if (running !== undefined) return;
        let disposed = false;
        let generation = 0;
        let fetching = false;
        let refreshNeeded = false;
        const refresh = async () => {
            if (disposed || document.hidden) return;
            const requested = ++generation;
            if (fetching) { refreshNeeded = true; return; }
            fetching = true;
            try {
                const value = await audioApi.getAudioStreamState();
                if (!disposed && requested === generation) setObservedRunning(value && typeof value.running === 'boolean' && typeof value.streamFailed === 'boolean' ? value.running && !value.streamFailed : undefined);
            } catch {
                if (!disposed && requested === generation) setObservedRunning(undefined);
            } finally {
                fetching = false;
                if (refreshNeeded && !disposed) { refreshNeeded = false; void refresh(); }
            }
        };
        const stopped = () => { if (!disposed) { generation += 1; refreshNeeded = false; setObservedRunning(false); } };
        const started = () => { if (!disposed) { setObservedRunning(undefined); void refresh(); } };
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error'].map(event => listen(event, event === 'audio-started' ? started : stopped));
        void Promise.all(subscriptions).then(() => { if (!disposed) void refresh(); }).catch(() => { if (!disposed) setObservedRunning(undefined); });
        refreshStream.current = () => { void refresh(); };
        const timer = setInterval(() => { if (!fetching) void refresh(); }, 1000);
        const visibility = () => { if (document.hidden) { generation += 1; setObservedRunning(undefined); } else void refresh(); };
        document.addEventListener('visibilitychange', visibility);
        return () => {
            disposed = true; generation += 1; refreshStream.current = () => {};
            clearInterval(timer); document.removeEventListener('visibilitychange', visibility);
            subscriptions.forEach(item => void item.then(stop => stop()).catch(() => {}));
        };
    }, [running]);
    const activeRunning = running ?? observedRunning;
    useEffect(() => { const release = model.activate(); void model.refresh(); return release; }, [model.activate, model.refresh]);
    useEffect(() => {
        if (!snapshot?.pending) return;
        const timer = setInterval(() => { if (!document.hidden) void model.refresh(); }, 250);
        return () => clearInterval(timer);
    }, [snapshot?.pending, model.refresh]);
    const params = draft?.singing;
    const reverb = draft?.reverb ?? defaultReverb;
    const dirty = Boolean(snapshot && draft && JSON.stringify(snapshot.config) !== JSON.stringify(draft));
    return <section aria-label={t('settings.SingingControls.393')} className="rounded-xl border border-border p-4 space-y-3 text-sm">
        {showHeading && <h3 className="font-bold">{t('settings.SingingControls.394')}</h3>}
        <p className="text-xs text-muted-foreground">{t('settings.SingingControls.395')}</p>
        <p role="status">{!snapshot ? t('settings.SingingControls.396') : activeRunning === false ? t('settings.SingingControls.397') : snapshot.pending ? t('settings.SingingControls.398') : activeRunning === true && snapshot.appliedRevision === snapshot.revision ? t('settings.SingingControls.399') : t('settings.SingingControls.400')}{dirty && t('settings.SingingControls.401')}</p>
        {snapshot && <p>{t('settings.SingingControls.402')}{snapshot.config.preset === 'singing' ? t('settings.SingingControls.403') : t(`obsTyped.preset.${snapshot.config.preset}`)} ／ {snapshot.config.active ? 'ON' : 'OFF'}{snapshot.config.singing && t('settings.SingingControls.404', { arg0: snapshot.config.singing.lowCutHz, arg1: Math.round(snapshot.config.singing.dynamics * 100), arg2: snapshot.config.singing.brightnessDb })}</p>}
        {!compact && <>
            <button type="button" disabled={busy || !snapshot} onClick={model.selectSinging} className="rounded border px-3 py-2 disabled:opacity-50">{t('settings.SingingControls.405')}</button>
            {draft?.preset === 'singing' && params && <fieldset disabled={busy} className="space-y-2">
                <legend>{t('settings.SingingControls.406')}</legend>
                {([
                    ['lowCutHz', t('settings.SingingControls.407'), 40, 160, 1],
                    ['dynamics', t('settings.SingingControls.408'), 0, 100, 1],
                    ['brightnessDb', t('settings.SingingControls.409'), -3, 3, 0.1],
                ] as const).map(([key, label, min, max, step]) => <label key={key} className="block">{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={key === 'dynamics' ? Math.round(params[key] * 100) : params[key]} onChange={event => {
                    const number = Number(event.target.value);
                    if (event.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) model.edit({ [key]: key === 'dynamics' ? number / 100 : number });
                }} className="block w-full rounded border border-input bg-background p-2" /></label>)}
            </fieldset>}
        </>}
        {draft?.preset === 'singing' && params && <p>{t('settings.singing.draft', { low: params.lowCutHz, dynamics: Math.round(params.dynamics * 100), brightness: params.brightnessDb })}</p>}
        {!compact && <fieldset disabled={busy || !draft} className="space-y-2">
            <legend className="font-bold">{t('settings.SingingControls.413')}</legend>
            <label className="flex items-center gap-2"><input type="checkbox" checked={reverb.enabled} onChange={event => model.editReverb({ enabled: event.target.checked })} />{t('settings.SingingControls.414')}</label>
            <p className="text-xs text-muted-foreground">{t('settings.SingingControls.415')}</p>
            {([
                ['mix', t('settings.SingingControls.416'), 0, 25, 1],
                ['decaySeconds', t('settings.SingingControls.417'), 0.3, 2.5, 0.1],
                ['damping', t('settings.SingingControls.418'), 0, 100, 1],
            ] as const).map(([key, label, min, max, step]) => <label key={key} className="block">{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={key === 'decaySeconds' ? reverb[key] : Math.round(reverb[key] * 100)} onChange={event => {
                const number = Number(event.target.value);
                if (event.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) model.editReverb({ [key]: key === 'decaySeconds' ? number : number / 100 });
            }} className="block w-full rounded border border-input bg-background p-2" /></label>)}
        </fieldset>}
        {snapshot && <p>{t('settings.singing.reverb', { applied: snapshot.config.reverb?.enabled ? 'ON' : 'OFF', draft: reverb.enabled ? 'ON' : 'OFF', mix: Math.round(reverb.mix * 100), decay: reverb.decaySeconds, damping: Math.round(reverb.damping * 100) })}</p>}
        {conflict && <p role="alert">{t('settings.SingingControls.424')}</p>}
        {(error || snapshot?.error) && <p role="alert">{error || snapshot?.error}</p>}
        <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => { void model.refresh(); refreshStream.current(); }} className="rounded border px-3 py-2">{t('settings.SingingControls.425')}</button>
            {onPreview && <button type="button" disabled={busy || !draft || conflict} onClick={onPreview} className="rounded border px-3 py-2 disabled:opacity-50">{t('settings.SingingControls.426')}</button>}
            <button type="button" disabled={previewActive || busy || !dirty || snapshot?.pending || conflict} onClick={() => void model.apply()} className="rounded border px-3 py-2 disabled:opacity-50">{t('settings.SingingControls.427')}</button>
            <button type="button" disabled={previewActive || busy || !snapshot?.undoToken || snapshot.pending || dirty} onClick={() => void model.undo()} className="rounded border px-3 py-2 disabled:opacity-50">{t('settings.SingingControls.428')}</button>
            {!compact && <Button type="button" variant="outline" disabled={busy || !dirty} onClick={model.resetDraft}>{t('settings.SingingControls.429')}</Button>}
            {onSaveProfile && <button type="button" disabled={previewActive || busy || !snapshot || snapshot.pending} onClick={onSaveProfile} className="rounded border px-3 py-2 disabled:opacity-50">{t('settings.SingingControls.430')}</button>}
        </div>
        {onSaveProfile && <p className="text-xs text-muted-foreground">{t('settings.SingingControls.431')}</p>}
        <details><summary>{t('settings.SingingControls.432')}</summary><p>{t('settings.SingingControls.433')}</p></details>
    </section>;
}
