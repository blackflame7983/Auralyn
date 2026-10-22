import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type QualityReport, type VoiceCheckState } from '@/api/audio';
import { useVoiceCheck } from '../useVoiceCheck';

const running = { running: true, streamFailed: false };
const report = { verdict: 'good' } as QualityReport;
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const emit = (name: string, payload: unknown) => {
    for (const [event, callback] of vi.mocked(listen).mock.calls) {
        if (event === name) callback({ event: name, id: 1, payload });
    }
};
beforeEach(() => {
    vi.mocked(listen).mockClear();
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ config: null, is_running: true });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue(running);
    vi.spyOn(audioApi, 'startVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'stopVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'stopVoiceCheckPlayback').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'analyzeVoiceCheck').mockResolvedValue(report);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('前の録音の解析が遅く完了しても、新しい録音の結果として表示しない', async () => {
    const analysis = deferred<QualityReport>();
    vi.mocked(audioApi.analyzeVoiceCheck).mockReturnValue(analysis.promise);
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.streamStatus).toBe('ready'));
    act(() => { void result.current.handleAnalyze(); });
    await act(async () => { await result.current.handleStartRecording(); });
    await act(async () => { analysis.resolve(report); });
    expect(result.current.qualityReport).toBeNull();
    expect(result.current.analyzing).toBe(false);
    expect(result.current.vcState.state).toBe('recording');
});

it('閉じる前の解析と状態通知が再表示後の画面へ反映されない', async () => {
    const analysis = deferred<QualityReport>();
    vi.mocked(audioApi.analyzeVoiceCheck).mockReturnValue(analysis.promise);
    const { result, rerender } = renderHook(({ open }) => useVoiceCheck(open), { initialProps: { open: true } });
    await waitFor(() => expect(result.current.streamStatus).toBe('ready'));
    const oldCallback = vi.mocked(listen).mock.calls.find(([event]) => event === 'voice-check-state')![1];
    act(() => { void result.current.handleAnalyze(); });
    rerender({ open: false });
    rerender({ open: true });
    await act(async () => {
        analysis.resolve(report);
        oldCallback({ event: 'voice-check-state', id: 1, payload: { state: 'playing', duration_ms: 123 } });
    });
    expect(result.current.qualityReport).toBeNull();
    expect(result.current.vcState.state).toBe('idle');
    expect(result.current.analyzing).toBe(false);
});

it('開始応答より新しい録音完了通知と波形を巻き戻さない', async () => {
    const start = deferred<unknown>();
    vi.mocked(audioApi.startVoiceCheck).mockReturnValue(start.promise);
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.streamStatus).toBe('ready'));
    act(() => { void result.current.handleStartRecording(); });
    await waitFor(() => expect(audioApi.startVoiceCheck).toHaveBeenCalledOnce());
    const ready: VoiceCheckState = { state: 'ready', position_ms: 0, duration_ms: 500 };
    await act(async () => {
        emit('voice-check-state', ready);
        emit('voice-check-envelope', { raw_peaks: [0.2], processed_peaks: [0.3] });
        start.resolve(undefined);
    });
    expect(result.current.vcState).toEqual(ready);
    expect(result.current.rawPeaks).toEqual([0.2]);
    expect(result.current.busy).toBe(false);
});

it('開始応答待ちに停止通知が来たら録音中表示へ戻さない', async () => {
    const start = deferred<unknown>();
    vi.mocked(audioApi.startVoiceCheck).mockReturnValue(start.promise);
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.streamStatus).toBe('ready'));
    act(() => { void result.current.handleStartRecording(); });
    await waitFor(() => expect(audioApi.startVoiceCheck).toHaveBeenCalledOnce());
    await act(async () => { emit('audio-stopped', null); start.resolve(undefined); });
    expect(result.current.vcState.state).toBe('idle');
    expect(result.current.streamStatus).toBe('stopped');
});

it('閉じている間に停止通知を受け取れなくても、再表示時に録音中表示を持ち越さない', async () => {
    const { result, rerender } = renderHook(({ open }) => useVoiceCheck(open), { initialProps: { open: true } });
    await waitFor(() => expect(result.current.streamStatus).toBe('ready'));
    await act(async () => { await result.current.handleStartRecording(); });
    expect(result.current.vcState.state).toBe('recording');
    rerender({ open: false });
    rerender({ open: true });
    expect(result.current.vcState.state).toBe('idle');
    expect(audioApi.stopVoiceCheck).toHaveBeenCalled();
});

it('録音開始と解析を同じ描画内で連打しても要求を重複させない', async () => {
    const start = deferred<unknown>();
    const analysis = deferred<QualityReport>();
    vi.mocked(audioApi.startVoiceCheck).mockReturnValue(start.promise);
    vi.mocked(audioApi.analyzeVoiceCheck).mockReturnValue(analysis.promise);
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.streamStatus).toBe('ready'));
    act(() => {
        void result.current.handleStartRecording();
        void result.current.handleStartRecording();
    });
    await waitFor(() => expect(audioApi.startVoiceCheck).toHaveBeenCalledOnce());
    act(() => { void result.current.handleAnalyze(); void result.current.handleAnalyze(); });
    expect(audioApi.analyzeVoiceCheck).toHaveBeenCalledOnce();
    await act(async () => { start.resolve(undefined); analysis.resolve(report); });
    expect(result.current.qualityReport).toEqual(report);
});
