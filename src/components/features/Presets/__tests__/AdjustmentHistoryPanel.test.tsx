import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { liveModesApi } from '@/api/liveModes';
import { builtinApi } from '@/api/builtinEffects';
import { readOutputGainStatus } from '@/api/outputGain';
import { voicePreviewApi } from '@/api/voiceCheckPreview';
import { AdjustmentHistoryPanel } from '../AdjustmentHistoryPanel';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';

const builtin = {epoch: 'one', revision: '2', appliedRevision: '2', config: {active: true, preset: 'warm', amount: 0.5, singing: null}, pending: false, undoToken: 'undo', redoToken: null, error: null} as const;
beforeEach(() => {
    vi.spyOn(liveModesApi, 'request').mockResolvedValue({armed: false} as any);
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({running: true, streamFailed: false});
    vi.spyOn(builtinApi, 'request').mockResolvedValue(builtin);
    vi.spyOn(readOutputGainStatusModule, 'readOutputGainStatus').mockResolvedValue({settled: true, undoAvailable: true, redoAvailable: false, historyId: 7, historyEpoch: "engine-one"} as any);
    vi.spyOn(voicePreviewApi, 'request').mockResolvedValue({noisePending: false, noiseUndoToken: 'nr-undo'} as any);
});
import * as readOutputGainStatusModule from '@/api/outputGain';
afterEach(() => {cleanup(); vi.restoreAllMocks();});

