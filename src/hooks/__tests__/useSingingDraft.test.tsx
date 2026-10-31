import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { builtinApi, defaultSinging, defaultReverb, type BuiltinSnapshot } from '@/api/builtinEffects';
import { audioApi } from '@/api/audio';
import { useSingingDraft } from '../useSingingDraft';
import { SingingControls } from '@/components/features/AudioSettings/SingingControls';

const initial = (): BuiltinSnapshot => ({ epoch: 'engine', revision: '1', appliedRevision: '0', pending: false,
    config: { active: false, preset: 'broadcast', amount: 0.7, singing: null }, undoToken: null, error: null });
let current: BuiltinSnapshot;
beforeEach(() => {
    current = initial();
    vi.mocked(listen).mockClear();
    vi.spyOn(audioApi, 'getAudioStreamState').mockResolvedValue({ running: false, streamFailed: false });
    vi.spyOn(builtinApi, 'request').mockImplementation(async request => {
        if (request.action !== 'snapshot') {
            if (request.epoch !== current.epoch || request.expectedRevision !== current.revision) throw new Error('conflict');
            current = { ...current, revision: String(Number(current.revision) + 1), config: request.action === 'apply' ? request.config : initial().config,
                undoToken: request.action === 'apply' ? 'one-undo' : null };
        }
        return structuredClone(current);
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Controls() { return <SingingControls model={useSingingDraft()} />; }
it.each([undefined, null])('旧設定の残響%sはOFFで表示し、操作しても声の設定を変更しない', async reverb => {
    current.config.reverb = reverb;
    render(<Controls />);
    const toggle = await screen.findByRole('checkbox', { name: '残響を有効にする' });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: '響きの量（%）' })).not.toBeVisible();
    fireEvent.click(screen.getByText('数値を細かく調整'));
    expect(screen.getByRole('spinbutton', { name: '響きの量（%）' })).toHaveValue(8);
    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole('spinbutton', { name: '残響の長さ（秒）' }), { target: { value: '1.8' } });
    expect(current.config.active).toBe(false);
    expect(current.config.preset).toBe('broadcast');
    expect(vi.mocked(builtinApi.request).mock.calls.every(([request]) => request.action === 'snapshot')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'この音をマイクへ適用' }));
    await waitFor(() => expect(current.config.reverb).toEqual({ ...defaultReverb, enabled: true, decaySeconds: 1.8 }));
    expect(current.config.active).toBe(false);
    expect(current.config.singing).toBeNull();
});
it('残響変更は候補世代とundoを失効させ、声のON/OFFは適用済み残響と未適用下書きを保つ', async () => {
    current.config.reverb = { ...defaultReverb, enabled: true };
    current.undoToken = 'old-undo';
    const { result } = renderHook(() => useSingingDraft());
    await act(async () => { await result.current.refresh(); });
    const revision = result.current.draftRevision;
    act(() => result.current.editReverb({ damping: 0.8, enabled: false }));
    expect(result.current.draftRevision).toBeGreaterThan(revision);
    expect(result.current.snapshot?.undoToken).toBeNull();
    await act(async () => { await result.current.setAppliedActive(true); });
    expect(current.config.reverb).toEqual({ ...defaultReverb, enabled: true });
    expect(result.current.draft?.reverb).toEqual({ ...defaultReverb, enabled: false, damping: 0.8 });
    act(() => result.current.resetDraft());
    act(() => result.current.editReverb({ mix: 0.12 }));
    await act(async () => { await result.current.apply(); });
    expect(current.config.reverb?.mix).toBe(0.12);
    await act(async () => { await result.current.undo(); });
    expect(current.config).toEqual(initial().config);
});
it('残響だけの下書きから候補入口を使え、保存操作は下書きを適用しない', async () => {
    const preview = vi.fn(); const save = vi.fn();
    function Entry() { return <SingingControls model={useSingingDraft()} onPreview={preview} onSaveProfile={save} />; }
    render(<Entry />);
    const toggle = await screen.findByRole('checkbox', { name: '残響を有効にする' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: '試しに聴く' }));
    expect(preview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('再取得・下書きのリセット・保存'));
    fireEvent.click(screen.getByRole('button', { name: '適用済み設定をプロファイルへ保存' }));
    expect(save).toHaveBeenCalledOnce();
    expect(current.config.reverb).toBeUndefined();
    expect(current.config.active).toBe(false);
});
it('親hookを持つだけではsnapshotもイベント監視も始めず、編集はIPCを呼ばない', async () => {
    const { result } = renderHook(() => useSingingDraft());
    expect(builtinApi.request).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    await act(async () => { await result.current.refresh(); });
    act(() => result.current.selectSinging());
    act(() => result.current.edit({ lowCutHz: 120, dynamics: 0.5, brightnessDb: 1 }));
    expect(builtinApi.request).toHaveBeenCalledTimes(1);
    expect(result.current.draft?.singing).toEqual({ lowCutHz: 120, dynamics: 0.5, brightnessDb: 1 });
    expect(result.current.snapshot?.config.preset).toBe('broadcast');
});
it('適用と一回undoはepoch/revision/tokenを送り、停止中prepared待ちを失敗扱いしない', async () => {
    const { result } = renderHook(() => useSingingDraft());
    await act(async () => { await result.current.refresh(); });
    act(() => result.current.selectSinging());
    await act(async () => { expect(await result.current.apply()).toBe(true); });
    expect(builtinApi.request).toHaveBeenLastCalledWith({ action: 'apply', epoch: 'engine', expectedRevision: '1', config: {
        active: true, preset: 'singing', amount: 0.7, singing: defaultSinging,
    } });
    expect(result.current.snapshot?.pending).toBe(false);
    expect(result.current.error).toBe('');
    await act(async () => { expect(await result.current.undo()).toBe(true); });
    expect(builtinApi.request).toHaveBeenLastCalledWith({ action: 'undo', epoch: 'engine', expectedRevision: '2', undoToken: 'one-undo' });
    expect(result.current.snapshot?.undoToken).toBeNull();
});
it('競合は下書きを維持し、再取得した現在値との差分を確認してから再適用できる', async () => {
    const { result } = renderHook(() => useSingingDraft());
    await act(async () => { await result.current.refresh(); });
    act(() => result.current.selectSinging());
    current = { ...current, revision: '2', config: { ...current.config, preset: 'warm' } };
    await act(async () => { expect(await result.current.apply()).toBe(false); });
    expect(result.current.conflict).toBe(true);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.draft?.preset).toBe('singing');
    expect(result.current.snapshot?.config.preset).toBe('warm');
    await act(async () => { await result.current.refresh(); });
    expect(result.current.conflict).toBe(false);
});
it('表示中だけ変更通知を購読し、閉じた後の音声イベントでは取得しない', async () => {
    const hook = renderHook(() => useSingingDraft());
    const controls = render(<SingingControls model={hook.result.current} />);
    await waitFor(() => expect(builtinApi.request).toHaveBeenCalled());
    // 実際の親再描画と同じmodel更新を渡す。
    controls.rerender(<SingingControls model={hook.result.current} />);
    await waitFor(() => expect(vi.mocked(listen).mock.calls.some(([event]) => event === 'audio-conditions-changed')).toBe(true));
    controls.unmount();
    await act(async () => {});
    const before = vi.mocked(builtinApi.request).mock.calls.length;
    window.dispatchEvent(new Event('profile-fx-applied'));
    await act(async () => {});
    expect(builtinApi.request).toHaveBeenCalledTimes(before);
});
it('歌設定ON/OFFは全値を保ち、編集後の再取得でも古いundoを復活させない', async () => {
    current.config = { active: true, preset: 'singing', amount: 0.2, singing: { lowCutHz: 110, dynamics: 0.65, brightnessDb: -1 } };
    const { result } = renderHook(() => useSingingDraft());
    await act(async () => { await result.current.refresh(); await result.current.setAppliedActive(false); });
    expect(current.config).toEqual({ active: false, preset: 'singing', amount: 0.2, singing: { lowCutHz: 110, dynamics: 0.65, brightnessDb: -1 } });
    act(() => result.current.edit({ brightnessDb: 2 }));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.snapshot?.undoToken).toBeNull();
});
it('停止中は保持設定を表示し、数値入力が下書きだけ変え品質合格を表示しない', async () => {
    render(<Controls />);
    const defaults = await screen.findByRole('button', { name: '歌向けの音から始める' });
    await waitFor(() => expect(defaults).toBeEnabled());
    fireEvent.click(defaults);
    fireEvent.click(screen.getByText('数値を細かく調整'));
    fireEvent.change(screen.getByRole('spinbutton', { name: '低音の整理（Hz）' }), { target: { value: '130' } });
    expect(screen.getByRole('spinbutton', { name: '低音の整理（Hz）' })).toHaveValue(130);
    expect(screen.getByRole('status')).toHaveTextContent('次回の音声開始時');
    expect(vi.mocked(builtinApi.request).mock.calls.every(([request]) => request.action === 'snapshot')).toBe(true);
});


