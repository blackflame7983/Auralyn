import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mixingApi, type MixSnapshot } from '@/api/mixing';
import { postMixApi } from '@/api/postMix';
import { MixingLiveControl } from '../MixingLiveControl';
import { LiveControlsHiddenContext } from '../LiveControlsContext';
const config = { version: 1 as const, source: { kind: 'device' as const, config: { host: 'WASAPI' as const, inputId: 'music', inputChannels: [0, 1] as [number, number] } }, levels: { voice: { gain: 1, muted: false }, accompaniment: { gain: 1, muted: false }, monitorAccompaniment: true, offsetMs: 0 } };
const snapshot = (revision = '1', gain = 1, muted = false) => ({ epoch: 'e', revision, config: { ...config, levels: { ...config.levels, accompaniment: { gain, muted } } }, savedConfig: null, error: null } as unknown as MixSnapshot);
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.spyOn(postMixApi, 'request').mockResolvedValue({ enabled: false, savedPlugins: [], plugins: [] } as any); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('書込み中の音声停止では未確定の音量を解除し、遅い応答も反映しない', async () => {
    let finish!: (value: MixSnapshot) => void;
    const request = vi.spyOn(mixingApi, 'request').mockImplementation(r => r.action === 'snapshot' ? Promise.resolve(snapshot()) : new Promise(resolve => { finish = resolve; }));
    const view = render(<MixingLiveControl running blocked={false} onSettings={vi.fn()} />); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'オケ音量とミュート' })); fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' });
    await act(async () => { await vi.advanceTimersByTimeAsync(125); }); expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'levels' }));
    view.rerender(<MixingLiveControl running={false} blocked={false} onSettings={vi.fn()} />); expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '100%');
    await act(async () => finish(snapshot('2', 0.99))); expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '100%');
});
it('編集開始前のpoll応答が遅れても確認済みrevisionを差し替えて外部muteを上書きしない', async () => {
    let finish!: (value: MixSnapshot) => void; let snapshots = 0;
    const request = vi.spyOn(mixingApi, 'request').mockImplementation(r => {
        if (r.action === 'snapshot') return ++snapshots === 1 ? Promise.resolve(snapshot()) : new Promise(resolve => { finish = resolve; });
        return Promise.reject(new Error('stale revision'));
    });
    render(<MixingLiveControl running blocked={false} onSettings={vi.fn()} />); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'オケ音量とミュート' })); await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft' }); await act(async () => finish(snapshot('2', 1, true)));
    await act(async () => { await vi.advanceTimersByTimeAsync(125); });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'levels', expectedRevision: '1', levels: expect.objectContaining({ accompaniment: { gain: 0.99, muted: false } }) }));
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '100%');
});

it('未設定のホームで欄が隠れたら、開いていた音量の小窓も閉じる（#297）', async () => {
    vi.spyOn(mixingApi, 'request').mockResolvedValue(snapshot());
    const view = render(<LiveControlsHiddenContext.Provider value={false}><MixingLiveControl running={false} blocked={false} onSettings={vi.fn()} /></LiveControlsHiddenContext.Provider>); await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'オケ音量とミュート' }));
    expect(screen.getByRole('slider')).toBeInTheDocument();
    view.rerender(<LiveControlsHiddenContext.Provider value><MixingLiveControl running={false} blocked={false} onSettings={vi.fn()} /></LiveControlsHiddenContext.Provider>);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
});
