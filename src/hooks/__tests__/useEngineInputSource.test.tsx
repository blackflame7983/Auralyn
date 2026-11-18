import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type AudioStateInfo } from '../../api/audio';
import type { InputSource } from '../../lib/inputSource';
import { useEngineInputSource } from '../useEngineInputSource';

const app: InputSource = { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Game', rawEndpointId: 'endpoint', purpose: 'voice' } };
const device: InputSource = { kind: 'device', config: { purpose: 'voice' } };
const state = (input_source: InputSource | undefined, is_running = true): AudioStateInfo => ({
    is_running, config: { host: 'WASAPI', input: null, output: null, sample_rate: 48000, buffer_size: 512, input_source },
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each([
    { name: 'アプリの音声で稼働中', running: true, source: app, expected: 'process_loopback' },
    { name: '機器入力で稼働中', running: true, source: device, expected: 'device' },
    { name: '入力元を報告しない旧い応答', running: true, source: undefined, expected: undefined },
])('エンジンが実際に使っている入力元を公開する：$name', async ({ running, source, expected }) => {
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue(state(source));
    const { result } = renderHook(() => useEngineInputSource(running));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current?.kind).toBe(expected);
});

it('止まっているあいだは状態を問い合わせず、実際の入力元も持ち越さない', async () => {
    const read = vi.spyOn(audioApi, 'getAudioState').mockResolvedValue(state(app));
    const { result, rerender } = renderHook(({ running }) => useEngineInputSource(running), { initialProps: { running: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current?.kind).toBe('process_loopback');
    rerender({ running: false });
    expect(result.current).toBeUndefined();
    read.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(read).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();
});

it('入力が途中でアプリの音声へ変わったら、次の確認で追従する', async () => {
    const read = vi.spyOn(audioApi, 'getAudioState').mockResolvedValue(state(device));
    const { result } = renderHook(() => useEngineInputSource(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current?.kind).toBe('device');
    read.mockResolvedValue(state(app));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(result.current?.kind).toBe('process_loopback');
});

it('状態を取得できないときは、前の値を信じず未確認に戻す', async () => {
    const read = vi.spyOn(audioApi, 'getAudioState').mockResolvedValue(state(app));
    const { result } = renderHook(() => useEngineInputSource(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(result.current?.kind).toBe('process_loopback');
    read.mockRejectedValue(new Error('取得失敗'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(result.current).toBeUndefined();
});
