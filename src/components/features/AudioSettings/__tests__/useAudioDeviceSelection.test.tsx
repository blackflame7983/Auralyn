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

it('未設定では先頭の再生入力・仮想出力ではなくWindowsの既定を選び、手動の未選択も保つ', async () => {
    const input = { ...devices('Windows microphone').inputs[0], id: 'default-mic' };
    const output = { ...devices('mic').outputs[0], name: 'Windows headphones', id: 'default-out' };
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [{ ...input, name: '再生リダイレクト', id: 'playback', is_default: false }, input],
        outputs: [{ ...output, name: 'Voicemeeter In 2', id: 'virtual', is_default: false }, output] });
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError: vi.fn() }));
    await waitFor(() => expect(result.current.selectedInputKey).toBe('id:default-mic'));
    expect(result.current.selectedOutputKey).toBe('id:default-out');
    act(() => result.current.setSelectedInputKey(''));
    expect(result.current.selectedInputKey).toBe('');
});

it.each(['none', 'virtual', 'ambiguous'])('既定が%sならマイクを推測せず未選択にする', async kind => {
    const input = { ...devices('Microphone').inputs[0], is_default: kind !== 'none', name: kind === 'virtual' ? 'CABLE Output' : 'Microphone' };
    const inputs = kind === 'ambiguous' ? [input, { ...input, name: 'Headset microphone', index: 1 }] : [input];
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs, outputs: [{ ...devices('mic').outputs[0], is_default: false }] });
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError: vi.fn() }));
    await waitFor(() => expect(result.current.devices.inputs).toHaveLength(inputs.length));
    expect(result.current.selectedInputKey).toBe(''); expect(result.current.selectedOutputKey).toBe('');
});

it('保存済み機器が消えても別の既定マイクへ切り替えない', async () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi', inputId: 'missing', output: 'out' }));
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue(devices('Other default microphone'));
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError: vi.fn() }));
    await waitFor(() => expect(result.current.selectedOutput).toBe('out'));
    expect(result.current.selectedInputKey).toBe('');
});

it('WebViewに設定がなくても親が復帰したnativeの機器ID・レートで開ける', async () => {
    const asio = { host: 'ASIO', name: 'saved ASIO', id: 'asio:saved', channels: 22, index: 0, is_input: true, is_default: false };
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [asio, ...devices('other mic').inputs], outputs: [{ ...asio, is_input: false }, ...devices('other mic').outputs] });
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError: vi.fn(), currentConfig: {
        host: 'ASIO', inputId: 'asio:saved', outputId: 'asio:saved', sampleRate: 96000, bufferSize: 256,
    } }));
    await waitFor(() => expect(result.current.selectedInputDevice?.id).toBe('asio:saved'));
    expect(result.current.selectedHost).toBe('ASIO');
    expect(result.current.selectedOutputDevice?.id).toBe('asio:saved');
    expect(result.current.selectedSampleRate).toBe(96000); expect(result.current.selectedBufferSize).toBe(256);
    expect(localStorage.getItem('vst_host_audio_config')).toBeNull();
});

it('未設定では先頭がASIOでもWASAPIを選び、ASIOは明示選択できる', async () => {
    const wasapi = devices('Mic');
    const asio = { ...wasapi.inputs[0], host: 'ASIO', name: 'ASIO driver' };
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [asio, ...wasapi.inputs], outputs: [{ ...asio, is_input: false }, ...wasapi.outputs] });
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError: vi.fn() }));
    await waitFor(() => expect(result.current.selectedHost).toBe('Wasapi'));
    expect(result.current.isAsio).toBe(false);
    act(() => result.current.setSelectedHost('ASIO'));
    expect(result.current.isAsio).toBe(true);
});

it('保存したWASAPIは列挙のWasapiと一致し、先頭のASIOへ切り替わらない', async () => {
    const wasapi = devices('other mic');
    wasapi.inputs.push({ ...wasapi.inputs[0], name: 'saved mic', host: 'WASAPI', index: 2 });
    const asio = { ...wasapi.inputs[0], name: 'ASIO driver', host: 'ASIO' };
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'saved mic', output: 'out', sampleRate: 48000, bufferSize: 512 }));
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [asio, ...wasapi.inputs], outputs: [{ ...asio, is_input: false }, ...wasapi.outputs] });
    const { result, rerender } = renderHook(({ isOpen }) => useAudioDeviceSelection({ isOpen, onError: vi.fn() }), { initialProps: { isOpen: true } });
    await waitFor(() => expect(result.current.selectedHost).toBe('Wasapi'));
    expect(result.current.selectedInput).toBe('saved mic');
    expect(result.current.selectedOutput).toBe('out');
    rerender({ isOpen: false });
    rerender({ isOpen: true });
    expect(result.current.selectedHost).toBe('Wasapi');
    expect(result.current.selectedInput).toBe('saved mic');
});

it.each([2, 64])('音声開始後に%iチャンネルの実能力を取得し、閉じた後は開始通知で再検出しない', async channels => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'Insert ASIO' }));
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
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'Insert ASIO' }));
    const input = { name: 'Insert ASIO', host: 'ASIO', id: 'asio:Insert ASIO', channels: 0, index: 0, is_input: true, is_default: false };
    localStorage.setItem('vst_host_cached_devices', JSON.stringify({ inputs: [input], outputs: [{ ...input, is_input: false }] }));
    const getDevices = vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [{ ...input, channels: 2 }], outputs: [{ ...input, is_input: false, channels: 2 }] });
    const { result } = renderHook(() => useAudioDeviceSelection({ isOpen: true, onError: vi.fn() }));
    await waitFor(() => expect(result.current.activeDevice?.channels).toBe(2));
    expect(getDevices).toHaveBeenCalledExactlyOnceWith(true);
});

it('能力未取得でも非2冪の実稼働バッファを候補と選択値に保持する', async () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'Insert ASIO' }));
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
