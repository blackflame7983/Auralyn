import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AudioSettingsModal } from '../AudioSettingsModal';
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

const devices = {
    inputs: [
        { name: 'ASIO device', host: 'ASIO', channels: 22 },
        { name: 'Cable input', host: 'Wasapi', channels: 2 },
    ],
    outputs: [
        { name: 'ASIO device', host: 'ASIO', channels: 22 },
        { name: 'Test output', host: 'Wasapi', channels: 2 },
    ],
};
beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
        'vst_host_audio_config',
        JSON.stringify({
            host: 'ASIO',
            input: 'ASIO device',
            output: 'ASIO device',
            inputChannels: [6, 7],
        })
    );
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
        if (cmd === 'get_audio_devices') return devices;
        if (cmd === 'start_audio' || cmd === 'restart_audio_engine')
            return { sample_rate: 48000, buffer_size: 512, channels: 2 };
        if (cmd === 'get_autostart_status') return { enabled: false };
        return null;
    });
});
afterEach(() => {
    cleanup();
    localStorage.clear();
});

it.each(['保存して開始', 'エンジン再起動'])(
    'ASIOからWASAPIの%sでエンジンと保存値を0/1へ更新する',
    async (action) => {
        const update = vi.fn();
        render(
            <AudioSettingsModal
                isOpen
                onClose={() => {}}
                onConfigChange={update}
                currentInputChannels={[6, 7]}
            />
        );
        await screen.findByRole('option', { name: 'Wasapi' });
        const host = screen
            .getAllByRole('combobox')
            .find((e) =>
                Array.from((e as HTMLSelectElement).options).some((o) => o.value === 'Wasapi')
            )!;
        fireEvent.change(host, { target: { value: 'Wasapi' } });
        fireEvent.click(screen.getByRole('button', { name: action }));
        if (action === 'エンジン再起動')
            fireEvent.click(await screen.findByRole('button', { name: '再起動する' }));
        await waitFor(() =>
            expect(update).toHaveBeenCalledWith(
                expect.objectContaining({ host: 'Wasapi', inputChannels: [0, 1] })
            )
        );
        expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 0, right: 1 });
    }
);

it('ASIOを維持する保存では6/7を維持する', async () => {
    const update = vi.fn();
    render(
        <AudioSettingsModal
            isOpen
            onClose={() => {}}
            onConfigChange={update}
            currentInputChannels={[6, 7]}
        />
    );
    await screen.findByRole('option', { name: 'ASIO device' });
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ host: 'ASIO', inputChannels: [6, 7] })
        )
    );
    expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 6, right: 7 });
});
