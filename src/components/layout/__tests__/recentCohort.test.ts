import { expect, it } from 'vitest';
import type { EngineRuntimeStats } from '@/api/audio';
import { recentCohort } from '../recentCohort';

function fixture(): EngineRuntimeStats {
    const distribution = { matchedFrames: 1, earliestArrivalToEnd: { p50: { lowerMs: 4, upperMs: 4.1 }, p95: null }, latestArrivalToEnd: { p50: null, p95: null } };
    return { queueDiagnostics: { state: 'running', epoch: 'e1' }, latencyMetadata: { schemaVersion: 1, streamRunning: true }, resamplerCohortTiming: {
        schemaVersion: 2, epoch: 'e1', mode: 'sameRateInputToOutputBufferEnd', status: 'partial', signalCorrespondence: 'notMeasured',
        windowId: '1', requestedRevision: '1', completedRevision: '1', appliedRevision: '1', rejectedRevision: null, normalMicOutput: true,
        geometry: { inputUnitFrames: 1, outputUnitFrames: 1 }, streamConsumedFrames: 10, receivedInputFrames: 10, cohortInputFrames: 10,
        consumedFrames: 10, matchedFrames: 10, pendingFrames: 0, unknownFrames: 0, zeroFilledFrames: 0, invalidReasons: [],
        periods: { windowSeconds: 30, updateIntervalMs: 1000, startupDurationMs: 3000, startNs: '0', endNs: '30000000000', recent: distribution, startup: distribution, steady: distribution },
    } } as unknown as EngineRuntimeStats;
}
it('直近の有効な範囲だけを表示し、period進行停止・遅い応答・停止を失効させる', () => {
    const stats = fixture(); const first = recentCohort(stats, true, 0, null);
    expect(first.range).toBeNull();
    expect(recentCohort(stats, true, 2500, first.tracker).range).toBeNull();
    const p = stats.resamplerCohortTiming!.periods!;
    p.endNs = '31000000000'; const next = recentCohort(stats, true, 3000, first.tracker);
    expect(next.range).toEqual({ lowerMs: 4, upperMs: 4.1 });
    p.endNs = '30000000000'; expect(recentCohort(stats, true, 3100, next.tracker).range).toBeNull();
    expect(recentCohort(stats, false, 3100, next.tracker).range).toBeNull();
});
it('条件変更待ち・停止・欠測・違うepoch・不正区間を数値にしない', () => {
    const stats = fixture(); const s = stats.resamplerCohortTiming!;
    s.completedRevision = '0'; expect(recentCohort(stats, true, 0, null).range).toBeNull();
    s.completedRevision = '1'; s.normalMicOutput = false; expect(recentCohort(stats, true, 0, null).range).toBeNull();
    s.normalMicOutput = true; s.periods!.recent.matchedFrames = 0; expect(recentCohort(stats, true, 0, null).range).toBeNull();
    s.periods!.recent.matchedFrames = 1; s.periods!.recent.earliestArrivalToEnd.p50 = { lowerMs: 4, upperMs: 3 };
    expect(recentCohort(stats, true, 0, null).range).toBeNull();
    stats.queueDiagnostics!.epoch = 'wrong'; expect(recentCohort(stats, true, 0, null).range).toBeNull();
});
it('永久fault後の同epochの古い値は戻さず、新epochは受け入れる', () => {
    const stats = fixture(); const first = recentCohort(stats, true, 0, null);
    stats.resamplerCohortTiming!.status = 'invalid'; const bad = recentCohort(stats, true, 1, first.tracker);
    stats.resamplerCohortTiming!.status = 'partial'; expect(recentCohort(stats, true, 2, bad.tracker).range).toBeNull();
    stats.resamplerCohortTiming!.epoch = 'e2'; stats.queueDiagnostics!.epoch = 'e2'; const fresh = recentCohort(stats, true, 3, bad.tracker);
    expect(fresh.range).toBeNull();
    stats.resamplerCohortTiming!.periods!.endNs = '31000000000';
    expect(recentCohort(stats, true, 4, fresh.tracker).range).not.toBeNull();
    stats.resamplerCohortTiming!.epoch = 'e1'; stats.queueDiagnostics!.epoch = 'e1'; expect(recentCohort(stats, true, 4, fresh.tracker).range).toBeNull();
});
