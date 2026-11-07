import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutMotion, useSettledReady } from '../useLayoutMotion';
import type { Availability } from '@/lib/preparation';

// jsdom は配置を計算しないので、位置と高さを data 属性から返し、ResizeObserver の通知を手で送る。
let notify: (() => void) | null = null;
const animate = vi.fn(() => ({ cancel: vi.fn(), playState: 'finished' }));
const reads = vi.fn();
const number = (element: HTMLElement, name: string) => Number(element.dataset[name] ?? 0);

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
    reads.mockClear();
    notify = null;
    animate.mockClear();
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { notify = callback; } observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() { return number(this, 'top'); } });
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { return number(this, 'left'); } });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { reads(this.id); return number(this, 'h'); } });
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return null; } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Home({ extra = false }: { extra?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutMotion(ref);
    return <div className="workspace-body" id="workspace"><div ref={ref}>
        <section id="strip" data-top="0" data-h="100" />
        <section id="chain" data-top="100" data-h="200"><div id="row" data-layout-motion data-top="120" data-left="0" data-h="40" /></section>
        {extra && <section id="extra" data-top="300" data-h="50" />}
    </div><div id="space" className="vst-panel-space" /></div>;
}
const el = (id: string) => document.getElementById(id)!;
const calls = (id: string) => animate.mock.calls.filter((_, index) => animate.mock.contexts[index] === el(id)).map(call => (call as unknown[])[0]);

describe('ホームの配置の補間（#298）', () => {
    it('前の区画が伸びたら、後ろの区画を前回の位置から transform で戻し、伸びた区画は切り抜かない', () => {
        render(<Home />);
        el('strip').dataset.h = '160';
        el('chain').dataset.top = '160';
        el('row').dataset.top = '180';
        act(() => notify?.());
        expect(calls('chain')).toEqual([[{ transform: 'translate(0px, -60px)' }, { transform: 'translate(0px, 0px)' }]]);
        // 切り抜くと、開いたばかりのメニューなど伸びた部分が押せない時間ができる。
        expect(calls('strip')).toEqual([]);
        // 区画の中の部品は区画からの位置で測るので、区画ごと動いただけなら二重に動かさない。
        expect(calls('row')).toEqual([]);
    });

    it('区画の中で折り返しが変わった部品だけを動かす', () => {
        render(<Home />);
        el('row').dataset.left = '300';
        act(() => notify?.());
        expect(calls('row')).toEqual([[{ transform: 'translate(-300px, 0px)' }, { transform: 'translate(0px, 0px)' }]]);
        expect(calls('chain')).toEqual([]);
    });

    it('あとから現れた区画は不透明度だけで入れる', async () => {
        function Toggle() { const [extra, setExtra] = useState(false); return <><button onClick={() => setExtra(true)}>add</button><Home extra={extra} /></>; }
        const view = render(<Toggle />);
        await act(async () => { view.getByText('add').click(); });
        act(() => notify?.());
        expect(calls('extra')).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
    });

    it('動きを減らす設定では、位置を記録するだけで動かさない', () => {
        vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
        render(<Home />);
        el('strip').dataset.h = '160';
        el('chain').dataset.top = '160';
        act(() => notify?.());
        expect(animate).not.toHaveBeenCalled();
    });
});

// jsdom に TransitionEvent がないため、実際のバブリング経路とプロパティを再現する。
const transition = (id: string, type: string, propertyName = 'width') => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, { propertyName: { value: propertyName }, pseudoElement: { value: '' } });
    act(() => { el(id).dispatchEvent(event); });
};
const frame = () => act(() => { vi.advanceTimersByTime(16); });

