import { message } from '@/i18n/messages';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MasterBar } from '../MasterBar';
import { audioApi, type EngineRuntimeStats, type ProcessingHealthSnapshot } from '../../../api/audio';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@/api/audio', () => ({
    audioApi: { getEngineRuntimeStats: vi.fn().mockRejectedValue(new Error('停止中')), getAudioState: vi.fn(), setNoiseReduction: vi.fn().mockResolvedValue(undefined) },
}));

let running: boolean;
let gain: number;
let initialized: boolean;
let finishListening: () => void;
let started: () => void;
let unlistenStarted: () => void;
let audioStartedReady: Array<(stop: () => void) => void>;
let eventHandlers: Map<string, Set<(event: { event: string; id: number; payload: unknown }) => void>>;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('vst_host_output_gain', '50');
    running = false;
    gain = 1;
    initialized = false;
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: true, config: null });
    unlistenStarted = vi.fn();
    eventHandlers = new Map();
    audioStartedReady = [];
    vi.mocked(listen).mockImplementation((event, callback) => {
        const handlers = eventHandlers.get(event) ?? new Set();
        handlers.add(callback);
        eventHandlers.set(event, handlers);
        if (event !== 'audio-started') return Promise.resolve(vi.fn());
        started = () => {
            for (const handler of eventHandlers.get('audio-started') ?? []) handler({ event, id: 1, payload: undefined });
        };
        return new Promise((resolve) => {
            audioStartedReady.push(resolve);
            finishListening = () => {
                for (const ready of audioStartedReady.splice(0)) ready(unlistenStarted);
            };
        });
    });
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
        const { request } = args as { request: { action: string; value?: number } };
        if (request.action === 'initialize' && running && !initialized) {
            gain = request.value!;
            initialized = true;
        }
        return {
            revision: 1, gain, confirmedGain: gain, running, settled: running,
            streamFailed: false, id: 0, phase: 'idle', progress: 0,
            proposal: null, playing: false, error: null, devices: [],
        };
    });
});

