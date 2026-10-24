import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi, type AudioDeviceList } from '../../../../api/audio';
import { useAudioDeviceSelection } from '../useAudioDeviceSelection';

const devices = (name: string, input = true): AudioDeviceList => ({
    inputs: input ? [{ name, host: 'Wasapi', channels: 2, index: 0, is_input: true, is_default: true }] : [],
    outputs: [{ name: 'out', host: 'Wasapi', channels: 2, index: 1, is_input: false, is_default: true }],
});
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
