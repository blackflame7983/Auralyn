import type { ResamplerBatchTimingSnapshot } from '@/api/audio';
import { useMessages } from '@/i18n/LocaleProvider';

const countValid = (value: number) => Number.isSafeInteger(value) && value >= 0;
const finite = (value: number) => Number.isFinite(value) && value >= 0;

export function ResamplerBatchTimingDetails({ snapshot: s, current }: {
    snapshot?: ResamplerBatchTimingSnapshot | null; current: boolean;
}) {
    const t = useMessages();
    const descriptor = s?.declaredResampler;
    const knownMode = s?.mode === 'callbackBatchReadiness';
    const declaredValid = !!descriptor && [descriptor.inputRateHz, descriptor.outputRateHz,
        descriptor.inputChunkFrames, descriptor.maxOutputChunkFrames].every(n => countValid(n) && n > 0)
        && descriptor.inputRateHz !== descriptor.outputRateHz && countValid(descriptor.declaredOutputDelayFrames);
    const countersValid = !!s && [s.consumedFrames, s.matchedFrames, s.pendingFrames, s.unknownFrames].every(countValid)
        && s.matchedFrames + s.pendingFrames + s.unknownFrames === s.consumedFrames;
    const active = current && knownMode && declaredValid && countersValid && s?.supported && !s.sealed && !s.counterInvalid;
    const status = !s || !knownMode || !declaredValid ? 'batchTiming.unknown'
        : s.counterInvalid ? 'batchTiming.invalid'
            : !countersValid ? 'batchTiming.unknown'
                : !s.supported ? 'batchTiming.unsupported'
                : s.sealed || !current ? 'batchTiming.stopped'
                    : s.matchedFrames === 0 ? 'batchTiming.pending' : 'batchTiming.observing';
    const count = (value: number) => countValid(value) ? value.toLocaleString() : t('batchTiming.unobserved');
    const range = (value: ResamplerBatchTimingSnapshot['p50']) => !value || !finite(value.lowerMs)
        || (value.upperMs !== null && (!finite(value.upperMs) || value.upperMs <= value.lowerMs))
        ? t('batchTiming.unobserved') : value.upperMs === null
            ? t('batchTiming.rangeOpen', { lower: value.lowerMs.toFixed(2) })
            : t('batchTiming.range', { lower: value.lowerMs.toFixed(2), upper: value.upperMs.toFixed(2) });
    return <section aria-label={t('batchTiming.title')} className="space-y-2">
        <h3 className="font-semibold">{t('batchTiming.title')}</h3>
        <p className="text-sm">{t(status)}</p>
        <p className="text-xs">{t('batchTiming.scope')}</p>
        {active && s && <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt>{t('batchTiming.p50')}</dt><dd>{s.matchedFrames > 0 ? range(s.p50) : t('batchTiming.unobserved')}</dd>
            <dt>{t('batchTiming.p95')}</dt><dd>{s.matchedFrames > 0 ? range(s.p95) : t('batchTiming.unobserved')}</dd>
            <dt>{t('batchTiming.coverage')}</dt><dd>{s.matchedFrames > 0 && s.coveragePercent !== null && finite(s.coveragePercent) && s.coveragePercent <= 100
                ? `${s.coveragePercent.toFixed(1)}%` : t('batchTiming.unobserved')}</dd>
        </dl>}
        {knownMode && s && <>
            <p className="text-xs">{t('batchTiming.counts', { consumed: count(s.consumedFrames), matched: count(s.matchedFrames), pending: count(s.pendingFrames), unknown: count(s.unknownFrames) })}</p>
            <p className="text-xs">{t('batchTiming.metadata', { input: count(s.inputMetadataDropped), output: count(s.outputMetadataDropped), invalid: count(s.invalidEvents), evicted: count(s.pendingEvictions) })}</p>
            <p className="text-xs">{t('batchTiming.period', { seconds: finite(s.observationMs) ? (s.observationMs / 1000).toFixed(2) : t('batchTiming.unobserved'), resolution: finite(s.histogramResolutionMs) ? s.histogramResolutionMs.toFixed(2) : t('batchTiming.unobserved') })}</p>
        </>}
        {knownMode && declaredValid && descriptor && <div className="space-y-1 text-xs">
            <h4 className="font-semibold">{t('batchTiming.declared')}</h4>
            <dl className="grid grid-cols-2 gap-2">
                <dt>{t('batchTiming.rates')}</dt><dd>{descriptor.inputRateHz.toLocaleString()} → {descriptor.outputRateHz.toLocaleString()} Hz</dd>
                <dt>{t('batchTiming.chunks')}</dt><dd>{descriptor.inputChunkFrames.toLocaleString()} / {descriptor.maxOutputChunkFrames.toLocaleString()} frame</dd>
                <dt>{t('batchTiming.delay')}</dt><dd>{t('batchTiming.delayValue', { frames: descriptor.declaredOutputDelayFrames.toLocaleString(), ms: (descriptor.declaredOutputDelayFrames * 1000 / descriptor.outputRateHz).toFixed(2) })}</dd>
            </dl>
            <p>{t('batchTiming.noAddition')}</p>
        </div>}
        <p className="text-xs text-muted-foreground">{t('batchTiming.limits')}</p>
    </section>;
}
