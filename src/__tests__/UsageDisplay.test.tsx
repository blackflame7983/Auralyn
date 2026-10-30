import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import { saveBeginnerMode } from '../hooks/useBeginnerMode';
import { saveVstPanelOpen } from '../hooks/useVstPanel';

const { audioState, modalCallbacks } = vi.hoisted(() => ({
    audioState: { audioConfig: { host: 'ASIO' }, isInitializing: false, isEngineRunning: true, engineProcessReady: true as boolean | null },
    modalCallbacks: { onPluginAdded: undefined as (() => void) | undefined, setWizardOpen: undefined as ((value: boolean) => void) | undefined },
}));

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }));
vi.mock('@/hooks/useAudioConfig', () => ({ useAudioConfig: () => audioState }));
vi.mock('@/hooks/useAppEvents', () => ({ useAppEvents: () => {} }));
vi.mock('@/api/audio', () => ({
    audioApi: { getDevices: () => Promise.resolve({ inputs: [], outputs: [] }) },
}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ onCloseRequested: () => Promise.resolve(() => {}) }),
}));
vi.mock('@/hooks/usePlugins', () => ({ usePlugins: () => ({ plugins: [{ id: 'kept' }] }) }));
vi.mock('@/components/features/Tutorial/TutorialOverlay', async () => {
    const { useTutorial } = await import('@/contexts/TutorialContext');
    return { TutorialOverlay: ({ step }: { step: string }) => {
        const { currentStep } = useTutorial();
        return <span data-testid="tutorial" data-active={currentStep === step}>{step}</span>;
    } };
});
vi.mock('@/components/features/PluginRack/PluginList', () => ({
    PluginList: ({ plugins, audioReady }: { plugins: { id: string }[]; audioReady: boolean }) => (
        <span data-testid="plugins" data-audio-ready={audioReady}>{plugins.map((p) => p.id).join()}</span>
    ),
}));
vi.mock('@/components/layout/ModalLayer', () => ({
    ModalLayer: ({ onPluginAdded, ui }: { onPluginAdded: () => void; ui: { setIsWizardOpen: (value: boolean) => void } }) => {
        modalCallbacks.onPluginAdded = onPluginAdded;
        modalCallbacks.setWizardOpen = ui.setIsWizardOpen;
        return <span data-testid="modals">設定入口</span>;
    },
}));
vi.mock('@/components/layout/AppShell', async () => {
    // 右パネルの開閉は共有の保存値（useVstPanel）で行う。本物の AppShell と同じく、開いている間だけラックを出す。
    const { useVstPanel, saveVstPanelOpen } = await import('@/hooks/useVstPanel');
    return { AppShell: ({ children, vstPanel }: { children: React.ReactNode; vstPanel?: React.ReactNode }) => {
        const [open] = useVstPanel();
        return <>
            <button onClick={() => saveVstPanelOpen(true)}>VSTを編集</button>
            {open && vstPanel}
            {children}
        </>;
    } };
});
vi.mock('sonner', () => ({ Toaster: () => null, toast: { success: vi.fn() } }));

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_wizard_done', 'true');
    Object.assign(audioState, { audioConfig: { host: 'ASIO' }, isInitializing: false, isEngineRunning: true, engineProcessReady: true });
});
afterEach(cleanup);
it('VST 構成は右パネルを開いたときだけ出し、エフェクトと全チュートリアルを保持する', () => {
    render(<App />);
    expect(screen.queryByTestId('plugins')).not.toBeInTheDocument();
    expect(screen.getByTestId('modals')).toBeVisible();
    expect(screen.queryAllByTestId('tutorial')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'VSTを編集' }));
    expect(screen.getByTestId('plugins')).toBeVisible();
    expect(screen.getByTestId('plugins')).toHaveTextContent('kept');
    expect(screen.getAllByTestId('tutorial').map((node) => node.textContent)).toEqual([
        'click_add_effect',
        'explain_plugin_card',
        'try_edit_plugin',
        'try_ab_compare',
    ]);
});
it('以前の詳細表示を使っていた人は右パネルを開いた状態から始め、数値の詳細の切替ではパネルを閉じない', () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    render(<App />);
    expect(screen.getByTestId('plugins')).toBeVisible();
    act(() => saveBeginnerMode(true));
    expect(screen.getByTestId('plugins')).toBeVisible();
    act(() => saveVstPanelOpen(false));
    expect(screen.queryByTestId('plugins')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('tutorial')).toHaveLength(0);
});

