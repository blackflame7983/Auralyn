import type { EngineRuntimeStats, ResamplerBatchTimingSnapshot } from '@/api/audio';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { LatencyDetails } from '../LatencyDetails';
import { ResamplerBatchTimingDetails } from '../ResamplerBatchTimingDetails';

const snapshot = (patch: Partial<ResamplerBatchTimingSnapshot> = {}): ResamplerBatchTimingSnapshot => ({
    mode: 'callbackBatchReadiness',
    declaredResampler: { inputRateHz: 44100, outputRateHz: 48000, inputChunkFrames: 1024,
        maxOutputChunkFrames: 1280, declaredOutputDelayFrames: 320 },
    epoch: 'engine:batch:1', supported: true, sealed: false, counterInvalid: false,
    consumedFrames: 100, matchedFrames: 80, pendingFrames: 10, unknownFrames: 10,
    coveragePercent: 80, p50: { lowerMs: 5.3, upperMs: 5.4 }, p95: { lowerMs: 10.6, upperMs: 10.7 },
    histogramResolutionMs: 0.1, observationMs: 1500,
    inputMetadataDropped: 1, outputMetadataDropped: 2, invalidEvents: 0, pendingEvictions: 0,
    overlappingCallbackFrames: 5, asioCycleClassification: 'unknownUnverifiedClock', ...patch,
});
afterEach(cleanup);

it('生成出力の観測と申告delayを分け、過去入力・FIR・全通過時間の未測定範囲を示す', () => {
    render(<ResamplerBatchTimingDetails snapshot={snapshot()} current />);
    expect(screen.getByText('5.30〜5.40 ms未満')).toBeInTheDocument();
    expect(screen.getByText('320 出力frame（6.67 ms）')).toBeInTheDocument();
    expect(screen.getByText('80.0%')).toBeInTheDocument();
    expect(screen.getByText(/読出し 100 生成出力frame／対応済 80／結合待ち 10／欠測 10/)).toBeInTheDocument();
    expect(screen.getByText(/過去の入力を集める待ち時間、FIRの信号遅延/)).toBeInTheDocument();
    expect(screen.getByText(/加算・減算していません/)).toBeInTheDocument();
});

it('未観測を0msとせず、停止・seal・失効後の分位や割合を現在値にしない', () => {
    const view = render(<ResamplerBatchTimingDetails snapshot={snapshot({ matchedFrames: 0, pendingFrames: 100, unknownFrames: 0,
        p50: { lowerMs: 0, upperMs: 0.1 } })} current />);
    expect(screen.getByText(/結合できた生成出力はまだありません/)).toBeInTheDocument();
    expect(screen.queryByText('0.00〜0.10 ms未満')).not.toBeInTheDocument();
    expect(screen.queryByText('80.0%')).not.toBeInTheDocument();
    for (const props of [{ snapshot: snapshot(), current: false }, { snapshot: snapshot({ sealed: true }), current: true },
        { snapshot: snapshot({ counterInvalid: true }), current: true }]) {
        view.rerender(<ResamplerBatchTimingDetails {...props} />);
        expect(screen.queryByText('5.30〜5.40 ms未満')).not.toBeInTheDocument();
        expect(screen.queryByText('80.0%')).not.toBeInTheDocument();
    }
    expect(screen.getByText(/観測が失効/)).toBeInTheDocument();
});

it('旧missing・null・未知mode・不正descriptorやcountは未取得として数値を採用しない', () => {
    const view = render(<ResamplerBatchTimingDetails current />);
    expect(screen.getByText(/旧エンジンを含みます/)).toBeInTheDocument();
    const invalidMode = { ...snapshot(), mode: 'futureMode' } as unknown as ResamplerBatchTimingSnapshot;
    for (const value of [null, invalidMode, snapshot({ declaredResampler: { ...snapshot().declaredResampler, outputRateHz: 0 } }),
        snapshot({ matchedFrames: 101 }), snapshot({ consumedFrames: NaN })]) {
        view.rerender(<ResamplerBatchTimingDetails snapshot={value} current />);
        expect(screen.getByText(/旧エンジンを含みます/)).toBeInTheDocument();
        expect(screen.queryByText('5.30〜5.40 ms未満')).not.toBeInTheDocument();
    }
});

it('不正分位・割合と上限不明bucketを区別する', () => {
    render(<ResamplerBatchTimingDetails snapshot={snapshot({ p50: { lowerMs: 1000, upperMs: null },
        p95: { lowerMs: NaN, upperMs: 1 }, coveragePercent: Infinity })} current />);
    expect(screen.getByText('1000.00 ms以上（上限不明）')).toBeInTheDocument();
    expect(screen.getAllByText('未観測')).toHaveLength(2);
});

it('表示の言語だけを切り替え、同じsectionと元の観測packetを保持する', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const packet = snapshot();
    const before = structuredClone(packet);
    render(<LocaleProvider store={store}><ResamplerBatchTimingDetails snapshot={packet} current /></LocaleProvider>);
    const section = screen.getByRole('region', { name: 'レート変換バッチの読出し時間' });
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('region', { name: 'Resampler batch read timing' })).toBe(section);
    expect(screen.getByText('5.30 to below 5.40 ms')).toBeInTheDocument();
    expect(screen.getByText(/Read 100 generated output frames \/ matched 80 \/ pending join 10 \/ missing 10/)).toBeInTheDocument();
    expect(screen.getByText(/earlier input accumulation/)).toBeInTheDocument();
    expect(packet).toEqual(before);
});

it('遅延詳細へ新しい観測だけを渡し、旧missing形式や停止で現在の分位を出さずIPCを増やさない', () => {
    vi.mocked(invoke).mockClear();
    const stats = { frameTiming: null, resamplerBatchTiming: snapshot(), latencyMetadata: {
        schemaVersion: 1, streamRunning: true, nominalSampleRateHz: 48000,
        fixedBufferRequestFrames: 512, nrConfiguredEnabled: false, nrProcessingRateHz: 48000,
        nrProcessingFrameSamples: 480, vstReportedLatencySamples: 0, signalCorrespondence: 'unmeasured',
    } } as EngineRuntimeStats;
    const view = render(<LatencyDetails stats={stats} />);
    expect(screen.getByText('5.30〜5.40 ms未満')).toBeInTheDocument();
    view.rerender(<LatencyDetails stats={stats} isRunning={false} />);
    expect(screen.queryByText('5.30〜5.40 ms未満')).not.toBeInTheDocument();
    view.rerender(<LatencyDetails stats={{ ...stats, resamplerBatchTiming: undefined }} />);
    expect(screen.getByText(/旧エンジンを含みます/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
});
