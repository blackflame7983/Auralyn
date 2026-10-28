import { builtinApi, defaultSinging, defaultReverb, type BuiltinConfig } from '@/api/builtinEffects';
import { useSingingDraft } from '@/hooks/useSingingDraft';
import { voicePreviewApi } from '@/api/voiceCheckPreview';
import { previewSnapshot } from './previewFixture';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '@/api/audio';
import { VoiceCheckModal } from '../VoiceCheckModal';
import { LocaleProvider, useLocale } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';

const running = { running: true, streamFailed: false };
const stopped = { running: false, streamFailed: false };
const open = (onSettings = vi.fn()) => render(<VoiceCheckModal isOpen onClose={vi.fn()} onOpenAudioSettings={onSettings} />);
const record = () => screen.getByRole('button', { name: /録音開始/ });
const emit = (name: string) => {
    for (const [event, callback] of vi.mocked(listen).mock.calls) {
        if (event === name) callback({ event: name, id: 1, payload: null });
    }
};

beforeEach(() => {
    localStorage.clear();
    vi.spyOn(voicePreviewApi, 'request').mockImplementation(async request => previewSnapshot(request));
    vi.mocked(listen).mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({ config: null, is_running: true });
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue(running);
    vi.spyOn(audioApi, 'startVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'stopVoiceCheck').mockResolvedValue(undefined);
    vi.spyOn(audioApi, 'stopVoiceCheckPlayback').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('録音前は試聴を折りたたみ、録音完了後は開いて再生操作を表示する', async () => {
    open();
    const details = screen.getByText('試聴先と再生').closest('details')!;
    await waitFor(() => expect(details).not.toHaveAttribute('open'));
    expect(screen.getByText('マイクの音・出力音量・ミュートは変わりません。配信・通話に乗らないヘッドホンなどを選んでください。OBSのデスクトップ音声やループバックが試聴先を拾う場合は、試聴音も配信・通話へ流れます。')).not.toBeVisible();
    act(() => {
        for (const [event, callback] of vi.mocked(listen).mock.calls) {
            if (event === 'voice-check-state') callback({ event, id: 1, payload: { state: 'ready', position_ms: 0, duration_ms: 1000 } });
        }
    });
    await waitFor(() => expect(details).toHaveAttribute('open'));
    expect(screen.getByRole('button', { name: '選んだ試聴先で再生' })).toBeVisible();
});

it('試聴エラーは録音前でも開き、停止と再試行の操作を表示する', async () => {
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => previewSnapshot(request, { error: '試聴の停止を確認できません' }));
    open();
    const details = screen.getByText('試聴先と再生').closest('details')!;
    await waitFor(() => expect(details).toHaveAttribute('open'));
    expect(screen.getByText('試聴の停止を確認できません')).toBeVisible();
    // 失敗・停止未確認では停止を再送できるようにする。
    expect(screen.getByRole('button', { name: '試聴を停止' })).toBeEnabled();
    expect(screen.getByText('再生できないとき')).toBeVisible();
});

it('locale更新による親再描画でも録音とdialogを保持し、previewをclose/cancelしない', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const close = vi.fn();
    function Surface() { useLocale(); return <VoiceCheckModal isOpen onClose={close} />; }
    render(<LocaleProvider store={store}><Surface /></LocaleProvider>);
    await waitFor(() => expect(record()).toBeEnabled());
    fireEvent.click(record());
    await waitFor(() => expect(audioApi.startVoiceCheck).toHaveBeenCalledOnce());
    const dialog = screen.getByRole('dialog');
    const actions = () => vi.mocked(voicePreviewApi.request).mock.calls.filter(([request]) => ['close','stop','cancel_candidate','open'].includes(request.action)).length;
    const before = actions();
    act(() => {store.setLocale('en');});
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(audioApi.startVoiceCheck).toHaveBeenCalledOnce(); expect(audioApi.stopVoiceCheck).not.toHaveBeenCalled();
    expect(audioApi.stopVoiceCheckPlayback).not.toHaveBeenCalled(); expect(actions()).toBe(before); expect(close).not.toHaveBeenCalled();
});

it('通常出力の切替を求めず独立した試聴先と取り込み確認を案内する', async () => {
    open();
    await screen.findByRole('button', { name: '試聴先を取得・更新' });
    await waitFor(() => expect(screen.getByRole('button', { name: '試聴先を取得・更新' })).toBeEnabled());
    expect(screen.getByRole('combobox', { name: 'ボイスチェックの試聴先' })).toBeInTheDocument();
    expect(screen.getByText(/ほかのアプリが試聴先を占有していると再生できません/)).toHaveTextContent('Voicemeeter');
    expect(screen.queryByRole('button', { name: '試聴先を設定する' })).not.toBeInTheDocument();
    expect(screen.getByText(/マイクの音・出力音量・ミュートは変わりません/)).toBeInTheDocument();
    expect(audioApi.startVoiceCheck).not.toHaveBeenCalled();
});

it('状態確認中と停止中は録音せず、設定への入口を示す', async () => {
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue(stopped);
    const settings = vi.fn();
    open(settings);
    expect(record()).toBeDisabled();
    await screen.findByText(/音声が停止しています/);
    expect(record()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'マイクと出力先を設定する' }));
    expect(settings).toHaveBeenCalledOnce();
    expect(audioApi.startVoiceCheck).not.toHaveBeenCalled();
});

