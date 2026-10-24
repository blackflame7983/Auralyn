import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { obsApi, type ObsSetupPlan, type ObsSetupHistory, type ObsTimingRequest } from '@/api/obs';
import { ObsTimingCheck } from '../ObsTimingCheck';

const targets = { supported: true, message: '対象を選択してください', targets: [
    { targetToken: 'real-voice-token', source: '声', currentOffsetMs: -40 },
    { targetToken: 'real-music-token', source: '伴奏', currentOffsetMs: 100 },
] };
const plan: ObsSetupPlan = { id: 8, supported: true, message: '変更予定のみ', duplicateMicSources: [],
    changes: [{ source: '声', label: '同期', before: -40, after: 80 }],
    timing: { targetToken: 'real-voice-token', source: '声', currentOffsetMs: -40, additionalDelayMs: 120, resultOffsetMs: 80,
        measurement: { method: 'manual', comparison: 'voiceAccompaniment', measuredDelayMs: -120, referenceNote: '同じ録画の同時の合図', fps: 60, track: 1 } },
};
const history = (results = ['適用済み']): ObsSetupHistory => ({ id: 8, restorable: true, changes: plan.changes, timing: plan.timing, results, resultEntries: results.map(value => ({ outcome: value === '適用済み' ? 'applied' : 'restoreUnknown', text: { code: value === '適用済み' ? 'obs.result.applied' : 'obs.result.restoreReadbackUnknown', args: {}, fallbackJa: value } })) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
    vi.mocked(invoke).mockClear(); vi.mocked(listen).mockClear();
    vi.spyOn(obsApi, 'connectionStatus').mockResolvedValue(true);
    vi.spyOn(obsApi, 'disconnect').mockResolvedValue(undefined);
    vi.spyOn(obsApi, 'timingTargets').mockResolvedValue(targets);
    vi.spyOn(obsApi, 'previewTiming').mockResolvedValue(plan);
    vi.spyOn(obsApi, 'applySetup').mockResolvedValue(history());
    vi.spyOn(obsApi, 'restoreSetup').mockResolvedValue(history(['復元済み']));
    vi.spyOn(obsApi, 'setupHistory').mockResolvedValue([history()]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function measure(direction = 'early', comparison = 'voiceAccompaniment') {
    fireEvent.change(screen.getByRole('combobox', { name: '比較するもの' }), { target: { value: comparison } });
    fireEvent.change(screen.getByRole('combobox', { name: '録画でのタイミング' }), { target: { value: direction } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '測った差（ms・正の整数）' }), { target: { value: '120' } });
    fireEvent.change(screen.getByRole('textbox', { name: '比較基準と音声経路・処理のメモ' }), { target: { value: '同じ録画の同時の合図' } });
    fireEvent.click(screen.getByRole('checkbox'));
}
async function selectTarget(token = 'real-voice-token') {
    await waitFor(() => expect(screen.getByRole('button', { name: 'OBSの対象を取得・再取得' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'OBSの対象を取得・再取得' }));
    await screen.findByRole('combobox', { name: '追加遅延を入れるOBSソース' });
    fireEvent.change(screen.getByRole('combobox', { name: '追加遅延を入れるOBSソース' }), { target: { value: token } });
}
async function preview() {
    fireEvent.click(screen.getByRole('button', { name: '同期の変更予定を確認' }));
    await screen.findByLabelText('同期の変更予定');
}
async function apply() {
    fireEvent.click(screen.getByRole('button', { name: 'この同期変更を適用する' }));
    await screen.findByLabelText('同期変更 8 の結果');
}

it.each([
    ['early', 'voiceAccompaniment', 'real-voice-token', -120, '伴奏より早い声'],
    ['late', 'voiceAccompaniment', 'real-music-token', 120, '声より早い伴奏'],
    ['early', 'audioVideo', 'real-voice-token', -120, '映像より早い音声'],
])('方向 %s/%s を実対象への追加遅延だけに変換し、適用は明示操作に限定する', async (direction, comparison, token, signed, role) => {
    render(<ObsTimingCheck />);
    expect(obsApi.timingTargets).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    measure(direction, comparison);
    expect(screen.getByText(role, { exact: false })).toBeInTheDocument();
    await selectTarget(token);
    expect(obsApi.previewTiming).not.toHaveBeenCalled();
    await preview();
    expect(obsApi.previewTiming).toHaveBeenCalledWith({ targetToken: token, additionalDelayMs: 120,
        measurement: { method: 'manual', comparison, measuredDelayMs: signed, referenceNote: '同じ録画の同時の合図', fps: null, track: null } });
    expect(obsApi.applySetup).not.toHaveBeenCalled();
    await apply();
    expect(obsApi.applySetup).toHaveBeenCalledOnce();
    expect(obsApi.applySetup).toHaveBeenCalledWith(8);
    fireEvent.click(screen.getByRole('button', { name: '再録画を確認して採用 #8' }));
    expect(obsApi.applySetup).toHaveBeenCalledOnce();
    expect(screen.getByText(/今回の録画を基に採用/)).toBeInTheDocument();
});

it.each([['unknown', 'voiceAccompaniment', false], ['late', 'audioVideo', false], ['early', 'voiceAccompaniment', true]])('判断不能・音声遅れ対映像・混合済み入力では変更を提案しない', (direction, comparison, mixed) => {
    render(<ObsTimingCheck mixed={Boolean(mixed)} />); measure(direction as string, comparison as string);
    expect(screen.getByRole('button', { name: 'OBSの対象を取得・再取得' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '同期の変更予定を確認' })).toBeDisabled();
    expect(obsApi.previewTiming).not.toHaveBeenCalled();
});

it('API未対応は対象選択や適用へ進めず手動確認を残す', async () => {
    vi.mocked(obsApi.timingTargets).mockResolvedValue({ supported: false, message: '必要な操作が使えません', targets: [] });
    render(<ObsTimingCheck />); measure();
    await waitFor(() => expect(screen.getByRole('button', { name: 'OBSの対象を取得・再取得' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'OBSの対象を取得・再取得' }));
    await screen.findByText(/必要な操作が使えません/);
    expect(screen.queryByRole('combobox', { name: '追加遅延を入れるOBSソース' })).not.toBeInTheDocument();
    expect(obsApi.previewTiming).not.toHaveBeenCalled();
});

it('測定条件の変更は遅いプレビュー応答を捨て、再取得も以前の予定を消す', async () => {
    const pending = deferred<ObsSetupPlan>(); vi.mocked(obsApi.previewTiming).mockReturnValueOnce(pending.promise);
    render(<ObsTimingCheck />); measure(); await selectTarget();
    fireEvent.click(screen.getByRole('button', { name: '同期の変更予定を確認' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '測った差（ms・正の整数）' }), { target: { value: '140' } });
    await act(async () => pending.resolve(plan));
    expect(screen.queryByLabelText('同期の変更予定')).not.toBeInTheDocument();
    await preview();
    fireEvent.click(screen.getByRole('button', { name: 'OBSの対象を取得・再取得' }));
    expect(screen.queryByLabelText('同期の変更予定')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: '追加遅延を入れるOBSソース' })).toHaveValue(''));
});

it('構成無効化通知と取り込み方の変更で対象・予定・安全確認を失効させる', async () => {
    const view = render(<ObsTimingCheck />); measure(); await selectTarget(); await preview();
    await act(async () => {
        const callback = vi.mocked(listen).mock.calls.find(([name]) => name === 'obs://timing-invalidated')![1];
        callback({ event: 'obs://timing-invalidated', id: 1, payload: null });
    });
    expect(screen.queryByLabelText('同期の変更予定')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.queryByRole('combobox', { name: '追加遅延を入れるOBSソース' })).not.toBeInTheDocument();
    expect(obsApi.applySetup).not.toHaveBeenCalled();
    view.rerender(<ObsTimingCheck mixed />);
    expect(screen.getByText(/同じソースに混ざっているため/)).toBeInTheDocument();
});

it('readback未確認は採用できず、競合付き戻すの結果を成功へ置き換えない', async () => {
    vi.mocked(obsApi.applySetup).mockResolvedValue(history(['適用状態を要確認: OBSの変更後の値を確認できません']));
    vi.mocked(obsApi.restoreSetup).mockResolvedValue(history(['競合: 後から変更された可能性があるため復元しません']));
    render(<ObsTimingCheck />); measure(); await selectTarget(); await preview(); await apply();
    expect(screen.getByRole('button', { name: '再録画を確認して採用 #8' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '同期変更 #8 を戻す' }));
    await screen.findByText(/競合: 後から変更された/);
    expect(obsApi.restoreSetup).toHaveBeenCalledWith(8);
    expect(screen.queryByText(/今回の録画を基に採用/)).not.toBeInTheDocument();
});

it('適用通信失敗を未適用扱いせず、明示的な履歴取得から復元できる', async () => {
    vi.mocked(obsApi.applySetup).mockRejectedValue(new Error('timeout'));
    render(<ObsTimingCheck />); measure(); await selectTarget(); await preview();
    fireEvent.click(screen.getByRole('button', { name: 'この同期変更を適用する' }));
    await screen.findByText(/変更済みの可能性があります/);
    fireEvent.click(screen.getByRole('button', { name: '同期の履歴を再取得' }));
    await screen.findByLabelText('同期変更 8 の結果');
    expect(obsApi.setupHistory).toHaveBeenCalledOnce();
});

it('追加後の範囲超過と小数差はプレビューAPIへ送らない', async () => {
    render(<ObsTimingCheck />); measure(); await selectTarget();
    fireEvent.change(screen.getByRole('spinbutton', { name: '測った差（ms・正の整数）' }), { target: { value: '20950' } });
    expect(screen.getByRole('button', { name: '同期の変更予定を確認' })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: '測った差（ms・正の整数）' }), { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: '同期の変更予定を確認' })).toBeDisabled();
    expect(obsApi.previewTiming).not.toHaveBeenCalled();
});