afterEach(async () => {
    cleanup();
    await act(async () => {});
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('起動時の保存ゲイン復元', () => {
    it('古い要求の遅い失敗を、新しい要求の成功後の再試行として残さない', async () => {
        const original = vi.mocked(invoke).getMockImplementation()!;
        let rejectFirst!: (error: Error) => void;
        const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
        const values: number[] = [];
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'set_output_gain') {
                const value = (args as { value: number }).value;
                values.push(value);
                if (values.length === 1) return firstWrite;
                gain = value;
                return;
            }
            return original(command, args);
        });
        running = true;
        render(<MasterBar isRunning />);
        await act(async () => { finishListening(); });
        const slider = screen.getByRole('slider', { name: '出力音量' });
        fireEvent.keyDown(slider, { key: 'ArrowRight' });
        await act(async () => { await vi.advanceTimersByTimeAsync(35); });
        expect(values).toEqual([1.01]);
        fireEvent.keyDown(slider, { key: 'ArrowLeft' });
        await act(async () => { await vi.advanceTimersByTimeAsync(35); });
        await act(async () => { rejectFirst(new Error('古い要求だけが失敗')); });
        expect(values).toEqual([1.01, 1]);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('100');
        expect(slider).toHaveAttribute('aria-valuenow', '100');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    it('child不在では保存gainを保持して初期化を送らず、明示開始後にだけ再試行する', async () => {
        vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: false, config: null });
        render(<MasterBar />);
        await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(5100); });
        expect(invoke).not.toHaveBeenCalled();
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: true, config: null });
        await act(async () => { running = true; started(); });
        expect(gain).toBe(.5);
        expect(invoke).toHaveBeenCalledWith('auto_gain', { request: { action: 'initialize', value: .5 } });
    });

    it.each(['dead', 'pipe'])('status取得失敗%s後の背景取得でも保存gainを上書きしない', async failure => {
        vi.mocked(invoke).mockRejectedValueOnce(new Error('old reader exited'));
        render(<MasterBar />);
        await act(async () => { finishListening(); });
        const calls = vi.mocked(invoke).mock.calls.length;
        vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: failure === 'pipe', config: null });
        if (failure === 'pipe') vi.mocked(invoke).mockRejectedValue(new Error('existing pipe broken'));
        await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
        if (failure === 'dead') expect(invoke).toHaveBeenCalledTimes(calls);
        else expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(calls);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
        if (failure === 'dead') expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        else expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    it('手動設定の失敗は背景の状態取得が成功しても消さない', async () => {
        const original = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === 'set_output_gain') throw new Error('manual request failed');
            return original(command, args);
        });
        running = true;
        render(<MasterBar isRunning />);
        await act(async () => { finishListening(); });
        const slider = screen.getByRole('slider', { name: '出力音量' });
        slider.focus();
        fireEvent.keyDown(slider, { key: 'ArrowRight' });
        await act(async () => { await vi.advanceTimersByTimeAsync(60); });
        expect(screen.getByRole('alert')).toHaveTextContent('音量を確認できません');
        await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
    });

    it('停止状態の取得中に開始通知が来ても、初期化後に保存値を再送する', async () => {
        let resolveInitial!: (value: unknown) => void;
        vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { resolveInitial = resolve; }));
        render(<MasterBar />);
        await act(async () => { finishListening(); });
        await act(async () => {
            running = true;
            started();
            resolveInitial({ revision: 1, gain: 1, confirmedGain: 1, running: false, settled: false, streamFailed: false });
        });
        expect(gain).toBe(0.5);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('一時的な起動確認失敗を再試行して警告を消し、手動再操作を要求し続けない', async () => {
        render(<MasterBar />);
        await act(async () => { finishListening(); });
        vi.mocked(invoke).mockRejectedValueOnce(new Error('engine warming up'));
        await act(async () => { running = true; started(); });
        expect(screen.getByRole('alert')).toHaveTextContent('音量を確認できません');
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
        await act(async () => {
            running = true;
            await vi.advanceTimersByTimeAsync(1100);
        });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(gain).toBe(0.5);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
    });

    it('復元失敗中に行った明示変更を定期再試行で上書きしない', async () => {
        render(<MasterBar />);
        await act(async () => { finishListening(); });
        vi.mocked(invoke).mockRejectedValueOnce(new Error('engine warming up'));
        await act(async () => { running = true; started(); });
        await act(async () => {
            running = true;
            initialized = true;
            gain = 0.7;
            await vi.advanceTimersByTimeAsync(1100);
        });
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(gain).toBe(0.7);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('70');
    });

    it('技術情報は開いたときだけ表示し、停止中の設定値を稼働中の遅延と混同しない', async () => {
        vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue({
            globalBypass: false, enabledPluginCount: 2, activePluginCount: 2,
            noiseReductionEnabled: true, noiseReductionActive: true,
        } as EngineRuntimeStats);
        const view = render(<MasterBar host="Wasapi" sampleRate={48000} bufferSize={512} isRunning={false} />);
        await act(async () => { finishListening(); });
        // 停止の札はホームの「いまの状態」へ集約する。右の列では、メーター自身の状態の語だけが残る。
        expect(screen.getAllByText('音声停止中').every(node => node.closest('[role="meter"]') !== null || node.classList.contains('invisible'))).toBe(true);
        expect(screen.getByRole('meter', { name: '出力' })).toHaveAttribute('aria-valuetext', '音声停止中');
        expect(screen.queryByText('VST有効')).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        const details = screen.getByRole('button', { name: '音声処理の詳細' });
        details.focus();
        fireEvent.click(details);
        expect(screen.getByRole('dialog', { name: '音声処理の詳細' })).toBeInTheDocument();
        expect(screen.getByText('WASAPI')).toBeInTheDocument();
        expect(screen.queryByText('48,000 Hz')).not.toBeInTheDocument();
        expect(screen.queryByText('推定 41.3 ms')).not.toBeInTheDocument();
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        await act(async () => { await vi.advanceTimersByTimeAsync(10); });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(details).toHaveFocus();
        view.rerender(<MasterBar host="Wasapi" sampleRate={48000} bufferSize={512} isRunning />);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.getByText('VST有効')).toBeInTheDocument();
        expect(screen.queryByText('推定 41.3 ms')).not.toBeInTheDocument();
        fireEvent.click(details);
        expect(screen.queryByText('推定 41.3 ms')).not.toBeInTheDocument();
        expect(screen.getByText(/根拠情報を未取得です/)).toBeInTheDocument();
        expect(screen.getByText('48,000 Hz')).toBeInTheDocument();
    });

    it('購読前の開始をreloadから推測せず、statusで保存値を100%へ変更しない', async () => {
        render(<MasterBar />);
        await act(async () => {});
        await act(async () => {
            // 起動が購読完了より先でも、完了後の初期取得で拾う。
            running = true;
            await vi.advanceTimersByTimeAsync(1500);
        });
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
        expect(invoke).not.toHaveBeenCalled();
        await act(async () => { finishListening(); });
        expect(gain).toBe(1);
        expect(vi.mocked(invoke).mock.calls.some(([, args]) => (args as { request: { action: string } }).request.action === 'initialize')).toBe(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
    });

    it('停止前の遅いstats応答を捨て、再開後のDefaultを古い固定要求で上書きしない', async () => {
        let old!: (stats: EngineRuntimeStats) => void;
        const metadata = { schemaVersion: 1 as const, streamRunning: true, nominalSampleRateHz: 48000, fixedBufferRequestFrames: null, nrConfiguredEnabled: true, nrProcessingRateHz: 48000, nrProcessingFrameSamples: 480, vstReportedLatencySamples: 0, signalCorrespondence: 'unmeasured' as const };
        const latest = { globalBypass: false, glitchCount: 0, enabledPluginCount: 0, noiseReductionMode: 'low', latencyMetadata: metadata } as EngineRuntimeStats;
        vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(latest).mockReturnValueOnce(new Promise(resolve => { old = resolve; }));
        const view = render(<MasterBar isRunning />);
        await act(async () => { finishListening(); });
        view.rerender(<MasterBar isRunning={false} />);
        fireEvent.click(screen.getByRole('button', { name: '音声処理の詳細' }));
        await act(async () => old({ ...latest, latencyMetadata: { ...metadata, fixedBufferRequestFrames: 256 } }));
        expect(screen.queryByText('256 sample / 5.33 ms')).not.toBeInTheDocument();
        view.rerender(<MasterBar isRunning />);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.getByText('デバイス既定（固定フレーム数は未指定）')).toBeInTheDocument();
        expect(screen.queryByText('256 sample / 5.33 ms')).not.toBeInTheDocument();
    });

    it('購読完了後に開始した場合もイベントから復元する', async () => {
        render(<MasterBar />);
        await act(async () => { finishListening(); });
        expect(gain).toBe(1);
        await act(async () => {
            running = true;
            started();
        });
        expect(gain).toBe(0.5);
        expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
    });

    it('購読待ち中に閉じた場合は遅い初期化や定期取得を残さない', async () => {
        const view = render(<MasterBar />);
        view.unmount();
        await act(async () => {
            finishListening();
            await vi.advanceTimersByTimeAsync(1500);
        });
        expect(unlistenStarted).toHaveBeenCalled();
        expect(invoke).not.toHaveBeenCalled();
    });
});

