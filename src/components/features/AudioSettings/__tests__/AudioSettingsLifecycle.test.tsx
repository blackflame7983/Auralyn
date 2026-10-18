import { type ComponentProps } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ModalLayer } from '@/components/layout/ModalLayer';
import { useUIState } from '@/hooks/useUIState';
import type { ObsSetupHistory } from '@/api/obs';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function AppModals() {
    const ui = useUIState();
    return (
        <>
            <button onClick={() => ui.setIsSettingsOpen(true)}>設定を表示</button>
            <button onClick={ui.openObsSettings}>OBSを整える</button>
            <ModalLayer
                ui={ui}
                audioConfig={{
                    host: 'WASAPI',
                    input: '',
                    output: '',
                    sampleRate: 48000,
                    bufferSize: 512,
                }}
                handleConfigUpdate={() => {}}
                pluginsApi={{} as ComponentProps<typeof ModalLayer>['pluginsApi']}
                onPluginAdded={() => {}}
            />
        </>
    );
}

afterEach(() => { cleanup(); localStorage.clear(); });

it('適用後に設定画面を閉じて再表示しても、再接続なしで履歴を復元する', async () => {
    let history: ObsSetupHistory[] = [];
    let connected = false;
    let connections = 0;
    const change = { source: 'test', label: 'ミュート', before: false, after: true };
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
        if (cmd === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (cmd === 'get_autostart_status') return { enabled: false };
        if (cmd === 'get_engine_tuning_config' || cmd === 'get_engine_runtime_stats') return null;
        if (cmd === 'obs_connection_status') return connected;
        if (cmd === 'connect_obs') { connections++; connected = true; history = []; return; }
        if (cmd === 'obs_setup_history') return history;
        if (cmd === 'obs_preview_setup') return { id: 1, supported: true, message: '', duplicateMicSources: [], changes: [change] };
        if (cmd === 'obs_apply_setup') {
            const result = { id: 1, changes: [change], results: ['適用済み'] };
            history.push(result); return result;
        }
        if (cmd === 'obs_restore_setup') {
            history[0] = { ...history[0], results: ['復元済み'] }; return history[0];
        }
    });
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    fireEvent.keyDown(await screen.findByRole('tab', { name: 'OBS連携' }), { key: 'Enter' });
    const connect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    fireEvent.click(await screen.findByRole('button', { name: '変更予定を確認する' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
    await screen.findByRole('button', { name: '変更 #1 を元に戻す' });
    fireEvent.click(screen.getByRole('button', { name: '設定画面を閉じる' }));
    expect(history).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    fireEvent.keyDown(await screen.findByRole('tab', { name: 'OBS連携' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: '変更 #1 を元に戻す' }));
    await screen.findByText(/復元済み/);
    expect(connections).toBe(1);
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'obs_restore_setup')).toHaveLength(1);
});

it('OBSの入口からはOBSタブを開き、通常の設定入口はオーディオへ戻る', async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
        if (cmd === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (cmd === 'get_autostart_status') return { enabled: false };
        if (cmd === 'obs_connection_status') return false;
        return null;
    });
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: 'OBSを整える' }));
    expect(await screen.findByRole('tab', { name: 'OBS連携' })).toHaveAttribute(
        'aria-selected',
        'true'
    );
    expect(invoke).not.toHaveBeenCalledWith('connect_obs', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '設定画面を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    expect(await screen.findByRole('tab', { name: 'オーディオ' })).toHaveAttribute(
        'aria-selected',
        'true'
    );
});
