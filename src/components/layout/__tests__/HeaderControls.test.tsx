import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { AppRail } from '../AppRail';
import { EmergencyMuteButton } from '../EmergencyMuteButton';
import { DeviceStatus } from '@/components/features/DeviceStatus/DeviceStatus';

vi.mock('@/components/ui/slider', () => ({ Slider: () => null }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('../AppUpdate', () => ({ useAppUpdate: () => ({}), UpdateGuide: () => null }));
vi.mock('../../features/LevelMeter/LevelMeter', () => ({ LevelMeter: () => null }));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }));
beforeEach(() => { localStorage.clear(); vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const rail = (over: Partial<ComponentProps<typeof AppRail>> = {}) => ({
    current: 'home' as const, onHome: vi.fn(), onSound: vi.fn(), onVst: vi.fn(), onConnect: vi.fn(), onSettings: vi.fn(),
    onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(), onOpenTroubleshoot: vi.fn(), onOpenWizard: vi.fn(), ...over,
});

it.each(['ja', 'en'] as const)('レールから現行の画面を開き、緊急ミュートは置かない（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    const props = rail();
    render(<LocaleProvider store={store}><AppRail {...props} /></LocaleProvider>);
    expect(screen.queryByText(message(locale, 'device.engine'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: message(locale, 'header.emergency') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: message(locale, 'header.compare') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: message(locale, 'header.setupOpen') })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'rail.connectName') }));
    expect(props.onConnect).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'rail.sound') }));
    expect(props.onSound).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${message(locale, 'rail.settings')}$`) }));
    expect(props.onSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: message(locale, 'rail.home') })).toHaveAttribute('aria-current', 'page');
    expect(props.onOpenWizard).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('緊急ミュートは名前を固定し、状態を別に示す（%s）', async locale => {
    const store = createLocaleStore(() => locale, () => true);
    const mute = vi.spyOn(audioApi, 'toggleGlobalMute').mockResolvedValue(undefined);
    render(<LocaleProvider store={store}><EmergencyMuteButton onOpenSettings={vi.fn()} /></LocaleProvider>);
    const muteButton = screen.getByRole('button', { name: message(locale, 'header.emergency') });
    expect(muteButton).toHaveTextContent(message(locale, 'header.emergency'));
    expect(muteButton).toHaveClass('font-medium', 'text-ui-support');
    expect(muteButton).not.toHaveClass('font-bold');
    expect(muteButton).toHaveAttribute('aria-pressed', 'false');
    expect(muteButton).toHaveClass('bg-background');
    expect(muteButton).not.toHaveClass('ring-2');
    fireEvent.click(muteButton);
    expect(mute).toHaveBeenCalledOnce();
    const callback = vi.mocked(listen).mock.calls.find(([event]) => event === 'global-mute-changed')![1];
    act(() => callback({ event: 'global-mute-changed', id: 1, payload: true }));
    expect(screen.getByRole('button', { name: message(locale, 'header.emergency') })).toBe(muteButton);
    expect(muteButton).toHaveAttribute('aria-pressed', 'true');
    expect(muteButton).toHaveClass('bg-destructive/10', 'ring-2', 'ring-destructive-text');
    expect(muteButton).not.toHaveClass('bg-background');
    expect(muteButton).toHaveAccessibleDescription(message(locale, 'header.muted'));
});

it.each([
    { processReady: null, isRunning: true, host: 'WASAPI', label: '音声状態未確認' },
    { processReady: false, isRunning: true, host: 'WASAPI', label: '音声停止中' },
    { processReady: true, isRunning: false, host: '', label: '音声未設定' },
    { processReady: true, isRunning: false, host: 'WASAPI', label: '音声停止中' },
    { processReady: true, isRunning: true, host: 'WASAPI', label: '実行中' },
])('音声状態を一度だけ表示し、停止・未確認では稼働中としない（$label）', props => {
    render(<DeviceStatus {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent(props.label);
    const dot = screen.getByRole('status').previousElementSibling;
    expect(dot).toHaveClass(props.label === '音声未設定' ? 'bg-muted-foreground' : props.label === '音声停止中' ? 'bg-meter-danger' : props.label === '実行中' ? 'bg-success' : 'bg-warning');
    expect(screen.getAllByText(props.label)).toHaveLength(1);
    expect(screen.queryByText(/エンジン|通過時間/)).not.toBeInTheDocument();
    if (props.label !== '実行中') expect(screen.queryByText('WASAPI')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('製品名は読み上げ用にし、表示モードや大型メーターはレールに置かない（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><AppRail {...rail({ current: 'vst' })} /></LocaleProvider>);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only');
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveClass('lg:not-sr-only');
    expect(document.querySelector('nav img')).toHaveAttribute('alt', '');
    expect(screen.getByRole('button', { name: message(locale, 'rail.vst') })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: message(locale, 'header.inputGain') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /テーマ|theme/i })).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('ヘルプからホームと同じ名前・行き先の診断を開く（%s）', async locale => {
    const onOpenTroubleshoot = vi.fn();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><AppRail
        {...rail({ onOpenTroubleshoot })} /></LocaleProvider>);
    const help = screen.getByRole('button', { name: message(locale, 'header.helpOpen') });
    fireEvent.keyDown(help, { key: 'Enter' });
    const entry = await screen.findByRole('menuitem', { name: new RegExp(message(locale, 'header.noSound')) });
    fireEvent.click(entry);
    expect(onOpenTroubleshoot).toHaveBeenCalledOnce();
});
