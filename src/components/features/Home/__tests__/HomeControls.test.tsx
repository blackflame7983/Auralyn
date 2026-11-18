import { useEffect } from 'react';
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
import { toast } from 'sonner';
import { message } from '@/i18n/messages';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const stats = (patch: Partial<EngineRuntimeStats> = {}) => ({
    preparation: { engineEpoch: '1' },
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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(toast.success).mockClear(); vi.mocked(toast.error).mockClear(); });

it('閉じたモジュールのヘッダーで直接ON/OFFでき、詳細の開閉や歌向け設定に干渉しない', async () => {
    const expanded = vi.fn();
    const request = vi.spyOn(builtinApi, 'request').mockImplementation(async req => ({
        epoch: 'e1', revision: '3', appliedRevision: '3', config: req.action === 'apply' ? req.config : singing, pending: false, undoToken: null, error: null,
    }));
    const model: PreparationModel = {
        context: { location: 'home', usage: 'obs', signal: 'separate', receiver: '' }, observation: emptyObservation('ready'), records: {}, checking: false, confirming: false,
        confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn(),
    };
    const view = render(<SoundChain model={model} audioReady isEngineRunning
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
    function MusicSafety() { const model = useLiveModes(); return <><LiveModeBar model={model} safetyOnly /><LiveProtectButton model={model} audioReady inputFromApp={false} safetyOnly /></>; }
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

const registeredDefinitions = { schemaVersion: 1 as const, version: '1', singing: { ...singing, active: true }, talk: null };
it.each([
    { name: '配信・通話 / 未登録 / 解除中', music: false, registered: false, armed: false, shown: true },
    { name: '配信・通話 / 未登録 / ロック中', music: false, registered: false, armed: true, shown: true },
    { name: '配信・通話 / 登録済み / 解除中', music: false, registered: true, armed: false, shown: true },
    { name: '配信・通話 / 登録済み / ロック中', music: false, registered: true, armed: true, shown: true },
    { name: '音楽鑑賞 / 未登録 / 解除中', music: true, registered: false, armed: false, shown: false },
    { name: '音楽鑑賞 / 登録済み / 解除中', music: true, registered: true, armed: false, shown: false },
    { name: '音楽鑑賞 / 未登録 / ロック中', music: true, registered: false, armed: true, shown: true },
    { name: '音楽鑑賞 / 登録済み / ロック中', music: true, registered: true, armed: true, shown: true },
])('右の列の操作ロックは、配信・通話では登録に関係なく出し、音楽鑑賞ではロック中だけ出す ($name)', async ({ music, registered, armed, shown }) => {
    const snapshot = liveSnapshot({ armed, definitions: registered ? registeredDefinitions : liveSnapshot().definitions });
    const request = vi.spyOn(liveModesApi, 'request').mockResolvedValue(snapshot);
    function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} safetyOnly={music} /><LiveProtectButton model={model} audioReady inputFromApp={false} safetyOnly={music} /></>; }
    render(<Column />);
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'snapshot' }));
    await act(async () => {});
    const lock = screen.queryByRole('button', { name: '操作をロック' });
    if (!shown) { expect(lock).not.toBeInTheDocument(); return; }
    expect(lock).toHaveAttribute('aria-pressed', String(armed));
});

it('歌・雑談を登録していない配信でも、操作ロックを押すと本番保護を有効にする', async () => {
    let armed = false;
    vi.spyOn(liveModesApi, 'request').mockImplementation(async () => liveSnapshot({ running: true, armed }));
    const protect = vi.spyOn(liveModesApi, 'protect').mockImplementation(async next => { armed = next; return liveSnapshot({ running: true, armed }); });
    function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady inputFromApp={false} /></>; }
    render(<Column />);
    const lock = await screen.findByRole('button', { name: '操作をロック' });
    await act(async () => fireEvent.click(lock));
    expect(protect).toHaveBeenCalledExactlyOnceWith(true, 'host1');
    await waitFor(() => expect(screen.getByRole('button', { name: '操作をロック' })).toHaveAttribute('aria-pressed', 'true'));
});

