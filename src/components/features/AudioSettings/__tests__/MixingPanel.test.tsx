import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mixingApi, type MixSnapshot } from '@/api/mixing';
import { liveOutputApi } from '@/api/liveOutput';
import { audioApi } from '@/api/audio';
import { currentOffsetContext } from '@/lib/offsetContext';
import { MixingPanel } from '../MixingPanel';
const levels = { voice: { gain: 0, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 };
const config = { version: 1 as const, source: { kind: 'device' as const, config: { host: 'WASAPI' as const, inputId: 'music', inputChannels: [0, 1] as [number, number] } }, levels };
const snapshot = (extra: Partial<MixSnapshot> = {}): MixSnapshot => ({ epoch: 'e', revision: '1', config, savedConfig: config, running: false, accompaniment: null, voicePeak: [0, 0], accompanimentPeak: [0, 0], mixPeak: [1.2, 1], knownVoiceProcessingFrames: null, pending: false, failed: false, primaryClock: null, error: null, ...extra });
const inputs = [{ name: 'Music', host: 'WASAPI', is_input: true, index: 0, is_default: false, channels: 4, id: 'music' }];
const output = (ready = true) => ({ config: { deviceId: ready ? 'out' : null, splitProcessing: ready, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null });
const audio = { is_running: false, config: { host: 'WASAPI', input: 'Mic', input_id: 'mic', output: 'Phones', output_id: 'phones', sample_rate: 48000, buffer_size: 128, routing: { inputChannels: [0, 1] as [number, number], outputRouting: { mode: 'legacy' as const } } } };
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function setup(value = snapshot(), ready = true, primaryIsVoiceDevice = true, onNavigate = vi.fn()) {
    const request = vi.spyOn(mixingApi, 'request').mockResolvedValue(value);
    vi.spyOn(liveOutputApi, 'request').mockResolvedValue(output(ready));
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue(audio);
    render(<MixingPanel inputs={inputs} primaryIsVoiceDevice={primaryIsVoiceDevice} onNavigate={onNavigate} />);
    expect(request).not.toHaveBeenCalled(); fireEvent.click(screen.getByText('オケを追加して配信する'));
    await screen.findByText(/適用中の入力元/); return request;
}
const voice = () => screen.getByRole('slider', { name: '声の音量' });
it('開いた時に自動取得し、0%を保持してキーボード調整を即時反映する', async () => {
    const request = await setup(); expect(request).toHaveBeenCalledTimes(1); expect(voice()).toHaveAttribute('aria-valuenow', '0');
    fireEvent.keyDown(voice(), { key: 'ArrowRight' });
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'levels', expectedEpoch: 'e', expectedRevision: '1', levels: { ...levels, voice: { gain: 0.01, muted: false } } }));
    expect(voice()).toHaveAttribute('aria-valuetext', '1%'); expect(screen.queryByText('調整を適用')).not.toBeInTheDocument();
});
it('最新状態の再取得で編集中の入力元と音量を失わない', async () => {
    const request = await setup(); fireEvent.change(screen.getByRole('combobox', { name: '入力ペア' }), { target: { value: '2,3' } });
    fireEvent.keyDown(voice(), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: '最新の状態を読み直す' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('combobox', { name: '入力ペア' })).toHaveValue('2,3'); expect(voice()).toHaveAttribute('aria-valuetext', '1%');
});
it('動作中と編集中を区別し、保存内容の明示的な読み直しで下書きを置き換える', async () => {
    const request = await setup();
    const active = screen.getByRole('region', { name: '動作中の設定' });
    const draft = screen.getByRole('region', { name: '編集中の内容' });
    expect(active).toHaveTextContent('Music');
    expect(within(active).queryByRole('combobox')).not.toBeInTheDocument();
    const pair = within(draft).getByRole('combobox', { name: '入力ペア' });
    fireEvent.change(pair, { target: { value: '2,3' } });
    expect(pair).toHaveValue('2,3');
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(within(draft).getByRole('button', { name: '保存内容で編集中の内容を置き換える' }));
    await waitFor(() => expect(pair).toHaveValue('0,1'));
    expect(request).toHaveBeenLastCalledWith({ action: 'reload', expectedEpoch: 'e', expectedRevision: '1' });
    expect(active).toHaveTextContent('Music');
});
it('前提の不足から設定欄へ移動でき、準備状態を自動更新する', async () => {
    const navigate = vi.fn(); await setup(snapshot(), false, false, navigate);
    fireEvent.click(screen.getByRole('button', { name: '配信用の分離出力を設定' })); expect(navigate).toHaveBeenCalledWith('output');
    fireEvent.click(screen.getByRole('button', { name: '主入力と用途を設定' })); expect(navigate).toHaveBeenCalledWith('input');
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    vi.mocked(liveOutputApi.request).mockResolvedValue(output());
    await waitFor(() => expect(screen.queryByRole('button', { name: '配信用の分離出力を設定' })).not.toBeInTheDocument(), { timeout: 2500 });
});
it('有効な1始まりの入力ペアだけを選び、機器変更時は先頭ペアになる', async () => {
    await setup(); const pair = screen.getByRole('combobox', { name: '入力ペア' });
    expect(within(pair).getAllByRole('option').map(o => o.textContent)).toEqual(['1–2', '3–4']);
    fireEvent.change(pair, { target: { value: '2,3' } }); fireEvent.change(screen.getByRole('combobox', { name: '機器を選択' }), { target: { value: 'music' } }); expect(pair).toHaveValue('0,1');
});
it('経路が同じ再適用は確認を要求せず、経路変更は改めて確認する', async () => {
    const request = await setup(); const confirm = () => screen.getByRole('checkbox', { name: /配信先と原音/ });
    // 開いた直後の適用中の経路は確認済みとして扱う。
    expect(screen.queryByRole('checkbox', { name: /配信先と原音/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '入力ペア' }), { target: { value: '2,3' } });
    fireEvent.click(confirm()); fireEvent.click(screen.getByRole('button', { name: '入力元を適用' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeEnabled(); expect(screen.queryByRole('checkbox', { name: /配信先と原音/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '入力ペア' }), { target: { value: '0,1' } });
    expect(confirm()).not.toBeChecked(); expect(screen.getByRole('button', { name: '入力元を適用' })).toHaveAccessibleDescription(/経路の確認/);
});
it('停止中は停止要求を出さず、動作中は無効理由として伝える', async () => {
    await setup(); expect(screen.queryByText('入力元の変更は音声停止中に行ってください。')).not.toBeInTheDocument();
    cleanup(); vi.restoreAllMocks(); await setup(snapshot({ running: true }));
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeDisabled(); expect(screen.getByRole('button', { name: '入力元を適用' })).toHaveAccessibleDescription(/音声停止中/);
    expect(screen.getByRole('button', { name: 'オケを無効にする' })).toHaveAccessibleDescription(/音声停止中/);
});
it('アプリ候補、原音ミュート、経路確認の順に無効理由を伝える', async () => {
    vi.spyOn(audioApi, 'processInputSources').mockResolvedValue([{ id: 'app', appKey: 'key', name: 'Player', routes: [{ id: 'raw', name: 'Raw', muted: false }] }]);
    await setup(); fireEvent.change(screen.getByRole('combobox', { name: 'オケの入力元' }), { target: { value: 'process' } });
    const apply = screen.getByRole('button', { name: '入力元を適用' }); expect(apply).toHaveAccessibleDescription(/再生中のアプリを一覧/);
    fireEvent.click(screen.getByRole('button', { name: 'アプリ一覧を更新' })); await screen.findByRole('option', { name: 'Player' });
    fireEvent.change(screen.getByRole('combobox', { name: '再生中のアプリを選択' }), { target: { value: 'app' } });
    expect(apply).toHaveAccessibleDescription(/Windows/);
    fireEvent.change(screen.getByRole('combobox', { name: '原音の出力先を選択' }), { target: { value: 'raw' } }); expect(apply).toBeDisabled();
});
it.each([{ epoch: 'e', revision: '2' }, { epoch: 'new', revision: '1' }])('外部の世代変更 $epoch/$revision は下書きを保持して書込みを止める', async external => {
    const request = await setup(); vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    fireEvent.change(screen.getByRole('combobox', { name: '入力ペア' }), { target: { value: '2,3' } }); request.mockResolvedValue(snapshot(external));
    await screen.findAllByText(/設定が変わりました/, {}, { timeout: 2500 }); expect(screen.getByRole('combobox', { name: '入力ペア' })).toHaveValue('2,3');
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'オケを無効にする' })).toBeDisabled();
    expect(voice()).toHaveAttribute('data-disabled');
    fireEvent.click(screen.getByRole('button', { name: '最新の状態を読み直す' })); await waitFor(() => expect(voice()).not.toHaveAttribute('data-disabled'));
    expect(screen.getByRole('combobox', { name: '入力ペア' })).toHaveValue('2,3');
});
it('古いポーリング応答は新しい書込み結果を上書きしない', async () => {
    let finish!: (value: MixSnapshot) => void; const request = await setup(); vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(snapshot({ revision: '2', config: { ...config, levels: { ...levels, voice: { gain: 0.01, muted: false } } } }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2), { timeout: 2500 }); fireEvent.keyDown(voice(), { key: 'ArrowRight' });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3)); await act(async () => finish(snapshot({ revision: 'old' })));
    expect(screen.queryByText(/設定が変わりました/)).not.toBeInTheDocument();
});
it('失敗した操作と分類・原文を示し、音量の編集を保持して再試行しない', async () => {
    const request = await setup(); request.mockRejectedValueOnce(new Error('stale revision')); fireEvent.keyDown(voice(), { key: 'ArrowRight' });
    await screen.findAllByRole('alert'); expect(screen.getByText(/音量・時間差の変更.*に失敗/)).toHaveTextContent('別の操作');
    expect(screen.getByText('Error: stale revision')).toBeInTheDocument(); expect(voice()).toHaveAttribute('aria-valuetext', '1%'); expect(request).toHaveBeenCalledTimes(2);
});
it('破損設定は停止中の確認後だけ復旧し、下書きを初期化する', async () => {
    const request = await setup(snapshot({ config: null, savedConfig: null, error: 'corrupt' })); fireEvent.click(screen.getByText('保存設定を復旧する'));
    const reset = screen.getByRole('button', { name: '保存状態を保管してオケを無効にする' }); expect(reset).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /現在の保存状態を保管して/ })); request.mockResolvedValueOnce(snapshot({ revision: '2', config: null, savedConfig: null })); fireEvent.click(reset);
    await screen.findByText('保存状態の記録を残し、オケを無効にしました。'); expect(voice()).toHaveAttribute('aria-valuetext', '100%');
    expect(request).toHaveBeenLastCalledWith({ action: 'reset', expectedEpoch: 'e', expectedRevision: '1' });
});
it('音量の連続操作をまとめ、処理中の最後の値を次のrevisionで送る', async () => {
    let finish!: (value: MixSnapshot) => void; const request = await setup(); request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.keyDown(voice(), { key: 'ArrowRight' }); fireEvent.keyDown(voice(), { key: 'ArrowRight' }); await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(voice(), { key: 'ArrowRight' }); await act(async () => finish(snapshot({ revision: '2' })));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'levels', expectedRevision: '2', levels: expect.objectContaining({ voice: { gain: 0.03, muted: false } }) })));
});

