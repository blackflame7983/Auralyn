import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { builtinApi, type BuiltinConfig } from '@/api/builtinEffects';
import { liveModesApi } from '@/api/liveModes';
import { LocaleContext } from '@/i18n/LocaleProvider';
import { useLiveModes } from '@/hooks/useLiveModes';
import { liveSnapshot } from '@/hooks/__tests__/liveModesFixture';
import { LiveModeBar } from '../../AudioSettings/LiveModeBar';
import { LiveProtectButton } from '../../AudioSettings/LiveProtectButton';
import { BuiltinQuick, BuiltinSwitch, NoiseQuick, NoiseSwitch, useVoiceQuick } from '../VoiceQuickControls';
import { SoundChain } from '../SoundChain';
import type { PreparationModel } from '@/hooks/usePreparation';
import { emptyObservation } from '@/lib/preparation';

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

it('閉じたモジュールのヘッダーで直接ON/OFFでき、詳細の開閉や歌向け設定に干渉しない', async () => {
    const expanded = vi.fn();
    const request = vi.spyOn(builtinApi, 'request').mockImplementation(async req => ({
        epoch: 'e1', revision: '3', appliedRevision: '3', config: req.action === 'apply' ? req.config : singing, pending: false, undoToken: null, error: null,
    }));
    const model: PreparationModel = {
        context: { location: 'home', usage: 'obs', signal: 'separate', receiver: '' }, observation: emptyObservation('ready'), records: {}, checking: false, confirming: false,
        confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn(),
    };
    const view = render(<SoundChain model={model} audioReady isEngineRunning listenOpen={false} onListen={vi.fn()} onListenClose={vi.fn()}
        onOpenSettings={vi.fn()} onOpenOBSSettings={vi.fn()} onExpandedChange={expanded} />);
    const noise = await screen.findByRole('switch', { name: 'ノイズ低減' });
    const builtin = screen.getByRole('switch', { name: '声を整える' });
    await waitFor(() => expect(noise).toBeEnabled());
    for (const control of [noise, builtin]) {
        expect(control.closest('.sound-module-item')).not.toBeNull();
        expect(control.closest('[inert]')).toBeNull();
        expect(control.parentElement!.closest('button')).toBeNull();
    }
    await act(async () => fireEvent.click(noise));
    expect(audioApi.setNoiseControlConfig).toHaveBeenCalledExactlyOnceWith({ active: false, mode: 'low', strength: 0.6, voiceGuard: false });
    await waitFor(() => expect(builtin).toBeEnabled());
    await act(async () => fireEvent.click(builtin));
    expect(request.mock.calls.filter(([req]) => req.action === 'apply')).toEqual([[{ action: 'apply', epoch: 'e1', expectedRevision: '3', config: { ...singing, active: false } }]]);
    expect(expanded.mock.calls.every(([open]) => open === false)).toBe(true);
    expect(view.container.querySelectorAll('.disclosure-panel[data-open="true"]')).toHaveLength(0);
});

it.each(['normal', 'protected', 'recovery', 'snapshotError'] as const)('音楽鑑賞の初期取得で安全状態を読み、必要な操作だけ残す (%s)', async kind => {
    const snapshot = liveSnapshot({ armed: kind === 'protected', error: kind === 'snapshotError' ? 'fixture error' : null,
        transaction: kind === 'recovery' ? { id: 'tx', phase: 'recovery_required', target: null, error: null, recoveryAvailable: true } : null });
    const request = vi.spyOn(liveModesApi, 'request').mockResolvedValue(snapshot);
    function MusicSafety() { const model = useLiveModes(); return <><LiveModeBar model={model} safetyOnly /><LiveProtectButton model={model} safetyOnly /></>; }
    render(<MusicSafety />);
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'snapshot' }));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: '歌' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '雑談' })).not.toBeInTheDocument();
    if (kind === 'normal') expect(screen.queryByRole('region')).not.toBeInTheDocument();
    if (kind === 'protected') expect(screen.getByRole('button', { name: '操作をロック' })).toHaveAttribute('aria-pressed', 'true');
    if (kind === 'recovery') expect(screen.getByRole('button', { name: '以前の状態を復旧する' })).toBeInTheDocument();
    if (kind === 'snapshotError') expect(screen.getByRole('alert')).toBeVisible();
});

it('ノイズ低減の強さは現在の抑制強度と声を守る設定を保ったまま切り替える', async () => {
    render(<VoiceQuickControls running />);
    const high = await screen.findByRole('radio', { name: '強' });
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
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '声を整える' })));
    expect(request).toHaveBeenCalledWith({ action: 'apply', epoch: 'e1', expectedRevision: '3', config: { ...singing, active: false } });
    expect(audioApi.setBuiltInEffects).not.toHaveBeenCalled();
});