it('登録していなくても、ロック中は定期確認して、バックエンドが保護を外した状態に追従する', async () => {
    vi.useFakeTimers();
    let armed = true;
    const request = vi.spyOn(liveModesApi, 'request').mockImplementation(async () => liveSnapshot({ armed, running: true }));
    function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady inputFromApp={false} /></>; }
    render(<Column />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole('button', { name: '操作をロック' })).toHaveAttribute('aria-pressed', 'true');
    armed = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(request.mock.calls.length).toBeGreaterThan(2);
    expect(screen.getByRole('button', { name: '操作をロック' })).toHaveAttribute('aria-pressed', 'false');
    vi.useRealTimers();
});

it('歌・雑談を登録済みで、ホーム以外のページ（帯が無い）でロック中でも、定期確認して保護の失効に追従する', async () => {
    vi.useFakeTimers();
    let armed = true;
    const request = vi.spyOn(liveModesApi, 'request').mockImplementation(async () => liveSnapshot({ armed, running: true, definitions: registeredDefinitions }));
    function Column({ home }: { home: boolean }) { const model = useLiveModes(); return <>{home && <LiveModeBar model={model} />}<LiveProtectButton model={model} audioReady inputFromApp={false} /></>; }
    const view = render(<Column home />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole('button', { name: '操作をロック' })).toHaveAttribute('aria-pressed', 'true');
    view.rerender(<Column home={false} />);
    armed = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(request.mock.calls.length).toBeGreaterThan(2);
    expect(screen.getByRole('button', { name: '操作をロック' })).toHaveAttribute('aria-pressed', 'false');
    vi.useRealTimers();
});

it.each([
    { locale: 'ja' as const, lock: '操作をロック' },
    { locale: 'en' as const, lock: 'Lock controls' },
])('音声が動いていない間は操作ロックを押せず、理由を title と読み上げで伝える ($locale)', async ({ locale, lock }) => {
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot({ running: false, armed: false }));
    const protect = vi.spyOn(liveModesApi, 'protect');
    function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady={false} inputFromApp={false} /></>; }
    render(<LocaleContext.Provider value={{ locale, setLocale: vi.fn() }}><Column /></LocaleContext.Provider>);
    const button = await screen.findByRole('button', { name: lock });
    const reason = message(locale, 'liveBar.protectNeedsAudio');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', reason);
    expect(button).toHaveAccessibleDescription(expect.stringContaining(reason));
    expect(screen.queryByText(reason)).toHaveClass('sr-only');
    fireEvent.click(button);
    expect(protect).not.toHaveBeenCalled();
});

it('音声が動いている間は、操作ロックに停止中の理由を付けず押せる', async () => {
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot({ running: true, armed: false }));
    function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady inputFromApp={false} /></>; }
    render(<Column />);
    const button = await screen.findByRole('button', { name: '操作をロック' });
    expect(button).toBeEnabled();
    expect(button.getAttribute('title')).toContain('操作をロック');
    expect(screen.queryByText(message('ja', 'liveBar.protectNeedsAudio'))).not.toBeInTheDocument();
});

it.each([
    { locale: 'ja' as const, lock: '操作をロック' },
    { locale: 'en' as const, lock: 'Lock controls' },
])('アプリの音声を入力にしていると、音声が動いていても操作ロックを押せず、理由を title と読み上げで伝える ($locale)', async ({ locale, lock }) => {
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot({ running: true, armed: false }));
    const protect = vi.spyOn(liveModesApi, 'protect');
    function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady inputFromApp /></>; }
    render(<LocaleContext.Provider value={{ locale, setLocale: vi.fn() }}><Column /></LocaleContext.Provider>);
    const button = await screen.findByRole('button', { name: lock });
    const reason = message(locale, 'liveBar.protectAppInput');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', reason);
    expect(button).toHaveAccessibleDescription(expect.stringContaining(reason));
    expect(screen.queryByText(reason)).toHaveClass('sr-only');
    fireEvent.click(button);
    expect(protect).not.toHaveBeenCalled();
});

