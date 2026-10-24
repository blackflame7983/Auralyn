import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppEvents } from '../useAppEvents';
import { MasterBar } from '../../components/layout/MasterBar';
import { audioApi } from '../../api/audio';
vi.mock('../useAudioRecovery', () => ({ useAudioRecovery: () => {} }));
vi.mock('../useLiveSceneRouting', () => ({ useLiveSceneRouting: () => {} }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() } }));
let callbacks: Map<string, Array<(event: { payload: unknown }) => void>>;
const props = { onAddPlugin: vi.fn(), onResetPlugins: vi.fn(), onCrash: vi.fn(), onLoadPreset: vi.fn() };
const intent = { generation: '7', revision: 12, gain: .6 };
const observed = (overrides = {}) => ({ generation: '7', state: { revision: 12, gain: .6, confirmedGain: .6, running: true, settled: true, streamFailed: false }, ...overrides });
const notify = (name: string, payload: unknown) => act(() => callbacks.get(name)?.forEach(callback => callback({ payload })));
beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); localStorage.setItem('vst_host_output_gain', '30'); callbacks = new Map(); vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockImplementation(async (name, callback) => { callbacks.set(name, [...(callbacks.get(name) ?? []), callback as (event: { payload: unknown }) => void]); return () => {}; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('稼働中hotkeyは同世代/revision/targetのsettled確認後だけ保存する', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(observed({ state: { ...observed().state, settled: false } })).mockResolvedValue(observed());
    renderHook(() => useAppEvents(props)); await act(async () => {}); notify('shortcut-output-gain', intent); await act(async () => {});
    expect(localStorage.getItem('vst_host_output_gain')).toBe('30');
    await act(() => vi.advanceTimersByTimeAsync(100)); expect(localStorage.getItem('vst_host_output_gain')).toBe('60');
});
it.each(['generation', 'revision', 'target', 'stopped'])('hotkey確認の%s不一致は未確認の値を保存しない', async changed => {
    const response = observed(); if (changed === 'generation') response.generation = '8';
    if (changed === 'revision') response.state.revision = 13;
    if (changed === 'target') response.state.gain = .8;
    if (changed === 'stopped') response.state.running = false;
    vi.mocked(invoke).mockResolvedValue(response); renderHook(() => useAppEvents(props)); await act(async () => {});
    notify('shortcut-output-gain', intent); await act(async () => {}); expect(localStorage.getItem('vst_host_output_gain')).toBe('30');
});
it.each(['slider', 'start', 'stop', 'unmount'])('遅い旧hotkey応答を%s後へ保存しない', async action => {
    let finish!: (value: unknown) => void; vi.mocked(invoke).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const hook = renderHook(() => useAppEvents(props)); await act(async () => {}); notify('shortcut-output-gain', intent); await act(async () => {});
    if (action === 'slider') { act(() => window.dispatchEvent(new Event('output-gain-intent'))); localStorage.setItem('vst_host_output_gain', '80'); }
    else if (action === 'unmount') hook.unmount(); else notify(action === 'start' ? 'audio-started' : 'audio-stopped', {});
    await act(async () => finish(observed())); expect(localStorage.getItem('vst_host_output_gain')).toBe(action === 'slider' ? '80' : '30');
});
it('連続hotkeyは新しい要求だけを保存する', async () => {
    let finish!: (value: unknown) => void; vi.mocked(invoke).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue(observed({ state: { ...observed().state, revision: 13, gain: .7, confirmedGain: .7 } }));
    renderHook(() => useAppEvents(props)); await act(async () => {}); notify('shortcut-output-gain', intent); await act(async () => {});
    notify('shortcut-output-gain', { ...intent, revision: 13, gain: .7 }); await act(async () => finish(observed()));
    expect(localStorage.getItem('vst_host_output_gain')).toBe('70');
});

it('実slider入力は30msの送信待ち中でも旧hotkey確認を失効させる', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    vi.spyOn(audioApi, 'getEngineRuntimeStats').mockRejectedValue(new Error('stats unavailable'));
    let gain = .3;
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'get_output_gain_observation') return new Promise(resolve => { finish = resolve; });
        if (command === 'set_output_gain') { gain = .31; return; }
        return { ...observed().state, gain, confirmedGain: gain };
    });
    const App = () => { useAppEvents(props); return <MasterBar isRunning />; };
    render(<App />); await act(async () => {});
    notify('shortcut-output-gain', intent); await act(async () => {});
    const slider = screen.getByRole('slider', { name: '出力ゲイン' });
    slider.focus(); fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await act(async () => finish(observed()));
    expect(slider).toHaveAttribute('aria-valuenow', '31');
    expect(localStorage.getItem('vst_host_output_gain')).toBe('30');
    expect(invoke).not.toHaveBeenCalledWith('set_output_gain', expect.anything());
    await act(() => vi.advanceTimersByTimeAsync(30));
    expect(localStorage.getItem('vst_host_output_gain')).toBe('31');
    expect(slider).toHaveAttribute('aria-valuenow', '31');
    vi.unstubAllGlobals();
});