it.each(['', '2001', '0.5'])('時間差が不正な下書き %s の間は音量・ミュートの要求を送らず、修正後にまとめて反映する', async invalid => {
    const request = await setup(); vi.useFakeTimers();
    fireEvent.keyDown(voice(), { key: 'ArrowRight' });
    const offset = screen.getByRole('spinbutton', { name: '配信用の手動時間差（ms）' });
    fireEvent.change(offset, { target: { value: invalid } });
    fireEvent.click(within(screen.getByRole('group', { name: '声' })).getByRole('checkbox', { name: 'ミュート' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(125); });
    expect(request.mock.calls.every(([r]) => r.action === 'snapshot')).toBe(true);
    expect(offset).toHaveAttribute('aria-invalid', 'true'); expect(offset).toHaveAccessibleDescription(/時間差は -2000〜2000 ms の整数/);
    expect(screen.queryByText(/設定が変わりました/)).not.toBeInTheDocument();
    fireEvent.change(offset, { target: { value: '0' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(125); });
    expect(request).toHaveBeenLastCalledWith({ action: 'levels', expectedEpoch: 'e', expectedRevision: '1', levels: { ...levels, voice: { gain: 0.01, muted: true } } });
    expect(offset).toHaveAttribute('aria-invalid', 'false');
});

it('古い時間差の未確認案内を出し、値を変えずに今の機材で確認済みとして保存する', async () => {
    const old = { ...config, levels: { ...levels, offsetMs: -35 } };
    const request = await setup(snapshot({ config: old, savedConfig: old }));
    expect(screen.getByText(/時間差は未確認/, { selector: '[role="status"]' })).toHaveTextContent('時間差は未確認');
    expect(screen.getByText(/時間差は未確認/, { selector: '[role="status"]' })).toHaveTextContent('機材の記録がありません');
    const context = currentOffsetContext(audio.config, config.source, output().config);
    const saved = { ...old, levels: { ...old.levels, offsetContext: context } };
    request.mockResolvedValueOnce(snapshot({ revision: '2', config: saved, savedConfig: saved }));
    fireEvent.click(screen.getByRole('button', { name: 'この機材で確認済みにする' }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ action: 'levels', expectedEpoch: 'e', expectedRevision: '1', levels: saved.levels }));
    await waitFor(() => expect(screen.queryByText(/時間差は未確認/)).not.toBeInTheDocument());
    expect(screen.getByRole('spinbutton', { name: '配信用の手動時間差（ms）' })).toHaveValue(-35);
});

it('時間差の変更を保存すると、保存時の機材の組み合わせが記録される', async () => {
    const request = await setup();
    const freshAudio = { ...audio, config: { ...audio.config, input_id: 'new-mic' } };
    vi.mocked(audioApi.getAudioState).mockResolvedValue(freshAudio);
    const nextLevels = { ...levels, offsetMs: 42, offsetContext: currentOffsetContext(freshAudio.config, config.source, output().config) };
    request.mockResolvedValueOnce(snapshot({ revision: '2', config: { ...config, levels: nextLevels } }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '配信用の手動時間差（ms）' }), { target: { value: '42' } });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ action: 'levels', expectedEpoch: 'e', expectedRevision: '1', levels: nextLevels }));
    await waitFor(() => expect(screen.queryByText(/時間差は未確認/)).not.toBeInTheDocument());
});

