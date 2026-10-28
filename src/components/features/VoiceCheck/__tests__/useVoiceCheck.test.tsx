import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { FixedClientError } from '@/lib/clientError';
import { defaultSinging, defaultReverb, type CandidateDraft } from '@/api/builtinEffects';
import { StrictMode } from 'react';
import type { BuiltinCandidate } from '@/api/voiceCheckPreview';
import { voicePreviewApi } from '@/api/voiceCheckPreview';
import { previewSnapshot } from './previewFixture';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type QualityReport, type VoiceCheckState } from '@/api/audio';
import { useVoiceCheck } from '../useVoiceCheck';
import { toast } from 'sonner';

const running = { running: true, streamFailed: false };
const report = { verdict: 'good' } as QualityReport;
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}
const emit = (name: string, payload: unknown) => {
    for (const [event, callback] of vi.mocked(listen).mock.calls) {
        if (event === name) callback({ event: name, id: 1, payload });
    }
};
beforeEach(() => {
    localStorage.clear();
    vi.spyOn(voicePreviewApi, 'request').mockImplementation(async request => previewSnapshot(request));
    vi.mocked(listen).mockClear();
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ config: null, is_running: true });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue(running);
    vi.spyOn(audioApi, 'startVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'stopVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'stopVoiceCheckPlayback').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'analyzeVoiceCheck').mockResolvedValue(report);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(['success', 'failure'] as const)('解析待ちの非表示後に再実行でき、旧%s応答は新しい解析へ干渉しない', async outcome => {
    const previous = deferred<QualityReport>();
    const current = deferred<QualityReport>();
    const errorToast = vi.spyOn(toast, 'error').mockReturnValue('ignored');
    vi.mocked(audioApi.analyzeVoiceCheck).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.streamStatus).toBe('ready'));
    act(() => { void result.current.handleAnalyze(); });
    expect(result.current.analyzing).toBe(true);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.analyzing).toBe(false);
    act(() => { void result.current.handleAnalyze(); });
    expect(audioApi.analyzeVoiceCheck).toHaveBeenCalledTimes(2);
    expect(result.current.analyzing).toBe(true);

    await act(async () => {
        if (outcome === 'success') previous.resolve(report);
        else previous.reject(new Error('stale analysis failure'));
    });
    expect(result.current.qualityReport).toBeNull();
    expect(result.current.analyzing).toBe(true);
    expect(errorToast).not.toHaveBeenCalled();
    await act(async () => { await result.current.handleAnalyze(); });
    expect(audioApi.analyzeVoiceCheck).toHaveBeenCalledTimes(2);

    const currentReport = { ...report, verdict: 'warn' } as QualityReport;
    await act(async () => current.resolve(currentReport));
    expect(result.current.qualityReport).toEqual(currentReport);
    expect(result.current.analyzing).toBe(false);
    await act(async () => { await result.current.handleAnalyze(); });
    expect(audioApi.analyzeVoiceCheck).toHaveBeenCalledTimes(3);
});

