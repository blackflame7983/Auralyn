import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioApi } from '@/api/audio';
import { message } from '@/i18n/messages';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { AudioSettingsModal } from '../AudioSettingsModal';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));

const voiceSource = { kind: 'device', config: { purpose: 'voice' } } as const;
const config = { host: 'Wasapi', input: 'Mic', output: 'Headphones', sampleRate: 48000, bufferSize: 512, inputSource: voiceSource };
const appRecord = {
    host: 'Wasapi', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512,
    inputSource: { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Player', rawEndpointId: 'endpoint', purpose: 'music' } },
} as const;
const candidate = { id: 'app-1', appKey: 'a'.repeat(64), name: 'Player', routes: [{ id: 'endpoint', name: 'Headphones', muted: false }] };
const devices = {
    inputs: [
        { host: 'Wasapi', name: 'Mic', channels: 2, is_input: true, is_default: true, index: 0 },
        { host: 'Wasapi', name: 'CABLE Output', channels: 2, is_input: true, is_default: false, index: 1 },
    ],
    outputs: [
        { host: 'Wasapi', name: 'Headphones', channels: 2, is_input: false, is_default: true, index: 0 },
        { host: 'Wasapi', name: 'USB Headphones', channels: 2, is_input: false, is_default: false, index: 1 },
    ],
};
const DISPLAY_KEY = 'auralyn_display_purpose';

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
    localStorage.setItem(DISPLAY_KEY, 'voice');
    localStorage.setItem('auralyn_usage_devices', JSON.stringify({ version: 1, voice: config, music: appRecord }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_devices') return devices;
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'get_engine_runtime_stats') return { noiseReductionEnabled: false, builtInEffectsEnabled: false };
        return null;
    });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });

it('アプリの音声の保存のあと、表示の保存に失敗しても、保留を残して表示の保存だけを再試行でき、成功したら音声と表示がそろう', async () => {
    vi.spyOn(audioApi, 'processInputSources').mockResolvedValue([candidate]);
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    const onClose = vi.fn();
    const onConfigChange = vi.fn(async (next: { inputSource?: unknown; host: string }) => {
        localStorage.setItem('vst_host_audio_config', JSON.stringify(next));
    });
    render(<AudioSettingsModal isOpen isAudioRunning currentConfig={config} onClose={onClose} onConfigChange={onConfigChange} onEngineRestarted={vi.fn(async () => 'completed' as const)} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'マイク' })).toHaveValue('Mic'));
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: '使い道を切り替えます' })).getByRole('button', { name: '切り替える' }));
    const app = await screen.findByRole('combobox', { name: message('ja', 'processInput.app') });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Player' })).toBeInTheDocument());
    fireEvent.change(app, { target: { value: 'app-1' } });
    const save = screen.getByRole('button', { name: '接続を保存して再起動' });
    await waitFor(() => expect(save).toBeEnabled());

    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
        if (key === DISPLAY_KEY) throw new Error('容量不足');
        return original.call(this, key, value);
    };
    try {
        fireEvent.click(save);
        await screen.findByText(message('ja', 'purpose.commitFailed', { reason: '容量不足' }));
    } finally { Storage.prototype.setItem = original; }
    expect(start).toHaveBeenCalledOnce();
    expect(readDisplayPurpose()).toBe('voice');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ inputSource: { kind: 'process_loopback' } });
    expect(onClose).not.toHaveBeenCalled();

    // 再試行できる。接続は保存済みなので、音声を開始し直さず、表示だけを確定する。
    const retry = screen.getByRole('button', { name: '接続を保存して再起動' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(start).toHaveBeenCalledOnce();
    expect(readDisplayPurpose()).toBe('music');
    expect(JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}')).toMatchObject({ inputSource: { kind: 'process_loopback', config: { purpose: 'music' } } });
    expect((JSON.parse(localStorage.getItem('auralyn_usage_devices') ?? '{}') as { voice?: unknown }).voice).toMatchObject({ input: 'Mic', inputSource: voiceSource });
});
