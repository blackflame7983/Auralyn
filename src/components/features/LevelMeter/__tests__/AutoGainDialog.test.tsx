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
