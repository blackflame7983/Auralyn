import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WaveformCanvas } from '../VoiceCheckVisuals';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.className = ''; });

it('波形はCSSの比較色を使い、テーマ変更で再描画し、監視を解除する', async () => {
    const colors: string[] = [];
    const context = {
        clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
        lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
        set fillStyle(value: string) { colors.push(value); },
        set strokeStyle(value: string) { colors.push(value); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
        getPropertyValue: (name: string) => ({ '--waveform-raw': document.documentElement.classList.contains('dark') ? '158 64% 65%' : '158 80% 25%', '--waveform-processed': '202 85% 30%', '--muted': '210 40% 96%', '--destructive-text': '0 74% 35%', '--foreground': '222 84% 5%' })[name] ?? '',
    }) as CSSStyleDeclaration);
    const view = render(<WaveformCanvas rawPeaks={[.2, .5]} processedPeaks={[.3, .6]} positionMs={250} durationMs={1000} activeSource="raw" markersMs={[500]} />);
    expect(colors).toContain('hsl(158 80% 25% / 1)');
    expect(colors).toContain('hsl(202 85% 30% / 1)');
    await act(async () => { document.documentElement.className = 'dark'; });
    expect(colors).toContain('hsl(158 64% 65% / 1)');
    const draws = context.clearRect.mock.calls.length;
    view.unmount();
    await act(async () => { document.documentElement.className = 'gaming'; });
    expect(context.clearRect).toHaveBeenCalledTimes(draws);
});


it.each([true, false])('サイズ・DPRの変更を描画へ反映し、監視を解除する（ResizeObserver: %s）', hasObserver => {
    const context = {
        clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
        lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    let width = 100;
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 50 }) as DOMRect);
    let resize = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', hasObserver ? class {
        constructor(callback: () => void) { resize = callback; }
        observe = vi.fn();
        disconnect = disconnect;
    } : undefined);
    const queries: { query: string; change: () => void; remove: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('matchMedia', (query: string) => {
        const entry = { query, change: () => {}, remove: vi.fn() };
        queries.push(entry);
        return { addEventListener: (_: string, callback: () => void) => { entry.change = callback; }, removeEventListener: entry.remove };
    });
    let dpr = 1;
    vi.spyOn(window, 'devicePixelRatio', 'get').mockImplementation(() => dpr);
    const view = render(<WaveformCanvas rawPeaks={[.2]} processedPeaks={[]} positionMs={0} durationMs={1000} activeSource="raw" markersMs={[]} />);
    const canvas = view.container.querySelector('canvas')!;
    expect(canvas.width).toBe(100);
    width = 200;
    act(() => { if (hasObserver) resize(); else window.dispatchEvent(new Event('resize')); });
    expect(canvas.width).toBe(200);
    act(() => { dpr = 2; queries[0].change(); });
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(100);
    expect(queries[1].query).toBe('(resolution: 2dppx)');
    expect(queries[0].remove).toHaveBeenCalled();
    view.unmount();
    if (hasObserver) expect(disconnect).toHaveBeenCalledOnce();
    expect(queries[1].remove).toHaveBeenCalled();
    const draws = context.clearRect.mock.calls.length;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(context.clearRect).toHaveBeenCalledTimes(draws);
});
