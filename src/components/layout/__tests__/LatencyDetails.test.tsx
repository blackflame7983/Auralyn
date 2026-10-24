import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { EngineRuntimeStats, LatencyMetadata } from '@/api/audio';
import { LatencyDetails } from '../LatencyDetails';
import { DeviceStatus } from '@/components/features/DeviceStatus/DeviceStatus';
const metadata = (patch: Partial<LatencyMetadata> = {}): LatencyMetadata => ({ schemaVersion: 1, streamRunning: true, nominalSampleRateHz: 48000, fixedBufferRequestFrames: 256, nrConfiguredEnabled: true, nrProcessingRateHz: 48000, nrProcessingFrameSamples: 480, vstReportedLatencySamples: 0, signalCorrespondence: 'unmeasured', ...patch });
const stats = (patch: Partial<LatencyMetadata> = {}): EngineRuntimeStats => ({ globalBypass: true, latencyMetadata: metadata(patch), callbackDiagnostics: { count: 3, minFrames: 480, maxFrames: 960, totalProcessingUs: 1, maxProcessingUs: 1 } } as EngineRuntimeStats);
afterEach(() => { cleanup(); vi.mocked(invoke).mockClear(); });
it('固定要求を1回換算し、VST-only bypassでもNR設定とフレーム長・VST申告0を別表示する', () => {
    render(<LatencyDetails stats={stats()} />);
    expect(screen.getByText('256 sample / 5.33 ms')).toBeInTheDocument();
    expect(screen.getByText('480 sample / 10.00 ms')).toBeInTheDocument();
    expect(screen.getByText('0 sample / 0.00 ms')).toBeInTheDocument();
    expect(screen.getByText(/ON（RT反映の確認値ではありません）/)).toBeInTheDocument();
    expect(screen.getByText('480〜960 frame')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('全通過時間は未測定');
    expect(screen.queryByText(/合計の推定/)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
});
it('Fixed→Defaultで512仮値を表示せず、停止と遅い旧running応答でも現在値を出さない', () => {
    const view = render(<LatencyDetails stats={stats()} />);
    view.rerender(<LatencyDetails stats={stats({ fixedBufferRequestFrames: null })} />);
    expect(screen.getByText('デバイス既定（固定フレーム数は未指定）')).toBeInTheDocument();
    expect(screen.queryByText(/512 sample/)).not.toBeInTheDocument();
    view.rerender(<LatencyDetails stats={stats()} isRunning={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('停止中・未確認');
    expect(screen.queryByText('480 sample / 10.00 ms')).not.toBeInTheDocument();
    view.rerender(<LatencyDetails stats={stats({ streamRunning: false })} isRunning />);
    expect(screen.getByRole('status')).toHaveTextContent('停止中・未確認');
});
it('旧形式・未取得・rate不明・NaNを0msや既定48kへ置き換えない', () => {
    const view = render(<LatencyDetails stats={{ noiseReductionLatencyMs: 10, totalChainLatencyMs: 50 } as EngineRuntimeStats} />);
    expect(screen.getByRole('status')).toHaveTextContent('旧形式');
    expect(screen.queryByText(/10.00 ms/)).not.toBeInTheDocument();
    view.rerender(<LatencyDetails stats={stats({ nominalSampleRateHz: null, nrProcessingFrameSamples: NaN, vstReportedLatencySamples: NaN })} />);
    expect(screen.getAllByText('不明').length).toBeGreaterThan(1);
    expect(screen.queryByText(/NaN|0.00 ms/)).not.toBeInTheDocument();
    view.rerender(<LatencyDetails stats={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('未取得');
});
it('NR内部rateが異なる場合も時間換算は出力rateを使い、Headerで総遅延のgradingや新IPCを足さない', () => {
    render(<><LatencyDetails stats={stats({ nominalSampleRateHz: 384000, nrProcessingRateHz: 192000, nrProcessingFrameSamples: 1920 })} /><DeviceStatus host="WASAPI" sampleRate={48000} bufferSize={512} isRunning onClick={vi.fn()} /></>);
    expect(screen.getByText('1920 sample / 5.00 ms')).toBeInTheDocument();
    expect(screen.getByText('192,000 Hz')).toBeInTheDocument();
    expect(screen.getByText('通過時間は未測定・詳細は設定へ')).toBeInTheDocument();
    expect(screen.queryByText(/低遅延|推定 /)).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
});

it('英語でも未測定・停止・不明・NR計算とVST申告の区別を保持しIPCを増やさない', () => {
    const store = createLocaleStore(() => 'en', () => true);
    const view = render(<LocaleProvider store={store}><LatencyDetails stats={stats({ fixedBufferRequestFrames: null })} /></LocaleProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('has not been measured');
    expect(screen.getByText(/Device default/)).toBeInTheDocument();
    expect(screen.getByText(/ON.*realtime application unconfirmed/)).toBeInTheDocument();
    expect(screen.getByText('480 sample / 10.00 ms')).toBeInTheDocument();
    expect(screen.getByText('0 sample / 0.00 ms')).toBeInTheDocument();
    view.rerender(<LocaleProvider store={store}><LatencyDetails stats={stats()} isRunning={false} /></LocaleProvider>);
    expect(screen.getByRole('status')).toHaveTextContent(/stopped.*unconfirmed/i);
    expect(screen.queryByText('480 sample / 10.00 ms')).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
});