it('標準の機器入力なら、操作ロックは押せて、保護の範囲を title と読み上げで伝える', async () => {
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot({ running: true, armed: false }));
    const protect = vi.spyOn(liveModesApi, 'protect').mockImplementation(async armed => liveSnapshot({ running: true, armed }));
    function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady inputFromApp={false} /></>; }
    render(<Column />);
    const button = await screen.findByRole('button', { name: '操作をロック' });
    const scope = message('ja', 'liveBar.protectHint');
    expect(button).toBeEnabled();
    expect(button.getAttribute('title')).toContain('操作をロック');
    expect(button.getAttribute('title')).toContain(scope);
    expect(button).toHaveAccessibleDescription(expect.stringContaining(scope));
    expect(screen.queryByText(message('ja', 'liveBar.protectAppInput'))).not.toBeInTheDocument();
    await act(async () => fireEvent.click(button));
    expect(protect).toHaveBeenCalledExactlyOnceWith(true, 'host1');
});

it('ロック中にアプリの音声へ変わっても、操作ロックの解除は押せる', async () => {
    const locked = liveSnapshot({ running: true, armed: true });
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(locked);
    const protect = vi.spyOn(liveModesApi, 'protect').mockImplementation(async armed => ({ ...locked, armed }));
    function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady inputFromApp /></>; }
    render(<Column />);
    const button = await screen.findByRole('button', { name: '操作をロック' });
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
    expect(button).toBeEnabled();
    await act(async () => fireEvent.click(button));
    expect(protect).toHaveBeenCalledExactlyOnceWith(false, 'host1');
});

it('登録なしでロック中の監視は、設定を開いた読み取りと同じ監視を共有し、定期確認を二重にしない', async () => {
    vi.useFakeTimers();
    vi.spyOn(liveModesApi, 'request').mockImplementation(async () => liveSnapshot({ armed: true, running: true }));
    const timers = async (withSettings: boolean) => {
        function Settings({ activate }: { activate: () => () => void }) { useEffect(() => activate(), [activate]); return null; }
        function Column() { const model = useLiveModes(); return <><LiveModeBar model={model} />{withSettings && <Settings activate={model.activate} />}<LiveProtectButton model={model} audioReady inputFromApp={false} /></>; }
        const view = render(<Column />);
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        const count = vi.getTimerCount();
        view.unmount();
        return count;
    };
    const watchOnly = await timers(false);
    const watchAndSettings = await timers(true);
    expect(watchAndSettings).toBe(watchOnly);
});

