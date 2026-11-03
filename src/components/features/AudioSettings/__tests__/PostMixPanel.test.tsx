import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { postMixApi, type PostMixSnapshot } from '@/api/postMix';
import { mixingApi } from '@/api/mixing';
import { audioApi } from '@/api/audio';
import { PostMixPanel } from '../PostMixPanel';
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }));
const plugin = { id: 'p1', path: 'eq.vst3', name: 'EQ', enabled: true, muted: false, gain: 0 };
const snapshot = (values: Partial<PostMixSnapshot> = {}): PostMixSnapshot => ({ epoch: 'epoch', revision: '1', enabled: false, running: false, savedPlugins: [], plugins: [], restored: false, error: null, transportLatencyFrames: 2048, declaredPluginLatencyFrames: null, ...values });
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup(value = snapshot(), mainRunning = false) {
    const request = vi.spyOn(postMixApi, 'request').mockResolvedValue(value);
    vi.spyOn(mixingApi, 'request').mockResolvedValue({ config: null } as any);
    render(<PostMixPanel mainRunning={mainRunning} />);
    expect(request).not.toHaveBeenCalled(); fireEvent.click(screen.getByText('ミックス後の配信 VST'));
    await screen.findByText(/転送の待ち時間/); return request;
}
it('読込だけでは復元せず、一覧の明示取得と選択で追加する', async () => {
    const request = await setup();
    vi.spyOn(audioApi, 'scanPlugins').mockResolvedValue([{ id: 'vst', name: 'EQ', path: 'eq.vst3', vendor: '', category: 'Fx', version: '' }]);
    expect(screen.getByText(/VST の処理待ち: 不明/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'VSTを追加' }));
    const browser = await screen.findByRole('dialog');
    await waitFor(() => expect(within(browser).getAllByText('EQ').length).toBeGreaterThan(0));
    fireEvent.click(within(browser).getAllByText('EQ')[0]);
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'add', path: 'eq.vst3', expectedEpoch: 'epoch', expectedRevision: '1' }));
});
it('稼働中はラック構成を変更できず、明示音量調整は可能', async () => {
    const request = await setup(snapshot({ restored: true, plugins: [plugin] }), true);
    expect(screen.getByRole('button', { name: 'VSTを追加' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'EQを削除' })).toBeDisabled();
    const slider = screen.getByRole('slider', { name: 'EQのゲイン' });
    expect(slider).toHaveAttribute('aria-valuenow', '0'); fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: 'gain', id: 'p1', value: 0.01, expectedEpoch: 'epoch', expectedRevision: '1' }));
});
it('異なる世代のポーリングは入力を保持し、書込みを拒否する', async () => {
    const request = await setup(snapshot({ restored: true, plugins: [plugin] }));
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList);

    request.mockResolvedValue(snapshot({ revision: '2', restored: true, plugins: [plugin] }));
    await screen.findByText(/設定が変わりました/, {}, { timeout: 2500 });
    expect(screen.getByRole('slider', { name: 'EQのゲイン' })).toHaveAttribute('data-disabled');
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

it('音量の送信前は保存を禁止し、失敗後と再読込後も未反映の編集だと伝える', async () => {
    const request = await setup(snapshot({ restored: true, plugins: [plugin] }));
    request.mockRejectedValueOnce(new Error('missing VST'));
    fireEvent.keyDown(screen.getByRole('slider', { name: 'EQのゲイン' }), { key: 'ArrowRight' });
    const save = screen.getByRole('button', { name: '配信 VST を保存' });
    expect(save).toBeDisabled(); expect(save).toHaveAccessibleDescription(/まだ反映されていない/);
    await screen.findAllByRole('alert'); expect(screen.getByRole('slider', { name: 'EQのゲイン' })).toHaveAttribute('aria-valuetext', '1%');
    fireEvent.click(screen.getByRole('button', { name: '最新の状態を読み直す' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '配信 VST を保存' })).toBeDisabled(); expect(screen.getByText(/まだ反映されていない変更/)).toBeInTheDocument();
    request.mockResolvedValue(snapshot({ revision: '2', restored: true, plugins: [{ ...plugin, gain: 0.01 }] }));
    fireEvent.click(screen.getByRole('button', { name: '音量の変更を再試行' })); await waitFor(() => expect(save).toBeEnabled());
});
