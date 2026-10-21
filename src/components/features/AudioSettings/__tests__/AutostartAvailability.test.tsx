import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
beforeEach(() => { vi.mocked(invoke).mockReset(); localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

function open(status: unknown) {
    localStorage.setItem('vst_host_system_tab_enabled', 'true');
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_autostart_status') {
            if (status instanceof Error) throw status;
            return status;
        }
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (command === 'get_engine_tuning_config') return {
            enableAffinityPinning: false, affinityMask: null,
            enableRealtimePriority: false, enableTimeCriticalAudioThreads: false,
        };
        return null;
    });
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'システム' }), { button: 0, ctrlKey: false });
}

it.each([
    'MSIX版の自動起動は準備中です。通常版の登録は変更しません。',
    '別のAuralynの自動起動登録があります。登録した版で解除してください。',
])('変更不可の理由を示し、Runキーの変更を送信しない: %s', async reason => {
    open({ enabled: false, canChange: false, reason, method: 'unavailable' });
    expect(await screen.findByText(reason)).toBeVisible();
    const control = screen.getByRole('switch', { name: 'Windows起動時に自動起動' });
    expect(control).toBeDisabled();
    fireEvent.click(control);
    expect(invoke).not.toHaveBeenCalledWith('set_autostart_enabled', expect.anything());
});

it('状態取得に失敗した場合は登録操作を無効にする', async () => {
    open(new Error('registry read failed'));
    expect(await screen.findByText(/自動起動の状態を確認できませんでした/)).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Windows起動時に自動起動' })).toBeDisabled();
});

it('自分の通常版の登録だけは明示操作で変更できる', async () => {
    open({ enabled: false, canChange: true, reason: null, method: 'registry' });
    const control = screen.getByRole('switch', { name: 'Windows起動時に自動起動' });
    await waitFor(() => expect(control).toBeEnabled());
    fireEvent.click(control);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_autostart_enabled', { enabled: true }));
});

it('変更後の状態確認に失敗しても有効になったと表示しない', async () => {
    open({ enabled: false, canChange: true, reason: null, method: 'registry' });
    const control = screen.getByRole('switch', { name: 'Windows起動時に自動起動' });
    await waitFor(() => expect(control).toBeEnabled());
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_autostart_status') throw new Error('status unavailable');
        return null;
    });
    fireEvent.click(control);
    expect(await screen.findByText(/自動起動の変更結果を確認できませんでした/)).toBeVisible();
    expect(control).not.toBeChecked();
    expect(control).toBeDisabled();
});
