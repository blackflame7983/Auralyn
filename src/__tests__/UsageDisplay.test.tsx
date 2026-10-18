import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import { saveBeginnerMode } from '../hooks/useBeginnerMode';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }));
vi.mock('@/hooks/useAudioConfig', () => ({
    useAudioConfig: () => ({
        audioConfig: { host: 'ASIO' },
        isInitializing: false,
        isEngineRunning: true,
    }),
}));
vi.mock('@/hooks/useAppEvents', () => ({ useAppEvents: () => {} }));
vi.mock('@/api/audio', () => ({
    audioApi: { getDevices: () => Promise.resolve({ inputs: [], outputs: [] }) },
}));
vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ onCloseRequested: () => Promise.resolve(() => {}) }),
}));
vi.mock('@/hooks/usePlugins', () => ({ usePlugins: () => ({ plugins: [{ id: 'kept' }] }) }));
vi.mock('@/contexts/TutorialContext', () => ({
    TutorialProvider: ({ children }: { children: React.ReactNode }) => children,
    useTutorial: () => ({ currentStep: 'click_add_effect', completeStep: () => {} }),
}));
vi.mock('@/components/features/Tutorial/TutorialOverlay', () => ({
    TutorialOverlay: ({ step }: { step: string }) => <span data-testid="tutorial">{step}</span>,
}));
vi.mock('@/components/features/PluginRack/PluginList', () => ({
    PluginList: ({ plugins }: { plugins: { id: string }[] }) => (
        <span data-testid="plugins">{plugins.map((p) => p.id).join()}</span>
    ),
}));
vi.mock('@/components/layout/ModalLayer', () => ({
    ModalLayer: () => <span data-testid="modals">設定入口</span>,
}));
vi.mock('@/components/layout/AppShell', () => ({
    AppShell: ({
        children,
        onDisplayModeChange,
    }: {
        children: React.ReactNode;
        onDisplayModeChange: (value: boolean) => void;
    }) => (
        <>
            <button onClick={() => onDisplayModeChange(false)}>VST詳細へ</button>
            {children}
        </>
    ),
}));
vi.mock('sonner', () => ({ Toaster: () => null, toast: { success: vi.fn() } }));

beforeEach(() => localStorage.clear());
afterEach(cleanup);
it('かんたん表示はVSTだけを折りたたみ、用途切替後もエフェクトと全チュートリアルを保持する', () => {
    render(<App />);
    expect(screen.getByTestId('plugins')).not.toBeVisible();
    expect(screen.getByTestId('modals')).toBeVisible();
    expect(screen.queryAllByTestId('tutorial')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'VST詳細へ' }));
    expect(screen.getByTestId('plugins')).toBeVisible();
    expect(screen.getByTestId('plugins')).toHaveTextContent('kept');
    expect(screen.getAllByTestId('tutorial').map((node) => node.textContent)).toEqual([
        'click_add_effect',
        'explain_plugin_card',
        'try_edit_plugin',
        'try_ab_compare',
    ]);
});
it('既存の詳細表示を初回から維持し、セットアップで保存した表示にも同期する', () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    render(<App />);
    expect(screen.getByTestId('plugins')).toBeVisible();
    act(() => saveBeginnerMode(true));
    expect(screen.getByTestId('plugins')).not.toBeVisible();
    expect(screen.queryAllByTestId('tutorial')).toHaveLength(0);
});