it('保存30%と既定gain1の遅いstatusがbootstrap相当の反映後へ届いても保存原文を保持する', async () => {
    localStorage.setItem('vst_host_output_gain', '30'); running = true;
    let finish!: (state: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<MasterBar isRunning />); await act(async () => finishListening());
    gain = .3; initialized = true;
    await act(async () => { finish({ revision: 0, gain: 1, confirmedGain: 1, running: true, settled: true, streamFailed: false }); await vi.advanceTimersByTimeAsync(2100); });
    expect(localStorage.getItem('vst_host_output_gain')).toBe('30');
    expect(vi.mocked(invoke).mock.calls.some(([, args]) => (args as { request: { action: string } }).request.action === 'initialize')).toBe(false);
    view.unmount(); render(<MasterBar isRunning />); await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(1100); });
    expect(localStorage.getItem('vst_host_output_gain')).toBe('30');
    expect(gain).toBe(.3);
});


it('gainの固定失敗noticeはlocaleに追従し、購読/初期化/保存を再実行しない', async()=>{
    const store=createLocaleStore(()=> 'ja',()=>true);
    vi.mocked(invoke).mockResolvedValue({revision:1,gain:.5,confirmedGain:.5,running:true,settled:false,streamFailed:true});
    render(<LocaleProvider store={store}><MasterBar isRunning/></LocaleProvider>);
    await act(async()=>{finishListening();started();});
    const alert=screen.getByRole('alert');expect(alert).toHaveAttribute('title','音声状態を確認できません。再試行してください。');
    const calls=vi.mocked(invoke).mock.calls.length;const subscriptions=vi.mocked(listen).mock.calls.length;
    act(()=>{store.setLocale('en');});
    expect(screen.getByRole('alert')).toBe(alert);expect(alert).toHaveAttribute('title','Could not verify the audio state. Try again.');
    expect(invoke).toHaveBeenCalledTimes(calls);expect(listen).toHaveBeenCalledTimes(subscriptions);expect(localStorage.getItem('vst_host_output_gain')).toBe('50');
});

