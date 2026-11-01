import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { obsApi, type ObsSetupPlan, type ObsSetupHistory } from '@/api/obs';
import { ObsSafeSetup } from '../ObsSafeSetup';

vi.mock('@/api/obs', () => ({
    obsApi: {
        setupHistory: vi.fn(),
        previewSetup: vi.fn(),
        applySetup: vi.fn(),
        forgetHistory: vi.fn(),
        restoreSetup: vi.fn(),
    },
}));
const change = { source: 'Auralyn マイク', label: 'ミュート', before: true, after: false, labelText: { code: 'obs.field.muted', args: {}, fallbackJa: 'ミュート' }, beforeText: { code: 'obs.value.boolean', args: {value: true}, fallbackJa: 'ON' }, afterText: { code: 'obs.value.boolean', args: {value: false}, fallbackJa: 'OFF' } };
const plan: ObsSetupPlan = {
    id: 7,
    supported: true,
    message: '',
    changes: [change],
    duplicateMicSources: ['マイク2'],
};
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
    it('適用中に世代が変わった履歴は、再取得せず復元不可を表示する', async () => {
        vi.mocked(obsApi.applySetup).mockResolvedValue({
            ...history,
            restorable: false,
            results: ['競合: 適用を中断しました'],
        });
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
        expect(await screen.findByRole('button', { name: '変更 #7 を元に戻す' })).toBeDisabled();
        expect(screen.getByText(/現在の接続では安全に復元できません/)).toBeInTheDocument();
        expect(obsApi.restoreSetup).not.toHaveBeenCalled();
    });

    it('予定を表示し、キャンセルでは適用しない', async () => {
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        await screen.findByText('ON → OFF');
        expect(obsApi.applySetup).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
        expect(
            screen.queryByRole('button', { name: 'この変更を適用する' }),
        ).not.toBeInTheDocument();
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
        vi.mocked(obsApi.previewSetup).mockResolvedValue({
            ...plan,
            supported: false,
            changes: [],
            message: '手動の手順をご利用ください。',
        });
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        await screen.findByText(/手動の手順をご利用ください。/);
        expect(
            screen.queryByRole('button', { name: 'この変更を適用する' }),
        ).not.toBeInTheDocument();
    });
    it('重複マイクもミュート予定を先に確認する', async () => {
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        fireEvent.click(
            await screen.findByRole('button', { name: '「マイク2」のミュート予定を確認' }),
        );
        await waitFor(() => expect(obsApi.previewSetup).toHaveBeenLastCalledWith('マイク2'));
        expect(obsApi.applySetup).not.toHaveBeenCalled();
    });
    it('部分失敗と競合を成功として表示しない', async () => {
        vi.mocked(obsApi.applySetup).mockResolvedValue({
            ...history,
            results: ['失敗（適用状態を要確認）'],
        });
        vi.mocked(obsApi.restoreSetup).mockResolvedValue({
            ...history,
            results: ['競合: 後から変更されたため復元しません'],
        });
        renderSetup();
        const historySummary = screen.getByText('過去の変更履歴');
        expect(historySummary.closest('details')).not.toHaveAttribute('open');
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
        expect(await screen.findByText(/失敗（適用状態を要確認）/)).toBeVisible();
        expect(historySummary.closest('details')).toHaveAttribute('open');
        expect(historySummary).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: '変更 #7 を元に戻す' }));
        await screen.findByText(/競合: 後から変更されたため復元しません/);
    });
    it('適用中の二重送信を防ぐ', async () => {
        let finish!: (value: ObsSetupHistory) => void;
        vi.mocked(obsApi.applySetup).mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        renderSetup();
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        const button = await screen.findByRole('button', { name: 'この変更を適用する' });
        fireEvent.click(button);
        fireEvent.click(button);
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

it('切断後の履歴を表示し、再接続前の履歴を自動復元しない', async () => {
    vi.mocked(obsApi.setupHistory).mockResolvedValue([
        { ...history, restorable: false, connectionLabel: 'localhost:4455' },
    ]);
    render(<ObsSafeSetup connected={false} disabled onBusyChange={() => {}} />);
    await screen.findByText(/現在の接続では安全に復元できません/);
    expect(screen.getByText('ON → OFF')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '変更 #7 を元に戻す' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '履歴を再取得' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '変更 #7 の履歴を削除' }));
    expect(obsApi.forgetHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '確認して履歴を削除' }));
    await waitFor(() => expect(obsApi.forgetHistory).toHaveBeenCalledWith(7));
    expect(obsApi.restoreSetup).not.toHaveBeenCalled();
});

it('遅い初期履歴の取得で適用後の新しい履歴を消さない', async () => {
    let finish!: (items: ObsSetupHistory[]) => void;
    vi.mocked(obsApi.setupHistory).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    renderSetup();
    fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
    await screen.findByRole('button', { name: '変更 #7 を元に戻す' });
    await act(async () => {
        finish([]);
    });
    expect(screen.getByRole('button', { name: '変更 #7 を元に戻す' })).toBeInTheDocument();
});