it('取得失敗後に明示的に再確認して復帰できる', async () => {
    vi.mocked(audioApi.getAudioStreamState).mockRejectedValueOnce(new Error('offline'));
    open();
    await screen.findByText(/音声の状態を確認できません/);
    expect(record()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '状態を再確認' }));
    await waitFor(() => expect(record()).toBeEnabled());
    fireEvent.click(record());
    await waitFor(() => expect(audioApi.startVoiceCheck).toHaveBeenCalledOnce());
});

it('クリック直前の再確認で停止していたら録音コマンドを送らない', async () => {
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValueOnce(running).mockResolvedValue(stopped);
    open();
    await waitFor(() => expect(record()).toBeEnabled());
    fireEvent.click(record());
    await screen.findByText(/音声が停止しています/);
    expect(audioApi.startVoiceCheck).not.toHaveBeenCalled();
});

it('停止通知より古い稼働応答で録音可能へ戻さない', async () => {
    let resolve!: (value: typeof running) => void;
    vi.mocked(audioApi.getAudioStreamState).mockReturnValue(new Promise(r => { resolve = r; }));
    open();
    await waitFor(() => expect(audioApi.getAudioStreamState).toHaveBeenCalledOnce());
    act(() => emit('audio-stopped'));
    await act(async () => resolve(running));
    expect(record()).toBeDisabled();
    expect(screen.getByText(/音声が停止しています/)).toBeInTheDocument();
});

it('録音開始失敗を画面内に残し、再試行の方法を示す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(audioApi.startVoiceCheck).mockRejectedValue(new Error('start failed'));
    open();
    await waitFor(() => expect(record()).toBeEnabled());
    fireEvent.click(record());
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('音声の状態を再確認');
    expect(screen.getByRole('button', { name: '状態を再確認' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'マイクと出力先を設定する' })).toBeInTheDocument();
});

it('声単体の録音地点をOBS最終ミックスと到達確認から区別する', async () => {
    open();
    expect(screen.getByText(/出力音量・全体ミュート適用前/)).toHaveTextContent('最終ミックスはOBSで録画して確認');
    const scope = screen.getByText('録音範囲と接続診断について').closest('details');
    expect(scope).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('録音範囲と接続診断について'));
    expect(scope).toHaveAttribute('open');
    expect(scope).toHaveTextContent('伴奏やOBS側の音量・フィルター・録音トラックを含む最終ミックスは、この録音の対象外');
    expect(scope).toHaveTextContent('接続診断は音の到達確認');
    await waitFor(() => expect(record()).toBeEnabled());
    expect(audioApi.startVoiceCheck).not.toHaveBeenCalled();
});

