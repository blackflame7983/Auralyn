import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { WaveformCanvas } from '../VoiceCheckVisuals';

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.className = ''; });

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
