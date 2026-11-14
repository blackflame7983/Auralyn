import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { peakProtectionApi, type PeakStatus } from '@/api/peakProtection';
import { PeakProtectionPanel } from '../PeakProtectionPanel';
import { message } from '@/i18n/messages';
const fixture = (enabled = false): PeakStatus => ({ config: { enabled, ceilingDb: -3, releaseMs: 150 }, running: true, pending: false, revision: '2', reductionDb: 0, addedLatencySamples: 0 });
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('読取りでは有効化せず、保持値を編集へ読み込み、明示操作だけで適用する', async () => {
    const request = vi.spyOn(peakProtectionApi, 'request').mockImplementation(async config => ({ ...fixture(), config: config ?? fixture().config }));
    render(<PeakProtectionPanel />); await act(async () => {});
    expect(request).toHaveBeenCalledWith();
    expect(request.mock.calls.every(args => args.length === 0)).toBe(true);
    // 天井は詳しい設定へ移した。閉じた初期状態でも、読み込んだ値は残る。
    expect(screen.getByText(message('ja', 'peak.details')).closest('details')).not.toHaveAttribute('open');
    expect(screen.getByRole('spinbutton', { name: message('ja', 'peak.ceiling') })).toHaveValue(-3);
    // ON と OFF は見出し横のスイッチ1つ。ON はいまの値で適用する。
    fireEvent.click(screen.getByRole('switch', { name: message('ja', 'peak.title') })); await act(async () => {});
    expect(request).toHaveBeenCalledWith({ enabled: true, ceilingDb: -3, releaseMs: 150 });
    fireEvent.change(screen.getByRole('spinbutton', { name: message('ja', 'peak.ceiling') }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('switch', { name: message('ja', 'peak.title') })); await act(async () => {});
    expect(request).toHaveBeenLastCalledWith({ enabled: false, ceilingDb: -3, releaseMs: 150 });
});
it('守る対象は開かずに読め、数値の詳細では詳しい設定が開き、適用はONにしない', async () => {
    const request = vi.spyOn(peakProtectionApi, 'request').mockImplementation(async config => ({ ...fixture(), config: config ?? fixture().config }));
    const view = render(<PeakProtectionPanel />); await act(async () => {});
    expect(screen.getByText(message('ja', 'peak.lead'))).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'peak.apply') })); await act(async () => {});
    expect(request).toHaveBeenLastCalledWith({ enabled: false, ceilingDb: -3, releaseMs: 150 });
    await act(async () => { view.rerender(<PeakProtectionPanel numericDetails />); });
    expect(screen.getByText(message('ja', 'peak.details')).closest('details')).toHaveAttribute('open');
});
it('失敗や停止通知より古い適用応答で確認済みに戻さない', async () => {
    let resolve!: (value: PeakStatus) => void;
    vi.spyOn(peakProtectionApi, 'request').mockImplementation(config => config ? new Promise(done => { resolve = done; }) : Promise.resolve(fixture()));
    render(<PeakProtectionPanel />); await act(async () => {});
    fireEvent.click(screen.getByRole('switch', { name: message('ja', 'peak.title') }));
    act(() => { for (const [event, callback] of vi.mocked(listen).mock.calls) if (event === 'audio-error') callback({ event, id: 1, payload: 'failure' }); });
    await act(async () => resolve(fixture(true)));
    expect(screen.getByText(message('ja', 'peak.unknown'))).toBeInTheDocument();
    // 状態を確認できないときは、スイッチで ON にできない。
    expect(screen.getByRole('switch', { name: message('ja', 'peak.title') })).toBeDisabled();
});
