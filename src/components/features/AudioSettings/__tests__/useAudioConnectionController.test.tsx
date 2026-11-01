import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type AudioDevice } from '@/api/audio';
import { ConnectionApplyError, useAudioConnectionController } from '../useAudioConnectionController';
import { useAudioDeviceSelection } from '../useAudioDeviceSelection';
import type { AudioConfig } from '@/api/audio';

const device = (name: string) => ({ name, id: name, host: 'ASIO', channels: 8 } as AudioDevice);
const callbacks = new Map<string, () => void>();
beforeEach(() => {
    callbacks.clear();
    vi.mocked(listen).mockImplementation(async (name, fn) => {
        callbacks.set(name, () => fn({ event: name, id: 1, payload: null }));
        return () => {};
    });
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: true, streamFailed: false });
    vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    vi.spyOn(audioApi, 'restart').mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    vi.spyOn(audioApi, 'setInputChannels').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const options = (save: () => void | Promise<void>) => ({ isOpen: true, host: 'ASIO', input: device('in'), output: device('out'), sampleRate: 48000, bufferSize: 512, isAsio: true, currentChannels: [2, 3] as [number, number], onConfigChange: save });

it('未取得からmono出力が判明した開始でも解決済みペアを保存し、保存だけ再試行する', async () => {
    let finish!: (config: AudioConfig) => void;
    vi.mocked(audioApi.start).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const save = vi.fn().mockRejectedValueOnce(new Error('save')).mockResolvedValue(undefined);
    const view = renderHook(({ count }) => useAudioConnectionController({ ...options(save), currentChannels: undefined,
        output: { ...device('out'), channels: count } }), { initialProps: { count: 0 } });
    let apply!: Promise<void>;
    act(() => { apply = view.result.current.apply(false); });
    view.rerender({ count: 1 });
    expect(view.result.current.outputRouting).toEqual({ mode: 'independent', channels: [0, 0] });
    await act(async () => {
        finish({ sample_rate: 48000, buffer_size: 512, channels: 2,
            routing: { inputChannels: [0, 1], outputRouting: { mode: 'independent', channels: [0, 0] } } });
        await expect(apply).rejects.toBeInstanceOf(ConnectionApplyError);
    });
    await act(async () => { await view.result.current.apply(false); });
    expect(audioApi.start).toHaveBeenCalledOnce();
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ outputRouting: { mode: 'independent', channels: [0, 0] } }), { audioStarted: true });
});

it.each([false, true])('実レートの補正で機器Bと入力ペアの下書きを機器Aへ戻さない（再起動=%s）', async restart => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'A', output: 'A', inputId: 'A', outputId: 'A', sampleRate: 96000, bufferSize: 512, inputChannels: [6, 7] }));
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [device('A'), device('B')], outputs: [device('A'), device('B')] });
    let finish!: (result: AudioConfig) => void;
    vi.mocked(restart ? audioApi.restart : audioApi.start).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const save = vi.fn();
    const view = renderHook(({ rate, buffer }) => {
        const selection = useAudioDeviceSelection({ isOpen: true, currentSampleRate: rate, currentBufferSize: buffer, onError: () => {} });
        const connection = useAudioConnectionController({ ...options(save), host: selection.selectedHost, input: selection.selectedInputDevice, output: selection.selectedInputDevice,
            sampleRate: selection.selectedSampleRate, bufferSize: selection.selectedBufferSize, isAsio: selection.isAsio });
        return { selection, connection };
    }, { initialProps: { rate: 96000, buffer: 512 } });
    await act(async () => {});
    act(() => view.result.current.selection.setSelectedInputKey('id:B'));
    act(() => view.result.current.connection.setChannels([4, 5]));
    let apply!: Promise<void>;
    act(() => { apply = view.result.current.connection.apply(restart); });
    view.rerender({ rate: 48000, buffer: 256 });
    expect(view.result.current.selection.selectedInput).toBe('B');
    expect(view.result.current.connection.channels).toEqual([4, 5]);
    await act(async () => { finish({ sample_rate: 48000, buffer_size: 256, channels: 8 }); await apply; });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ input: 'B', inputId: 'B', inputChannels: [4, 5], sampleRate: 48000, bufferSize: 256 }), { audioStarted: true });
    cleanup(); localStorage.clear();
});

