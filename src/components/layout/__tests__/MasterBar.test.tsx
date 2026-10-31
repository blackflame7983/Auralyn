import { message } from '@/i18n/messages';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MasterBar } from '../MasterBar';
import { audioApi, type EngineRuntimeStats } from '../../../api/audio';

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
    vi.mocked(listen).mockImplementation((event, callback) => {
        if (event !== 'audio-started') return Promise.resolve(vi.fn());
        started = () => callback({ event, id: 1, payload: undefined });
        return new Promise((resolve) => {
            finishListening = () => resolve(unlistenStarted);
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
        // 常設の停止表示はヘッダーへ集約し、メーターの状態名は残す。
        expect(screen.queryByText('音声停止中')).not.toBeInTheDocument();
        expect(screen.getByRole('meter', { name: '出力' })).toHaveAttribute('aria-valuetext', '音声停止中');
        expect(screen.queryByText('VST有効')).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        const details = screen.getByRole('button', { name: '音声処理の詳細' });
        details.focus();
        fireEvent.click(details);
        expect(screen.getByRole('dialog', { name: '音声処理の詳細' })).toBeInTheDocument();
        expect(screen.getByText('Wasapi')).toBeInTheDocument();
        expect(screen.queryByText('48,000 Hz')).not.toBeInTheDocument();
        expect(screen.queryByText('推定 41.3ms')).not.toBeInTheDocument();
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        await act(async () => { await vi.advanceTimersByTimeAsync(10); });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(details).toHaveFocus();
        view.rerender(<MasterBar host="Wasapi" sampleRate={48000} bufferSize={512} isRunning />);
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.getByText('VST有効')).toBeInTheDocument();
        expect(screen.queryByText('推定 41.3ms')).not.toBeInTheDocument();
        fireEvent.click(details);
        expect(screen.queryByText('推定 41.3ms')).not.toBeInTheDocument();
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
        expect(unlistenStarted).toHaveBeenCalledOnce();
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
