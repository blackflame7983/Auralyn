import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type AudioDevice } from '@/api/audio';
import { ConnectionApplyError, ConnectionStartError, useAudioConnectionController } from '../useAudioConnectionController';
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

it('アプリ入力ではマイク名・IDを渡さず、保存失敗は再開せずに保存だけ再試行する', async () => {
    const source = { kind: 'process_loopback' as const, config: { appKey: 'a'.repeat(64), appName: 'player.exe', rawEndpointId: 'raw', purpose: 'music' as const } };
    const request = { source, candidateId: 'app-1' };
    const save = vi.fn().mockRejectedValueOnce(new Error('save')).mockResolvedValue(undefined);
    const view = renderHook(() => useAudioConnectionController({ ...options(save), host: 'WASAPI', isAsio: false, input: undefined, inputSource: request }));
    await act(async () => { await expect(view.result.current.apply(false)).rejects.toBeInstanceOf(ConnectionApplyError); });
    await act(async () => { await view.result.current.apply(false); });
    expect(audioApi.start).toHaveBeenCalledOnce();
    expect(vi.mocked(audioApi.start).mock.calls[0]).toEqual(['WASAPI', undefined, 'out', 512, 48000, undefined, 'out', undefined,
        { inputChannels: [0, 1], outputRouting: { mode: 'independent', channels: [0, 1] } }, request]);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ input: undefined, inputId: undefined, inputSource: source }), { audioStarted: true });
    expect(JSON.stringify(save.mock.calls[1][0])).not.toContain('candidateId');
});

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

// 新しい接続で開始できないとき、止まったままにせず直前の接続で開始し直す（#289）。
const previousConfig = { host: 'WASAPI', input: 'mic', output: 'speaker', input_id: 'wasapi:mic', output_id: 'wasapi:speaker', sample_rate: 48000, buffer_size: 512,
    routing: { inputChannels: [0, 1] as [number, number], outputRouting: { mode: 'independent' as const, channels: [0, 1] as [number, number] } } };
// 再起動は旧エンジンを止めてから開始する。失敗した開始の後は、止まった状態を返す。
const failAfterStopping = (fn: typeof audioApi.start, message: string, config: object = previousConfig) => {
    let stopped = false;
    vi.mocked(audioApi.getAudioState).mockImplementation(async () => stopped ? { is_running: false, config: null } : { is_running: true, config: config as never });
    vi.mocked(fn).mockImplementationOnce(async () => { stopped = true; throw new Error(message); });
};

it.each([false, true])('開始に失敗したら直前に動いていた接続へ戻し、保存しない（再起動=%s）', async restart => {
    failAfterStopping(restart ? audioApi.restart : audioApi.start, 'sample clock or rate cannot be determined');
    const save = vi.fn();
    const view = renderHook(() => useAudioConnectionController(options(save)));
    let error: unknown;
    await act(async () => { error = await view.result.current.apply(restart).catch(e => e); });
    expect(error).toBeInstanceOf(ConnectionStartError);
    expect((error as ConnectionStartError).rollback).toBe('restored');
    expect((error as Error).message).toContain('sample clock');
    expect(audioApi.start).toHaveBeenLastCalledWith('WASAPI', 'mic', 'speaker', 512, 48000, 'wasapi:mic', 'wasapi:speaker', undefined, previousConfig.routing);
    expect(save).not.toHaveBeenCalled();
});

it('直前の接続にも戻せなければ、その結果を返す', async () => {
    failAfterStopping(audioApi.restart, 'new failed');
    vi.mocked(audioApi.start).mockRejectedValueOnce(new Error('previous failed'));
    const view = renderHook(() => useAudioConnectionController(options(vi.fn())));
    let error: unknown;
    await act(async () => { error = await view.result.current.apply(true).catch(e => e); });
    expect((error as ConnectionStartError).rollback).toBe('failed');
});

it('旧接続を止める前に失敗し、まだ動いていれば、開始し直さずそのまま残す', async () => {
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: true, config: previousConfig });
    vi.mocked(audioApi.restart).mockRejectedValueOnce(new Error('microphone access denied'));
    const view = renderHook(() => useAudioConnectionController(options(vi.fn())));
    let error: unknown;
    await act(async () => { error = await view.result.current.apply(true).catch(e => e); });
    expect((error as ConnectionStartError).rollback).toBe('kept');
    expect(audioApi.start).not.toHaveBeenCalled();
});

it('機器入力の用途も直前のまま戻す', async () => {
    const source = { kind: 'device' as const, config: { purpose: 'music' as const } };
    failAfterStopping(audioApi.restart, 'failed', { ...previousConfig, input_source: source });
    const view = renderHook(() => useAudioConnectionController(options(vi.fn())));
    let error: unknown;
    await act(async () => { error = await view.result.current.apply(true).catch(e => e); });
    expect((error as ConnectionStartError).rollback).toBe('restored');
    expect(audioApi.start).toHaveBeenLastCalledWith('WASAPI', 'mic', 'speaker', 512, 48000, 'wasapi:mic', 'wasapi:speaker', undefined, previousConfig.routing, { source });
});

it.each([
    ['止まっていた', { is_running: false, config: previousConfig }, { running: true, streamFailed: false }],
    ['ストリームが失敗していた', { is_running: true, config: previousConfig }, { running: true, streamFailed: true }],
])('開始前に音が%s場合は、戻す開始をしない', async (_label, state, stream) => {
    vi.mocked(audioApi.getAudioState).mockResolvedValue(state);
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue(stream);
    vi.mocked(audioApi.start).mockRejectedValueOnce(new Error('failed'));
    const view = renderHook(() => useAudioConnectionController(options(vi.fn())));
    let error: unknown;
    await act(async () => { error = await view.result.current.apply(false).catch(e => e); });
    expect((error as ConnectionStartError).rollback).toBe('none');
    expect(audioApi.start).toHaveBeenCalledOnce();
});

it('アプリ入力だった直前の接続は、候補を選び直せないため戻さない', async () => {
    const source = { kind: 'process_loopback' as const, config: { appKey: 'a'.repeat(64), appName: 'player.exe', rawEndpointId: 'raw', purpose: 'music' as const } };
    failAfterStopping(audioApi.restart, 'failed', { ...previousConfig, input: null, input_id: undefined, input_source: source });
    const view = renderHook(() => useAudioConnectionController(options(vi.fn())));
    let error: unknown;
    await act(async () => { error = await view.result.current.apply(true).catch(e => e); });
    expect((error as ConnectionStartError).rollback).toBe('failed');
    expect(audioApi.start).not.toHaveBeenCalled();
});


it.each(['getAudioState', 'getAudioStreamState'] as const)('開始失敗後の%s失敗では旧接続を再開始しない', async method => {
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: true, config: previousConfig });
    vi.mocked(audioApi.restart).mockImplementationOnce(async () => {
        vi.mocked(audioApi[method]).mockRejectedValue(new Error('state unavailable'));
        throw new Error('preflight failed');
    });
    const view = renderHook(() => useAudioConnectionController(options(vi.fn())));
    await act(async () => {
        await expect(view.result.current.apply(true)).rejects.toMatchObject({ rollback: 'unknown' });
    });
    expect(audioApi.start).not.toHaveBeenCalled();
});
