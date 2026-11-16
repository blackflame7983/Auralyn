import { afterEach, expect, it, vi } from 'vitest';
import { startAnimationFrames } from '../internal/animationFrame';

afterEach(() => vi.unstubAllGlobals());

it('停止は保留中のframeを回収し、遅いcallbackも描画・再予約しない', () => {
    const pending: FrameRequestCallback[] = [];
    const request = vi.fn((callback: FrameRequestCallback) => { pending.push(callback); return pending.length; });
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const paint = vi.fn();
    const stop = startAnimationFrames(paint);
    pending[0]?.(10);
    expect(paint).toHaveBeenCalledWith(10);
    expect(request).toHaveBeenCalledTimes(2);
    stop();
    expect(cancel).toHaveBeenCalledWith(2);
    pending[1]?.(20);
    expect(paint).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
});
