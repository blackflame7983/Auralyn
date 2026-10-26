import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { listen } from '@tauri-apps/api/event';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { AppShell } from '../AppShell';

vi.mock('../Header', () => ({ Header: () => null }));
vi.mock('../MasterBar', () => ({ MasterBar: () => null }));
vi.mock('../../features/LevelMeter/LoudnessCheck', () => ({ LoudnessCheck: () => null }));
vi.mock('../../features/Home/VoiceQuickControls', () => ({ VoiceQuickControls: () => <p>quick</p> }));
beforeEach(() => vi.mocked(listen).mockClear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([false, true])('音声停止中の入口は設定を開き、稼働中には表示しない（稼働=%s）', running => {
    const onOpenSettings = vi.fn();
    render(<AppShell isBeginnerMode onDisplayModeChange={vi.fn()} onOpenOBSSettings={vi.fn()}
        onOpenSettings={onOpenSettings} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="WASAPI" engineProcessReady={true} isEngineRunning={running}>
        <p>エフェクト設定</p>
    </AppShell>);
    const button = screen.queryByRole('button', { name: 'マイクと出力先を設定する' });
    if (running) expect(button).not.toBeInTheDocument();
    else { fireEvent.click(button!); expect(onOpenSettings).toHaveBeenCalledOnce(); }
});

it('かんたん表示はつなぐ・整える・確かめるの3段で、未設定時は設定を唯一の主操作にする', () => {
    const sound = vi.fn();
    const voice = vi.fn();
    render(<AppShell isBeginnerMode onDisplayModeChange={vi.fn()} onOpenOBSSettings={vi.fn()}
        onOpenSettings={vi.fn()} onOpenSoundSettings={sound} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={voice} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="" isEngineRunning={false}>
        <p>エフェクト設定</p>
    </AppShell>);
    expect(screen.getByRole('button', { name: '音量チェック' })).toHaveAttribute('aria-pressed', 'false');
    for (const name of ['マイクと送り先', '声を整える', '聴いて確かめる']) expect(screen.getByRole('region', { name })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'マイクと出力先を設定する' })).toHaveLength(1);
    expect(screen.queryByText('quick')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '録音して聴き比べる' })).toBeDisabled();
    expect(sound).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled();
});


it.each([null, false])('古い稼働表示が残っていても状態=%sでは設定を主操作にする', engineProcessReady => {
    const settings = vi.fn();
    render(<AppShell isBeginnerMode={false} onDisplayModeChange={vi.fn()} onOpenOBSSettings={vi.fn()}
        onOpenSettings={settings} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="WASAPI" isEngineRunning engineProcessReady={engineProcessReady}>
        <p>エフェクト設定</p>
    </AppShell>);
    fireEvent.click(screen.getByRole('button', { name: 'マイクと出力先を設定する' }));
    expect(settings).toHaveBeenCalledOnce();
    const selectedView = screen.getByRole('button', { name: 'VST・詳細' });
    expect(selectedView).toHaveAttribute('aria-pressed', 'true');
    expect(selectedView.className).not.toContain('aria-pressed:bg-primary');
});


const commonProps = {
    onDisplayModeChange: vi.fn(), onOpenOBSSettings: vi.fn(), onOpenSettings: vi.fn(),
    onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(), onOpenTroubleshoot: vi.fn(),
    onOpenVoiceCheck: vi.fn(), onOpenWizard: vi.fn(), onToggleLargeMeter: vi.fn(),
    isLargeMeterOpen: false, currentHost: 'WASAPI', isEngineRunning: true, engineProcessReady: true,
};

it.each(['ja', 'en'] as const)('フッターの原音比較で固定名・状態・外部変更を保ち、失敗時は反転しない（%s）', async locale => {
    const bypass = vi.spyOn(audioApi, 'setGlobalBypass').mockResolvedValue(undefined);
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <AppShell {...commonProps} isBeginnerMode={false}><p>rack</p></AppShell>
    </LocaleProvider>);
    const compare = screen.getByRole('button', { name: message(locale, 'header.compare') });
    expect(compare.closest('footer')).not.toBeNull();
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    await act(async () => fireEvent.click(compare));
    expect(bypass).toHaveBeenCalledWith(true);
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    expect(compare).toHaveAccessibleDescription(message(locale, 'header.vstOff'));
    await act(async () => fireEvent.click(compare));
    expect(bypass).toHaveBeenLastCalledWith(false);
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    const callback = vi.mocked(listen).mock.calls.find(([event]) => event === 'global-bypass-changed')![1];
    act(() => callback({ event: 'global-bypass-changed', id: 1, payload: true }));
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    bypass.mockRejectedValueOnce(new Error('test failure'));
    await act(async () => fireEvent.click(compare));
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: message(locale, 'header.compare') })).toHaveLength(1);
});

it('音量チェックは両表示で同じ表示切替行に一つだけあり、モード変更時に閉じる', () => {
    const view = render(<AppShell {...commonProps} isBeginnerMode><p>rack</p></AppShell>);
    const toggle = screen.getByRole('button', { name: '音量チェック' });
    const row = toggle.parentElement;
    expect(row).toHaveAttribute('aria-label', message('ja', 'shell.view'));
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    view.rerender(<AppShell {...commonProps} isBeginnerMode={false}><p>rack</p></AppShell>);
    expect(screen.getAllByRole('button', { name: '音量チェック' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '音量チェック' })).toBe(toggle);
    expect(toggle.parentElement).toBe(row);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

it('かんたん表示の稼働中は入出力・声の簡易調整・試聴をメインで扱い、詳しい調整は音づくりを開く', () => {
    const sound = vi.fn(); const voice = vi.fn(); const obs = vi.fn();
    render(<AppShell {...commonProps} isBeginnerMode onOpenSoundSettings={sound} onOpenVoiceCheck={voice} onOpenOBSSettings={obs}
        currentInput="USB マイク" currentOutput="CABLE Input (VB-Audio Virtual Cable)"><p>rack</p></AppShell>);
    expect(screen.getByText('USB マイク')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'マイクの入力レベル' })).toBeInTheDocument();
    expect(screen.getByText('quick')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'マイクと出力先を設定する' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '録音して聴き比べる' }));
    fireEvent.click(screen.getByRole('button', { name: 'OBS連携' }));
    expect(voice).toHaveBeenCalledOnce(); expect(obs).toHaveBeenCalledOnce();
});
