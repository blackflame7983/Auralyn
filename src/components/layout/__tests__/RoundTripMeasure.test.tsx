import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { AudioStateInfo, EngineRuntimeStats, RoundTripConditions, RoundTripMeasurement } from '@/api/audio';
import { RoundTripMeasure, RoundTripMeasureView, conditionsMatch, currentRoundTripConditions } from '../RoundTripMeasure';

const conditions = (patch: Partial<RoundTripConditions> = {}): RoundTripConditions => ({
    outputDeviceId: 'out',
    inputDeviceId: 'in',
    inputChannel: 0,
    inputChannelRight: 0,
    inputMixed: false,
    sampleRate: 48000,
    bufferSize: 128,
    engineEpoch: 'epoch-1',
    ...patch,
});

const success = (patch: Partial<RoundTripMeasurement> = {}): RoundTripMeasurement => ({
    kind: 'success',
    reason: null,
    delayFrames: 1800,
    delayMs: 37.5,
    resolutionMs: 1.3,
    inverted: false,
    confidence: 0.82,
    conditions: conditions(),
    measuredAtMs: 1,
    levelDb: -20,
    ...patch,
});

afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); });

it('開始を押すまで往復測定のコマンドを送らない', async () => {
    vi.mocked(invoke).mockResolvedValue({ phase: 'running', progress: 0, result: null });
    render(<RoundTripMeasure isRunning declaredMs={null} />);
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '測定を開始' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('measure_round_trip', { levelDb: null }));
});

it('取消は取消コマンドを送り、結果と古い結果を数値の現在値と分けて示す', async () => {
    const onCancel = vi.fn();
    const view = render(<RoundTripMeasureView
        snapshot={{ phase: 'running', progress: 0.4, result: null }}
        error={null}
        busy={false}
        current={conditions()}
        declaredMs={null}
        onStart={() => undefined}
        onCancel={onCancel}
    />);
    expect(screen.getByText('測定しています：40 %')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '測定を取り消す' }));
    expect(onCancel).toHaveBeenCalledOnce();

    view.rerender(<RoundTripMeasureView
        snapshot={{ phase: 'done', progress: 1, result: success() }}
        error={null}
        busy={false}
        current={conditions()}
        declaredMs={12.5}
        onStart={() => undefined}
        onCancel={onCancel}
    />);
    const current = screen.getByText('実測（往復）：37.5 ms（± 1.3 ms）');
    expect(current.parentElement).toHaveAttribute('data-current', 'true');
    expect(screen.getByText('極性：正相')).toBeInTheDocument();
    expect(screen.getByText('信頼度：0.82')).toBeInTheDocument();
    expect(screen.getByText('申告値の合計：12.5 ms（測定値ではありません）')).toBeInTheDocument();
    expect(screen.queryByText('条件が変わったため、この数値はいまの遅延ではありません。')).not.toBeInTheDocument();

    view.rerender(<RoundTripMeasureView
        snapshot={{ phase: 'done', progress: 1, result: success({ inverted: true }) }}
        error={null}
        busy={false}
        current={conditions({ engineEpoch: 'epoch-2' })}
        declaredMs={null}
        onStart={() => undefined}
        onCancel={onCancel}
    />);
    expect(screen.getByText('実測（往復）：37.5 ms（± 1.3 ms）').parentElement).toHaveAttribute('data-current', 'false');
    expect(screen.getByText('条件が変わったため、この数値はいまの遅延ではありません。')).toBeInTheDocument();
    expect(screen.getByText('極性：逆相')).toBeInTheDocument();
});

it('失敗の理由と対処を色だけに頼らず示し、条件が確認できない数値は現在値にしない', () => {
    render(<RoundTripMeasureView
        snapshot={{ phase: 'done', progress: 1, result: success({ kind: 'failure', reason: 'no_signal', delayMs: null, delayFrames: null, resolutionMs: null, confidence: null }) }}
        error={null}
        busy={false}
        current={null}
        declaredMs={null}
        onStart={() => undefined}
        onCancel={() => undefined}
    />);
    expect(screen.getByText(/入力からスイープが戻ってきていません/)).toBeInTheDocument();
    expect(screen.getByText(/出力と入力の接続/)).toBeInTheDocument();
    expect(screen.queryByText(/実測（往復）/)).not.toBeInTheDocument();
});

it('英語でも開始・取消・結果・古い結果を区別する', () => {
    const store = createLocaleStore(() => 'en', () => true);
    const view = render(<LocaleProvider store={store}><RoundTripMeasureView
        snapshot={{ phase: 'running', progress: 0.2, result: null }}
        error={null}
        busy={false}
        current={null}
        declaredMs={null}
        onStart={() => undefined}
        onCancel={() => undefined}
    /></LocaleProvider>);
    expect(screen.getByRole('button', { name: 'Cancel measurement' })).toBeEnabled();
    expect(screen.getByText('Measuring: 20%')).toBeInTheDocument();
    view.rerender(<LocaleProvider store={store}><RoundTripMeasureView
        snapshot={{ phase: 'done', progress: 1, result: success() }}
        error={null}
        busy={false}
        current={null}
        declaredMs={null}
        onStart={() => undefined}
        onCancel={() => undefined}
    /></LocaleProvider>);
    expect(screen.getByText('Measured round trip: 37.5 ms (± 1.3 ms)').parentElement).toHaveAttribute('data-current', 'false');
    expect(screen.getByText('The current conditions could not be confirmed, so this number is not treated as the current latency.')).toBeInTheDocument();
    expect(screen.getByText('Polarity: normal')).toBeInTheDocument();
});

it('機器・レート・バッファ・世代が変わると条件不一致になる', () => {
    const saved = conditions();
    expect(conditionsMatch(saved, conditions())).toBe(true);
    expect(conditionsMatch(saved, conditions({ bufferSize: 0 }))).toBe(false);
    expect(conditionsMatch(saved, conditions({ sampleRate: 96000 }))).toBe(false);
    expect(conditionsMatch(saved, conditions({ outputDeviceId: 'other' }))).toBe(false);
    expect(conditionsMatch(saved, conditions({ inputDeviceId: 'other' }))).toBe(false);
    expect(conditionsMatch(saved, conditions({ inputChannel: 1 }))).toBe(false);
    expect(conditionsMatch(saved, conditions({ inputChannelRight: 1 }))).toBe(false);
    const stats = {
        latencyMetadata: { schemaVersion: 1, streamRunning: true, nominalSampleRateHz: 48000, fixedBufferRequestFrames: null, nrConfiguredEnabled: false, nrProcessingRateHz: null, nrProcessingFrameSamples: null, vstReportedLatencySamples: 0, signalCorrespondence: 'unmeasured' },
        preparation: { inputChannels: [0, 1] },
        queueDiagnostics: { epoch: 'epoch-1' },
    } as EngineRuntimeStats;
    const audio = { is_running: true, config: { host: 'WASAPI', input: 'Mic', output: 'Speakers', input_id: 'in', output_id: 'out', sample_rate: 48000, buffer_size: null } } as AudioStateInfo;
    expect(currentRoundTripConditions(stats, audio, true)).toMatchObject({ bufferSize: 0, inputMixed: true, engineEpoch: 'epoch-1' });
    expect(currentRoundTripConditions(stats, audio, false)).toBeNull();
});