it('保存した試聴先が消えても代替せず、再選択と取り込み確認を求める', async () => {
    localStorage.setItem('vst_host_voice_check_preview_device', 'missing-device');
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => previewSnapshot(request, { recordingId: 9, durationMs: 1000, devices: request.action === 'devices' ? [{ id: 'hp', name: 'Headphones' }] : [] }));
    open();
    const refresh = screen.getByRole('button', { name: '試聴先を取得・更新' });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await screen.findByRole('option', { name: 'Headphones' });
    const select = screen.getByRole('combobox', { name: 'ボイスチェックの試聴先' });
    expect(select).toHaveValue('missing-device');
    expect(screen.getByRole('checkbox', { name: /選んだ試聴先がOBS/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: '選んだ試聴先で再生' })).toBeDisabled();
    expect(screen.getByText(/再生するには、試聴先を選び/)).toBeVisible();
    fireEvent.change(select, { target: { value: 'hp' } });
    expect(screen.getByRole('checkbox', { name: /選んだ試聴先がOBS/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '選んだ試聴先で再生' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /選んだ試聴先がOBS/ }));
    expect(screen.getByRole('button', { name: '選んだ試聴先で再生' })).toBeEnabled();
    expect(screen.queryByText(/再生するには、試聴先を選び/)).not.toBeInTheDocument();
});

it('AutoGainの所有と停止操作を区別し、取り込み確認があっても競合時は開始できない', async () => {
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => previewSnapshot(request, {
        recordingId: 9, durationMs: 1000, owner: 'auto_gain', conflict: '音量調整の録音・聞き比べが使用中です',
        devices: request.action === 'devices' ? [{ id: 'hp', name: 'Headphones' }] : [],
    }));
    open();
    const refresh = screen.getByRole('button', { name: '試聴先を取得・更新' });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await screen.findByRole('option', { name: 'Headphones' });
    fireEvent.change(screen.getByRole('combobox', { name: 'ボイスチェックの試聴先' }), { target: { value: 'hp' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /選んだ試聴先がOBS/ }));
    expect(screen.getByRole('button', { name: '選んだ試聴先で再生' })).toBeDisabled();
    expect(screen.getByText(/こちらからは停止しません/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '試聴を停止' })).toBeEnabled();
    expect(vi.mocked(voicePreviewApi.request).mock.calls.some(([request]) => request.action === 'start')).toBe(false);
});

it('録音後・録音中の変更と内部VST未照合を折畳み条件欄で区別する', async () => {
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => previewSnapshot(request, {
        recordingId: 9, durationMs: 1000, recordingStale: true,
        metadata: { recordingId: 9, revision: 3, sampleRate: 48000, bufferSize: 512, host: 'Wasapi', inputChannels: [0, 1], inputGain: 1,
            noiseEnabled: true, noiseMode: 'standard', noiseStrength: 0.5, voiceGuard: true, builtInEnabled: false,
            builtInPreset: 'broadcast', builtInAmount: 0.5, globalBypass: false, plugins: [], changedDuringRecording: true,
            rawTap: 'post_input_gain_and_channel_selection_pre_fx', processedTap: 'post_fx_pre_output_gain_and_global_mute', vstParametersVerified: false },
    }));
    open();
    await waitFor(() => expect(screen.getByRole('button', { name: '試聴先を取得・更新' })).toBeEnabled());
    fireEvent.click(screen.getByText('録音時の条件と現在との違い'));
    expect(screen.getByText(/現在のマイクの音とは異なる以前の録音/)).toBeVisible();
    expect(screen.getByText(/録音中にも設定が変更/)).toBeVisible();
    expect(screen.getByText(/VST内部パラメーターは照合していません/)).toBeVisible();
    expect(screen.getByText(/48000 Hz/)).toHaveTextContent('512');
});


