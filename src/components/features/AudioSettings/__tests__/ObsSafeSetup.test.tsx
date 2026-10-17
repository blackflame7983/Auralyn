import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { obsApi, type ObsSetupPlan, type ObsSetupHistory } from '@/api/obs';
import { ObsSafeSetup } from '../ObsSafeSetup';

vi.mock('@/api/obs', () => ({ obsApi: { setupHistory: vi.fn(), previewSetup: vi.fn(), applySetup: vi.fn(), restoreSetup: vi.fn() } }));
const change = { source: 'Auralyn マイク', label: 'ミュート', before: true, after: false };
const plan: ObsSetupPlan = { id: 7, supported: true, message: '', changes: [change], duplicateMicSources: ['マイク2'] };
const history: ObsSetupHistory = { id: 7, changes: [change], results: ['適用済み'] };
beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(obsApi.setupHistory).mockResolvedValue([]);
    vi.mocked(obsApi.previewSetup).mockResolvedValue(plan);
    vi.mocked(obsApi.applySetup).mockResolvedValue(history);
    vi.mocked(obsApi.restoreSetup).mockResolvedValue({ ...history, results: ['復元済み'] });
});
afterEach(cleanup);
const renderSetup = () => render(<ObsSafeSetup disabled={false} onBusyChange={() => {}} />);
describe('OBS の変更確認と復元', () => {
    it('予定を表示し、キャンセルでは適用しない', async () => {
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        await screen.findByText('ON → OFF');
        expect(obsApi.applySetup).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
        expect(screen.queryByRole('button', { name: 'この変更を適用する' })).not.toBeInTheDocument();
        expect(obsApi.applySetup).not.toHaveBeenCalled();
    });
    it('確認後だけ適用し、結果と復元を表示する', async () => {
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
        const undo = await screen.findByRole('button', { name: '変更 #7 を元に戻す' });
        expect(obsApi.applySetup).toHaveBeenCalledExactlyOnceWith(7);
        fireEvent.click(undo);
        await screen.findByText(/復元済み/);
        expect(obsApi.restoreSetup).toHaveBeenCalledExactlyOnceWith(7);
    });
    it('未対応では適用ボタンを出さない', async () => {
        vi.mocked(obsApi.previewSetup).mockResolvedValue({ ...plan, supported: false, changes: [], message: '手動の手順をご利用ください。' });
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        await screen.findByText('手動の手順をご利用ください。');
        expect(screen.queryByRole('button', { name: 'この変更を適用する' })).not.toBeInTheDocument();
    });
    it('重複マイクもミュート予定を先に確認する', async () => {
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        fireEvent.click(await screen.findByRole('button', { name: '「マイク2」のミュート予定を確認' }));
        await waitFor(() => expect(obsApi.previewSetup).toHaveBeenLastCalledWith('マイク2'));
        expect(obsApi.applySetup).not.toHaveBeenCalled();
    });
    it('部分失敗と競合を成功として表示しない', async () => {
        vi.mocked(obsApi.applySetup).mockResolvedValue({ ...history, results: ['失敗（適用状態を要確認）'] });
        vi.mocked(obsApi.restoreSetup).mockResolvedValue({ ...history, results: ['競合: 後から変更されたため復元しません'] });
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
        await screen.findByText(/失敗（適用状態を要確認）/);
        fireEvent.click(screen.getByRole('button', { name: '変更 #7 を元に戻す' }));
        await screen.findByText(/競合: 後から変更されたため復元しません/);
    });
    it('適用中の二重送信を防ぐ', async () => {
        let finish!: (value: ObsSetupHistory) => void;
        vi.mocked(obsApi.applySetup).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        const button = await screen.findByRole('button', { name: 'この変更を適用する' });
        fireEvent.click(button); fireEvent.click(button);
        expect(obsApi.applySetup).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: 'キャンセル' })).toBeDisabled();
        finish(history);
        await screen.findByRole('button', { name: '変更 #7 を元に戻す' });
    });
    it('画面を開き直しても接続中の履歴を取り出せる', async () => {
        vi.mocked(obsApi.setupHistory).mockResolvedValue([history]);
        renderSetup();
        await screen.findByRole('button', { name: '変更 #7 を元に戻す' });
    });
});
