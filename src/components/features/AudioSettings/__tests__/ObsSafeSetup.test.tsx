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
            results: ['競合：適用を中断しました'],
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
        const raw = await screen.findByText(/手動の手順をご利用ください。/);
        expect(raw.closest('details')).not.toHaveAttribute('open');
        expect(raw).not.toBeVisible();
        expect(screen.getByText(/変更予定を確認できません/)).toBeVisible();
        fireEvent.click(raw.closest('details')!.querySelector('summary')!);
        expect(raw).toBeVisible();
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
            results: ['競合：後から変更されたため復元しません'],
        });
        renderSetup();
        const historySummary = screen.getByText('過去の変更履歴');
        expect(historySummary.closest('details')).not.toHaveAttribute('open');
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
        expect(await screen.findByText(/失敗（適用状態を要確認）/)).not.toBeVisible();
        expect(historySummary.closest('details')).toHaveAttribute('open');
        expect(historySummary).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: '変更 #7 を元に戻す' }));
        await screen.findByText(/競合：後から変更されたため復元しません/);
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
    for (const raw of screen.getAllByText('個別の原文')) {
        expect(raw.closest('details')).not.toHaveAttribute('open');
        expect(raw).not.toBeVisible();
        fireEvent.click(raw.closest('details')!.querySelector('summary')!);
        expect(raw).toBeVisible();
        expect(raw.textContent).toBe('個別の原文');
    }
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

it.each(['ja', 'en'] as const)('OBS の取得・操作エラーは要約と次の操作を本文に残し、原文は閉じた詳細に置く（%s）', async locale => {
    const store = createLocaleStore(() => locale, () => true);
    const raw = 'Error: OBS request failed\n' + 'long-detail-'.repeat(30);
    vi.mocked(obsApi.setupHistory).mockRejectedValueOnce(new Error(raw.slice(7)));
    render(<LocaleProvider store={store}><ObsSafeSetup disabled={false} onBusyChange={() => {}} /></LocaleProvider>);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(locale === 'ja' ? '変更履歴を取得できませんでした。' : 'Could not retrieve the change history.');
    expect(alert).toHaveTextContent(locale === 'ja' ? '履歴を再取得' : 'Refresh history');
    expect(alert).not.toHaveTextContent(raw);
    const pre = screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === raw);
    const details = pre.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(pre).not.toBeVisible();
    const summary = details.querySelector('summary')!;
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(pre).toBeVisible();
    expect(pre).toHaveClass('font-mono', 'whitespace-pre-wrap', 'select-text');
    fireEvent.click(summary);
    expect(pre).not.toBeVisible();
    vi.mocked(obsApi.previewSetup).mockRejectedValueOnce('preview failed');
    fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? '変更予定を確認する' : 'Review proposed changes' }));
    const operationRaw = await screen.findByText('preview failed');
    expect(operationRaw.closest('details')).not.toHaveAttribute('open');
    expect(operationRaw).not.toBeVisible();
});


it.each(['history', 'preview', 'apply', 'undo', 'forget'] as const)('失敗した操作 %s に合う要約と次の操作を表示する', async operation => {
    const raw = `Error: ${operation} transport failed`;
    vi.mocked(obsApi.setupHistory).mockResolvedValue([history]);
    renderSetup();
    await screen.findByRole('button', { name: '変更 #7 を元に戻す' });
    fireEvent.click(screen.getByText('過去の変更履歴'));
    if (operation === 'history') {
        vi.mocked(obsApi.setupHistory).mockRejectedValueOnce(raw);
        fireEvent.click(screen.getByRole('button', { name: '履歴を再取得' }));
    } else if (operation === 'preview') {
        vi.mocked(obsApi.previewSetup).mockRejectedValueOnce(raw);
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
    } else if (operation === 'apply') {
        vi.mocked(obsApi.applySetup).mockRejectedValueOnce(raw);
        fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
        fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
    } else if (operation === 'undo') {
        vi.mocked(obsApi.restoreSetup).mockRejectedValueOnce(raw);
        fireEvent.click(screen.getByRole('button', { name: '変更 #7 を元に戻す' }));
    } else {
        vi.mocked(obsApi.forgetHistory).mockRejectedValueOnce(raw);
        fireEvent.click(screen.getByRole('button', { name: '変更 #7 の履歴を削除' }));
        fireEvent.click(screen.getByRole('button', { name: '確認して履歴を削除' }));
    }
    const alert = await screen.findByRole('alert');
    const summaries = { history: '変更履歴を取得できませんでした。', preview: '変更予定を確認できませんでした。', apply: '変更の適用を確認できませんでした。', undo: '変更の取り消しを確認できませんでした。', forget: '履歴を削除できませんでした。' };
    expect(alert).toHaveTextContent(summaries[operation]);
    expect(alert).toHaveTextContent(operation === 'preview' ? 'OBS の接続を確認し、「変更予定を確認する」で再試行' : '履歴を再取得');
    expect(alert).not.toHaveTextContent(raw);
    expect(screen.getByText(raw)).not.toBeVisible();
});

it('履歴上限の既知の対処を本文に表示する', async () => {
    vi.mocked(obsApi.previewSetup).mockRejectedValueOnce('変更履歴が20件あります。OBSで状態を確認し、不要な履歴を削除してください。');
    renderSetup();
    fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('不要な履歴を削除してください');
    expect(screen.getByRole('alert')).not.toHaveTextContent('接続を確認');
});

it('既知の型付き対処を本文に出し、変更一覧がある未知の補足は確認失敗と呼ばない', async () => {
    vi.mocked(obsApi.previewSetup).mockRejectedValueOnce({ code: 'obs.plan.unsupported', args: {}, fallbackJa: 'Error: original reason' });
    renderSetup();
    fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('現在の条件では変更を提案できません');
    expect(screen.getByText('Error: original reason')).not.toBeVisible();
    vi.mocked(obsApi.previewSetup).mockResolvedValueOnce({ ...plan, message: 'Error: unknown plan message' });
    fireEvent.click(screen.getByRole('button', { name: '変更予定を確認する' }));
    await screen.findByRole('button', { name: 'この変更を適用する' });
    expect(screen.getByText(/適用前に下の変更一覧を確認/)).toBeVisible();
    expect(screen.queryByText(/変更予定を確認できません/)).not.toBeInTheDocument();
    expect(screen.getByText('Error: unknown plan message')).not.toBeVisible();
});

it.each(['obs.result.applyInterrupted', 'obs.result.applyWriteUnknown', 'obs.result.restoreWriteFailed'])('履歴の %s 原文は項目ごとの閉じた詳細でだけ読める', async code => {
    const raw = 'Error: failure detail\n' + 'x'.repeat(200);
    vi.mocked(obsApi.setupHistory).mockResolvedValue([{ ...history, resultEntries: [{ outcome: 'applyUnknown', text: { code, args: {}, fallbackJa: raw } }] }]);
    renderSetup();
    fireEvent.click(screen.getByText('過去の変更履歴'));
    const pre = await screen.findByText((_, node) => node?.tagName === 'PRE' && node.textContent === raw);
    expect(pre).not.toBeVisible();
    expect(pre.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(pre.closest('details')!.querySelector('summary')!);
    expect(pre).toBeVisible();
    expect(pre.textContent).toBe(raw);
});
