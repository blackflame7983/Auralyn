import type { EngineRuntimeStats, FrameTimingSnapshot } from '@/api/audio';

const revision = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
type Range = NonNullable<FrameTimingSnapshot['p50']>;
export interface RecentCohortTracker { epoch: string; window: bigint; requested: bigint; end: bigint; changedAt: number; progressed: boolean; faulted: boolean; sealed: boolean; priorEpochs: Set<string> }

// 欠測や失効の値を直近値として扱わない。音声信号そのものの到達時間ではない。
export function recentCohort(stats: EngineRuntimeStats | null, running: boolean, now: number, previous: RecentCohortTracker | null): { range: Range | null; tracker: RecentCohortTracker | null } {
    const s = stats?.resamplerCohortTiming; const q = stats?.queueDiagnostics; const m = stats?.latencyMetadata;
    if (!running || !s || !q || !m || m.schemaVersion !== 1 || !m.streamRunning || q.state !== 'running' || q.epoch !== s.epoch || !s.epoch) return { range: null, tracker: previous };
    if (s.status === 'invalid' || s.status === 'unsupported' || s.status === 'sealed') {
        if (previous?.epoch !== s.epoch && previous?.priorEpochs.has(s.epoch)) return { range: null, tracker: previous };
        const base = previous?.epoch === s.epoch ? previous : {
            epoch: s.epoch, window: revision(s.windowId) ? BigInt(s.windowId) : 0n,
            requested: revision(s.requestedRevision) ? BigInt(s.requestedRevision) : 0n,
            end: 0n, changedAt: now, progressed: false, faulted: false, sealed: false,
            priorEpochs: new Set([...(previous?.priorEpochs ?? []), ...(previous ? [previous.epoch] : [])].slice(-32)),
        };
        const tracker = { ...base, faulted: base.faulted || s.status !== 'sealed', sealed: base.sealed || s.status === 'sealed' };
        return { range: null, tracker };
    }
    if (s.schemaVersion !== 2 || !['inputCohortToOutputBufferEnd', 'sameRateInputToOutputBufferEnd'].includes(s.mode) || s.signalCorrespondence !== 'notMeasured'
        || !revision(s.windowId) || !revision(s.requestedRevision) || !revision(s.completedRevision) || !revision(s.appliedRevision)
        || (s.rejectedRevision !== null && !revision(s.rejectedRevision)) || !Array.isArray(s.invalidReasons)
        || !s.geometry || ![s.geometry.inputUnitFrames, s.geometry.outputUnitFrames].every(n => count(n) && n > 0)
        || ![s.receivedInputFrames, s.cohortInputFrames, s.consumedFrames, s.matchedFrames, s.pendingFrames, s.unknownFrames, s.zeroFilledFrames, s.streamConsumedFrames].every(count)
        || s.streamConsumedFrames! < s.consumedFrames || s.cohortInputFrames > s.receivedInputFrames || s.matchedFrames + s.pendingFrames + s.unknownFrames !== s.consumedFrames
        || BigInt(s.appliedRevision) > BigInt(s.completedRevision) || BigInt(s.completedRevision) > BigInt(s.requestedRevision)) return { range: null, tracker: previous };
    const p = s.periods;
    if (!p || p.windowSeconds !== 30 || p.updateIntervalMs !== 1000 || p.startupDurationMs !== 3000 || !revision(p.endNs)
        || (p.startNs !== null && (!revision(p.startNs) || BigInt(p.startNs) > BigInt(p.endNs)))) return { range: null, tracker: previous };
    const window = BigInt(s.windowId); const requested = BigInt(s.requestedRevision); const end = BigInt(p.endNs);
    let tracker = previous;
    if (!tracker || tracker.epoch !== s.epoch) {
        if (tracker?.priorEpochs.has(s.epoch)) return { range: null, tracker };
        const priorEpochs = [...(tracker?.priorEpochs ?? []), ...(tracker ? [tracker.epoch] : [])].slice(-32);
        tracker = { epoch: s.epoch, window, requested, end, changedAt: now, progressed: false, faulted: false, sealed: false, priorEpochs: new Set(priorEpochs) };
    } else {
        if (window < tracker.window || requested < tracker.requested || (window === tracker.window && end < tracker.end)) return { range: null, tracker };
        if (window !== tracker.window || end > tracker.end) tracker = { ...tracker, window, requested, end, changedAt: now, progressed: window === tracker.window && end > tracker.end };
        else tracker = { ...tracker, requested };
    }
    const recent = p.recent; const range = recent?.earliestArrivalToEnd?.p50;
    if (tracker.faulted || tracker.sealed || s.status !== 'partial' || !s.normalMicOutput || s.requestedRevision !== s.completedRevision
        || s.invalidReasons.length !== 0 || s.matchedFrames < 1 || !count(recent?.matchedFrames) || recent.matchedFrames < 1
        || !tracker.progressed || now - tracker.changedAt >= 2500 || !range || !Number.isFinite(range.lowerMs) || range.lowerMs < 0
        || (range.upperMs !== null && (!Number.isFinite(range.upperMs) || range.upperMs <= range.lowerMs))) return { range: null, tracker };
    return { range, tracker };
}
