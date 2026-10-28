import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { LocaleProvider } from '../../i18n/LocaleProvider';
import { createLocaleStore } from '../../i18n/locale';
import { useAudioConfig } from '../useAudioConfig';
import { useAudioRecovery } from '../useAudioRecovery';
import { useAppEvents } from '../useAppEvents';
import { useObsUsage } from '../useObsUsage';
import { audioApi } from '../../api/audio';
import { obsApi } from '../../api/obs';
import { liveModesApi } from '../../api/liveModes';
import type { ReactNode } from 'react';

const windowMock = vi.hoisted(() => ({ onDragDropEvent: vi.fn(async (_callback: unknown) => () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowMock }));
vi.mock('../useLiveSceneRouting', () => ({ useLiveSceneRouting: vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));
let callbacks: Map<string, Array<(event: {payload: unknown}) => void>>;
const notify = (name: string, payload: unknown = '') => act(() => callbacks.get(name)?.forEach(callback => callback({payload})));
const config = {host: 'ASIO', input: 'actual mic', output: 'actual out', sampleRate: 48000, bufferSize: 512, inputChannels: [4, 5]};
function language() {
    const store = createLocaleStore(() => 'ja', () => true);
    return { store, wrapper: ({children}: {children: ReactNode}) => <LocaleProvider store={store}>{children}</LocaleProvider> };
}
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear(); callbacks = new Map();
    localStorage.setItem('vst_host_audio_config', JSON.stringify(config)); localStorage.setItem('vst_host_wizard_done', 'true');
    vi.mocked(listen).mockImplementation(async (name, callback) => { callbacks.set(name, [...(callbacks.get(name) ?? []), callback as (event: {payload: unknown}) => void]); return vi.fn<() => void>(); });
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.restoreAllMocks(); vi.useRealTimers(); });
it('初期bootstrap待機中の言語切替は同じ要求と保存値を保ち、失敗案内だけ現在の言語にする', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async command => command === 'audio_frontend_bootstrap' ? new Promise(resolve => {finish = resolve;}) : undefined);
    const {store, wrapper} = language(); const settings = vi.fn();
    renderHook(() => useAudioConfig(vi.fn(), settings), {wrapper}); await act(async () => {});
    const requests = vi.mocked(invoke).mock.calls.slice(); const raw = localStorage.getItem('vst_host_audio_config');
    act(() => {store.setLocale('en');}); expect(invoke).toHaveBeenCalledTimes(requests.length);
    await act(async () => finish({outcome: 'inactive', initialPage: true, error: 'access denied 0x80070005'}));
    expect(toast.error).toHaveBeenCalledWith('Could not start the audio engine', expect.objectContaining({description: expect.stringContaining('Windows microphone permissions'), action: expect.objectContaining({label: 'Settings'})}));
    expect(localStorage.getItem('vst_host_audio_config')).toBe(raw);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'audio_frontend_bootstrap')).toHaveLength(1);
    expect(vi.mocked(invoke).mock.calls.some(([command]) => ['start_audio', 'set_input_channels', 'set_input_gain', 'set_output_gain'].includes(command))).toBe(false);
});
it('復旧予約中の言語切替はtimerと購読を増やさず、raw Stream Errorを判定して1回だけ復旧する', async () => {
    vi.spyOn(liveModesApi, 'request').mockResolvedValue({armed: false} as Awaited<ReturnType<typeof liveModesApi.request>>);
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({sample_rate: 48000, buffer_size: 512, channels: 2});
    vi.spyOn(audioApi, 'setInputChannels').mockResolvedValue(undefined);
    const {store, wrapper} = language(); renderHook(() => useAudioRecovery(), {wrapper}); await act(async () => {});
    notify('audio-stream-error', 'Input Stream Error: actual device'); const subscriptions = vi.mocked(listen).mock.calls.length;
    act(() => {store.setLocale('en');}); await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(listen).toHaveBeenCalledTimes(subscriptions); expect(start).toHaveBeenCalledExactlyOnceWith('ASIO', 'actual mic', 'actual out', 512, 48000, undefined, undefined);
    expect(audioApi.setInputChannels).toHaveBeenCalledExactlyOnceWith(4, 5); expect(toast.success).toHaveBeenCalledWith('Audio engine reconnected');
});
it('drop購読と一度だけのtray通知を言語で作り直さず、実名/payload/エラーidentityを維持する', async () => {
    const {store, wrapper} = language(); const props = {onAddPlugin: vi.fn(async () => true), onResetPlugins: vi.fn(), onCrash: vi.fn(), onLoadPreset: vi.fn(async () => true)};
    renderHook(() => useAppEvents(props), {wrapper}); await act(async () => {});
    notify('minimized-to-tray'); const subscriptions = vi.mocked(listen).mock.calls.length;
    act(() => {store.setLocale('en');}); expect(listen).toHaveBeenCalledTimes(subscriptions); expect(windowMock.onDragDropEvent).toHaveBeenCalledOnce();
    notify('minimized-to-tray'); expect(toast.info).toHaveBeenCalledTimes(1);
    const drop = windowMock.onDragDropEvent.mock.calls[0][0] as (event: unknown) => void;
    act(() => drop({payload: {type: 'drop', paths: ['C:/plugins/実名.vst3', 'C:/実名.txt']}}));
    expect(toast.info).toHaveBeenCalledWith('Loading 実名…'); expect(props.onAddPlugin).toHaveBeenCalledWith(expect.objectContaining({name: '実名', path: 'C:/plugins/実名.vst3', category: 'Fx'}));
    notify('shortcut-error', 'Plugin not found: 実名'); expect(toast.error).toHaveBeenCalledWith('Could not apply the shortcut action', {description: 'Original detail (untranslated): Plugin not found: 実名'});
    notify('shortcut-error', {code: 'gainPending'});
    expect(toast.error).toHaveBeenLastCalledWith('Could not apply the shortcut action', {description: 'The gain adjustment is still being confirmed. Try the action again.'});
    notify('shortcut-error', {code: 'audioStateUnavailable'});
    expect(toast.error).toHaveBeenLastCalledWith('Could not apply the shortcut action', {description: 'Could not retrieve the audio state.'});
    notify('audio-error', 'Stream Error: raw'); expect(props.onCrash).toHaveBeenCalledWith('Stream Error: raw');
});
it('言語切替でOBS leaseを解放せず、最後の利用終了後だけ停止し、再試行も明示操作に限る', async () => {
    const disconnect = vi.spyOn(obsApi, 'disconnect').mockRejectedValue(new Error('raw OBS error'));
    const {store, wrapper} = language(); const hook = renderHook(({active}) => useObsUsage(active), {initialProps: {active: true}, wrapper});
    act(() => {store.setLocale('en');}); await act(async () => {}); expect(disconnect).not.toHaveBeenCalled();
    hook.rerender({active: false}); await act(async () => {});
    expect(disconnect).toHaveBeenCalledOnce(); expect(toast.error).toHaveBeenCalledWith('Could not confirm that the OBS connection stopped', expect.objectContaining({action: expect.objectContaining({label: 'Retry stopping'})}));
    const options = vi.mocked(toast.error).mock.calls[0][1] as unknown as {action: {onClick: () => void}};
    await act(async () => options.action.onClick()); expect(disconnect).toHaveBeenCalledTimes(2);
});
