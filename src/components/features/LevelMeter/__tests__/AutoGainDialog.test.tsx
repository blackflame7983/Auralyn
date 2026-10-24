import { FixedClientError } from '@/lib/clientError';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoGainDialog } from '../AutoGainDialog';
import {
    confirmOutputGain,
    gainCommand,
    type GainRequest,
    type GainSnapshot,
} from '@/api/outputGain';

vi.mock('@/api/outputGain', () => ({ gainCommand: vi.fn(), confirmOutputGain: vi.fn() }));
const base: GainSnapshot = {
    revision: 100,
    gain: 0.8,
    confirmedGain: 0.8,
    settled: true,
    running: true,
    streamFailed: false,
    id: 42,
    phase: 'ready',
    progress: 1,
    playing: false,
    error: null,
    devices: [{ id: 'headphones', name: 'ヘッドホン' }],
    proposal: { before: 0.8, after: 1, measured: -22, predicted: -20, peak: -4, limited: false },
};
let current: GainSnapshot;
beforeEach(() => {
    vi.clearAllMocks();
    current = { ...base };
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    vi.mocked(gainCommand).mockImplementation(async (r: GainRequest) => {
        if (r.action === 'apply')
            current = { ...current, phase: 'applied', revision: 101, gain: 1, confirmedGain: 1 };
        if (r.action === 'restore')
            current = {
                ...current,
                phase: 'restored',
                revision: 102,
                gain: 0.8,
                confirmedGain: 0.8,
            };
        return current;
    });
    vi.mocked(confirmOutputGain).mockImplementation(async (s) => s);
});
afterEach(async () => {
    cleanup();
    await act(async () => {});
});
describe('自動ゲインの操作', () => {
    it('障害後の破棄は取消だけを送り、停止済みACKから開始や音量適用へ進まない', async () => {
        const view = render(<AutoGainDialog onClose={() => {}} />);
        await screen.findByRole('button', { name: 'この音量を使う' });
        vi.mocked(gainCommand).mockResolvedValue({ ...base, revision: 0, id: 0,
            settled: false, running: false, gain: 1, confirmedGain: 1,
            phase: 'idle', proposal: null, playing: false });
        vi.mocked(gainCommand).mockClear();
        view.unmount();
        await act(async () => {});
        expect(gainCommand).toHaveBeenCalledExactlyOnceWith({ action: 'cancel' });
        expect(confirmOutputGain).not.toHaveBeenCalled();
    });
    it('提案の準備完了後は、変更できない目標選択ではなく適用・聞き比べを案内する', async () => {
        render(<AutoGainDialog onClose={() => {}} />);
        const apply = await screen.findByRole('button', { name: 'この音量を使う' });
        expect(screen.getByRole('status')).toHaveTextContent('提案を確認し、「この音量を使う」で適用するか、試聴先を選んで聞き比べてください');
        expect(screen.getByRole('status')).not.toHaveTextContent('目標を選び、録音してください');
        expect(screen.getByLabelText('自動調整の目標')).toBeDisabled();
        expect(apply).toBeEnabled();
        expect(screen.getByRole('button', { name: '調整後を聴く' })).toBeDisabled();
        expect(gainCommand).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'apply' }));
    });
    it('提案があっても音量の反映が未確認なら、適用できると案内しない', async () => {
        current = { ...base, settled: false };
        render(<AutoGainDialog onClose={() => {}} />);
        await screen.findByRole('button', { name: 'この音量を使う' });
        expect(screen.getByRole('status')).toHaveTextContent('音量の反映を確認しています');
        expect(screen.getByRole('button', { name: 'この音量を使う' })).toBeDisabled();
    });
    it('録音前は目標選択と録音を案内する', async () => {
        current = { ...base, phase: 'idle', proposal: null };
        render(<AutoGainDialog onClose={() => {}} />);
        await screen.findByRole('button', { name: '録音して提案する' });
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('目標を選び、録音してください'));
        expect(screen.getByLabelText('自動調整の目標')).toBeEnabled();
    });
    it('停止応答を確認できるまで閉じず、失敗時は再試行できる', async () => {
        const onClose = vi.fn();
        render(<AutoGainDialog onClose={onClose} />);
        await screen.findByRole('button', { name: 'この音量を使う' });
        vi.mocked(gainCommand).mockRejectedValueOnce(new Error('停止に失敗'));
        fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
        await screen.findByText(/停止を確認できません。閉じる操作を再試行/);
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    });
    it('確認操作まで適用せず、同一世代の適用と復元を送る', async () => {
        render(<AutoGainDialog onClose={() => {}} />);
        const apply = await screen.findByRole('button', { name: 'この音量を使う' });
        expect(vi.mocked(gainCommand).mock.calls.some(([r]) => r.action === 'apply')).toBe(false);
        fireEvent.click(apply);
        await waitFor(() =>
            expect(screen.getByText('提案した音量を適用しました')).toBeInTheDocument(),
        );
        expect(gainCommand).toHaveBeenCalledWith({ action: 'apply', id: 42, revision: 100 });
        fireEvent.click(screen.getByRole('button', { name: '元に戻す' }));
        await waitFor(() =>
            expect(gainCommand).toHaveBeenCalledWith({ action: 'restore', id: 42, revision: 101 }),
        );
    });
    it('試聴先と配信へ流れない確認が揃うまで再生しない', async () => {
        render(<AutoGainDialog onClose={() => {}} />);
        const play = await screen.findByRole('button', { name: '調整後を聴く' });
        expect(play).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: '試聴先を取得・更新' }));
        await screen.findByRole('option', { name: 'ヘッドホン' });
        fireEvent.change(screen.getByLabelText('聞き比べの試聴先'), {
            target: { value: 'headphones' },
        });
        expect(play).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(play);
        await waitFor(() =>
            expect(gainCommand).toHaveBeenCalledWith({
                action: 'preview',
                id: 42,
                after: true,
                device: 'headphones',
            }),
        );
        expect(vi.mocked(gainCommand).mock.calls.some(([r]) => r.action === 'apply')).toBe(false);
    });
    it('世代変更で復元を無効化し、元の値を送らない', async () => {
        current = { ...base, phase: 'invalid', proposal: null, error: '音声設定が変わりました' };
        render(<AutoGainDialog onClose={() => {}} />);
        await screen.findByText('音声設定が変わりました');
        expect(screen.queryByRole('button', { name: '元に戻す' })).not.toBeInTheDocument();
    });
    it('非表示とアンマウントで中止し、再表示だけでは開始しない', async () => {
        const view = render(<AutoGainDialog onClose={() => {}} />);
        await screen.findByRole('button', { name: 'この音量を使う' });
        act(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await waitFor(() => expect(gainCommand).toHaveBeenCalledWith({ action: 'cancel' }));
        view.unmount();
        await act(async () => {});
        expect(
            vi.mocked(gainCommand).mock.calls.filter(([r]) => r.action === 'cancel'),
        ).toHaveLength(2);
        expect(vi.mocked(gainCommand).mock.calls.some(([r]) => r.action === 'begin')).toBe(false);
    });
});