it('StrictModeの後始末で旧通常再生を停止せず、新しい独立試聴を自己失効させない', async () => {
    vi.mocked(audioApi.stopVoiceCheckPlayback).mockImplementation(async () => {
        // 通常出力を変える旧APIはHostから条件変更を通知する。
        await Promise.resolve();
        emit('audio-conditions-changed', null);
    });
    const { result, unmount } = renderHook(() => useVoiceCheck(true), {
        wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    await waitFor(() => expect(result.current.preview?.state).toBe('idle'));
    expect(audioApi.stopVoiceCheckPlayback).not.toHaveBeenCalled();
    unmount();
    expect(audioApi.stopVoiceCheck).toHaveBeenCalled();
});

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

it('録音開始の条件変更後は完了通知で試聴を準備し、以降の条件変更では復活させない', async () => {
    vi.mocked(audioApi.startVoiceCheck).mockImplementation(async () => {
        emit('audio-conditions-changed', null);
    });
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.state).toBe('idle'));
    await waitFor(() => expect(result.current.streamStatus).toBe('ready'));
    await act(async () => { await result.current.handleStartRecording(); });
    expect(result.current.preview?.state).toBe('closed');
    await act(async () => {
        emit('voice-check-state', { state: 'ready', position_ms: 0, duration_ms: 500 });
    });
    await waitFor(() => expect(result.current.preview?.state).toBe('idle'));
    await act(async () => { emit('audio-conditions-changed', null); });
    expect(result.current.preview?.state).toBe('closed');
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

it('独立試聴のA/Bとloop・音量合わせは同じtransportをupdateし通常出力APIを呼ばない', async () => {
    let playing = false;
    let options = { source: 'processed' as 'raw' | 'processed', loopPlayback: true, levelMatch: false };
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'start') playing = true;
        if (request.action === 'start' || request.action === 'update') options = { source: request.source, loopPlayback: request.loopPlayback, levelMatch: request.levelMatch };
        return previewSnapshot(request, { recordingId: 9, durationMs: 1000, positionMs: 420, state: playing ? 'playing' : 'idle', levelMatchAvailable: true, ...options,
            devices: request.action === 'devices' ? [{ id: 'headphones', name: 'Headphones' }] : [] });
    });
    const ordinaryPlayback = vi.spyOn(audioApi, 'playVoiceCheck');
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.recordingId).toBe(9));
    await act(async () => { await result.current.refreshPreviewDevices(); });
    act(() => { result.current.setPreviewDeviceId('headphones'); });
    act(() => { result.current.setSafeOutput(true); });
    await act(async () => { await result.current.handleTogglePlayback(); });
    await act(async () => { await result.current.handleSourceChange('raw'); });
    await act(async () => { result.current.setLoopPlayback(false); });
    await act(async () => { result.current.setLevelMatch(true); });
    const requests = vi.mocked(voicePreviewApi.request).mock.calls.map(([request]) => request);
    expect(requests.filter(request => request.action === 'start')).toHaveLength(1);
    expect(requests.filter(request => request.action === 'update')).toHaveLength(3);
    expect(result.current.preview?.positionMs).toBe(420);
    expect(result.current.source).toBe('raw');
    expect(result.current.loopPlayback).toBe(false);
    expect(result.current.levelMatch).toBe(true);
    expect(ordinaryPlayback).not.toHaveBeenCalled();
    expect(localStorage.getItem('vst_host_voice_check_preview_device')).toBe('headphones');
});

it('開始応答待ちでもstopを送り、遅い開始成功を再生状態へ戻さない', async () => {
    const started = deferred<ReturnType<typeof previewSnapshot>>();
    let startRequest: Parameters<typeof previewSnapshot>[0] | undefined;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'start') { startRequest = request; return started.promise; }
        return previewSnapshot(request, { recordingId: 9, durationMs: 1000, state: request.action === 'stop' ? 'stopped' : 'idle', devices: request.action === 'devices' ? [{ id: 'hp', name: 'Headphones' }] : [] });
    });
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.recordingId).toBe(9));
    await act(async () => { await result.current.refreshPreviewDevices(); });
    act(() => result.current.setPreviewDeviceId('hp'));
    act(() => result.current.setSafeOutput(true));
    act(() => { void result.current.handleTogglePlayback(); });
    await waitFor(() => expect(startRequest).toBeDefined());
    await act(async () => { await result.current.handleStopPreview(); });
    expect(result.current.preview?.state).toBe('stopped');
    await act(async () => started.resolve(previewSnapshot(startRequest!, { state: 'playing', recordingId: 9 })));
    expect(result.current.preview?.state).toBe('stopped');
});

it('epoch取得前に閉じてもcloseを送り、openの遅い応答を新sessionへ適用しない', async () => {
    const opened = deferred<ReturnType<typeof previewSnapshot>>();
    let firstOpen: Parameters<typeof previewSnapshot>[0] | undefined;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'open' && !firstOpen) { firstOpen = request; return opened.promise; }
        return previewSnapshot(request);
    });
    const { result, rerender } = renderHook(({ open }) => useVoiceCheck(open), { initialProps: { open: true } });
    await waitFor(() => expect(firstOpen).toBeDefined());
    rerender({ open: false });
    await waitFor(() => expect(vi.mocked(voicePreviewApi.request).mock.calls.some(([request]) => request.action === 'close' && request.sessionId === firstOpen!.sessionId && request.epoch === null)).toBe(true));
    rerender({ open: true });
    await waitFor(() => expect(result.current.preview?.sessionId).toBeGreaterThan(firstOpen!.sessionId));
    const currentSession = result.current.preview!.sessionId;
    await act(async () => opened.resolve(previewSnapshot(firstOpen!, { state: 'playing' })));
    expect(result.current.preview?.sessionId).toBe(currentSession);
    expect(result.current.preview?.state).not.toBe('playing');
    expect(result.current.safeOutput).toBe(false);
});

