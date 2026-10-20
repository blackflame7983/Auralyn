import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
const devices = {
    inputs: [{ name: 'ASIO device', host: 'ASIO', channels: 2 }, { name: 'USB mic', host: 'Wasapi', channels: 2 }],
    outputs: [{ name: 'ASIO device', host: 'ASIO', channels: 2 }, { name: 'Headphones', host: 'Wasapi', channels: 2 }],
};
const openSettings = () => render(<AudioSettingsModal isOpen onClose={() => {}} onConfigChange={vi.fn()} />);
const hostSelect = () => screen.getAllByRole('combobox').find(element =>
    Array.from((element as HTMLSelectElement).options).some(option => option.value === 'Wasapi'))!;

beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        if (command === 'get_autostart_status') return { enabled: false };
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); });

it('未保存で閉じて再表示してもキャッシュからホストとデバイスを選択する', async () => {
    const first = openSettings();
    await screen.findByRole('option', { name: 'ASIO device' });
    first.unmount();
    openSettings();
    await waitFor(() => expect(hostSelect()).toHaveValue('ASIO'));
    expect(screen.getByRole('option', { name: 'ASIO device' })).toBeInTheDocument();
    expect(screen.queryByText('対応デバイスなし')).not.toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_audio_devices')).toHaveLength(1);
});

it('接続設定と即時反映の音づくりを分け、操作名を公開する', async () => {
    openSettings();
    const host = await screen.findByRole('combobox', { name: 'オーディオドライバ' });
    const input = screen.getByRole('combobox', { name: 'マイク入力・ASIOデバイス' });
    expect(screen.queryByRole('switch', { name: 'ノイズ低減' })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '音づくり' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('switch', { name: 'ノイズ低減' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '内蔵ボイスチェーン' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存して開始' })).not.toBeInTheDocument();
    expect(host.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

});

it('キャッシュのみの再表示でも保存済みWASAPIの入出力を復元する', async () => {
    localStorage.setItem('vst_host_cached_devices', JSON.stringify(devices));
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi', input: 'USB mic', output: 'Headphones' }));
    openSettings();
    await waitFor(() => expect(hostSelect()).toHaveValue('Wasapi'));
    expect(screen.getByRole('option', { name: 'USB mic' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Headphones' })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('get_audio_devices', expect.anything());
});

it('消えた保存ホストを使用可能なホストへ置き換え、手動で切り替えられる', async () => {
    localStorage.setItem('vst_host_cached_devices', JSON.stringify(devices));
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Removed driver' }));
    openSettings();
    await waitFor(() => expect(hostSelect()).toHaveValue('ASIO'));
    expect(screen.getByRole('option', { name: 'ASIO device' })).toBeInTheDocument();
    // 手動切替も引き続き有効であることを確認する。
    fireEvent.change(hostSelect(), { target: { value: 'Wasapi' } });
    expect(screen.getByRole('option', { name: 'USB mic' })).toBeInTheDocument();
});

it('処理設定の取得前は音づくりを変更しない', async () => {
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return new Promise(() => {});
        return null;
    });
    render(<AudioSettingsModal initialTab="sound" isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    expect(await screen.findByRole('switch', { name: '内蔵ボイスチェーン' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'ノイズ低減' })).toBeDisabled();
    expect(screen.getByText(/現在の設定を確認できるまで/)).toBeInTheDocument();
});
