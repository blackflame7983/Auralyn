import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { postMixApi, type PostMixSnapshot } from '@/api/postMix';
import { audioApi } from '@/api/audio';
import { PostMixPanel } from '../PostMixPanel';
const plugin = { id: 'p1', path: 'eq.vst3', name: 'EQ', enabled: true, muted: false, gain: 0 };
const snapshot = (values: Partial<PostMixSnapshot> = {}): PostMixSnapshot => ({ epoch: 'epoch', revision: '1', enabled: false, running: false, savedPlugins: [], plugins: [], restored: false, error: null, transportLatencyFrames: 2048, declaredPluginLatencyFrames: null, ...values });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup(value = snapshot(), mainRunning = false) {
    const request = vi.spyOn(postMixApi, 'request').mockResolvedValue(value);
    render(<PostMixPanel mainRunning={mainRunning} />);
    fireEvent.click(screen.getByText('ミックス後の配信 VST')); expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '状態を読み込む' }));
    await screen.findByText(/追加の転送待ち/); return request;
}
it('読込だけでは復元せず、一覧の明示取得と選択で追加する', async () => {
    const request = await setup();
    vi.spyOn(audioApi, 'scanPlugins').mockResolvedValue([{ id: 'vst', name: 'EQ', path: 'eq.vst3', vendor: '', category: 'Fx', version: '' }]);
    expect(screen.getByText(/VST 申告の処理待ち: 不明/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'VST 一覧を取得' }));
    await screen.findByRole('option', { name: 'EQ' });
    fireEvent.change(screen.getByRole('combobox', { name: '追加する VST' }), { target: { value: 'eq.vst3' } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'add', path: 'eq.vst3', expectedEpoch: 'epoch', expectedRevision: '1' }));
});
it('稼働中はラック構成を変更できず、明示音量調整は可能', async () => {
    const request = await setup(snapshot({ restored: true, plugins: [plugin] }), true);
    expect(screen.getByRole('button', { name: '追加' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '削除' })).toBeDisabled();
    const group = screen.getByRole('group', { name: 'EQ' });
    expect(within(group).getByRole('spinbutton')).toHaveValue(0);
    fireEvent.click(within(group).getByRole('button', { name: '音量を適用' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'gain', id: 'p1', value: 0, expectedEpoch: 'epoch', expectedRevision: '1' }));
});
it('異なる世代のポーリングは入力を保持し、書込みを拒否する', async () => {
    const request = await setup(snapshot({ restored: true, plugins: [plugin] }));
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0.5' } });
    request.mockResolvedValue(snapshot({ revision: '2', restored: true, plugins: [plugin] }));
    await screen.findByText(/設定が変わりました/, {}, { timeout: 2500 });
    expect(screen.getByRole('spinbutton')).toHaveValue(0.5);
    expect(screen.getByRole('button', { name: '音量を適用' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '配信 VST を保存' })).toBeDisabled();
});
it('破損保存の復旧は確認後だけ実行し、失敗時に再試行しない', async () => {
    const request = await setup(snapshot({ error: 'corrupt' }));
    fireEvent.click(screen.getByText('保存設定を復旧する'));
    const button = screen.getByRole('button', { name: '保存状態を保管して無効にする' }); expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /保存状態を保管して配信 VST/ }));
    request.mockRejectedValueOnce(new Error('failed')); fireEvent.click(button);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/記録を残し、配信 VST を無効/)).not.toBeInTheDocument();
});