it('hiddenとエンジン停止で試聴sessionを終了し、自動的には再開しない', async () => {
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.epoch).toBe('engine-epoch'));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.preview?.state).toBe('closed');
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.preview?.state).toBe('closed');
    await act(async () => { await result.current.preparePreview(); });
    await act(async () => emit('audio-stream-error', null));
    expect(result.current.preview?.state).toBe('closed');
    expect(result.current.safeOutput).toBe(false);
    expect(vi.mocked(voicePreviewApi.request).mock.calls.some(([request]) => request.action === 'start')).toBe(false);
});

it('停止失敗を残し再試行でき、状態pollだけでは警告を消さない', async () => {
    let failStop = true;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'stop' && failStop) throw new Error('stop unavailable');
        return previewSnapshot(request, { state: request.action === 'stop' ? 'stopped' : 'idle' });
    });
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.epoch).toBe('engine-epoch'));
    await act(async () => { await result.current.handleStopPreview(); });
    expect(result.current.stopUnconfirmed).toBe(true);
    expect(result.current.previewError).toContain('stop unavailable');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(result.current.stopUnconfirmed).toBe(true);
    failStop = false;
    await act(async () => { await result.current.handleStopPreview(); });
    expect(result.current.stopUnconfirmed).toBe(false);
    expect(result.current.previewError).toBe('');
});


it('update応答待ちのstatus追越しを防ぎ、次の変更へ確定したA/B・loop・音量合わせを引き継ぐ', async () => {
    let options = { source: 'processed' as 'raw' | 'processed', loopPlayback: true, levelMatch: false };
    let pending: ReturnType<typeof deferred<ReturnType<typeof previewSnapshot>>> | undefined;
    let pendingRequest: Parameters<typeof previewSnapshot>[0] | undefined;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'update') {
            options = { source: request.source, loopPlayback: request.loopPlayback, levelMatch: request.levelMatch };
            pendingRequest = request;
            pending = deferred<ReturnType<typeof previewSnapshot>>();
            return pending.promise;
        }
        return previewSnapshot(request, { state: 'playing', ...options });
    });
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.state).toBe('playing'));
    const changes = [
        () => result.current.handleSourceChange('raw'),
        () => result.current.setLoopPlayback(false),
        () => result.current.setLevelMatch(true),
    ];
    for (const change of changes) {
        pending = undefined;
        act(() => { void change(); });
        await waitFor(() => expect(pending).toBeDefined());
        const statusCount = vi.mocked(voicePreviewApi.request).mock.calls.filter(([request]) => request.action === 'status').length;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
        expect(vi.mocked(voicePreviewApi.request).mock.calls.filter(([request]) => request.action === 'status')).toHaveLength(statusCount);
        await act(async () => pending!.resolve(previewSnapshot(pendingRequest!, { state: 'playing', ...options })));
        expect(result.current.source).toBe(options.source);
        expect(result.current.loopPlayback).toBe(options.loopPlayback);
        expect(result.current.levelMatch).toBe(options.levelMatch);
    }
    const updates = vi.mocked(voicePreviewApi.request).mock.calls.map(([request]) => request).filter(request => request.action === 'update');
    expect(updates).toEqual([
        expect.objectContaining({ source: 'raw', loopPlayback: true, levelMatch: false }),
        expect.objectContaining({ source: 'raw', loopPlayback: false, levelMatch: false }),
        expect.objectContaining({ source: 'raw', loopPlayback: false, levelMatch: true }),
    ]);
});