it('機材の変更項目を示し、音量だけの操作では時間差を確認済みにしない', async () => {
    const context = currentOffsetContext(audio.config, config.source, output().config)!;
    const old = { ...config, levels: { ...levels, offsetMs: 35, offsetContext: { ...context, voiceInputId: 'old-mic', voiceChannels: [2, 3] as [number, number], accompaniment: 'old-music', outputId: 'old-phones', broadcastId: null } } };
    const request = await setup(snapshot({ config: old, savedConfig: old }));
    expect(screen.getByText(/時間差は未確認/, { selector: '[role="status"]' })).toHaveTextContent('変わった項目：声の入力 / 声のチャンネル / オケ / 本人用の出力 / 配信の出力');
    fireEvent.keyDown(voice(), { key: 'ArrowRight' });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'levels', levels: { ...old.levels, voice: { gain: 0.01, muted: false } } })));
    expect(screen.getByText(/時間差は未確認/, { selector: '[role="status"]' })).toHaveTextContent('時間差は未確認');
});

it('確認の保存に失敗した場合は未確認表示と時間差を保持する', async () => {
    const old = { ...config, levels: { ...levels, offsetMs: -35 } };
    const request = await setup(snapshot({ config: old, savedConfig: old }));
    request.mockRejectedValueOnce(new Error('save failed'));
    fireEvent.click(screen.getByRole('button', { name: 'この機材で確認済みにする' }));
    await screen.findByText('Error: save failed');
    expect(screen.getByText(/時間差は未確認/, { selector: '[role="status"]' })).toHaveTextContent('時間差は未確認');
    expect(screen.getByRole('spinbutton', { name: '配信用の手動時間差（ms）' })).toHaveValue(-35);
});

