import { act, cleanup, renderHook } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type AudioStateInfo } from '../../api/audio';
import type { InputSource } from '../../lib/inputSource';
import { useEngineInputSource } from '../useEngineInputSource';

const app: InputSource = { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Game', rawEndpointId: 'endpoint', purpose: 'voice' } };
const device: InputSource = { kind: 'device', config: { purpose: 'voice' } };
const state = (input_source: InputSource | undefined, is_running = true): AudioStateInfo => ({
    is_running, config: { host: 'WASAPI', input: null, output: null, sample_rate: 48000, buffer_size: 512, input_source },
});

/** 既存の状態確認（useAudioConfig の定期確認など）が1回行われたことにする。 */
async function pollOnce(reply: AudioStateInfo | Error) {
    vi.mocked(invoke).mockReset();
    if (reply instanceof Error) vi.mocked(invoke).mockRejectedValue(reply); else vi.mocked(invoke).mockResolvedValue(reply);
    await act(async () => { await audioApi.getAudioState().catch(() => undefined); });
}

beforeEach(() => { vi.mocked(invoke).mockReset(); });
afterEach(async () => {
    cleanup();
    vi.mocked(invoke).mockResolvedValue(state(undefined, false));
    await audioApi.getAudioState();
    vi.restoreAllMocks();
});

it.each([
    { name: 'アプリの音声で稼働中', source: app, expected: 'process_loopback' },
    { name: '機器入力で稼働中', source: device, expected: 'device' },
    { name: '入力元を報告しない旧い応答', source: undefined, expected: undefined },
])('エンジンが実際に使っている入力元を、既存の状態確認の応答から公開する：$name', async ({ source, expected }) => {
    const { result } = renderHook(() => useEngineInputSource(true));
    await pollOnce(state(source));
    expect(result.current?.kind).toBe(expected);
});

it('この hook は問い合わせを出さない', async () => {
    renderHook(() => useEngineInputSource(true));
    await act(async () => {});
    expect(invoke).not.toHaveBeenCalled();
});

it('止まっているあいだは実際の入力元を持ち越さず、再開後は最初の応答まで未確認にする', async () => {
    const { result, rerender } = renderHook(({ running }) => useEngineInputSource(running), { initialProps: { running: true } });
    await pollOnce(state(app));
    expect(result.current?.kind).toBe('process_loopback');
    rerender({ running: false });
    expect(result.current).toBeUndefined();
    rerender({ running: true });
    expect(result.current).toBeUndefined();
    await pollOnce(state(device));
    expect(result.current?.kind).toBe('device');
});

it('止まる前に出した確認の応答が止まったあとに届いても、再開時の入力元として使わない', async () => {
    const { result, rerender } = renderHook(({ running }) => useEngineInputSource(running), { initialProps: { running: true } });
    let reply: (value: AudioStateInfo) => void = () => {};
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockReturnValue(new Promise<AudioStateInfo>(resolve => { reply = resolve; }));
    let late: Promise<unknown> = Promise.resolve();
    act(() => { late = audioApi.getAudioState(); });
    rerender({ running: false });
    await act(async () => { reply(state(app)); await late; });
    rerender({ running: true });
    expect(result.current).toBeUndefined();
    await pollOnce(state(device));
    expect(result.current?.kind).toBe('device');
});

it('入力が途中でアプリの音声へ変わったら、次の確認で追従する', async () => {
    const { result } = renderHook(() => useEngineInputSource(true));
    await pollOnce(state(device));
    expect(result.current?.kind).toBe('device');
    await pollOnce(state(app));
    expect(result.current?.kind).toBe('process_loopback');
});

it('エンジンが止まったと報告されたら、未確認に戻す', async () => {
    const { result } = renderHook(() => useEngineInputSource(true));
    await pollOnce(state(app));
    await pollOnce(state(app, false));
    expect(result.current).toBeUndefined();
});

it('状態を取得できないときは、前の値を信じず未確認に戻す', async () => {
    const { result } = renderHook(() => useEngineInputSource(true));
    await pollOnce(state(app));
    expect(result.current?.kind).toBe('process_loopback');
    await pollOnce(new Error('取得失敗'));
    expect(result.current).toBeUndefined();
});

it('同じ入力元の応答が続いても、画面を更新し直さない', async () => {
    let renders = 0;
    renderHook(() => { renders += 1; return useEngineInputSource(true); });
    await pollOnce(state(app));
    const after = renders;
    await pollOnce(state({ ...app, config: { ...app.config } }));
    expect(renders).toBe(after);
});