describe('幅変更と区画補間の競合防止（#345）', () => {
    it.each(['transitionend', 'transitioncancel'])('%s 後に1回だけ位置を記録し、通知中は計測も補間もしない', end => {
        render(<Home />);
        reads.mockClear();
        transition('workspace', 'transitionrun', 'max-width');
        transition('space', 'transitionrun');
        el('chain').dataset.top = '160';
        act(() => { notify?.(); notify?.(); });
        expect(reads).not.toHaveBeenCalled();
        expect(animate).not.toHaveBeenCalled();
        transition('space', end);
        frame();
        expect(reads).not.toHaveBeenCalled();
        transition('workspace', end, 'max-width');
        act(() => notify?.());
        expect(reads).not.toHaveBeenCalled();
        frame();
        expect(reads.mock.calls.filter(([id]) => id === 'chain')).toHaveLength(1);
        expect(animate).not.toHaveBeenCalled();
        // 直後の通常通知も遷移前へ引き戻さず、以後の内容変更は補間できる。
        act(() => notify?.());
        expect(animate).not.toHaveBeenCalled();
        el('chain').dataset.top = '180';
        act(() => notify?.());
        expect(calls('chain')).toEqual([[{ transform: 'translate(0px, -20px)' }, { transform: 'translate(0px, 0px)' }]]);
    });

    it('開閉の反転では cancel と次の run の間を計測しない', () => {
        render(<Home />);
        reads.mockClear();
        transition('space', 'transitionrun');
        transition('space', 'transitioncancel');
        transition('space', 'transitionrun');
        frame();
        act(() => notify?.());
        expect(reads).not.toHaveBeenCalled();
        transition('space', 'transitionend');
        frame();
        expect(reads.mock.calls.filter(([id]) => id === 'chain')).toHaveLength(1);
    });

    it('子要素の色・transform や無関係な幅の遷移は計測を止めない', () => {
        render(<Home />);
        transition('space', 'transitionrun', 'transform');
        transition('row', 'transitionrun');
        el('chain').dataset.top = '160';
        act(() => notify?.());
        expect(calls('chain')).toHaveLength(1);
    });

    it('窓を連続リサイズしている間は既存補間を止め、静まった位置を1回だけ記録する', () => {
        render(<Home />);
        el('chain').dataset.top = '160';
        act(() => notify?.());
        const running = animate.mock.results[0].value;
        reads.mockClear();
        animate.mockClear();
        act(() => window.dispatchEvent(new Event('resize')));
        expect(running.cancel).toHaveBeenCalled();
        el('chain').dataset.top = '180';
        act(() => { notify?.(); vi.advanceTimersByTime(100); window.dispatchEvent(new Event('resize')); notify?.(); });
        act(() => vi.advanceTimersByTime(119));
        expect(reads).not.toHaveBeenCalled();
        act(() => vi.advanceTimersByTime(17));
        expect(reads.mock.calls.filter(([id]) => id === 'chain')).toHaveLength(1);
        expect(animate).not.toHaveBeenCalled();
        act(() => notify?.());
        expect(animate).not.toHaveBeenCalled();
    });

    it('窓のリサイズとパネル遷移の両方が終わるまで待つ', () => {
        render(<Home />);
        reads.mockClear();
        transition('space', 'transitionrun');
        act(() => window.dispatchEvent(new Event('resize')));
        act(() => vi.advanceTimersByTime(200));
        expect(reads).not.toHaveBeenCalled();
        transition('space', 'transitioncancel');
        frame();
        expect(reads.mock.calls.filter(([id]) => id === 'chain')).toHaveLength(1);
    });

    it('動きを減らす設定では終了後も補間しない', () => {
        vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
        render(<Home />);
        transition('space', 'transitionrun');
        el('chain').dataset.top = '160';
        transition('space', 'transitionend');
        frame();
        act(() => notify?.());
        expect(animate).not.toHaveBeenCalled();
    });

    it('予約要素が終了通知前に取り外されても計測を再開する', async () => {
        render(<Home />);
        reads.mockClear();
        transition('space', 'transitionrun');
        await act(async () => { el('space').remove(); });
        frame();
        expect(reads.mock.calls.filter(([id]) => id === 'chain')).toHaveLength(1);
        el('chain').dataset.top = '160';
        act(() => notify?.());
        expect(calls('chain')).toHaveLength(1);
    });

    it('アンマウント時は予約済みの計測とリスナーを解除する', () => {
        const view = render(<Home />);
        transition('space', 'transitionrun');
        transition('space', 'transitionend');
        view.unmount();
        reads.mockClear();
        act(() => { vi.advanceTimersByTime(200); window.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(200); });
        expect(reads).not.toHaveBeenCalled();
    });
});

it('反映待ちの間は直前の判定を保ち、確定した状態が届いたら切り替える（#298）', () => {
    const view = renderHook(({ availability }: { availability: Availability }) => useSettledReady(availability), { initialProps: { availability: 'ready' } });
    expect(view.result.current).toBe(true);
    view.rerender({ availability: 'pending' });
    expect(view.result.current).toBe(true);
    view.rerender({ availability: 'muted' });
    expect(view.result.current).toBe(false);
    view.rerender({ availability: 'pending' });
    expect(view.result.current).toBe(false);
});