it('devices応答待ちは後発statusと他の一覧取得を抑止し、取得した候補を必ず表示する', async () => {
    const listed = deferred<ReturnType<typeof previewSnapshot>>();
    let deviceRequest: Parameters<typeof previewSnapshot>[0] | undefined;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'devices') { deviceRequest = request; return listed.promise; }
        return previewSnapshot(request);
    });
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.epoch).toBe('engine-epoch'));
    act(() => { result.current.setSafeOutput(true); void result.current.refreshPreviewDevices(); });
    await waitFor(() => expect(deviceRequest).toBeDefined());
    const statusCount = vi.mocked(voicePreviewApi.request).mock.calls.filter(([request]) => request.action === 'status').length;
    await act(async () => { await result.current.refreshPreviewDevices(); await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(vi.mocked(voicePreviewApi.request).mock.calls.filter(([request]) => request.action === 'devices')).toHaveLength(1);
    expect(vi.mocked(voicePreviewApi.request).mock.calls.filter(([request]) => request.action === 'status')).toHaveLength(statusCount);
    await act(async () => listed.resolve(previewSnapshot(deviceRequest!, { devices: [{ id: 'new-hp', name: 'New headphones' }] })));
    expect(result.current.previewDevices).toEqual([{ id: 'new-hp', name: 'New headphones' }]);
    expect(result.current.safeOutput).toBe(false);
    expect(result.current.previewBusy).toBe(false);
});

it('操作前に開始したstatusが操作後に返っても確定した表示を巻き戻さない', async () => {
    const oldStatus = deferred<ReturnType<typeof previewSnapshot>>();
    let statusRequest: Parameters<typeof previewSnapshot>[0] | undefined;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'status') { statusRequest = request; return oldStatus.promise; }
        return previewSnapshot(request, { state: 'playing', source: request.action === 'update' ? request.source : 'processed' });
    });
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(statusRequest).toBeDefined());
    await act(async () => { await result.current.handleSourceChange('raw'); });
    await act(async () => oldStatus.resolve(previewSnapshot(statusRequest!, { state: 'playing', source: 'processed' })));
    expect(result.current.source).toBe('raw');
    expect(result.current.preview?.source).toBe('raw');
});


const singingDraft = (): CandidateDraft => ({ epoch: 'builtin-epoch', revision: '4', draftRevision: 1,
    config: { active: true, preset: 'singing', amount: 0.7, singing: defaultSinging } });
const candidateFor = (draft: CandidateDraft): BuiltinCandidate => ({ id: 'candidate-1', recordingId: 9, baseRevision: draft.revision, state: 'preparing', config: draft.config,
    sampleRate: 48000, sourceFrames: 1000, renderedFrames: 0, algorithmicLatencyFrames: 0, filterPhase: 'minimumPhase', samplePeak: null, error: null });
