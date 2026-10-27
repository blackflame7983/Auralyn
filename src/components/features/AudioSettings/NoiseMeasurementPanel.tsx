import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { noiseMeasurementApi, type NoiseMeasurementRequest, type NoiseMeasurementSnapshot } from '@/api/noiseMeasurement';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';

const stateLabels: Record<NoiseMeasurementSnapshot['state'], MessageKey> = {
    idle: 'measurement.idle', capturing: 'measurement.capturing', review: 'measurement.review',
    approved: 'measurement.approved', invalid: 'measurement.invalid', stale: 'measurement.stale',
};
const qualityLabels: Record<string, MessageKey> = {
    nonFinite: 'measurement.nonFinite', silent: 'measurement.silent', clipped: 'measurement.clipped',
    short: 'measurement.short', variable: 'measurement.variable', uncertain: 'measurement.uncertain',
};

export function NoiseMeasurementPanel() {
    const t = useMessages();
    const { locale } = useLocale();
    const [snapshot, setSnapshot] = useState<NoiseMeasurementSnapshot | null>(null);
    const [quiet, setQuiet] = useState(false);
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);
    const active = useRef(false), serial = useRef(0), writing = useRef(false), reading = useRef(false);
    const owned = useRef<{epoch: string; generation: string} | null>(null);
    const conditionEvents = useRef(0);
    const lastGeneration = useRef<string | null>(null);
    const cancelOwned = () => {
        const generation = owned.current; owned.current = null;
        if (generation) void noiseMeasurementApi.request({ action: 'cancel', ...generation }).catch(() => {});
    };
    useEffect(() => {
        active.current = true;
        let live = true;
        const refresh = async () => {
            if (!live || document.hidden || writing.current || reading.current) return;
            reading.current = true;
            const version = serial.current;
            try {
                const next = await noiseMeasurementApi.request({ action: 'snapshot' });
                if (live && active.current && version === serial.current && !document.hidden) {
                    if (!next || typeof next.generation !== 'string' || !(next.state in stateLabels)) throw Error('Unknown measurement state');
                    if (lastGeneration.current !== `${next.epoch}:${next.generation}`) setQuiet(false);
                    lastGeneration.current = `${next.epoch}:${next.generation}`;
                    setSnapshot(next); setError(false);
                    if (next.state !== 'capturing') owned.current = null;
                }
            } catch { if (active.current && version === serial.current) { setSnapshot(null); setError(true); } }
            finally { reading.current = false; }
        };
        const hidden = () => {
            serial.current++; setQuiet(false);
            if (document.hidden) { cancelOwned(); setSnapshot(null); }
            else void refresh();
        };
        const changed = () => { if (!live) return; serial.current++; setQuiet(false); setSnapshot(null); void refresh(); };
        const conditionsChanged = () => {
            if (!live) return;
            conditionEvents.current++; setQuiet(false); setSnapshot(null);
            // 自分の開始/採用でもHostは条件変更を通知する。所有する開始を自己取消せず、応答後に読み直す。
            if (!writing.current) { serial.current++; void refresh(); }
        };
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error'].map(event => listen(event, changed));
        subscriptions.push(listen('audio-conditions-changed', conditionsChanged));
        const timer = setInterval(() => { void refresh(); }, 500);
        document.addEventListener('visibilitychange', hidden);
        void refresh();
        return () => {
            live = false; active.current = false; serial.current++; cancelOwned(); clearInterval(timer);
            document.removeEventListener('visibilitychange', hidden);
            subscriptions.forEach(p => { void p.then(stop => stop()).catch(() => {}); });
        };
    }, []);
    const run = async (request: NoiseMeasurementRequest) => {
        if (writing.current || document.hidden) return;
        writing.current = true; const version = ++serial.current; setBusy(true); setQuiet(false);
        try {
            const next = await noiseMeasurementApi.request(request);
            if (request.action === 'start') {
                if (!active.current || version !== serial.current || document.hidden) {
                    void noiseMeasurementApi.request({ action: 'cancel', epoch: next.epoch, generation: next.generation }).catch(() => {}); return;
                }
                owned.current = {epoch: next.epoch, generation: next.generation};
            }
            if (active.current && version === serial.current) {
                const events = conditionEvents.current;
                const latest = request.action === 'snapshot' ? next : await noiseMeasurementApi.request({ action: 'snapshot' });
                if (active.current && version === serial.current && events === conditionEvents.current && !document.hidden) {
                    setSnapshot(latest); setError(false);
                    if (latest.state !== 'capturing' || latest.epoch !== owned.current?.epoch || latest.generation !== owned.current?.generation) owned.current = null;
                    if (request.action === 'approve') window.dispatchEvent(new Event('profile-fx-applied'));
                }
            }
        } catch { if (active.current && version === serial.current) { setError(true); setSnapshot(null); } }
        finally { writing.current = false; if (active.current) setBusy(false); }
    };
    return <section aria-label={t('measurement.title')} className="space-y-3 rounded-md border border-border p-3">
        <h3 className="text-sm font-semibold">{t('measurement.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('measurement.scope')}</p>
        <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !snapshot || snapshot.state === 'capturing'} onClick={() => snapshot && void run({ action: 'start', epoch: snapshot.epoch, generation: snapshot.generation })} className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50">{t('settings.AudioSettingsModal.121')}</button>
            <button type="button" disabled={busy || !snapshot || snapshot.state !== 'capturing'} onClick={() => snapshot && void run({ action: 'cancel', epoch: snapshot.epoch, generation: snapshot.generation })} className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50">{t('settings.AudioSettingsModal.122')}</button>
            <button type="button" disabled={busy} onClick={() => void run({ action: 'snapshot' })} className="rounded border border-border px-3 py-2 text-xs disabled:opacity-50">{t('prep.refresh')}</button>
        </div>
        <p role="status" className="text-xs">{error ? t('measurement.error') : snapshot ? t(stateLabels[snapshot.state]) : t('prep.checking')}{snapshot?.state === 'capturing' && ` ${Math.round(snapshot.progress * 100)}%`}</p>
        {snapshot?.quality.map(code => <p key={code} className="text-xs text-warning">{t(qualityLabels[code] ?? 'measurement.uncertain')}</p>)}
        {snapshot?.state === 'review' && <>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={quiet} onChange={e => setQuiet(e.target.checked)} />{t('measurement.quiet')}</label>
            <button type="button" disabled={!quiet || busy} onClick={() => void run({ action: 'approve', epoch: snapshot.epoch, generation: snapshot.generation, acknowledgedQuiet: quiet })} className="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{t('measurement.use')}</button>
        </>}
        {snapshot?.previousAvailable && snapshot.state !== 'approved' && <p className="text-xs text-muted-foreground">{t('measurement.previous')}</p>}
        <details className="text-xs space-y-2"><summary className="cursor-pointer">{t('measurement.conditions')}</summary>
            {snapshot?.conditions && <p>{snapshot.conditions.host} · {snapshot.conditions.input} · ch {snapshot.conditions.channels.map(ch => ch + 1).join('/')} · {Math.round(snapshot.conditions.inputGain * 100)}% · {snapshot.conditions.analysisRate} Hz</p>}
            {snapshot?.capturedAtUnixMs && <p>{new Date(snapshot.capturedAtUnixMs).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')}</p>}
            {snapshot?.previous && snapshot.state !== 'approved' && <p>{t('measurement.previous')}: {snapshot.previous.conditions.input} · {snapshot.previous.capturedAtUnixMs ? new Date(snapshot.previous.capturedAtUnixMs).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US') : '—'}</p>}
            <p>{t('measurement.limits')}</p>
        </details>
    </section>;
}
