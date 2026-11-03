import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mixingApi, type MixSnapshot } from '@/api/mixing';
import { liveOutputApi } from '@/api/liveOutput';
import { audioApi } from '@/api/audio';
import { MixingPanel } from '../MixingPanel';
const levels = { voice: { gain: 0, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 };
const config = { version: 1 as const, source: { kind: 'device' as const, config: { host: 'WASAPI' as const, inputId: 'music', inputChannels: [0, 1] as [number, number] } }, levels };
const snapshot = (extra: Partial<MixSnapshot> = {}): MixSnapshot => ({ epoch: 'e', revision: '1', config, savedConfig: config, running: false, accompaniment: null, voicePeak: [0, 0], accompanimentPeak: [0, 0], mixPeak: [1.2, 1], knownVoiceProcessingFrames: null, pending: false, failed: false, primaryClock: null, error: null, ...extra });
const inputs = [{ name: 'Music', host: 'WASAPI', is_input: true, index: 0, is_default: false, channels: 4, id: 'music' }];
const output = (ready = true) => ({ config: { deviceId: ready ? 'out' : null, splitProcessing: ready, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function setup(value = snapshot(), ready = true, primaryIsVoiceDevice = true, onNavigate = vi.fn()) {
    const request = vi.spyOn(mixingApi, 'request').mockResolvedValue(value);
    vi.spyOn(liveOutputApi, 'request').mockResolvedValue(output(ready));
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
    fireEvent.click(confirm()); fireEvent.click(screen.getByRole('button', { name: '入力元を適用' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeEnabled(); expect(screen.queryByRole('checkbox', { name: /配信先と原音/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: '入力ペア' }), { target: { value: '2,3' } });
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
