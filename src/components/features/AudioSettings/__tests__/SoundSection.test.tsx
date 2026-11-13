import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { builtinApi, type BuiltinSnapshot } from '@/api/builtinEffects';
import { broadcastTruePeakApi } from '@/api/broadcastTruePeak';
import { peakProtectionApi, type PeakStatus } from '@/api/peakProtection';
import { UnsavedLeaveDialog } from '@/components/layout/UnsavedLeaveDialog';
import { registerRackOpener } from '@/components/layout/openRackBridge';
import { invalidateRuntimeStats } from '@/hooks/useRuntimeStats';
import { message } from '@/i18n/messages';
import { BuiltinAmount, BuiltinSwitch, NoiseQuick, NoiseSwitch, useVoiceQuick } from '../../Home/VoiceQuickControls';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

const stats = (patch: Partial<EngineRuntimeStats> = {}) => ({
    noiseReductionEnabled: true, noiseReductionMode: 'low', noiseControlStrength: 0.8, noiseVoiceGuard: true,
    builtInEffectsEnabled: true, builtInEffectsPreset: 'broadcast', builtInEffectsAmount: 0.5, ...patch,
} as EngineRuntimeStats);
const peak = (ceilingDb = -3): PeakStatus => ({ config: { enabled: false, ceilingDb, releaseMs: 150 }, running: true, pending: false, revision: '2', reductionDb: 0, addedLatencySamples: 0 });
const broadcast = { config: { enabled: false, ceilingDb: -1, releaseMs: 100 }, running: true, pending: false, revision: '2', reductionDb: 0, addedLatencySamples: 0 };

function HomeQuick() {
    const q = useVoiceQuick(true);
    return <div data-testid="home-quick"><NoiseSwitch q={q} /><NoiseQuick q={q} /><BuiltinSwitch q={q} /><BuiltinAmount q={q} /></div>;
}

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi', input: '', output: '', sampleRate: 48000, bufferSize: 512 }));
    invalidateRuntimeStats();
    const snapshot: BuiltinSnapshot = { epoch: 'engine', revision: '2', appliedRevision: '2', pending: false, undoToken: null, error: null,
        config: { active: true, preset: 'broadcast', amount: 0.5, singing: null } };
    vi.spyOn(builtinApi, 'request').mockImplementation(async request => request.action === 'apply' ? { ...snapshot, config: request.config } : snapshot);
    vi.spyOn(audioApi, 'getEngineTuningConfig').mockResolvedValue({ enableAffinityPinning: false, affinityMask: null, enableRealtimePriority: false, enableTimeCriticalAudioThreads: false });
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [], outputs: [] });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    vi.spyOn(peakProtectionApi, 'request').mockImplementation(async config => config ? { ...peak(), config: { ...peak().config, ...config } } : peak());
    vi.spyOn(broadcastTruePeakApi, 'request').mockResolvedValue({ ...broadcast, applied: false });
});
afterEach(() => { cleanup(); invalidateRuntimeStats(); vi.restoreAllMocks(); });

it('ホームと音づくりの基本は同じ値を読み、どちらで変えてももう一方へ出る', async () => {
    let current = stats();
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockImplementation(async () => current);
    vi.spyOn(audioApi, 'setNoiseControlConfig').mockImplementation(async config => { current = { ...current, noiseReductionEnabled: config.active, noiseReductionMode: config.mode, noiseControlStrength: config.strength, noiseVoiceGuard: config.voiceGuard }; });
    vi.spyOn(audioApi, 'setBuiltInEffects').mockImplementation(async config => { current = { ...current, builtInEffectsEnabled: config.active, builtInEffectsPreset: config.preset ?? current.builtInEffectsPreset, builtInEffectsAmount: config.amount ?? current.builtInEffectsAmount }; });
    render(<><HomeQuick /><AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} /></>);
    const homeRoot = await screen.findByTestId('home-quick');
    const home = within(homeRoot);
    const high = await home.findByRole('radio', { name: '強' });
    await waitFor(() => expect(high).toBeEnabled());
    const soundHigh = screen.getAllByRole('radio', { name: '強' }).find(radio => !homeRoot.contains(radio))!;
    expect(home.getByRole('radio', { name: '弱' })).toHaveAttribute('aria-checked', 'true');
    expect(soundHigh).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(high);
    await waitFor(() => expect(soundHigh).toHaveAttribute('aria-checked', 'true'));
    const soundAmount = screen.getAllByRole('slider', { name: '声の整え具合' }).find(slider => !homeRoot.contains(slider))!;
    await waitFor(() => expect(soundAmount).toBeEnabled());
    fireEvent.keyDown(soundAmount, { key: 'End' });
    fireEvent.keyUp(soundAmount, { key: 'End' });
    await waitFor(() => expect(home.getByRole('slider', { name: '声の整え具合' })).toHaveAttribute('aria-valuenow', '100'));
});

it('音量の保護に未適用の数値があるまま小区分を移ると確認し、残ると値を保ち、捨てると基本へ移る', async () => {
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue(stats());
    render(<><UnsavedLeaveDialog /><AudioSettingsModal isOpen initialTab="sound" onClose={vi.fn()} onConfigChange={vi.fn()} /></>);
    fireEvent.keyDown(await screen.findByRole('tab', { name: '音量の保護' }), { key: 'Enter' });
    const panel = await screen.findByRole('region', { name: '大きな音を抑える' });
    const ceiling = within(panel).getByRole('spinbutton', { name: '天井（dBFS）' });
    await waitFor(() => expect(ceiling).toHaveValue(-3));
    fireEvent.change(ceiling, { target: { value: '-6' } });
    fireEvent.keyDown(screen.getByRole('tab', { name: '基本' }), { key: 'Enter' });
    const dialog = await screen.findByRole('alertdialog', { name: '保存していない変更があります' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'このページに戻る' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(ceiling).toHaveValue(-6);
    fireEvent.keyDown(screen.getByRole('tab', { name: '基本' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: '保存していない変更があります' })).getByRole('button', { name: '変更を捨てて移動' }));
    expect(await screen.findByRole('heading', { name: 'ノイズ低減' })).toBeVisible();
    expect(screen.queryByRole('spinbutton', { name: '天井（dBFS）' })).not.toBeInTheDocument();
});

it('音楽鑑賞では指定した小区分でも音量の保護だけを出し、VSTを開く', async () => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue(stats());
    const open = vi.fn();
    const unregister = registerRackOpener(open);
    render(<AudioSettingsModal isOpen initialTab="sound" initialSection="singing" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 2, name: '音量の保護' })).toBeVisible();
    expect(screen.getByText(message('ja', 'sound.musicLead'))).toBeVisible();
    expect(screen.queryByRole('tab', { name: '基本' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'ノイズ低減' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'VSTを開く' }));
    expect(open).toHaveBeenCalledTimes(1);
    unregister();
});
