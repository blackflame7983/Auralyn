import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { liveModesApi } from '@/api/liveModes';
import { MonitorTrial, monitorAdvice } from '../MonitorTrial';
vi.mock('@/api/audio', () => ({ audioApi: { start: vi.fn(), getEngineRuntimeStats: vi.fn(), setInputChannels: vi.fn() } }));
vi.mock('@/api/liveModes', () => ({ liveModesApi: { preflight: vi.fn() } }));
vi.mock('@/components/layout/LatencyDetails', () => ({ LatencyDetails: () => <p>details</p> }));
const stats = (epoch = 'before', fixed: number | null = 512) => ({ latencyMetadata: { schemaVersion: 1, streamRunning: true, nominalSampleRateHz: 48000, fixedBufferRequestFrames: fixed, streamEpoch: epoch, comparisonRevision: '1:1' }, queueDiagnostics: { epoch } } as EngineRuntimeStats);
const original = { host: 'WASAPI', input: 'mic', output: 'phones', inputId: 'i', outputId: 'o', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] };
const devices = [{ name: 'phones', host: 'WASAPI', id: 'o', channels: 2, is_input: false, is_default: false, index: 0, buffer_size_range: [128, 1024] as [number, number] }];
afterEach(cleanup);
beforeEach(() => {
    vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify(original));
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats());
    vi.mocked(audioApi.start).mockResolvedValue({ sample_rate: 48000, buffer_size: 128, channels: 2 });
});
it('申告0と不明・無効段を区別して比較案を作り、停止中の旧内訳は使わない', () => {
    const data = stats();
    data.latencyMetadata!.nrConfiguredEnabled = true;
    data.latencyMetadata!.stageBreakdown = { current: true, vst: [
        { id: 'zero', name: 'zero', state: 'active', declaredSamples: 0 },
        { id: 'unknown', name: 'unknown', state: 'active', declaredSamples: null },
        { id: 'delay', name: 'delay', state: 'active', declaredSamples: 256 },
        { id: 'off', name: 'off', state: 'bypassed', declaredSamples: 1024 },
    ] } as never;
    expect(monitorAdvice(data)).toEqual([{ kind: 'nr' }, { kind: 'vstUnknown', name: 'unknown' }, { kind: 'vstDelay', name: 'delay', samples: 256 }]);
    data.latencyMetadata!.streamRunning = false; expect(monitorAdvice(data)).toEqual([]);
});
it('候補確認まで音声を変更せず、保護拒否後は開始しない', async () => {
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByText('現在の実設定から候補を作る'));
    await screen.findByText(/buffer要求 512 → 128/);
    expect(audioApi.start).not.toHaveBeenCalled();
    vi.mocked(liveModesApi.preflight).mockRejectedValueOnce(new Error('protected'));
    fireEvent.click(screen.getByText('この候補で試験を開始'));
    await screen.findByRole('alert'); expect(audioApi.start).not.toHaveBeenCalled();
});
it('Defaultや能力不明を512固定へ読み替えず候補を拒否する', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats('before', null));
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByText('現在の実設定から候補を作る'));
    await screen.findByRole('alert'); expect(audioApi.start).not.toHaveBeenCalled();
});
it('試験中の条件変更後は採用・自動復元せず原本を残す', async () => {
    const onApplied = vi.fn().mockResolvedValue(undefined);
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValueOnce(stats()).mockResolvedValueOnce(stats()).mockResolvedValueOnce(stats('trial')).mockResolvedValue(stats('external'));
    render(<MonitorTrial devices={devices} onApplied={onApplied} />);
    fireEvent.click(screen.getByText('現在の実設定から候補を作る')); await screen.findByText(/buffer要求 512 → 128/);
    fireEvent.click(screen.getByText('この候補で試験を開始')); await screen.findByText('この構成を採用');
    fireEvent.click(screen.getByRole('checkbox', { name: /同じ声・伴奏で/ })); fireEvent.click(screen.getByText('この構成を採用'));
    await screen.findByRole('alert'); expect(audioApi.start).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('auralyn_monitor_trial_result')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('auralyn_monitor_trial_original')!)).toMatchObject({ bufferSize: 512 });
});
it('復元失敗後も再表示した画面から明示的に原本を復元できる', async () => {
    sessionStorage.setItem('auralyn_monitor_trial_original', JSON.stringify(original));
    const onApplied = vi.fn().mockResolvedValue(undefined);
    render(<MonitorTrial devices={devices} onApplied={onApplied} />);
    const restore = screen.getByText('保存した元の設定へ戻す'); expect(restore).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /現在の入出力設定を/ }));
    vi.mocked(audioApi.start).mockRejectedValueOnce(new Error('missing')); fireEvent.click(restore);
    await screen.findByRole('alert'); expect(sessionStorage.getItem('auralyn_monitor_trial_original')).not.toBeNull();
    await waitFor(() => expect(restore).toBeEnabled()); fireEvent.click(restore);
    await waitFor(() => expect(sessionStorage.getItem('auralyn_monitor_trial_original')).toBeNull());
    expect(onApplied).toHaveBeenCalledTimes(1);
});
it('要求が128でもdriverが512を受理した場合は実際のrateとbufferを表示する', async () => {
    const onApplied = vi.fn().mockResolvedValue(undefined);
    vi.mocked(audioApi.start).mockResolvedValue({ sample_rate: 44100, buffer_size: 512, channels: 2 });
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValueOnce(stats()).mockResolvedValueOnce(stats()).mockResolvedValue(stats('trial', 512));
    render(<MonitorTrial devices={devices} onApplied={onApplied} />);
    fireEvent.click(screen.getByText('現在の実設定から候補を作る')); await screen.findByText(/buffer要求 512 → 128/);
    fireEvent.click(screen.getByText('この候補で試験を開始'));
    await screen.findByText('受理された設定：44100 Hz ／ 512 frame。要求値と異なる場合があります。');
    expect(screen.getByText(/試験buffer要求：128 frame/)).toBeInTheDocument();
    expect(onApplied).toHaveBeenLastCalledWith(expect.objectContaining({ sampleRate: 44100, bufferSize: 512 }));
});
