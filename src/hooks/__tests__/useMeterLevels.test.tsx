import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { LevelMeter } from '@/components/features/LevelMeter/LevelMeter';
import { StrictMode } from 'react';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { METER_TIMEOUT_MS, useMeterLevels } from '../useMeterLevels';

const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
const emit = (name: string, payload?: unknown) => act(() => handlers.get(name)?.forEach(fn => fn({ payload })));
const level = (value: number) => emit('audio-level', { input: [value, value], output: [value, value] });
const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));
beforeEach(() => {
    vi.useFakeTimers(); handlers.clear();
    vi.mocked(listen).mockImplementation(async (name, callback) => {
        const fn = callback as unknown as (event: { payload: unknown }) => void;
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        return () => { handlers.get(name)?.delete(fn); };
    });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(listen).mockReset(); });

it.each(['audio-stopped', 'audio-error', 'audio-stream-error'])('%sでバー・peakを即座に破棄し、クリップは新しい開始まで保持する', event => {
    const { result } = renderHook(() => useMeterLevels({ running: true, large: true }));
    level(1.2); tick(16);
    expect(result.current.clipped).toBe(true);
    emit(event); level(1.3); tick(16);
    expect(result.current).toMatchObject({ levels: [0, 0], peak: [0, 0], clipped: true, state: 'stopped' });
    emit('audio-started');
    expect(result.current.state).toBe('waiting');
    expect(result.current.clipped).toBe(false);
    level(.5); tick(16);
    expect(result.current.levels[0]).toBeGreaterThan(0);
});
it('非ゼロtimeoutは更新待ちとし、ゼロ通知の省略は正常な無音として保持する', () => {
    const { result } = renderHook(() => useMeterLevels({ running: true }));
    level(1.2); tick(METER_TIMEOUT_MS + 32);
    expect(result.current).toMatchObject({ levels: [0, 0], peak: [0, 0], clipped: true, state: 'stale' });
    level(0); tick(10000);
    expect(result.current.state).toBe('silent');
});
it.each([NaN, Infinity, -1])('不正値%sを新しい有効測定として表示しない', value => {
    const { result } = renderHook(() => useMeterLevels({ running: true }));
    level(.8); tick(16); level(value);
    expect(result.current.levels).toEqual([0, 0]);
    expect(result.current.state).toBe('stale');
});
it('−3 dBFS では点灯せず、0 dBFS で点灯し手動で消せる', () => {
    const { result } = renderHook(() => useMeterLevels({ running: true }));
    level(Math.pow(10, -3 / 20)); tick(16); expect(result.current.clipped).toBe(false);
    level(1); tick(16); expect(result.current.clipped).toBe(true);
    level(.2); tick(16); act(() => result.current.resetClip()); tick(16);
    expect(result.current.clipped).toBe(false);
});
it('prop停止・再開で前回値を使わない', () => {
    const { result, rerender } = renderHook(({ running }) => useMeterLevels({ running }), { initialProps: { running: true } });
    level(.8); tick(16); rerender({ running: false }); level(.9);
    expect(result.current.state).toBe('stopped');
    rerender({ running: true });
    expect(result.current.levels).toEqual([0, 0]);
    expect(result.current.state).toBe('waiting');
});
it('StrictModeの旧購読と遅れて解決するunlistenを回収し、unmount後のタイマーを残さない', async () => {
    const { result, unmount } = renderHook(() => useMeterLevels({ running: true }), { wrapper: StrictMode });
    await act(async () => {});
    expect(handlers.get('audio-level')!.size).toBe(1);
    level(.4); tick(16); expect(result.current.state).toBe('live');
    unmount(); await act(async () => {});
    expect(handlers.get('audio-level')!.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
});

it('実メーターのlocale切替で購読・timeout・無音状態を作り直さない', async () => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><LevelMeter running type="input" /></LocaleProvider>);
    await act(async () => {});
    level(.5); tick(16);
    const meter = screen.getByLabelText('入力レベル: レベル表示中');
    const subscriptions = vi.mocked(listen).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByLabelText('Input level: Displaying levels')).toBe(meter);
    expect(vi.mocked(listen).mock.calls).toHaveLength(subscriptions);
    tick(METER_TIMEOUT_MS + 32);
    expect(screen.getByLabelText('Input level: Waiting for level updates')).toBe(meter);
    level(0); tick(16);
    expect(screen.getByLabelText('Input level: Silent')).toBe(meter);
    act(() => { store.setLocale('ja'); });
    expect(screen.getByLabelText('入力レベル: 無音')).toBe(meter);
    expect(vi.mocked(listen).mock.calls).toHaveLength(subscriptions);
});

 it('最後のクリップからの経過秒を更新し、再検出・手動解除・再開始でリセットする', () => {
    const { result } = renderHook(() => useMeterLevels({ running: true, type: 'input' }));
    level(1); tick(16); tick(9984);
    expect(result.current).toMatchObject({ clipped: true, clipSecondsAgo: 10 });
    level(1); tick(16); expect(result.current.clipSecondsAgo).toBe(0);
    act(() => result.current.resetClip()); tick(16);
    expect(result.current).toMatchObject({ clipped: false, clipSecondsAgo: null });
    level(1); tick(16); emit('audio-started');
    expect(result.current).toMatchObject({ clipped: false, clipSecondsAgo: null });
});