it.each([
    ['ja', false], ['en', false], ['ja', true], ['en', true],
] as const)('長い状態・配信側停止でも常設操作と詳細の状態を保持する（%s・停止=%s）', async (locale, failed) => {
    const stats = {
        globalBypass: false, enabledPluginCount: 0, activePluginCount: 0,
        noiseReductionEnabled: true, noiseReductionMode: 'high', speechDetected: true,
        latencyMetadata: { processingContext: 'broadcastWorker', broadcastState: failed ? 'failed' : 'running' },
    } as EngineRuntimeStats;
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue(stats);
    const voice = vi.fn();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <MasterBar isRunning processReady host="WASAPI" onOpenVoiceCheck={voice} />
    </LocaleProvider>);
    await act(async () => { finishListening(); });
    const state = message(locale, failed ? 'liveOutput.shortFailed' : 'liveOutput.branchLabel');
    if (failed) expect(screen.getByText(state)).toBeVisible();
    else expect(screen.queryByText(state)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: message(locale, 'master.voice')})).not.toBeInTheDocument();
    expect(voice).not.toHaveBeenCalled();
    expect(audioApi.setNoiseReduction).not.toHaveBeenCalled();
    expect(screen.getByRole('slider', { name: message(locale, 'master.outputGain') })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'master.details') }));
    expect(screen.getByRole('dialog', { name: message(locale, 'master.detailsTitle') })).toBeVisible();
    expect(screen.getAllByText(state)).toHaveLength(failed ? 2 : 1);
});

it.each([null, false])('稼働表示が残っていてもready=%sを正常色・原音と表示しない', async processReady => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue({globalBypass: false, enabledPluginCount: 0, activePluginCount: 0} as EngineRuntimeStats);
    render(<MasterBar isRunning processReady={processReady} host="WASAPI" />);
    await act(async () => finishListening());
    const state = screen.getByText(processReady === null ? message('ja', 'master.unverified') : message('ja', 'prep.failed'));
    expect(state.className).not.toContain('text-success');
    expect(screen.queryByText('原音')).not.toBeInTheDocument();
});

it('音切れ増加の表示は10秒保持し、詳細を開けて、再開始やカウンタ減少を誤検出しない', async () => {
    let count = 4;
    const openAudioTuning = vi.fn();
    vi.mocked(audioApi.getEngineRuntimeStats).mockImplementation(async () => ({ glitchCount: count, enabledPluginCount: 0, activePluginCount: 0 } as EngineRuntimeStats));
    const view = render(<MasterBar isRunning onOpenAudioTuning={openAudioTuning} />);
    await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(0); });
    count = 5; await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const button = screen.getByRole('button', { name: '直近で音切れを検出' });
    fireEvent.click(screen.getByRole('button', { name: '途切れにくくする' }));
    expect(openAudioTuning).toHaveBeenCalledOnce();
    expect(button).toHaveAttribute('title', '直近で音切れを検出');
    button.focus(); fireEvent.click(button);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(screen.getByRole('button', { name: '直近で音切れを検出' })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByRole('button', { name: '直近で音切れを検出' })).toBeNull();
    count = 0; await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByRole('button', { name: '直近で音切れを検出' })).toBeNull();
    view.rerender(<MasterBar isRunning={false} />);
    count = 10; view.rerender(<MasterBar isRunning />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByRole('button', { name: '直近で音切れを検出' })).toBeNull();
});

