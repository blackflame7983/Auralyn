import { useMessages } from '@/i18n/LocaleProvider';
import type { FrameTimingSnapshot } from '@/api/audio';

const finite = (n: number) => Number.isFinite(n) && n >= 0;


export function FrameTimingDetails({ snapshot: s, current }: { snapshot?: FrameTimingSnapshot | null; current: boolean }) {
    const t = useMessages();
    const count = (n: number) => finite(n) ? n.toLocaleString() : t('meterBrowser.copy.157');
    const range = (q: FrameTimingSnapshot['p50']) => !q || !finite(q.lowerMs) || (q.upperMs !== null && (!finite(q.upperMs) || q.upperMs <= q.lowerMs))
        ? t('meterBrowser.copy.158') : q.upperMs === null ? t('meterBrowser.copy.159', { arg0: q.lowerMs.toFixed(2) }) : t('meterBrowser.copy.160', { arg0: q.lowerMs.toFixed(2), arg1: q.upperMs.toFixed(2) });
    const active = current && s?.supported && !s.sealed && !s.counterInvalid;
    const status = !s ? t('meterBrowser.copy.161')
        : !s.supported ? t('meterBrowser.copy.162')
            : s.counterInvalid ? t('meterBrowser.copy.163')
                : s.sealed || !current ? t('meterBrowser.copy.164')
                    : s.matchedFrames === 0 ? t('meterBrowser.copy.165') : t('meterBrowser.copy.166');
    return <section aria-label={t('meterBrowser.copy.167')} className="space-y-2">
        <h3 className="font-semibold">{t('meterBrowser.copy.168')}</h3>
        <p className="text-sm">{status}</p>
        {s && <>
            {active && <dl className="grid grid-cols-2 gap-2 text-xs">
                <dt>{t('meterBrowser.copy.169')}</dt><dd>{range(s.p50)}</dd>
                <dt>{t('meterBrowser.copy.170')}</dt><dd>{range(s.p95)}</dd>
                <dt>{t('meterBrowser.copy.171')}</dt><dd>{s.coveragePercent !== null && finite(s.coveragePercent) && s.coveragePercent <= 100 ? `${s.coveragePercent.toFixed(1)}%` : t('meterBrowser.copy.172')}</dd>
            </dl>}
            <p className="text-xs">{t('meterBrowser.frame.counts', { consumed: count(s.consumedFrames), matched: count(s.matchedFrames), pending: count(s.pendingFrames), missing: count(s.unknownFrames) })}</p>
            <p className="text-xs">{t('meterBrowser.copy.177')}</p>
            <p className="text-xs">{t('meterBrowser.frame.lost', { input: count(s.inputMetadataDropped), output: count(s.outputMetadataDropped), invalid: count(s.invalidEvents), evicted: count(s.pendingEvictions) })}</p>
            <p className="text-xs">{t('meterBrowser.frame.period', { seconds: finite(s.observationMs) ? (s.observationMs / 1000).toFixed(2) : t('meterBrowser.copy.184'), resolution: finite(s.histogramResolutionMs) ? s.histogramResolutionMs.toFixed(2) : t('meterBrowser.copy.186') })}</p>
            <p className="break-all text-xs text-muted-foreground">{t('meterBrowser.copy.188')}{s.epoch}</p>
        </>}
        <p className="text-xs text-muted-foreground">{t('meterBrowser.copy.189')}</p>
    </section>;
}