it.each([false, true])('残響だけ=%sの候補も準備でき、比較範囲とA/Bを示し元録音の解析やWAVを誤表示しない', async reverbOnly => {
    const config: BuiltinConfig = reverbOnly
        ? { active: false, preset: 'broadcast', amount: 0.7, singing: null, reverb: { ...defaultReverb, enabled: true } }
        : { active: true, preset: 'singing', amount: 0.7, singing: defaultSinging };
    vi.spyOn(builtinApi, 'request').mockResolvedValue({ epoch: 'builtin', revision: '4', appliedRevision: '4', pending: false, undoToken: null, error: null, config });
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => previewSnapshot(request, { recordingId: 9, durationMs: 1000,
        candidate: request.action === 'prepare_candidate' ? { id: 'candidate-1', recordingId: 9, baseRevision: '4', state: 'ready', config,
            sampleRate: 48000, sourceFrames: 48000, renderedFrames: reverbOnly ? 168000 : 48000, algorithmicLatencyFrames: 0, filterPhase: 'minimumPhase', samplePeak: 0.2, error: null } : null }));
    function CandidateModal() { return <VoiceCheckModal isOpen onClose={vi.fn()} singingModel={useSingingDraft()} />; }
    render(<CandidateModal />);
    const prepare = await screen.findByRole('button', { name: 'この録音から内蔵ボイスチェーンの候補を作成' });
    await waitFor(() => expect(prepare).toBeEnabled());
    expect(screen.getByText(/ノイズ低減・既存VST・出力音量は含めません/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'A：原音（マイク音量後）' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'B：候補（内蔵ボイスチェーン・残響のみ）' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '品質チェックを実行' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'WAVで保存' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '選んだ試聴先で再生' })).toBeDisabled();
    fireEvent.click(prepare);
    await screen.findByText('候補の準備ができました。試聴先を確認して再生してください。');
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'prepare_candidate', config }));
    expect(screen.getByText(/元の録音：48000フレーム（1.00秒）/)).toBeInTheDocument();
    if (reverbOnly) {
        expect(screen.getByText(/比較用：168000フレーム（3.50秒）/)).toHaveTextContent('120000フレームの無音');
        expect(screen.getByText(/残響の比較窓は設定した長さの2倍/)).toHaveTextContent('末尾20ms');
    }
    expect(screen.getByText(/候補作成の完了は、聴いたことや音質改善の判定ではありません/)).toBeInTheDocument();
    expect(audioApi.startVoiceCheck).not.toHaveBeenCalled();
});


it.each(['ja', 'en'] as const)('再生中は一時停止とせず停止・先頭からの再生を案内する（%s）', async locale => {
    // ポーリングの前後で同じ再生状態を返し、クリックの速さに依存させない。
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let playbackState: 'idle' | 'playing' | 'stopped' | 'closed' = 'idle';
    let playingStatusPolls = 0;
    vi.mocked(voicePreviewApi.request).mockImplementation(async request => {
        if (request.action === 'open') playbackState = 'idle';
        if (request.action === 'start') playbackState = 'playing';
        if (request.action === 'stop') playbackState = 'stopped';
        if (request.action === 'close') playbackState = 'closed';
        if (request.action === 'status' && playbackState === 'playing') playingStatusPolls += 1;
        return previewSnapshot(request, {
            recordingId: 9, durationMs: 1000, state: playbackState,
            devices: request.action === 'devices' ? [{ id: 'hp', name: 'Headphones' }] : [],
        });
    });
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><VoiceCheckModal isOpen onClose={vi.fn()} /></LocaleProvider>);
    const refresh = screen.getByRole('button', { name: locale === 'ja' ? '試聴先を取得・更新' : 'Get / refresh listening outputs' });
    await waitFor(() => expect(refresh).toBeEnabled());
    fireEvent.click(refresh);
    await screen.findByRole('option', { name: 'Headphones' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hp' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? '選んだ試聴先で再生' : 'Play through the selected output' }));
    const stop = await screen.findByRole('button', { name: locale === 'ja' ? '再生を停止（再生は先頭から）' : 'Stop playback (replay starts from the beginning)' });
    await waitFor(() => expect(stop).toBeEnabled());
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(playingStatusPolls).toBe(2);
    const playingStop = screen.getByRole('button', { name: locale === 'ja' ? '再生を停止（再生は先頭から）' : 'Stop playback (replay starts from the beginning)' });
    expect(playingStop).toBeEnabled();
    expect(screen.queryByRole('button', { name: /一時停止|Pause/i })).not.toBeInTheDocument();
    fireEvent.click(playingStop);
    await waitFor(() => expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({ action: 'stop' })));
    await waitFor(() => expect(screen.getByRole('button', { name: locale === 'ja' ? '選んだ試聴先で再生' : 'Play through the selected output' })).toBeEnabled());
});
