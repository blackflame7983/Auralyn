import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveModesApi } from '@/api/liveModes';
import { builtinApi, defaultReverb } from '@/api/builtinEffects';
import { useLiveModes } from '../useLiveModes';
import { LiveModeControls } from '@/components/features/AudioSettings/LiveModeControls';
import { beginRackRestore } from '@/lib/liveRouting';
import { liveSnapshot } from './liveModesFixture';
beforeEach(() => { vi.spyOn(liveModesApi, 'request').mockResolvedValue(liveSnapshot()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('親hookだけではIPCせず、使用期間だけ取得しhiddenと閉じた後のpollを止める', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLiveModes());
    expect(liveModesApi.request).not.toHaveBeenCalled();
    let release!: () => void;
    await act(async () => { release = result.current.activate(); });
    expect(liveModesApi.request).toHaveBeenCalledOnce();
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(liveModesApi.request).toHaveBeenCalledOnce();
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(liveModesApi.request).toHaveBeenCalledTimes(2);
    act(() => release());
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(liveModesApi.request).toHaveBeenCalledTimes(2);
});
it('同じモード指定も明示intentで送り、応答前に適用済みや切替完了へ進めない', async () => {
    let resolve!: (value: ReturnType<typeof liveSnapshot>) => void;
    const { result } = renderHook(() => useLiveModes());
    await act(async () => { await result.current.refresh(); });
    const select = vi.spyOn(liveModesApi, 'select').mockReturnValue(new Promise(done => { resolve = done; }));
    act(() => { void result.current.select('singing'); });
    expect(result.current.snapshot?.target).toBeNull();
    expect(select).toHaveBeenCalledWith('singing', 'host1');
    await act(async () => resolve(liveSnapshot({ target: 'singing', phase: 'stopped', revision: '1' })));
    expect(result.current.snapshot?.phase).toBe('stopped');
    expect(result.current.snapshot?.applied).toBeNull();
});
it('雑談の残響ONは確認を求め、明示選択後に登録用コピーだけをOFFにする', async () => {
    const config = { active: false, preset: 'broadcast' as const, amount: 0.7, singing: null, reverb: { ...defaultReverb, enabled: true } };
    vi.spyOn(builtinApi, 'request').mockResolvedValue({ epoch: 'engine', revision: '5', appliedRevision: '4', pending: false, config, undoToken: null, error: null });
    const { result } = renderHook(() => useLiveModes());
    let outcome: unknown;
    await act(async () => { await result.current.refresh(); outcome = await result.current.saveApplied('talk'); });
    expect(outcome).toBe('reverb');
    expect(vi.mocked(liveModesApi.request).mock.calls.some(([request]) => request.action === 'save')).toBe(false);
    expect(config.reverb.enabled).toBe(true);
    await act(async () => { outcome = await result.current.saveApplied('talk', true); });
    expect(outcome).toBe(true);
    expect(liveModesApi.request).toHaveBeenLastCalledWith({ action: 'save', expectedVersion: '0', singing: null, talk: { ...config, reverb: { ...config.reverb, enabled: false } } });
    expect(config.reverb.enabled).toBe(true);
    expect(builtinApi.request).toHaveBeenCalledTimes(2);
    await act(async () => { await result.current.saveApplied('singing'); });
    expect(liveModesApi.request).toHaveBeenLastCalledWith({ action: 'save', expectedVersion: '0', singing: config, talk: null });
});
it('残響OFFを選んでも未適用の設定を登録しない', async () => {
    const config = { active: true, preset: 'broadcast' as const, amount: 0.7, singing: null, reverb: { ...defaultReverb, enabled: true } };
    vi.spyOn(builtinApi, 'request').mockResolvedValue({ epoch: 'engine', revision: '5', appliedRevision: '4', pending: true, config, undoToken: null, error: null });
    const { result } = renderHook(() => useLiveModes());
    let outcome: unknown;
    await act(async () => { await result.current.refresh(); outcome = await result.current.saveApplied('talk', true); });
    expect(outcome).toBe(false);
    expect(result.current.error).toContain('適用');
    expect(vi.mocked(liveModesApi.request).mock.calls.some(([request]) => request.action === 'save')).toBe(false);
});
it('保存が失敗した場合は次の調整導線を表示せず、保存済み要約を維持する', async () => {
    const config = { active: true, preset: 'broadcast' as const, amount: 0.7, singing: null, reverb: { ...defaultReverb, enabled: true } };
    vi.mocked(liveModesApi.request).mockImplementation(async request => {
        if (request.action === 'save') throw new Error('save failed');
        return liveSnapshot({ definitions: { schemaVersion: 1, version: '0', singing: config, talk: null } });
    });
    vi.spyOn(builtinApi, 'request').mockResolvedValue({ epoch: 'engine', revision: '5', appliedRevision: '5', pending: false, config, undoToken: null, error: null });
    function Panel() { return <LiveModeControls model={useLiveModes()} initiallyOpen onAdjust={vi.fn()} />; }
    render(<Panel />);
    await screen.findByText(/声 ON.*残響 ON/);
    fireEvent.click(screen.getByRole('button', { name: /歌.*登録/ }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/次に.*音を調整/)).not.toBeInTheDocument();
    expect(screen.getByText(/声 ON.*残響 ON/)).toBeInTheDocument();
});
it('雑談の残響確認から登録した後に歌の調整へ進める', async () => {
    const config = { active: true, preset: 'broadcast' as const, amount: 0.7, singing: null, reverb: { ...defaultReverb, enabled: true } };
    vi.spyOn(builtinApi, 'request').mockResolvedValue({ epoch: 'engine', revision: '5', appliedRevision: '5', pending: false, config, undoToken: null, error: null });
    const adjust = vi.fn();
    function Panel() { return <LiveModeControls model={useLiveModes()} initiallyOpen onAdjust={adjust} />; }
    render(<Panel />);
    const register = await screen.findByRole('button', { name: /雑談モードへ登録/ });
    fireEvent.click(register);
    const confirm = await screen.findByRole('button', { name: '残響をOFFにして登録' });
    expect(vi.mocked(liveModesApi.request).mock.calls.some(([request]) => request.action === 'save')).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(await screen.findByRole('button', { name: /次に歌.*音を調整/ }));
    expect(adjust).toHaveBeenCalledWith('singing');
});
it('復元中はmode/arm要求を拒否し、完了後に保護解除を送れる', async () => {
    const { result } = renderHook(() => useLiveModes());
    await act(async () => { await result.current.refresh(); });
    let release!: () => void; act(() => { release = beginRackRestore(); });
    await act(async () => { await result.current.protect(true); await result.current.select('talk'); });
    expect(result.current.busy).toBe(true);
    expect(liveModesApi.request).toHaveBeenCalledOnce();
    act(() => release());
    await act(async () => { await result.current.protect(false); });
    expect(liveModesApi.request).toHaveBeenLastCalledWith({ action: 'disarm', intent: expect.objectContaining({ expectedEpoch: 'host1', sequence: expect.any(Number), clientId: expect.any(String) }) });
});
it('操作開始前の遅いsnapshotは新しいepochとモード応答を巻き戻さない', async () => {
    const { result } = renderHook(() => useLiveModes());
    await act(async () => { await result.current.refresh(); });
    let resolve!: (value: ReturnType<typeof liveSnapshot>) => void;
    vi.mocked(liveModesApi.request).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    act(() => { void result.current.refresh(); });
    vi.spyOn(liveModesApi, 'select').mockResolvedValue(liveSnapshot({ epoch: 'host2', running: true, target: 'talk', applied: 'talk', phase: 'settled' }));
    await act(async () => { await result.current.select('talk'); });
    await act(async () => resolve(liveSnapshot()));
    expect(result.current.snapshot?.epoch).toBe('host2');
    expect(result.current.snapshot?.phase).toBe('settled');
});
it('画面はCustom・停止保持・RT受付・切替完了・自然tailを区別する', async () => {
    function Panel() { return <LiveModeControls model={useLiveModes()} />; }
    render(<Panel />);
    fireEvent.click(screen.getByText('モード登録'));
    await screen.findByText(/現在は個別の設定/);
    vi.mocked(liveModesApi.request).mockResolvedValue(liveSnapshot({ target: 'singing', phase: 'stopped' }));
    fireEvent.click(screen.getByText('モードの状態を再取得'));
    await screen.findByText(/停止中の設定として保持/);
    vi.mocked(liveModesApi.request).mockResolvedValue(liveSnapshot({ running: true, target: 'singing', phase: 'queued', revision: '2', acceptedRevision: '1' }));
    fireEvent.click(screen.getByText('モードの状態を再取得'));
    await screen.findByText(/音声処理の受理を待って/);
    vi.mocked(liveModesApi.request).mockResolvedValue(liveSnapshot({ running: true, target: 'talk', applied: 'talk', phase: 'settled', naturalTail: true }));
    fireEvent.click(screen.getByText('モードの状態を再取得'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('切替完了：雑談'));
    expect(screen.getByText(/声の切替完了は、余韻が消えたことの確認ではありません/)).toBeInTheDocument();
});
