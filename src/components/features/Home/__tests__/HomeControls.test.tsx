import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { builtinApi, type BuiltinConfig } from '@/api/builtinEffects';
import { liveModesApi } from '@/api/liveModes';
import { useLiveModes } from '@/hooks/useLiveModes';
import { liveSnapshot } from '@/hooks/__tests__/liveModesFixture';
import { LiveModeBar } from '../../AudioSettings/LiveModeBar';
import { BuiltinQuick, BuiltinSwitch, NoiseQuick, NoiseSwitch, useVoiceQuick } from '../VoiceQuickControls';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const stats = (patch: Partial<EngineRuntimeStats> = {}) => ({
    noiseReductionEnabled: true, noiseReductionMode: 'low', noiseControlStrength: 0.6, noiseVoiceGuard: false,
    builtInEffectsEnabled: true, builtInEffectsPreset: 'broadcast', builtInEffectsAmount: 0.5, ...patch,
} as EngineRuntimeStats);
// チェーン列のノイズ低減・内蔵ボイスチェーンの段と同じ組み合わせで操作する。
function VoiceQuickControls({ running }: { running: boolean }) {
    const q = useVoiceQuick(running);
    return <><NoiseSwitch q={q} /><NoiseQuick q={q} /><BuiltinSwitch q={q} /><BuiltinQuick q={q} /></>;
}
const singing: BuiltinConfig = { active: true, preset: 'singing', amount: 0.5, singing: { lowCutHz: 100, dynamics: 0.4, brightnessDb: 1 }, reverb: { enabled: true, mix: 0.1, decaySeconds: 1, damping: 0.5 } };

beforeEach(() => {
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue(stats());
    vi.spyOn(audioApi, 'setNoiseControlConfig').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'setBuiltInEffects').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('ノイズ低減の強さは現在の抑制強度と声を守る設定を保ったまま切り替える', async () => {
    render(<VoiceQuickControls running />);
    const high = await screen.findByRole('button', { name: '強' });
    await waitFor(() => expect(high).toBeEnabled());
    await act(async () => fireEvent.click(high));
    expect(audioApi.setNoiseControlConfig).toHaveBeenCalledWith({ active: true, mode: 'high', strength: 0.6, voiceGuard: false });
});

it('学習・会場モード中は強さを上書きせず、詳しい調整へ案内する', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats({ noiseReductionMode: 'smart' }));
    render(<VoiceQuickControls running />);
    expect(await screen.findByText(/現在は「測定値で調整」で低減しています/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '強' })).not.toBeInTheDocument();
});

it('使わない間（enabled=false）は状態を取りに行かない', async () => {
    renderHook(() => useVoiceQuick(true, false));
    await act(async () => {});
    expect(audioApi.getEngineRuntimeStats).not.toHaveBeenCalled();
});

it('内蔵ボイスチェーンのON/OFFは適用済みの歌向け設定と残響を保持する', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats({ builtInEffectsPreset: 'singing' }));
    const request = vi.spyOn(builtinApi, 'request').mockImplementation(async req => ({
        epoch: 'e1', revision: '3', appliedRevision: '3', config: req.action === 'apply' ? req.config : singing, pending: false, undoToken: null, error: null,
    }));
    render(<VoiceQuickControls running />);
    expect(await screen.findByText(/歌向けの設定を使っています/)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '内蔵ボイスチェーン' })));
    expect(request).toHaveBeenCalledWith({ action: 'apply', epoch: 'e1', expectedRevision: '3', config: { ...singing, active: false } });
    expect(audioApi.setBuiltInEffects).not.toHaveBeenCalled();
});

it('プリセットはかかり具合を保って反映する', async () => {
    render(<VoiceQuickControls running />);
    const bright = await screen.findByRole('button', { name: '明瞭' });
    await waitFor(() => expect(bright).toBeEnabled());
    await act(async () => fireEvent.click(bright));
    expect(audioApi.setBuiltInEffects).toHaveBeenCalledWith({ active: true, preset: 'bright', amount: 0.5 });
});

it('本番モードは未登録ならメインに出さず、定期確認もしない', async () => {
    vi.useFakeTimers();
    const request = vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot());
    const { result } = renderHook(() => useLiveModes());
    render(<LiveModeBar model={result.current} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByRole('region', { name: '本番モード' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
    vi.useRealTimers();
});

it('登録済みなら歌・雑談の切替と本番保護をメインに出し、保護の名前は固定する', async () => {
    const config: BuiltinConfig = { ...singing, active: true };
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot({ running: true, definitions: { schemaVersion: 1, version: '1', singing: config, talk: null } }));
    const protect = vi.spyOn(liveModesApi, 'protect').mockResolvedValue(liveSnapshot({ running: true, armed: true, definitions: { schemaVersion: 1, version: '1', singing: config, talk: null } }));
    function Bar() { return <LiveModeBar model={useLiveModes()} />; }
    render(<Bar />);
    await screen.findByRole('region', { name: '本番モード' });
    expect(screen.getByRole('button', { name: '歌' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '雑談' })).toBeDisabled();
    const guard = screen.getByRole('button', { name: '本番保護' });
    expect(guard).toHaveAttribute('aria-pressed', 'false');
    await act(async () => fireEvent.click(guard));
    expect(protect).toHaveBeenCalledWith(true, 'host1');
    await waitFor(() => expect(screen.getByRole('button', { name: '本番保護' })).toHaveAttribute('aria-pressed', 'true'));
});
