import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { message } from '@/i18n/messages';
import { UpdatePreferences } from '../UpdatePreferences';

afterEach(() => { cleanup(); localStorage.clear(); vi.mocked(invoke).mockReset(); });

it('確認がOFFのインストール版では、自動ダウンロードを選べない理由を出す', async () => {
    localStorage.setItem('vst_host_update_policy', JSON.stringify({ automatic: false, download: false }));
    vi.mocked(invoke).mockImplementation(async command => command === 'get_distribution' ? 'standalone' : undefined);
    render(<UpdatePreferences />);
    const download = screen.getByRole('checkbox', { name: message('ja', 'settings.UpdatePreferences.437') });
    expect(download).toBeDisabled();
    const reason = message('ja', 'settings.update.downloadNeedsCheck', { check: message('ja', 'settings.UpdatePreferences.436') });
    await waitFor(() => expect(screen.getByText(reason)).toBeVisible());
    expect(download).toHaveAttribute('aria-describedby', 'update-download-reason');
    expect(screen.getByRole('heading', { name: message('ja', 'settings.UpdatePreferences.434') })).toHaveClass('text-ui-control');
    expect(screen.getByRole('heading', { name: message('ja', 'settings.UpdatePreferences.434') })).not.toHaveClass('text-ui-heading');
});

it('確認がONのときは、自動ダウンロードの理由を出さない', async () => {
    localStorage.setItem('vst_host_update_policy', JSON.stringify({ automatic: true, download: false }));
    vi.mocked(invoke).mockResolvedValue('standalone');
    render(<UpdatePreferences />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: message('ja', 'settings.UpdatePreferences.437') })).toBeEnabled());
    expect(screen.queryByText(message('ja', 'settings.update.downloadNeedsCheck', { check: message('ja', 'settings.UpdatePreferences.436') }))).not.toBeInTheDocument();
});