it('APIは専用commandと厳密requestだけを渡す', async () => {
    vi.mocked(obsApi.timingTargets).mockRestore(); vi.mocked(obsApi.previewTiming).mockRestore();
    const request: ObsTimingRequest = { targetToken: 'real-token', additionalDelayMs: 5,
        measurement: { method: 'manual', comparison: 'audioVideo', measuredDelayMs: -5, referenceNote: '同時の光と音', fps: 30, track: 1 } };
    await obsApi.timingTargets(); await obsApi.previewTiming(request);
    expect(invoke).toHaveBeenCalledWith('obs_timing_targets');
    expect(invoke).toHaveBeenCalledWith('obs_preview_timing', { request });
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'obs_preview_setup')).toBe(false);
});


it.each(['audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error', 'global-bypass-changed', 'audio-conditions-changed'])('音声条件イベント%sで旧予定と採用・確認を失効させる', async event => {
    render(<ObsTimingCheck />); measure(); await selectTarget(); await preview();
    const callback = vi.mocked(listen).mock.calls.find(([name]) => name === event)![1];
    await act(async () => callback({ event, id: 1, payload: null }));
    expect(screen.queryByLabelText('同期の変更予定')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(obsApi.applySetup).not.toHaveBeenCalled();
});

it('採用後の音声条件変更でも過去の採用を無効化する', async () => {
    render(<ObsTimingCheck />); measure(); await selectTarget(); await preview(); await apply();
    fireEvent.click(screen.getByRole('button', { name: '再録画を確認して採用 #8' }));
    const callback = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-conditions-changed')![1];
    await act(async () => callback({ event: 'audio-conditions-changed', id: 1, payload: null }));
    expect(screen.queryByText(/今回の録画を基に採用/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '同期変更 #8 を戻す' })).toBeDisabled();
});

