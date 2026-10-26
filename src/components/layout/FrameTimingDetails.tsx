import { useMessages } from '@/i18n/LocaleProvider';
import type { FrameTimingSnapshot } from '@/api/audio';

const finite = (n: number) => Number.isFinite(n) && n >= 0;


export function FrameTimingDetails({ snapshot: s, current }: { snapshot?: FrameTimingSnapshot | null; current: boolean }) {
    const t = useMessages();
    const count = (n: number) => finite(n) ? n.toLocaleString() : t('frameTiming.unknown');
    const range = (q: FrameTimingSnapshot['p50']) => !q || !finite(q.lowerMs) || (q.upperMs !== null && (!finite(q.upperMs) || q.upperMs <= q.lowerMs))
        ? t('frameTiming.unobserved') : q.upperMs === null ? t('frameTiming.lowerBound', { arg0: q.lowerMs.toFixed(2) }) : t('frameTiming.range', { arg0: q.lowerMs.toFixed(2), arg1: q.upperMs.toFixed(2) });
    const active = current && s?.supported && !s.sealed && !s.counterInvalid;
    const status = !s ? t('frameTiming.missing')
        : !s.supported ? t('frameTiming.differentRates')
            : s.counterInvalid ? t('frameTiming.invalidCounters')
                : s.sealed || !current ? t('frameTiming.stopped')
                    : s.matchedFrames === 0 ? t('frameTiming.pending') : t('frameTiming.observing');
    return <section aria-label={t('frameTiming.title')} className="space-y-2">
        <h3 className="font-semibold">{t('frameTiming.title')}</h3>
        <p className="text-sm">{status}</p>
        {s && <>
            {active && <dl className="grid grid-cols-2 gap-2 text-xs">
                <dt>{t('frameTiming.median')}</dt><dd>{range(s.p50)}</dd>
                <dt>{t('frameTiming.p95')}</dt><dd>{range(s.p95)}</dd>
                <dt>{t('frameTiming.coverage')}</dt><dd>{s.coveragePercent !== null && finite(s.coveragePercent) && s.coveragePercent <= 100 ? `${s.coveragePercent.toFixed(1)}%` : t('frameTiming.unobserved')}</dd>
            </dl>}
            <p className="text-xs">{t('frameTiming.counts', { consumed: count(s.consumedFrames), matched: count(s.matchedFrames), pending: count(s.pendingFrames), missing: count(s.unknownFrames) })}</p>
            <p className="text-xs">{t('frameTiming.pendingScope')}</p>
            <p className="text-xs">{t('frameTiming.lost', { input: count(s.inputMetadataDropped), output: count(s.outputMetadataDropped), invalid: count(s.invalidEvents), evicted: count(s.pendingEvictions) })}</p>
            <p className="text-xs">{t('frameTiming.period', { seconds: finite(s.observationMs) ? (s.observationMs / 1000).toFixed(2) : t('frameTiming.unknown'), resolution: finite(s.histogramResolutionMs) ? s.histogramResolutionMs.toFixed(2) : t('frameTiming.unknown') })}</p>
            <p className="break-all text-xs text-muted-foreground">{t('frameTiming.epoch')}{s.epoch}</p>
        </>}
        <p className="text-xs text-muted-foreground">{t('frameTiming.limitations')}</p>
    </section>;
}