it('ロック中に音声が止まっても、操作ロックの解除は押せる', async () => {
    const locked = liveSnapshot({ running: true, armed: true });
    vi.spyOn(liveModesApi, 'request').mockResolvedValue(locked);
    const protect = vi.spyOn(liveModesApi, 'protect').mockImplementation(async armed => ({ ...locked, armed }));
    function Column({ ready }: { ready: boolean }) { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady={ready} inputFromApp={false} /></>; }
    const view = render(<Column ready />);
    await waitFor(() => expect(screen.getByRole('button', { name: '操作をロック' })).toHaveAttribute('aria-pressed', 'true'));
    view.rerender(<Column ready={false} />);
    const button = screen.getByRole('button', { name: '操作をロック' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(message('ja', 'liveBar.protectNeedsAudio'))).not.toBeInTheDocument();
    await act(async () => fireEvent.click(button));
    expect(protect).toHaveBeenCalledExactlyOnceWith(false, 'host1');
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
    expect(await screen.findByText(/現在「測定値で調整」で低減中/)).toBeInTheDocument();
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
    expect(await screen.findByText(/歌向けの設定を使用中/)).toBeInTheDocument();
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
it('声を整えるがOFFでも種類を保存し、ONにはしない', async () => {
    const saved: BuiltinConfig = { active: false, preset: 'warm', amount: 0.4, singing: { lowCutHz: 80, dynamics: 0.2, brightnessDb: 0 }, reverb: { enabled: true, mix: 0.1, decaySeconds: 1, damping: 0.5 } };
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats({ builtInEffectsEnabled: false, builtInEffectsPreset: 'warm', builtInEffectsAmount: 0.4 }));
    const request = vi.spyOn(builtinApi, 'request').mockImplementation(async req => ({
        epoch: 'e1', revision: '3', appliedRevision: '3', config: req.action === 'apply' ? req.config : saved, pending: false, undoToken: null, error: null,
    }));
    render(<VoiceQuickControls running />);
    const bright = await screen.findByRole('radio', { name: '明瞭' });
    await waitFor(() => expect(bright).toBeEnabled());
    expect(screen.getByRole('radio', { name: '温かめ' })).toHaveAttribute('aria-checked', 'true');
    await act(async () => fireEvent.click(bright));
    expect(request).toHaveBeenCalledWith({ action: 'apply', epoch: 'e1', expectedRevision: '3', config: { ...saved, active: false, preset: 'bright', amount: 0.4 } });
    expect(audioApi.setBuiltInEffects).not.toHaveBeenCalled();
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
    function Bar() { const model = useLiveModes(); return <><LiveModeBar model={model} /><LiveProtectButton model={model} audioReady inputFromApp={false} /></>; }
    render(<LocaleContext.Provider value={{ locale: labels.locale, setLocale: vi.fn() }}><Bar /></LocaleContext.Provider>);
    await screen.findByRole('region', { name: labels.region });
    expect(screen.getByRole('radio', { name: labels.sing })).toBeEnabled();
    expect(screen.getByRole('radio', { name: labels.talk })).toBeDisabled();
    const guard = screen.getByRole('button', { name: labels.lock });
    expect(guard).toHaveAttribute('aria-pressed', 'false');
    const scope = message(labels.locale, 'liveBar.protectHint');
    expect(guard).toHaveAccessibleDescription(`${labels.unlocked} ${scope}`);
    expect(guard.querySelector('#live-protect-state')).toHaveClass('sr-only');
    expect(guard).toHaveAttribute('title', `${labels.lock}\n${scope}`);
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
    expect(guard).toHaveAccessibleDescription(`${labels.unlocked} ${scope}`);
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


it('整え具合が0%のときは、軽い圧縮が残る一文をスライダーに結び、操作は止めない', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats({ builtInEffectsAmount: 0, builtInEffectsEnabled: false }));
    render(<VoiceQuickControls running />);
    const slider = await screen.findByRole('slider', { name: '声の整え具合' });
    await waitFor(() => expect(slider).not.toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByText('0%でも軽い圧縮は残ります。切るときは OFF にします')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '標準' })).toBeEnabled();
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

// 事前の snapshot も含め、builtin への要求はすべて音声エンジンが居るときだけの指定で届ける。
function expectEveryBuiltinRequestRequiresRunning(request: { mock: { calls: unknown[][] } }, actions: string[]) {
    expect(request.mock.calls.map(([req]) => (req as { action: string }).action)).toEqual(actions);
    for (const call of request.mock.calls) expect(call[1]).toEqual({ requireRunning: true });
}

it('停止中の操作は音声エンジンが居るときだけ届け、成功したら変更が戻る旨と残し方を補足する', async () => {
    const request = vi.spyOn(builtinApi, 'request').mockImplementation(async req => ({
        epoch: 'e1', revision: '3', appliedRevision: '3', config: req.action === 'apply' ? req.config : singing, pending: false, undoToken: null, error: null,
    }));
    const view = renderHook(() => useVoiceQuick(false, true, true));
    await waitFor(() => expect(view.result.current.stats).not.toBeNull());
    await act(async () => { await view.result.current.applyNoise({ mode: 'high' }); });
    expect(audioApi.setNoiseControlConfig).toHaveBeenCalledExactlyOnceWith({ active: true, mode: 'high', strength: 0.6, voiceGuard: false, requireRunning: true });
    expect(toast.success).toHaveBeenLastCalledWith(expect.any(String), { description: message('ja', 'home.stoppedHeldNoise') });
    await act(async () => { await view.result.current.applyChain({ amount: 30 }); });
    expect(audioApi.setBuiltInEffects).toHaveBeenCalledExactlyOnceWith({ active: true, preset: 'broadcast', amount: 0.3, requireRunning: true });
    await act(async () => { await view.result.current.toggleChain(false); });
    expectEveryBuiltinRequestRequiresRunning(request, ['snapshot', 'apply']);
    expect(toast.success).toHaveBeenLastCalledWith(expect.any(String), { description: message('ja', 'home.stoppedHeldVoice') });
});

it('停止中に声を整えるがOFFのまま種類・整え具合を変えるときも、事前の読取りを含めて音声エンジンが居るときだけ届ける', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats({ builtInEffectsEnabled: false }));
    const request = vi.spyOn(builtinApi, 'request').mockImplementation(async req => ({
        epoch: 'e1', revision: '3', appliedRevision: '3', config: req.action === 'apply' ? req.config : singing, pending: false, undoToken: null, error: null,
    }));
    const view = renderHook(() => useVoiceQuick(false, true, true));
    await waitFor(() => expect(view.result.current.stats).not.toBeNull());
    await act(async () => { await view.result.current.applyChain({ amount: 30 }); });
    expectEveryBuiltinRequestRequiresRunning(request, ['snapshot', 'apply']);
    expect(audioApi.setBuiltInEffects).not.toHaveBeenCalled();
});

