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

it.each(['channels', 'save'] as const)('システム再起動の%s失敗から接続画面で再試行してVST復元まで完了する', async stage => {
    const restart = vi.spyOn(audioApi, 'restart').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const start = vi.spyOn(audioApi, 'start');
    const channels = vi.spyOn(audioApi, 'setInputChannels').mockResolvedValue(undefined);
    if (stage === 'channels') restart.mockRejectedValueOnce(new Error('input setting failed'));
    const save = vi.fn().mockResolvedValue(undefined);
    if (stage === 'save') save.mockRejectedValueOnce(new Error('storage failed'));
    const restored = vi.fn().mockResolvedValue(undefined);
    const closed = vi.fn();
    render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={closed} onConfigChange={save} onEngineRestarted={restored} />);
    await screen.findByRole('button', { name: '保存して再起動' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'システム' }), { button: 0, ctrlKey: false });
    const button = await screen.findByRole('button', { name: '音声処理を再起動' });
    await waitFor(() => expect(button).toBeEnabled());
    button.focus();
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: '再起動する' }));
    await screen.findByText(stage === 'channels' ? /input setting failed/ : /storage failed/);
    fireEvent.click(await screen.findByRole('button', { name: '設定に戻って再試行' }));
    const retry = await screen.findByRole('button', { name: '保存して再起動' });
    expect(retry).toBeEnabled();
    expect(restored).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(restart).toHaveBeenCalledTimes(stage === 'channels' ? 2 : 1);
    expect(start).not.toHaveBeenCalled();
    expect(channels).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(stage === 'save' ? 2 : 1);
    expect(restored).toHaveBeenCalledOnce();
});

it.each(['ASIO', 'Wasapi'])('別hostのプリセットで先頭以外の入出力を復元する（変更前=%s）', async previousHost => {
    const targetHost = previousHost === 'ASIO' ? 'Wasapi' : 'ASIO';
    const items = ['ASIO', 'Wasapi'].flatMap(host => [1, 2].map(index => ({
        host, name: `${host} device ${index}`, id: `${host}-${index}`, channels: 4,
    })));
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: previousHost, input: `${previousHost} device 1`, output: `${previousHost} device 1`, sampleRate: 48000, bufferSize: 512 }));
    localStorage.setItem('vst_host_audio_presets', JSON.stringify({ target: {
        host: targetHost, input: `${targetHost} device 2`, output: `${targetHost} device 2`, sampleRate: 48000, bufferSize: 512,
    } }));
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return { inputs: items, outputs: items };
        if (command === 'get_autostart_status') return { enabled: false };
        return null;
    });
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    render(<AudioSettingsModal isOpen onClose={vi.fn()} onConfigChange={vi.fn()} />);
    const input = await screen.findByRole('combobox', { name: 'マイク入力' });
    await waitFor(() => expect(input).toHaveValue(`id:${previousHost}-1`));
    fireEvent.change(screen.getByRole('combobox', { name: '入出力プリセット' }), { target: { value: 'target' } });
    await waitFor(() => expect(input).toHaveValue(`id:${targetHost}-2`));
    fireEvent.click(screen.getByRole('button', { name: '保存して開始' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(targetHost, `${targetHost} device 2`, `${targetHost} device 2`, 512, 48000, `${targetHost}-2`, `${targetHost}-2`, undefined, expect.objectContaining({ outputRouting: expect.any(Object) }), { source: { kind: "device", config: { purpose: "voice" } } }));
});

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

it.each([false, true])('入力ペアの下書きだけでは保存せず、明示適用後に接続先とともに保存する（機器変更=%s）', async changeDevice => {
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
            onClose={vi.fn()} onConfigChange={(update, options) => {
                changed(update, options);
                setCurrent(previous => ({ ...previous, ...update }));
            }} />;
    }
    render(<Parent />);
    const input = await screen.findByRole('combobox', { name: 'マイク入力' });
    await waitFor(() => expect(input).toHaveValue('Device A'));
    const save = screen.getByRole('button', { name: '保存して再起動' });
    expect(save).toBeDisabled();
    if (changeDevice) fireEvent.change(input, { target: { value: 'Device B' } });
    fireEvent.click(screen.getByRole('radio', { name: '入力チャンネル 3/4' }));
    expect(changed).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(save).toBeEnabled();
    fireEvent.click(save);
    const selected = changeDevice ? 'Device B' : 'Device A';
    await waitFor(() => expect(start).toHaveBeenCalledWith('ASIO', selected, selected, 512, 48000, undefined, undefined, undefined, expect.objectContaining({ inputChannels: [2, 3] }), { source: { kind: "device", config: { purpose: "voice" } } }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ host: 'ASIO', input: selected, output: selected, inputChannels: [2, 3] }), { audioStarted: true }));
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