it.each([
    { label: '未設定', audioConfig: { host: '' }, isInitializing: false, isEngineRunning: false, engineProcessReady: true },
    { label: '初期化中', audioConfig: { host: 'ASIO' }, isInitializing: true, isEngineRunning: true, engineProcessReady: true },
    { label: '停止中', audioConfig: { host: 'ASIO' }, isInitializing: false, isEngineRunning: false, engineProcessReady: true },
    { label: '稼働未確認', audioConfig: { host: 'ASIO' }, isInitializing: false, isEngineRunning: true, engineProcessReady: null },
    { label: '開始失敗', audioConfig: { host: 'ASIO' }, isInitializing: false, isEngineRunning: false, engineProcessReady: false },
])('$labelでも右パネルの VST 準備を残し、チュートリアルは稼働確認後まで表示しない', state => {
    Object.assign(audioState, state);
    localStorage.setItem('auralyn_vst_panel_open', 'true');
    render(<App />);
    expect(screen.getByTestId('plugins')).toBeVisible();
    expect(screen.getByTestId('plugins')).toHaveAttribute('data-audio-ready', 'false');
    expect(screen.queryAllByTestId('tutorial')).toHaveLength(0);
    expect(localStorage.getItem('vst_host_tutorial_completed')).toBeNull();
    expect(localStorage.getItem('vst_host_wizard_done')).toBe('true');
});

it('停止中の遅い追加完了で進めず、稼働再開時に同じチュートリアル手順へ戻る', () => {
    localStorage.setItem('auralyn_vst_panel_open', 'true');
    const view = render(<App />);
    const activeStep = () => screen.getAllByTestId('tutorial').find(node => node.dataset.active === 'true')?.textContent;
    expect(activeStep()).toBe('click_add_effect');
    const lateAddition = modalCallbacks.onPluginAdded!;
    audioState.isEngineRunning = false;
    view.rerender(<App />);
    expect(screen.queryAllByTestId('tutorial')).toHaveLength(0);
    act(() => lateAddition());
    audioState.isEngineRunning = true;
    view.rerender(<App />);
    expect(activeStep()).toBe('click_add_effect');
    expect(screen.getByTestId('plugins')).toHaveAttribute('data-audio-ready', 'true');
    act(() => modalCallbacks.onPluginAdded!());
    expect(activeStep()).toBe('explain_plugin_card');
    audioState.engineProcessReady = null;
    view.rerender(<App />);
    expect(screen.queryAllByTestId('tutorial')).toHaveLength(0);
    audioState.engineProcessReady = true;
    view.rerender(<App />);
    expect(activeStep()).toBe('explain_plugin_card');
    expect(localStorage.getItem('vst_host_tutorial_completed')).toBeNull();
});


it('同じウィンドウの完了通知後もモーダル中は隠し、閉じて稼働確認できた時に最初の案内を表示する', () => {
    localStorage.removeItem('vst_host_wizard_done');
    localStorage.setItem('auralyn_vst_panel_open', 'true');
    const view = render(<App />);
    const activeStep = () => screen.queryAllByTestId('tutorial').find(node => node.dataset.active === 'true')?.textContent;
    expect(activeStep()).toBeUndefined();
    act(() => modalCallbacks.setWizardOpen?.(true));
    act(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        window.dispatchEvent(new Event('vst_host_tutorial_start'));
    });
    expect(screen.queryAllByTestId('tutorial')).toHaveLength(0);
    audioState.engineProcessReady = null;
    act(() => modalCallbacks.setWizardOpen?.(false));
    view.rerender(<App />);
    expect(activeStep()).toBeUndefined();
    audioState.engineProcessReady = true;
    view.rerender(<App />);
    expect(activeStep()).toBe('click_add_effect');
    expect(localStorage.getItem('vst_host_tutorial_completed')).toBeNull();
});