it('停止中に音声エンジンが居なくて失敗したら、起こさず失敗を知らせて状態を読み直す', async () => {
    vi.mocked(audioApi.setNoiseControlConfig).mockRejectedValue('音声エンジンが動いていないため、変更できません。');
    const view = renderHook(() => useVoiceQuick(false, true, true));
    await waitFor(() => expect(view.result.current.stats).not.toBeNull());
    const reads = vi.mocked(audioApi.getEngineRuntimeStats).mock.calls.length;
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue({} as EngineRuntimeStats);
    await act(async () => { await view.result.current.applyNoise({ active: false }); });
    expect(toast.error).toHaveBeenCalledWith(message('ja', 'home.applyFailed'));
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(vi.mocked(audioApi.getEngineRuntimeStats).mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(view.result.current.stats?.preparation).toBeUndefined());
});

it('実行中の操作は、音声エンジンが居るときだけ届ける指定を付けない', async () => {
    const view = renderHook(() => useVoiceQuick(true, true, false));
    await waitFor(() => expect(view.result.current.stats).not.toBeNull());
    await act(async () => { await view.result.current.applyNoise({ mode: 'high' }); });
    expect(audioApi.setNoiseControlConfig).toHaveBeenCalledExactlyOnceWith({ active: true, mode: 'high', strength: 0.6, voiceGuard: false });
    expect(toast.success).toHaveBeenCalledWith(expect.any(String));
});

it('停止中のホームのスイッチ・選択・スライダーを実際に操作すると、どれも音声エンジンが居るときだけの経路で送る', async () => {
    const request = vi.spyOn(builtinApi, 'request').mockImplementation(async req => ({
        epoch: 'e1', revision: '3', appliedRevision: '3', config: req.action === 'apply' ? req.config : singing, pending: false, undoToken: null, error: null,
    }));
    const model: PreparationModel = {
        context: { location: 'home', usage: 'obs', signal: 'separate', receiver: '' }, observation: emptyObservation('ready'), records: {}, checking: false, confirming: false,
        confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn(),
    };
    render(<SoundChain model={model} stopped audioReady isEngineRunning={false} onOpenSettings={vi.fn()} onOpenOBSSettings={vi.fn()} />);
    const noise = await screen.findByRole('switch', { name: 'ノイズ低減' });
    await waitFor(() => expect(noise).toBeEnabled());
    await act(async () => fireEvent.click(noise));
    expect(audioApi.setNoiseControlConfig).toHaveBeenLastCalledWith({ active: false, mode: 'low', strength: 0.6, voiceGuard: false, requireRunning: true });
    await waitFor(() => expect(screen.getByRole('radio', { name: '強' })).toBeEnabled());
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: '強' })));
    expect(audioApi.setNoiseControlConfig).toHaveBeenLastCalledWith({ active: true, mode: 'high', strength: 0.6, voiceGuard: false, requireRunning: true });
    await waitFor(() => expect(screen.getByRole('switch', { name: '声を整える' })).toBeEnabled());
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: '声を整える' })));
    expectEveryBuiltinRequestRequiresRunning(request, ['snapshot', 'apply']);
    await waitFor(() => expect(screen.getByRole('radio', { name: '明瞭' })).toBeEnabled());
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: '明瞭' })));
    expect(audioApi.setBuiltInEffects).toHaveBeenLastCalledWith({ active: true, preset: 'bright', amount: 0.5, requireRunning: true });
    const slider = screen.getByRole('slider');
    await act(async () => { fireEvent.keyDown(slider, { key: 'ArrowRight' }); fireEvent.keyUp(slider, { key: 'ArrowRight' }); });
    await waitFor(() => expect(audioApi.setBuiltInEffects).toHaveBeenLastCalledWith({ active: true, preset: 'broadcast', amount: 0.55, requireRunning: true }));
});