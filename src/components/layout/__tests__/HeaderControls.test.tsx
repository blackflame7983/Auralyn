import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { Header } from '../Header';
import { DeviceStatus } from '@/components/features/DeviceStatus/DeviceStatus';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('../AppUpdate', () => ({ useAppUpdate: () => ({}), UpdateGuide: () => null }));
vi.mock('../../features/LevelMeter/LevelMeter', () => ({ LevelMeter: () => null }));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn() } }));
beforeEach(() => { localStorage.clear(); vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['ja', 'en'] as const)('本番操作の名前を固定し、ミュート・比較の状態を公開する（%s）', async locale => {
    const store = createLocaleStore(() => locale, () => true);
    const mute = vi.spyOn(audioApi, 'toggleGlobalMute').mockResolvedValue(undefined);
    const bypass = vi.fn();
    const props = { onOpenSettings: vi.fn(), onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(),
        onOpenTroubleshoot: vi.fn(), onOpenWizard: vi.fn(), onToggleGlobalBypass: bypass,
        isGlobalBypassed: false, onToggleLargeMeter: vi.fn(), isLargeMeterOpen: false,
        currentHost: 'WASAPI', isEngineRunning: true, engineProcessReady: true };
    const view = render(<LocaleProvider store={store}><Header {...props} /></LocaleProvider>);
    const muteButton = screen.getByRole('button', { name: message(locale, 'header.emergency') });
    const compare = screen.getByRole('button', { name: message(locale, 'header.compare') });
    expect(muteButton).toHaveTextContent(message(locale, 'header.emergency'));
    expect(compare).toHaveTextContent(message(locale, 'header.compare'));
    expect(muteButton).toHaveAttribute('aria-pressed', 'false');
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(muteButton);
    expect(mute).toHaveBeenCalledOnce();
    const callback = vi.mocked(listen).mock.calls.find(([event]) => event === 'global-mute-changed')![1];
    act(() => callback({ event: 'global-mute-changed', id: 1, payload: true }));
    expect(screen.getByRole('button', { name: message(locale, 'header.emergency') })).toBe(muteButton);
    expect(muteButton).toHaveAttribute('aria-pressed', 'true');
    expect(muteButton).toHaveAccessibleDescription(message(locale, 'header.muted'));
    fireEvent.click(compare);
    expect(bypass).toHaveBeenCalledOnce();
    view.rerender(<LocaleProvider store={store}><Header {...props} isGlobalBypassed /></LocaleProvider>);
    expect(screen.getByRole('button', { name: message(locale, 'header.compare') })).toBe(compare);
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    expect(compare).toHaveAccessibleDescription(message(locale, 'header.vstOff'));
});

it.each([
    { processReady: null, isRunning: true, host: 'WASAPI', label: '音声状態未確認' },
    { processReady: false, isRunning: true, host: 'WASAPI', label: '音声停止中' },
    { processReady: true, isRunning: false, host: '', label: '音声未設定' },
    { processReady: true, isRunning: false, host: 'WASAPI', label: '音声停止中' },
    { processReady: true, isRunning: true, host: 'WASAPI', label: '音声処理中' },
])('音声状態を一度だけ表示し、停止・未確認では稼働中としない（$label）', props => {
    const openSettings = vi.fn();
    render(<DeviceStatus {...props} onClick={openSettings} />);
    expect(screen.getByRole('status')).toHaveTextContent(props.label);
    expect(screen.getAllByText(props.label)).toHaveLength(1);
    expect(screen.queryByText(/エンジン|通過時間/)).not.toBeInTheDocument();
    if (props.label !== '音声処理中') expect(screen.queryByText('WASAPI')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(openSettings).toHaveBeenCalledOnce();
});