it('同期の測定履歴は通常セットアップとは区別して対象・差分・測定条件を表示する', async () => {
    vi.mocked(obsApi.setupHistory).mockResolvedValue([{ ...history, timing: {
        targetToken: 'real-target', source: '歌声', currentOffsetMs: 20, additionalDelayMs: 80, resultOffsetMs: 100,
        measurement: { method: 'manual', comparison: 'voiceAccompaniment', measuredDelayMs: -80, referenceNote: '同時の合図・48k', fps: null, track: 1 },
    } }]);
    renderSetup();
    expect(await screen.findByText(/同期変更 #7/)).toBeInTheDocument();
    expect(screen.getByText(/同期：歌声/)).toHaveTextContent('20 ms → 100 ms（追加 80 ms）');
    expect(screen.getByText(/測定条件：同時の合図/)).toBeInTheDocument();
    expect(obsApi.previewSetup).not.toHaveBeenCalled();
    expect(obsApi.applySetup).not.toHaveBeenCalled();
});

it('typed予定・全結果outcomeを翻訳し、確認途中のlocale変更で再取得や書込をしない', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    vi.mocked(obsApi.previewSetup).mockResolvedValue({...plan, message: '原文予定', messageText: {code: 'obs.plan.selectedExisting', args: {}, fallbackJa: '原文予定'}});
    render(<LocaleProvider store={store}><ObsSafeSetup disabled={false} onBusyChange={() => {}} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', {name: '変更予定を確認する'}));
    const preview = await screen.findByLabelText('OBS の変更予定');
    act(() => { store.setLocale('en'); });
    expect(screen.getByText('Planned changes to the selected existing sources and filters.')).toBeInTheDocument();
    expect(preview).toBeInTheDocument();
    expect(screen.getByText('Auralyn マイク：Mute')).toBeVisible();
    expect(obsApi.previewSetup).toHaveBeenCalledTimes(1);
    expect(obsApi.setupHistory).toHaveBeenCalledTimes(1);
    expect(obsApi.applySetup).not.toHaveBeenCalled();
    expect(obsApi.restoreSetup).not.toHaveBeenCalled();
});

it('typedの全outcomeは結果を表示するだけで復元を実行しない', async () => {
    const outcomes = ['notRun', 'applied', 'conflict', 'applyUnknown', 'restoreDeferred', 'restoreUnknown', 'restored', 'alreadyOriginal', 'restoreFailed'] as const;
    const codes = ['notRun', 'applied', 'valueConflict', 'applyWriteUnknown', 'restoreAudioDeferred', 'restoreReadbackUnknown', 'restored', 'alreadyOriginal', 'restoreWriteFailed'];
    vi.mocked(obsApi.setupHistory).mockResolvedValue(outcomes.map((outcome, index) => ({...history, id: index + 1, restorable: outcome === 'applied', resultEntries: [{outcome, text:{code:'obs.result.' + codes[index], args:{}, fallbackJa:'個別の原文'}}]})));
    const store = createLocaleStore(() => 'en', () => true);
    render(<LocaleProvider store={store}><ObsSafeSetup disabled={false} onBusyChange={() => {}} /></LocaleProvider>);
    fireEvent.click(screen.getByText('Previous changes'));
    expect(await screen.findByText(/Already at the original value/)).toBeVisible();
    for(const text of ['Not run','Applied','Restored']) expect(screen.getByText(text, {exact:false})).toBeVisible();
    expect(screen.getByText(/The write result is unknown/)).toBeVisible();
    expect(screen.getByText(/Restore failed/)).toHaveTextContent('Original detail (untranslated): 個別の原文');
    expect(obsApi.restoreSetup).not.toHaveBeenCalled();
    expect(obsApi.applySetup).not.toHaveBeenCalled();
});

it.each(['ja', 'en'] as const)('未接続の理由を表示し、確認と復元に関連付ける (%s)', async locale => {
    vi.mocked(obsApi.setupHistory).mockResolvedValue([{ ...history, restorable: false }]);
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><ObsSafeSetup connected={false} disabled onBusyChange={() => {}} /></LocaleProvider>);
    const reason = locale === 'ja' ? 'OBSに接続すると使えます。' : 'Connect to OBS to use this.';
    const preview = screen.getByRole('button', { name: locale === 'ja' ? '変更予定を確認する' : 'Review proposed changes' });
    expect(screen.getByText(reason)).toBeVisible();
    expect(preview).toBeDisabled();
    expect(preview).toHaveAccessibleDescription(reason);
    const undo = await screen.findByRole('button', { name: locale === 'ja' ? '変更 #7 を元に戻す' : /Undo change #7/ });
    expect(undo).toHaveAccessibleDescription(expect.stringContaining(reason));
});
