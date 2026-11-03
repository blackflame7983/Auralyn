import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mixingApi, type MixSnapshot } from '@/api/mixing';
import { liveOutputApi } from '@/api/liveOutput';
import { audioApi } from '@/api/audio';
import { MixingPanel } from '../MixingPanel';

const levels = { voice: { gain: 0, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 };
const config = { version: 1 as const, source: { kind: 'device' as const, config: { host: 'WASAPI' as const, inputId: 'music', inputChannels: [0, 1] as [number, number] } }, levels };
const snapshot = (extra: Partial<MixSnapshot> = {}): MixSnapshot => ({ epoch: 'e', revision: '1', config, savedConfig: config, running: false, accompaniment: null, voicePeak: [0, 0], accompanimentPeak: [0, 0], mixPeak: [1.2, 1], knownVoiceProcessingFrames: null, pending: false, failed: false, primaryClock: null, error: null, ...extra });
const inputs = [{ name: 'Music', host: 'WASAPI', is_input: true, index: 0, is_default: false, channels: 2, id: 'music' }];
const output = (ready = true) => ({ config: { deviceId: ready ? 'out' : null, splitProcessing: ready, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup(value = snapshot(), ready = true, primaryIsVoiceDevice = true) {
    const request = vi.spyOn(mixingApi, 'request').mockResolvedValue(value);
    vi.spyOn(liveOutputApi, 'request').mockResolvedValue(output(ready));
    render(<MixingPanel inputs={inputs} primaryIsVoiceDevice={primaryIsVoiceDevice} />);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('オケを追加して配信する'));
    fireEvent.click(screen.getByRole('button', { name: '読み込む' }));
    await screen.findByText(/現在の入力元/);
    return request;
}
it('明示読込後に 0 の音量を保持し、調整を明示適用する', async () => {
    const request = await setup();
    expect(request).toHaveBeenCalledTimes(1);
    const voice = screen.getByRole('group', { name: '声' });
    expect(within(voice).getByRole('spinbutton')).toHaveValue(0);
    expect(screen.getByText(/1.20/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '調整を適用' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'levels', expectedEpoch: 'e', expectedRevision: '1', levels }));
});
it('分離出力がない場合と再生中は入力元の適用を拒否し、無効化は停止時に可能', async () => {
    await setup(snapshot(), false);
    expect(screen.getByText(/先に「自分用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /配信先と原音/ }));
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'オケを無効にする' })).toBeEnabled();
    cleanup(); vi.restoreAllMocks();
    await setup(snapshot({ running: true }));
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'オケを無効にする' })).toBeDisabled();
});
it('保存失敗時は下書きを保持し、再試行しない', async () => {
    const request = await setup();
    request.mockRejectedValueOnce(new Error('stale'));
    fireEvent.change(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: '調整を適用' }));
    await screen.findByRole('alert');
    expect(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton')).toHaveValue(0.5);
    expect(request).toHaveBeenCalledTimes(2);
});
it('保存名だけではアプリを適用できず、候補消失後は再選択が必要', async () => {
    const app = { id: 'one', appKey: 'a'.repeat(64), name: 'player', routes: [{ id: 'raw', name: 'output', muted: true }] };
    const processConfig = { ...config, source: { kind: 'process_loopback' as const, config: { appKey: app.appKey, appName: app.name, rawEndpointId: 'raw', purpose: 'music' as const } } };
    vi.spyOn(audioApi, 'processInputSources').mockResolvedValueOnce([app]).mockResolvedValueOnce([]);
    await setup(snapshot({ config: null, savedConfig: processConfig }));
    fireEvent.click(screen.getByRole('checkbox', { name: /配信先と原音/ }));
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'アプリ一覧を更新' }));
    await screen.findByRole('option', { name: 'player' });
    fireEvent.change(screen.getByRole('combobox', { name: '再生中のアプリを選択' }), { target: { value: 'one' } });
    fireEvent.change(screen.getByRole('combobox', { name: '原音の出力先を選択' }), { target: { value: 'raw' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /配信先と原音/ }));
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'アプリ一覧を更新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '入力元を適用' })).toBeDisabled());
});

it('古いポーリング応答は新しい適用結果を上書きしない', async () => {
    let finish!: (value: MixSnapshot) => void;
    const request = await setup();
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(snapshot({ revision: '2', knownVoiceProcessingFrames: 128 }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2), { timeout: 2500 });
    fireEvent.click(screen.getByRole('button', { name: '調整を適用' }));
    await screen.findByText(/128 フレーム/);
    await act(async () => { finish(snapshot({ revision: '1', knownVoiceProcessingFrames: 7 })); });
    expect(screen.getByText(/128 フレーム/)).toBeInTheDocument();
    expect(screen.queryByText(/7 フレーム/)).not.toBeInTheDocument();
});