it('機材を判定できないときは控えめに案内し、確認ボタンを出さない', async () => {
    const old = { ...config, levels: { ...levels, offsetMs: 35 } };
    await setup(snapshot({ config: old, savedConfig: old }));
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ is_running: false, config: null });
    fireEvent.click(screen.getByRole('button', { name: '最新の状態を読み直す' }));
    await waitFor(() => expect(screen.getByText(/機材の組み合わせを取得できない/, { selector: '[role="status"]' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'この機材で確認済みにする' })).not.toBeInTheDocument();
});

it('声の機材を変えると案内が出て、同じ機材に戻すと保存せず案内が消える', async () => {
    const context = currentOffsetContext(audio.config, config.source, output().config);
    const saved = { ...config, levels: { ...levels, offsetMs: 35, offsetContext: context } };
    const request = await setup(snapshot({ config: saved, savedConfig: saved }));
    expect(screen.queryByText(/時間差は未確認/)).not.toBeInTheDocument();
    vi.mocked(audioApi.getAudioState).mockResolvedValue({ ...audio, config: { ...audio.config, input_id: 'new-mic' } });
    fireEvent.click(screen.getByRole('button', { name: '最新の状態を読み直す' }));
    await screen.findByText(/変わった項目：声の入力/);
    vi.mocked(audioApi.getAudioState).mockResolvedValue(audio);
    fireEvent.click(screen.getByRole('button', { name: '最新の状態を読み直す' }));
    await waitFor(() => expect(screen.queryByText(/時間差は未確認/)).not.toBeInTheDocument());
    expect(request.mock.calls.every(([r]) => r.action === 'snapshot')).toBe(true);
});