it('候補を準備してread-only poll後、原音/候補を同位置updateし通常送出は変更しない', async () => {
    const draft = singingDraft();
    let candidate: BuiltinCandidate | null = null;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'prepare_candidate') candidate = candidateFor(draft);
        if (request.action === 'candidate_status' && candidate) candidate = { ...candidate, state: 'ready', renderedFrames: 1000, samplePeak: 0.2 };
        return previewSnapshot(request, { recordingId: 9, durationMs: 1000, positionMs: 200,
            state: request.action === 'start' || request.action === 'update' ? 'playing' : 'idle', candidate,
            devices: request.action === 'devices' ? [{ id: 'hp', name: 'Headphones' }] : [] });
    });
    const legacy = vi.spyOn(audioApi, 'setBuiltInEffects');
    const { result } = renderHook(() => useVoiceCheck(true, draft));
    await waitFor(() => expect(result.current.preview?.recordingId).toBe(9));
    await act(async () => { await result.current.prepareCandidate(); });
    await waitFor(() => expect(result.current.candidate?.state).toBe('ready'));
    await act(async () => { await result.current.refreshPreviewDevices(); });
    act(() => result.current.setPreviewDeviceId('hp')); act(() => result.current.setSafeOutput(true));
    await act(async () => { await result.current.handleTogglePlayback(); });
    await act(async () => { await result.current.handleSourceChange('raw'); });
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepare_candidate', recordingId: 9, expectedRevision: '4', config: draft.config }));
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', candidateId: 'candidate-1' }));
    const poll = vi.mocked(voicePreviewApi.request).mock.calls.find(([request]) => request.action === 'candidate_status')![0];
    const prepared = vi.mocked(voicePreviewApi.request).mock.calls.find(([request]) => request.action === 'prepare_candidate')![0];
    expect(poll.operationId).toBe(prepared.operationId);
    expect(result.current.preview?.positionMs).toBe(200);
    expect(legacy).not.toHaveBeenCalled();
});
it.each(['singing', 'reverb'])('%s下書き変更後の遅い候補応答を採用せず、同じ録音IDでも旧候補を再生しない', async change => {
    const draft = singingDraft(); const pending = deferred<ReturnType<typeof previewSnapshot>>();
    let request: Parameters<typeof previewSnapshot>[0] | undefined;
    vi.mocked(voicePreviewApi.request).mockImplementation(async value => {
        if (value.action === 'prepare_candidate') { request = value; return pending.promise; }
        return previewSnapshot(value, { recordingId: 9 });
    });
    const { result, rerender } = renderHook(({ draft }) => useVoiceCheck(true, draft), { initialProps: { draft } });
    await waitFor(() => expect(result.current.preview?.recordingId).toBe(9));
    act(() => { void result.current.prepareCandidate(); });
    await waitFor(() => expect(request).toBeDefined());
    rerender({ draft: { ...draft, draftRevision: 2, config: change === 'singing'
        ? { ...draft.config, singing: { ...defaultSinging, lowCutHz: 120 } }
        : { ...draft.config, reverb: { ...defaultReverb, enabled: true } } } });
    await act(async () => pending.resolve(previewSnapshot(request!, { recordingId: 9, candidate: { ...candidateFor(draft), state: 'ready' } })));
    expect(result.current.candidate).toBeNull();
    expect(vi.mocked(voicePreviewApi.request).mock.calls.some(([value]) => value.action === 'start')).toBe(false);
});
it('候補作成後の下書き変更はcancelし、hidden/再録音はsessionをcloseする', async () => {
    const draft = singingDraft();
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => previewSnapshot(request, { recordingId: 9,
        candidate: request.action === 'prepare_candidate' ? { ...candidateFor(draft), state: 'ready' } : null }));
    const { result, rerender } = renderHook(({ draft }) => useVoiceCheck(true, draft), { initialProps: { draft } });
    await waitFor(() => expect(result.current.preview?.recordingId).toBe(9));
    await act(async () => { await result.current.prepareCandidate(); });
    rerender({ draft: { ...draft, draftRevision: 2 } });
    await waitFor(() => expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel_candidate', candidateId: 'candidate-1' })));
    expect(result.current.candidate).toBeNull();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
    hidden.mockRestore();
});


it('固定preview失敗のlocaleだけを解決し、stop未確認/device/安全確認と要求数を保つ', async()=>{
    const store=createLocaleStore(()=> 'ja',()=>true);
    const {result}=renderHook(()=>useVoiceCheck(true),{wrapper:({children})=><LocaleProvider store={store}>{children}</LocaleProvider>});
    await waitFor(()=>expect(result.current.preview?.state).toBe('idle'));
    act(()=>{result.current.setPreviewDeviceId('exact-device');result.current.setSafeOutput(true);});
    const original=vi.mocked(voicePreviewApi.request).getMockImplementation()!;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request=>{if(request.action==='stop')throw new FixedClientError('preview.invalidSnapshot');return original(request);});
    await act(async()=>{await result.current.handleStopPreview();});
    expect(result.current.stopUnconfirmed).toBe(true);expect(result.current.previewError).toContain('試聴の状態を確認できません。');
    const calls=vi.mocked(voicePreviewApi.request).mock.calls.length;const subscriptions=vi.mocked(listen).mock.calls.length;
    act(()=>{store.setLocale('en');});
    expect(result.current.previewError).toContain('Could not verify the preview state.');
    expect(result.current.stopUnconfirmed).toBe(true);expect(result.current.previewDeviceId).toBe('exact-device');expect(result.current.safeOutput).toBe(true);
    expect(voicePreviewApi.request).toHaveBeenCalledTimes(calls);expect(listen).toHaveBeenCalledTimes(subscriptions);
});