it('自動入力と独立出力を開始要求へ渡し、mono入力の解決結果を保存する', async () => {
    const save = vi.fn();
    vi.mocked(audioApi.start).mockResolvedValue({ sample_rate: 48000, buffer_size: 512, channels: 2,
        routing: { inputChannels: [0, 0], outputRouting: { mode: 'independent', channels: [0, 1] } } });
    const view = renderHook(() => useAudioConnectionController({ ...options(save), currentChannels: undefined }));
    await act(async () => { await view.result.current.apply(false); });
    expect(audioApi.start).toHaveBeenCalledWith('ASIO', 'in', 'out', 512, 48000, 'in', 'out', undefined,
        { inputChannels: undefined, outputRouting: { mode: 'independent', channels: [0, 1] } });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ inputChannels: [0, 0], outputRouting: { mode: 'independent', channels: [0, 1] } }), { audioStarted: true });
});

it.each([false, true])('入力ペアを開始要求へ含め、開始後のsetterを送らない（再起動=%s）', async restart => {
    const save = vi.fn();
    const view = renderHook(() => useAudioConnectionController(options(save)));
    act(() => view.result.current.setChannels([6, 7]));
    await act(async () => { await view.result.current.apply(restart); });
    expect(restart ? audioApi.restart : audioApi.start).toHaveBeenCalledWith('ASIO', 'in', 'out', 512, 48000, 'in', 'out', undefined,
        { inputChannels: [6, 7], outputRouting: { mode: 'legacy' } });
    expect(audioApi.setInputChannels).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ inputChannels: [6, 7] }), { audioStarted: true });
});

it.each([false, true])('開始前のルーティング拒否では保存しない（再起動=%s）', async restart => {
    const start = vi.mocked(restart ? audioApi.restart : audioApi.start);
    start.mockRejectedValueOnce(new Error('routing rejected'));
    const save = vi.fn();
    const view = renderHook(() => useAudioConnectionController(options(save)));
    await act(async () => { await expect(view.result.current.apply(restart)).rejects.toThrow('routing rejected'); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { await view.result.current.apply(restart); });
    expect(start).toHaveBeenCalledTimes(2);
    expect(audioApi.setInputChannels).not.toHaveBeenCalled();
});

it('保存失敗後は開始と入力設定を繰り返さず保存だけ再試行する', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('save')).mockResolvedValue(undefined);
    const view = renderHook(() => useAudioConnectionController(options(save)));
    await act(async () => { await expect(view.result.current.apply(false)).rejects.toBeInstanceOf(ConnectionApplyError); });
    await act(async () => { await view.result.current.apply(false); });
    expect(audioApi.start).toHaveBeenCalledOnce();
    expect(audioApi.setInputChannels).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(2);
});

it('失敗後に停止通知または下書き変更があれば新しい開始を行う', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('save')).mockRejectedValueOnce(new Error('save'));
    const view = renderHook(() => useAudioConnectionController(options(save)));
    await act(async () => { await expect(view.result.current.apply(false)).rejects.toThrow(); });
    act(() => callbacks.get('audio-stopped')!());
    await act(async () => { await expect(view.result.current.apply(false)).rejects.toThrow(); });
    act(() => view.result.current.setChannels([4, 5]));
    await act(async () => { await view.result.current.apply(false); });
    expect(audioApi.start).toHaveBeenCalledTimes(3);
    expect(audioApi.start).toHaveBeenLastCalledWith('ASIO', 'in', 'out', 512, 48000, 'in', 'out', undefined, { inputChannels: [4, 5], outputRouting: { mode: 'legacy' } });
});


it('自分の開始通知が入力適用の途中に遅れても同じ接続は失効しない', async () => {
    let finish!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: true, config: { host: 'ASIO', input: 'in', output: 'out', input_id: 'in', output_id: 'out', sample_rate: 48000, buffer_size: 512 } });
    const view = renderHook(() => useAudioConnectionController(options(save)));
    let apply!: Promise<void>;
    await act(async () => { apply = view.result.current.apply(false); });
    act(() => callbacks.get('audio-started')!());
    await act(async () => { finish(); await apply; });
    expect(save).toHaveBeenCalledOnce();
});

