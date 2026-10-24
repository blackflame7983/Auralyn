import type { EngineRuntimeStats, ResamplerCohortTimingSnapshot } from '@/api/audio';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { LatencyDetails } from '../LatencyDetails';
import { ResamplerCohortTimingDetails } from '../ResamplerCohortTimingDetails';
const packet = (patch: Partial<ResamplerCohortTimingSnapshot> = {}): ResamplerCohortTimingSnapshot => ({
    schemaVersion: 2, windowId: '1', requestedRevision: '0', completedRevision: '0', appliedRevision: '0', rejectedRevision: null, normalMicOutput: true, streamConsumedFrames: 100, epoch: 'cohort:1', mode: 'inputCohortToOutputBufferEnd', status: 'partial', signalCorrespondence: 'notMeasured',
    geometry: { inputUnitFrames: 294, outputUnitFrames: 320 }, receivedInputFrames: 1024, cohortInputFrames: 882, unemittedInputFrames: 142,
    consumedFrames: 100, matchedFrames: 80, pendingFrames: 20, unknownFrames: 0, zeroFilledFrames: 8, coveragePercent: 80,
    earliestArrivalToEnd: { p50: { lowerMs: 12, upperMs: 12.1 }, p95: { lowerMs: 13, upperMs: 13.1 } },
    latestArrivalToEnd: { p50: { lowerMs: 3, upperMs: 3.1 }, p95: { lowerMs: 5, upperMs: 5.1 } }, invalidReasons: [], ...patch,
});
afterEach(cleanup);
it('蓄積到着区間とcarryを表示しDSP全信号を観測したとしない', () => {
    render(<ResamplerCohortTimingDetails snapshot={packet()} current />);
    expect(screen.getByText('12.00〜12.10 ms未満')).toBeInTheDocument();
    expect(screen.getByText('3.00〜3.10 ms未満')).toBeInTheDocument();
    expect(screen.getByText(/原入力 1,024 frame／cohort消費 882／未生成・carry 142/)).toBeInTheDocument();
    expect(screen.getByText(/NRのdry\/wet混合/)).toBeInTheDocument();
    expect(screen.getByText(/信号の点対応や総信号遅延ではありません/)).toBeInTheDocument();
});
it('旧missing/null/不正count/未知modeやsignal保証はunknownで数値を採用しない', () => {
    const view = render(<ResamplerCohortTimingDetails current />);
    for (const snapshot of [undefined, null, packet({ schemaVersion: 1 }), packet({ matchedFrames: 101 }), packet({ mode: 'future' as never }), packet({ signalCorrespondence: 'measured' as never }), packet({ invalidReasons: ['future'] })]) {
        view.rerender(<ResamplerCohortTimingDetails snapshot={snapshot} current />);
        expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
        expect(screen.getByText(/入力cohort観測は未取得/)).toBeInTheDocument();
    }
});
it('skip/nonmic/停止/旧条件で現在分位を残さず理由を表示する', () => {
    const view = render(<ResamplerCohortTimingDetails snapshot={packet()} current />);
    for (const reason of ['recoverySkip', 'nonMicOutput']) {
        view.rerender(<ResamplerCohortTimingDetails snapshot={packet({ status: 'invalid', invalidReasons: [reason] })} current />);
        expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
        expect(screen.getByText(/失効理由/)).toBeInTheDocument();
    }
    view.rerender(<ResamplerCohortTimingDetails snapshot={packet({ status: 'sealed' })} current />);
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
    view.rerender(<ResamplerCohortTimingDetails snapshot={packet()} current={false} />);
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
});
it('未観測/不正分位を0msにせず言語だけ切替えてpacketと同じsectionを保持する', () => {
    const store = createLocaleStore(() => 'ja', () => true); const data = packet({ latestArrivalToEnd: { p50: null, p95: { lowerMs: NaN, upperMs: 1 } } });
    const view = render(<LocaleProvider store={store}><ResamplerCohortTimingDetails snapshot={data} current /></LocaleProvider>);
    const region = screen.getByRole('region', { name: '蓄積入力cohortから出力bufferまで' });
    expect(screen.getAllByText('未観測')).toHaveLength(2);
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('region', { name: 'Accumulated input cohort to output buffer' })).toBe(region);
    expect(screen.getByText('12.00 to below 12.10 ms')).toBeInTheDocument();
    view.rerender(<LocaleProvider store={store}><ResamplerCohortTimingDetails snapshot={packet({ matchedFrames: 0, pendingFrames: 100 })} current /></LocaleProvider>);
    expect(screen.queryByText('12.00 to below 12.10 ms')).not.toBeInTheDocument();
});

