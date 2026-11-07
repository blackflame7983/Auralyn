import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { openStreamMixPanel, saveStreamMixPanel, takeStreamMixOpenRequest } from '@/lib/streamMixPanel';
import { StreamMixPanel } from '../StreamMixPanel';

vi.mock('../../AudioSettings/MixingPanel', () => ({ MixingPanel: () => <details id="mixing-settings"><summary tabIndex={0}>オケ</summary></details> }));
vi.mock('../../AudioSettings/PostMixPanel', () => ({ PostMixPanel: () => <details><summary>配信VST</summary></details> }));
const props = { running: true, primaryIsVoiceDevice: true, disabled: false, onOpenDevices: vi.fn() };

beforeEach(() => {
    saveStreamMixPanel(false);
    takeStreamMixOpenRequest();
    vi.spyOn(audioApi, 'getDevices').mockResolvedValue({ inputs: [], outputs: [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); saveStreamMixPanel(false); takeStreamMixOpenRequest(); });

it('既定では区画を増やさず、表示設定でホームの操作欄を出し入れする', async () => {
    render(<StreamMixPanel {...props} />);
    expect(screen.queryByRole('region', { name: '配信ミックス' })).not.toBeInTheDocument();
    act(() => saveStreamMixPanel(true));
    expect(screen.getByRole('region', { name: '配信ミックス' })).toContainElement(screen.getByText('オケ'));
    await waitFor(() => expect(audioApi.getDevices).toHaveBeenCalledWith(false));
    act(() => saveStreamMixPanel(false));
    expect(screen.queryByRole('region', { name: '配信ミックス' })).not.toBeInTheDocument();
});

it('設定から届いた開く要求はダイアログ終了まで待ち、オケを展開してフォーカスする', async () => {
    const view = render(<StreamMixPanel {...props} disabled />);
    act(() => openStreamMixPanel());
    expect(screen.getByText('オケ').closest('details')).not.toHaveAttribute('open');
    expect(audioApi.getDevices).not.toHaveBeenCalled();
    view.rerender(<StreamMixPanel {...props} />);
    await waitFor(() => expect(screen.getByText('オケ')).toHaveFocus());
    expect(screen.getByText('オケ').closest('details')).toHaveAttribute('open');
});

it('描画前の開く要求も失わず、再度の要求で閉じたオケを開き直す', async () => {
    act(() => openStreamMixPanel());
    render(<StreamMixPanel {...props} />);
    await waitFor(() => expect(screen.getByText('オケ')).toHaveFocus());
    screen.getByText('オケ').closest('details')!.open = false;
    screen.getByText('オケ').blur();
    act(() => openStreamMixPanel());
    await waitFor(() => expect(screen.getByText('オケ').closest('details')).toHaveAttribute('open'));
    expect(screen.getByText('オケ')).toHaveFocus();
});


it('描画済みでも期限切れの依頼はダイアログ終了後に展開・フォーカスしない', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
    saveStreamMixPanel(true);
    const view = render(<StreamMixPanel {...props} disabled />);
    act(() => openStreamMixPanel());
    now.mockReturnValue(14000);
    view.rerender(<StreamMixPanel {...props} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    expect(screen.getByText('オケ').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('オケ')).not.toHaveFocus();
});

it('描画待ちの間に過ぎた時間も期限へ含める', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10000);
    act(() => openStreamMixPanel());
    now.mockReturnValue(12500);
    const view = render(<StreamMixPanel {...props} disabled />);
    now.mockReturnValue(13500);
    view.rerender(<StreamMixPanel {...props} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    expect(screen.getByText('オケ').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('オケ')).not.toHaveFocus();
});