it('開始待ちで停止したら遅い開始応答から入力適用や保存をしない', async () => {
    let finish!: (result: { sample_rate: number; buffer_size: number; channels: number }) => void;
    vi.mocked(audioApi.start).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const save = vi.fn();
    const view = renderHook(() => useAudioConnectionController(options(save)));
    let apply!: Promise<void>;
    act(() => { apply = view.result.current.apply(false); });
    act(() => callbacks.get('audio-stopped')!());
    await act(async () => { finish({ sample_rate: 48000, buffer_size: 512, channels: 2 }); await expect(apply).rejects.toThrow(); });
    expect(audioApi.setInputChannels).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
});

it('開始後の実レート同期は同じ要求として途中から再試行する', async () => {
    vi.mocked(audioApi.start).mockResolvedValue({ sample_rate: 48000, buffer_size: 256, channels: 2 });
    const save = vi.fn().mockRejectedValueOnce(new Error('save')).mockResolvedValue(undefined);
    const view = renderHook(({ rate, buffer }) => useAudioConnectionController({ ...options(save), sampleRate: rate, bufferSize: buffer }), { initialProps: { rate: 96000, buffer: 512 } });
    await act(async () => { await expect(view.result.current.apply(false)).rejects.toThrow(); });
    view.rerender({ rate: 48000, buffer: 256 });
    await act(async () => { await view.result.current.apply(false); });
    expect(audioApi.start).toHaveBeenCalledOnce();
    expect(audioApi.setInputChannels).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 48000, bufferSize: 256 }), { audioStarted: true });
});

it('開始後に別の機器への開始通知が来たら保存を続けない', async () => {
    let finish!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: true, config: { host: 'ASIO', input: 'other', output: 'out', input_id: 'other', output_id: 'out', sample_rate: 48000, buffer_size: 512 } });
    const view = renderHook(() => useAudioConnectionController(options(save)));
    let apply!: Promise<void>;
    await act(async () => { apply = view.result.current.apply(false); });
    act(() => callbacks.get('audio-started')!());
    await act(async () => { finish(); await expect(apply).rejects.toThrow(); });
    expect(save).toHaveBeenCalledOnce();
});


it('失敗後に下書きを変えて元に戻しても旧attemptを再利用しない', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('save')).mockResolvedValue(undefined);
    const view = renderHook(() => useAudioConnectionController(options(save)));
    await act(async () => { await expect(view.result.current.apply(false)).rejects.toThrow(); });
    act(() => view.result.current.setChannels([4, 5]));
    act(() => view.result.current.setChannels([2, 3]));
    await act(async () => { await view.result.current.apply(false); });
    expect(audioApi.start).toHaveBeenCalledTimes(2);
});


it('プロセスと機器情報があってもストリーム停止中は監視しない', async () => {
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: true, config: { host: 'ASIO', input: 'in', input_id: 'in', output: 'out', output_id: 'out', sample_rate: 48000, buffer_size: 512 } });
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({ running: false, streamFailed: false });
    const view = renderHook(() => useAudioConnectionController(options(vi.fn())));
    await act(async () => {});
    expect(audioApi.getAudioStreamState).toHaveBeenCalled();
    expect(view.result.current.monitorInput).toBe(false);
});

it('停止通知後に遅れて稼働応答が届いても監視を再開しない', async () => {
    let finish!: (state: { running: boolean; streamFailed: boolean }) => void;
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: true, config: { host: 'ASIO', input: 'in', input_id: 'in', output: 'out', output_id: 'out', sample_rate: 48000, buffer_size: 512 } });
    vi.mocked(audioApi.getAudioStreamState).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = renderHook(() => useAudioConnectionController(options(vi.fn())));
    await act(async () => {});
    act(() => callbacks.get('audio-stopped')!());
    await act(async () => { finish({ running: true, streamFailed: false }); });
    expect(view.result.current.monitorInput).toBe(false);
    expect(audioApi.getAudioState).toHaveBeenCalledTimes(1);
});