it('時間差の保存待ちに音量を変えても、次の要求に新しい文脈を引き継ぐ', async () => {
    let finish!: (value: MixSnapshot) => void;
    const request = await setup();
    const context = currentOffsetContext(audio.config, config.source, output().config);
    const nextLevels = { ...levels, offsetMs: 35, offsetContext: context };
    request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '配信用の手動時間差（ms）' }), { target: { value: '35' } });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(voice(), { key: 'ArrowRight' });
    request.mockResolvedValueOnce(snapshot({ revision: '3', config: { ...config, levels: { ...nextLevels, voice: { gain: 0.01, muted: false } } } }));
    await act(async () => finish(snapshot({ revision: '2', config: { ...config, levels: nextLevels } })));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ action: 'levels', expectedEpoch: 'e', expectedRevision: '2', levels: { ...nextLevels, voice: { gain: 0.01, muted: false } } }));
    expect(screen.queryByText(/時間差は未確認/)).not.toBeInTheDocument();
});

it('まだ適用していない時間差は、入力元の適用時にその入力元の文脈を保存する', async () => {
    const request = await setup(snapshot({ config: null, savedConfig: config }));
    fireEvent.change(screen.getByRole('combobox', { name: '入力ペア' }), { target: { value: '2,3' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '配信用の手動時間差（ms）' }), { target: { value: '35' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /配信先と原音/ }));
    const source = { ...config.source, config: { ...config.source.config, inputChannels: [2, 3] as [number, number] } };
    const saved = { ...config, source, levels: { ...levels, offsetMs: 35, offsetContext: currentOffsetContext(audio.config, source, output().config) } };
    request.mockResolvedValueOnce(snapshot({ revision: '2', config: saved, savedConfig: saved }));
    fireEvent.click(screen.getByRole('button', { name: '入力元を適用' }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ action: 'configure', expectedEpoch: 'e', expectedRevision: '1', config: saved }));
});

it('配信先の再取得に失敗した場合は、以前の機材を確認済みとして表示し続けない', async () => {
    const context = currentOffsetContext(audio.config, config.source, output().config);
    const saved = { ...config, levels: { ...levels, offsetMs: 35, offsetContext: context } };
    await setup(snapshot({ config: saved, savedConfig: saved }));
    vi.mocked(liveOutputApi.request).mockRejectedValueOnce(new Error('output unavailable'));
    fireEvent.click(screen.getByRole('button', { name: '最新の状態を読み直す' }));
    await screen.findByText('Error: output unavailable');
    expect(screen.getByText(/機材の組み合わせを取得できない/, { selector: '[role="status"]' })).toBeInTheDocument();
});
