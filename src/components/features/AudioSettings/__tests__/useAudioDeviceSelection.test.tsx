import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type AudioDeviceList } from '../../../../api/audio';
import { listen } from '@tauri-apps/api/event';
import { useAudioDeviceSelection } from '../useAudioDeviceSelection';

const devices = (name: string, input = true): AudioDeviceList => ({
    inputs: input ? [{ name, host: 'Wasapi', channels: 2, index: 0, is_input: true, is_default: true }] : [],
    outputs: [{ name: 'out', host: 'Wasapi', channels: 2, index: 1, is_input: false, is_default: true }],
});
beforeEach(() => { localStorage.clear(); vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([2, 64])('音声開始後に%iチャンネルの実能力を取得し、閉じた後は開始通知で再検出しない', async channels => {
    const input = { name: 'Insert ASIO', host: 'ASIO', id: 'asio:Insert ASIO', channels: 0, index: 0, is_input: true, is_default: false };
    const getDevices = vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [input], outputs: [{ ...input, is_input: false }] });
    const { result, rerender } = renderHook(({ isOpen }) => useAudioDeviceSelection({ isOpen, onError: vi.fn() }), { initialProps: { isOpen: true } });
    await waitFor(() => expect(result.current.activeDevice?.channels).toBe(0));
    getDevices.mockResolvedValue({ inputs: [{ ...input, channels }], outputs: [{ ...input, is_input: false, channels }] });
    const started = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-started')![1];
    act(() => started({ event: 'audio-started', id: 1, payload: {} }));
    await waitFor(() => expect(result.current.activeDevice?.channels).toBe(channels));
    expect(getDevices).toHaveBeenLastCalledWith(true);
    rerender({ isOpen: false });
    const calls = getDevices.mock.calls.length;
    act(() => started({ event: 'audio-started', id: 2, payload: {} }));
    expect(getDevices).toHaveBeenCalledTimes(calls);
});

it('登録名だけのキャッシュで開き直しても稼働中の機器の能力を取得する', async () => {
    const input = { name: 'Insert ASIO', host: 'ASIO', id: 'asio:Insert ASIO', channels: 0, index: 0, is_input: true, is_default: false };
    localStorage.setItem('vst_host_cached_devices', JSON.stringify({ inputs: [input], outputs: [{ ...input, is_input: false }] }));
    const getDevices = vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [{ ...input, channels: 2 }], outputs: [{ ...input, is_input: false, channels: 2 }] });
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError: vi.fn() }));
    await waitFor(() => expect(result.current.activeDevice?.channels).toBe(2));
    expect(getDevices).toHaveBeenCalledExactlyOnceWith(true);
});

it('能力未取得でも非2冪の実稼働バッファを候補と選択値に保持する', async () => {
    const input = { name: 'Insert ASIO', host: 'ASIO', channels: 0, index: 0, is_input: true, is_default: false };
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [input], outputs: [{ ...input, is_input: false }] });
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, currentBufferSize: 960, onError: vi.fn() }));
    await waitFor(() => expect(result.current.activeDevice?.channels).toBe(0));
    expect(result.current.supportedBufferSizes).toContain(960);
    expect(result.current.selectedBufferSize).toBe(960);
});

it('ASIOの登録名だけの一覧でも保存した機器とバッファを選択でき、取得後は能力範囲を使う', async () => {
    const registered = { name: 'Insert ASIO', host: 'ASIO', id: 'ASIO:Insert ASIO', channels: 0, index: 0, is_input: true, is_default: false };
    const list: AudioDeviceList = { inputs: [registered], outputs: [{ ...registered, is_input: false, index: 1 }] };
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: registered.name, output: registered.name, bufferSize: 512, sampleRate: 96000 }));
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue(list);
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError: vi.fn() }));
    await waitFor(() => expect(result.current.selectedInput).toBe(registered.name));
    expect(result.current.selectedOutput).toBe(registered.name);
    expect(result.current.canChangeBufferSize).toBe(true);
    expect(result.current.supportedBufferSizes).toContain(512);
    vi.mocked(audioApi.getDevices).mockResolvedValue({
        inputs: [{ ...registered, channels: 16, buffer_size_range: [256, 1024] }], outputs: list.outputs,
    });
    await act(async () => result.current.fetchDevices(true));
    expect(result.current.supportedBufferSizes).toEqual([256, 512, 1024]);
});

it('古い再検出の応答で、新しいデバイス一覧とキャッシュを上書きしない', async () => {
    const pending: ((value: AudioDeviceList) => void)[] = [];
    vi.spyOn(audioApi, 'getDevices').mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const onError = vi.fn();
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError }));
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.fetchDevices(true); });
    await act(async () => { pending[1](devices('new')); await refresh; });
    await act(async () => pending[0](devices('old')));
    expect(result.current.selectedInput).toBe('new');
    expect(JSON.parse(localStorage.getItem('vst_host_cached_devices')!).inputs[0].name).toBe('new');
});

it('設定画面を閉じた後の取得結果をキャッシュへ書き込まない', async () => {
    let finish!: (value: AudioDeviceList) => void;
    vi.spyOn(audioApi, 'getDevices').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onError = vi.fn();
    const { rerender } = renderHook(({ isOpen }) => useAudioDeviceSelection({ isOpen, onError }), { initialProps: { isOpen: true } });
    rerender({ isOpen: false });
    await act(async () => finish(devices('late')));
    expect(localStorage.getItem('vst_host_cached_devices')).toBeNull();
});

it('入力が消失した再検出では以前の入力を保持せず、出力は選択できる', async () => {
    localStorage.setItem('vst_host_cached_devices', JSON.stringify(devices('mic')));
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue(devices('', false));
    const onError = vi.fn();
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError }));
    await waitFor(() => expect(result.current.selectedInput).toBe('mic'));
    await act(async () => result.current.fetchDevices(true));
    expect(result.current.selectedInput).toBe('');
    expect(result.current.selectedOutput).toBe('out');
});

it('再検出待ちで閉じても、キャッシュを使った再表示が読み込み中のままにならない', async () => {
    localStorage.setItem('vst_host_cached_devices', JSON.stringify(devices('mic')));
    vi.spyOn(audioApi, 'getDevices').mockImplementation(() => new Promise(() => {}));
    const onError = vi.fn();
    const { result, rerender } = renderHook(({ isOpen }) => useAudioDeviceSelection({ isOpen, onError }), { initialProps: { isOpen: true } });
    act(() => { void result.current.fetchDevices(true); });
    expect(result.current.loading).toBe(true);
    rerender({ isOpen: false });
    rerender({ isOpen: true });
    expect(result.current.loading).toBe(false);
});