it('適用済みのON/OFFを切り替えても編集中の歌向け下書きは失わない', async () => {
    current.config = { active: true, preset: 'singing', amount: 0.7, singing: defaultSinging };
    const { result } = renderHook(() => useSingingDraft());
    await act(async () => { await result.current.refresh(); });
    act(() => result.current.edit({ lowCutHz: 140 }));
    await act(async () => { await result.current.setAppliedActive(false); });
    expect(current.config.active).toBe(false);
    expect(current.config.singing?.lowCutHz).toBe(80);
    expect(result.current.draft?.singing?.lowCutHz).toBe(140);
});


const emitStream = (event: string) => {
    for (const [name, callback] of vi.mocked(listen).mock.calls) if (name === event) callback({ event, id: 1, payload: null });
};
it.each(['audio-stopped', 'audio-stream-error', 'audio-error'])('内蔵revision固定でも%sで停止表示へ変わり、開始通知で再確認する', async event => {
    current.appliedRevision = current.revision;
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({ running: true, streamFailed: false });
    render(<Controls />);
    await screen.findByText('稼働中の処理への反映を確認しました。');
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({ running: false, streamFailed: false });
    await act(async () => emitStream(event));
    expect(screen.getByRole('status')).toHaveTextContent('次回の音声開始時');
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({ running: true, streamFailed: false });
    await act(async () => emitStream('audio-started'));
    expect(screen.getByRole('status')).toHaveTextContent('稼働中の処理への反映を確認しました');
    expect(current.revision).toBe('1');
    expect(current.appliedRevision).toBe('1');
});
it('running=trueでもstreamFailed=trueなら稼働中と表示せず、手動再取得は内蔵値が同じでも音声状態を更新する', async () => {
    current.appliedRevision = current.revision;
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({ running: true, streamFailed: true });
    render(<Controls />);
    await screen.findByText('設定を保持しています。次回の音声開始時に処理を準備します。');
    vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({ running: true, streamFailed: false });
    fireEvent.click(screen.getByRole('button', { name: '内蔵ボイスチェーンの現在値を再取得' }));
    await screen.findByText('稼働中の処理への反映を確認しました。');
});
it('停止前の遅い状態応答を無効化し、閉じた後の応答・通知・pollでIPCを続けない', async () => {
    vi.useFakeTimers();
    try {
        current.appliedRevision = current.revision;
        let finish!: (value: { running: boolean; streamFailed: boolean }) => void;
        vi.mocked(audioApi.getAudioStreamState).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        const view = render(<Controls />);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        await act(async () => emitStream('audio-stopped'));
        await act(async () => finish({ running: true, streamFailed: false }));
        expect(screen.getByRole('status')).toHaveTextContent('次回の音声開始時');
        const calls = vi.mocked(audioApi.getAudioStreamState).mock.calls.length;
        view.unmount();
        await act(async () => { emitStream('audio-started'); await vi.advanceTimersByTimeAsync(4000); });
        expect(audioApi.getAudioStreamState).toHaveBeenCalledTimes(calls);
    } finally { vi.useRealTimers(); }
});
it('通知を逃した場合も表示中のbounded pollで状態を確認し、閉じると停止する', async () => {
    vi.useFakeTimers();
    try {
        current.appliedRevision = current.revision;
        vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({ running: true, streamFailed: false });
        const view = render(<Controls />);
        await act(async () => { await vi.advanceTimersByTimeAsync(1); });
        expect(screen.getByRole('status')).toHaveTextContent('稼働中の処理への反映を確認しました');
        vi.mocked(audioApi.getAudioStreamState).mockResolvedValue({ running: false, streamFailed: false });
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
        expect(screen.getByRole('status')).toHaveTextContent('次回の音声開始時');
        view.unmount();
        const count = vi.mocked(audioApi.getAudioStreamState).mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(audioApi.getAudioStreamState).toHaveBeenCalledTimes(count);
    } finally { vi.useRealTimers(); }
});
