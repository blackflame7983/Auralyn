import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { broadcastTruePeakApi, type BroadcastTruePeakStatus } from '@/api/broadcastTruePeak';
import { BroadcastTruePeakPanel } from '../BroadcastTruePeakPanel';
import { message } from '@/i18n/messages';
const fixture = (enabled = false, addedLatencySamples = enabled ? 48 : 0, applied = enabled): BroadcastTruePeakStatus => ({
    config: { enabled, ceilingDb: -3, releaseMs: 150 }, running: true, pending: false, applied, revision: '2', reductionDb: 0, addedLatencySamples,
});
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); vi.mocked(listen).mockClear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('読取りでは有効化せず、自分用の遅延が0である説明と保証範囲を出す', async () => {
    const request = vi.spyOn(broadcastTruePeakApi, 'request').mockImplementation(async config => ({ ...fixture(), config: config ?? fixture().config, applied: config?.enabled ?? false, addedLatencySamples: config?.enabled ? 48 : 0 }));
    render(<BroadcastTruePeakPanel />); await act(async () => {});
    expect(request).toHaveBeenCalledWith();
    expect(request.mock.calls.every(args => args.length === 0)).toBe(true);
    expect(screen.getByRole('spinbutton', { name: message('ja', 'truePeak.ceiling') })).toHaveValue(-3);
    expect(screen.getByText(/自分用は 0 sample/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(message('ja', 'truePeak.limitsTitle')));
    expect(screen.getByText(/OBS 内部の処理/)).toBeInTheDocument();
    expect(screen.getByText(/デバイス側のサンプルレート変換は範囲外/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'truePeak.enable') })); await act(async () => {});
    expect(request).toHaveBeenCalledWith({ enabled: true, ceilingDb: -3, releaseMs: 150 });
    expect(screen.getByText(/48 sample/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'truePeak.disable') })); await act(async () => {});
    expect(request).toHaveBeenLastCalledWith({ enabled: false, ceilingDb: -3, releaseMs: 150 });
    expect(screen.queryByText(message('ja', 'truePeak.notApplied'))).not.toBeInTheDocument();
});
it('有効でも分離出力でないときは未適用と遅延 0 を出す', async () => {
    vi.spyOn(broadcastTruePeakApi, 'request').mockResolvedValue(fixture(true, 0, false));
    render(<BroadcastTruePeakPanel />); await act(async () => {});
    expect(screen.getByText(message('ja', 'truePeak.notApplied'))).toBeInTheDocument();
    expect(screen.getByText(/先読み：0 sample/)).toBeInTheDocument();
});
