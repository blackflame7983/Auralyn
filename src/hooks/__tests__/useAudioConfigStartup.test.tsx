import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const config = { host: 'Wasapi', sample_rate: 48000, buffer_size: 512 };
let callbacks: Map<string, ((event: { payload: unknown }) => void)[]>;
const notify = (name: string, payload: unknown = null) => act(() => callbacks.get(name)?.forEach(callback => callback({ payload })));

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem('vst_host_wizard_done', 'true');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi', sampleRate: 48000, bufferSize: 512 }));
    callbacks = new Map();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockImplementation(async (event, callback) => {
        callbacks.set(event, [...(callbacks.get(event) ?? []), callback as (event: { payload: unknown }) => void]);
        return () => {};
    });
});
afterEach(() => { cleanup(); localStorage.clear(); });

it('移行後は設定確認へ進み、保存されたデバイスで自動開始しない', async () => {
    localStorage.setItem('vst_host_migration_review_required', 'true');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'selected-asio', output: 'selected-asio', sampleRate: 96000, bufferSize: 512, inputChannels: [6, 7] }));
    const { useAudioConfig } = await import('../useAudioConfig');
    const open = vi.fn();
    const { result } = renderHook(() => useAudioConfig(vi.fn(), open));
    await waitFor(() => expect(result.current.isInitializing).toBe(false));
    expect(open).toHaveBeenCalledOnce();
    expect(result.current.audioConfig).toMatchObject({ host: 'ASIO', inputChannels: [6, 7] });
    expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    act(() => result.current.handleConfigUpdate({ host: 'Wasapi' }));
    expect(localStorage.getItem('vst_host_migration_review_required')).toBe('true');
    act(() => result.current.handleConfigUpdate({ host: 'Wasapi' }, { audioStarted: true }));
    expect(localStorage.getItem('vst_host_migration_review_required')).toBeNull();
});

it.each(['audio-stopped', 'audio-error', 'audio-stream-error'])('起動時の状態取得中に %s が届いたら、古い稼働応答を反映しない', async event => {
    let finish!: (value: unknown) => void;
    const stream = new Promise(resolve => { finish = resolve; });
    vi.mocked(invoke).mockImplementation(async command => command === 'get_audio_state'
        ? { is_running: true, config } : command === 'auto_gain' ? stream : undefined);
    const { useAudioConfig } = await import('../useAudioConfig');
    const { result } = renderHook(() => useAudioConfig(vi.fn()));
    await act(async () => {});
    notify(event);
    await act(async () => { finish({ running: true, streamFailed: false }); });
    expect(result.current.isEngineRunning).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('set_input_channels', expect.anything());
});

it('停止通知後の古い未稼働応答から、自動起動をやり直さない', async () => {
    let finish!: (value: unknown) => void;
    const state = new Promise(resolve => { finish = resolve; });
    vi.mocked(invoke).mockImplementation(async command => command === 'get_audio_state'
        ? state : { running: false, streamFailed: false });
    const { useAudioConfig } = await import('../useAudioConfig');
    renderHook(() => useAudioConfig(vi.fn()));
    await act(async () => {});
    notify('audio-stopped');
    await act(async () => { finish({ is_running: false, config: null }); });
    expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
});

it.each([false, true])('起動要求の応答前に停止した場合だけ稼働表示を戻さない: 停止=%s', async stopped => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_state') return { is_running: true, config: null };
        if (command === 'auto_gain') return { running: false, streamFailed: false };
        if (command === 'start_audio') return new Promise(resolve => { finish = resolve; });
    });
    const { useAudioConfig } = await import('../useAudioConfig');
    const { result } = renderHook(() => useAudioConfig(vi.fn()));
    await waitFor(() => expect(finish).toBeDefined());
    notify('audio-started', { sample_rate: 44100, buffer_size: 256 });
    if (stopped) notify('audio-stopped');
    await act(async () => { finish({ sample_rate: 44100, buffer_size: 256, channels: 2 }); });
    expect(result.current.isEngineRunning).toBe(!stopped);
    if (stopped) expect(invoke).not.toHaveBeenCalledWith('set_input_channels', expect.anything());
    else {
        expect(result.current.audioConfig.sampleRate).toBe(44100);
        expect(invoke).toHaveBeenCalledWith('set_input_channels', { left: 0, right: 1 });
    }
});
