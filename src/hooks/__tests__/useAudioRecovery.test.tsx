import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi } from '../../api/audio';
import { liveModesApi } from '../../api/liveModes';
import { useAudioRecovery } from '../useAudioRecovery';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
let callbacks: Map<string, (event: { payload: string }) => void>;
const notify = (event: string, payload = '') => act(() => callbacks.get(event)?.({ payload }));
const disconnect = () => notify('audio-stream-error', 'Input Stream Error: device removed');
const tick = async (ms: number) => { await act(() => vi.advanceTimersByTimeAsync(ms)); };

beforeEach(() => {
    vi.spyOn(liveModesApi, 'request').mockResolvedValue({ armed: false } as Awaited<ReturnType<typeof liveModesApi.request>>);
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('vst_host_audio_config', JSON.stringify({
        host: 'ASIO', input: 'mic', output: 'out', sampleRate: 48000, bufferSize: 512, inputChannels: [4, 5],
    }));
    callbacks = new Map();
    vi.mocked(listen).mockImplementation(async (event, callback) => {
        callbacks.set(event, callback as (event: { payload: string }) => void);
        return () => { callbacks.delete(event); };
    });
    vi.spyOn(audioApi, 'setInputChannels').mockResolvedValue(undefined);
});
afterEach(async () => { cleanup(); await act(async () => {}); vi.restoreAllMocks(); vi.useRealTimers(); });
it.each(['snapshot', 'actual'])('%sの遅い状態取得中に手動停止したら復旧とch設定・成功通知を行わない', async waiting => {
    let finish!: () => void;
    if (waiting === 'snapshot') {
        vi.mocked(liveModesApi.request).mockReturnValueOnce(new Promise(resolve => {
            finish = () => resolve({ armed: false } as Awaited<ReturnType<typeof liveModesApi.request>>);
        }));
    } else {
        vi.mocked(liveModesApi.request).mockResolvedValue({ armed: true } as Awaited<ReturnType<typeof liveModesApi.request>>);
        vi.spyOn(audioApi, 'getAudioState').mockReturnValue(new Promise(resolve => {
            finish = () => resolve({ is_running: true, config: { host: 'WASAPI', input: 'actual-in', output: 'actual-out', sample_rate: 96000, buffer_size: 256 } });
        }));
    }
    const start = vi.spyOn(audioApi, 'start');
    renderHook(() => useAudioRecovery()); disconnect(); await tick(2000);
    notify('audio-stopped');
    await act(async () => finish()); await tick(12000);
    expect(start).not.toHaveBeenCalled();
    expect(audioApi.setInputChannels).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
});
it('中止済みの旧snapshot応答が新しい復旧Startの停止通知除外を解除しない', async () => {
    let oldSnapshot!: () => void; let finishStart!: () => void;
    vi.mocked(liveModesApi.request).mockReturnValueOnce(new Promise(resolve => {
        oldSnapshot = () => resolve({ armed: false } as Awaited<ReturnType<typeof liveModesApi.request>>);
    }));
    const start = vi.spyOn(audioApi, 'start').mockReturnValue(new Promise(resolve => {
        finishStart = () => resolve({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    }));
    renderHook(() => useAudioRecovery()); disconnect(); await tick(2000);
    notify('audio-stopped'); disconnect(); await tick(2000);
    expect(start).toHaveBeenCalledOnce();
    await act(async () => oldSnapshot());
    notify('audio-stopped'); // 新しいStart自身の停止通知。
    await act(async () => finishStart());
    expect(audioApi.setInputChannels).toHaveBeenCalledExactlyOnceWith(4, 5);
    expect(toast.success).toHaveBeenCalledOnce();
});
it('本番保護中は保存済み自動deviceではなくHostの具体的な実設定だけで復旧する', async () => {
    vi.mocked(liveModesApi.request).mockResolvedValue({ armed: true } as Awaited<ReturnType<typeof liveModesApi.request>>);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: { host: 'WASAPI', input: 'actual-in', output: 'actual-out', sample_rate: 96000, buffer_size: 256 } });
    const start = vi.spyOn(audioApi, 'start').mockResolvedValue({ sample_rate: 96000, buffer_size: 256, channels: 2 });
    renderHook(() => useAudioRecovery()); disconnect(); await tick(2000);
    expect(start).toHaveBeenCalledWith('WASAPI', 'actual-in', 'actual-out', 256, 96000);
    expect(audioApi.setInputChannels).not.toHaveBeenCalled();
});
it('本番保護中の実設定が不明なら自動deviceへfallbackしない', async () => {
    vi.mocked(liveModesApi.request).mockResolvedValue({ armed: true } as Awaited<ReturnType<typeof liveModesApi.request>>);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ is_running: true, config: null });
    const start = vi.spyOn(audioApi, 'start');
    renderHook(() => useAudioRecovery()); disconnect(); await tick(12000);
    expect(start).not.toHaveBeenCalled();
});

it('新しい通知がなくても3回試し、上限後の通知では繰り返さない', async () => {
    const start = vi.spyOn(audioApi, 'start').mockRejectedValue(new Error('missing device'));
    const restart = vi.spyOn(audioApi, 'restart');
    renderHook(() => useAudioRecovery());
    disconnect();
    await tick(12_000);
    expect(start).toHaveBeenCalledTimes(3);
    expect(restart).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledOnce();
    disconnect();
    await tick(20_000);
    expect(start).toHaveBeenCalledTimes(3);
});

it('重複エラーと遅い開始応答でも要求を並行させず、チャンネルを復元する', async () => {
    let finish!: () => void;
    const start = vi.spyOn(audioApi, 'start').mockImplementation(() => new Promise(resolve => {
        finish = () => resolve({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    }));
    renderHook(() => useAudioRecovery());
    disconnect();
    await tick(2000);
    disconnect();
    notify('audio-stopped'); // Start自身による停止通知
    await tick(20_000);
    expect(start).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(audioApi.setInputChannels).toHaveBeenCalledWith(4, 5);
    expect(toast.success).toHaveBeenCalledOnce();
});

it.each(['stop', 'config', 'crash', 'unmount', 'migration'])('%sで予約済みの自動復帰を中止する', async reason => {
    const start = vi.spyOn(audioApi, 'start');
    const { unmount } = renderHook(() => useAudioRecovery());
    disconnect();
    if (reason === 'stop') notify('audio-stopped');
    if (reason === 'crash') notify('audio-error');
    if (reason === 'unmount') unmount();
    if (reason === 'config') localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'Wasapi' }));
    if (reason === 'migration') localStorage.setItem('vst_host_migration_review_required', 'true');
    await tick(12_000);
    expect(start).not.toHaveBeenCalled();
});

it('終了後に届いた開始応答ではチャンネル設定や成功通知を行わない', async () => {
    let finish!: () => void;
    vi.spyOn(audioApi, 'start').mockImplementation(() => new Promise(resolve => {
        finish = () => resolve({ sample_rate: 48000, buffer_size: 512, channels: 2 });
    }));
    const { unmount } = renderHook(() => useAudioRecovery());
    disconnect();
    await tick(2000);
    unmount();
    await act(async () => finish());
    expect(audioApi.setInputChannels).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
});
