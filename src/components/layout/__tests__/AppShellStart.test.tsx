import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from '../AppShell';

vi.mock('../Header', () => ({ Header: () => null }));
vi.mock('../MasterBar', () => ({ MasterBar: () => null }));
vi.mock('../../features/LevelMeter/LoudnessCheck', () => ({ LoudnessCheck: () => null }));
afterEach(cleanup);

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

it('かんたん表示の音づくりと試聴を直接開き、音量チェックは明示表示にする', () => {
    const sound = vi.fn();
    const voice = vi.fn();
    render(<AppShell isBeginnerMode onDisplayModeChange={vi.fn()} onOpenOBSSettings={vi.fn()}
        onOpenSettings={vi.fn()} onOpenSoundSettings={sound} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={voice} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="" isEngineRunning={false}>
        <p>エフェクト設定</p>
    </AppShell>);
    expect(screen.getByRole('checkbox', { name: '音量チェックを表示' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /1. 声を整える/ }));
    expect(sound).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /2. 録音して聴く/ }));
    expect(voice).toHaveBeenCalledOnce();
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
