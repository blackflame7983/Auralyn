import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { liveModesApi } from '@/api/liveModes';
import { MonitorTrial, monitorAdvice } from '../MonitorTrial';
vi.mock('@/api/audio', () => ({ audioApi: { start: vi.fn(), getEngineRuntimeStats: vi.fn(), getAudioStreamState: vi.fn(), getAudioState: vi.fn(), getDevices: vi.fn(), setInputChannels: vi.fn() } }));
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
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({running: true, streamFailed: false});
    vi.mocked(audioApi.getAudioState).mockResolvedValue({is_running: true, config: {host:'WASAPI', input:'mic', output:'phones', input_id:'i', output_id:'o', sample_rate:48000, buffer_size:512}});
    vi.mocked(audioApi.getDevices).mockResolvedValue({inputs:[{name:'mic', host:'WASAPI',id:'i',is_input:true,is_default:false,index:0,channels:2}],outputs: devices});
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
    expect(JSON.parse(localStorage.getItem('auralyn_monitor_trial_original_v1')!)).toMatchObject({version: 1, original: {bufferSize: 512}});
});
it('復元失敗後も再表示した画面から明示的に原本を復元できる', async () => {
    sessionStorage.setItem('auralyn_monitor_trial_original', JSON.stringify(original));
    const onApplied = vi.fn().mockResolvedValue(undefined);
    render(<MonitorTrial devices={devices} onApplied={onApplied} />);
    const restore = screen.getByText('保存した元の設定へ戻す'); expect(restore).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /現在の入出力設定を/ }));
    await waitFor(() => expect(restore).toBeEnabled());
    vi.mocked(audioApi.start).mockRejectedValueOnce(new Error('missing')); fireEvent.click(restore);
    await screen.findByRole('alert'); expect(localStorage.getItem('auralyn_monitor_trial_original_v1')).not.toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /現在の入出力設定を/ }));
    await waitFor(() => expect(restore).toBeEnabled()); vi.mocked(audioApi.start).mockResolvedValueOnce({sample_rate: 48000, buffer_size: 512, channels: 2}); fireEvent.click(restore);
    await waitFor(() => expect(localStorage.getItem('auralyn_monitor_trial_original_v1')).toBeNull());
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

it('再起動後の原本は自動適用せず、機器消失時も保持して新しい試験を防ぐ', async () => {
    localStorage.setItem('auralyn_monitor_trial_original_v1', JSON.stringify({version:1, original}));
    vi.mocked(audioApi.getDevices).mockResolvedValue({inputs:[],outputs:devices});
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    expect(audioApi.start).not.toHaveBeenCalled();
    expect(screen.getByText('現在の実設定から候補を作る')).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', {name:/現在の入出力設定を/}));
    await waitFor(() => expect(screen.getByRole('button', {name:'保存した元の設定へ戻す'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'保存した元の設定へ戻す'}));
    await screen.findByRole('alert');
    expect(audioApi.start).not.toHaveBeenCalled();
    expect(localStorage.getItem('auralyn_monitor_trial_original_v1')).not.toBeNull();
});
it('壊れた原本は新試験を防ぎ、現在の状態の明示採用まで消さない', () => {
    localStorage.setItem('auralyn_monitor_trial_original_v1', '{broken');
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    expect(screen.getByText('現在の実設定から候補を作る')).toBeDisabled();
    const keep = screen.getByRole('button', {name:'現在の設定を使う'}); expect(keep).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', {name:/保存原本は復元せず/}));
    fireEvent.click(keep);
    expect(localStorage.getItem('auralyn_monitor_trial_original_v1')).toBeNull();
    expect(audioApi.start).not.toHaveBeenCalled();
});

it('再確認後に現在の入出力が変わった場合は復元せず、原本を保持する', async () => {
    localStorage.setItem('auralyn_monitor_trial_original_v1', JSON.stringify({version:1, original}));
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', {name:/現在の入出力設定を/}));
    const restore = screen.getByRole('button', {name:'保存した元の設定へ戻す'});
    await waitFor(() => expect(restore).toBeEnabled());
    vi.mocked(audioApi.getAudioState).mockResolvedValue({is_running:true,config:{host:'WASAPI',input:'other mic',output:'phones',sample_rate:48000,buffer_size:512}});
    fireEvent.click(restore); await screen.findByRole('alert');
    expect(audioApi.start).not.toHaveBeenCalled();
    expect(localStorage.getItem('auralyn_monitor_trial_original_v1')).not.toBeNull();
});

it('復元の受理値が原本と異なる場合は原本を保持し、期待した現在状態を渡す', async () => {
    localStorage.setItem('auralyn_monitor_trial_original_v1', JSON.stringify({version:1, original}));
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', {name:/現在の入出力設定を/}));
    const restore = screen.getByRole('button', {name:'保存した元の設定へ戻す'});
    await waitFor(() => expect(restore).toBeEnabled());
    fireEvent.click(restore);
    await screen.findByRole('alert');
    expect(audioApi.start).toHaveBeenCalledWith('WASAPI', 'mic', 'phones', 512, 48000, 'i', 'o', expect.objectContaining({is_running:true}));
    expect(localStorage.getItem('auralyn_monitor_trial_original_v1')).not.toBeNull();
});

it('原本を永続保存できない場合は試験を開始しない', async () => {
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
        if (key === 'auralyn_monitor_trial_original_v1') throw new Error('storage unavailable');
        return Reflect.apply(originalSetItem, localStorage, [key, value]);
    });
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByText('現在の実設定から候補を作る'));
    await screen.findByText(/buffer要求 512 → 128/);
    fireEvent.click(screen.getByText('この候補で試験を開始'));
    await screen.findByRole('alert');
    expect(audioApi.start).not.toHaveBeenCalled();
    setItem.mockRestore();
});

it('保存設定と現在の実機 ID が異なる場合、候補を作らず開始しない', async () => {
    vi.mocked(audioApi.getAudioState).mockResolvedValue({is_running:true, config:{host:'WASAPI', input:'mic', output:'phones', input_id:'other', output_id:'o', sample_rate:48000, buffer_size:512}});
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByText('現在の実設定から候補を作る'));
    await screen.findByRole('alert');
    expect(audioApi.start).not.toHaveBeenCalled();
    expect(localStorage.getItem('auralyn_monitor_trial_original_v1')).toBeNull();
});

it('復元後の実機 ID を確認できない場合は原本を保持する', async () => {
    localStorage.setItem('auralyn_monitor_trial_original_v1', JSON.stringify({version:1, original}));
    render(<MonitorTrial devices={devices} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', {name:/現在の入出力設定を/}));
    const restore = screen.getByRole('button', {name:'保存した元の設定へ戻す'});
    await waitFor(() => expect(restore).toBeEnabled());
    vi.mocked(audioApi.start).mockImplementationOnce(async () => {
        vi.mocked(audioApi.getAudioState).mockResolvedValue({is_running:true, config:{host:'WASAPI', input:'mic', output:'phones', sample_rate:48000, buffer_size:512}});
        return {sample_rate:48000, buffer_size:512, channels:2};
    });
    fireEvent.click(restore);
    await screen.findByRole('alert');
    expect(localStorage.getItem('auralyn_monitor_trial_original_v1')).not.toBeNull();
});
