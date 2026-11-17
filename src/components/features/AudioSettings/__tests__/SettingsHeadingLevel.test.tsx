import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { message } from '@/i18n/messages';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

afterEach(() => { cleanup(); localStorage.clear(); vi.mocked(invoke).mockReset(); });

it('システムの項目見出しは節の見出しより小さい', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'obs_setup_history' ? [] : null);
    render(<AudioSettingsModal isOpen initialTab="system" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const section = await screen.findByRole('heading', { name: message('ja', 'settings.system.preferences') });
    const item = await screen.findByRole('heading', { name: message('ja', 'settings.AudioSettingsModal.142') });
    expect(section).toHaveClass('text-ui-heading');
    expect(item).toHaveClass('text-ui-control');
    expect(item).not.toHaveClass('text-ui-heading');
});

it('OBSの接続先は、節の見出しより小さい', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'obs_setup_history' ? [] : null);
    render(<AudioSettingsModal isOpen initialTab="obs" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const section = await screen.findByRole('heading', { name: message('ja', 'obs.section.connect') });
    const item = await screen.findByText(message('ja', 'obs.target'));
    expect(section).toHaveClass('text-ui-heading');
    expect(item).toHaveClass('text-ui-control');
    expect(item).not.toHaveClass('text-ui-heading');
});