it('言語だけ切り替えても試聴先・安全確認・提案・dialogを保持し同じrequestを送る', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><AutoGainDialog onClose={vi.fn()} /></LocaleProvider>);
    await screen.findByRole('button', { name: '調整後を聴く' });
    fireEvent.click(screen.getByRole('button', { name: '試聴先を取得・更新' }));
    await screen.findByRole('option', { name: 'ヘッドホン' });
    const output = screen.getByLabelText('聞き比べの試聴先');
    fireEvent.change(output, { target: { value: 'headphones' } });
    const safety = screen.getByRole('checkbox');
    fireEvent.click(safety);
    const dialog = screen.getByRole('dialog');
    const calls = vi.mocked(gainCommand).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByLabelText('Gain comparison listening output')).toBe(output);
    expect(output).toHaveValue('headphones');
    expect(safety).toBeChecked();
    expect(screen.getByText('ヘッドホン')).toBeInTheDocument();
    expect(vi.mocked(gainCommand).mock.calls).toHaveLength(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Listen after adjustment' }));
    await waitFor(() => expect(gainCommand).toHaveBeenCalledWith({ action: 'preview', id: 42, after: true, device: 'headphones' }));
    expect(gainCommand).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'apply' }));
});
it('反映待ちも言語切替で再適用や取消へ進まず、元エラーは未翻訳詳細に表示する', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    current = { ...base, settled: false, error: 'Stream Error: original token' };
    render(<LocaleProvider store={store}><AutoGainDialog onClose={vi.fn()} /></LocaleProvider>);
    await screen.findByText('Stream Error: original token');
    const calls = vi.mocked(gainCommand).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('button', { name: 'Use this level' })).toBeDisabled();
    expect(screen.getByText('Original detail (untranslated)')).toBeInTheDocument();
    expect(screen.getByText('Stream Error: original token')).toBeInTheDocument();
    expect(vi.mocked(gainCommand).mock.calls).toHaveLength(calls);
});

it.each(['recording', 'applying'] as const)('locale変更で%sの状態や目標を再生成しない', async phase => {
    const store = createLocaleStore(() => 'ja', () => true);
    current = { ...base, phase, progress: .4 };
    render(<LocaleProvider store={store}><AutoGainDialog onClose={vi.fn()} /></LocaleProvider>);
    const target = await screen.findByLabelText('自動調整の目標');
    await waitFor(() => expect(target).toBeDisabled());
    const calls = vi.mocked(gainCommand).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByLabelText('Gain adjustment target')).toBe(target);
    expect(target).toHaveValue('-20');
    expect(target).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(phase === 'recording' ? 'Recording 4 / 10 s' : 'Checking output level application');
    expect(vi.mocked(gainCommand).mock.calls).toHaveLength(calls);
});


it('停止確認の固定失敗を翻訳してもdialog/目標値を保持しclose/cancelを繰り返さない', async()=>{
    const store=createLocaleStore(()=> 'ja',()=>true);const close=vi.fn();
    current={...base,settled:false};
    vi.mocked(confirmOutputGain).mockRejectedValue(new FixedClientError('gain.unconfirmed'));
    render(<LocaleProvider store={store}><AutoGainDialog onClose={close}/></LocaleProvider>);
    const dialog=screen.getByRole('dialog');const target=screen.getByRole('combobox',{name:'自動調整の目標'});
    fireEvent.click(screen.getByRole('button',{name:'閉じる'}));
    await screen.findByText('音量の反映を確認できません。状態を再取得してください。');
    const calls=vi.mocked(gainCommand).mock.calls.length;
    act(()=>{store.setLocale('en');});
    expect(screen.getByRole('dialog')).toBe(dialog);expect(target).toBeInTheDocument();expect(target).toHaveValue('-20');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not confirm the gain change. Refresh the status.');
    expect(close).not.toHaveBeenCalled();expect(gainCommand).toHaveBeenCalledTimes(calls);
});