it('処理停止を言葉と印で示し、進みが戻ると消し、詳細に直近の回数を出す', async () => {
    const health = (state: 'stalled' | 'normal', late: number, underflow: number) => ({
        glitchCount: 4,
        enabledPluginCount: 0,
        activePluginCount: 0,
        processingHealth: { state, stallKind: state === 'stalled' ? 'processing' as const : null, stalledMs: state === 'stalled' ? 800 : 0, recentLate: late, recentUnderflow: underflow, windowSecs: 60 },
    });
    let current = health('stalled', 12, 4);
    vi.mocked(audioApi.getEngineRuntimeStats).mockImplementation(async () => current as EngineRuntimeStats);
    render(<MasterBar isRunning />);
    await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(0); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('音声処理が止まっています（無音ではなく処理が進んでいません）');
    expect(alert.querySelector('svg')).toBeTruthy();
    expect(alert).toHaveTextContent('自動では再開しません');
    fireEvent.click(screen.getByRole('button', { name: '音声処理の詳細' }));
    fireEvent.click(screen.getByText('診断情報'));
    expect(screen.getByText('直近60秒：遅着 12回 / 音切れの可能性 4回')).toBeVisible();
    expect(screen.getByText('直近1分の回数が多いです。')).toBeVisible();
    expect(screen.getByText('累積のグリッチ回数')).toBeVisible();
    expect(screen.getByText('4')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    current = health('normal', 1, 0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByText('音声処理が止まっています（無音ではなく処理が進んでいません）')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '音声処理の詳細' }));
    fireEvent.click(screen.getByText('診断情報'));
    expect(screen.getByText('直近60秒：遅着 1回 / 音切れの可能性 0回')).toBeVisible();
    expect(screen.queryByText('直近1分の回数が多いです。')).toBeNull();
});

const stalledEvent = (): ProcessingHealthSnapshot => ({
    state: 'stalled', stallKind: 'outputCallback', stalledMs: 800, recentLate: 0, recentUnderflow: 0, windowSecs: 60,
});
const emit = (event: string, payload?: unknown) => {
    eventHandlers.get(event)?.forEach(callback => callback({ event, id: 1, payload }));
};

it('イベントの停止を受けて表示し、稼働していなければ出さない', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValue(new Error('offline'));
    const view = render(<MasterBar isRunning />);
    await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { emit('audio-processing-health', stalledEvent()); });
    expect(screen.getByRole('alert')).toHaveTextContent('音声処理が止まっています（無音ではなく処理が進んでいません）');
    view.rerender(<MasterBar isRunning={false} />);
    expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['audio-stopped', 'audio-error', 'audio-stream-error', 'audio-started'])('%sでイベントの停止表示を消す', async event => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValue(new Error('offline'));
    render(<MasterBar isRunning />);
    await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { emit('audio-processing-health', stalledEvent()); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await act(async () => { emit(event); });
    expect(screen.queryByText('音声処理が止まっています（無音ではなく処理が進んでいません）')).toBeNull();
});

it('統計が来ないイベントの停止は2.5秒で消える', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockRejectedValue(new Error('offline'));
    render(<MasterBar isRunning />);
    await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { emit('audio-processing-health', stalledEvent()); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByText('音声処理が止まっています（無音ではなく処理が進んでいません）')).toBeNull();
});

it('英語でも処理停止と直近回数を言葉で示す', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue({
        glitchCount: 2, enabledPluginCount: 0, activePluginCount: 0,
        processingHealth: { state: 'stalled', stallKind: 'outputCallback', stalledMs: 500, recentLate: 11, recentUnderflow: 3, windowSecs: 60 },
    } as EngineRuntimeStats);
    render(<LocaleProvider store={createLocaleStore(() => 'en', () => true)}><MasterBar isRunning /></LocaleProvider>);
    await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('alert')).toHaveTextContent('Audio processing has stopped');
    fireEvent.click(screen.getByRole('button', { name: message('en', 'master.details') }));
    fireEvent.click(screen.getByText(message('en', 'structure.diagnostics')));
    expect(screen.getByText('Last 60 s: late arrivals 11 / possible underruns 3')).toBeVisible();
});