it('同epochのpacketだけを表示し、未取得/旧epoch/停止では現在分位を出さない', () => {
    const stats = { resamplerCohortTiming: packet(), queueDiagnostics: { epoch: 'cohort:1', state: 'running' }, latencyMetadata: { schemaVersion: 1, streamRunning: true } } as EngineRuntimeStats;
    const view = render(<LatencyDetails stats={stats} />);
    expect(screen.getByText('12.00〜12.10 ms未満')).toBeInTheDocument();
    view.rerender(<LatencyDetails stats={{ ...stats, queueDiagnostics: { ...stats.queueDiagnostics!, epoch: 'old' } }} />);
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
    view.rerender(<LatencyDetails stats={stats} isRunning={false} />);
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
});
it('末尾bucketの上限不明を値0や有限上限へ置換しない', () => {
    render(<ResamplerCohortTimingDetails snapshot={packet({ earliestArrivalToEnd: { p50: { lowerMs: 1000, upperMs: null }, p95: null } })} current />);
    expect(screen.getByText('1000.00 ms以上（上限不明）')).toBeInTheDocument();
});

it('pending/旧窓を表示せずRT完了後だけ新CDFを採用し、localeで窓をresetしない', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const wrap = (data: ResamplerCohortTimingSnapshot) => <LocaleProvider store={store}><ResamplerCohortTimingDetails snapshot={data} current /></LocaleProvider>;
    const view = render(wrap(packet({ status: 'pending', requestedRevision: '1' })));
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
    view.rerender(wrap(packet())); // Late response before the request must not revive the old CDF.
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
    const applied = packet({ windowId: '2', requestedRevision: '1', completedRevision: '1', appliedRevision: '1' });
    view.rerender(wrap(applied));expect(screen.getByText('12.00〜12.10 ms未満')).toBeInTheDocument();
    act(() => { store.setLocale('en'); });expect(screen.getByText('12.00 to below 12.10 ms')).toBeInTheDocument();
    view.rerender(wrap(packet()));expect(screen.queryByText('12.00 to below 12.10 ms')).not.toBeInTheDocument();
});
it('同率direct窓・一時差替えからの復帰と拒否revisionを区別する', () => {
    const view = render(<ResamplerCohortTimingDetails snapshot={packet({ mode: 'sameRateInputToOutputBufferEnd', status: 'substituted', normalMicOutput: false })} current />);
    expect(screen.getByRole('region', { name: '入力callbackから出力buffer完了まで' })).toBeInTheDocument();
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
    view.rerender(<ResamplerCohortTimingDetails snapshot={packet({ mode: 'sameRateInputToOutputBufferEnd', windowId: '2' })} current />);
    expect(screen.getByText('12.00〜12.10 ms未満')).toBeInTheDocument();
    view.rerender(<ResamplerCohortTimingDetails snapshot={packet({ windowId: '3', requestedRevision: '2', completedRevision: '2', appliedRevision: '1', rejectedRevision: '2' })} current />);
    expect(screen.getByText(/要求 2 はRT側で拒否/)).toBeInTheDocument();
});
it('恒久faultとseal後の古い正常packetは同epochで復活せず新epochだけ再開する', () => {
    const view = render(<ResamplerCohortTimingDetails snapshot={packet({ status: 'invalid', invalidReasons: ['recoverySkip'] })} current />);
    view.rerender(<ResamplerCohortTimingDetails snapshot={packet({ windowId: '3' })} current />);
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
    view.rerender(<ResamplerCohortTimingDetails snapshot={packet({ epoch: 'new-start' })} current />);
    expect(screen.getByText('12.00〜12.10 ms未満')).toBeInTheDocument();
    view.rerender(<ResamplerCohortTimingDetails snapshot={packet({ epoch: 'new-start', status: 'sealed' })} current />);
    view.rerender(<ResamplerCohortTimingDetails snapshot={packet({ epoch: 'new-start' })} current />);
    expect(screen.queryByText('12.00〜12.10 ms未満')).not.toBeInTheDocument();
});
