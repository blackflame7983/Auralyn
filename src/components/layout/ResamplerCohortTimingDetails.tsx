import { useRef } from 'react';
import type { ResamplerCohortTimingSnapshot, TimingDistribution } from '@/api/audio';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
const countValid = (n: number) => Number.isSafeInteger(n) && n >= 0;
const reasons: Record<string, MessageKey> = {
    conditionsChanged: 'cohortTiming.reason.conditionsChanged', geometryMismatch: 'cohortTiming.reason.geometryMismatch', inputMetadataGap: 'cohortTiming.reason.inputMetadataGap',
    outputMetadataGap: 'cohortTiming.reason.outputMetadataGap', pendingCapacity: 'cohortTiming.reason.pendingCapacity',
    counterOverflow: 'cohortTiming.reason.counterOverflow', timestampOrder: 'cohortTiming.reason.timestampOrder',
    recoverySkip: 'cohortTiming.reason.recoverySkip', ordinalMismatch: 'cohortTiming.reason.ordinalMismatch', nonMicOutput: 'cohortTiming.reason.nonMicOutput',
};
export function ResamplerCohortTimingDetails({ snapshot: s, current }: { snapshot?: ResamplerCohortTimingSnapshot | null; current: boolean }) {
    const t = useMessages();
    const revision = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
    const known = s?.schemaVersion === 2 && ['inputCohortToOutputBufferEnd', 'sameRateInputToOutputBufferEnd'].includes(s.mode) && s.signalCorrespondence === 'notMeasured'
        && ['collecting', 'partial', 'invalid', 'sealed', 'unsupported', 'pending', 'substituted'].includes(s.status)
        && revision(s.windowId) && revision(s.requestedRevision) && revision(s.completedRevision) && revision(s.appliedRevision)
        && BigInt(s.appliedRevision!) <= BigInt(s.completedRevision!) && BigInt(s.completedRevision!) <= BigInt(s.requestedRevision!)
        && (s.rejectedRevision === null || revision(s.rejectedRevision)) && typeof s.normalMicOutput === 'boolean'
        && Array.isArray(s.invalidReasons) && s.invalidReasons.every(r => Object.prototype.hasOwnProperty.call(reasons, r));
    const counts = !!s && [s.receivedInputFrames, s.cohortInputFrames, s.consumedFrames, s.matchedFrames, s.pendingFrames, s.unknownFrames, s.zeroFilledFrames].every(countValid)
        && countValid(s.streamConsumedFrames!) && s.streamConsumedFrames! >= s.consumedFrames && s.cohortInputFrames <= s.receivedInputFrames && s.matchedFrames + s.pendingFrames + s.unknownFrames === s.consumedFrames;
    const geometry = !!s?.geometry && [s.geometry.inputUnitFrames, s.geometry.outputUnitFrames].every(n => countValid(n) && n > 0);
    const latest = useRef<{ epoch: string; window: bigint; requested: bigint; faulted: boolean; sealed: boolean } | null>(null);
    let superseded = false;
    if (known && s) {
        const window = BigInt(s.windowId!); const requested = BigInt(s.requestedRevision!);
        if (latest.current?.epoch !== s.epoch) latest.current = { epoch: s.epoch, window, requested, faulted: false, sealed: false };
        const seen = latest.current!;
        superseded = window < seen.window || requested < seen.requested || seen.faulted || seen.sealed;
        if (window >= seen.window && requested >= seen.requested) { seen.window = window; seen.requested = requested; }
        seen.faulted ||= s.status === 'invalid' || s.status === 'unsupported'; seen.sealed ||= s.status === 'sealed';
    }
    const periodEnd = useRef<{ epoch: string; window: string; end: bigint } | null>(null);
    if (known && s?.periods && revision(s.periods.endNs) && revision(s.windowId)) {
        const end = BigInt(s.periods.endNs);
        if (periodEnd.current?.epoch === s.epoch && periodEnd.current.window === s.windowId) superseded ||= end < periodEnd.current.end;
        if (!superseded) periodEnd.current = { epoch: s.epoch, window: s.windowId, end };
    }
    const active = !superseded && s?.normalMicOutput && s.requestedRevision === s.completedRevision && known && counts && geometry && current && s.status === 'partial' && s.invalidReasons.length === 0 && s.matchedFrames > 0;
    const status = !known || !counts || !geometry ? 'cohortTiming.unknown' : s.status === 'invalid' ? 'cohortTiming.invalid'
        : !current || s.status === 'sealed' ? 'cohortTiming.stopped' : superseded ? 'cohortTiming.staleWindow' : s.status === 'pending' ? 'cohortTiming.pending' : s.status === 'substituted' ? 'cohortTiming.substituted' : active ? 'cohortTiming.observing' : 'cohortTiming.unobserved';
    const count = (n: number | null) => n !== null && countValid(n) ? n.toLocaleString() : t('batchTiming.unobserved');
    const range = (v: { lowerMs: number; upperMs: number | null } | null | undefined) => !v || !Number.isFinite(v.lowerMs) || v.lowerMs < 0
        || (v.upperMs !== null && (!Number.isFinite(v.upperMs) || v.upperMs <= v.lowerMs)) ? t('batchTiming.unobserved')
        : v.upperMs === null ? t('batchTiming.rangeOpen', { lower: v.lowerMs.toFixed(2) }) : t('batchTiming.range', { lower: v.lowerMs.toFixed(2), upper: v.upperMs.toFixed(2) });
    const periods = s?.periods;
    const validDistribution = (d: TimingDistribution | undefined) => !!d && countValid(d.matchedFrames) && !!d.earliestArrivalToEnd && !!d.latestArrivalToEnd;
    const periodKnown = periods?.windowSeconds === 30 && periods.updateIntervalMs === 1000 && periods.startupDurationMs === 3000
        && revision(periods.endNs) && (periods.startNs === null || (revision(periods.startNs) && BigInt(periods.startNs) <= BigInt(periods.endNs)))
        && [periods.recent, periods.startup, periods.steady].every(validDistribution);
    const distribution = (d: TimingDistribution) => <dl className="grid grid-cols-2 gap-2 text-xs">
        <dt>{t('cohortTiming.earliest50')}</dt><dd>{range(d.earliestArrivalToEnd.p50)}</dd>
        <dt>{t('cohortTiming.earliest95')}</dt><dd>{range(d.earliestArrivalToEnd.p95)}</dd>
        <dt>{t('cohortTiming.latest50')}</dt><dd>{range(d.latestArrivalToEnd.p50)}</dd>
        <dt>{t('cohortTiming.latest95')}</dt><dd>{range(d.latestArrivalToEnd.p95)}</dd>
        <dt>{t('timingPeriods.frames')}</dt><dd>{count(d.matchedFrames)}</dd>
    </dl>;
    return <section aria-label={t(s?.mode === 'sameRateInputToOutputBufferEnd' ? 'cohortTiming.directTitle' : 'cohortTiming.title')} className="space-y-2">
        <h3 className="font-semibold">{t(s?.mode === 'sameRateInputToOutputBufferEnd' ? 'cohortTiming.directTitle' : 'cohortTiming.title')}</h3><p className="text-sm">{t(status)}</p><p className="text-xs">{t(s?.mode === 'sameRateInputToOutputBufferEnd' ? 'cohortTiming.directScope' : 'cohortTiming.scope')}</p>
        {known && <p className="text-xs">{t('cohortTiming.window', { window: s.windowId!, requested: s.requestedRevision!, completed: s.completedRevision!, applied: s.appliedRevision! })}</p>}
        {known && <p className="text-xs">{t('cohortTiming.appliedBoundary')}</p>}
        {known && s.rejectedRevision !== null && <p className="text-xs">{t('cohortTiming.rejected', { revision: s.rejectedRevision! })}</p>}
        {active && periodKnown && <div className="space-y-2">
            <div role="group" aria-label={t('timingPeriods.recent')}><h4>{t('timingPeriods.recent')}</h4>{distribution(periods.recent)}</div>
            <p className="text-xs">{t('timingPeriods.boundary')}</p>
            <details><summary>{t('timingPeriods.startup')}</summary>{distribution(periods.startup)}</details>
            <details><summary>{t('timingPeriods.steady')}</summary>{distribution(periods.steady)}</details>
        </div>}
        {active && <details><summary>{t('timingPeriods.cumulative')}</summary><dl className="grid grid-cols-2 gap-2 text-xs">
            <dt>{t('cohortTiming.earliest50')}</dt><dd>{range(s.earliestArrivalToEnd?.p50)}</dd>
            <dt>{t('cohortTiming.earliest95')}</dt><dd>{range(s.earliestArrivalToEnd?.p95)}</dd>
            <dt>{t('cohortTiming.latest50')}</dt><dd>{range(s.latestArrivalToEnd?.p50)}</dd>
            <dt>{t('cohortTiming.latest95')}</dt><dd>{range(s.latestArrivalToEnd?.p95)}</dd>
            <dt>{t('batchTiming.coverage')}</dt><dd>{s.coveragePercent !== null && Number.isFinite(s.coveragePercent) && s.coveragePercent >= 0 && s.coveragePercent <= 100 ? `${s.coveragePercent.toFixed(1)}%` : t('batchTiming.unobserved')}</dd>
        </dl></details>}
        {known && counts && <div className="text-xs">
            <p>{t('batchTiming.counts', { consumed: count(s.consumedFrames), matched: count(s.matchedFrames), pending: count(s.pendingFrames), unknown: count(s.unknownFrames) })}</p>
            <p>{t('cohortTiming.streamCounts', { frames: count(s.streamConsumedFrames!) })}</p>
            <p>{t('cohortTiming.inputCounts', { received: count(s.receivedInputFrames), processed: count(s.cohortInputFrames), remaining: count(s.unemittedInputFrames) })}</p>
            <p>{t('cohortTiming.zeroFill', { frames: count(s.zeroFilledFrames) })}</p>
            {s.invalidReasons.map(reason => <p key={reason}>{t('cohortTiming.reasons', { reason: t(reasons[reason]) })}</p>)}
        </div>}
        <p className="text-xs text-muted-foreground">{t('cohortTiming.limits')}</p>
    </section>;
}