it('統計を一度受け取った後に失敗したら、状態を取得できないと出す', async () => {
    vi.mocked(audioApi.getEngineRuntimeStats)
        .mockResolvedValueOnce({ glitchCount: 0, enabledPluginCount: 0, activePluginCount: 0 } as EngineRuntimeStats)
        .mockRejectedValue(new Error('offline'));
    render(<MasterBar isRunning />);
    await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('音声処理の状態を取得できません。')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('音声処理の状態を取得できません。')).toBeVisible();
    vi.mocked(audioApi.getEngineRuntimeStats).mockResolvedValue({ glitchCount: 0, enabledPluginCount: 0, activePluginCount: 0 } as EngineRuntimeStats);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByText('音声処理の状態を取得できません。')).toBeNull();
});

it('音切れ表示が詳細を開いている間に消えても常設の入口へフォーカスを戻す', async () => {
    let count = 0;
    vi.mocked(audioApi.getEngineRuntimeStats).mockImplementation(async () => ({ glitchCount: count, enabledPluginCount: 0, activePluginCount: 0 } as EngineRuntimeStats));
    render(<MasterBar isRunning />);
    await act(async () => { finishListening(); await vi.advanceTimersByTimeAsync(0); });
    count = 1;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const button = screen.getByRole('button', { name: '直近で音切れを検出' });
    button.focus(); fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(11000); });
    expect(button.isConnected).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('button', { name: message('ja', 'master.details') })).toHaveFocus();
});


it.each(['ja', 'en'] as const)('フッターの出力ラベルは操作用の文字で、数値だけ等幅にする（%s）', locale => {
    const { container } = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><MasterBar /></LocaleProvider>);
    const label = screen.getAllByText(message(locale, 'meter.output')).find(node => node.classList.contains('text-ui-control') || node.parentElement?.classList.contains('text-ui-control'))!;
    expect(label).toHaveClass('text-ui-control');
    expect(label).not.toHaveClass('font-mono');
    expect(label).not.toHaveClass('tracking-widest');
    expect(label).not.toHaveClass('text-xs');
    expect(container.querySelector('#master-output-gain')).toHaveClass('w-full');
    expect(container.querySelector('#master-output-gain')).not.toHaveClass('w-32');
    expect(screen.getByText('50%')).toHaveClass('font-mono');
});

it('出力音量は1つで、マウスで100%にでき、キーの刻みと30msの送信待ちを保つ', async () => {
    // JSDOMにないポインター座標・captureだけを補い、実際のRadix Sliderを操作する。
    vi.stubGlobal('PointerEvent', MouseEvent);
    try {
        const view = render(<MasterBar />);
        const sliders = screen.getAllByRole('slider', { name: '出力音量' });
        expect(sliders).toHaveLength(1);
        const slider = sliders[0];
        expect(slider.closest('#master-output-gain')).not.toBeNull();
        const root = slider.closest('[data-orientation="horizontal"].touch-none')!;
        vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 128 } as DOMRect);
        Object.assign(root, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
        fireEvent.pointerDown(root, { clientX: 64, button: 0, pointerType: 'mouse' });
        fireEvent.pointerUp(root);
        expect(slider).toHaveAttribute('aria-valuenow', '100');
        expect(slider).toHaveFocus();
        const writes = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'set_output_gain');
        expect(writes()).toHaveLength(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(29); });
        expect(writes()).toHaveLength(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(writes()).toEqual([['set_output_gain', { value: 1 }]]);
        for (const [key, expected] of [['ArrowRight', 101], ['ArrowLeft', 100], ['ArrowUp', 101], ['ArrowDown', 100], ['PageUp', 110], ['PageDown', 100], ['Home', 0], ['End', 200]] as const) {
            fireEvent.keyDown(slider, { key });
            expect(slider).toHaveAttribute('aria-valuenow', String(expected));
        }
        // 連続キー操作も従来どおり最後の値だけを送信する。
        await act(async () => { await vi.advanceTimersByTimeAsync(30); });
        expect(writes()).toEqual([['set_output_gain', { value: 1 }], ['set_output_gain', { value: 2 }]]);
        fireEvent.doubleClick(root);
        expect(slider).toHaveAttribute('aria-valuenow', '100');
        view.unmount();
    } finally { vi.unstubAllGlobals(); }
});

it.each([true, false])('出力メーターは右の列に常に1つ出す（稼働=%s）', isRunning => {
    render(<MasterBar isRunning={isRunning} />);
    expect(screen.getAllByRole('meter', { name: message('ja', 'meter.output') })).toHaveLength(1);
});
