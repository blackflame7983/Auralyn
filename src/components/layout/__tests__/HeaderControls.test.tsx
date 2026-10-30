import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { Header } from '../Header';
import { DeviceStatus } from '@/components/features/DeviceStatus/DeviceStatus';

vi.mock('@/components/ui/slider', () => ({ Slider: () => null }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('../AppUpdate', () => ({ useAppUpdate: () => ({}), UpdateGuide: () => null }));
vi.mock('../../features/LevelMeter/LevelMeter', () => ({ LevelMeter: () => null }));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn() } }));
beforeEach(() => { localStorage.clear(); vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['ja', 'en'] as const)('共通ヘッダーの入口とミュートの状態を公開する（%s）', async locale => {
    const store = createLocaleStore(() => locale, () => true);
    const mute = vi.spyOn(audioApi, 'toggleGlobalMute').mockResolvedValue(undefined);
    const props = { onOpenSettings: vi.fn(), onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(),
        onOpenTroubleshoot: vi.fn(), onOpenWizard: vi.fn(),
        onToggleLargeMeter: vi.fn(), isLargeMeterOpen: false,
        currentHost: 'WASAPI', isEngineRunning: true, engineProcessReady: true };
    const view = render(<LocaleProvider store={store}><Header {...props} /></LocaleProvider>);
    const muteButton = screen.getByRole('button', { name: message(locale, 'header.emergency') });
    expect(screen.queryByRole('button', { name: message(locale, 'header.compare') })).not.toBeInTheDocument();
    const setup = screen.getByRole('button', { name: message(locale, 'header.setupOpen') });
    expect(setup).toHaveClass('border-input');
    expect(setup).not.toHaveClass('bg-primary');
    fireEvent.click(setup);
    expect(props.onOpenWizard).toHaveBeenCalledOnce();
    expect(muteButton).toHaveTextContent(message(locale, 'header.emergency'));
    expect(muteButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(muteButton);
    expect(mute).toHaveBeenCalledOnce();
    const callback = vi.mocked(listen).mock.calls.find(([event]) => event === 'global-mute-changed')![1];
    act(() => callback({ event: 'global-mute-changed', id: 1, payload: true }));
    expect(screen.getByRole('button', { name: message(locale, 'header.emergency') })).toBe(muteButton);
    expect(muteButton).toHaveAttribute('aria-pressed', 'true');
    expect(muteButton).toHaveAccessibleDescription(message(locale, 'header.muted'));
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'header.audioSettingsOpen') }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    // 詳細表示でも同じヘッダーの位置にセットアップを残す。
    localStorage.setItem('vst_host_beginner_mode', 'false');
    act(() => window.dispatchEvent(new CustomEvent('vst_host_beginner_mode_changed', { detail: false })));
    view.rerender(<LocaleProvider store={store}><Header {...props} /></LocaleProvider>);
    expect(screen.getByRole('button', { name: message(locale, 'header.setupOpen') })).toBe(setup);
    fireEvent.click(setup);
    expect(props.onOpenWizard).toHaveBeenCalledTimes(2);
});

it.each([
    { processReady: null, isRunning: true, host: 'WASAPI', label: '音声状態未確認' },
    { processReady: false, isRunning: true, host: 'WASAPI', label: '音声停止中' },
    { processReady: true, isRunning: false, host: '', label: '音声未設定' },
    { processReady: true, isRunning: false, host: 'WASAPI', label: '音声停止中' },
    { processReady: true, isRunning: true, host: 'WASAPI', label: '音声処理中' },
])('音声状態を一度だけ表示し、停止・未確認では稼働中としない（$label）', props => {
    render(<DeviceStatus {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent(props.label);
    expect(screen.getAllByText(props.label)).toHaveLength(1);
    expect(screen.queryByText(/エンジン|通過時間/)).not.toBeInTheDocument();
    if (props.label !== '音声処理中') expect(screen.queryByText('WASAPI')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('かんたん／詳細はヘッダーのアイコン1つで切り替え、ヘルプの近道と同じ名前にする（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    const props = { onOpenSettings: vi.fn(), onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(),
        onOpenTroubleshoot: vi.fn(), onOpenWizard: vi.fn(),
        onToggleLargeMeter: vi.fn(), isLargeMeterOpen: false,
        currentHost: 'WASAPI', isEngineRunning: true, engineProcessReady: true };
    render(<LocaleProvider store={store}><Header {...props} /></LocaleProvider>);
    const toDetailed = screen.getByRole('button', { name: message(locale, 'header.advanced') });
    expect(toDetailed).toHaveAttribute('data-detailed', 'false');
    fireEvent.click(toDetailed);
    expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
    // 押した後は同じボタンが「かんたんに切替」になり、詳細表示中であることを主色で示す。
    expect(toDetailed).toHaveAccessibleName(message(locale, 'header.simple'));
    expect(toDetailed).toHaveAttribute('data-detailed', 'true');
    fireEvent.click(toDetailed);
    expect(localStorage.getItem('vst_host_beginner_mode')).toBe('true');
    // マイク音量は本番帯へ移し、フッター・本番帯と重なる小さなメーターとテーマ切替はヘッダーに置かない（詳細表示でも）。
    fireEvent.click(toDetailed);
    expect(screen.queryByRole('button', { name: message(locale, 'header.inputGain') })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /テーマ|theme/i })).not.toBeInTheDocument();
});