const noiseSettings = { enabled: true, mode: 'smart', strength: 0.8, voiceGuard: true,
    learnedMix: 0.6, hasLearnedMix: false, profileRms: null, backend: 'nnnoiseless-0.5.2', model: 'bundled-e6de5fbfadf7ec91' };
it('NR候補は明示採用後だけUndo/Redoでき、応答前の自己変更通知で履歴を失わない', async () => {
    let candidate: BuiltinCandidate | null = null;
    let basis = 'nr-basis'; let token: string | null = null; let redo: string | null = null;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'prepare_noise') candidate = { ...candidateFor(singingDraft()), baseRevision: basis, state: 'ready', noise: { ...noiseSettings, strength: 0.6 } };
        if (request.action === 'apply_noise') { emit('audio-conditions-changed', null); basis = 'nr-after-apply'; token = 'nr-undo'; candidate = null; }
        if (request.action === 'undo_noise') { emit('audio-conditions-changed', null); basis = 'nr-after-undo'; token = null; redo = 'nr-redo'; }
        if (request.action === 'redo_noise') { emit('audio-conditions-changed', null); basis = 'nr-after-redo'; token = 'nr-undo-2'; redo = null; }
        return previewSnapshot(request, { recordingId: 9, noiseBasis: basis, noiseSettings, noiseUndoToken: token, noiseRedoToken: redo, noisePending: false, candidate });
    });
    const legacy = vi.spyOn(audioApi, 'setNoiseControlConfig');
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.noiseBasis).toBe('nr-basis'));
    await act(async () => { await result.current.prepareNoise('weaker'); });
    expect(result.current.candidate?.noise?.strength).toBe(0.6);
    expect(result.current.candidateMode).toBe('noise');
    expect(legacy).not.toHaveBeenCalled();
    expect(vi.mocked(voicePreviewApi.request).mock.calls.some(([r]) => r.action === 'apply_noise')).toBe(false);
    await act(async () => { await result.current.applyNoise(); });
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'apply_noise', expectedBasis: 'nr-basis', candidateId: 'candidate-1' }));
    expect(result.current.preview?.noiseUndoToken).toBe('nr-undo');
    await act(async () => { await result.current.undoNoise(); });
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'undo_noise', token: 'nr-undo' }));
    expect(result.current.preview?.noiseUndoToken).toBeNull();
    expect(result.current.preview?.noiseRedoToken).toBe('nr-redo');
    await act(async () => { await result.current.redoNoise(); });
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'redo_noise', token: 'nr-redo' }));
    expect(result.current.preview?.noiseUndoToken).toBe('nr-undo-2');
    expect(result.current.preview?.noiseRedoToken).toBeNull();
    expect(legacy).not.toHaveBeenCalled();
});
it('画面非表示後の遅いNR候補を採用せず、その候補だけを取消する', async () => {
    const pending = deferred<ReturnType<typeof previewSnapshot>>();
    let prepare: Parameters<typeof previewSnapshot>[0] | undefined;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'prepare_noise') { prepare = request; return pending.promise; }
        return previewSnapshot(request, { recordingId: 9, noiseBasis: 'nr-basis', noiseSettings, noisePending: false });
    });
    const { result } = renderHook(() => useVoiceCheck(true));
    await waitFor(() => expect(result.current.preview?.noiseBasis).toBe('nr-basis'));
    act(() => { void result.current.prepareNoise('stronger'); });
    await waitFor(() => expect(prepare).toBeDefined());
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => pending.resolve(previewSnapshot(prepare!, { recordingId: 9, noiseBasis: 'nr-basis', candidate: { ...candidateFor(singingDraft()), baseRevision: 'nr-basis', state: 'ready', noise: noiseSettings } })));
    expect(result.current.candidate).toBeNull();
    expect(vi.mocked(voicePreviewApi.request).mock.calls.some(([r]) => r.action === 'apply_noise' || r.action === 'start')).toBe(false);
});