it('適用待ちの条件変更でも返った履歴を残し、安全な採用や復元は許可しない', async () => {
    const pending = deferred<ObsSetupHistory>(); vi.mocked(obsApi.applySetup).mockReturnValue(pending.promise);
    render(<ObsTimingCheck />); measure(); await selectTarget(); await preview();
    fireEvent.click(screen.getByRole('button', { name: 'この同期変更を適用する' }));
    const callback = vi.mocked(listen).mock.calls.find(([name]) => name === 'audio-conditions-changed')![1];
    await act(async () => { callback({ event: 'audio-conditions-changed', id: 1, payload: null }); pending.resolve(history(['適用状態を要確認'])); });
    expect(screen.getByLabelText('同期変更 8 の結果')).toHaveTextContent('適用状態を要確認');
    expect(screen.getByRole('button', { name: '同期変更 #8 を戻す' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '再録画を確認して採用 #8' })).toBeDisabled();
});


it('認証失敗は固定案内から既存設定へ委譲し、生のエラーやパスワードを表示しない', async () => {
    vi.mocked(obsApi.connectionStatus).mockResolvedValue(false);
    vi.spyOn(obsApi, 'connect').mockRejectedValue(new Error('auth private-value'));
    const settings = vi.fn();
    render(<ObsTimingCheck onOpenObsSettings={settings} />);
    fireEvent.click(await screen.findByRole('button', { name: '保存先のOBSへ接続' }));
    await screen.findByText(/認証が必要な場合はOBS接続設定で/);
    expect(screen.queryByText(/private-value/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OBS接続設定を開く' }));
    expect(settings).toHaveBeenCalledOnce();
    expect(obsApi.connect).toHaveBeenCalledWith({ host: 'localhost', port: 4455 });
});

it('typed outcomeだけを採用条件にし、locale変更は同じ入力・確認・接続購読を維持する', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><ObsTimingCheck /></LocaleProvider>);
    measure();
    await selectTarget();
    const input = screen.getByRole('textbox', { name: '比較基準と音声経路・処理のメモ' });
    const selected = screen.getByRole('combobox', { name: '追加遅延を入れるOBSソース' });
    const calls = { status: vi.mocked(obsApi.connectionStatus).mock.calls.length, targets: vi.mocked(obsApi.timingTargets).mock.calls.length, listen: vi.mocked(listen).mock.calls.length };
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('textbox', { name: 'Reference, audio routing and processing notes' })).toBe(input);
    expect(input).toHaveValue('同じ録画の同時の合図');
    expect(screen.getByRole('combobox', { name: 'OBS source to add delay to' })).toBe(selected);
    expect(selected).toHaveValue('real-voice-token');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(obsApi.connectionStatus).toHaveBeenCalledTimes(calls.status);
    expect(obsApi.timingTargets).toHaveBeenCalledTimes(calls.targets);
    expect(listen).toHaveBeenCalledTimes(calls.listen);
    fireEvent.click(screen.getByRole('button', { name: 'Preview sync changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply this sync change' }));
    await screen.findByText('Applied');
    expect(screen.getByRole('button', { name: 'Keep after checking a new recording #8' })).toBeEnabled();
    act(() => { store.setLocale('ja'); });
    expect(screen.getByRole('alert')).toHaveTextContent('変更結果を確認し');
    expect(obsApi.applySetup).toHaveBeenCalledExactlyOnceWith(8);
});
it.each([undefined, null, [], [{outcome: 'future', text: {code: 'obs.result.applied', args: {}, fallbackJa: '適用済み'}}]])('旧文言が適用済みでもtyped結果%jは採用を許可しない', async entries => {
    vi.mocked(obsApi.setupHistory).mockResolvedValue([{...history(), resultEntries: entries as ObsSetupHistory['resultEntries']}]);
    render(<ObsTimingCheck />);
    fireEvent.click(screen.getByRole('button', {name: '同期の履歴を再取得'}));
    expect(await screen.findByRole('button', {name: '再録画を確認して採用 #8'})).toBeDisabled();
    expect(obsApi.applySetup).not.toHaveBeenCalled();
});
