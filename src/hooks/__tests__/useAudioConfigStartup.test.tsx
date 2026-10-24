import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { StrictMode } from 'react';
import { toast } from 'sonner';
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
const config = { host: 'ASIO', input: 'selected', output: 'selected', sampleRate: 96000, bufferSize: 512, inputChannels: [6, 7] };
const state = { is_running: true, config: { host: 'ASIO', sample_rate: 96000, buffer_size: 512 } };
const running = { running: true, streamFailed: false };
const attached = { outcome: 'attached', initialPage: false, error: null };
let callbacks: Map<string, ((event: { payload: unknown }) => void)[]>;
const notify = (name: string, payload: unknown = null) => act(() => callbacks.get(name)?.forEach(callback => callback({ payload })));
function deferred() {
    let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
    localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
    localStorage.setItem('vst_host_input_gain', '35'); localStorage.setItem('vst_host_output_gain', '30');
    callbacks = new Map(); vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockImplementation(async (event, callback) => {
        callbacks.set(event, [...(callbacks.get(event) ?? []), callback as (event: { payload: unknown }) => void]); return () => {};
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
function native(extra?: (command: string) => unknown) {
    vi.mocked(invoke).mockImplementation(async command => {
        const value = extra?.(command); if (value !== undefined) return value;
        if (command === 'audio_frontend_bootstrap') return attached;
        if (command === 'get_audio_state') return state;
        if (command === 'auto_gain') return running;
    });
}
function noLegacyMutation() {
    expect(vi.mocked(invoke).mock.calls.some(([command]) => ['start_audio', 'restart_audio_engine', 'set_input_channels', 'set_input_gain', 'set_output_gain'].includes(command))).toBe(false);
}
it('初回cold開始はsaved pairとgainを一つのnative要求へ渡し、通常Start/pairを送らない', async () => {
    native(command => command === 'audio_frontend_bootstrap' ? { outcome: 'started', initialPage: true, error: null } : undefined);
    const { useAudioConfig } = await import('../useAudioConfig'); const { result } = renderHook(() => useAudioConfig(vi.fn()));
    await waitFor(() => expect(result.current.isEngineRunning).toBe(true));
    expect(invoke).toHaveBeenCalledWith('audio_frontend_bootstrap', { request: { config, inputGain: .35, outputGain: .3 } });
    noLegacyMutation();
});
it.each(['running', 'stopped', 'failed', 'absent'])('同Hostの%s reloadは実unmount/remountとmodule再読込の両方でattachだけにする', async situation => {
    let seen = false; let starts = 0;
    native(command => {
        if (command === 'audio_frontend_bootstrap') { const initialPage = !seen; seen = true; if (initialPage) starts += 1; return { outcome: initialPage ? 'started' : 'attached', initialPage, error: null }; }
        if (command === 'get_audio_state') return situation === 'absent' ? { is_running: false, config: null } : state;
        if (command === 'auto_gain') return { running: situation === 'running', streamFailed: situation === 'failed' };
    });
    let hook = await import('../useAudioConfig'); const first = renderHook(() => hook.useAudioConfig(vi.fn())); await act(async () => {}); first.unmount();
    const second = renderHook(() => hook.useAudioConfig(vi.fn())); await act(async () => {}); second.unmount();
    vi.resetModules(); hook = await import('../useAudioConfig'); const third = renderHook(() => hook.useAudioConfig(vi.fn())); await act(async () => {});
    expect(starts).toBe(1); expect(third.result.current.isEngineRunning).toBe(situation === 'running'); noLegacyMutation();
});
it('Host新規作成相当のgate resetだけが新しい初回開始を許可する', async () => {
    let seen = false; let starts = 0;
    native(command => command === 'audio_frontend_bootstrap' ? (() => { const initialPage = !seen; seen = true; if (initialPage) starts++; return { outcome: initialPage ? 'started' : 'attached', initialPage, error: null }; })() : undefined);
    let hook = await import('../useAudioConfig'); const first = renderHook(() => hook.useAudioConfig(vi.fn())); await act(async () => {}); first.unmount();
    seen = false; vi.resetModules(); hook = await import('../useAudioConfig'); renderHook(() => hook.useAudioConfig(vi.fn())); await act(async () => {});
    expect(starts).toBe(2); noLegacyMutation();
});
it('移行確認待ちはbootstrapにもStartにも進まない', async () => {
    localStorage.setItem('vst_host_migration_review_required', 'true'); native();
    const { useAudioConfig } = await import('../useAudioConfig'); const open = vi.fn();
    const { result } = renderHook(() => useAudioConfig(vi.fn(), open));
    await waitFor(() => expect(result.current.isInitializing).toBe(false)); expect(open).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith('audio_frontend_bootstrap', expect.anything()); noLegacyMutation();
});
it.each(['audio-stopped', 'audio-error', 'audio-stream-error'])('遅いbootstrap応答より%sを優先し、稼働表示や旧setterを復活させない', async event => {
    const held = deferred(); native(command => command === 'audio_frontend_bootstrap' ? held.promise : command === 'get_audio_state' ? { is_running: false, config: null } : undefined);
    const { useAudioConfig } = await import('../useAudioConfig'); const { result } = renderHook(() => useAudioConfig(vi.fn())); await act(async () => {});
    notify(event); await act(async () => held.resolve({ outcome: 'attached', initialPage: false, error: null }));
    expect(result.current.isEngineRunning).toBe(false); expect(toast.success).not.toHaveBeenCalled(); noLegacyMutation();
});
function holdInitialRead(stage: 'state' | 'stream') {
    const held = deferred(); let states = 0, streams = 0;
    native(command => {
        if (command === 'get_audio_state') { states++; if (states === 1) return { is_running: false, config: null }; return stage === 'state' && states === 2 ? held.promise : state; }
        if (command === 'auto_gain') { streams++; return stage === 'stream' && streams === 1 ? held.promise : running; }
    });
    return { held, pending: () => stage === 'state' ? states >= 2 : streams >= 1 };
}
it.each(['state', 'stream'] as const)('warmup通知と重なる古い%s応答は取り直し、pairはnative一要求だけにする', async stage => {
    const { held, pending } = holdInitialRead(stage);
    const { useAudioConfig } = await import('../useAudioConfig'); const { result } = renderHook(() => useAudioConfig(vi.fn()));
    await waitFor(() => expect(pending()).toBe(true)); notify('audio-started', { sample_rate: 96000, buffer_size: 512 });
    await act(async () => held.resolve(stage === 'state' ? state : running));
    await waitFor(() => expect(result.current.isEngineRunning).toBe(true));
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'audio_frontend_bootstrap')).toHaveLength(1); noLegacyMutation();
});
it.each(['state', 'stream'] as const)('古い%s取得失敗を新しい開始通知で失効させる', async stage => {
    const { held, pending } = holdInitialRead(stage); const { useAudioConfig } = await import('../useAudioConfig');
    const { result } = renderHook(() => useAudioConfig(vi.fn())); await waitFor(() => expect(pending()).toBe(true));
    notify('audio-started', { sample_rate: 96000, buffer_size: 512 }); await act(async () => held.reject(new Error('retired request')));
    await waitFor(() => expect(result.current.isEngineRunning).toBe(true)); expect(toast.error).not.toHaveBeenCalled(); noLegacyMutation();
});
it.each((['state', 'stream'] as const).flatMap(stage => ['audio-stopped', 'audio-error', 'audio-stream-error'].map(event => ({ stage, event }))))('初期$stage待機の$event後にStart通知が来ても旧初期化を再開しない', async ({ stage, event }) => {
    const { held, pending } = holdInitialRead(stage); const { useAudioConfig } = await import('../useAudioConfig');
    renderHook(() => useAudioConfig(vi.fn())); await waitFor(() => expect(pending()).toBe(true));
    notify(event); notify('audio-started', { sample_rate: 96000, buffer_size: 512 }); await act(async () => held.resolve(stage === 'state' ? state : running));
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'audio_frontend_bootstrap')).toHaveLength(1); noLegacyMutation();
});
it('状態変更が続くsnapshotは最大3回で打切り、bootstrapを再送しない', async () => {
    let states = 0; const pending: ReturnType<typeof deferred>[] = [];
    native(command => { if (command !== 'get_audio_state') return undefined; states++; if (states === 1) return { is_running: false, config: null }; const held = deferred(); pending.push(held); return held.promise; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useAudioConfig } = await import('../useAudioConfig'); const { result } = renderHook(() => useAudioConfig(vi.fn()));
    for (let i = 0; i < 3; i++) { await waitFor(() => expect(pending).toHaveLength(i + 1)); notify('audio-started', { sample_rate: 96000, buffer_size: 512 }); await act(async () => pending[i].resolve(state)); }
    await waitFor(() => expect(result.current.isInitializing).toBe(false)); expect(states).toBe(4); expect(warn).toHaveBeenCalledOnce(); noLegacyMutation();
});
it('StrictModeはpending bootstrapを一度だけ共有し、完了前に保存gainを書き換えない', async () => {
    const held = deferred(); native(command => command === 'audio_frontend_bootstrap' ? held.promise : undefined);
    const { useAudioConfig } = await import('../useAudioConfig'); renderHook(() => useAudioConfig(vi.fn()), { wrapper: StrictMode });
    await act(async () => {}); expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'audio_frontend_bootstrap')).toHaveLength(1);
    expect(localStorage.getItem('vst_host_output_gain')).toBe('30'); await act(async () => held.resolve(attached)); noLegacyMutation();
});
it('warmup失敗は手動開始案内を表示し、自動再送しない', async () => {
    native(command => command === 'audio_frontend_bootstrap' ? { outcome: 'inactive', initialPage: true, error: '設定から明示的に再開してください' } : undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {}); const { useAudioConfig } = await import('../useAudioConfig'); renderHook(() => useAudioConfig(vi.fn()));
    await waitFor(() => expect(toast.error).toHaveBeenCalled()); expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'audio_frontend_bootstrap')).toHaveLength(1); noLegacyMutation();
});

it('世代が安定したsnapshot取得失敗は再試行せず手動確認へ案内する', async () => {
    const { held, pending } = holdInitialRead('state');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { useAudioConfig } = await import('../useAudioConfig'); const { result } = renderHook(() => useAudioConfig(vi.fn()));
    await waitFor(() => expect(pending()).toBe(true)); await act(async () => held.reject(new Error('current snapshot failure')));
    expect(result.current.isEngineRunning).toBe(false); expect(toast.error).toHaveBeenCalledOnce();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'get_audio_state')).toHaveLength(2);
    noLegacyMutation();
});
