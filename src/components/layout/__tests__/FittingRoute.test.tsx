import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { FittingRoute } from '../FittingRoute';

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function installObserver() {
    let notify: ResizeObserverCallback | undefined;
    class Observer {
        observe() { /* 幅は試験が渡す */ }
        unobserve() { /* 試験では外さない */ }
        disconnect() { /* 試験では外さない */ }
        constructor(callback: ResizeObserverCallback) { notify = callback; }
    }
    vi.stubGlobal('ResizeObserver', Observer);
    return () => act(() => { notify?.([], {} as ResizeObserver); });
}

function stubWidths(box: HTMLElement, available: number, widths: Record<string, number>) {
    Object.defineProperty(box, 'clientWidth', { configurable: true, value: available });
    Object.defineProperty(box.querySelector('[data-route-sep]'), 'offsetWidth', { configurable: true, value: 16 });
    Object.defineProperty(box.querySelector('[data-route-ellipsis]'), 'offsetWidth', { configurable: true, value: 12 });
    for (const segment of box.querySelectorAll('[data-route-seg], [data-route-alt]')) {
        Object.defineProperty(segment, 'offsetWidth', { configurable: true, value: widths[segment.textContent ?? ''] ?? 0 });
    }
}

it('狭い帯では先頭を隠し、送り先と全文を残す', () => {
    const notify = installObserver();
    const route = 'CABLE Output → スピーカー → OBSで配信';
    const { container } = render(<FittingRoute route={route} />);
    const box = container.querySelector('[data-route-box]') as HTMLElement;
    stubWidths(box, 120, { 'CABLE Output': 200, 'スピーカー': 80, 'OBSで配信': 70 });
    notify();
    const visual = box.querySelector('[data-route-visual]') as HTMLElement;
    expect(visual.textContent).toBe('… → OBSで配信');
    expect(visual).toHaveAttribute('aria-hidden', 'true');
    expect(box).toHaveAttribute('title', route);
    expect(box.querySelector('.sr-only')?.textContent).toBe(route);
    // 送り先が全文で入るなら、末尾を省略しない。
    expect(visual.querySelector('.text-ellipsis')).toBeNull();
});

it('送り先が全文で入らない幅では、機器名を隠したまま送り先を短い形にする', () => {
    const notify = installObserver();
    const route = 'Yeti Stereo Microphone → CABLE Input → Stream with OBS';
    const { container } = render(<FittingRoute route={route} compact={['OBS']} />);
    const box = container.querySelector('[data-route-box]') as HTMLElement;
    stubWidths(box, 105, { 'Yeti Stereo Microphone': 150, 'CABLE Input': 90, 'Stream with OBS': 100, 'OBS': 25 });
    notify();
    const visual = box.querySelector('[data-route-visual]') as HTMLElement;
    expect(visual.textContent).toBe('… → OBS');
    expect(visual.querySelector('.text-ellipsis')).toBeNull();
    expect(box).toHaveAttribute('title', route);
    expect(box.querySelector('.sr-only')?.textContent).toBe(route);
});

it('短い形でも入らない幅になったときだけ、短い形の末尾を省略する', () => {
    const notify = installObserver();
    const route = 'Yeti Stereo Microphone → CABLE Input → Stream with OBS';
    const { container } = render(<FittingRoute route={route} compact={['OBS']} />);
    const box = container.querySelector('[data-route-box]') as HTMLElement;
    stubWidths(box, 40, { 'Yeti Stereo Microphone': 150, 'CABLE Input': 90, 'Stream with OBS': 100, 'OBS': 25 });
    notify();
    const visual = box.querySelector('[data-route-visual]') as HTMLElement;
    expect(visual.textContent).toBe('… → OBS');
    expect(visual.querySelector('.text-ellipsis')?.textContent).toBe('OBS');
});

it('中間まで残せる幅では、送り先の直前まで見せる', () => {
    const notify = installObserver();
    const route = 'CABLE Output → スピーカー → OBSで配信';
    const { container } = render(<FittingRoute route={route} />);
    const box = container.querySelector('[data-route-box]') as HTMLElement;
    stubWidths(box, 200, { 'CABLE Output': 200, 'スピーカー': 80, 'OBSで配信': 70 });
    notify();
    expect(box.querySelector('[data-route-visual]')?.textContent).toBe('… → スピーカー → OBSで配信');
});

it('幅が足りるときは省略記号を出さない', () => {
    const notify = installObserver();
    const route = '自分用 → スピーカー';
    const { container } = render(<FittingRoute route={route} />);
    const box = container.querySelector('[data-route-box]') as HTMLElement;
    stubWidths(box, 400, { '自分用': 80, 'スピーカー': 70 });
    notify();
    expect(box.querySelector('[data-route-visual]')?.textContent).toBe(route);
});
