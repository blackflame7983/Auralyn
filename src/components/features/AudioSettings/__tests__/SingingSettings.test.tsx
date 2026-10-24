import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { builtinApi, defaultReverb, type BuiltinSnapshot } from '@/api/builtinEffects';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
let current: BuiltinSnapshot;
beforeEach(() => {
    localStorage.clear();
    current = { epoch: 'engine', revision: '2', appliedRevision: '2', pending: false, undoToken: null, error: null,
        config: { active: true, preset: 'singing', amount: 0.6, singing: { lowCutHz: 110, dynamics: 0.65, brightnessDb: -1 } } };
    vi.spyOn(builtinApi, 'request').mockImplementation(async request => {
        if (request.action === 'apply') current = { ...current, revision: '3', config: request.config, undoToken: 'undo' };
        return structuredClone(current);
    });
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [], outputs: [] });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({ builtInEffectsEnabled: true, builtInEffectsPreset: 'singing', builtInEffectsAmount: 0.6 } as EngineRuntimeStats);
    vi.spyOn(audioApi, 'setBuiltInEffects').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });
it('設定画面の遅延根拠は手動停止で失効し、遅い旧stats応答を受理しない', async () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    vi.mocked(invoke).mockResolvedValue(undefined);
    vi.mocked(listen).mockClear();
    vi.spyOn(audioApi, 'getEngineTuningConfig').mockResolvedValue({ enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false });
    const stats = { builtInEffectsEnabled: false, noiseReductionEnabled: true, latencyMetadata: { schemaVersion: 1 as const, streamRunning: true, nominalSampleRateHz: 48000, fixedBufferRequestFrames: 256, nrConfiguredEnabled: true, nrProcessingRateHz: 48000, nrProcessingFrameSamples: 480, vstReportedLatencySamples: 0, signalCorrespondence: 'unmeasured' as const } } as EngineRuntimeStats;
    let old!: (value: EngineRuntimeStats) => void;
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValueOnce(stats).mockReturnValueOnce(new Promise(resolve => { old = resolve; }));
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const system = await screen.findByRole('tab', { name: 'システム' });
    fireEvent.keyDown(system, { key: 'Enter' });
    await screen.findByText('256 sample / 5.33 ms');
    fireEvent.click(screen.getByRole('button', { name: '統計を更新' }));
    act(() => { for (const [name, callback] of vi.mocked(listen).mock.calls) if (name === 'audio-stopped') callback({ event: name, id: 1, payload: null }); });
    await act(async () => old(stats));
    expect(screen.queryByText('256 sample / 5.33 ms')).not.toBeInTheDocument();
    expect(screen.getByText(/音声は停止中・未確認です/)).toBeInTheDocument();
});
it('通常設定を開くだけでbuiltin snapshotを取得せず、音作りを開いて初めて取得する', async () => {
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    await screen.findByRole('tab', { name: '音づくり' });
    expect(builtinApi.request).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('tab', { name: '音づくり' }), { key: 'Enter' });
    await waitFor(() => expect(builtinApi.request).toHaveBeenCalledWith({ action: 'snapshot' }));
});
it('歌向けON/OFFは残響を含む全値を保持し、旧preset即時APIには残響の上書きを送らない', async () => {
    current.config.reverb = { ...defaultReverb, enabled: true };
    render(<AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const toggle = await screen.findByRole('switch', { name: '内蔵ボイスチェーン' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(screen.getByRole('slider', { name: '内蔵ボイスチェーンのかかり具合' })).toBeDisabled();
    expect(screen.getByText(/歌向けでは従来の/)).toBeInTheDocument();
    fireEvent.click(toggle);
    await waitFor(() => expect(builtinApi.request).toHaveBeenCalledWith({ action: 'apply', epoch: 'engine', expectedRevision: '2', config: {
        active: false, preset: 'singing', amount: 0.6, singing: { lowCutHz: 110, dynamics: 0.65, brightnessDb: -1 },
        reverb: { ...defaultReverb, enabled: true },
    } }));
    expect(audioApi.setBuiltInEffects).not.toHaveBeenCalled();
    const legacy = screen.getByRole('button', { name: '配信（即時切替）' });
    await waitFor(() => expect(legacy).toBeEnabled());
    fireEvent.click(legacy);
    await waitFor(() => expect(audioApi.setBuiltInEffects).toHaveBeenCalledWith({ active: true, preset: 'broadcast', amount: 0.6 }));
});
