import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { FrameTimingSnapshot } from '@/api/audio';
import { FrameTimingDetails } from '../FrameTimingDetails';

const snapshot = (patch: Partial<FrameTimingSnapshot> = {}): FrameTimingSnapshot => ({
    epoch: 'engine:queue:1', supported: true, sealed: false, counterInvalid: false,
    consumedFrames: 100, matchedFrames: 80, pendingFrames: 10, unknownFrames: 10,
    coveragePercent: 80, p50: { lowerMs: 5.3, upperMs: 5.4 }, p95: { lowerMs: 10.6, upperMs: 10.7 },
    histogramResolutionMs: 0.1, observationMs: 1500,
    inputMetadataDropped: 1, outputMetadataDropped: 2, invalidEvents: 0, pendingEvictions: 0,
    overlappingCallbackFrames: 5, asioCycleClassification: 'unknownUnverifiedClock', ...patch,
});
afterEach(cleanup);
it('frame加重の範囲・coverage・欠測を示し、全信号通過時間やASIO周期を実測扱いしない', () => {
    render(<FrameTimingDetails snapshot={snapshot()} current />);
    expect(screen.getByText('5.30〜5.40 ms未満')).toBeInTheDocument();
    expect(screen.getByText('80.0%')).toBeInTheDocument();
    expect(screen.getByText(/読出し 100 frame／対応済 80／結合待ち 10／欠測 10/)).toBeInTheDocument();
    expect(screen.getByText(/入力 1件・出力 2件/)).toBeInTheDocument();
    expect(screen.getByText(/ASIOの周期対応は未確認/)).toBeInTheDocument();
    expect(screen.getByText(/全通過時間は未測定/)).toBeInTheDocument();
});
it('未取得・異率・未観測・停止・counter異常で現在の0ms成功へ置き換えない', () => {
    const view = render(<FrameTimingDetails current />);
    expect(screen.getByText(/旧形式を含みます/)).toBeInTheDocument();
    view.rerender(<FrameTimingDetails snapshot={snapshot({ supported: false })} current />);
    expect(screen.getByText(/異なるレート.*未対応/)).toBeInTheDocument();
    expect(screen.queryByText('80.0%')).not.toBeInTheDocument();
    view.rerender(<FrameTimingDetails snapshot={snapshot({ p50: null, p95: null, matchedFrames: 0, coveragePercent: null })} current />);
    expect(screen.getByText(/まだ未観測/)).toBeInTheDocument();
    expect(screen.getAllByText('未観測').length).toBe(3);
    view.rerender(<FrameTimingDetails snapshot={snapshot()} current={false} />);
    expect(screen.getByText(/停止中・未確認/)).toBeInTheDocument();
    expect(screen.queryByText('5.30〜5.40 ms未満')).not.toBeInTheDocument();
    view.rerender(<FrameTimingDetails snapshot={snapshot({ sealed: true })} current />);
    expect(screen.queryByText('80.0%')).not.toBeInTheDocument();
    view.rerender(<FrameTimingDetails snapshot={snapshot({ counterInvalid: true })} current />);
    expect(screen.getByText(/counterが無効/)).toBeInTheDocument();
});
it('最終bucketは上限不明、不正な範囲・割合は未観測として扱う', () => {
    const view = render(<FrameTimingDetails snapshot={snapshot({ p50: { lowerMs: 1000, upperMs: null }, p95: { lowerMs: NaN, upperMs: 1 }, coveragePercent: NaN })} current />);
    expect(screen.getByText('1000.00 ms以上（上限不明）')).toBeInTheDocument();
    expect(screen.getAllByText('未観測').length).toBe(2);
    view.rerender(<FrameTimingDetails snapshot={snapshot({ p50: { lowerMs: 10, upperMs: 1 } })} current />);
    expect(screen.getByText('未観測')).toBeInTheDocument();
});

it('停止状態でもlocaleのみで表示が変わり、結合待ちと欠測を統合しない', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><FrameTimingDetails snapshot={snapshot()} current={false} /></LocaleProvider>);
    const section = screen.getByRole('region', { name: '対応frameの読出し時間' });
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('region', { name: 'Corresponding-frame read timing' })).toBe(section);
    expect(screen.getByText(/Read 100 frames \/ matched 80 \/ pending join 10 \/ missing 10/)).toBeInTheDocument();
    expect(screen.getByText(/Stopped or unconfirmed/)).toBeInTheDocument();
    expect(screen.queryByText('80.0%')).not.toBeInTheDocument();
    expect(screen.getByText(/ASIO cycle correspondence is unverified/)).toBeInTheDocument();
});
