import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { addAppVisibilityListener, initializeAppVisibility, isAppHidden, removeAppVisibilityListener } from '../appVisibility';
import { useMeterLevels } from '@/hooks/useMeterLevels';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const handlers = new Map<string, (event: { payload: any }) => void>();
const emit = (name: string, payload: unknown) => act(() => handlers.get(name)?.({ payload }));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
let stop: (() => void) | undefined;
beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue(true);
    vi.mocked(listen).mockImplementation(async (name, callback) => {
        handlers.set(name, callback as (event: { payload: any }) => void);
        return () => { handlers.delete(name); };
    });
});
afterEach(() => { stop?.(); stop = undefined; cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('native 非表示は DOM と合成され、復帰と後片付けを通知する', async () => {
    const changed = vi.fn();
    addAppVisibilityListener(changed);
    stop = initializeAppVisibility();
    await flush();
    expect(isAppHidden()).toBe(false);
    emit('app://window-activity', false);
    expect(isAppHidden()).toBe(true);
    expect(document.documentElement.dataset.appHidden).toBe('true');
    emit('app://window-activity', true);
    expect(isAppHidden()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    stop(); stop = undefined;
    expect(handlers.has('app://window-activity')).toBe(false);
    expect(document.documentElement.dataset.appHidden).toBeUndefined();
    removeAppVisibilityListener(changed);
});

it('取得応答より新しい native 通知を優先する', async () => {
    let resolve!: (value: boolean) => void;
    vi.mocked(invoke).mockReturnValue(new Promise<boolean>(r => { resolve = r; }));
    stop = initializeAppVisibility();
    await flush();
    emit('app://window-activity', false);
    await act(async () => resolve(true));
    expect(isAppHidden()).toBe(true);
});

it('購読完了前の cleanup は遅れた unlisten を回収する', async () => {
    let resolve!: (stop: () => void) => void;
    const dispose = vi.fn();
    vi.mocked(listen).mockReturnValue(new Promise(r => { resolve = r; }));
    stop = initializeAppVisibility();
    stop(); stop = undefined;
    await act(async () => resolve(dispose));
    expect(dispose).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
});

it('DOM が表示中でも native 非表示ではメーターを更新せず復帰時に反映する', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    stop = initializeAppVisibility();
    await flush();
    const { result } = renderHook(() => useMeterLevels({ running: true }));
    await flush();
    emit('app://window-activity', false);
    emit('audio-level', { input: [1.2, 1.2], output: [1.2, 1.2] });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.clipped).toBe(false);
    emit('app://window-activity', true);
    expect(result.current.clipped).toBe(true);
});
