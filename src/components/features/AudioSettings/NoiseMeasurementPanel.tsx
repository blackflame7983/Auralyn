import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/button';
import { displayAudioHost } from '@/lib/audioDevices';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
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

export function NoiseMeasurementPanel({ embedded = false }: { embedded?: boolean }) {
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
            if (!live || isAppHidden() || writing.current || reading.current) return;
            reading.current = true;
            const version = serial.current;
            try {
                const next = await noiseMeasurementApi.request({ action: 'snapshot' });
                if (live && active.current && version === serial.current && !isAppHidden()) {
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
            if (isAppHidden()) { cancelOwned(); setSnapshot(null); }
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
        addAppVisibilityListener(hidden);
        void refresh();
        return () => {
            live = false; active.current = false; serial.current++; cancelOwned(); clearInterval(timer);
            removeAppVisibilityListener(hidden);
            subscriptions.forEach(p => { void p.then(stop => stop()).catch(() => {}); });
        };
    }, []);
    const run = async (request: NoiseMeasurementRequest) => {
        if (writing.current || isAppHidden()) return;
        writing.current = true; const version = ++serial.current; setBusy(true); setQuiet(false);
        try {
            const next = await noiseMeasurementApi.request(request);
            if (request.action === 'start') {
                if (!active.current || version !== serial.current || isAppHidden()) {
                    void noiseMeasurementApi.request({ action: 'cancel', epoch: next.epoch, generation: next.generation }).catch(() => {}); return;
                }
                owned.current = {epoch: next.epoch, generation: next.generation};
            }
            if (active.current && version === serial.current) {
                const events = conditionEvents.current;
                const latest = request.action === 'snapshot' ? next : await noiseMeasurementApi.request({ action: 'snapshot' });
                if (active.current && version === serial.current && events === conditionEvents.current && !isAppHidden()) {
                    setSnapshot(latest); setError(false);
                    if (latest.state !== 'capturing' || latest.epoch !== owned.current?.epoch || latest.generation !== owned.current?.generation) owned.current = null;
                    if (request.action === 'approve') window.dispatchEvent(new Event('profile-fx-applied'));
                }
            }
        } catch { if (active.current && version === serial.current) { setError(true); setSnapshot(null); } }
        finally { writing.current = false; if (active.current) setBusy(false); }
    };
    return <section aria-label={t('measurement.title')} className={embedded ? 'mt-3 space-y-3' : 'space-y-3 rounded-control border border-border p-3'}>
        {!embedded && <h3 className="text-ui-heading font-semibold">{t('measurement.title')}</h3>}
        <p className="text-ui-support text-muted-foreground">{t('measurement.scope')}</p>
        <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || !snapshot || snapshot.state === 'capturing'} onClick={() => snapshot && void run({ action: 'start', epoch: snapshot.epoch, generation: snapshot.generation })} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('settings.AudioSettingsModal.121')}</Button>
            <Button type="button" disabled={busy || !snapshot || snapshot.state !== 'capturing'} onClick={() => snapshot && void run({ action: 'cancel', epoch: snapshot.epoch, generation: snapshot.generation })} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('settings.AudioSettingsModal.122')}</Button>
            <Button type="button" disabled={busy} onClick={() => void run({ action: 'snapshot' })} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal">{t('prep.refresh')}</Button>
        </div>
        <p role="status" className="text-ui-support">{error ? t('measurement.error') : snapshot ? t(stateLabels[snapshot.state]) : t('prep.checking')}{snapshot?.state === 'capturing' && ` ${Math.round(snapshot.progress * 100)}%`}</p>
        {snapshot?.quality.map(code => <p key={code} className="text-ui-support text-warning">{t(qualityLabels[code] ?? 'measurement.uncertain')}</p>)}
        {snapshot?.state === 'review' && <>
            <label className="flex items-center gap-2 text-ui-control"><Checkbox checked={quiet} onChange={e => setQuiet(e.target.checked)} />{t('measurement.quiet')}</label>
            <Button type="button" disabled={!quiet || busy} onClick={() => void run({ action: 'approve', epoch: snapshot.epoch, generation: snapshot.generation, acknowledgedQuiet: quiet })} variant="default" size="sm" className="h-auto min-h-9 whitespace-normal">{t('measurement.use')}</Button>
        </>}
        {snapshot?.previousAvailable && snapshot.state !== 'approved' && <p className="text-ui-support text-muted-foreground">{t('measurement.previous')}</p>}
        <details className="text-ui-support space-y-2"><summary className="cursor-pointer">{t('measurement.conditions')}</summary>
            {snapshot?.conditions && <p>{displayAudioHost(snapshot.conditions.host)} · {snapshot.conditions.input} · ch {snapshot.conditions.channels.map(ch => ch + 1).join('/')} · {Math.round(snapshot.conditions.inputGain * 100)}% · {snapshot.conditions.analysisRate} Hz</p>}
            {snapshot?.capturedAtUnixMs && <p>{new Date(snapshot.capturedAtUnixMs).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')}</p>}
            {snapshot?.previous && snapshot.state !== 'approved' && <p>{t('measurement.previous')}: {snapshot.previous.conditions.input} · {snapshot.previous.capturedAtUnixMs ? new Date(snapshot.previous.capturedAtUnixMs).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US') : '—'}</p>}
            <p>{t('measurement.limits')}</p>
        </details>
    </section>;
}
