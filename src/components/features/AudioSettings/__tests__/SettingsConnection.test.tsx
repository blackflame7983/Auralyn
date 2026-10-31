import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AudioSettingsModal } from '../AudioSettingsModal';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';
import { useState } from 'react';
import type { AudioPreferences } from '@/lib/audioPreferences';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
const config = { host: 'Wasapi', input: 'Mic', output: 'Headphones', sampleRate: 48000, bufferSize: 512 };
const devices = {
    inputs: [{ host: 'Wasapi', name: 'Mic', channels: 2, is_input: true, is_default: true, index: 0 }],
    outputs: [{ host: 'Wasapi', name: 'Headphones', channels: 2, is_input: false, is_default: true, index: 0 }],
};
beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });

it('稼働中の変更なし保存を抑止し、変更を戻すと再び抑止する', async () => {
    const start = vi.spyOn(audioApi, 'start');
    render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const save = await screen.findByRole('button', { name: '保存して再起動' });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク入力' })).toHaveValue('Mic'));
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(/変更はありません.*音声が一瞬途切れます/);
    fireEvent.click(save);
    expect(start).not.toHaveBeenCalled();
    const summary = screen.getByText('音の途切れ・周波数', { exact: false, selector: 'summary' });
    fireEvent.click(summary);
    await waitFor(() => expect(summary.closest('details')).toHaveAttribute('open'));
    fireEvent.click(await screen.findByRole('button', { name: /途切れにくく.*音切れ対策/ }));
    expect(save).toBeEnabled();
    expect(screen.getByText('変更予定：音の途切れにくさ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /標準.*配信・会話向け/ }));
    expect(save).toBeDisabled();
});

it('停止中の変更なしでも明示開始できる', async () => {
    render(<AudioSettingsModal isOpen isAudioRunning={false} currentConfig={config} onClose={vi.fn()} onConfigChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: '保存して開始' })).toBeEnabled();
});

it('IDなしASIO設定の入力ペア変更で未適用の接続先まで保存せず、接続先の適用を続けられる', async () => {
    const applied: AudioPreferences = { host: 'ASIO', input: 'Device A', output: 'Device A', sampleRate: 48000, bufferSize: 512, inputChannels: [0, 1] };
    localStorage.setItem('vst_host_audio_config', JSON.stringify(applied));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return {
            inputs: ['Device A', 'Device B'].map(name => ({ name, host: 'ASIO', channels: 4 })),
            outputs: ['Device A', 'Device B'].map(name => ({ name, host: 'ASIO', channels: 4 })),
        };
        if (command === 'get_autostart_status') return { enabled: false };
        return null;
    });
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 4 });
    const changed = vi.fn();
    function Parent() {
        const [current, setCurrent] = useState(applied);
        return <AudioSettingsModal isOpen isAudioRunning currentConfig={current} currentInputChannels={current.inputChannels}
            onClose={vi.fn()} onConfigChange={update => {
                changed(update);
                setCurrent(previous => ({ ...previous, ...update }));
            }} />;
    }
    render(<Parent />);
    const input = await screen.findByRole('combobox', { name: 'マイク入力' });
    await waitFor(() => expect(input).toHaveValue('Device A'));
    const save = screen.getByRole('button', { name: '保存して再起動' });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Device B' } });
    fireEvent.click(screen.getByRole('radio', { name: '入力チャンネル 3/4' }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(changed).toHaveBeenLastCalledWith({ host: 'ASIO', inputChannels: [2, 3] });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(start).toHaveBeenCalledWith('ASIO', 'Device B', 'Device B', 512, 48000, undefined, undefined));
});

it('設定画面内で開始後の反映に失敗しても、稼働中の同じ設定を再試行できる', async () => {
    const change = vi.fn().mockRejectedValueOnce(new Error('storage failed')).mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const props = { isOpen: true, currentConfig: config, onClose: vi.fn(), onConfigChange: change };
    const view = render(<AudioSettingsModal {...props} isAudioRunning={false} />);
    fireEvent.click(await screen.findByRole('button', { name: '保存して開始' }));
    await screen.findByRole('button', { name: '設定に戻って再試行' });
    view.rerender(<AudioSettingsModal {...props} isAudioRunning />);
    fireEvent.click(screen.getByRole('button', { name: '設定に戻って再試行' }));
    const retry = await screen.findByRole('button', { name: '保存して再起動' });
    expect(retry).toBeEnabled();
    expect(retry).toHaveAccessibleDescription(/設定の反映を再試行します/);
    fireEvent.click(retry);
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
});

it('3択にない256サンプルは数値指定として開き、選択状態を公開する', async () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ ...config, bufferSize: 256 }));
    render(<AudioSettingsModal isOpen currentBufferSize={256} initialSection="audioTuning" onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const numeric = await screen.findByRole('button', { name: '数値で指定' });
    await waitFor(() => expect(numeric).toHaveAttribute('aria-pressed', 'true'));
    expect(numeric).toHaveClass('border-selection');
    expect(screen.getByRole('button', { name: 'おまかせ' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('combobox', { name: 'バッファサイズ' })).toHaveValue('256');
});

it.each(['numeric', 'glitch'] as const)('%sの条件では途切れ設定を開く', async reason => {
    if (reason === 'numeric') localStorage.setItem('vst_host_beginner_mode', 'false');
    else vi.spyOn(audioApi, 'getEngineRuntimeStats').mockResolvedValue({ glitchCount: 1 } as EngineRuntimeStats);
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const summary = await screen.findByText('音の途切れ・周波数', { exact: false, selector: 'summary' });
    await waitFor(() => expect(summary.closest('details')).toHaveAttribute('open'));
});

it('通常は現在値付きで閉じ、再検出の操作領域を確保する', async () => {
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const summary = await screen.findByText('音の途切れ・周波数', { exact: false, selector: 'summary' });
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(summary).toHaveTextContent('標準 · 48 kHz');
    expect(screen.getByRole('button', { name: '再検出' })).toHaveClass('min-h-6');
});
