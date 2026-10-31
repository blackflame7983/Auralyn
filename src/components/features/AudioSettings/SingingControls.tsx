import { Button } from '@/components/ui/button';
import { InfoPopover } from '@/components/ui/InfoPopover';
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
    const refreshVisible = compact || !snapshot || Boolean(error || snapshot.error || conflict) || activeRunning !== true;
    const refreshButton = <Button type="button" variant="outline" disabled={busy} onClick={() => { void model.refresh(); refreshStream.current(); }} className="h-auto whitespace-normal px-3 py-2 text-xs">{t('settings.SingingControls.425')}</Button>;
    const historyButtons = <>
        <Button type="button" variant="outline" disabled={previewActive || busy || !snapshot?.undoToken || snapshot.pending || dirty} onClick={() => void model.undo()} className="h-auto whitespace-normal px-3 py-2 text-xs">{t('settings.SingingControls.428')}</Button>
        <Button type="button" variant="outline" disabled={previewActive || busy || !snapshot?.redoToken || snapshot.pending || dirty} onClick={() => void model.redo()} className="h-auto whitespace-normal px-3 py-2 text-xs">{t('history.redo')}</Button>
    </>;
    const canUndo = Boolean(snapshot?.undoToken || snapshot?.redoToken);
    const saveButton = onSaveProfile && <Button type="button" variant="outline" disabled={previewActive || busy || !snapshot || snapshot.pending} onClick={onSaveProfile} className="h-auto whitespace-normal px-3 py-2 text-xs">{t('settings.SingingControls.430')}</Button>;
    const numeric = (key: 'mix' | 'decaySeconds' | 'damping', label: string, min: number, max: number, step: number) => <label key={key} className="min-w-0 text-xs">{label}
        <input aria-label={label} type="number" min={min} max={max} step={step} value={key === 'decaySeconds' ? reverb[key] : Math.round(reverb[key] * 100)} onChange={event => {
            const number = Number(event.target.value);
            if (event.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) model.editReverb({ [key]: key === 'decaySeconds' ? number : number / 100 });
        }} className="mt-1 block w-full rounded border border-input bg-background p-2 text-sm" />
    </label>;
    return <section aria-label={t('settings.SingingControls.393')} className="space-y-4 text-sm">
        <div className="flex items-center gap-1">
            {showHeading && <h3 className="font-bold">{t('settings.SingingControls.394')}</h3>}
            <InfoPopover label={t('singing.guideHelp')}><p>{t('settings.SingingControls.395')}</p><p className="mt-2">{t('settings.SingingControls.433')}</p></InfoPopover>
            <p className="text-xs text-muted-foreground">{t('singing.draftSafety')}</p>
        </div>
        <p role="status" className="text-xs text-muted-foreground">{!snapshot ? t('settings.SingingControls.396') : activeRunning === false ? t('settings.SingingControls.397') : snapshot.pending ? t('settings.SingingControls.398') : activeRunning === true && snapshot.appliedRevision === snapshot.revision ? t('settings.SingingControls.399') : t('settings.SingingControls.400')}{dirty && t('settings.SingingControls.401')}</p>
        {snapshot && <p className="text-xs">{t('settings.SingingControls.402')}{snapshot.config.preset === 'singing' ? t('settings.SingingControls.403') : t(`obsTyped.preset.${snapshot.config.preset}`)} ／ {snapshot.config.active ? 'ON' : 'OFF'}</p>}
        {compact && snapshot?.config.singing && <p className="text-xs">{t('singing.appliedValues')}{t('settings.SingingControls.404', { arg0: snapshot.config.singing.lowCutHz, arg1: Math.round(snapshot.config.singing.dynamics * 100), arg2: snapshot.config.singing.brightnessDb })}</p>}
        {compact && draft?.preset === 'singing' && params && <p className="text-xs">{t('settings.singing.draft', { low: params.lowCutHz, dynamics: Math.round(params.dynamics * 100), brightness: params.brightnessDb })}</p>}
        {compact && snapshot && <p className="text-xs">{t('settings.singing.reverb', { applied: snapshot.config.reverb?.enabled ? 'ON' : 'OFF', draft: reverb.enabled ? 'ON' : 'OFF', mix: Math.round(reverb.mix * 100), decay: reverb.decaySeconds, damping: Math.round(reverb.damping * 100) })}</p>}
        {!compact && <div className="space-y-3">
            <h4 className="font-semibold">{t('singing.prepare')}</h4>
            <Button type="button" variant="outline" disabled={busy || !snapshot} onClick={model.selectSinging} className="h-auto whitespace-normal px-3 py-2">{t('settings.SingingControls.405')}</Button>
            <fieldset disabled={busy || !draft}>
                <legend className="sr-only">{t('settings.SingingControls.413')}</legend>
                <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2"><input type="checkbox" checked={reverb.enabled} onChange={event => model.editReverb({ enabled: event.target.checked })} />{t('settings.SingingControls.414')}</label>
                    <InfoPopover label={t('singing.reverbHelp')}>{t('settings.SingingControls.415')}</InfoPopover>
                </div>
            </fieldset>
            <details className="rounded-lg border border-border p-3">
                <summary className="cursor-pointer font-medium">{t('singing.fineTune')}</summary>
                <div className="mt-3 space-y-4">
                    {draft?.preset === 'singing' && params && <fieldset disabled={busy}>
                        <legend className="mb-2 text-xs font-semibold">{t('settings.SingingControls.406')}</legend>
                        <div className="grid gap-3 sm:grid-cols-3">{([
                            ['lowCutHz', t('settings.SingingControls.407'), 40, 160, 1],
                            ['dynamics', t('settings.SingingControls.408'), 0, 100, 1],
                            ['brightnessDb', t('settings.SingingControls.409'), -3, 3, 0.1],
                        ] as const).map(([key, label, min, max, step]) => <label key={key} className="min-w-0 text-xs">{label}<input aria-label={label} type="number" min={min} max={max} step={step} value={key === 'dynamics' ? Math.round(params[key] * 100) : params[key]} onChange={event => {
                            const number = Number(event.target.value);
                            if (event.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) model.edit({ [key]: key === 'dynamics' ? number / 100 : number });
                        }} className="mt-1 block w-full rounded border border-input bg-background p-2 text-sm" /></label>)}</div>
                    </fieldset>}
                    <fieldset disabled={busy || !draft}>
                        <legend className="mb-2 text-xs font-semibold">{t('settings.SingingControls.413')}</legend>
                        <div className="grid gap-3 sm:grid-cols-3">
                            {numeric('mix', t('settings.SingingControls.416'), 0, 25, 1)}
                            {numeric('decaySeconds', t('settings.SingingControls.417'), 0.3, 2.5, 0.1)}
                            {numeric('damping', t('settings.SingingControls.418'), 0, 100, 1)}
                        </div>
                    </fieldset>
                    {snapshot?.config.singing && <p className="text-xs text-muted-foreground">{t('singing.appliedValues')}{t('settings.SingingControls.404', { arg0: snapshot.config.singing.lowCutHz, arg1: Math.round(snapshot.config.singing.dynamics * 100), arg2: snapshot.config.singing.brightnessDb })}</p>}
                    {snapshot && <p className="text-xs text-muted-foreground">{t('singing.appliedReverb', { state: snapshot.config.reverb?.enabled ? 'ON' : 'OFF' })}</p>}
                </div>
            </details>
        </div>}
        {conflict && <p role="alert" className="text-warning">{t('settings.SingingControls.424')}</p>}
        {(error || snapshot?.error) && <div className="space-y-2"><p role="alert" className="text-warning">{error || t('singing.requestFailed')}</p>
            {snapshot?.error && <details><summary className="cursor-pointer text-xs">{t('settings.mode.errorDetails')}</summary><p className="mt-2 break-words text-xs">{snapshot.error}</p></details>}
        </div>}
        <div className="space-y-3 border-t border-border pt-3">
            {!compact && <h4 className="font-semibold">{t('singing.listenApply')}</h4>}
            {!compact && <p className="text-xs text-muted-foreground">{previewActive ? t('singing.stopPreview') : !snapshot ? t('singing.waitForSettings') : snapshot.pending ? t('singing.waitForApply') : dirty ? t('singing.previewThenApply') : t('singing.noChanges')}</p>}
            <div className="flex flex-wrap gap-2">
                {onPreview && <Button type="button" variant="secondary" disabled={busy || !draft || conflict} onClick={onPreview} className="h-auto whitespace-normal px-3 py-2">{t('settings.SingingControls.426')}</Button>}
                <Button type="button" disabled={previewActive || busy || !dirty || snapshot?.pending || conflict} onClick={() => void model.apply()} className="h-auto whitespace-normal px-3 py-2">{t('settings.SingingControls.427')}</Button>
            </div>
            {(refreshVisible || canUndo) && <div className="flex flex-wrap gap-2">{refreshVisible && refreshButton}{canUndo && historyButtons}</div>}
        </div>
        {compact ? <>{saveButton}{onSaveProfile && <p className="text-xs text-muted-foreground">{t('settings.SingingControls.431')}</p>}</> : <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-xs font-medium">{t('singing.otherActions')}</summary>
            <div className="mt-3 flex flex-wrap gap-2">
                {!refreshVisible && refreshButton}
                {!canUndo && historyButtons}
                <Button type="button" variant="outline" disabled={busy || !dirty} onClick={model.resetDraft} className="h-auto whitespace-normal px-3 py-2 text-xs">{t('settings.SingingControls.429')}</Button>
                {saveButton}
            </div>
            {onSaveProfile && <p className="mt-2 text-xs text-muted-foreground">{t('settings.SingingControls.431')}</p>}
        </details>}
        <details><summary className="cursor-pointer text-xs text-muted-foreground">{t('settings.SingingControls.432')}</summary><p className="mt-2 text-xs">{t('settings.SingingControls.433')}</p></details>
    </section>;
}