it.each([{ epoch: 'e', revision: '2' }, { epoch: 'new', revision: '1' }])('外部世代変更 $epoch/$revision で下書きを保持し書込みを止める', async (external) => {
    const request = await setup();
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    fireEvent.change(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /配信先と原音/ }));
    request.mockResolvedValue(snapshot({ ...external, knownVoiceProcessingFrames: 42 }));
    await screen.findByText(/設定が変わりました/, {}, { timeout: 2500 });
    expect(screen.getByText(/42 フレーム/)).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton')).toHaveValue(0.5);
    expect(screen.getByRole('button', { name: '調整を適用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '入力元を適用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'オケを無効にする' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '読み込む' }));
    await waitFor(() => expect(screen.queryByText(/設定が変わりました/)).not.toBeInTheDocument());
    expect(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton')).toHaveValue(0);
    fireEvent.click(screen.getByRole('button', { name: '調整を適用' }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ action: 'levels', expectedEpoch: external.epoch, expectedRevision: external.revision, levels }));
});

it('同じ世代のポーリングは下書きと操作を維持する', async () => {
    const request = await setup();
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    request.mockResolvedValue(snapshot({ knownVoiceProcessingFrames: 64 }));
    fireEvent.change(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton'), { target: { value: '0.5' } });
    await screen.findByText(/64 フレーム/, {}, { timeout: 2500 });
    expect(screen.getByRole('button', { name: '調整を適用' })).toBeEnabled();
    expect(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton')).toHaveValue(0.5);
});

it('オケの待機・失敗と配信ミックスの失敗を区別する', async () => {
    const accompaniment = { capturedFrames: 0, nonzeroFrames: 0, failed: false, waitingForAudio: true, inputRateHz: 48000, correctionLimitPpm: 2000, queuedFrames: 0, renderedFrames: 0, correctionPpm: 0, pauseResets: 0, waitingDiscardedFrames: 0, discontinuities: 0, timestampErrors: 0, nonfiniteSamples: 0 };
    const request = await setup(snapshot({ accompaniment }));
    expect(screen.getByText('オケの音声を待っています。')).toHaveAttribute('role', 'status');
    request.mockResolvedValue(snapshot({ accompaniment: { ...accompaniment, failed: true }, failed: true }));
    fireEvent.click(screen.getByRole('button', { name: '読み込む' }));
    await screen.findByText(/オケの入力が停止しました/);
    expect(screen.queryByText('オケの音声を待っています。')).not.toBeInTheDocument();
    expect(screen.getByText(/配信ミックスの処理に問題/)).toHaveAttribute('role', 'alert');
});

function openRecovery() {
    fireEvent.click(screen.getByText('保存設定を復旧する'));
    return { confirm: screen.getByRole('checkbox', { name: /現在の保存状態を保管して/ }), button: screen.getByRole('button', { name: '保存状態を保管してオケを無効にする' }) };
}

it('破損設定を停止中に明示復旧し、下書きと選択を初期化する', async () => {
    const request = await setup(snapshot({ config: null, savedConfig: null, error: 'corrupt' }), false, false);
    fireEvent.change(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /配信先と原音/ }));
    const recovery = openRecovery();
    expect(recovery.button).toBeDisabled();
    fireEvent.click(recovery.confirm);
    expect(recovery.button).toBeEnabled();
    request.mockResolvedValueOnce(snapshot({ revision: '2', config: null, savedConfig: null, error: null }));
    fireEvent.click(recovery.button);
    await screen.findByText('保存状態の記録を残し、オケを無効にしました。');
    expect(request).toHaveBeenLastCalledWith({ action: 'reset', expectedEpoch: 'e', expectedRevision: '1' });
    expect(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton')).toHaveValue(1);
    expect(screen.getByRole('checkbox', { name: /配信先と原音/ })).not.toBeChecked();
    expect(recovery.confirm).not.toBeChecked();
    expect(screen.getByText('現在の入力元: 未選択')).toBeInTheDocument();
    expect(screen.getByText('保存済みの入力元（下書きの参照）: 未選択')).toBeInTheDocument();
});

it('再生中は復旧できない', async () => {
    const request = await setup(snapshot({ running: true, error: 'corrupt' }));
    const recovery = openRecovery();
    expect(recovery.confirm).toBeDisabled();
    expect(recovery.button).toBeDisabled();
    fireEvent.click(recovery.button);
    expect(request).toHaveBeenCalledTimes(1);
});

it('復旧失敗は下書きを保持し、自動的に再試行しない', async () => {
    const request = await setup(snapshot({ error: 'corrupt' }));
    fireEvent.change(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton'), { target: { value: '0.5' } });
    const recovery = openRecovery();
    fireEvent.click(recovery.confirm);
    request.mockRejectedValueOnce(new Error('backup failed'));
    fireEvent.click(recovery.button);
    await waitFor(() => expect(recovery.button).toBeEnabled());
    expect(within(screen.getByRole('group', { name: '声' })).getByRole('spinbutton')).toHaveValue(0.5);
    expect(screen.queryByText('保存状態の記録を残し、オケを無効にしました。')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
});

it('外部の世代変更後は復旧も禁止する', async () => {
    const request = await setup(snapshot({ error: 'corrupt' }));
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    const recovery = openRecovery();
    fireEvent.click(recovery.confirm);
    request.mockResolvedValue(snapshot({ revision: '2', error: 'corrupt' }));
    await screen.findByText(/設定が変わりました/, {}, { timeout: 2500 });
    expect(recovery.button).toBeDisabled();
    fireEvent.click(recovery.button);
    expect(request.mock.calls.every(([args]) => args.action === 'snapshot')).toBe(true);
});
