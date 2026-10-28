import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Window as TauriWindow } from '@tauri-apps/api/window';
import { UsageWindowController, useUsageWindow } from '../useUsageWindow';

const mocks = vi.hoisted(() => ({ monitors: vi.fn(), current: vi.fn() }));
vi.mock('@tauri-apps/api/window', async importOriginal => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/window')>()),
    availableMonitors: mocks.monitors,
    getCurrentWindow: mocks.current,
}));

function fakeWindow() {
    const state = { x: 100, y: 50, width: 1024, height: 768, maximized: false, minimized: false, scale: 1 };
    const handlers: Record<string, () => void> = {};
    const unsubscribed = vi.fn();
    const win = {
        outerPosition: vi.fn(async () => ({ x: state.x, y: state.y })),
        innerSize: vi.fn(async () => ({ width: state.width * state.scale, height: state.height * state.scale })),
        outerSize: vi.fn(async () => ({ width: state.width * state.scale + 16, height: state.height * state.scale + 40 })),
        scaleFactor: vi.fn(async () => state.scale),
        isMaximized: vi.fn(async () => state.maximized),
        isMinimized: vi.fn(async () => state.minimized),
        // WindowsのTaoは制約変更時に最大化を解除する。
        setMinSize: vi.fn(async () => { state.maximized = false; }),
        setSize: vi.fn(async (size: { width: number; height: number }) => { state.width = size.width; state.height = size.height; }),
        setPosition: vi.fn(async (pos: { x: number; y: number }) => { state.x = pos.x; state.y = pos.y; }),
        maximize: vi.fn(async () => { state.maximized = true; }),
        unmaximize: vi.fn(async () => { state.maximized = false; }),
        onMoved: vi.fn(async (cb: () => void) => { handlers.moved = cb; return unsubscribed; }),
        onResized: vi.fn(async (cb: () => void) => { handlers.resized = cb; return unsubscribed; }),
        onScaleChanged: vi.fn(async (cb: () => void) => { handlers.scale = cb; return unsubscribed; }),
    };
    return { win, state, handlers, unsubscribed };
}
const asWindow = (win: ReturnType<typeof fakeWindow>['win']) => win as unknown as TauriWindow;

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('isTauri', false);
    mocks.monitors.mockResolvedValue([{ name: 'main', scaleFactor: 1, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } } }]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('用途別ウィンドウ', () => {
    it('初回は既存サイズを維持し、切替時に不足分だけ拡大して音楽へ戻しても縮めない', async () => {
        const { win, state } = fakeWindow();
        state.width = 900; state.height = 600;
        const controller = new UsageWindowController(asWindow(win));
        await controller.setPurpose('music');
        expect(win.setSize).not.toHaveBeenCalled();
        await controller.setPurpose('voice');
        expect([state.width, state.height]).toEqual([960, 640]);
        await controller.setPurpose('music');
        expect([state.width, state.height]).toEqual([960, 640]);
        expect(JSON.parse(localStorage.getItem('auralyn_window_v1_music')!)).toMatchObject({ width: 960, height: 640 });
        controller.dispose();
    });

    it('起動時だけ保存した用途の通常位置と最大化を復元する', async () => {
        const { win, state } = fakeWindow();
        localStorage.setItem('auralyn_window_v1_music', JSON.stringify({ x: 200, y: 120, width: 1100, height: 750, maximized: true }));
        const controller = new UsageWindowController(asWindow(win));
        await controller.setPurpose('music');
        expect(state).toMatchObject({ x: 200, y: 120, width: 1100, height: 750, maximized: true });
        expect(win.maximize).toHaveBeenCalledOnce();
        expect(JSON.parse(localStorage.getItem('auralyn_window_v1_music')!)).toMatchObject({ x: 200, y: 120, width: 1100, height: 750, maximized: true });
        controller.dispose();
    });

    it('取り外されたモニターに保存された位置を接続中の画面内へ復元する', async () => {
        const { win, state } = fakeWindow();
        localStorage.setItem('auralyn_window_v1_music', JSON.stringify({ x: 3000, y: 200, width: 1100, height: 750, maximized: false }));
        const controller = new UsageWindowController(asWindow(win));
        await controller.setPurpose('music');
        expect(state).toMatchObject({ x: 804, y: 200, width: 1100, height: 750, maximized: false });
        controller.dispose();
    });

    it('古い非同期の用途変更を取り消し、新しい用途だけを適用する', async () => {
        const { win, state } = fakeWindow();
        state.width = 900; state.height = 600;
        let release!: (value: { x: number; y: number }) => void;
        win.outerPosition.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const controller = new UsageWindowController(asWindow(win));
        const old = controller.setPurpose('voice');
        await Promise.resolve();
        const latest = controller.setPurpose('music');
        release({ x: 100, y: 50 });
        await Promise.all([old, latest]);
        expect(win.setSize).not.toHaveBeenCalled();
        expect(localStorage.getItem('auralyn_window_v1_voice')).toBeNull();
        expect(localStorage.getItem('auralyn_window_v1_music')).not.toBeNull();
        controller.dispose();
    });

    it('最大化中のイベントでは、通常時の寸法を壊さず最大化を記録する', async () => {
        vi.useFakeTimers();
        const { win, state, handlers, unsubscribed } = fakeWindow();
        const controller = new UsageWindowController(asWindow(win));
        await controller.listen();
        await controller.setPurpose('voice');
        state.maximized = true; state.x = 0; state.y = 0; state.width = 1920; state.height = 1040;
        const minCalls = win.setMinSize.mock.calls.length;
        handlers.resized();
        await vi.advanceTimersByTimeAsync(121);
        expect(win.setMinSize).toHaveBeenCalledTimes(minCalls);
        expect(state.maximized).toBe(true);
        expect(JSON.parse(localStorage.getItem('auralyn_window_v1_voice')!)).toMatchObject({ x: 100, y: 50, width: 1024, height: 768, maximized: true });
        controller.dispose();
        expect(unsubscribed).toHaveBeenCalledTimes(3);
    });

    it('最大化中に用途を切り替えても解除せず、解除後に新しい下限を適用する', async () => {
        vi.useFakeTimers();
        const { win, state, handlers } = fakeWindow();
        state.width = 900; state.height = 600;
        const controller = new UsageWindowController(asWindow(win));
        await controller.listen();
        await controller.setPurpose('music');
        const minCalls = win.setMinSize.mock.calls.length;
        state.maximized = true; state.x = 0; state.y = 0; state.width = 1920; state.height = 1040;
        await controller.setPurpose('voice');
        expect(state.maximized).toBe(true);
        expect(win.setMinSize).toHaveBeenCalledTimes(minCalls);
        expect(JSON.parse(localStorage.getItem('auralyn_window_v1_voice')!)).toMatchObject({ width: 900, height: 600, maximized: true });
        state.maximized = false; state.x = 100; state.y = 50; state.width = 900; state.height = 600;
        handlers.resized();
        await vi.advanceTimersByTimeAsync(121);
        expect(win.setMinSize).toHaveBeenCalledTimes(minCalls + 1);
        expect(state).toMatchObject({ width: 960, height: 640, maximized: false });
        controller.dispose();
    });

    it('初回から最大化されているとき、用途別状態がなければ最大化を保つ', async () => {
        const { win, state } = fakeWindow();
        state.maximized = true; state.x = 0; state.y = 0; state.width = 1920; state.height = 1040;
        const controller = new UsageWindowController(asWindow(win));
        await controller.setPurpose('voice');
        expect(state.maximized).toBe(true);
        expect(win.setMinSize).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem('auralyn_window_v1_voice')!)).toMatchObject({ width: 1024, height: 768, maximized: true });
        controller.dispose();
    });

    it('既に最大化中の起動時に保存済み最大化を復元する場合、制約変更の前に通常表示へ戻す', async () => {
        const { win, state } = fakeWindow();
        state.maximized = true; state.x = 0; state.y = 0; state.width = 1920; state.height = 1040;
        localStorage.setItem('auralyn_window_v1_voice', JSON.stringify({ x: 200, y: 120, width: 1100, height: 750, maximized: true }));
        const controller = new UsageWindowController(asWindow(win));
        await controller.setPurpose('voice');
        expect(win.unmaximize).toHaveBeenCalledOnce();
        expect(win.unmaximize.mock.invocationCallOrder[0]).toBeLessThan(win.setMinSize.mock.invocationCallOrder[0]);
        expect(state).toMatchObject({ x: 200, y: 120, width: 1100, height: 750, maximized: true });
        controller.dispose();
    });

    it('通常表示の連続イベントで同じ下限を繰り返し適用しない', async () => {
        vi.useFakeTimers();
        const { win, handlers } = fakeWindow();
        const controller = new UsageWindowController(asWindow(win));
        await controller.listen();
        await controller.setPurpose('voice');
        handlers.resized();
        await vi.advanceTimersByTimeAsync(121);
        handlers.moved();
        await vi.advanceTimersByTimeAsync(121);
        expect(win.setMinSize).toHaveBeenCalledOnce();
        controller.dispose();
    });

    it('最小化中の移動・サイズイベントを保存せず、復帰後に保留された用途を適用する', async () => {
        vi.useFakeTimers();
        const { win, state, handlers } = fakeWindow();
        const controller = new UsageWindowController(asWindow(win));
        await controller.listen();
        await controller.setPurpose('music');
        const original = localStorage.getItem('auralyn_window_v1_music');
        state.minimized = true; state.x = -32000; state.y = -32000; state.width = 160; state.height = 32;
        handlers.moved();
        await vi.advanceTimersByTimeAsync(121);
        expect(localStorage.getItem('auralyn_window_v1_music')).toBe(original);
        const minCalls = win.setMinSize.mock.calls.length;
        await controller.setPurpose('voice');
        expect(win.setMinSize).toHaveBeenCalledTimes(minCalls);
        expect(localStorage.getItem('auralyn_window_v1_voice')).toBeNull();
        state.minimized = false; state.x = 100; state.y = 50; state.width = 900; state.height = 600;
        handlers.resized();
        await vi.advanceTimersByTimeAsync(121);
        expect(state).toMatchObject({ x: 100, y: 50, width: 960, height: 640 });
        expect(JSON.parse(localStorage.getItem('auralyn_window_v1_voice')!)).toMatchObject({ x: 100, y: 50, width: 960, height: 640 });
        controller.dispose();
    });

    it('ブラウザではネイティブAPIに触れない', async () => {
        function Component() { useUsageWindow('music'); return null; }
        await act(async () => { render(<Component />); });
        expect(mocks.current).not.toHaveBeenCalled();
        expect(mocks.monitors).not.toHaveBeenCalled();
    });
});
