import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAudioConfig } from '../useAudioConfig';
import { audioApi } from '../../api/audio';

const config = { host: 'Wasapi', sample_rate: 48000, buffer_size: 512 };
let callbacks: Map<string, (() => void)[]>;
beforeEach(() => {
    vi.spyOn(audioApi, 'frontendBootstrap').mockResolvedValue({ outcome: 'attached', initialPage: false, error: null });
    localStorage.clear();
    callbacks = new Map();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockImplementation(async (event, callback) => {
        callbacks.set(event, [...(callbacks.get(event) ?? []), callback as () => void]);
        return () => {};
    });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['cold', 'dead', 'pipe'])('常時状態pollの%sでStartを送らず、coldならstream照会も送らない', async situation => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_audio_state') return { is_running: situation !== 'cold', config };
        if (command === 'auto_gain') throw new Error('existing connection unavailable');
        throw new Error(`unexpected ${command}`);
    });
    const { result, unmount } = renderHook(() => useAudioConfig(vi.fn()));
    await act(async () => { await vi.advanceTimersByTimeAsync(6100); });
    expect(result.current.isEngineRunning).toBe(false);
    expect(result.current.engineProcessReady).toBe(situation === 'cold' ? false : null);
    expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith('restart_audio_engine', expect.anything());
    const requests = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'auto_gain');
    expect(requests.length).toBe(situation === 'cold' ? 0 : 4);
    unmount(); vi.useRealTimers();
});

it.each([
    [null, { running: false, streamFailed: false }, false],
    [config, { running: false, streamFailed: false }, false],
    [config, { running: true, streamFailed: true }, false],
    [config, { running: true, streamFailed: false }, true],
] as const)('常駐プロセスと実音声の稼働を区別する: %j %j', async (audioConfig, stream, running) => {
    vi.mocked(invoke).mockImplementation(async command => command === 'get_audio_state'
        ? { is_running: true, config: audioConfig } : stream);
    const { result } = renderHook(() => useAudioConfig(vi.fn()));
    await waitFor(() => expect(result.current.engineProcessReady).toBe(true));
    expect(result.current.isEngineRunning).toBe(running);
    expect(invoke).not.toHaveBeenCalledWith('start_audio', expect.anything());
    if (running) {
        act(() => callbacks.get('audio-stream-error')?.forEach(callback => callback()));
        expect(result.current.isEngineRunning).toBe(false);
    }
});

it('状態取得失敗を稼働中にせず、未確認として公開する', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('取得失敗'));
    const { result } = renderHook(() => useAudioConfig(vi.fn()));
    await act(async () => {});
    expect(result.current.engineProcessReady).toBeNull();
    expect(result.current.isEngineRunning).toBe(false);
});

it('停止通知より前に取得を始めた古い稼働状態で表示を戻さない', async () => {
    let resolveProcess!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async command => command === 'get_audio_state'
        ? new Promise(resolve => { resolveProcess = resolve; })
        : { running: true, streamFailed: false });
    const { result } = renderHook(() => useAudioConfig(vi.fn()));
    await act(async () => {});
    act(() => callbacks.get('audio-stopped')?.forEach(callback => callback()));
    await act(async () => { resolveProcess({ is_running: true, config }); });
    expect(result.current.isEngineRunning).toBe(false);
});