it('操作中に無効になったら、終わった操作の再取得で古い状態を戻さない', async () => {
    let finish!: () => void;
    vi.mocked(audioApi.setNoiseControlConfig).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const view = renderHook(({ enabled }) => useVoiceQuick(true, enabled), { initialProps: { enabled: true } });
    await waitFor(() => expect(view.result.current.stats).not.toBeNull());
    act(() => { void view.result.current.applyNoise({ mode: 'high' }); });
    view.rerender({ enabled: false });
    expect(view.result.current.stats).toBeNull();
    const calls = vi.mocked(audioApi.getEngineRuntimeStats).mock.calls.length;
    await act(async () => { finish(); });
    expect(audioApi.getEngineRuntimeStats).toHaveBeenCalledTimes(calls);
    expect(view.result.current.stats).toBeNull();
});
it('プリセットはかかり具合を保って反映する', async () => {
    render(<VoiceQuickControls running />);
    const bright = await screen.findByRole('radio', { name: '明瞭' });
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
    expect(screen.queryByRole('region', { name: 'モード切替' })).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
    vi.useRealTimers();
});

it.each([
    { locale: 'ja' as const, region: 'モード切替', sing: '歌', talk: '雑談', lock: '操作をロック', unlockHint: 'もう一度押すと操作ロックを解除します。', locked: 'ロック中', unlocked: '解除中' },
    { locale: 'en' as const, region: 'Live mode', sing: 'Sing', talk: 'Talk', lock: 'Lock controls', unlockHint: 'Press again to unlock controls.', locked: 'Locked', unlocked: 'Unlocked' },
])('本番帯の操作名と状態がロック・解除の結果に追従し、フォーカスを保つ ($locale)', async labels => {
    const config: BuiltinConfig = { ...singing, active: true };
    const snapshot = liveSnapshot({ running: true, definitions: { schemaVersion: 1, version: '1', singing: config, talk: null } });
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(snapshot);
    const protect = vi.spyOn(liveModesApi, 'protect').mockImplementation(async armed => ({ ...snapshot, armed }));
    function Bar() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} /></>; }
    render(<LocaleContext.Provider value={{ locale: labels.locale, setLocale: vi.fn() }}><Bar /></LocaleContext.Provider>);
    await screen.findByRole('region', { name: labels.region });
    expect(screen.getByRole('radio', { name: labels.sing })).toBeEnabled();
    expect(screen.getByRole('radio', { name: labels.talk })).toBeDisabled();
    const guard = screen.getByRole('button', { name: labels.lock });
    expect(guard).toHaveAttribute('aria-pressed', 'false');
    expect(guard).toHaveAccessibleDescription(labels.unlocked);
    expect(guard.querySelector('#live-protect-state')).toHaveClass('sr-only');
    expect(guard).toHaveAttribute('title', labels.lock);
    expect(guard).toHaveClass('min-h-6', 'min-w-6');
    guard.focus();
    await act(async () => fireEvent.click(guard));
    expect(protect).toHaveBeenCalledWith(true, 'host1');
    await waitFor(() => expect(screen.getByRole('button', { name: labels.lock })).toHaveAttribute('aria-pressed', 'true'));
    expect(guard).toHaveAccessibleDescription(labels.locked);
    expect(guard.getAttribute('title')).toContain(labels.unlockHint);
    expect(guard).toHaveTextContent(labels.locked);
    expect(guard).toHaveFocus();
    await act(async () => fireEvent.click(guard));
    expect(protect).toHaveBeenLastCalledWith(false, 'host1');
    await waitFor(() => expect(screen.getByRole('button', { name: labels.lock })).toHaveAttribute('aria-pressed', 'false'));
    expect(guard).toHaveAccessibleDescription(labels.unlocked);
    expect(guard).toHaveFocus();
});

it('ノイズ低減OFFでも現在の強さを示し、OFFを保ったまま編集できる', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats({ noiseReductionEnabled: false, noiseReductionMode: 'low' }));
    render(<VoiceQuickControls running />);
    const low = await screen.findByRole('radio', { name: '弱' });
    await waitFor(() => expect(low).toHaveAttribute('aria-checked', 'true'));
    const high = screen.getByRole('radio', { name: '強' });
    expect(high).toHaveAttribute('aria-checked', 'false');
    await act(async () => fireEvent.click(high));
    expect(audioApi.setNoiseControlConfig).toHaveBeenCalledWith(expect.objectContaining({ active: false, mode: 'high' }));
});


it.each(['keyup', 'blur'] as const)('声の量は5%刻みの編集中に送らず、%sで一度だけ確定する', async end => {
    render(<VoiceQuickControls running />);
    const slider = await screen.findByRole('slider', { name: '声の整え具合' });
    await waitFor(() => expect(slider).not.toHaveAttribute('aria-disabled', 'true'));
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider).toHaveAttribute('aria-valuenow', '55');
    expect(slider).toHaveAttribute('aria-valuetext', '55%');
    expect(audioApi.setBuiltInEffects).not.toHaveBeenCalled();
    await act(async () => { if (end === 'keyup') fireEvent.keyUp(slider, { key: 'ArrowRight' }); else fireEvent.blur(slider); });
    expect(audioApi.setBuiltInEffects).toHaveBeenCalledExactlyOnceWith({ active: true, preset: 'broadcast', amount: 0.55 });
    fireEvent.blur(slider);
    expect(audioApi.setBuiltInEffects).toHaveBeenCalledTimes(1);
});
