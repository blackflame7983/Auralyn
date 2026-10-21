import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { MicrophonePermissionGuide } from '../MicrophonePermissionGuide';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
beforeEach(() => { vi.mocked(invoke).mockReset(); localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

it('MSIXと通常配布版の確認場所を示し、固定のマイク設定だけを開く', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(<MicrophonePermissionGuide expanded />);
    expect(screen.getByText(/アプリ一覧に表示されるAuralyn/)).toHaveTextContent('デスクトップ アプリ');
    fireEvent.click(screen.getByRole('button', { name: 'Windowsのマイク設定を開く' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_desktop_settings', { target: 'microphonePrivacy' }));
    expect(invoke).toHaveBeenCalledTimes(1);
});

it('設定起動に失敗しても手動の手順と再試行を残す', async () => {
    vi.mocked(invoke).mockRejectedValueOnce('起動失敗').mockResolvedValue(undefined);
    render(<MicrophonePermissionGuide expanded />);
    const open = screen.getByRole('button', { name: 'Windowsのマイク設定を開く' });
    fireEvent.click(open);
    expect(await screen.findByRole('alert')).toHaveTextContent('Windowsの設定から');
    fireEvent.click(open);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

it.each(['保存して開始', 'エンジン再起動'])('%sのアクセス拒否から戻っても選択したデバイスと保存値を保ち、明示操作で再試行する', async action => {
    const devices = {
        inputs: ['Mic A', 'Mic B'].map(name => ({ name, host: 'Wasapi', channels: 2 })),
        outputs: [{ name: 'Headphones', host: 'Wasapi', channels: 2 }],
    };
    const saved = JSON.stringify({ host: 'Wasapi', input: 'Mic A', output: 'Headphones' });
    localStorage.setItem('vst_host_audio_config', saved);
    const start = vi.fn().mockRejectedValueOnce('アクセスが拒否されました。(0x80070005)')
        .mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'start_audio' || command === 'restart_audio_engine') return start();
        return null;
    });
    const changed = vi.fn();
    const restarted = vi.fn();
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={changed} onEngineRestarted={restarted} />);
    const input = await screen.findByRole('combobox', { name: 'マイク入力・ASIOデバイス' });
    fireEvent.change(input, { target: { value: 'Mic B' } });
    fireEvent.click(screen.getByRole('button', { name: action }));
    if (action === 'エンジン再起動')
        fireEvent.click(await screen.findByRole('button', { name: '再起動する' }));
    await screen.findByRole('button', { name: '設定に戻って再試行' });
    expect(document.querySelector('details')).toHaveAttribute('open');
    expect(changed).not.toHaveBeenCalled();
    expect(restarted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Windowsのマイク設定を開く' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Windowsのマイク設定を開く' })).toBeEnabled());
    expect(start).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('vst_host_audio_config')).toBe(saved);
    fireEvent.click(screen.getByRole('button', { name: '設定に戻って再試行' }));
    expect(screen.getByRole('combobox', { name: 'マイク入力・ASIOデバイス' })).toHaveValue('Mic B');
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ input: 'Mic B' }), { audioStarted: true }));
    expect(start).toHaveBeenCalledTimes(2);
});
