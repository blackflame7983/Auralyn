import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { liveModesApi } from '@/api/liveModes';
import { builtinApi } from '@/api/builtinEffects';
import { readOutputGainStatus } from '@/api/outputGain';
import { voicePreviewApi } from '@/api/voiceCheckPreview';
import { AdjustmentHistoryPanel } from '../AdjustmentHistoryPanel';

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
    fireEvent.click(within(row).getByRole('button', {name: '適用前へ戻す'}));
    await waitFor(() => expect(within(row).getByRole('button', {name: '変更後を再適用'})).toBeEnabled());
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