it('状態更新は対象名ごと読み上げ、各操作の説明も同じ対象と状態へ結び付ける', async () => {
    render(<AdjustmentHistoryPanel onVoiceCheck={vi.fn()} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', {name: '履歴の状態を確認'}));
    await waitFor(() => expect(screen.getAllByText('適用前へ戻せます')).toHaveLength(3));
    for (const label of ['NR候補', '内蔵処理', '固定出力ゲイン']) {
        const row = screen.getByText(new RegExp(`^${label}:`)).closest('li')!;
        const status = within(row).getByRole('status');
        expect(status).toHaveTextContent(`${label}: 適用前へ戻せます`);
        expect(status).toHaveAttribute('aria-atomic', 'true');
        for (const button of within(row).getAllByRole('button')) {
            expect(button).toHaveAccessibleDescription(`${label}: 適用前へ戻せます`);
        }
    }
});

it('未作成・対象編集・新測定の理由を対象別に示し、原因から操作権限を作らない', async () => {
    vi.mocked(builtinApi.request).mockResolvedValue({...builtin, undoToken: null, historyReason: 'settings_changed'});
    vi.mocked(voicePreviewApi.request).mockResolvedValue({noiseHistoryReason: 'not_created', noisePending: false} as any);
    vi.mocked(readOutputGainStatusModule.readOutputGainStatus).mockResolvedValue({historyReason: 'new_measurement', settled: false} as any);
    render(<AdjustmentHistoryPanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', {name: '履歴の状態を確認'}));
    await waitFor(() => expect(screen.getByText('対象の設定が編集されたため、履歴が失効しました')).toBeInTheDocument());
    expect(screen.getByText('このエンジンでは履歴がまだありません')).toBeInTheDocument();
    expect(screen.getByText('新しい測定・録音を始めたため、前の履歴が失効しました')).toBeInTheDocument();
    for (const button of screen.getAllByRole('button', {name: /適用前へ戻す|変更後を再適用/})) expect(button).toBeDisabled();
});

it.each([
    ['input_changed', 'input conditions changed'],
    ['learning_changed', 'noise measurement or learning conditions changed'],
    ['stream_changed', 'audio was started or stopped'],
    ['stream_failed', 'audio processing failed'],
    ['conditions_changed', 'related audio conditions changed'],
])('英語でも%sの根拠を表示する', async (reason, expected) => {
    vi.mocked(builtinApi.request).mockResolvedValue({...builtin, undoToken: null, historyReason: reason as any});
    const store = createLocaleStore(() => 'en', () => true);
    render(<LocaleProvider store={store}><AdjustmentHistoryPanel /></LocaleProvider>);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', {name: 'Check history status'}));
    await waitFor(() => expect(screen.getByText(new RegExp(expected))).toBeInTheDocument());
});

it.each([undefined, 'future_reason'])('理由コード%sを未作成や設定変更と推測しない', async reason => {
    vi.mocked(builtinApi.request).mockResolvedValue({...builtin, undoToken: null, historyReason: reason as any});
    render(<AdjustmentHistoryPanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', {name: '履歴の状態を確認'}));
    await waitFor(() => expect(screen.getByText('履歴の有無・失効理由を確認できません。状態を取得し直してください')).toBeInTheDocument());
    expect(screen.queryByText('このエンジンでは履歴がまだありません')).not.toBeInTheDocument();
});

it('取得失敗では直前の原因を表示し続けず、再確認で新しい理由へ更新する', async () => {
    vi.mocked(builtinApi.request).mockResolvedValue({...builtin, undoToken: null, historyReason: 'input_changed'});
    render(<AdjustmentHistoryPanel />);
    await act(async () => {});
    const check = screen.getByRole('button', {name: '履歴の状態を確認'});
    fireEvent.click(check);
    await waitFor(() => expect(screen.getByText(/入力機器・チャンネル・入力ゲインなどの条件変更/)).toBeInTheDocument());
    vi.mocked(builtinApi.request).mockRejectedValueOnce(new Error('unavailable'));
    fireEvent.click(check);
    await waitFor(() => expect(screen.getAllByText('履歴の状態を取得できません。再確認してください')).toHaveLength(3));
    expect(screen.queryByText(/入力機器・チャンネル・入力ゲインなどの条件変更/)).not.toBeInTheDocument();
    vi.mocked(builtinApi.request).mockResolvedValue({...builtin, undoToken: null, historyReason: 'not_created'});
    fireEvent.click(check);
    await waitFor(() => expect(screen.getByText('このエンジンでは履歴がまだありません')).toBeInTheDocument());
});

it('停止中も理由を読み取るが、履歴取得から音声を開始しない', async () => {
    const start = vi.spyOn(audioApi, 'start');
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({running: false, streamFailed: false});
    vi.mocked(builtinApi.request).mockResolvedValue({...builtin, historyReason: 'stream_changed'});
    render(<AdjustmentHistoryPanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', {name: '履歴の状態を確認'}));
    await waitFor(() => expect(screen.getByText('音声の開始・停止やストリーム条件の変更で、履歴が失効しました')).toBeInTheDocument());
    expect(screen.getByText('音声は停止中です。Undo／Redoは実行しません')).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    for (const button of screen.getAllByRole('button', {name: '適用前へ戻す'})) expect(button).toBeDisabled();
});
it('表示だけでは状態取得や設定変更をせず、明示取得で方向を表示する', async () => {
    const open = vi.fn(); render(<AdjustmentHistoryPanel onVoiceCheck={open} />);
    await act(async () => {});
    expect(audioApi.getAudioStreamState).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '履歴の状態を確認'}));
    await waitFor(() => expect(screen.getAllByText('適用前へ戻せます')).toHaveLength(3));
    expect(voicePreviewApi.request).toHaveBeenCalledWith(expect.objectContaining({action: 'history_status'}));
    fireEvent.click(screen.getByRole('button', {name: '録音チェックで操作する'}));
    expect(open).toHaveBeenCalledOnce();
    expect(builtinApi.request).toHaveBeenCalledWith({action: 'snapshot'});
    expect(readOutputGainStatus).toHaveBeenCalledOnce();
});
it('反映を確認したUndoの後だけRedoを有効にし、別変更通知で失効表示にする', async () => {
    let undone = false;
    vi.mocked(builtinApi.request).mockImplementation(async request => {
        if (request.action === 'undo') undone = true;
        return undone ? {...builtin, revision: '3', appliedRevision: '3', undoToken: null, redoToken: 'redo'} : builtin;
    });
    render(<AdjustmentHistoryPanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', {name: '履歴の状態を確認'}));
    await waitFor(() => expect(screen.getAllByText('適用前へ戻せます')).toHaveLength(3));
    const row = screen.getByText(/^内蔵処理:/).closest('li')!;
    const undo = within(row).getByRole('button', {name: '適用前へ戻す'});
    undo.focus();
    fireEvent.click(undo);
    await waitFor(() => expect(within(row).getByRole('button', {name: '変更後を再適用'})).toBeEnabled());
    expect(screen.getByRole('region', {name: '現在のUndo／Redo'})).toHaveFocus();
    act(() => window.dispatchEvent(new Event('profile-fx-applied')));
    expect(within(row).getByRole('button', {name: '変更後を再適用'})).toBeDisabled();
});

it('本番保護中はトークンが残っていても操作可能と表示しない', async () => {
    vi.mocked(liveModesApi.request).mockResolvedValue({armed: true} as any);
    render(<AdjustmentHistoryPanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', {name: '履歴の状態を確認'}));
    await waitFor(() => expect(screen.getAllByText('本番保護中のため操作できません')).toHaveLength(3));
    for (const button of screen.getAllByRole('button', {name: '適用前へ戻す'})) expect(button).toBeDisabled();
});
