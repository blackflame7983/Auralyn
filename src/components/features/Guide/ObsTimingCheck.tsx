import { useMessages } from '@/i18n/LocaleProvider';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { canAdoptObsHistory, formatObsText, obsHistoryResults, originalObsText } from '@/lib/obsUiText';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useObsUsage } from '@/hooks/useObsUsage';
import { readObsEndpoint } from '@/lib/obsConnectionPreferences';
import { listen } from '@tauri-apps/api/event';
import { obsApi, type ObsSetupHistory, type ObsSetupPlan, type ObsTimingTargets } from '@/api/obs';

// 録画や測定は利用者が行う。実在対象の確認と、明示した同期値の変更だけを支援する。
export function ObsTimingCheck({ mixed = false, contextKey = '', onOpenObsSettings }: { mixed?: boolean; contextKey?: string; onOpenObsSettings?: () => void }) {
    const t = useMessages();
    const obsInUse = useObsUsage(true);
    const usedRef = useRef(obsInUse);
    usedRef.current = obsInUse;
    const [endpoint] = useState(readObsEndpoint);
    const [connection, setConnection] = useState<'checking' | 'connected' | 'disconnected'>('checking');
    const connectionRevision = useRef(0);
    const [comparison, setComparison] = useState<'voiceAccompaniment' | 'audioVideo'>('voiceAccompaniment');
    const [direction, setDirection] = useState('');
    const [difference, setDifference] = useState('');
    const [reference, setReference] = useState('');
    const [fps, setFps] = useState('');
    const [track, setTrack] = useState('');
    const [checked, setChecked] = useState(false);
    const [targets, setTargets] = useState<ObsTimingTargets | null>(null);
    const [targetToken, setTargetToken] = useState('');
    const [plan, setPlan] = useState<ObsSetupPlan | null>(null);
    const [history, setHistory] = useState<ObsSetupHistory[]>([]);
    const [busy, setBusy] = useState('');
    const [message, setMessage] = useState<SettingsNotice>('');
    const [adopted, setAdopted] = useState<number | null>(null);
    const revision = useRef(0);
    const inFlight = useRef(false);
    const alive = useRef(true);
    const refreshConnection = useCallback(async () => {
        const version = ++connectionRevision.current;
        if (!obsInUse) { setConnection('disconnected'); return; }
        setConnection('checking');
        try {
            const connected = await obsApi.connectionStatus();
            if (alive.current && usedRef.current && version === connectionRevision.current) setConnection(connected ? 'connected' : 'disconnected');
        } catch {
            if (alive.current && usedRef.current && version === connectionRevision.current) { setConnection('disconnected'); setMessage(notice('obsTiming.copy.00')); }
        }
    }, [obsInUse]);
    useEffect(() => {
        void refreshConnection();
        if (!obsInUse) {
            revision.current += 1; setPlan(null); setTargets(null); setTargetToken(''); setChecked(false); setAdopted(null);
            setHistory(items => items.map(item => ({ ...item, restorable: false })));
        }
    }, [refreshConnection, obsInUse]);
    const invalidate = () => { revision.current += 1; setPlan(null); setAdopted(null); };
    useEffect(() => {
        alive.current = true;
        const invalidateContext = () => {
            revision.current += 1;
            setPlan(null); setTargets(null); setTargetToken(''); setChecked(false); setAdopted(null);
            setHistory(items => items.map(item => ({ ...item, restorable: false })));
            setMessage(notice('obsTiming.copy.01'));
        };
        const subscriptions = ['obs://timing-invalidated', 'audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error', 'global-bypass-changed', 'audio-conditions-changed'].map(event => listen(event, () => {
            if (!alive.current) return;
            invalidateContext();
            if (event === 'obs://timing-invalidated') void refreshConnection();
        }));
        void Promise.all(subscriptions).catch(() => { if (alive.current) setMessage(notice('obsTiming.copy.02')); });
        window.addEventListener('profile-fx-applied', invalidateContext);
        return () => {
            alive.current = false; revision.current += 1;
            window.removeEventListener('profile-fx-applied', invalidateContext);
            connectionRevision.current += 1;
            subscriptions.forEach(subscription => { void subscription.then(stop => stop()).catch(() => {}); });
        };
    }, [refreshConnection]);
    useEffect(() => {
        revision.current += 1;
        setPlan(null); setTargets(null); setTargetToken(''); setChecked(false); setAdopted(null);
    }, [mixed, contextKey]);
    const run = async (kind: string, action: (version: number) => Promise<void>) => {
        if (inFlight.current || !usedRef.current) return;
        inFlight.current = true; setBusy(kind); setMessage('');
        const version = revision.current;
        try { await action(version); }
        catch {
            if (alive.current && version === revision.current) setMessage(notice('obsTiming.failure'));
        } finally { inFlight.current = false; if (alive.current) setBusy(''); }
    };
    const connect = async () => {
        if (inFlight.current || !usedRef.current) return;
        inFlight.current = true; setBusy('connect'); setMessage('');
        invalidate();
        try {
            await obsApi.connect({ host: endpoint.host, port: endpoint.port });
            if (alive.current && usedRef.current) await refreshConnection();
        } catch {
            if (alive.current && usedRef.current) {
                setConnection('disconnected');
                setMessage(notice('obsTiming.connectFailure', { port: endpoint.port }));
            }
        } finally { inFlight.current = false; if (alive.current) setBusy(''); }
    };
    const current = (version: number) => alive.current && version === revision.current;
    const selected = targets?.targets.find(target => target.targetToken === targetToken);
    const delay = Number(difference);
    const supportedDirection = direction === 'early' || (direction === 'late' && comparison === 'voiceAccompaniment' && !mixed);
    const eligible = supportedDirection && !(mixed && comparison === 'voiceAccompaniment');
    const valid = eligible && checked && !!reference.trim() && reference.length <= 500 && difference.trim() !== ''
        && Number.isInteger(delay) && delay > 0 && delay <= 20950
        && (!fps || (Number.isFinite(Number(fps)) && Number(fps) >= 1 && Number(fps) <= 240))
        && (!track || (Number.isInteger(Number(track)) && Number(track) >= 1 && Number(track) <= 6));
    const resultOffset = selected ? selected.currentOffsetMs + delay : NaN;
    const writePending = busy === 'apply' || busy === 'restore';
    const targetRole = comparison === 'audioVideo' ? t('obsTiming.copy.03') : direction === 'late' ? t('obsTiming.copy.04') : t('obsTiming.copy.05');
    const refresh = () => {
        if (connection !== 'connected' || !usedRef.current) return;
        invalidate(); setTargets(null); setTargetToken('');
        void run('targets', async version => {
            const result = await obsApi.timingTargets();
            if (current(version)) setTargets(result);
        });
    };
    const preview = () => {
        if (connection !== 'connected' || !valid || !selected || !targets?.supported || resultOffset < -950 || resultOffset > 20000) return;
        invalidate();
        void run('preview', async version => {
            const result = await obsApi.previewTiming({
                targetToken: selected.targetToken, additionalDelayMs: delay,
                measurement: { method: 'manual', comparison, measuredDelayMs: direction === 'late' ? delay : -delay,
                    referenceNote: reference.trim(), fps: fps ? Number(fps) : null, track: track ? Number(track) : null },
            });
            if (current(version)) setPlan(result);
        });
    };
    return <details open className="rounded-lg border border-border p-3 space-y-3 text-sm">
        <summary className="cursor-pointer font-bold">{t('obsTiming.copy.06')}</summary>
        <p>{t('obsTiming.copy.07')}</p>
        <p className="text-xs text-muted-foreground">{t('obsTiming.copy.08')}</p>
        <div className="rounded border p-3 space-y-2" aria-label={t('obsTiming.copy.09')}>
            <p>{connection === 'connected' ? t('obsTiming.copy.10') : connection === 'checking' ? t('obsTiming.copy.11') : t('obsTiming.disconnected', { host: endpoint.host, port: endpoint.port })}</p>
            {connection === 'disconnected' && <button type="button" disabled={!!busy || !obsInUse} onClick={() => void connect()} className="rounded border px-3 py-2 disabled:opacity-50">{t('obsTiming.copy.12')}</button>}
            <button type="button" disabled={!!busy || !obsInUse} onClick={() => void refreshConnection()} className="ml-2 underline">{t('obsTiming.copy.13')}</button>
            {onOpenObsSettings && <button type="button" disabled={!!busy} onClick={onOpenObsSettings} className="ml-2 underline">{t('obsTiming.copy.14')}</button>}
            <p className="text-xs text-muted-foreground">{t('obsTiming.copy.15')}</p>
        </div>
        <fieldset disabled={writePending} className="space-y-3">
            <legend className="font-bold">{t('obsTiming.copy.16')}</legend>
            <label className="block">{t('obsTiming.copy.17')}<select aria-label={t('obsTiming.copy.17')} value={comparison} onChange={event => { invalidate(); setComparison(event.target.value as typeof comparison); setDirection(''); setTargetToken(''); }} className="block w-full rounded border bg-background p-2">
                <option value="voiceAccompaniment">{t('obsTiming.copy.18')}</option><option value="audioVideo">{t('obsTiming.copy.19')}</option>
            </select></label>
            <label className="block">{t('obsTiming.copy.20')}<select aria-label={t('obsTiming.copy.20')} value={direction} onChange={event => { invalidate(); setDirection(event.target.value); setTargetToken(''); }} className="block w-full rounded border bg-background p-2">
                <option value="">{t('obsTiming.copy.21')}</option><option value="early">{comparison === 'audioVideo' ? t('obsTiming.copy.22') : t('obsTiming.copy.23')}</option><option value="late">{comparison === 'audioVideo' ? t('obsTiming.copy.24') : t('obsTiming.copy.25')}</option><option value="unknown">{t('obsTiming.copy.26')}</option>
            </select></label>
            <label className="block">{t('obsTiming.copy.27')}<input aria-label={t('obsTiming.copy.27')} type="number" min="1" max="20950" step="1" value={difference} onChange={event => { invalidate(); setDifference(event.target.value); }} className="block w-full rounded border bg-background p-2" /></label>
            <label className="block">{t('obsTiming.copy.28')}<textarea aria-label={t('obsTiming.copy.28')} maxLength={500} value={reference} onChange={event => { invalidate(); setReference(event.target.value); }} className="block w-full rounded border bg-background p-2" /></label>
            <p className="text-xs text-muted-foreground">{t('obsTiming.copy.29')}</p>
            <div className="flex flex-wrap gap-3">
                <label>{t('obsTiming.copy.30')}<input aria-label={t('obsTiming.copy.30')} type="number" min="1" max="240" value={fps} onChange={event => { invalidate(); setFps(event.target.value); }} className="block w-28 rounded border bg-background p-2" /></label>
                <label>{t('obsTiming.copy.31')}<input aria-label={t('obsTiming.copy.31')} type="number" min="1" max="6" step="1" value={track} onChange={event => { invalidate(); setTrack(event.target.value); }} className="block w-28 rounded border bg-background p-2" /></label>
            </div>
            <label className="flex items-start gap-2"><input type="checkbox" checked={checked} onChange={event => { invalidate(); setChecked(event.target.checked); }} /><span>{t('obsTiming.copy.32')}</span></label>
        </fieldset>
        {mixed && comparison === 'voiceAccompaniment' ? <p>{t('obsTiming.copy.33')}</p>
            : direction === 'unknown' ? <p>{t('obsTiming.copy.34')}</p>
                : comparison === 'audioVideo' && direction === 'late' ? <p>{t('obsTiming.copy.35')}</p> : null}
        {eligible && <p>{t('obsTiming.targetRole', { role: targetRole })}</p>}
        <button type="button" disabled={!!busy || !valid || connection !== 'connected' || !obsInUse} onClick={refresh} className="rounded border px-3 py-2 disabled:opacity-50">{t('obsTiming.copy.36')}</button>
        {targets && <p role="status">{originalObsText(t, targets.message)}{targets.supported && !targets.targets.length ? t('obsTiming.copy.37') : ''}</p>}
        {targets?.supported && <label className="block">{t('obsTiming.copy.38')}<select aria-label={t('obsTiming.copy.38')} disabled={!!busy} value={targetToken} onChange={event => { invalidate(); setTargetToken(event.target.value); }} className="block w-full rounded border bg-background p-2">
            <option value="">{t('obsTiming.copy.39')}</option>{targets.targets.map(target => <option key={target.targetToken} value={target.targetToken}>{t('obsTiming.sourceOption', { source: target.source, value: target.currentOffsetMs })}</option>)}
        </select></label>}
        {selected && valid && <p>{t('obsTiming.offset', { source: selected.source, before: selected.currentOffsetMs, delay, after: resultOffset })}{resultOffset > 20000 || resultOffset < -950 ? t('obsTiming.copy.40') : ''}</p>}
        <button type="button" disabled={!!busy || connection !== 'connected' || !obsInUse || !valid || !selected || !targets?.supported || resultOffset > 20000 || resultOffset < -950} onClick={preview} className="rounded border px-3 py-2 disabled:opacity-50">{t('obsTiming.copy.41')}</button>
        {plan && <div aria-label={t('obsTiming.copy.42')} className="rounded border p-3 space-y-2">
            <p>{formatObsText(t, plan.messageText, plan.message)}</p>
            {plan.timing && <p>{t('obsTiming.offset', { source: plan.timing.source, before: plan.timing.currentOffsetMs, delay: plan.timing.additionalDelayMs, after: plan.timing.resultOffsetMs })}</p>}
            <button type="button" disabled={!!busy || connection !== 'connected' || !obsInUse || !plan.supported || !plan.timing || !plan.changes.length} onClick={() => void run('apply', async version => {
                const applyingId = plan.id;
                setPlan(null);
                const result = await obsApi.applySetup(applyingId);
                if (!alive.current) return;
                setHistory(items => [...items, current(version) ? result : { ...result, restorable: false }]); setPlan(null); setAdopted(null);
                setTargets(null); setTargetToken(''); setChecked(false);
                setMessage(current(version) ? notice('obsTiming.copy.43') : notice('obsTiming.copy.44'));
            })} className="rounded border px-3 py-2 disabled:opacity-50">{t('obsTiming.copy.45')}</button>
            <button type="button" disabled={!!busy} onClick={invalidate} className="ml-2 underline">{t('obsTiming.copy.46')}</button>
        </div>}
        {busy && <p role="status">{writePending ? t('obsTiming.copy.47') : t('obsTiming.copy.48')}</p>}
        {message && <p role="alert" className="break-words">{renderNotice(t, message)}</p>}
        <button type="button" disabled={!!busy} className="underline" onClick={() => { invalidate(); void run('history', async version => { const items = await obsApi.setupHistory(); if (current(version)) setHistory(items.filter(item => item.timing)); }); }}>{t('obsTiming.copy.49')}</button>
        {history.map(item => <div key={item.id} aria-label={t('obsTiming.historyAria', { id: item.id })} className="rounded border p-3 space-y-2">
            <p>{t('obsTiming.historyTitle', { id: item.id, source: item.timing?.source ?? '—', before: item.timing?.currentOffsetMs ?? '—', after: item.timing?.resultOffsetMs ?? '—' })}</p>
            <p>{t('obsTiming.reference', { note: item.timing?.measurement.referenceNote ?? '—' })}</p>
            <p>{obsHistoryResults(t, item).join(' ／ ')}</p>
            {item.restorable === false && <p>{t('obsTiming.copy.50')}</p>}
            <p>{t('obsTiming.copy.51')}</p>
            <button type="button" disabled={!!busy || !canAdoptObsHistory(item)} onClick={() => setAdopted(item.id)} className="rounded border px-3 py-2 disabled:opacity-50">{t('obsTiming.adopt', { id: item.id })}</button>
            <button type="button" disabled={!!busy || connection !== 'connected' || !obsInUse || item.restorable === false} onClick={() => { invalidate(); void run('restore', async version => {
                const restored = await obsApi.restoreSetup(item.id);
                if (alive.current) { setTargets(null); setTargetToken(''); setChecked(false); }
                if (alive.current) setHistory(items => items.map(old => old.id === item.id ? (current(version) ? restored : { ...restored, restorable: false }) : old));
            }); }} className="ml-2 rounded border px-3 py-2 disabled:opacity-50">{t('obsTiming.undo', { id: item.id })}</button>
            {adopted === item.id && <p role="status">{t('obsTiming.copy.52')}</p>}
        </div>)}
        <p className="text-xs text-muted-foreground">{t('obsTiming.copy.53')}</p>
    </details>;
}
